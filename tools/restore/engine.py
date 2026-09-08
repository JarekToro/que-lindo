"""Model loading + pipeline execution for the restore-compare tool."""
from __future__ import annotations

import atexit
import hashlib
import json
import os
import shlex
import subprocess
import urllib.request
import urllib.error
import tempfile
import threading
import time
from collections import OrderedDict
from pathlib import Path
from typing import Any, Callable

import cv2
import numpy as np
import torch
from PIL import Image, ImageOps

try:  # facexlib downloads detector weights via urllib; python.org builds lack root certs
    import certifi

    os.environ.setdefault("SSL_CERT_FILE", certifi.where())
except ImportError:
    pass

import spandrel
import spandrel_extra_arches

spandrel_extra_arches.install()

ROOT = Path(__file__).parent
# RC_MODELS_DIR / RC_CACHE_DIR relocate the weights and the result cache (the
# desktop app points them at its own data folder); default is beside this file.
MODELS_DIR = Path(os.environ.get("RC_MODELS_DIR") or ROOT / "models")
CACHE_DIR = Path(os.environ.get("RC_CACHE_DIR") or ROOT / "cache")
FACEX_DIR = MODELS_DIR / "facexlib"
MODEL_EXTS = {".pth", ".pt", ".safetensors", ".ckpt"}

if os.environ.get("RC_DEVICE"):
    DEVICE = torch.device(os.environ["RC_DEVICE"])
elif torch.backends.mps.is_available():
    DEVICE = torch.device("mps")
elif torch.cuda.is_available():
    DEVICE = torch.device("cuda")
else:
    DEVICE = torch.device("cpu")

MAX_LOADED = int(os.environ.get("RC_MAX_LOADED", "3"))
_lock = threading.Lock()
_loaded: "OrderedDict[str, spandrel.ImageModelDescriptor]" = OrderedDict()
_info_cache: dict[str, dict[str, Any]] = {}


# ----------------------------------------------------------------- models

def list_model_files() -> list[str]:
    if not MODELS_DIR.exists():
        return []
    out = []
    for p in sorted(MODELS_DIR.rglob("*")):
        if p.suffix.lower() in MODEL_EXTS and "facexlib" not in p.parts:
            out.append(str(p.relative_to(MODELS_DIR)))
    return out


def model_info(name: str) -> dict[str, Any]:
    if name in _info_cache:
        return _info_cache[name]
    info_path = CACHE_DIR / "model_info.json"
    if info_path.exists():
        try:
            _info_cache.update(json.loads(info_path.read_text()))
        except Exception:
            pass
        if name in _info_cache:
            return _info_cache[name]
    return {"name": name, "arch": "?", "purpose": "?", "scale": None, "loaded": False}


def _save_info(name: str, d: spandrel.ImageModelDescriptor) -> None:
    info_path = CACHE_DIR / "model_info.json"
    if info_path.exists():  # merge with what other processes wrote
        try:
            for k, v in json.loads(info_path.read_text()).items():
                _info_cache.setdefault(k, v)
        except Exception:
            pass
    _info_cache[name] = {
        "name": name,
        "arch": d.architecture.name,
        "purpose": d.purpose,
        "scale": d.scale,
        "tiling": str(d.tiling.name),
        "input_channels": d.input_channels,
        "tags": list(d.tags),
        "loaded": True,
    }
    CACHE_DIR.mkdir(exist_ok=True)
    (CACHE_DIR / "model_info.json").write_text(json.dumps(_info_cache, indent=1))


def load_model(name: str) -> spandrel.ImageModelDescriptor:
    with _lock:
        if name in _loaded:
            _loaded.move_to_end(name)
            return _loaded[name]
        path = MODELS_DIR / name
        if not path.exists():
            raise FileNotFoundError(f"model not found: {name}")
        desc = spandrel.ModelLoader(device=DEVICE).load_from_file(path)
        if not isinstance(desc, spandrel.ImageModelDescriptor):
            raise TypeError(f"{name}: not an image model ({type(desc).__name__})")
        desc = desc.eval().to(DEVICE)
        _loaded[name] = desc
        while len(_loaded) > MAX_LOADED:
            _loaded.popitem(last=False)
            if DEVICE.type == "mps":
                torch.mps.empty_cache()
        _save_info(name, desc)
        return desc


# ----------------------------------------------------------------- image utils

