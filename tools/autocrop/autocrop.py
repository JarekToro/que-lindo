#!/usr/bin/env python3
# /// script
# requires-python = ">=3.9"
# dependencies = ["numpy", "opencv-python-headless>=4.8", "tifffile"]
# ///
"""
autocrop — find a photograph lying on a plain(ish) background, straighten it,
and crop it out. Built for high-resolution shots of old prints laid on a grey
towel: the towel is texture, the print is a bright, sharp-edged rectangle.

    uv run autocrop.py scans/ -o cropped/
    python autocrop.py IMG_0001.tif IMG_0002.tif -o cropped/ --debug

How it works, per image:
  1. Downscale for analysis (detection is done at ~1400px, the warp at full res).
  2. GrabCut, seeded with "the border is background, the middle is probably
     foreground" — the towel's colour/texture model separates it from the print
     without any threshold to tune. A colour-distance fallback covers the cases
     GrabCut gives up on.
  3. Largest blob → convex hull → four side-lines fitted to the hull's points.
     Their intersections are the corners. Fitting lines (rather than taking the
     polygon's vertices) recovers the true corner of prints with rounded or
     scalloped edges, which approxPolyDP would shave off.
  4. Perspective warp to a rectangle sized from the longest opposite sides, at
     full resolution, in the source bit depth (8- or 16-bit TIFF preserved).

Exit code is the number of images that failed detection (0 = all cropped).
"""

from __future__ import annotations

import argparse
import concurrent.futures as cf
import os
import sys
from dataclasses import dataclass
from pathlib import Path
from typing import Optional

import cv2
import numpy as np

IMAGE_EXTS = {".tif", ".tiff", ".jpg", ".jpeg", ".png", ".heic", ".webp", ".bmp"}
ANALYSIS_MAX_SIDE = 1400


# ----------------------------------------------------------------------------
# I/O
# ----------------------------------------------------------------------------


def read_image(path: Path) -> np.ndarray:
    """BGR (or BGRA) array in the file's own bit depth. cv2 first; tifffile for
    TIFFs cv2 can't decode (unusual compressions, planar configs)."""
    img = cv2.imread(str(path), cv2.IMREAD_UNCHANGED)
    if img is None and path.suffix.lower() in {".tif", ".tiff"}:
        import tifffile  # optional heavy import, only on the fallback path

        arr = tifffile.imread(str(path))
        if arr.ndim == 4:  # pages × h × w × c: take the first page
            arr = arr[0]
        if arr.ndim == 3 and arr.shape[-1] >= 3:
            arr = np.ascontiguousarray(arr[..., [2, 1, 0] + ([3] if arr.shape[-1] == 4 else [])])
        img = arr
    if img is None:
        raise ValueError(f"could not decode {path}")
    if img.ndim == 2:
        img = cv2.cvtColor(img, cv2.COLOR_GRAY2BGR)
    return img


def to_uint8_bgr(img: np.ndarray) -> np.ndarray:
    """8-bit, 3-channel copy for analysis. Alpha dropped, 16-bit scaled."""
    if img.shape[2] == 4:
        img = img[..., :3]
    if img.dtype == np.uint16:
        return (img >> 8).astype(np.uint8)
    if img.dtype != np.uint8:
        lo, hi = float(img.min()), float(img.max())
        return ((img - lo) / max(hi - lo, 1e-6) * 255).astype(np.uint8)
    return img


# ----------------------------------------------------------------------------
# Detection
# ----------------------------------------------------------------------------


@dataclass
class Detection:
    quad: np.ndarray  # 4×2 float32, full-resolution pixels, TL TR BR BL
    method: str
    area_frac: float
    hull: Optional[np.ndarray] = None  # N×2, full-res, the mask's convex hull (debug)
    confidence: float = 1.0  # weakest side's edge support relative to the strongest


