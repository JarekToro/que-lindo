"""2D neighborhood attention (NATTEN semantics) as tiled dense attention.

Queries are grouped into TxT tiles (origins clamped so the last tile overlaps rather than
padding); each tile attends densely to its (T+2p)x(T+2p) halo, with a boolean mask keeping
exactly the NATTEN window of every query (windows shift at the borders instead of padding,
and stay inside the halo as long as T + p >= kernel). Two batched matmuls + softmax.
Maps smaller than one tile fall back to `fallback` (a gather implementation)."""
from __future__ import annotations

import torch
import torch.nn.functional as F

_cache: dict[tuple, tuple] = {}


def _as_pair(kernel_size) -> tuple[int, int]:
    if isinstance(kernel_size, (tuple, list)):
        return int(kernel_size[0]), int(kernel_size[1])
    return int(kernel_size), int(kernel_size)


def _plan(H: int, W: int, kh: int, kw: int, T: int, device: torch.device):
    """Tile origins, gather indices and the window mask for a (H, W, kernel, tile) layout."""
    key = (H, W, kh, kw, T, str(device))
    if key in _cache:
        return _cache[key]
    ph, pw = kh // 2, kw // 2
    Kh, Kw = T + 2 * ph, T + 2 * pw
    ar = torch.arange
    orig_r = (ar(-(-H // T), device=device) * T).clamp(max=H - T)  # (nTh,)
    orig_c = (ar(-(-W // T), device=device) * T).clamp(max=W - T)  # (nTw,)
    qr = orig_r[:, None] + ar(T, device=device)                  # (nTh, T) absolute query rows
    qc = orig_c[:, None] + ar(T, device=device)
    kr = orig_r[:, None] + ar(Kh, device=device) - ph             # (nTh, Kh) absolute key rows (may be outside image)
    kc = orig_c[:, None] + ar(Kw, device=device) - pw
    sr = (ar(H, device=device) - ph).clamp(0, H - kh)             # NATTEN window start per row
    sc = (ar(W, device=device) - pw).clamp(0, W - kw)
    s_r, s_c = sr[qr], sc[qc]
    rowok = (kr[:, None, :] >= s_r[:, :, None]) & (kr[:, None, :] < s_r[:, :, None] + kh)  # (nTh, T, Kh)
    colok = (kc[:, None, :] >= s_c[:, :, None]) & (kc[:, None, :] < s_c[:, :, None] + kw)  # (nTw, T, Kw)
    mask = (rowok[:, None, :, None, :, None] & colok[None, :, None, :, None, :]).reshape(len(orig_r) * len(orig_c), T * T, Kh * Kw)
    plan = (qr, qc, kr + ph, kc + pw, mask)  # key indices shifted into the padded map
    _cache[key] = plan
    return plan


def na2d(q, k, v, kernel_size, dilation=1, is_causal=None, rpb=None, scale=None, tile: int = 8, fallback=None, **_):
    """q, k, v: (n, H, W, heads, e) -> (n, H, W, heads, e)."""
    kh, kw = _as_pair(kernel_size)
    n, H, W, nh, e = q.shape
    kh, kw = min(kh, H), min(kw, W)
    T = max(tile, kh, kw)
    if (H < T or W < T) and fallback is not None:
        return fallback(q, k, v, kernel_size, scale=scale)
    T = min(T, H, W)
    scale = float(scale) if scale is not None else e ** -0.5
    ph, pw = kh // 2, kw // 2
    qr, qc, kr, kc, mask = _plan(H, W, kh, kw, T, q.device)
    nTh, nTw = qr.shape[0], qc.shape[0]
    Kh, Kw = kr.shape[1], kc.shape[1]

    kp = F.pad(k, (0, 0, 0, 0, pw, pw, ph, ph))  # zero halo; masked out anyway
    vp = F.pad(v, (0, 0, 0, 0, pw, pw, ph, ph))
    divisible = H % T == 0 and W % T == 0
    if divisible:
        # non-overlapping tiles: reshape / unfold views, single copy on the final reshape
        qt = q.reshape(n, nTh, T, nTw, T, nh, e).permute(0, 1, 3, 5, 2, 4, 6).reshape(n, nTh * nTw, nh, T * T, e)
        kt = kp.unfold(1, Kh, T).unfold(2, Kw, T).permute(0, 1, 2, 3, 5, 6, 4).reshape(n, nTh * nTw, nh, Kh * Kw, e)
        vt = vp.unfold(1, Kh, T).unfold(2, Kw, T).permute(0, 1, 2, 3, 5, 6, 4).reshape(n, nTh * nTw, nh, Kh * Kw, e)
    else:
        # overlapping tiles (origins clamped): gather. q (n, nTh, T, nTw, T, nh, e); k/v (n, nTh, Kh, nTw, Kw, nh, e)
        qt = q[:, qr][:, :, :, qc].permute(0, 1, 3, 5, 2, 4, 6).reshape(n, nTh * nTw, nh, T * T, e)
        kt = kp[:, kr][:, :, :, kc].permute(0, 1, 3, 5, 2, 4, 6).reshape(n, nTh * nTw, nh, Kh * Kw, e)
        vt = vp[:, kr][:, :, :, kc].permute(0, 1, 3, 5, 2, 4, 6).reshape(n, nTh * nTw, nh, Kh * Kw, e)

    logits = torch.matmul(qt, kt.transpose(-1, -2)) * scale          # (n, nT, nh, T*T, K)
    logits = logits.masked_fill(~mask[None, :, None], float("-inf"))
    out_t = torch.matmul(logits.softmax(-1).to(vt.dtype), vt)        # (n, nT, nh, T*T, e)
    out_t = out_t.reshape(n, nTh, nTw, nh, T, T, e).permute(0, 1, 4, 2, 5, 3, 6)  # (n, nTh, T, nTw, T, nh, e)
    if divisible:
        return out_t.reshape(n, H, W, nh, e)
    out = q.new_empty(q.shape)
    out[:, qr[:, :, None, None], qc[None, None, :, :]] = out_t  # overlapping tiles write identical values
    return out