Image.MAX_IMAGE_PIXELS = None  # scans and 4x upscales routinely exceed PIL's default bomb limit


def open_image(path: str | Path, crop: list[int] | None = None) -> Image.Image:
    im = Image.open(path)
    im = ImageOps.exif_transpose(im)
    if crop:
        x, y, w, h = crop
        im = im.crop((max(0, x), max(0, y), min(im.width, x + w), min(im.height, y + h)))
    return im.convert("RGB")


def load_image(path: str | Path, crop: list[int] | None = None) -> np.ndarray:
    """-> float32 RGB HWC in [0,1]. Crop is applied before the float conversion (huge scans)."""
    return np.asarray(open_image(path, crop)).astype(np.float32) / 255.0


def save_png(img: np.ndarray, path: str | Path) -> None:
    Image.fromarray(to_uint8(img)).save(path, compress_level=3)


def to_uint8(img: np.ndarray) -> np.ndarray:
    return np.clip(img * 255.0 + 0.5, 0, 255).astype(np.uint8)


def to_tensor(img: np.ndarray) -> torch.Tensor:
    return torch.from_numpy(np.ascontiguousarray(img.transpose(2, 0, 1)))[None].to(DEVICE)


def to_numpy(t: torch.Tensor) -> np.ndarray:
    return t[0].clamp(0, 1).permute(1, 2, 0).float().cpu().numpy()


def resize(img: np.ndarray, w: int, h: int, method: str = "lanczos") -> np.ndarray:
    interp = {
        "lanczos": cv2.INTER_LANCZOS4,
        "area": cv2.INTER_AREA,
        "cubic": cv2.INTER_CUBIC,
        "linear": cv2.INTER_LINEAR,
        "nearest": cv2.INTER_NEAREST,
    }.get(method, cv2.INTER_LANCZOS4)
    return np.clip(cv2.resize(img, (w, h), interpolation=interp), 0, 1)


def blend(out: np.ndarray, prev: np.ndarray, alpha: float) -> np.ndarray:
    if alpha >= 1.0:
        return out
    if prev.shape[:2] != out.shape[:2]:
        prev = resize(prev, out.shape[1], out.shape[0], "lanczos")
    if alpha <= 0.0:
        return prev
    return alpha * out + (1.0 - alpha) * prev


# ----------------------------------------------------------------- inference

@torch.inference_mode()
def run_full(desc: spandrel.ImageModelDescriptor, x: torch.Tensor) -> torch.Tensor:
    if desc.input_channels == 1 and x.shape[1] == 3:
        x = (0.299 * x[:, 0:1] + 0.587 * x[:, 1:2] + 0.114 * x[:, 2:3])
    y = desc(x)
    if y.shape[1] == 1:
        y = y.repeat(1, 3, 1, 1)
    return y


@torch.inference_mode()
def run_tiled(desc: spandrel.ImageModelDescriptor, x: torch.Tensor, tile: int, overlap: int = 32) -> torch.Tensor:
    _, _, H, W = x.shape
    s = desc.scale
    if tile <= 0 or (H <= tile and W <= tile):
        return run_full(desc, x)
    out = torch.zeros((1, 3, H * s, W * s), dtype=x.dtype, device=x.device)
    for y0 in range(0, H, tile):
        for x0 in range(0, W, tile):
            y1, x1 = min(y0 + tile, H), min(x0 + tile, W)
            py0, px0 = max(0, y0 - overlap), max(0, x0 - overlap)
            py1, px1 = min(H, y1 + overlap), min(W, x1 + overlap)
            o = run_full(desc, x[:, :, py0:py1, px0:px1])
            oy, ox = (y0 - py0) * s, (x0 - px0) * s
            out[:, :, y0 * s:y1 * s, x0 * s:x1 * s] = o[:, :, oy:oy + (y1 - y0) * s, ox:ox + (x1 - x0) * s]
    return out


@torch.inference_mode()
def run_face_model(desc: spandrel.ImageModelDescriptor, face_rgb: np.ndarray, w: float) -> np.ndarray:
    """face_rgb: 512x512 float RGB. GFPGAN/CodeFormer expect [-1,1] in/out."""
    x = to_tensor(face_rgb)
    if desc.purpose == "FaceSR":
        x = x * 2.0 - 1.0
        arch = desc.architecture.name.lower()
        if "codeformer" in arch:
            y = desc.model(x, weight=float(w))[0]
        else:
            y = desc.model(x)[0]
        y = (y + 1.0) / 2.0
        return to_numpy(y)
    return to_numpy(run_full(desc, x))


