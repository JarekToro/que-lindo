// The Restore view: one photo, full window. A pipeline of restoration steps
// on the right, the photo on the left with the result over it (swap, hold
// Space to peek, or a split you drag). Nothing touches the file until you
// choose Replace (original kept in _originals/) or Save as copy.
//
// The heavy lifting is the Python engine in tools/restore; see restore/client.ts.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ask, message, save } from "@tauri-apps/plugin-dialog";
import { importFiles } from "../App";
import { notePhotoRewritten } from "../editExternal";
import { EngineError, engine, resetEngine } from "../restore/client";
import type { EngineInfo, EngineProblem, ModelInfo, RestoreClient, RunResult } from "../restore/client";
import {
  BUILTIN_PRESETS,
  DEFAULT_QUAD,
  STEP_NAMES,
  STEP_TYPES,
  allPresets,
  defaultStep,
  loadUserPresets,
  needs,
  saveUserPresets,
  stepLabel,
} from "../restore/steps";
import type { Preset, Quad, ResizeMethod, Step } from "../restore/steps";
import { useEditor } from "../store";
import Menu from "./Menu";

type ViewMode = "result" | "original" | "split";

interface View {
  scale: number;
  tx: number;
  ty: number;
}

const baseName = (p: string) => p.replace(/^.*[/\\]/, "");
const dirName = (p: string) => p.slice(0, Math.max(p.lastIndexOf("/"), p.lastIndexOf("\\")));
const splitExt = (name: string): [string, string] => {
  const dot = name.lastIndexOf(".");
  return dot <= 0 ? [name, ""] : [name.slice(0, dot), name.slice(dot)];
};

/** Above this many pixels the viewer asks the engine for a downscaled original. */
const HUGE_PX = 40e6;

function loadImage(url: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const im = new Image();
    im.onload = () => resolve(im);
    im.onerror = () => reject(new Error("image failed to load"));
    im.src = url;
  });
}