def foreground_mask_grabcut(small: np.ndarray, iters: int) -> np.ndarray:
    h, w = small.shape[:2]
    mask = np.full((h, w), cv2.GC_PR_BGD, np.uint8)
    # Outer 4% ring: the towel, for sure. Inner 40% box: probably the print.
    bx, by = int(w * 0.04), int(h * 0.04)
    mask[:by, :] = cv2.GC_BGD
    mask[-by:, :] = cv2.GC_BGD
    mask[:, :bx] = cv2.GC_BGD
    mask[:, -bx:] = cv2.GC_BGD
    cx0, cx1 = int(w * 0.30), int(w * 0.70)
    cy0, cy1 = int(h * 0.30), int(h * 0.70)
    mask[cy0:cy1, cx0:cx1] = cv2.GC_PR_FGD
    bgd = np.zeros((1, 65), np.float64)
    fgd = np.zeros((1, 65), np.float64)
    # Light blur softens the towel weave so the colour model sees a surface,
    # not thousands of tiny bright fibres.
    blurred = cv2.GaussianBlur(small, (0, 0), 1.2)
    cv2.grabCut(blurred, mask, None, bgd, fgd, iters, cv2.GC_INIT_WITH_MASK)
    fg = np.where((mask == cv2.GC_FGD) | (mask == cv2.GC_PR_FGD), 255, 0).astype(np.uint8)
    return fg


def _border_ring(a: np.ndarray, frac: float = 0.04) -> np.ndarray:
    """Pixels of the outer ring, flattened — the background's own sample."""
    h, w = a.shape[:2]
    bx, by = max(int(w * frac), 2), max(int(h * frac), 2)
    parts = [a[:by], a[-by:], a[:, :bx], a[:, -bx:]]
    return np.concatenate([p.reshape(-1, *a.shape[2:]) for p in parts])


def foreground_mask_towel(small: np.ndarray) -> np.ndarray:
    """The print is whatever is *not* towel. Towel = close to the border's
    colour AND carrying the border's texture. Two cues because each fails
    alone: a dark shadow on the print matches the towel's grey but is smooth;
    gravel on the print matches the texture but not the colour."""
    lab = cv2.cvtColor(cv2.GaussianBlur(small, (0, 0), 1.5), cv2.COLOR_BGR2Lab).astype(np.float32)
    ring = _border_ring(lab)
    med = np.median(ring, axis=0)
    dist = np.linalg.norm(lab - med, axis=2)
    ring_dist = np.linalg.norm(ring - med, axis=1)
    colour_ok = dist < np.percentile(ring_dist, 98) * 1.15

    g = cv2.cvtColor(small, cv2.COLOR_BGR2GRAY).astype(np.float32)
    k = 9
    mu = cv2.blur(g, (k, k))
    std = np.sqrt(np.maximum(cv2.blur(g * g, (k, k)) - mu * mu, 0))
    std = cv2.GaussianBlur(std, (0, 0), 4)
    ring_std = _border_ring(std)
    lo, hi = np.percentile(ring_std, 5), np.percentile(ring_std, 95)
    # Tight below: a smooth shadow on the print reads ~3 where the towel reads
    # ~10-25, and that gap is the whole point of this cue. Looser above: a
    # busier towel corner must not turn into "print".
    texture_ok = (std > lo - 0.15 * (hi - lo) - 0.5) & (std < hi + 0.6 * (hi - lo) + 1.0)

    towel = (colour_ok & texture_ok).astype(np.uint8) * 255
    towel = cv2.morphologyEx(towel, cv2.MORPH_CLOSE, cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (15, 15)))
    return cv2.bitwise_not(towel)


def foreground_mask_colour(small: np.ndarray) -> np.ndarray:
    """Distance from the border's median colour in Lab, Otsu-thresholded.
    Cheap and threshold-free; the last-ditch fallback."""
    lab = cv2.cvtColor(cv2.GaussianBlur(small, (0, 0), 2.0), cv2.COLOR_BGR2Lab).astype(np.float32)
    med = np.median(_border_ring(lab), axis=0)
    dist = np.linalg.norm(lab - med, axis=2)
    dist8 = np.clip(dist / max(dist.max(), 1e-6) * 255, 0, 255).astype(np.uint8)
    _, fg = cv2.threshold(dist8, 0, 255, cv2.THRESH_BINARY | cv2.THRESH_OTSU)
    return fg