_face_helper = None


def get_face_helper():
    global _face_helper
    if _face_helper is None:
        from facexlib.utils.face_restoration_helper import FaceRestoreHelper
        FACEX_DIR.mkdir(parents=True, exist_ok=True)
        det_device = torch.device(os.environ.get("RC_FACE_DEVICE", "cpu"))
        _face_helper = FaceRestoreHelper(
            1, face_size=512, crop_ratio=(1, 1), det_model="retinaface_resnet50",
            save_ext="png", use_parse=True, device=det_device, model_rootpath=str(FACEX_DIR),
        )
    return _face_helper


def run_on_faces(restore: Callable[[np.ndarray], np.ndarray], img: np.ndarray, log: list[str]) -> np.ndarray:
    """Detect + align faces, run `restore` on each 512x512 RGB float crop, paste back."""
    helper = get_face_helper()
    helper.clean_all()
    bgr = cv2.cvtColor(to_uint8(img), cv2.COLOR_RGB2BGR)
    helper.read_image(bgr)
    n = helper.get_face_landmarks_5(only_center_face=False, resize=640, eye_dist_threshold=5)
    log.append(f"faces detected: {n}")
    if n == 0:
        return img
    helper.align_warp_face()
    for face in helper.cropped_faces:
        face_rgb = cv2.cvtColor(face, cv2.COLOR_BGR2RGB).astype(np.float32) / 255.0
        restored = restore(face_rgb)
        helper.add_restored_face(cv2.cvtColor(to_uint8(restored), cv2.COLOR_RGB2BGR))
    helper.get_inverse_affine(None)
    pasted = helper.paste_faces_to_input_image(upsample_img=None)
    return cv2.cvtColor(pasted, cv2.COLOR_BGR2RGB).astype(np.float32) / 255.0


# ----------------------------------------------------------------- PMRF worker

PMRF_PORT = int(os.environ.get("RC_PMRF_PORT", "8788"))
PMRF_DIR = ROOT / "external"
PMRF_PY = PMRF_DIR / "pmrf-venv" / "bin" / "python"
_pmrf_proc: subprocess.Popen | None = None


def _stop_pmrf() -> None:
    if _pmrf_proc is not None and _pmrf_proc.poll() is None:
        _pmrf_proc.terminate()


atexit.register(_stop_pmrf)


def _pmrf_health() -> dict[str, Any] | None:
    try:
        with urllib.request.urlopen(f"http://127.0.0.1:{PMRF_PORT}/health", timeout=10) as r:
            return json.loads(r.read())
    except (urllib.error.URLError, ConnectionError, TimeoutError, OSError):
        return None


def ensure_pmrf(log: list[str], timeout: float = 1800) -> None:
    """Start external/pmrf_worker.py if needed and wait until its model is loaded."""
    global _pmrf_proc
    h = _pmrf_health()
    if h and h.get("loaded"):
        return
    if h is None and (_pmrf_proc is None or _pmrf_proc.poll() is not None):
        if not PMRF_PY.exists():
            raise RuntimeError(f"PMRF venv missing: {PMRF_PY}. See README (PMRF section).")
        logf = open(PMRF_DIR / "pmrf_worker.log", "ab")
        _pmrf_proc = subprocess.Popen(
            [str(PMRF_PY), str(PMRF_DIR / "pmrf_worker.py"), "--port", str(PMRF_PORT)],
            stdout=logf, stderr=subprocess.STDOUT, cwd=str(PMRF_DIR),
            env={**os.environ, "RC_PARENT_PID": str(os.getpid())},  # the worker exits when we are gone
        )
        log.append("started PMRF worker (first run downloads ~2GB from Hugging Face)")
    t0 = time.time()
    exited_at: float | None = None
    while time.time() - t0 < timeout:
        h = _pmrf_health()
        if h and h.get("error"):
            raise RuntimeError(f"PMRF worker failed: {h['error']} (see external/pmrf_worker.log)")
        if h and h.get("loaded"):
            log.append(f"PMRF worker ready on {h.get('device')} after {time.time() - t0:.0f}s")
            return
        if _pmrf_proc is not None and _pmrf_proc.poll() is not None:
            # our spawn died: usually "address already in use" because another process's worker
            # owns the port and was busy. Give that worker a grace period before giving up.
            exited_at = exited_at or time.time()
            _pmrf_proc = None
        if exited_at and h is None and time.time() - exited_at > 120:
            raise RuntimeError("PMRF worker exited and no worker is answering (see external/pmrf_worker.log)")
        time.sleep(1.0)
    raise RuntimeError("PMRF worker did not become ready in time")


