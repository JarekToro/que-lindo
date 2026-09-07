#!/usr/bin/env python3
# /// script
# requires-python = ">=3.9"
# dependencies = ["numpy", "opencv-python-headless>=4.8", "tifffile"]
# ///
"""
review — crop photos one at a time in the browser, with the corners prefilled.

    uv run review.py ~/Downloads/scans/tiff            # output → ~/Downloads/scans/tiff/cropped
    python review.py scans/ -o cropped/ --port 8765

Opens a page showing each scan with autocrop's four detected corners drawn on
it. Drag a corner (or a whole edge) until it sits on the print, press Enter:
the full-resolution TIFF is perspective-corrected and written losslessly (LZW)
to the output folder, and the next scan loads. Progress is saved in
`<out>/review-state.json`, so quitting and coming back resumes where you were.

Keys:  Enter = crop & next · ← → = browse · S = skip · R = re-detect
       [ ] = rotate output 90° · Esc = drop the current drag
"""

from __future__ import annotations

import argparse
import json
import sys
import threading
import webbrowser
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Optional
from urllib.parse import unquote, urlparse

import cv2
import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parent))
import autocrop  # noqa: E402  (same folder)

PREVIEW_MAX = 2200  # px, longest side of the JPEG the browser works on


class Session:
    def __init__(self, files: list[Path], out_dir: Path, inset: float):
        self.files = files
        self.out_dir = out_dir
        self.inset = inset
        self.previews = out_dir / ".previews"
        self.previews.mkdir(parents=True, exist_ok=True)
        self.state_path = out_dir / "review-state.json"
        self.state: dict[str, dict] = {}
        if self.state_path.exists():
            try:
                self.state = json.loads(self.state_path.read_text())
            except json.JSONDecodeError:
                self.state = {}
        self.cache: dict[int, dict] = {}
        self.locks: dict[int, threading.Lock] = {i: threading.Lock() for i in range(len(files))}
        self.state_lock = threading.Lock()
        # Detection takes several seconds per scan; run ahead of the user.
        threading.Thread(target=self._prefetch, daemon=True).start()

    # ---- analysis -------------------------------------------------------

    def _prefetch(self) -> None:
        for i, f in enumerate(self.files):
            if not self.state.get(f.name, {}).get("done"):
                try:
                    self.analyse(i)
                except Exception as e:  # keep going; the item shows the error
                    self.cache[i] = {"error": str(e)}

    def analyse(self, i: int) -> dict:
        with self.locks[i]:
            if i in self.cache:
                return self.cache[i]
            src = self.files[i]
            img = autocrop.read_image(src)
            img8 = autocrop.to_uint8_bgr(img)
            h, w = img8.shape[:2]
            preview = self.previews / f"{src.stem}.jpg"
            if not preview.exists():
                s = min(1.0, PREVIEW_MAX / max(h, w))
                small = cv2.resize(img8, None, fx=s, fy=s, interpolation=cv2.INTER_AREA) if s < 1 else img8
                cv2.imwrite(str(preview), small, [cv2.IMWRITE_JPEG_QUALITY, 88])
            dets = autocrop.detect(img8, 0.08, False, 5)
            if dets:
                quad = dets[0].quad.tolist()
                conf = dets[0].confidence
                method = dets[0].method
            else:
                m = 0.1
                quad = [[w * m, h * m], [w * (1 - m), h * m], [w * (1 - m), h * (1 - m)], [w * m, h * (1 - m)]]
                conf, method = 0.0, "none"
            self.cache[i] = {"w": w, "h": h, "auto": quad, "confidence": conf, "method": method}
            return self.cache[i]

    def item(self, i: int) -> dict:
        info = dict(self.analyse(i))
        saved = self.state.get(self.files[i].name, {})
        info.update(
            index=i,
            total=len(self.files),
            name=self.files[i].name,
            preview=f"/preview/{i}",
            quad=saved.get("quad", info.get("auto")),
            rotate=saved.get("rotate", 0),
            done=bool(saved.get("done")),
            skipped=bool(saved.get("skipped")),
            output=saved.get("output"),
        )
        return info

    # ---- output ---------------------------------------------------------

    def confirm(self, i: int, quad: list[list[float]], rotate: int) -> dict:
        src = self.files[i]
        img = autocrop.read_image(src)
        q = autocrop.order_corners(np.array(quad, np.float32))
        out = autocrop.warp(img, q, self.inset)
        rotate %= 4
        if rotate:
            out = cv2.rotate(out, [None, cv2.ROTATE_90_CLOCKWISE, cv2.ROTATE_180, cv2.ROTATE_90_COUNTERCLOCKWISE][rotate])
        dst = self.out_dir / f"{src.stem}.tiff"
        if not cv2.imwrite(str(dst), out, [cv2.IMWRITE_TIFF_COMPRESSION, 5]):  # 5 = LZW, lossless
            raise RuntimeError(f"could not write {dst}")
        self._set(src.name, {"quad": q.tolist(), "rotate": rotate, "done": True, "skipped": False, "output": dst.name})
        return {"output": dst.name, "size": [int(out.shape[1]), int(out.shape[0])]}

    def skip(self, i: int) -> None:
        self._set(self.files[i].name, {"skipped": True, "done": False})

    def save_quad(self, i: int, quad: list[list[float]], rotate: int) -> None:
        """Remember a drag without cropping, so browsing away doesn't lose it."""
        prev = self.state.get(self.files[i].name, {})
        if not prev.get("done"):
            self._set(self.files[i].name, {**prev, "quad": quad, "rotate": rotate})

    def _set(self, name: str, patch: dict) -> None:
        with self.state_lock:
            self.state[name] = {**self.state.get(name, {}), **patch}
            tmp = self.state_path.with_suffix(".tmp")
            tmp.write_text(json.dumps(self.state, indent=1))
            tmp.replace(self.state_path)

    def progress(self) -> dict:
        done = sum(1 for f in self.files if self.state.get(f.name, {}).get("done"))
        skipped = sum(1 for f in self.files if self.state.get(f.name, {}).get("skipped"))
        first_open = next(
            (i for i, f in enumerate(self.files) if not self.state.get(f.name, {}).get("done") and not self.state.get(f.name, {}).get("skipped")),
            0,
        )
        return {"total": len(self.files), "done": done, "skipped": skipped, "first_open": first_open, "out": str(self.out_dir)}


