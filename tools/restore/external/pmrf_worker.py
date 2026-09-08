"""PMRF worker.

Loads ohayonguy/PMRF_blind_face_image_restoration once and serves aligned 512x512 face
crops over a tiny local HTTP API, so the main app can call it many times without
re-loading. Runs inside external/pmrf-venv (PMRF's deps differ from the main app).

PMRF's HDiT uses `natten` (neighborhood attention) which only ships CUDA kernels; a
pure-PyTorch implementation with identical semantics is installed as a shim below so
the model runs on MPS / CPU.

  GET  /health                     -> {"ok": true, "loaded": bool, "device": "mps"}
  POST /restore  {"input": png, "output": png, "steps": 25, "seed": 0, "mmse_only": false}
"""
from __future__ import annotations

import argparse
import json
import os
import sys
import threading
import time
import traceback
import types
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

ROOT = Path(__file__).resolve().parent
PMRF_DIR = ROOT / "PMRF"
sys.path.insert(0, str(PMRF_DIR))

try:  # python.org macOS builds ship without root certs
    import certifi

    os.environ.setdefault("SSL_CERT_FILE", certifi.where())
except ImportError:
    pass

import numpy as np
import torch
from PIL import Image

# PMRF imports wandb at module level; it is never used at inference time.
sys.modules.setdefault("wandb", types.ModuleType("wandb"))


