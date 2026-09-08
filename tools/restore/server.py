"""FastAPI server for the restore tool: the standalone web UIs in static/ and the
desktop app's Restore view both talk to this.

Env:
  RC_ROOTS   os.pathsep-separated folders that /api/folder* and /api/curate/* may touch
             (default: your home directory; the app passes its own list)
  RC_CORS    "1" to answer cross-origin requests (the app's webview is a different origin)
  RC_PARENT_PID  pid of the process that started us; exit as soon as it is not our parent any
             more (the app sets this: a force-quit must not leave a server holding gigabytes
             of models, and the app may die while torch is still importing)
"""
from __future__ import annotations

import hashlib
import io
import json
import os
import threading
import time
import traceback
from pathlib import Path
from typing import Any

from fastapi import FastAPI, HTTPException, Query, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, JSONResponse, Response
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel

import engine
from PIL import Image

ROOT = Path(__file__).parent
UPLOADS = ROOT / "uploads"
CACHE = engine.CACHE_DIR
UPLOADS.mkdir(exist_ok=True)
CACHE.mkdir(parents=True, exist_ok=True)

app = FastAPI(title="restore-compare")
if os.environ.get("RC_CORS") == "1":
    # Bound to 127.0.0.1 and started by the app itself; the origin check is the
    # only thing standing between the webview and the API, so drop it on request.
    app.add_middleware(CORSMiddleware, allow_origins=["*"], allow_methods=["*"], allow_headers=["*"])
_run_lock = threading.Lock()
_status: dict[str, str] = {"current": ""}


def _watch_parent(parent: int) -> None:
    """Exit once re-parented (the launcher died without a chance to stop us). The
    expected parent comes from the launcher, not from getppid() here: by the time
    this module imports, a launcher that died early has already been replaced by
    init, and there would be nothing left to notice."""
    while os.getppid() == parent:
        time.sleep(2.0)
    print("[restore] parent gone, exiting", flush=True)
    os._exit(0)


if os.environ.get("RC_PARENT_PID", "").isdigit():
    threading.Thread(target=_watch_parent, args=(int(os.environ["RC_PARENT_PID"]),), daemon=True).start()


class RunRequest(BaseModel):
    image: str
    steps: list[dict[str, Any]]
    crop: list[int] | None = None  # x, y, w, h in source pixels


def _capabilities() -> dict[str, bool]:
    """Which optional step types can actually run here (their venv + code exist)."""
    return {
        "pmrf": engine.PMRF_PY.exists() and (engine.PMRF_DIR / "pmrf_worker.py").exists(),
        "bopbtl": engine.BOPBTL_PY.exists() and (engine.BOPBTL_DIR / "run.py").exists(),
    }


@app.get("/api/info")
def info() -> dict[str, Any]:
    return {
        "device": str(engine.DEVICE),
        "models_dir": str(engine.MODELS_DIR),
        "status": _status["current"],
        "busy": _run_lock.locked(),
        "capabilities": _capabilities(),
    }


@app.get("/api/models")
def models() -> list[dict[str, Any]]:
    return [engine.model_info(n) for n in engine.list_model_files()]


@app.post("/api/upload")
async def upload(file: UploadFile) -> dict[str, Any]:
    data = await file.read()
    h = hashlib.sha1(data).hexdigest()[:16]
    ext = Path(file.filename or "img.png").suffix.lower() or ".png"
    path = UPLOADS / f"{h}{ext}"
    if not path.exists():
        path.write_bytes(data)
    im = engine.open_image(path)
    return {"id": path.name, "hash": h, "w": im.width, "h": im.height, "url": f"/api/source/{path.name}"}


@app.get("/api/source/{name}")
def source(name: str, crop: str | None = None, max_px: int | None = Query(None, alias="max")):
    """Original upload. `crop=x,y,w,h` and/or `max=N` (longest side) are served as PNG so the
    browser never has to decode a 100+ megapixel scan just to show a preview or a crop."""
    p = UPLOADS / Path(name).name
    if not p.exists():
        raise HTTPException(404)
    if not crop and not max_px:
        return FileResponse(p)
    box = [int(v) for v in crop.split(",")] if crop else None
    im = engine.open_image(p, box)
    if max_px and 0 < max_px < max_side(im):
        im.thumbnail((max_px, max_px), Image.LANCZOS, reducing_gap=2.0)  # reduce() first: fast on huge scans
    buf = io.BytesIO()
    im.save(buf, format="PNG", compress_level=1)
    return Response(buf.getvalue(), media_type="image/png", headers={"Cache-Control": "max-age=31536000, immutable"})


def max_side(im: Image.Image) -> int:
    return im.width if im.width >= im.height else im.height


@app.get("/api/result/{key}.png")
def result(key: str) -> FileResponse:
    p = CACHE / f"{Path(key).name}.png"
    if not p.exists():
        raise HTTPException(404)
    return FileResponse(p, headers={"Cache-Control": "max-age=31536000, immutable"})