export default function RestoreView({ path }: { path: string }) {
  const setRestoring = useEditor((s) => s.setRestoring);
  const media = useEditor((s) => s.media);
  const project = useEditor((s) => s.project);
  const relinkMedia = useEditor((s) => s.relinkMedia);

  // ---- engine -------------------------------------------------------------
  const [client, setClient] = useState<RestoreClient | null>(null);
  const [problem, setProblem] = useState<EngineProblem | null>(null);
  const [info, setInfo] = useState<EngineInfo | null>(null);
  const [models, setModels] = useState<ModelInfo[]>([]);
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    let live = true;
    setProblem(null);
    engine()
      .then(async (c) => {
        if (!live) return;
        setClient(c);
        const [i, m] = await Promise.all([c.info(), c.models()]);
        if (!live) return;
        setInfo(i);
        setModels(m);
      })
      .catch((e: unknown) => {
        if (!live) return;
        setProblem(e instanceof EngineError ? e.problem : { kind: "failed", message: String(e), log: "" });
      });
    return () => {
      live = false;
    };
  }, [attempt]);

  // ---- the photo list (bin order) and where we are in it ------------------
  const photos = useMemo(
    () => media.filter((m) => m.status === "ready" && m.info.is_image).map((m) => m.path),
    [media],
  );
  const at = photos.indexOf(path);
  const item = media.find((m) => m.path === path);
  const pixels = item?.status === "ready" ? item.info.width * item.info.height : 0;
  const usedInFilm = project.slides.some((s) =>
    s.cells.some((c) => c.source.type === "image" && c.source.path === path),
  );

  // ---- pipeline -----------------------------------------------------------
  const [userPresets, setUserPresets] = useState<Preset[]>(() => loadUserPresets());
  const presets = allPresets(userPresets);
  const [presetName, setPresetName] = useState<string | null>(BUILTIN_PRESETS[0].name);
  const [steps, setSteps] = useState<Step[]>(() => BUILTIN_PRESETS[0].steps.map((s) => ({ ...s })));
  const [savingPreset, setSavingPreset] = useState(false);
  const [newPresetName, setNewPresetName] = useState("");
  const [quality, setQuality] = useState(95);

  /** Index of the autocrop step whose corners are on the photo, or null. */
  const [cropAt, setCropAt] = useState<number | null>(null);
  const [detecting, setDetecting] = useState(false);
  /** Bumped when the view transform changes so the corner handles follow. */
  const [, setViewVersion] = useState(0);

  const edit = (next: Step[]) => {
    setSteps(next);
    setPresetName(null);
    if (cropAt !== null && next[cropAt]?.type !== "autocrop") setCropAt(null);
  };
  const pickPreset = (name: string) => {
    const p = presets.find((x) => x.name === name);
    if (!p) return;
    setSteps(p.steps.map((s) => ({ ...s })));
    setPresetName(name);
    setCropAt(null);
  };

  /** The corners being adjusted (a fresh default quad when the step is on auto). */
  const cropQuad: Quad | null = (() => {
    if (cropAt === null) return null;
    const st = steps[cropAt];
    return st?.type === "autocrop" ? (st.quad ?? DEFAULT_QUAD) : null;
  })();

  const setCropCorner = (k: number, x: number, y: number) => {
    if (cropAt === null) return;
    edit(
      steps.map((st, j) => {
        if (j !== cropAt || st.type !== "autocrop") return st;
        const q = (st.quad ?? DEFAULT_QUAD).map((pt) => [...pt] as [number, number]) as Quad;
        q[k] = [Math.max(-0.5, Math.min(1.5, x)), Math.max(-0.5, Math.min(1.5, y))];
        return { ...st, quad: q };
      }),
    );
  };

  /** Put the corners on the photo for step i (starting from the default box). */
  const adjustCorners = (i: number) => {
    if (cropAt === i) {
      setCropAt(null);
      return;
    }
    const st = steps[i];
    if (st?.type !== "autocrop") return;
    if (!st.quad) edit(steps.map((x, j) => (j === i && x.type === "autocrop" ? { ...x, quad: DEFAULT_QUAD } : x)));
    setCropAt(i);
  };

  const detectCorners = async (i: number) => {
    if (!client || detecting) return;
    setDetecting(true);
    try {
      const det = await client.detectPrint(path);
      if (!det.found || !det.quad) {
        void message("No print was found in this photo. Place the corners by hand with “Adjust corners”.", {
          title: "Nothing detected",
          kind: "info",
        });
        return;
      }
      const quad = det.quad;
      edit(steps.map((x, j) => (j === i && x.type === "autocrop" ? { ...x, quad } : x)));
      setCropAt(i);
      setNote(`Print found (${det.method}, confidence ${Math.round((det.confidence ?? 0) * 100)}%). Drag a corner to adjust.`);
    } catch (e) {
      void message(`Detection failed:\n${String(e)}`, { title: "Detect corners", kind: "error" });
    } finally {
      setDetecting(false);
    }
  };
  const savePreset = () => {
    const name = newPresetName.trim();
    if (!name || !steps.length) return;
    const next = [...userPresets.filter((p) => p.name !== name), { name, steps: steps.map((s) => ({ ...s })), builtin: false }];
    setUserPresets(next);
    saveUserPresets(next);
    setPresetName(name);
    setSavingPreset(false);
    setNewPresetName("");
  };
  const deletePreset = () => {
    if (!presetName) return;
    const next = userPresets.filter((p) => p.name !== presetName);
    setUserPresets(next);
    saveUserPresets(next);
    setPresetName(null);
  };

  const missing = useMemo(() => {
    if (!info) return [];
    const n = needs(steps);
    const out: string[] = [];
    if (n.pmrf && !info.capabilities.pmrf) out.push("PMRF is not set up (tools/restore/setup.sh --pmrf)");
    if (n.bopbtl && !info.capabilities.bopbtl)
      out.push("Bringing Old Photos Back to Life is not set up (tools/restore/setup.sh --bopbtl)");
    for (const s of steps) if (s.type === "model" && !s.model) out.push("a Model step has no model chosen");
    return out;
  }, [steps, info]);

  // ---- images -------------------------------------------------------------
  const [orig, setOrig] = useState<HTMLImageElement | null>(null);
  const [res, setRes] = useState<HTMLImageElement | null>(null);
  const [result, setResult] = useState<RunResult | null>(null);
  const [bust, setBust] = useState(0);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);

  useEffect(() => {
    if (!client) return;
    let live = true;
    setOrig(null);
    setRes(null);
    setResult(null);
    setLoadError(null);
    setNote(null);
    setCropAt(null);
    const url = client.originalUrl(path, pixels > HUGE_PX ? 4000 : undefined, bust);
    loadImage(url)
      .then((im) => {
        if (!live) return;
        setOrig(im);
        fitRef.current = true;
      })
      .catch(() => live && setLoadError("The photo could not be loaded."));
    return () => {
      live = false;
    };
  }, [client, path, pixels, bust]);

  // ---- running ------------------------------------------------------------
  const [running, setRunning] = useState(false);
  const [status, setStatus] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [showLog, setShowLog] = useState(false);

  const run = async () => {
    if (!client || running || !steps.length || missing.length) return;
    const target = path;
    setRunning(true);
    setError(null);
    setNote(null);
    setStatus("starting…");
    const poll = setInterval(() => {
      client
        .info()
        .then((i) => setStatus(i.status || "working…"))
        .catch(() => undefined);
    }, 700);
    try {
      const r = await client.process(target, steps);
      const im = await loadImage(client.resultUrl(r));
      if (useEditor.getState().restoring !== target) return; // moved on meanwhile
      setResult(r);
      setRes(im);
      setMode("result");
      setCropAt(null);
    } catch (e) {
      const msg = String(e instanceof Error ? e.message : e);
      setError(msg);
      if (/Failed to fetch|Load failed|NetworkError/i.test(msg)) resetEngine();
    } finally {
      clearInterval(poll);
      setRunning(false);
      setStatus("");
    }
  };

  // ---- committing ---------------------------------------------------------
  const [committing, setCommitting] = useState(false);
  const name = baseName(path);

  const replaceOriginal = async () => {
    if (!client || !result || committing) return;
    const ok = await ask(
      `Replace “${name}” with the restored version?\n\nThe original is kept next to it in _originals/.`,
      { title: "Replace photo", kind: "warning", okLabel: "Replace" },
    );
    if (!ok) return;
    setCommitting(true);
    try {
      const r = await client.replace(path, result.key, quality);
      await notePhotoRewritten(path);
      setBust((b) => b + 1); // reload the (now restored) original; the result view resets with it
      setNote(`Replaced. The original is in ${r.backup ?? "_originals/"}.`);
    } catch (e) {
      void message(`Could not replace the photo:\n${String(e)}`, { title: "Replace failed", kind: "error" });
    } finally {
      setCommitting(false);
    }
  };

  const saveAsCopy = async () => {
    if (!client || !result || committing) return;
    const [stem, ext] = splitExt(name);
    const keep = /\.(jpe?g|png|webp|tiff?)$/i.test(ext) ? ext : ".png";
    const picked = await save({
      title: "Save restored copy",
      defaultPath: `${dirName(path)}/${stem}_restored${keep}`,
      filters: [{ name: "Image", extensions: ["jpg", "jpeg", "png", "webp", "tif", "tiff"] }],
    });
    if (!picked) return;
    setCommitting(true);
    try {
      const r = await client.saveAs(path, result.key, picked, quality);
      const written = r.written;
      await importFiles([written]);
      let swapped = false;
      if (usedInFilm) {
        swapped = await ask(`Use the restored copy in the film in place of “${name}”?`, {
          title: "Saved",
          kind: "info",
          okLabel: "Use the copy",
          cancelLabel: "Keep the original",
        });
        if (swapped) {
          relinkMedia({ [path]: written });
          void importFiles([path]); // the original stays available on the shelf
        }
      }
      setNote(`Saved ${baseName(written)}${swapped ? " and placed it in the film" : " on the shelf"}.`);
    } catch (e) {
      void message(`Could not save the copy:\n${String(e)}`, { title: "Save failed", kind: "error" });
    } finally {
      setCommitting(false);
    }
  };

  // ---- the stage: zoom, pan, modes ---------------------------------------
  const stageRef = useRef<HTMLDivElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const viewRef = useRef<View>({ scale: 1, tx: 0, ty: 0 });
  const fitRef = useRef(true);
  const [mode, setMode] = useState<ViewMode>("result");
  const [peek, setPeek] = useState(false);
  const [split, setSplit] = useState(0.5);
  const [zoomPct, setZoomPct] = useState(100);

  const draw = useCallback(() => {
    const canvas = canvasRef.current;
    const stage = stageRef.current;
    if (!canvas || !stage) return;
    const dpr = window.devicePixelRatio || 1;
    const W = stage.clientWidth;
    const H = stage.clientHeight;
    if (!W || !H) return;
    if (canvas.width !== Math.round(W * dpr) || canvas.height !== Math.round(H * dpr)) {
      canvas.width = Math.round(W * dpr);
      canvas.height = Math.round(H * dpr);
    }
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.fillStyle = "#000";
    ctx.fillRect(0, 0, W, H);
    if (!orig) return;
    if (fitRef.current) {
      const s = Math.min(W / orig.naturalWidth, H / orig.naturalHeight);
      viewRef.current = { scale: s, tx: (W - orig.naturalWidth * s) / 2, ty: (H - orig.naturalHeight * s) / 2 };
      fitRef.current = false;
      setZoomPct(Math.round(s * 100));
    }
    const v = viewRef.current;
    const drawOne = (im: HTMLImageElement) => {
      // Results may differ in size from the original (resize steps); keep them
      // on the original's geometry so the two line up.
      const s = v.scale * (orig.naturalWidth / im.naturalWidth);
      ctx.imageSmoothingEnabled = s < 2;
      ctx.drawImage(im, v.tx, v.ty, im.naturalWidth * s, im.naturalHeight * s);
    };
    const showing: ViewMode = peek || cropQuad ? "original" : mode;
    if (!res || showing === "original") {
      drawOne(orig);
      if (cropQuad) {
        ctx.strokeStyle = "#d4af6e";
        ctx.lineWidth = 1.5;
        ctx.beginPath();
        cropQuad.forEach(([x, y], k) => {
          const px = v.tx + x * orig.naturalWidth * v.scale;
          const py = v.ty + y * orig.naturalHeight * v.scale;
          if (k === 0) ctx.moveTo(px, py);
          else ctx.lineTo(px, py);
        });
        ctx.closePath();
        ctx.stroke();
        setViewVersion((n) => n + 1);
      }
      return;
    }
    if (showing === "result") {
      drawOne(res);
      return;
    }
    drawOne(orig);
    const x = Math.round(W * split);
    ctx.save();
    ctx.beginPath();
    ctx.rect(x, 0, W - x, H);
    ctx.clip();
    drawOne(res);
    ctx.restore();
    ctx.fillStyle = "rgba(255,255,255,0.85)";
    ctx.fillRect(x - 1, 0, 2, H);
  }, [orig, res, mode, peek, split, cropQuad]);

  useEffect(() => {
    draw();
  }, [draw]);

  useEffect(() => {
    const stage = stageRef.current;
    if (!stage) return;
    const ro = new ResizeObserver(() => draw());
    ro.observe(stage);
    return () => ro.disconnect();
  }, [draw]);

  const fit = () => {
    fitRef.current = true;
    draw();
  };
  const zoom100 = () => {
    const stage = stageRef.current;
    if (!stage || !orig) return;
    viewRef.current = {
      scale: 1,
      tx: (stage.clientWidth - orig.naturalWidth) / 2,
      ty: (stage.clientHeight - orig.naturalHeight) / 2,
    };
    setZoomPct(100);
    draw();
  };
  const zoomAt = (mx: number, my: number, f: number) => {
    const v = viewRef.current;
    const ns = Math.max(0.02, Math.min(32, v.scale * f));
    const k = ns / v.scale;
    viewRef.current = { scale: ns, tx: mx - (mx - v.tx) * k, ty: my - (my - v.ty) * k };
    setZoomPct(Math.round(ns * 100));
    draw();
  };

  // Wheel zoom needs a non-passive listener; React's onWheel is passive.
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const r = canvas.getBoundingClientRect();
      zoomAt(e.clientX - r.left, e.clientY - r.top, Math.exp(-e.deltaY * 0.0015));
    };
    canvas.addEventListener("wheel", onWheel, { passive: false });
    return () => canvas.removeEventListener("wheel", onWheel);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [draw]);

  const drag = useRef<{ kind: "pan" | "split"; x: number; y: number; tx: number; ty: number } | null>(null);
  const onPointerDown = (e: React.PointerEvent<HTMLCanvasElement>) => {
    const r = e.currentTarget.getBoundingClientRect();
    const x = e.clientX - r.left;
    const nearSplit = mode === "split" && res && Math.abs(x - r.width * split) < 10;
    e.currentTarget.setPointerCapture(e.pointerId);
    drag.current = {
      kind: nearSplit ? "split" : "pan",
      x: e.clientX,
      y: e.clientY,
      tx: viewRef.current.tx,
      ty: viewRef.current.ty,
    };
  };
  const onPointerMove = (e: React.PointerEvent<HTMLCanvasElement>) => {
    const d = drag.current;
    const r = e.currentTarget.getBoundingClientRect();
    if (!d) {
      const x = e.clientX - r.left;
      e.currentTarget.style.cursor =
        mode === "split" && res && Math.abs(x - r.width * split) < 10 ? "col-resize" : "grab";
      return;
    }
    if (d.kind === "split") {
      setSplit(Math.max(0.02, Math.min(0.98, (e.clientX - r.left) / r.width)));
      return;
    }
    viewRef.current = { ...viewRef.current, tx: d.tx + (e.clientX - d.x), ty: d.ty + (e.clientY - d.y) };
    draw();
  };
  const onPointerUp = () => {
    drag.current = null;
  };

  // ---- corner handles -----------------------------------------------------
  const handleDrag = useRef<number | null>(null);
  const onHandleDown = (k: number) => (e: React.PointerEvent<HTMLButtonElement>) => {
    e.stopPropagation();
    e.currentTarget.setPointerCapture(e.pointerId);
    handleDrag.current = k;
  };
  const onHandleMove = (e: React.PointerEvent<HTMLButtonElement>) => {
    const k = handleDrag.current;
    const stage = stageRef.current;
    if (k === null || !stage || !orig) return;
    const r = stage.getBoundingClientRect();
    const v = viewRef.current;
    setCropCorner(
      k,
      (e.clientX - r.left - v.tx) / (orig.naturalWidth * v.scale),
      (e.clientY - r.top - v.ty) / (orig.naturalHeight * v.scale),
    );
  };
  const onHandleUp = () => {
    handleDrag.current = null;
  };
  const handlePositions =
    cropQuad && orig
      ? cropQuad.map(([x, y]) => ({
          left: viewRef.current.tx + x * orig.naturalWidth * viewRef.current.scale,
          top: viewRef.current.ty + y * orig.naturalHeight * viewRef.current.scale,
        }))
      : [];
  const CORNER_NAMES = ["Top left", "Top right", "Bottom right", "Bottom left"];

  // ---- keys ---------------------------------------------------------------
  const close = () => setRestoring(null);
  const go = (delta: number) => {
    const next = photos[at + delta];
    if (next) setRestoring(next);
  };
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement;
      const typing = ["INPUT", "TEXTAREA", "SELECT"].includes(t.tagName) || t.isContentEditable;
      if (e.key === "Escape") {
        if (typing) return;
        e.preventDefault();
        close();
        return;
      }
      if (typing) return;
      if (e.key === "ArrowLeft") go(-1);
      else if (e.key === "ArrowRight") go(1);
      else if (e.key === " " && t.tagName !== "BUTTON") {
        e.preventDefault();
        setPeek(true);
      } else if (e.key === "f" || e.key === "F") fit();
      else if (e.key === "1") zoom100();
      else if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) void run();
    };
    const onUp = (e: KeyboardEvent) => {
      if (e.key === " ") setPeek(false);
    };
    const onBlur = () => setPeek(false);
    window.addEventListener("keydown", onKey);
    window.addEventListener("keyup", onUp);
    window.addEventListener("blur", onBlur);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("keyup", onUp);
      window.removeEventListener("blur", onBlur);
    };
  });

  // ---- render -------------------------------------------------------------
  const canRun = !!client && !running && steps.length > 0 && missing.length === 0 && !!orig;

  return (
    <div className="restore" role="region" aria-label="Restore photo">
      <header className="restore-head">
        <button onClick={close} title="Back to the film (Esc)">
          ‹ Back to film
        </button>
        <span className="restore-title" title={path}>
          {name}
          {photos.length > 1 && at >= 0 && (
            <span className="values-scope">
              {" "}
              · {at + 1} of {photos.length}
            </span>
          )}
        </span>
        <button className="ghost" onClick={() => go(-1)} disabled={at <= 0} title="Previous photo (←)" aria-label="Previous photo">
          ‹
        </button>
        <button
          className="ghost"
          onClick={() => go(1)}
          disabled={at < 0 || at >= photos.length - 1}
          title="Next photo (→)"
          aria-label="Next photo"
        >
          ›
        </button>
        <span className="restore-spacer" />
        <div className="seg" role="group" aria-label="What the photo shows">
          <button className={mode === "original" ? "on" : ""} onClick={() => setMode("original")}>
            Original
          </button>
          <button className={mode === "result" ? "on" : ""} onClick={() => setMode("result")} disabled={!res}>
            Result
          </button>
          <button className={mode === "split" ? "on" : ""} onClick={() => setMode("split")} disabled={!res}>
            Split
          </button>
        </div>
        <span className="time" title="Zoom">
          {zoomPct}%
        </span>
        <button className="ghost" onClick={fit} title="Fit to window (F)">
          Fit
        </button>
        <button className="ghost" onClick={zoom100} title="Actual pixels (1)">
          1:1
        </button>
      </header>

      <div className="restore-body">
        <div className="restore-stage" ref={stageRef}>
          <canvas
            ref={canvasRef}
            onPointerDown={onPointerDown}
            onPointerMove={onPointerMove}
            onPointerUp={onPointerUp}
            onPointerCancel={onPointerUp}
            onDoubleClick={fit}
            aria-label={peek || mode === "original" || !res ? "Original photo" : "Restored photo"}
          />
          {handlePositions.map((pos, k) => (
            <button
              key={k}
              className="crop-handle"
              style={pos}
              onPointerDown={onHandleDown(k)}
              onPointerMove={onHandleMove}
              onPointerUp={onHandleUp}
              onPointerCancel={onHandleUp}
              title={`${CORNER_NAMES[k]} corner of the print: drag`}
              aria-label={`${CORNER_NAMES[k]} corner`}
            />
          ))}
          {cropQuad && <div className="restore-badge">corners · drag to fit the print</div>}
          {res && !cropQuad && (
            <div className="restore-badge">{peek || mode === "original" ? "original" : mode === "split" ? "original | result" : "result"}</div>
          )}
          {!res && orig && !running && (
            <div className="restore-hint">Hold Space to peek at the original once there is a result.</div>
          )}
          {(running || (!orig && client && !loadError)) && (
            <div className="restore-status" role="status">
              {running ? status || "working…" : "loading photo…"}
            </div>
          )}
          {loadError && <div className="restore-status warn">{loadError}</div>}
          {!client && !problem && (
            <div className="restore-status" role="status">
              Starting the restore engine…
            </div>
          )}
          {problem && (
            <div className="restore-setup">
              {problem.kind === "not-installed" ? (
                <>
                  <h2>Photo restoration is not set up</h2>
                  <p>
                    The restore engine (models for faces, old prints, denoising) lives in
                    <code> tools/restore</code> and needs a one-time install:
                  </p>
                  <pre>tools/restore/setup.sh --all</pre>
                  <p className="hint">
                    Looked in <code>{problem.lookedIn}</code>. Set <code>SLIDESHOW_RESTORE_DIR</code> to use another
                    location. See <code>tools/restore/README.md</code>.
                  </p>
                </>
              ) : (
                <>
                  <h2>The restore engine could not start</h2>
                  <pre>{problem.message}</pre>
                  {problem.log && (
                    <p className="hint">
                      Log: <code>{problem.log}</code>
                    </p>
                  )}
                </>
              )}
              <div className="row">
                <button
                  className="primary"
                  onClick={() => {
                    resetEngine();
                    setAttempt((n) => n + 1);
                  }}
                >
                  Try again
                </button>
                <button onClick={close}>Back to film</button>
              </div>
            </div>
          )}
        </div>

        <aside className="restore-side" aria-label="Restore pipeline">
          <div className="restore-group">
            <label className="restore-label" htmlFor="restore-preset">
              Preset
            </label>
            <div className="row" style={{ margin: 0 }}>
              <select
                id="restore-preset"
                value={presetName ?? "__custom"}
                onChange={(e) => pickPreset(e.target.value)}
                style={{ flex: 1, maxWidth: "none" }}
              >
                {presetName === null && <option value="__custom">Custom</option>}
                {presets.map((p) => (
                  <option key={p.name} value={p.name}>
                    {p.name}
                  </option>
                ))}
              </select>
              {presetName && !presets.find((p) => p.name === presetName)?.builtin ? (
                <button className="ghost" onClick={deletePreset} title="Delete this preset">
                  Delete
                </button>
              ) : (
                <button className="ghost" onClick={() => setSavingPreset((v) => !v)} title="Keep these steps as a preset">
                  Save…
                </button>
              )}
            </div>
            {savingPreset && (
              <div className="row" style={{ margin: "6px 0 0" }}>
                <input
                  autoFocus
                  placeholder="Preset name"
                  value={newPresetName}
                  onChange={(e) => setNewPresetName(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") savePreset();
                    if (e.key === "Escape") setSavingPreset(false);
                  }}
                  style={{ flex: 1, maxWidth: "none" }}
                />
                <button className="primary" onClick={savePreset} disabled={!newPresetName.trim()}>
                  Save
                </button>
              </div>
            )}
          </div>

          <div className="restore-group">
            <div className="restore-label">Steps</div>
            {steps.length === 0 && <p className="hint">No steps. Add one below or pick a preset.</p>}
            {steps.map((s, i) => (
              <StepEditor
                key={i}
                step={s}
                index={i}
                count={steps.length}
                models={models}
                adjusting={cropAt === i}
                detecting={detecting}
                onAdjust={() => adjustCorners(i)}
                onDetect={() => void detectCorners(i)}
                onChange={(next) => edit(steps.map((x, j) => (j === i ? next : x)))}
                onRemove={() => edit(steps.filter((_, j) => j !== i))}
                onMove={(d) => {
                  const j = i + d;
                  if (j < 0 || j >= steps.length) return;
                  const next = [...steps];
                  [next[i], next[j]] = [next[j], next[i]];
                  edit(next);
                }}
              />
            ))}
            <Menu
              label="+ Add step ▾"
              ariaLabel="Add step"
              items={STEP_TYPES.map((t) => ({
                label: STEP_NAMES[t],
                onPick: () => edit([...steps, defaultStep(t, t === "model" ? (models[0]?.name ?? "") : "")]),
              }))}
            />
          </div>

          <div className="restore-group">
            <button className="primary restore-run" onClick={() => void run()} disabled={!canRun} title="Run the steps (⌘↩)">
              {running ? "Running…" : result ? "Run again" : "Run"}
            </button>
            {missing.map((m) => (
              <p key={m} className="hint warn">
                {m}
              </p>
            ))}
            {error && (
              <p className="hint warn" role="alert">
                {error}
              </p>
            )}
            {result && (
              <p className="hint">
                {result.w}×{result.h} · {(result.ms / 1000).toFixed(1)} s{result.cached ? " (cached)" : ""} ·{" "}
                <button className="ghost" onClick={() => setShowLog((v) => !v)}>
                  {showLog ? "hide log" : "log"}
                </button>
              </p>
            )}
            {result && showLog && <pre className="restore-log">{result.log.join("\n")}</pre>}
            {info && (
              <p className="hint">
                Engine on {info.device}
                {models.length ? ` · ${models.length} model${models.length === 1 ? "" : "s"}` : " · no model files"}
              </p>
            )}
          </div>

          <div className="restore-group restore-commit">
            <div className="restore-label">Keep the result</div>
            <label className="restore-field">
              <span>JPEG quality</span>
              <input
                type="number"
                min={60}
                max={100}
                value={quality}
                onChange={(e) => setQuality(Math.max(60, Math.min(100, Number(e.target.value) || 95)))}
              />
            </label>
            <div className="row" style={{ margin: 0 }}>
              <button onClick={() => void replaceOriginal()} disabled={!result || committing} title="Overwrite the file; the original moves to _originals/">
                Replace original…
              </button>
              <button onClick={() => void saveAsCopy()} disabled={!result || committing} title="Write the result as a new file">
                Save as copy…
              </button>
            </div>
            {note && (
              <p className="hint" role="status">
                {note}
              </p>
            )}
          </div>
        </aside>
      </div>
    </div>
  );
}