def clean_mask(fg: np.ndarray) -> np.ndarray:
    k = max(3, int(min(fg.shape) * 0.01) | 1)
    kernel = cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (k, k))
    fg = cv2.morphologyEx(fg, cv2.MORPH_OPEN, kernel)
    fg = cv2.morphologyEx(fg, cv2.MORPH_CLOSE, kernel)
    # A dark strip across the print (a doorway, a shadow) can split the mask
    # into pieces. Bridge gaps up to ~4% of the frame: nothing else on a towel
    # sits that close to the print.
    kk = max(3, int(min(fg.shape) * 0.04) | 1)
    fg = cv2.morphologyEx(fg, cv2.MORPH_CLOSE, cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (kk, kk)))
    # Fill holes: anything not reachable from the border is inside the print.
    flood = fg.copy()
    hh, ww = fg.shape
    ffmask = np.zeros((hh + 2, ww + 2), np.uint8)
    cv2.floodFill(flood, ffmask, (0, 0), 255)
    holes = cv2.bitwise_not(flood)
    return cv2.bitwise_or(fg, holes)


def order_corners(pts: np.ndarray) -> np.ndarray:
    """TL, TR, BR, BL by angle around the centroid — robust to any rotation."""
    c = pts.mean(axis=0)
    ang = np.arctan2(pts[:, 1] - c[1], pts[:, 0] - c[0])
    # With y pointing down, ascending angle walks TL(-135°)→TR(-45°)→BR(45°)→BL(135°).
    return pts[np.argsort(ang)].astype(np.float32)


def quad_from_hull(hull: np.ndarray) -> Optional[np.ndarray]:
    """Four corners from a convex hull by fitting a line to each side.

    Start from approxPolyDP's four vertices to *assign* hull points to sides,
    then fit each side's line and intersect neighbours. Rounded corners pull
    approxPolyDP's vertices inward; the fitted lines extrapolate past them."""
    pts = hull.reshape(-1, 2).astype(np.float32)
    if len(pts) < 4:
        return None
    peri = cv2.arcLength(hull, True)
    approx = None
    for eps in np.linspace(0.01, 0.12, 23):
        cand = cv2.approxPolyDP(hull, eps * peri, True)
        if len(cand) == 4:
            approx = cand.reshape(4, 2).astype(np.float32)
            break
        if len(cand) < 4:
            break
    if approx is None:
        rect = cv2.minAreaRect(hull)
        approx = cv2.boxPoints(rect).astype(np.float32)
    approx = order_corners(approx)

    # Assign each hull point to the nearest side segment of the approx quad,
    # dropping points near the vertices (that's where rounded corners live).
    lines = []
    for i in range(4):
        a, b = approx[i], approx[(i + 1) % 4]
        ab = b - a
        L = np.linalg.norm(ab) + 1e-6
        n = np.array([-ab[1], ab[0]]) / L
        t = ((pts - a) @ ab) / (L * L)
        d = np.abs((pts - a) @ n)
        near = (d < 0.03 * L) & (t > 0.12) & (t < 0.88)
        side = pts[near]
        if len(side) < 2:
            side = np.stack([a, b])
        vx, vy, x0, y0 = cv2.fitLine(side, cv2.DIST_HUBER, 0, 0.01, 0.01).ravel()
        lines.append((np.array([x0, y0]), np.array([vx, vy])))

    corners = []
    for i in range(4):
        (p1, d1), (p2, d2) = lines[(i - 1) % 4], lines[i]
        denom = d1[0] * d2[1] - d1[1] * d2[0]
        if abs(denom) < 1e-6:
            return None
        t = ((p2[0] - p1[0]) * d2[1] - (p2[1] - p1[1]) * d2[0]) / denom
        corners.append(p1 + t * d1)
    return order_corners(np.array(corners, np.float32))


def gradient_magnitude(small: np.ndarray) -> np.ndarray:
    """Edge strength with the towel weave blurred away; the print's border is
    a long, straight ridge in this map, the weave is short-range noise."""
    g = cv2.cvtColor(cv2.GaussianBlur(small, (0, 0), 2.0), cv2.COLOR_BGR2GRAY).astype(np.float32)
    gx = cv2.Sobel(g, cv2.CV_32F, 1, 0, ksize=3)
    gy = cv2.Sobel(g, cv2.CV_32F, 0, 1, ksize=3)
    mag = np.sqrt(gx * gx + gy * gy)
    return mag / max(float(np.percentile(mag, 99.5)), 1e-6)


