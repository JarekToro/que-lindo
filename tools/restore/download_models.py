"""Download a starter set of restoration weights into ./models.

Usage: .venv/bin/python download_models.py [name ...]   (no args = list)
"""
from __future__ import annotations

import os
import sys
import urllib.request
from pathlib import Path

try:  # python.org macOS builds ship without root certs
    import certifi

    os.environ.setdefault("SSL_CERT_FILE", certifi.where())
except ImportError:
    pass

MODELS = {
    # real-world denoisers (film grain friendly)
    "scunet_color_real_psnr": "https://github.com/cszn/KAIR/releases/download/v1.0/scunet_color_real_psnr.pth",
    "scunet_color_real_gan": "https://github.com/cszn/KAIR/releases/download/v1.0/scunet_color_real_gan.pth",
    # restormer
    "restormer_real_denoising": "https://github.com/swz30/Restormer/releases/download/v1.0/real_denoising.pth",
    "restormer_motion_deblurring": "https://github.com/swz30/Restormer/releases/download/v1.0/motion_deblurring.pth",
    "restormer_single_image_defocus_deblurring": "https://github.com/swz30/Restormer/releases/download/v1.0/single_image_defocus_deblurring.pth",
    # face restoration
    "GFPGANv1.4": "https://github.com/TencentARC/GFPGAN/releases/download/v1.3.4/GFPGANv1.4.pth",
    "GFPGANv1.3": "https://github.com/TencentARC/GFPGAN/releases/download/v1.3.0/GFPGANv1.3.pth",
    "codeformer": "https://github.com/sczhou/CodeFormer/releases/download/v0.1.0/codeformer.pth",
    "RestoreFormer": "https://github.com/wzhouxiff/RestoreFormerPlusPlus/releases/download/v1.0.0/RestoreFormer.ckpt",  # RestoreFormer++ not supported by spandrel
    # swinir real-world denoise / jpeg
    "swinir_color_dn_noise15": "https://github.com/JingyunLiang/SwinIR/releases/download/v0.0/005_colorDN_DFWB_s128w8_SwinIR-M_noise15.pth",
    "swinir_jpeg_q40_color": "https://github.com/JingyunLiang/SwinIR/releases/download/v0.0/006_colorCAR_DFWB_s126w7_SwinIR-M_jpeg40.pth",
}

# NAFNet weights live on Google Drive; drop them in models/ by hand:
#   https://github.com/megvii-research/NAFNet#results-and-pre-trained-models
# 1x OpenModelDB models: https://openmodeldb.info/?t=1x  -> save .pth/.safetensors into models/


def convert_lightning_ckpt(src: Path, dst: Path) -> Path:
    """Unwrap a pytorch-lightning checkpoint (RestoreFormer) into a plain state_dict .pth."""
    import torch

    ck = torch.load(src, map_location="cpu", weights_only=False)
    sd = ck.get("state_dict", ck)
    prefix = "vqvae."
    sd = {k[len(prefix):] if k.startswith(prefix) else k: v for k, v in sd.items()}
    sd.pop("quantize.utility_counter", None)  # training-only buffer, not part of the arch
    torch.save(sd, dst)
    src.unlink()
    return dst


def main(argv: list[str]) -> None:
    dest = Path(__file__).parent / "models"
    dest.mkdir(exist_ok=True)
    if not argv:
        print("available:\n  " + "\n  ".join(MODELS))
        print("\nrun: python download_models.py all   (or a subset of names)")
        return
    names = list(MODELS) if argv == ["all"] else argv
    failed: list[str] = []
    for n in names:
        url = MODELS.get(n)
        if not url:
            print(f"unknown: {n}")
            continue
        out = dest / (n + Path(url).suffix)
        if out.exists():
            print(f"skip {out.name} (exists)")
            continue
        print(f"get  {out.name}  <- {url}")
        tmp = out.with_suffix(".part")
        try:
            urllib.request.urlretrieve(url, tmp)
            if out.suffix == ".ckpt":
                out = convert_lightning_ckpt(tmp, out.with_suffix(".pth"))
            else:
                tmp.rename(out)
        except Exception as e:  # keep going; report at the end
            tmp.unlink(missing_ok=True)
            failed.append(f"{n}: {e}")
            print(f"FAIL {n}: {e}")
    print("done" + (f", {len(failed)} failed:\n  " + "\n  ".join(failed) if failed else ""))


if __name__ == "__main__":
    main(sys.argv[1:])