# ---------------------------------------------------------------------------
# HTTP
# ---------------------------------------------------------------------------

SESSION: Optional[Session] = None


class Handler(BaseHTTPRequestHandler):
    def log_message(self, fmt, *args):  # quiet
        pass

    def _json(self, obj, code=200):
        body = json.dumps(obj).encode()
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        assert SESSION is not None
        path = urlparse(self.path).path
        try:
            if path == "/":
                body = PAGE.encode()
                self.send_response(200)
                self.send_header("Content-Type", "text/html; charset=utf-8")
                self.send_header("Content-Length", str(len(body)))
                self.end_headers()
                self.wfile.write(body)
            elif path == "/api/progress":
                self._json(SESSION.progress())
            elif path.startswith("/api/item/"):
                i = int(path.rsplit("/", 1)[1])
                if not 0 <= i < len(SESSION.files):
                    return self._json({"error": "out of range"}, 404)
                self._json(SESSION.item(i))
            elif path.startswith("/preview/"):
                i = int(unquote(path.rsplit("/", 1)[1]))
                SESSION.analyse(i)
                data = (SESSION.previews / f"{SESSION.files[i].stem}.jpg").read_bytes()
                self.send_response(200)
                self.send_header("Content-Type", "image/jpeg")
                self.send_header("Content-Length", str(len(data)))
                self.send_header("Cache-Control", "max-age=86400")
                self.end_headers()
                self.wfile.write(data)
            else:
                self._json({"error": "not found"}, 404)
        except Exception as e:
            self._json({"error": str(e)}, 500)

    def do_POST(self):
        assert SESSION is not None
        path = urlparse(self.path).path
        n = int(self.headers.get("Content-Length", "0"))
        payload = json.loads(self.rfile.read(n) or b"{}")
        try:
            i = int(path.rsplit("/", 1)[1])
            if path.startswith("/api/confirm/"):
                self._json(SESSION.confirm(i, payload["quad"], int(payload.get("rotate", 0))))
            elif path.startswith("/api/skip/"):
                SESSION.skip(i)
                self._json({"ok": True})
            elif path.startswith("/api/save/"):
                SESSION.save_quad(i, payload["quad"], int(payload.get("rotate", 0)))
                self._json({"ok": True})
            elif path.startswith("/api/redetect/"):
                SESSION.cache.pop(i, None)
                prev = SESSION.state.get(SESSION.files[i].name, {})
                if not prev.get("done"):
                    prev.pop("quad", None)
                    SESSION._set(SESSION.files[i].name, prev)
                self._json(SESSION.item(i))
            else:
                self._json({"error": "not found"}, 404)
        except Exception as e:
            self._json({"error": str(e)}, 500)


