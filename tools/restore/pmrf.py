"""Run PMRF on an image or a folder, no UI.

  .venv/bin/python pmrf.py in.jpg out.png
  .venv/bin/python pmrf.py in.jpg out.png --steps 10 --seed 3 --blend 0.6
  .venv/bin/python pmrf.py photos/ restored/ --steps 25          # every image in the folder
  .venv/bin/python pmrf.py in.jpg out.png --mmse                  # posterior-mean estimate only

Faces are detected, aligned, restored, and pasted back. Non-face pixels are untouched.
Starts external/pmrf_worker.py on first use and leaves it running for later calls.
"""
from __future__ import annotations

import argparse
import hashlib
import sys
import time
from pathlib import Path

import engine

IMAGE_EXTS = {".png", ".jpg", ".jpeg", ".webp", ".tif", ".tiff", ".bmp"}


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("input", type=Path, help="image file or folder")
    ap.add_argument("output", type=Path, help="output file (or folder when input is a folder)")
    ap.add_argument("--steps", type=int, default=25, help="flow steps (default 25; fewer = closer to posterior mean)")
    ap.add_argument("--seed", type=int, default=0)
    ap.add_argument("--blend", type=float, default=1.0, help="0..1 blend of result over input (default 1)")
    ap.add_argument("--mmse", action="store_true", help="posterior-mean (SwinIR) estimate only, no flow")
    args = ap.parse_args()

    step = {"type": "pmrf", "steps": args.steps, "seed": args.seed, "mmse": args.mmse, "blend": args.blend}
    if args.input.is_dir():
        files = sorted(p for p in args.input.iterdir() if p.suffix.lower() in IMAGE_EXTS)
        if not files:
            sys.exit(f"no images in {args.input}")
        args.output.mkdir(parents=True, exist_ok=True)
        pairs = [(p, args.output / (p.stem + ".png")) for p in files]
    else:
        if not args.input.exists():
            sys.exit(f"not found: {args.input}")
        args.output.parent.mkdir(parents=True, exist_ok=True)
        pairs = [(args.input, args.output)]

    failed: list[str] = []
    for src, dst in pairs:
        t0 = time.time()
        img = engine.load_image(src)
        base = hashlib.sha1(src.read_bytes()).hexdigest()[:16]  # raw PMRF output is cached; blend sweeps are free
        try:
            out, log = engine.run_pipeline(img, [step], progress=lambda s: print(f"  {s}", flush=True), cache_base=base)
        except Exception as e:
            print(f"FAIL {src.name}: {e}", file=sys.stderr)
            failed.append(src.name)
            continue
        engine.save_png(out, dst)
        faces = next((l for l in log if l.startswith("faces detected")), "")
        print(f"{src.name} -> {dst}  {faces}  {time.time() - t0:.1f}s", flush=True)
    if failed:
        print(f"{len(failed)} failed: {' '.join(failed)}  (re-run the same command: finished images are cached and skip instantly)", flush=True)


if __name__ == "__main__":
    main()