def snap_side(mag: np.ndarray, a: np.ndarray, b: np.ndarray, reach_in: float, reach_out: float, outward: np.ndarray) -> tuple[np.ndarray, np.ndarray]:
    """Slide and tilt the segment a→b within `reach` pixels to sit on the
    strongest straight ridge of `mag`. Brute force over (offset, angle): a few
    thousand candidates × a few hundred samples — instant, and unfoolable by
    the towel's dense but directionless texture."""
    h, w = mag.shape
    ab = b - a
    L = float(np.linalg.norm(ab)) + 1e-6
    d = ab / L
    n = np.array([-d[1], d[0]], np.float32)
    mid = (a + b) / 2
    # Only the middle 80% of the side votes: corners are where the print may
    # be rounded, torn, or lifting off the towel.
    ts = np.linspace(-0.4, 0.4, 240).astype(np.float32) * L
    # The mask under-segments, so the true edge is at or *outside* the guess:
    # search further outward than inward. `outward` says which way that is.
    sign = 1.0 if float(n @ outward) > 0 else -1.0
    offsets = (np.arange(-reach_in, reach_out + 0.5, 1.0, np.float32) * sign).astype(np.float32)
    reach = max(reach_in, reach_out)
    angles = np.deg2rad(np.linspace(-4.0, 4.0, 41)).astype(np.float32)
    best = (-1.0, 0.0, 0.0)
    for ang in angles:
        c, s_ = np.cos(ang), np.sin(ang)
        dr = np.array([d[0] * c - d[1] * s_, d[0] * s_ + d[1] * c], np.float32)
        nr = np.array([-dr[1], dr[0]], np.float32)
        base = mid[None, :] + ts[:, None] * dr[None, :]  # 240×2
        pts = base[None, :, :] + offsets[:, None, None] * nr[None, None, :]  # O×240×2
        xs = np.clip(np.rint(pts[..., 0]).astype(np.int32), 0, w - 1)
        ys = np.clip(np.rint(pts[..., 1]).astype(np.int32), 0, h - 1)
        score = mag[ys, xs].mean(axis=1)  # O
        # Mild pull toward the starting guess breaks ties among parallel ridges.
        score -= 0.06 * np.abs(offsets) / max(reach, 1)
        i = int(np.argmax(score))
        if score[i] > best[0]:
            best = (float(score[i]), float(offsets[i]), float(ang))
    _, off, ang = best
    c, s_ = np.cos(ang), np.sin(ang)
    dr = np.array([d[0] * c - d[1] * s_, d[0] * s_ + d[1] * c], np.float32)
    nr = np.array([-dr[1], dr[0]], np.float32)
    p = mid + off * nr
    return p.astype(np.float32), dr


def intersect(p1: np.ndarray, d1: np.ndarray, p2: np.ndarray, d2: np.ndarray) -> Optional[np.ndarray]:
    denom = d1[0] * d2[1] - d1[1] * d2[0]
    if abs(denom) < 1e-6:
        return None
    t = ((p2[0] - p1[0]) * d2[1] - (p2[1] - p1[1]) * d2[0]) / denom
    return p1 + t * d1


def refine_quad(quad: np.ndarray, mag: np.ndarray, reach_in: float, reach_out: float) -> Optional[np.ndarray]:
    c = quad.mean(axis=0)
    lines = []
    for i in range(4):
        a, b = quad[i], quad[(i + 1) % 4]
        lines.append(snap_side(mag, a, b, reach_in, reach_out, (a + b) / 2 - c))
    corners = []
    for i in range(4):
        (p1, d1), (p2, d2) = lines[(i - 1) % 4], lines[i]
        c = intersect(p1, d1, p2, d2)
        if c is None:
            return None
        corners.append(c)
    return order_corners(np.array(corners, np.float32))