// ---- one step's controls ---------------------------------------------------

const METHODS: ResizeMethod[] = ["lanczos", "area", "cubic", "linear", "nearest"];

/** A number field that lets you type "0." on the way to 0.35: the text is
 * local state, the parsed value flows out on every valid keystroke. */
function Num({
  label,
  value,
  step: inc,
  min,
  max,
  set,
  title,
}: {
  label: string;
  value: number;
  step?: number;
  min?: number;
  max?: number;
  set: (n: number) => void;
  title?: string;
}) {
  const [text, setText] = useState(String(value));
  useEffect(() => {
    if (Number(text) !== value) setText(String(value));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [value]);
  return (
    <label className="restore-field" title={title}>
      <span>{label}</span>
      <input
        type="number"
        value={text}
        step={inc}
        min={min}
        max={max}
        onChange={(e) => {
          setText(e.target.value);
          const n = Number(e.target.value);
          if (e.target.value !== "" && Number.isFinite(n)) set(n);
        }}
        onBlur={() => setText(String(value))}
      />
    </label>
  );
}

function Check({ label, value, set, title }: { label: string; value: boolean; set: (b: boolean) => void; title?: string }) {
  return (
    <label className="restore-check" title={title}>
      <input type="checkbox" checked={value} onChange={(e) => set(e.target.checked)} />
      <span>{label}</span>
    </label>
  );
}

function StepEditor({
  step,
  index,
  count,
  models,
  adjusting,
  detecting,
  onAdjust,
  onDetect,
  onChange,
  onRemove,
  onMove,
}: {
  step: Step;
  index: number;
  count: number;
  models: ModelInfo[];
  /** autocrop only: this step's corners are on the photo right now. */
  adjusting: boolean;
  detecting: boolean;
  onAdjust: () => void;
  onDetect: () => void;
  onChange: (s: Step) => void;
  onRemove: () => void;
  onMove: (delta: -1 | 1) => void;
}) {
  let body: React.ReactNode;
  switch (step.type) {
    case "model":
      body = (
        <>
          <label className="restore-field wide">
            <span>Model</span>
            <select value={step.model} onChange={(e) => onChange({ ...step, model: e.target.value })}>
              {!models.some((m) => m.name === step.model) && <option value={step.model}>{step.model || "choose…"}</option>}
              {models.map((m) => (
                <option key={m.name} value={m.name}>
                  {m.name}
                  {m.loaded ? ` · ${m.arch}` : ""}
                </option>
              ))}
            </select>
          </label>
          <Num label="Tile" value={step.tile} step={64} min={0} set={(n) => onChange({ ...step, tile: n })} title="0 = whole image at once" />
          {/codeformer/i.test(step.model) && (
            <Num label="Fidelity w" value={step.w} step={0.1} min={0} max={1} set={(n) => onChange({ ...step, w: n })} />
          )}
          <Check label="Faces only" value={step.face} set={(b) => onChange({ ...step, face: b })} title="Run on aligned face crops and paste back" />
        </>
      );
      break;
    case "pmrf":
      body = (
        <>
          <Num label="Flow steps" value={step.steps} step={5} min={1} set={(n) => onChange({ ...step, steps: Math.max(1, Math.round(n)) })} title="Fewer = closer to the posterior mean" />
          <Num label="Seed" value={step.seed} step={1} set={(n) => onChange({ ...step, seed: Math.round(n) })} />
          <Check label="Posterior mean only" value={step.mmse} set={(b) => onChange({ ...step, mmse: b })} title="Skip the flow: the minimal-distortion SwinIR estimate" />
        </>
      );
      break;
    case "bopbtl":
      body = (
        <>
          <Check label="Scratches" value={step.scratch} set={(b) => onChange({ ...step, scratch: b })} title="Detect and inpaint scratches" />
          <Check label="Faces" value={step.faces} set={(b) => onChange({ ...step, faces: b })} title="Also run the face detection and enhancement stages (slow, CPU)" />
          <Check label="HR" value={step.hr} set={(b) => onChange({ ...step, hr: b })} title="512 px face model / patch attention for large scans" />
        </>
      );
      break;
    case "resize":
      body = (
        <>
          <Num label="Scale" value={step.scale} step={0.05} min={0.05} set={(n) => onChange({ ...step, scale: n })} />
          <label className="restore-field">
            <span>Method</span>
            <select value={step.method} onChange={(e) => onChange({ ...step, method: e.target.value as ResizeMethod })}>
              {METHODS.map((m) => (
                <option key={m}>{m}</option>
              ))}
            </select>
          </label>
        </>
      );
      break;
    case "sharpen":
      body = (
        <>
          <Num label="Amount" value={step.amount} step={0.1} set={(n) => onChange({ ...step, amount: n })} />
          <Num label="Radius" value={step.radius} step={0.5} min={0.1} set={(n) => onChange({ ...step, radius: n })} />
        </>
      );
      break;
    case "grain":
      body = (
        <>
          <Num label="Amount" value={step.amount} step={0.01} set={(n) => onChange({ ...step, amount: n })} />
          <Num label="Size" value={step.size} step={0.5} min={1} set={(n) => onChange({ ...step, size: n })} />
          <Num label="Seed" value={step.seed} step={1} set={(n) => onChange({ ...step, seed: Math.round(n) })} />
        </>
      );
      break;
    case "autocrop":
      body = (
        <>
          <div className="row" style={{ margin: 0, width: "100%" }}>
            <button onClick={onDetect} disabled={detecting} title="Find the print's edges (tools/autocrop)">
              {detecting ? "Detecting…" : "Detect corners"}
            </button>
            <button className={adjusting ? "on" : ""} onClick={onAdjust} title="Drag the four corners on the photo">
              {adjusting ? "Done adjusting" : "Adjust corners"}
            </button>
            {step.quad && (
              <button className="ghost" onClick={() => onChange({ ...step, quad: null })} title="Back to automatic detection at run time">
                Auto
              </button>
            )}
          </div>
          <Num
            label="Inset %"
            value={Math.round(step.inset * 1000) / 10}
            step={0.5}
            min={0}
            max={20}
            set={(n) => onChange({ ...step, inset: Math.max(0, Math.min(0.2, n / 100)) })}
            title="Trim this much from each edge after straightening (hides a sliver of background)"
          />
          <label className="restore-field" title="Turn the cropped print">
            <span>Turn</span>
            <button className="ghost" onClick={() => onChange({ ...step, rotate: ((step.rotate + 3) % 4) as 0 | 1 | 2 | 3 })} aria-label="Rotate left">
              ↺
            </button>
            <span>{step.rotate * 90}°</span>
            <button className="ghost" onClick={() => onChange({ ...step, rotate: ((step.rotate + 1) % 4) as 0 | 1 | 2 | 3 })} aria-label="Rotate right">
              ↻
            </button>
          </label>
          <p className="hint" style={{ width: "100%", margin: 0 }}>
            {step.quad ? "Corners set by hand." : "Corners are found automatically when you run."}
          </p>
        </>
      );
      break;
    case "cmd":
      body = (
        <label className="restore-field wide" title="{in} {out} {tmp} are substituted">
          <span>Command</span>
          <input type="text" value={step.cmd} onChange={(e) => onChange({ ...step, cmd: e.target.value })} spellCheck={false} />
        </label>
      );
      break;
  }

  return (
    <div className="restore-step">
      <div className="restore-step-head">
        <span className="restore-step-n">{index + 1}</span>
        <span className="restore-step-title" title={STEP_NAMES[step.type]}>
          {stepLabel(step)}
        </span>
        <button className="ghost" onClick={() => onMove(-1)} disabled={index === 0} title="Move up" aria-label="Move step up">
          ↑
        </button>
        <button className="ghost" onClick={() => onMove(1)} disabled={index === count - 1} title="Move down" aria-label="Move step down">
          ↓
        </button>
        <button className="ghost" onClick={onRemove} title="Remove step" aria-label="Remove step">
          ×
        </button>
      </div>
      <div className="restore-step-body">{body}</div>
      {step.type !== "autocrop" && (
      <label className="restore-field restore-blend">
        <span>Blend {Math.round(step.blend * 100)}%</span>
        <input
          type="range"
          min={0}
          max={1}
          step={0.05}
          value={step.blend}
          onChange={(e) => onChange({ ...step, blend: Number(e.target.value) })}
          title="How much of this step's output to keep over its input"
        />
      </label>
      )}
    </div>
  );
}