PAGE = r"""<!doctype html>
<meta charset="utf-8">
<title>Crop review</title>
<style>
  :root { color-scheme: dark; --bg:#141416; --panel:#1e1e22; --line:#333; --text:#e8e8ec; --muted:#9a9aa3; --accent:#d4af6e; --ok:#6fcf97; --warn:#f2c94c; }
  html,body { margin:0; height:100%; background:var(--bg); color:var(--text); font:14px -apple-system, system-ui, sans-serif; }
  body { display:flex; flex-direction:column; }
  header { display:flex; flex-wrap:wrap; align-items:center; gap:10px 14px; padding:8px 14px; background:var(--panel); border-bottom:1px solid var(--line); }
  header button { white-space:nowrap; }
  header .name { font-weight:600; }
  header .muted { color:var(--muted); }
  header .spacer { flex:1; }
  button { background:#2a2a30; color:var(--text); border:1px solid var(--line); border-radius:6px; padding:6px 12px; cursor:pointer; font:inherit; }
  button:hover { border-color:var(--accent); }
  button.primary { background:var(--accent); color:#111; border-color:var(--accent); font-weight:600; }
  button:disabled { opacity:.5; cursor:default; }
  kbd { color:var(--muted); font-size:11px; margin-left:4px; }
  main { flex:1; position:relative; overflow:hidden; }
  canvas { position:absolute; inset:0; width:100%; height:100%; touch-action:none; }
  #status { position:absolute; left:14px; bottom:12px; color:var(--muted); background:rgba(20,20,22,.8); padding:4px 8px; border-radius:6px; }
  #conf { padding:2px 8px; border-radius:10px; font-size:12px; }
  #conf.good { background:rgba(111,207,151,.18); color:var(--ok); }
  #conf.low { background:rgba(242,201,76,.18); color:var(--warn); }
  #done { color:var(--ok); }
  progress { width:160px; accent-color:var(--accent); }
</style>
<header>
  <span class="name" id="name">…</span>
  <span class="muted" id="counter"></span>
  <progress id="bar" max="1" value="0"></progress>
  <span id="conf"></span>
  <span id="done"></span>
  <span class="spacer"></span>
  <button id="prev" title="Previous (←)">←</button>
  <button id="next" title="Next (→)">→</button>
  <button id="redetect" title="Run detection again (R)">Re-detect<kbd>R</kbd></button>
  <button id="rotL" title="Rotate output counter-clockwise ([)">⟲<kbd>[</kbd></button>
  <button id="rotR" title="Rotate output clockwise (])">⟳<kbd>]</kbd></button>
  <button id="skip" title="Skip this one (S)">Skip<kbd>S</kbd></button>
  <button id="confirm" class="primary" title="Crop, save, next (Enter)">Crop &amp; next<kbd>⏎</kbd></button>
</header>
<main><canvas id="c"></canvas><div id="status"></div></main>
<script>
const $ = (id) => document.getElementById(id);
const canvas = $("c"), ctx = canvas.getContext("2d");
let item = null, img = null, quad = null, rotate = 0, view = { s: 1, ox: 0, oy: 0 };
let drag = null; // { kind: "corner"|"edge", i, start:[x,y], orig: quad copy }
let busy = false;
const HIT = 16;

function status(t) { $("status").textContent = t; }

function fit() {
  const r = canvas.parentElement.getBoundingClientRect();
  canvas.width = r.width * devicePixelRatio; canvas.height = r.height * devicePixelRatio;
  if (!item) return;
  const pad = 30;
  const s = Math.min((r.width - 2 * pad) / item.w, (r.height - 2 * pad) / item.h);
  view = { s, ox: (r.width - item.w * s) / 2, oy: (r.height - item.h * s) / 2, cw: r.width, ch: r.height };
  draw();
}
const toScreen = ([x, y]) => [view.ox + x * view.s, view.oy + y * view.s];
const toImage = (sx, sy) => [(sx - view.ox) / view.s, (sy - view.oy) / view.s];

function draw() {
  ctx.setTransform(devicePixelRatio, 0, 0, devicePixelRatio, 0, 0);
  ctx.clearRect(0, 0, view.cw, view.ch);
  if (!img) return;
  ctx.drawImage(img, view.ox, view.oy, item.w * view.s, item.h * view.s);
  if (!quad) return;
  // Dim everything outside the quad.
  ctx.save();
  ctx.beginPath(); ctx.rect(0, 0, view.cw, view.ch);
  const p = quad.map(toScreen);
  ctx.moveTo(...p[0]); for (let i = 1; i < 4; i++) ctx.lineTo(...p[i]); ctx.closePath();
  ctx.fillStyle = "rgba(0,0,0,0.45)"; ctx.fill("evenodd");
  ctx.restore();
  ctx.lineWidth = 2; ctx.strokeStyle = "#6fe07f";
  ctx.beginPath(); ctx.moveTo(...p[0]); for (let i = 1; i < 4; i++) ctx.lineTo(...p[i]); ctx.closePath(); ctx.stroke();
  p.forEach(([x, y], i) => {
    ctx.beginPath(); ctx.arc(x, y, 7, 0, Math.PI * 2);
    ctx.fillStyle = drag && drag.kind === "corner" && drag.i === i ? "#fff" : "#6fe07f"; ctx.fill();
    ctx.lineWidth = 2; ctx.strokeStyle = "#111"; ctx.stroke();
  });
  // Up arrow shows how the output will be oriented.
  const c = p.reduce((a, q) => [a[0] + q[0] / 4, a[1] + q[1] / 4], [0, 0]);
  ctx.save(); ctx.translate(c[0], c[1]); ctx.rotate(-rotate * Math.PI / 2);
  ctx.strokeStyle = "rgba(255,255,255,0.7)"; ctx.lineWidth = 3;
  ctx.beginPath(); ctx.moveTo(0, 22); ctx.lineTo(0, -22); ctx.moveTo(-10, -10); ctx.lineTo(0, -22); ctx.lineTo(10, -10); ctx.stroke();
  ctx.restore();
  if (drag && drag.kind === "corner") loupe(quad[drag.i]);
}

// Magnified view of the corner being dragged, from the preview's own pixels.
function loupe(pt) {
  const R = 90, Z = 3;
  const [sx, sy] = toScreen(pt);
  let lx = sx + 40, ly = sy - 40 - 2 * R;
  if (lx + 2 * R > view.cw) lx = sx - 40 - 2 * R;
  if (ly < 0) ly = sy + 40;
  const scale = img.naturalWidth / item.w; // preview px per image px
  const src = (2 * R) / (Z * view.s) * scale;
  ctx.save();
  ctx.beginPath(); ctx.arc(lx + R, ly + R, R, 0, Math.PI * 2); ctx.clip();
  ctx.fillStyle = "#000"; ctx.fillRect(lx, ly, 2 * R, 2 * R);
  ctx.drawImage(img, pt[0] * scale - src / 2, pt[1] * scale - src / 2, src, src, lx, ly, 2 * R, 2 * R);
  // The quad's edges through the loupe, so you can line them up with the print.
  ctx.strokeStyle = "rgba(111,224,127,0.9)"; ctx.lineWidth = 1.5;
  const i = drag.i, a = quad[(i + 3) % 4], b = quad[(i + 1) % 4];
  const m = ([x, y]) => [lx + R + (x - pt[0]) * view.s * Z, ly + R + (y - pt[1]) * view.s * Z];
  for (const q of [a, b]) { ctx.beginPath(); ctx.moveTo(lx + R, ly + R); ctx.lineTo(...m(q)); ctx.stroke(); }
  ctx.strokeStyle = "rgba(255,255,255,0.8)"; ctx.beginPath(); ctx.moveTo(lx + R - 8, ly + R); ctx.lineTo(lx + R + 8, ly + R); ctx.moveTo(lx + R, ly + R - 8); ctx.lineTo(lx + R, ly + R + 8); ctx.stroke();
  ctx.restore();
  ctx.strokeStyle = "#fff"; ctx.lineWidth = 2; ctx.beginPath(); ctx.arc(lx + R, ly + R, R, 0, Math.PI * 2); ctx.stroke();
}

function hit(sx, sy) {
  const p = quad.map(toScreen);
  for (let i = 0; i < 4; i++) if (Math.hypot(p[i][0] - sx, p[i][1] - sy) < HIT) return { kind: "corner", i };
  for (let i = 0; i < 4; i++) {
    const a = p[i], b = p[(i + 1) % 4];
    const t = Math.max(0, Math.min(1, ((sx - a[0]) * (b[0] - a[0]) + (sy - a[1]) * (b[1] - a[1])) / ((b[0] - a[0]) ** 2 + (b[1] - a[1]) ** 2)));
    const d = Math.hypot(a[0] + t * (b[0] - a[0]) - sx, a[1] + t * (b[1] - a[1]) - sy);
    if (d < HIT * 0.6) return { kind: "edge", i };
  }
  return null;
}

canvas.addEventListener("pointerdown", (e) => {
  if (!quad || busy) return;
  const h = hit(e.offsetX, e.offsetY);
  if (!h) return;
  drag = { ...h, start: toImage(e.offsetX, e.offsetY), orig: quad.map((q) => [...q]) };
  canvas.setPointerCapture(e.pointerId);
  draw();
});
canvas.addEventListener("pointermove", (e) => {
  if (!drag) { const h = quad && !busy ? hit(e.offsetX, e.offsetY) : null; canvas.style.cursor = h ? (h.kind === "corner" ? "crosshair" : "move") : "default"; return; }
  const [x, y] = toImage(e.offsetX, e.offsetY);
  const dx = x - drag.start[0], dy = y - drag.start[1];
  const clamp = ([px, py]) => [Math.max(0, Math.min(item.w, px)), Math.max(0, Math.min(item.h, py))];
  if (drag.kind === "corner") quad[drag.i] = clamp([x, y]);
  else for (const j of [drag.i, (drag.i + 1) % 4]) quad[j] = clamp([drag.orig[j][0] + dx, drag.orig[j][1] + dy]);
  draw();
});
const endDrag = () => { if (!drag) return; drag = null; draw(); save(); };
canvas.addEventListener("pointerup", endDrag);
canvas.addEventListener("pointercancel", endDrag);
window.addEventListener("resize", fit);

async function api(path, body) {
  const r = await fetch(path, body ? { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) } : {});
  const j = await r.json();
  if (j.error) throw new Error(j.error);
  return j;
}
let saveTimer = null;
function save() { clearTimeout(saveTimer); saveTimer = setTimeout(() => api(`/api/save/${item.index}`, { quad, rotate }).catch(() => {}), 300); }

async function load(i) {
  busy = true; drag = null;
  status("Detecting corners…");
  $("name").textContent = "…"; $("done").textContent = ""; $("conf").textContent = "";
  try {
    item = await api(`/api/item/${i}`);
  } catch (e) { status("Error: " + e.message); busy = false; return; }
  quad = item.quad.map((q) => [...q]); rotate = item.rotate || 0;
  $("name").textContent = item.name;
  $("counter").textContent = `${item.index + 1} / ${item.total}`;
  $("prev").disabled = item.index === 0; $("next").disabled = item.index === item.total - 1;
  $("done").textContent = item.done ? `✓ saved as ${item.output}` : item.skipped ? "skipped" : "";
  const c = item.confidence;
  $("conf").textContent = item.method === "none" ? "no detection — place corners by hand" : `auto · edge confidence ${c.toFixed(2)}`;
  $("conf").className = c >= 0.15 ? "good" : "low";
  await new Promise((res) => { img = new Image(); img.onload = res; img.onerror = res; img.src = item.preview; });
  status(item.done ? "Already cropped — Enter re-crops and overwrites." : "Drag corners or edges onto the print. Enter to crop.");
  busy = false;
  fit();
  refreshProgress();
  history.replaceState(null, "", `#${i}`);
}
async function refreshProgress() {
  const p = await api("/api/progress");
  $("bar").max = p.total; $("bar").value = p.done;
  $("bar").title = `${p.done} cropped, ${p.skipped} skipped, ${p.total - p.done - p.skipped} to go → ${p.out}`;
}
function go(d) { if (!item || busy) return; const n = item.index + d; if (n >= 0 && n < item.total) load(n); }
async function confirm() {
  if (!item || busy) return;
  busy = true; status("Cropping and saving TIFF…");
  try {
    const r = await api(`/api/confirm/${item.index}`, { quad, rotate });
    status(`Saved ${r.output} (${r.size[0]}×${r.size[1]})`);
    busy = false;
    if (item.index + 1 < item.total) load(item.index + 1);
    else { refreshProgress(); status(`Saved ${r.output}. That was the last one.`); }
  } catch (e) { status("Error: " + e.message); busy = false; }
}
async function skip() { if (!item || busy) return; await api(`/api/skip/${item.index}`, {}); go(1); }
async function redetect() {
  if (!item || busy) return;
  busy = true; status("Re-detecting…");
  try { const it = await api(`/api/redetect/${item.index}`, {}); quad = it.auto.map((q) => [...q]); item.confidence = it.confidence; item.method = it.method;
    $("conf").textContent = `auto · edge confidence ${it.confidence.toFixed(2)}`; $("conf").className = it.confidence >= 0.15 ? "good" : "low"; }
  catch (e) { status("Error: " + e.message); }
  busy = false; draw(); save(); status("Corners reset to the detector's guess.");
}
function rot(d) { if (!item || busy) return; rotate = (rotate + d + 4) % 4; draw(); save(); }

$("prev").onclick = () => go(-1); $("next").onclick = () => go(1);
$("confirm").onclick = confirm; $("skip").onclick = skip; $("redetect").onclick = redetect;
$("rotL").onclick = () => rot(-1); $("rotR").onclick = () => rot(1);
window.addEventListener("keydown", (e) => {
  if (e.target.tagName === "INPUT") return;
  if (e.key === "Enter") { e.preventDefault(); confirm(); }
  else if (e.key === "ArrowRight") go(1);
  else if (e.key === "ArrowLeft") go(-1);
  else if (e.key === "s" || e.key === "S") skip();
  else if (e.key === "r" || e.key === "R") redetect();
  else if (e.key === "[") rot(-1);
  else if (e.key === "]") rot(1);
  else if (e.key === "Escape" && drag) { quad = drag.orig; drag = null; draw(); }
});

(async () => {
  fit();
  const p = await api("/api/progress");
  const fromHash = parseInt(location.hash.slice(1), 10);
  load(Number.isFinite(fromHash) ? fromHash : p.first_open);
})();
</script>
"""