def plausible(q: np.ndarray, h: int, w: int) -> bool:
    """Inside the frame (give or take), convex, and not a sliver."""
    if (q[:, 0] < -0.05 * w).any() or (q[:, 0] > 1.05 * w).any() or (q[:, 1] < -0.05 * h).any() or (q[:, 1] > 1.05 * h).any():
        return False
    if not cv2.isContourConvex(q.reshape(-1, 1, 2)):
        return False
    sides = [np.linalg.norm(q[(i + 1) % 4] - q[i]) for i in range(4)]
    return min(sides) > 0.04 * min(h, w) and max(sides) / min(sides) < 6


def line_support(mag: np.ndarray, a: np.ndarray, b: np.ndarray) -> float:
    """Mean edge strength along the middle 80% of segment a→b."""
    h, w = mag.shape
    ts = np.linspace(0.1, 0.9, 200)
    xs = np.clip(np.rint(a[0] + (b[0] - a[0]) * ts).astype(np.int32), 0, w - 1)
    ys = np.clip(np.rint(a[1] + (b[1] - a[1]) * ts).astype(np.int32), 0, h - 1)
    return float(mag[ys, xs].mean())


def enclosing_quad(hull: np.ndarray, mag: np.ndarray) -> Optional[np.ndarray]:
    """Best quadrilateral enclosing a convex hull, judged by the image.

    Segmentation only ever *loses* parts of the print (a dark corner, a busy
    edge), so the mask is a subset of the print and the print's outline is a
    quad that contains the hull. Candidate side directions are the hull's own
    edges (longest first) plus the perpendiculars of the longest few, so a
    side the mask lost entirely can still be completed at right angles. Each
    direction's supporting line hugs the hull; every valid 4-combination is
    intersected, and the winner is the quad whose sides run along the
    strongest edges in the picture — the print's real border is a long, sharp
    ridge, a diagonal cut through the mask is not. Area breaks ties toward
    the tighter fit."""
    pts = hull.reshape(-1, 2).astype(np.float64)
    if len(pts) < 3:
        return None
    c = pts.mean(axis=0)
    cands: list[tuple[float, np.ndarray]] = []  # (edge length as weight, outward unit normal)
    n_pts = len(pts)
    for i in range(n_pts):
        p0, p1 = pts[i], pts[(i + 1) % n_pts]
        e = p1 - p0
        L = np.linalg.norm(e)
        if L < 1e-6:
            continue
        n = np.array([-e[1], e[0]]) / L
        if np.dot(n, (p0 + p1) / 2 - c) < 0:
            n = -n
        cands.append((L, n))
    cands.sort(key=lambda t: -t[0])
    top = cands[:14]
    for L, n in cands[:4]:
        perp = np.array([-n[1], n[0]])
        top.append((L * 0.5, perp))
        top.append((L * 0.5, -perp))
    # Dedupe near-identical normals (within 3°).
    normals: list[np.ndarray] = []
    for _, n in top:
        if all(abs(np.arctan2(n[0] * m[1] - n[1] * m[0], n @ m)) > np.deg2rad(3) for m in normals):
            normals.append(n)
    offsets = [float((pts @ n).max()) for n in normals]
    angles = [float(np.arctan2(n[1], n[0])) for n in normals]
    order = np.argsort(angles)
    normals = [normals[i] for i in order]
    offsets = [offsets[i] for i in order]
    angles = [angles[i] for i in order]
    k = len(normals)
    best_score, best = None, None
    from itertools import combinations

    lo_gap, hi_gap = np.deg2rad(40), np.deg2rad(140)
    for combo in combinations(range(k), 4):
        ok = True
        corners = []
        for j in range(4):
            a, b = combo[j], combo[(j + 1) % 4]
            gap = (angles[b] - angles[a]) % (2 * np.pi)
            if not (lo_gap <= gap <= hi_gap):
                ok = False
                break
            A = np.array([normals[a], normals[b]])
            det = np.linalg.det(A)
            if abs(det) < 1e-9:
                ok = False
                break
            corners.append(np.linalg.solve(A, np.array([offsets[a], offsets[b]])))
        if not ok:
            continue
        q = np.array(corners)
        x, y = q[:, 0], q[:, 1]
        area = 0.5 * abs(np.dot(x, np.roll(y, -1)) - np.dot(y, np.roll(x, -1)))
        hull_area = cv2.contourArea(pts.astype(np.float32).reshape(-1, 1, 2))
        if area > 3.0 * hull_area:
            continue
        supports = [line_support(mag, q[j], q[(j + 1) % 4]) for j in range(4)]
        # Every side has to be an edge: the weakest side counts double.
        score = (sum(supports) + min(supports)) / 5 - 0.02 * (area / hull_area - 1)
        if best_score is None or score > best_score:
            best_score, best = score, q
    if best is None:
        return None
    return order_corners(best.astype(np.float32))


