#!/usr/bin/env python3
# /// script
# requires-python = ">=3.9"
# dependencies = ["numpy", "opencv-python-headless>=4.8"]
# ///
"""Stage a photograph as a print lying on a table, for the README's crop shot.

    make-print-photo.py PHOTO OUT.jpg

The print gets a white border, a slight tilt and perspective, and a soft
shadow, on a warm grey cloth with a little texture: what a phone snap of an
old print looks like before tools/autocrop straightens it. The screenshot
spec runs this with the restore engine's Python (it has numpy and OpenCV).
"""
from __future__ import annotations

import sys

import cv2
import numpy as np


def main(src: str, dst: str) -> None:
    photo = cv2.imread(src, cv2.IMREAD_COLOR)
    if photo is None:
        sys.exit(f"could not read {src}")
    W, H = 2400, 1800
    rng = np.random.default_rng(7)

    # The cloth: warm grey with a real weave. The detector separates print
    # from background by the border's colour and its texture, so the texture
    # has to be there (fine, high-contrast, everywhere) and the tone must not
    # drift across the frame: a vignette reads as "the border is darker than
    # the middle", which is exactly what a print looks like.
    base = np.array([124, 128, 136], np.float32)[None, None, :]
    weave = rng.normal(0, 16, (H, W, 1)).astype(np.float32)
    # Directional blur along x and y separately gives a woven look rather than
    # static.
    warp_ = cv2.blur(weave, (3, 1))
    weft = cv2.blur(weave, (1, 3))
    weave = (0.5 * warp_ + 0.5 * weft)[..., None] if warp_.ndim == 2 else 0.5 * warp_ + 0.5 * weft
    cloth = np.clip(base + weave, 0, 255).astype(np.uint8)

    # The print: photo inside a white border, sized to sit in the frame.
    # Fit the print inside about 60% of the frame whichever way it is oriented.
    scale = min(1400 / photo.shape[1], 1080 / photo.shape[0])
    inner = cv2.resize(photo, None, fx=scale, fy=scale, interpolation=cv2.INTER_AREA)
    b = 34
    print_img = cv2.copyMakeBorder(inner, b, b, b, b, cv2.BORDER_CONSTANT, value=(242, 244, 246))
    ph, pw = print_img.shape[:2]

    # Slightly tilted, slightly foreshortened, off centre.
    src_q = np.float32([[0, 0], [pw, 0], [pw, ph], [0, ph]])
    cx, cy = W * 0.52, H * 0.5
    ang = np.deg2rad(-6.0)
    c, s = np.cos(ang), np.sin(ang)
    rot = np.array([[c, -s], [s, c]], np.float32)
    corners = (src_q - [pw / 2, ph / 2]) @ rot.T + [cx, cy]
    # Perspective: the far (top) edge a touch narrower.
    corners[0] += [22, 14]
    corners[1] += [-22, 14]
    dst_q = corners.astype(np.float32)
    M = cv2.getPerspectiveTransform(src_q, dst_q)
    warped = cv2.warpPerspective(print_img, M, (W, H), flags=cv2.INTER_CUBIC)
    mask = cv2.warpPerspective(np.full((ph, pw), 255, np.uint8), M, (W, H))

    # A soft shadow under the print, offset down-right.
    shadow = cv2.GaussianBlur(np.roll(np.roll(mask, 18, axis=0), 14, axis=1), (0, 0), 22).astype(np.float32) / 255
    out = cloth.astype(np.float32) * (1 - 0.45 * shadow[..., None])
    m = (mask > 0)[..., None]
    out = np.where(m, warped.astype(np.float32), out)
    cv2.imwrite(dst, np.clip(out, 0, 255).astype(np.uint8), [cv2.IMWRITE_JPEG_QUALITY, 92])
    print(f"wrote {dst} ({W}x{H}); print corners {dst_q.round().tolist()}")


if __name__ == "__main__":
    if len(sys.argv) != 3:
        sys.exit(__doc__)
    main(sys.argv[1], sys.argv[2])
