"""Run Microsoft 'Bringing Old Photos Back to Life' over an image or a folder, no UI.

  .venv/bin/python bopbtl.py photos/ restored/                 # global restoration only (no face stages)
  .venv/bin/python bopbtl.py photos/ restored/ --faces         # full upstream pipeline incl. face enhancement
  .venv/bin/python bopbtl.py photos/ restored/ --scratch       # also detect + inpaint scratches
  .venv/bin/python bopbtl.py in.jpg out.png

The whole folder is processed in one model load (much faster than per image). CPU only.
"""
from __future__ import annotations

import argparse
import shutil
import sys
import tempfile
import time
from pathlib import Path

import engine

IMAGE_EXTS = {".png", ".jpg", ".jpeg", ".webp", ".tif", ".tiff", ".bmp"}


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("input", type=Path)
    ap.add_argument("output", type=Path)
    ap.add_argument("--faces", action="store_true", help="run dlib face detection + face enhancement stages too")
    ap.add_argument("--scratch", action="store_true", help="scratch detection + inpainting")
    ap.add_argument("--hr", action="store_true", help="512px face model (with --faces)")
    args = ap.parse_args()

    log: list[str] = []
    t0 = time.time()
    with tempfile.TemporaryDirectory(prefix="rc_bopbtl_batch_") as td:
        if args.input.is_dir():
            files = sorted(p for p in args.input.iterdir() if p.suffix.lower() in IMAGE_EXTS)
            if not files:
                sys.exit(f"no images in {args.input}")
            in_dir, final = args.input, args.output
            names = {p.stem for p in files}
        else:
            if not args.input.exists():
                sys.exit(f"not found: {args.input}")
            in_dir = Path(td) / "in"
            in_dir.mkdir()
            shutil.copy(args.input, in_dir / args.input.name)
            final, names = args.output.parent, {args.input.stem}
        print(f"BOPBTL {'full pipeline' if args.faces else 'global restoration only'} on {len(names)} image(s)...", flush=True)
        try:
            res_dir = engine.bopbtl_folder(in_dir, Path(td) / "out", args.scratch, args.hr, args.faces, log)
        except Exception as e:
            sys.exit(f"FAILED: {e}\n" + "\n".join(log[-3:]))
        final.mkdir(parents=True, exist_ok=True)
        done = 0
        for p in sorted(res_dir.iterdir()):
            if p.suffix.lower() == ".png" and p.stem in names:
                dst = final / (args.output.name if not args.input.is_dir() else p.name)
                shutil.copy(p, dst)
                done += 1
        missing = names - {p.stem for p in res_dir.iterdir()}
    print(f"done: {done} written to {final}  {time.time() - t0:.0f}s" + (f"  MISSING: {sorted(missing)}" if missing else ""))


if __name__ == "__main__":
    main()