def main(argv: Optional[list[str]] = None) -> int:
    global SESSION
    ap = argparse.ArgumentParser(description="Review and crop scanned prints one by one in the browser.")
    ap.add_argument("inputs", nargs="+", help="image files and/or directories")
    ap.add_argument("-o", "--out", default=None, help="output directory (default: <first input dir>/cropped)")
    ap.add_argument("--inset", type=float, default=0.4, help="shave this %% off every edge after the warp (default 0.4)")
    ap.add_argument("--port", type=int, default=8765)
    ap.add_argument("--no-browser", action="store_true")
    args = ap.parse_args(argv)

    files = autocrop.gather(args.inputs)
    if not files:
        print("no images found", file=sys.stderr)
        return 1
    first = Path(args.inputs[0]).expanduser()
    out_dir = Path(args.out).expanduser() if args.out else (first if first.is_dir() else first.parent) / "cropped"
    out_dir.mkdir(parents=True, exist_ok=True)
    SESSION = Session(files, out_dir, args.inset / 100)

    server = ThreadingHTTPServer(("127.0.0.1", args.port), Handler)
    url = f"http://127.0.0.1:{args.port}/"
    print(f"{len(files)} scans · output → {out_dir}\n{url}   (Ctrl-C to quit)")
    if not args.no_browser:
        threading.Timer(0.6, lambda: webbrowser.open(url)).start()
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\nbye")
    return 0


if __name__ == "__main__":
    sys.exit(main())