def quads_from_mask(fg: np.ndarray, mag: np.ndarray, min_area_frac: float, multi: bool) -> list[tuple[np.ndarray, float, np.ndarray]]:
    h, w = fg.shape
    contours, _ = cv2.findContours(fg, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
    out = []
    for c in sorted(contours, key=cv2.contourArea, reverse=True):
        hull = cv2.convexHull(c)
        frac = cv2.contourArea(hull) / (h * w)
        if frac < min_area_frac:
            break
        # A print is a solid rectangle. Dark regions along its edge can bite
        # into the mask, so this is lenient; the enclosing quad and the edge
        # snap put the rest back.
        if cv2.contourArea(c) / max(cv2.contourArea(hull), 1) < 0.6:
            continue
        simple = cv2.approxPolyDP(hull, 0.004 * cv2.arcLength(hull, True), True)
        q = enclosing_quad(simple, mag)
        if q is None or not plausible(q, h, w):
            q = quad_from_hull(hull)
        if q is None or not plausible(q, h, w):
            continue
        out.append((q, frac, simple.reshape(-1, 2).astype(np.float32)))
        if not multi:
            break
    return out


def detect(img8: np.ndarray, min_area_frac: float, multi: bool, grabcut_iters: int) -> list[Detection]:
    h, w = img8.shape[:2]
    scale = min(1.0, ANALYSIS_MAX_SIDE / max(h, w))
    small = cv2.resize(img8, None, fx=scale, fy=scale, interpolation=cv2.INTER_AREA) if scale < 1 else img8
    sh, sw = small.shape[:2]
    mag = gradient_magnitude(small)

    def union(*fns):
        acc = None
        for fn in fns:
            try:
                m = fn()
            except cv2.error:
                continue
            acc = m if acc is None else cv2.bitwise_or(acc, m)
        return acc if acc is not None else np.zeros((sh, sw), np.uint8)

    attempts = [
        # Both estimates under-segment the print in different places (towel
        # cues miss grey textured regions, GrabCut misses dark ones); their
        # union is far closer to the true rectangle than either alone.
        ("towel+grabcut", lambda: union(lambda: foreground_mask_towel(small), lambda: foreground_mask_grabcut(small, grabcut_iters))),
        ("towel", lambda: foreground_mask_towel(small)),
        ("grabcut", lambda: foreground_mask_grabcut(small, grabcut_iters)),
        ("colour", lambda: foreground_mask_colour(small)),
    ]
    for name, make in attempts:
        fg = clean_mask(make())
        found = quads_from_mask(fg, mag, min_area_frac, multi)
        # The whole frame being "foreground" means the seeds failed, not a hit.
        found = [(q, f, hl) for q, f, hl in found if f < 0.97]
        if not found:
            continue
        dets = []
        for q, f, hl in found:
            refined = refine_quad(q, mag, reach_in=0.02 * max(sh, sw), reach_out=0.10 * max(sh, sw))
            if refined is not None and plausible(refined, sh, sw):
                q = refined
            # A side that found no edge to sit on (the print runs off the frame,
            # or the mask lost a whole side) shows up as weak support.
            sup = [line_support(mag, q[j], q[(j + 1) % 4]) for j in range(4)]
            conf = min(sup) / max(max(sup), 1e-6)
            dets.append(Detection(q / scale, name, f, hl / scale, conf))
        return dets
    return []


# ----------------------------------------------------------------------------
# Warp
# ----------------------------------------------------------------------------


def warp(img: np.ndarray, quad: np.ndarray, inset_frac: float) -> np.ndarray:
    tl, tr, br, bl = quad
    wid = int(round(max(np.linalg.norm(tr - tl), np.linalg.norm(br - bl))))
    hei = int(round(max(np.linalg.norm(bl - tl), np.linalg.norm(br - tr))))
    if wid < 8 or hei < 8:
        raise ValueError("degenerate quad")
    dst = np.array([[0, 0], [wid - 1, 0], [wid - 1, hei - 1], [0, hei - 1]], np.float32)
    M = cv2.getPerspectiveTransform(quad.astype(np.float32), dst)
    out = cv2.warpPerspective(img, M, (wid, hei), flags=cv2.INTER_CUBIC, borderMode=cv2.BORDER_REPLICATE)
    if inset_frac > 0:
        ix, iy = int(wid * inset_frac), int(hei * inset_frac)
        out = out[iy : hei - iy, ix : wid - ix]
    return out


def draw_debug(img8: np.ndarray, dets: list[Detection]) -> np.ndarray:
    h, w = img8.shape[:2]
    scale = min(1.0, 1600 / max(h, w))
    vis = cv2.resize(img8, None, fx=scale, fy=scale) if scale < 1 else img8.copy()
    for i, d in enumerate(dets):
        if d.hull is not None:
            hl = (d.hull * scale).astype(np.int32)
            cv2.polylines(vis, [hl.reshape(-1, 1, 2)], True, (255, 160, 0), 2)
        q = (d.quad * scale).astype(np.int32)
        cv2.polylines(vis, [q.reshape(-1, 1, 2)], True, (0, 255, 0), 3)
        for j, (x, y) in enumerate(q):
            cv2.circle(vis, (int(x), int(y)), 8, (0, 0, 255), -1)
            cv2.putText(vis, "TL TR BR BL".split()[j], (int(x) + 10, int(y) - 10), cv2.FONT_HERSHEY_SIMPLEX, 0.7, (0, 0, 255), 2)
        cv2.putText(vis, f"#{i} {d.method} {d.area_frac:.0%}", (12, 30 + 28 * i), cv2.FONT_HERSHEY_SIMPLEX, 0.8, (0, 255, 0), 2)
    return vis


# ----------------------------------------------------------------------------
# Driver
# ----------------------------------------------------------------------------


@dataclass
class Job:
    src: Path
    out_dir: Path
    fmt: Optional[str]
    inset: float
    min_area: float
    multi: bool
    debug: bool
    grabcut_iters: int
    jpeg_quality: int


CHECK_BELOW = 0.35


def process(job: Job) -> tuple[Path, str, int, bool]:
    """Returns (source, message, crops written, needs-a-look). 0 crops = failure."""
    try:
        img = read_image(job.src)
        img8 = to_uint8_bgr(img)
        dets = detect(img8, job.min_area, job.multi, job.grabcut_iters)
        shaky = any(d.confidence < CHECK_BELOW for d in dets)
        if job.debug or shaky:
            job.out_dir.mkdir(parents=True, exist_ok=True)
            cv2.imwrite(str(job.out_dir / f"{job.src.stem}.debug.jpg"), draw_debug(img8, dets), [cv2.IMWRITE_JPEG_QUALITY, 80])
        if not dets:
            return job.src, "no photo found", 0, False
        job.out_dir.mkdir(parents=True, exist_ok=True)
        ext = f".{job.fmt.lstrip('.')}" if job.fmt else job.src.suffix
        if ext.lower() in {".jpg", ".jpeg"} and img.dtype != np.uint8:
            img = to_uint8_bgr(img)  # JPEG is 8-bit only
        written = 0
        for i, d in enumerate(dets):
            out = warp(img, d.quad, job.inset)
            suffix = f"-{i + 1}" if len(dets) > 1 else ""
            dst = job.out_dir / f"{job.src.stem}{suffix}{ext}"
            params = [cv2.IMWRITE_JPEG_QUALITY, job.jpeg_quality] if ext.lower() in {".jpg", ".jpeg"} else []
            if ext.lower() in {".tif", ".tiff"}:
                params = [cv2.IMWRITE_TIFF_COMPRESSION, 5]  # LZW: lossless, smaller than raw
            if not cv2.imwrite(str(dst), out, params):
                return job.src, f"failed to write {dst.name}", written, shaky
            written += 1
        sizes = ", ".join(f"{d.quad[1][0] - d.quad[0][0]:.0f}px wide, {d.method}, edge confidence {d.confidence:.2f}" for d in dets)
        return job.src, f"{written} crop(s): {sizes}", written, shaky
    except Exception as e:  # one bad file must not kill the batch
        return job.src, f"error: {e}", 0, False


def gather(inputs: list[str]) -> list[Path]:
    files: list[Path] = []
    for raw in inputs:
        p = Path(raw).expanduser()
        if p.is_dir():
            files += sorted(q for q in p.iterdir() if q.suffix.lower() in IMAGE_EXTS and not q.name.startswith("."))
        elif p.exists():
            files.append(p)
        else:
            print(f"skip (missing): {p}", file=sys.stderr)
    return files


def main(argv: Optional[list[str]] = None) -> int:
    ap = argparse.ArgumentParser(description="Straighten and crop photographs shot against a plain background.")
    ap.add_argument("inputs", nargs="+", help="image files and/or directories")
    ap.add_argument("-o", "--out", default="cropped", help="output directory (default: ./cropped)")
    ap.add_argument("--format", default=None, help="output extension, e.g. tif, png, jpg (default: same as source)")
    ap.add_argument("--inset", type=float, default=0.4, help="shave this %% off every edge after the warp, to lose any towel fringe (default 0.4)")
    ap.add_argument("--min-area", type=float, default=8.0, help="ignore blobs smaller than this %% of the frame (default 8)")
    ap.add_argument("--multi", action="store_true", help="extract every photo in the frame, not just the largest")
    ap.add_argument("--debug", action="store_true", help="also write <name>.debug.jpg with the detected corners drawn")
    ap.add_argument("--grabcut-iters", type=int, default=5)
    ap.add_argument("--jpeg-quality", type=int, default=95)
    ap.add_argument("-j", "--jobs", type=int, default=max(1, (os.cpu_count() or 2) // 2), help="parallel workers")
    ap.add_argument("--overwrite", action="store_true", help="re-crop files whose output already exists")
    args = ap.parse_args(argv)

    files = gather(args.inputs)
    if not files:
        print("nothing to do", file=sys.stderr)
        return 1
    out_dir = Path(args.out).expanduser()
    if not args.overwrite:
        ext = f".{args.format.lstrip('.')}" if args.format else None
        todo = [f for f in files if not (out_dir / f"{f.stem}{ext or f.suffix}").exists()]
        skipped = len(files) - len(todo)
        if skipped:
            print(f"skipping {skipped} already cropped (use --overwrite to redo)")
        files = todo

    jobs = [
        Job(f, out_dir, args.format, args.inset / 100, args.min_area / 100, args.multi, args.debug, args.grabcut_iters, args.jpeg_quality)
        for f in files
    ]
    failures = 0
    checks: list[str] = []
    width = max((len(f.name) for f in files), default=10)
    with cf.ProcessPoolExecutor(max_workers=args.jobs) as ex:
        for src, msg, n, shaky in ex.map(process, jobs):
            if n == 0:
                failures += 1
            elif shaky:
                checks.append(src.name)
            tag = "FAIL " if n == 0 else "CHECK" if shaky else "OK   "
            print(f"{tag} {src.name:<{width}}  {msg}", flush=True)
    print(f"\n{len(jobs) - failures}/{len(jobs)} cropped → {out_dir}" + (f"  ({failures} failed; try --debug)" if failures else ""))
    if checks:
        print(f"{len(checks)} worth a look (one edge found little to sit on — print off the frame, or a lost side); "
              f"their .debug.jpg overlays are in {out_dir}:\n  " + "\n  ".join(checks))
    return failures


if __name__ == "__main__":
    sys.exit(main())