@app.post("/api/run")
def run(req: RunRequest) -> JSONResponse:
    src = UPLOADS / Path(req.image).name
    if not src.exists():
        raise HTTPException(404, "image not found")
    try:
        steps = [engine.step_key(s) for s in req.steps]
    except (KeyError, ValueError) as e:
        raise HTTPException(400, f"bad step: {e}")
    key = engine.pipeline_hash(src.stem, steps, req.crop)
    out_png = CACHE / f"{key}.png"
    meta_path = CACHE / f"{key}.json"
    if out_png.exists() and meta_path.exists():
        meta = json.loads(meta_path.read_text())
        meta["cached"] = True
        return JSONResponse(meta)

    with _run_lock:
        if out_png.exists() and meta_path.exists():
            meta = json.loads(meta_path.read_text())
            meta["cached"] = True
            return JSONResponse(meta)
        t0 = time.time()
        img = engine.load_image(src, req.crop)
        if img.size == 0:
            raise HTTPException(400, "empty crop")
        try:
            out, log = engine.run_pipeline(
                img, steps,
                progress=lambda s: _status.__setitem__("current", s),
                cache_base=f"{src.stem}|{req.crop}",
            )
        except Exception as e:
            _status["current"] = ""
            traceback.print_exc()
            raise HTTPException(500, f"{type(e).__name__}: {e}")
        _status["current"] = ""
        engine.save_png(out, out_png)
        meta = {
            "key": key,
            "url": f"/api/result/{key}.png",
            "w": int(out.shape[1]),
            "h": int(out.shape[0]),
            "ms": int((time.time() - t0) * 1000),
            "log": log,
            "steps": steps,
            "cached": False,
        }
        meta_path.write_text(json.dumps(meta))
        return JSONResponse(meta)


# ----------------------------------------------------------------- folder comparer (static/folders.html)

IMAGE_EXTS = {".png", ".jpg", ".jpeg", ".webp", ".tif", ".tiff", ".bmp"}


def _roots() -> list[Path]:
    raw = os.environ.get("RC_ROOTS")
    if not raw:
        return [Path.home().resolve()]
    return [Path(r).expanduser().resolve() for r in raw.split(os.pathsep) if r]


def _folder(path: str) -> Path:
    p = Path(path).expanduser().resolve()
    if not any(p == r or r in p.parents for r in _roots()):
        raise HTTPException(403, "folder is outside the allowed roots (RC_ROOTS)")
    if not p.is_dir():
        raise HTTPException(404, f"not a folder: {path}")
    return p


@app.get("/api/folder")
def folder(path: str) -> dict[str, Any]:
    p = _folder(path)
    files = sorted(f.name for f in p.iterdir() if f.is_file() and f.suffix.lower() in IMAGE_EXTS and not f.name.startswith("."))
    return {"path": str(p), "files": files}


THUMBS = CACHE / "thumbs"
RESULTS = CACHE / "results"
BACKUP_DIR = "_originals"


@app.get("/api/folder/file")
def folder_file(path: str, name: str, max_px: int | None = Query(None, alias="max")):
    p = _folder(path)
    f = p / Path(name).name
    if not f.is_file():
        raise HTTPException(404)
    if not max_px:
        return FileResponse(f)
    st = f.stat()
    THUMBS.mkdir(parents=True, exist_ok=True)
    tp = THUMBS / (hashlib.sha1(f"{f}|{st.st_mtime_ns}|{st.st_size}|{max_px}".encode()).hexdigest()[:20] + ".jpg")
    if not tp.exists():
        im = engine.open_image(f)
        im.thumbnail((max_px, max_px), Image.LANCZOS, reducing_gap=2.0)
        im.save(tp, format="JPEG", quality=85)
    return FileResponse(tp, media_type="image/jpeg", headers={"Cache-Control": "max-age=86400"})


# ----------------------------------------------------------------- curate: run a pipeline on a folder file, then commit

class ProcessRequest(BaseModel):
    path: str
    name: str
    steps: list[dict[str, Any]]


class CommitRequest(BaseModel):
    path: str
    name: str
    key: str
    mode: str  # "replace" (original moved to _originals/) or "saveas"
    new_name: str | None = None  # saveas: file name in the same folder…
    new_path: str | None = None  # …or an absolute path (its folder must be under RC_ROOTS)
    quality: int = 95


@app.get("/api/curate/folder")
def curate_folder(path: str) -> dict[str, Any]:
    """Folder listing plus which files already have a backed-up original."""
    p = _folder(path)
    backups = {f.name for f in (p / BACKUP_DIR).iterdir()} if (p / BACKUP_DIR).is_dir() else set()
    files = []
    for f in sorted(p.iterdir()):
        if f.is_file() and f.suffix.lower() in IMAGE_EXTS and not f.name.startswith("."):
            files.append({"name": f.name, "restored": f.name in backups, "size": f.stat().st_size})
    return {"path": str(p), "files": files, "backup_dir": BACKUP_DIR}