# --------------------------------------------------------------------------- natten shim
def _window_index(length: int, kernel: int, device: torch.device) -> torch.Tensor:
    """NATTEN neighborhood: window of `kernel` centred on i, shifted (not padded) at borders."""
    i = torch.arange(length, device=device)
    start = (i - kernel // 2).clamp(0, max(length - kernel, 0))
    return start[:, None] + torch.arange(kernel, device=device)[None, :]  # (L, k)


def _as_pair(kernel_size) -> tuple[int, int]:
    if isinstance(kernel_size, (tuple, list)):
        return int(kernel_size[0]), int(kernel_size[1])
    return int(kernel_size), int(kernel_size)


def na2d_gather(q: torch.Tensor, k: torch.Tensor, v: torch.Tensor, kernel_size, dilation=1, is_causal=None, rpb=None, scale=None, **_):
    """Reference fused-NA equivalent (per-position gathers; exact but slow). Used only for maps
    smaller than one tile. q, k, v: (n, H, W, heads, e). Returns (n, H, W, heads, e)."""
    kh, kw = _as_pair(kernel_size)
    n, H, W, nh, e = q.shape
    kh, kw = min(kh, H), min(kw, W)
    scale = float(scale) if scale is not None else e ** -0.5
    ri = _window_index(H, kh, q.device)
    ci = _window_index(W, kw, q.device)
    # rows per chunk so that the gathered k/v block stays around 256MB
    per_row = n * W * nh * kh * kw * e * q.element_size()
    rows = max(1, min(H, int(256e6 // max(per_row, 1))))
    out = torch.empty_like(q)
    for r0 in range(0, H, rows):
        r1 = min(H, r0 + rows)
        idx = ri[r0:r1]  # (R, kh)
        kk = k[:, idx][:, :, :, ci]  # (n, R, kh, W, kw, nh, e)
        vv = v[:, idx][:, :, :, ci]
        kk = kk.permute(0, 1, 3, 5, 2, 4, 6).reshape(n, r1 - r0, W, nh, kh * kw, e)
        vv = vv.permute(0, 1, 3, 5, 2, 4, 6).reshape(n, r1 - r0, W, nh, kh * kw, e)
        qq = q[:, r0:r1]  # (n, R, W, nh, e)
        logits = torch.einsum("nrwhe,nrwhke->nrwhk", qq, kk) * scale
        a = logits.softmax(dim=-1).to(vv.dtype)
        out[:, r0:r1] = torch.einsum("nrwhk,nrwhke->nrwhe", a, vv)
    return out


sys.path.insert(0, str(ROOT.parent))  # na_tiled.py lives in the project root
import na_tiled  # noqa: E402


def na2d(q, k, v, kernel_size, **kw):
    """Tiled dense-attention NA (see na_tiled.py): ~10x faster than the gather version on MPS."""
    return na_tiled.na2d(q, k, v, kernel_size, fallback=na2d_gather, **kw)


def _install_natten_shim() -> None:
    mod = types.ModuleType("natten")
    fn = types.ModuleType("natten.functional")
    fn.na2d = na2d
    mod.functional = fn
    mod.has_fused_na = lambda: True
    mod.__version__ = "0.0-shim"
    sys.modules["natten"] = mod
    sys.modules["natten.functional"] = fn


_install_natten_shim()

from lightning_models.mmse_rectified_flow import MMSERectifiedFlow  # noqa: E402

HF_ID = "ohayonguy/PMRF_blind_face_image_restoration"


class Worker:
    def __init__(self, device: str):
        self.device = torch.device(device)
        self.model = None
        self.error: str | None = None
        self.lock = threading.Lock()

    def load(self) -> None:
        try:
            t0 = time.time()
            print(f"[pmrf] loading {HF_ID} on {self.device} ...", flush=True)
            model = MMSERectifiedFlow.from_pretrained(HF_ID)
            # training-only metrics carry float64 state that cannot move to MPS
            for name in ("fid", "inception_score"):
                model._modules.pop(name, None)
            model = model.to(self.device).eval()
            model.freeze()
            self.model = model
            print(f"[pmrf] loaded in {time.time() - t0:.1f}s", flush=True)
        except Exception as e:  # surfaced via /health
            self.error = f"{type(e).__name__}: {e}"
            traceback.print_exc()

    @torch.no_grad()
    def restore(self, img: np.ndarray, steps: int, seed: int | None, mmse_only: bool) -> np.ndarray:
        """img: float32 RGB HWC [0,1], 512x512 aligned face."""
        m = self.model
        y = torch.from_numpy(img.transpose(2, 0, 1))[None].to(self.device)
        if y.shape[-2:] != (512, 512):
            y = torch.nn.functional.interpolate(y, size=(512, 512), mode="bilinear", align_corners=False)
        z0 = m.mmse_model(y).clip(0, 1)  # posterior mean (SwinIR) estimate
        if mmse_only:
            return z0[0].permute(1, 2, 0).cpu().numpy()
        gen = torch.Generator(device="cpu")
        if seed is not None:
            gen.manual_seed(int(seed))
        noise = torch.randn(z0.shape, generator=gen).to(self.device)
        x = z0 + noise * m.hparams.mmse_noise_std
        eps = float(m.hparams.eps)
        dt = (1.0 / steps) * (1.0 - eps)
        t_one = torch.ones(1, device=self.device)
        for i in range(steps):
            t = (i / steps) * (1.0 - eps) + eps
            v = m(x_t=x, t=t_one * t, y=y).to(x.dtype)
            x = x + v * dt
        return x.clip(0, 1)[0].permute(1, 2, 0).float().cpu().numpy()


def make_handler(worker: Worker):
    class H(BaseHTTPRequestHandler):
        def log_message(self, *a):  # quiet
            pass

        def _json(self, code: int, obj: dict) -> None:
            body = json.dumps(obj).encode()
            self.send_response(code)
            self.send_header("content-type", "application/json")
            self.send_header("content-length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)

        def do_GET(self):
            self._json(200, {"ok": worker.error is None, "loaded": worker.model is not None, "device": str(worker.device), "error": worker.error})

        def do_POST(self):
            n = int(self.headers.get("content-length", "0"))
            req = json.loads(self.rfile.read(n) or b"{}")
            if worker.model is None:
                return self._json(503, {"ok": False, "error": worker.error or "model not loaded yet"})
            try:
                t0 = time.time()
                img = np.asarray(Image.open(req["input"]).convert("RGB")).astype(np.float32) / 255.0
                with worker.lock:
                    out = worker.restore(img, int(req.get("steps", 25)), req.get("seed"), bool(req.get("mmse_only", False)))
                Image.fromarray(np.clip(out * 255 + 0.5, 0, 255).astype(np.uint8)).save(req["output"])
                self._json(200, {"ok": True, "ms": int((time.time() - t0) * 1000)})
            except Exception as e:
                traceback.print_exc()
                self._json(500, {"ok": False, "error": f"{type(e).__name__}: {e}"})

    return H


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--port", type=int, default=int(os.environ.get("RC_PMRF_PORT", "8788")))
    ap.add_argument("--device", default=os.environ.get("RC_PMRF_DEVICE") or ("mps" if torch.backends.mps.is_available() else "cuda" if torch.cuda.is_available() else "cpu"))
    ap.add_argument("--selftest", action="store_true", help="load, run one random crop, exit")
    args = ap.parse_args()
    torch.set_grad_enabled(False)
    worker = Worker(args.device)
    if args.selftest:
        worker.load()
        if worker.error:
            sys.exit(1)
        img = np.random.default_rng(0).random((512, 512, 3), dtype=np.float32)
        t0 = time.time(); z = worker.restore(img, 25, 0, True); print("mmse", z.shape, float(z.min()), float(z.max()), f"{time.time() - t0:.1f}s")
        t0 = time.time(); o = worker.restore(img, 5, 0, False); print("flow5", o.shape, float(o.min()), float(o.max()), f"{time.time() - t0:.1f}s")
        return
    threading.Thread(target=worker.load, daemon=True).start()
    # The app (or the CLI) that started us may be killed rather than exit cleanly;
    # a worker with 2 GB of weights must not outlive it. Re-parented to init = orphaned.
    # The launcher passes its pid (RC_PARENT_PID): getppid() here may already be init
    # if it died while torch was importing.
    parent = int(os.environ["RC_PARENT_PID"]) if os.environ.get("RC_PARENT_PID", "").isdigit() else os.getppid()

    def watch_parent() -> None:
        while os.getppid() == parent:
            time.sleep(2.0)
        print("[pmrf] parent gone, exiting", flush=True)
        os._exit(0)

    threading.Thread(target=watch_parent, daemon=True).start()
    srv = ThreadingHTTPServer(("127.0.0.1", args.port), make_handler(worker))
    print(f"[pmrf] serving on 127.0.0.1:{args.port}", flush=True)
    srv.serve_forever()


if __name__ == "__main__":
    main()