def pmrf_restore_face(face_rgb: np.ndarray, steps: int, seed: int | None, mmse_only: bool) -> np.ndarray:
    with tempfile.TemporaryDirectory(prefix="rc_pmrf_") as td:
        src, dst = Path(td) / "in.png", Path(td) / "out.png"
        save_png(face_rgb, src)
        body = json.dumps({"input": str(src), "output": str(dst), "steps": steps, "seed": seed, "mmse_only": mmse_only}).encode()
        req = urllib.request.Request(f"http://127.0.0.1:{PMRF_PORT}/restore", data=body, headers={"content-type": "application/json"})
        try:
            with urllib.request.urlopen(req, timeout=1800) as r:
                json.loads(r.read())
        except urllib.error.HTTPError as e:
            raise RuntimeError(f"PMRF: {json.loads(e.read()).get('error', e)}")
        return load_image(dst)


# ----------------------------------------------------------------- Bringing Old Photos Back to Life

BOPBTL_DIR = ROOT / "external" / "BOPBTL"
BOPBTL_PY = ROOT / "external" / "bopbtl-venv" / "bin" / "python"
BOPBTL_MPS = ROOT / "external" / "bopbtl_mps.py"
# upstream is CUDA/CPU only; the launcher redirects CUDA calls to MPS for the Global stage
BOPBTL_DEVICE = os.environ.get("RC_BOPBTL_DEVICE") or ("mps" if torch.backends.mps.is_available() else "cpu")


def _bopbtl_env() -> dict[str, str]:
    env = os.environ.copy()
    env["BOPBTL_DEVICE"] = BOPBTL_DEVICE
    env["PATH"] = f"{BOPBTL_PY.parent}:{env.get('PATH', '')}"  # run.py shells out to bare `python`
    env.setdefault("OMP_NUM_THREADS", str(os.cpu_count() or 4))
    return env


def _bopbtl_cmd(cmd: list[str], cwd: Path, log: list[str], log_name: str, timeout: int) -> str:
    log.append("$ " + " ".join(cmd[1:]))
    p = subprocess.run(cmd, cwd=str(cwd), env=_bopbtl_env(), capture_output=True, text=True, timeout=timeout)
    text = p.stdout + p.stderr
    with open(ROOT / "external" / log_name, "a") as f:
        f.write(f"\n### {' '.join(cmd[1:])}\n{text}")
    # upstream scripts ignore child exit codes and print "done" regardless, and test.py catches
    # per-image exceptions and prints "Skip <name> due to an error": detect both ourselves
    if p.returncode != 0 or "Traceback" in text or "due to an error" in text:
        lines = [l for l in text.strip().splitlines() if l.strip()]
        tb = [l for l in lines if "Error" in l or "Traceback" in l or "due to an error" in l][-2:]
        why = " | ".join(tb or lines[-3:]) or (f"killed by signal {-p.returncode} (out of memory?)" if p.returncode < 0 else f"exit code {p.returncode} with no output")
        raise RuntimeError(f"BOPBTL failed ({cmd[1]}): {why} (full log: external/{log_name})")
    return text