@app.post("/api/curate/process")
def curate_process(req: ProcessRequest) -> JSONResponse:
    p = _folder(req.path)
    f = p / Path(req.name).name
    if not f.is_file():
        raise HTTPException(404, "file not found")
    try:
        steps = [engine.step_key(s) for s in req.steps]
    except (KeyError, ValueError) as e:
        raise HTTPException(400, f"bad step: {e}")
    base = hashlib.sha1(f.read_bytes()).hexdigest()[:16]
    key = engine.pipeline_hash(base, steps, None)
    RESULTS.mkdir(parents=True, exist_ok=True)
    out_png, meta_path = RESULTS / f"{key}.png", RESULTS / f"{key}.json"
    if out_png.exists() and meta_path.exists():
        meta = json.loads(meta_path.read_text()); meta["cached"] = True
        return JSONResponse(meta)
    with _run_lock:
        t0 = time.time()
        img = engine.load_image(f)
        try:
            out, log = engine.run_pipeline(img, steps, progress=lambda s: _status.__setitem__("current", s), cache_base=base)
        except Exception as e:
            _status["current"] = ""
            traceback.print_exc()
            raise HTTPException(500, f"{type(e).__name__}: {e}")
        _status["current"] = ""
        engine.save_png(out, out_png)
        meta = {"key": key, "url": f"/api/curate/result/{key}.png", "w": int(out.shape[1]), "h": int(out.shape[0]),
                "ms": int((time.time() - t0) * 1000), "log": log, "steps": steps, "cached": False}
        meta_path.write_text(json.dumps(meta))
        return JSONResponse(meta)


class DetectRequest(BaseModel):
    path: str
    name: str


@app.post("/api/autocrop/detect")
def autocrop_detect(req: DetectRequest) -> dict[str, Any]:
    """Corners of a print in a photo of a print (tools/autocrop), as fractions of
    the image size, for the app to show as draggable handles."""
    p = _folder(req.path)
    f = p / Path(req.name).name
    if not f.is_file():
        raise HTTPException(404, "file not found")
    img = engine.load_image(f)
    det = engine.detect_print(img)
    return {"w": int(img.shape[1]), "h": int(img.shape[0]), "found": det is not None, **(det or {})}


@app.get("/api/curate/result/{key}.png")
def curate_result(key: str) -> FileResponse:
    f = RESULTS / f"{Path(key).name}.png"
    if not f.exists():
        raise HTTPException(404)
    return FileResponse(f, headers={"Cache-Control": "max-age=31536000, immutable"})


@app.post("/api/curate/commit")
def curate_commit(req: CommitRequest) -> dict[str, Any]:
    p = _folder(req.path)
    src = p / Path(req.name).name
    res = RESULTS / f"{Path(req.key).name}.png"
    if not src.is_file():
        raise HTTPException(404, "original not found")
    if not res.is_file():
        raise HTTPException(404, "result not found; run the pipeline again")
    im = Image.open(res).convert("RGB")

    def write(dst: Path) -> None:
        ext = dst.suffix.lower()
        if ext in {".jpg", ".jpeg"}:
            im.save(dst, format="JPEG", quality=max(1, min(100, req.quality)), subsampling=0)
        elif ext == ".webp":
            im.save(dst, format="WEBP", quality=max(1, min(100, req.quality)))
        elif ext in {".tif", ".tiff"}:
            im.save(dst, format="TIFF", compression="tiff_lzw")
        else:
            im.save(dst, format="PNG", compress_level=3)

    if req.mode == "replace":
        bdir = p / BACKUP_DIR
        bdir.mkdir(exist_ok=True)
        backup = bdir / src.name
        if backup.exists():  # never overwrite an existing backup: keep the very first original
            backup = bdir / f"{src.stem}_{int(time.time())}{src.suffix}"
        tmp = p / f".{src.stem}.tmp{src.suffix}"
        write(tmp)  # write the new file first, then swap, so a failure leaves the original untouched
        src.rename(backup)
        tmp.rename(src)
        return {"ok": True, "written": src.name, "backup": str(backup.relative_to(p))}
    if req.mode == "saveas":
        if req.new_path:
            target = Path(req.new_path).expanduser()
            dst = _folder(str(target.parent)) / target.name
        elif req.new_name:
            dst = p / Path(req.new_name).name
        else:
            raise HTTPException(400, "new_name or new_path required")
        if dst.suffix == "":
            dst = dst.with_suffix(".png")
        if dst.exists() and not req.new_path:  # a picked path came through a Save dialog that already asked
            raise HTTPException(409, f"{dst.name} already exists")
        write(dst)
        return {"ok": True, "written": str(dst) if req.new_path else dst.name}
    raise HTTPException(400, "mode must be replace or saveas")


@app.delete("/api/cache")
def clear_cache() -> dict[str, int]:
    n = 0
    for p in list(CACHE.iterdir()) + list(engine.STEP_CACHE.glob("*.png")):
        if p.is_file() and p.suffix in {".png", ".json"} and p.name != "model_info.json":
            p.unlink()
            n += 1
    return {"deleted": n}


app.mount("/", StaticFiles(directory=ROOT / "static", html=True), name="static")