def bopbtl_folder(in_dir: Path, out_dir: Path, scratch: bool, hr: bool, faces: bool, log: list[str], timeout: int = 3600 * 6) -> Path:
    """Run BOPBTL over a folder of images. Returns the folder holding one PNG per input.

    faces=True  -> upstream run.py: global restore, [scratch], dlib faces, face enhance, warp back.
    faces=False -> global restoration only (Global/test.py), model loaded once for the whole folder.
    """
    if not BOPBTL_PY.exists() or not (BOPBTL_DIR / "run.py").exists():
        raise RuntimeError("BOPBTL not set up: see README (Old Photos section)")
    log_name = "bopbtl_last.log"
    (ROOT / "external" / log_name).write_text("")
    out_dir.mkdir(parents=True, exist_ok=True)
    # upstream loaders open every file in the folder (.DS_Store included): stage image files only
    staged = out_dir / "_input"
    staged.mkdir(exist_ok=True)
    exts = {".png", ".jpg", ".jpeg", ".webp", ".tif", ".tiff", ".bmp"}
    for f in sorted(in_dir.iterdir()):
        if f.is_file() and f.suffix.lower() in exts and not f.name.startswith("."):
            (staged / f.name).symlink_to(f.resolve())
    in_dir = staged
    py = str(BOPBTL_PY)
    if faces:
        cmd = [py, "run.py", "--input_folder", str(in_dir), "--output_folder", str(out_dir), "--GPU", "-1"]
        cmd += ["--with_scratch"] if scratch else []
        cmd += ["--HR"] if hr else []
        _bopbtl_cmd(cmd, BOPBTL_DIR, log, log_name, timeout)
        return out_dir / "final_output"
    g = BOPBTL_DIR / "Global"
    # test.py (the heavy restoration net) goes through the MPS launcher; detection.py (small
    # scratch UNet) picks its device with `.to(int)` which the launcher cannot redirect, so it stays on CPU
    test_cmd = [py, str(BOPBTL_MPS), "test.py", "--gpu_ids", "0"] if BOPBTL_DEVICE == "mps" else [py, "test.py", "--gpu_ids", "-1"]
    if scratch and not hr:
        # the non-HR scratch model runs global non-local attention over every position at 1/4 res:
        # memory is quadratic (a 1296x1080 photo asks for ~29 GB). Upstream's --HR patch-attention
        # model exists for exactly this, so switch to it automatically when a photo is too big.
        biggest = 0
        for f in in_dir.iterdir():
            try:
                with Image.open(f) as im:
                    biggest = max(biggest, (im.width // 4) * (im.height // 4))
            except Exception:
                pass
        if biggest > 40_000:  # ~800x800 input
            hr = True
            log.append("scratch: image too large for global attention, using the HR patch-attention model")
    if scratch:
        masks = out_dir / "masks"
        _bopbtl_cmd([py, "detection.py", "--test_path", str(in_dir), "--output_dir", str(masks), "--input_size", "full_size", "--GPU", "-1"], g, log, log_name, timeout)
        _bopbtl_cmd(test_cmd + ["--Scratch_and_Quality_restore", "--test_input", str(masks / "input"), "--test_mask", str(masks / "mask"),
                                "--outputs_dir", str(out_dir)] + (["--HR"] if hr else []), g, log, log_name, timeout)
    else:
        _bopbtl_cmd(test_cmd + ["--test_mode", "Full", "--Quality_restore", "--test_input", str(in_dir), "--outputs_dir", str(out_dir)], g, log, log_name, timeout)
    return out_dir / "restored_image"


def run_bopbtl(img: np.ndarray, scratch: bool, hr: bool, faces: bool, log: list[str]) -> np.ndarray:
    """Single-image BOPBTL step for pipelines (see bopbtl_folder). CPU only."""
    with tempfile.TemporaryDirectory(prefix="rc_bopbtl_") as td:
        inp = Path(td) / "in"
        inp.mkdir()
        save_png(img, inp / "img.png")
        res_dir = bopbtl_folder(inp, Path(td) / "out", scratch, hr, faces, log)
        result = res_dir / "img.png"
        if not result.exists():
            raise RuntimeError(f"BOPBTL produced no output in {res_dir.name} (see external/bopbtl_last.log)")
        return load_image(result)


def run_command(template: str, img: np.ndarray, log: list[str]) -> np.ndarray:
    with tempfile.TemporaryDirectory(prefix="rc_") as td:
        src = Path(td) / "in.png"
        dst = Path(td) / "out.png"
        save_png(img, src)
        cmd = template.replace("{in}", shlex.quote(str(src))).replace("{out}", shlex.quote(str(dst))).replace("{tmp}", shlex.quote(td))
        log.append(f"$ {cmd}")
        p = subprocess.run(cmd, shell=True, capture_output=True, text=True, timeout=1800)
        tail = (p.stdout + p.stderr).strip().splitlines()[-8:]
        log.extend(tail)
        if p.returncode != 0:
            raise RuntimeError(f"command failed ({p.returncode}): {' '.join(tail[-2:])}")
        if not dst.exists():
            cands = [q for q in Path(td).iterdir() if q.suffix.lower() in {".png", ".jpg", ".jpeg", ".webp"} and q.name != "in.png"]
            if not cands:
                raise RuntimeError("command produced no {out} file")
            dst = cands[0]
        out = load_image(dst)
    return out


# ----------------------------------------------------------------- autocrop (tools/autocrop)

AUTOCROP_DIR = ROOT.parent / "autocrop"
Quad = list[list[float]]  # four [x, y] corners TL TR BR BL, as fractions of width / height


def _autocrop():
    """tools/autocrop/autocrop.py, imported lazily (numpy + cv2 only; its TIFF
    reader is not used here since images arrive already decoded)."""
    import importlib
    import sys

    if str(AUTOCROP_DIR) not in sys.path:
        sys.path.insert(0, str(AUTOCROP_DIR))
    return importlib.import_module("autocrop")


def detect_print(img: np.ndarray) -> dict[str, Any] | None:
    """Corners of a print lying on a plain background, or None. img: float RGB."""
    ac = _autocrop()
    h, w = img.shape[:2]
    dets = ac.detect(cv2.cvtColor(to_uint8(img), cv2.COLOR_RGB2BGR), 0.08, False, 5)
    if not dets:
        return None
    d = dets[0]
    return {
        "quad": [[float(x) / w, float(y) / h] for x, y in d.quad],
        "confidence": float(d.confidence),
        "method": d.method,
    }


def run_autocrop(img: np.ndarray, quad: Quad | None, inset: float, rotate: int, log: list[str]) -> np.ndarray:
    """Straighten and crop the print at `quad` (auto-detected when None)."""
    ac = _autocrop()
    h, w = img.shape[:2]
    if quad is None:
        det = detect_print(img)
        if det is None:
            raise RuntimeError("no print found in the photo; place the corners by hand")
        quad = det["quad"]
        log.append(f"print detected ({det['method']}, confidence {det['confidence']:.2f})")
    q = ac.order_corners(np.array([[x * w, y * h] for x, y in quad], np.float32))
    out = ac.warp(img, q, float(inset))
    if rotate % 4:
        out = cv2.rotate(out, [None, cv2.ROTATE_90_CLOCKWISE, cv2.ROTATE_180, cv2.ROTATE_90_COUNTERCLOCKWISE][rotate % 4])
    return np.ascontiguousarray(np.clip(out, 0, 1, dtype=np.float32))


# ----------------------------------------------------------------- pipeline

def step_key(step: dict[str, Any]) -> dict[str, Any]:
    """Normalised step used for hashing and execution."""
    t = step.get("type", "model")
    s: dict[str, Any] = {"type": t, "blend": float(step.get("blend", 1.0))}
    if t == "model":
        s["model"] = step["model"]
        s["tile"] = int(step.get("tile", 0) or 0)
        s["face"] = bool(step.get("face", False))
        s["w"] = float(step.get("w", 0.5))
    elif t == "cmd":
        s["cmd"] = step["cmd"]
    elif t == "bopbtl":
        s["scratch"] = bool(step.get("scratch", False))
        s["hr"] = bool(step.get("hr", False))
        s["faces"] = bool(step.get("faces", True))
    elif t == "pmrf":
        s["steps"] = int(step.get("steps", 25))
        s["seed"] = int(step.get("seed", 0))
        s["mmse"] = bool(step.get("mmse", False))
    elif t == "resize":
        s["scale"] = float(step.get("scale", 1.0))
        s["method"] = step.get("method", "lanczos")
    elif t == "sharpen":
        s["amount"] = float(step.get("amount", 0.5))
        s["radius"] = float(step.get("radius", 1.0))
    elif t == "grain":
        s["amount"] = float(step.get("amount", 0.03))
        s["size"] = float(step.get("size", 1.0))
        s["seed"] = int(step.get("seed", 0))
    elif t == "autocrop":
        q = step.get("quad")
        s["quad"] = [[round(float(x), 5), round(float(y), 5)] for x, y in q] if q else None
        s["inset"] = float(step.get("inset", 0.0))
        s["rotate"] = int(step.get("rotate", 0)) % 4
        s["blend"] = 1.0  # a geometry change; mixing with the uncropped input makes no sense
    else:
        raise ValueError(f"unknown step type {t}")
    return s


def pipeline_hash(image_hash: str, steps: list[dict[str, Any]], crop: list[int] | None) -> str:
    payload = json.dumps({"img": image_hash, "steps": steps, "crop": crop}, sort_keys=True)
    return hashlib.sha1(payload.encode()).hexdigest()[:16]


def sharpen(img: np.ndarray, amount: float, radius: float) -> np.ndarray:
    blur = cv2.GaussianBlur(img, (0, 0), max(radius, 0.1))
    return np.clip(img + amount * (img - blur), 0, 1)


def grain(img: np.ndarray, amount: float, size: float, seed: int) -> np.ndarray:
    rng = np.random.default_rng(seed)
    h, w = img.shape[:2]
    if size > 1.0:
        sh, sw = max(1, int(h / size)), max(1, int(w / size))
        n = rng.standard_normal((sh, sw, 1)).astype(np.float32)
        n = cv2.resize(n, (w, h), interpolation=cv2.INTER_LINEAR)[..., None]
    else:
        n = rng.standard_normal((h, w, 1)).astype(np.float32)
    return np.clip(img + amount * n, 0, 1)


def run_step(step: dict[str, Any], img: np.ndarray, log: list[str]) -> np.ndarray:
    t = step["type"]
    if t == "model":
        desc = load_model(step["model"])
        use_face = step["face"] or desc.purpose == "FaceSR"
        if use_face:
            return run_on_faces(lambda face: run_face_model(desc, face, step["w"]), img, log)
        return to_numpy(run_tiled(desc, to_tensor(img), step["tile"]))
    if t == "cmd":
        return run_command(step["cmd"], img, log)
    if t == "bopbtl":
        return run_bopbtl(img, step["scratch"], step["hr"], step["faces"], log)
    if t == "pmrf":
        ensure_pmrf(log)
        return run_on_faces(lambda face: pmrf_restore_face(face, step["steps"], step["seed"], step["mmse"]), img, log)
    if t == "resize":
        h, w = img.shape[:2]
        return resize(img, max(1, round(w * step["scale"])), max(1, round(h * step["scale"])), step["method"])
    if t == "sharpen":
        return sharpen(img, step["amount"], step["radius"])
    if t == "grain":
        return grain(img, step["amount"], step["size"], step["seed"])
    if t == "autocrop":
        return run_autocrop(img, step["quad"], step["inset"], step["rotate"], log)
    raise ValueError(t)


STEP_CACHE = CACHE_DIR / "steps"


def raw_step_key(cache_base: str, chain: list[dict[str, Any]], step: dict[str, Any]) -> str:
    """Key for a step's un-blended output: depends on the source image, every earlier step
    (including their blends, since those shape this step's input), and this step minus blend."""
    no_blend = {k: v for k, v in step.items() if k != "blend"}
    payload = json.dumps({"base": cache_base, "chain": chain, "step": no_blend}, sort_keys=True)
    return hashlib.sha1(payload.encode()).hexdigest()[:16]


def run_pipeline(
    img: np.ndarray,
    steps: list[dict[str, Any]],
    progress: Callable[[str], None] | None = None,
    cache_base: str | None = None,
) -> tuple[np.ndarray, list[str]]:
    """Run steps in order. Blend is a pixel-space mix applied after each step, so with a
    `cache_base` the raw (blend=1) output of every step is cached and re-blending is free."""
    log: list[str] = []
    cur = img
    chain: list[dict[str, Any]] = []
    for i, raw in enumerate(steps):
        step = step_key(raw)
        name = step.get("model") or step["type"]
        t0 = time.time()
        raw_path = STEP_CACHE / f"{raw_step_key(cache_base, chain, step)}.png" if cache_base else None
        if raw_path is not None and raw_path.exists():
            out = load_image(raw_path)
            how = "raw cached"
        else:
            if progress:
                progress(f"step {i + 1}/{len(steps)}: {name}" + (f" ({step['steps']} flow steps)" if step["type"] == "pmrf" else ""))
            out = run_step(step, cur, log)
            if raw_path is not None:
                STEP_CACHE.mkdir(parents=True, exist_ok=True)
                save_png(out, raw_path)
            how = "ran"
        out = blend(out, cur, step["blend"])
        log.append(f"step {i + 1} {name} blend={step['blend']} {how} {time.time() - t0:.2f}s -> {out.shape[1]}x{out.shape[0]}")
        chain.append(step)
        cur = out
        if DEVICE.type == "mps":
            torch.mps.empty_cache()
    return cur, log
