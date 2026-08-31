import { useEffect, useRef, useState } from "react";
import { isSuperseded, renderPreview } from "../api";
import { layoutRects } from "../layout";
import { ensureAudioCtx, mixForRev } from "../mixcache";
import { ANCHOR_POINTS } from "../presets";
import { slideAt, useEditor } from "../store";
import type { Motion, TextOverlay } from "../types";

const PLAYBACK_FPS = 12;

/** Scrubbable preview rendered by the real compositor (raw frames over binary IPC). */
export default function Preview() {
  const time = useEditor((s) => s.time);
  const setTime = useEditor((s) => s.setTime);
  const timing = useEditor((s) => s.timing);
  const rev = useEditor((s) => s.rev);
  const playing = useEditor((s) => s.playing);
  const setPlaying = useEditor((s) => s.setPlaying);
  const selectSlide = useEditor((s) => s.selectSlide);
  const selectedText = useEditor((s) => s.selectedText);
  const selectText = useEditor((s) => s.selectText);
  const project = useEditor((s) => s.project);

  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const [hasFrame, setHasFrame] = useState(false);
  const inFlight = useRef(false);
  const wanted = useRef({ time: 0, rev: 0, reveal: false });
  const served = useRef({ time: -1, rev: -1, reveal: false });

  const scale = project.settings.width > 2000 ? 0.33 : 0.5;

  // Fetch the newest wanted frame, one request in flight at a time.
  const pump = async () => {
    if (inFlight.current) return;
    inFlight.current = true;
    try {
      let failures = 0;
      while (
        served.current.time !== wanted.current.time ||
        served.current.rev !== wanted.current.rev ||
        served.current.reveal !== wanted.current.reveal
      ) {
        const target = { ...wanted.current };
        try {
          const frame = await renderPreview(target.time, scale, target.reveal);
          const canvas = canvasRef.current;
          if (canvas) {
            if (canvas.width !== frame.width) canvas.width = frame.width;
            if (canvas.height !== frame.height) canvas.height = frame.height;
            canvas
              .getContext("2d")
              ?.putImageData(new ImageData(frame.pixels, frame.width, frame.height), 0, 0);
            setHasFrame(true);
          }
          served.current = target;
          failures = 0;
        } catch (e) {
          // A newer request beat this one; loop around for the newest.
          if (isSuperseded(e)) continue;
          // Likely a startup race (project not posted yet) — retry briefly.
          if (++failures > 20) {
            console.warn("preview giving up", e);
            served.current = target;
            break;
          }
          await new Promise((r) => setTimeout(r, 300));
        }
      }
    } finally {
      inFlight.current = false;
    }
  };

  // While a text on the shown slide is being edited, the frame reveals every
  // overlay at full opacity so placement is visible before its fade-in.
  const editingText =
    !playing &&
    selectedText !== null &&
    useEditor.getState().selectedSlide === slideAt(timing, time);

  useEffect(() => {
    wanted.current = { time, rev, reveal: editingText };
    void pump();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [time, rev, scale, editingText]);

  // Playback: audio is the clock. The mix (same plan as export) plays through
  // an AudioBufferSourceNode and `time` chases audioContext.currentTime, so
  // frames follow the sound instead of a drifting setInterval. With no audio
  // the same context clock drives time — wall-clock accurate either way.
  const total = timing?.total ?? 0;
  useEffect(() => {
    if (!playing) return;
    const ctx = ensureAudioCtx();
    let cancelled = false;
    let started = false;
    let source: AudioBufferSourceNode | null = null;
    let anchorPos = 0;
    let anchorCtxTime = 0;

    const begin = async () => {
      await ctx.resume();
      let buffer: AudioBuffer | null = null;
      try {
        buffer = await mixForRev(ctx, rev);
      } catch (e) {
        console.warn("audio mix unavailable, playing silent", e);
      }
      if (cancelled) return;
      anchorPos = useEditor.getState().time;
      anchorCtxTime = ctx.currentTime;
      if (buffer && anchorPos < buffer.duration) {
        source = new AudioBufferSourceNode(ctx, { buffer });
        source.connect(ctx.destination);
        source.start(0, anchorPos);
      }
      started = true;
    };
    void begin();

    const id = setInterval(() => {
      if (!started || cancelled) return;
      const t = anchorPos + (ctx.currentTime - anchorCtxTime);
      if (t >= total) {
        setPlaying(false);
        setTime(total);
      } else {
        setTime(t);
      }
    }, 1000 / PLAYBACK_FPS);

    return () => {
      cancelled = true;
      clearInterval(id);
      if (source) {
        try {
          source.stop();
        } catch {
          // Already ended.
        }
        source.disconnect();
      }
    };
  }, [playing, rev, total, setPlaying, setTime]);

  const currentSlide = slideAt(timing, time);

  const fmt = (t: number) => {
    const m = Math.floor(t / 60);
    const s = (t % 60).toFixed(1).padStart(4, "0");
    return `${m}:${s}`;
  };

  // ---- text placement on the frame: drag a handle, the offset follows ----
  const shownSlide = project.slides[currentSlide];
  const textDrag = useRef<{
    ti: number;
    startX: number;
    startY: number;
    offset: [number, number];
    moved: boolean;
  } | null>(null);

  const mutateStore = useEditor((s) => s.mutate);
  const patchTextOffset = (ti: number, offset: [number, number], history: boolean) => {
    mutateStore(
      (p) => ({
        ...p,
        slides: p.slides.map((s, i) =>
          i === currentSlide
            ? { ...s, texts: s.texts.map((t, j) => (j === ti ? { ...t, offset } : t)) }
            : s,
        ),
      }),
      { history },
    );
  };

  const handleFor = (t: TextOverlay): { left: string; top: string; tx: string; ty: string } => {
    const [ax, ay] = ANCHOR_POINTS[t.anchor] ?? [0.5, 0.5];
    const fx = Math.min(Math.max(ax + t.offset[0], 0), 1);
    const fy = Math.min(Math.max(ay + t.offset[1], 0), 1);
    return {
      left: `${fx * 100}%`,
      top: `${fy * 100}%`,
      tx: `${-ax * 100}%`,
      ty: `${-ay * 100}%`,
    };
  };

  const beginTextDrag = (e: React.PointerEvent, ti: number) => {
    if (e.button !== 0 || !shownSlide) return;
    e.stopPropagation();
    selectSlide(currentSlide, false);
    selectText(ti);
    textDrag.current = {
      ti,
      startX: e.clientX,
      startY: e.clientY,
      offset: [...shownSlide.texts[ti].offset] as [number, number],
      moved: false,
    };
    try {
      (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    } catch {
      // Synthetic pointers have no capturable id; moves still bubble here.
    }
  };

  const moveTextDrag = (e: React.PointerEvent) => {
    const d = textDrag.current;
    const frame = overlayRef.current;
    if (!d || !frame || !(e.buttons & 1)) return;
    const r = frame.getBoundingClientRect();
    const dx = (e.clientX - d.startX) / Math.max(r.width, 1);
    const dy = (e.clientY - d.startY) / Math.max(r.height, 1);
    // First movement takes the undo snapshot; the rest of the drag coalesces.
    patchTextOffset(d.ti, [d.offset[0] + dx, d.offset[1] + dy], !d.moved);
    d.moved = true;
  };

  const endTextDrag = () => {
    textDrag.current = null;
  };

  const overlayRef = useRef<HTMLDivElement | null>(null);

  // ---- zoom focus on the frame: aim where the zoom pushes into ----
  const selectedCellIdx = useEditor((s) => s.selectedCell);
  const zoomTarget = (() => {
    if (playing || !shownSlide || selectedCellIdx === null) return null;
    if (useEditor.getState().selectedSlide !== currentSlide) return null;
    const cell = shownSlide.cells[selectedCellIdx];
    if (!cell || cell.motion.type !== "zoom") return null;
    const W = project.settings.width;
    const H = Math.max(project.settings.height, 1);
    const rects = layoutRects(
      shownSlide.layout,
      shownSlide.cells.length,
      W,
      H,
      shownSlide.margin,
      shownSlide.gutter,
    );
    const r = rects[selectedCellIdx];
    if (!r) return null;
    return {
      motion: cell.motion,
      rect: { x: r.x / W, y: r.y / H, w: r.w / W, h: r.h / H },
    };
  })();

  const zoomDrag = useRef<{ startX: number; startY: number; origin: [number, number]; moved: boolean } | null>(null);

  const patchZoomOrigin = (origin: [number, number], history: boolean) => {
    if (selectedCellIdx === null) return;
    mutateStore(
      (p) => ({
        ...p,
        slides: p.slides.map((s, i) =>
          i === currentSlide
            ? {
                ...s,
                cells: s.cells.map((c, j) =>
                  j === selectedCellIdx && c.motion.type === "zoom"
                    ? { ...c, motion: { ...(c.motion as Extract<Motion, { type: "zoom" }>), origin } }
                    : c,
                ),
              }
            : s,
        ),
      }),
      { history },
    );
  };

  const moveZoomDrag = (e: React.PointerEvent) => {
    const d = zoomDrag.current;
    const frame = overlayRef.current;
    if (!d || !frame || !(e.buttons & 1) || !zoomTarget) return;
    const r = frame.getBoundingClientRect();
    const dx = (e.clientX - d.startX) / Math.max(r.width * zoomTarget.rect.w, 1);
    const dy = (e.clientY - d.startY) / Math.max(r.height * zoomTarget.rect.h, 1);
    patchZoomOrigin(
      [Math.min(1, Math.max(0, d.origin[0] + dx)), Math.min(1, Math.max(0, d.origin[1] + dy))],
      !d.moved,
    );
    d.moved = true;
  };

  return (
    <main className="preview">
      <div className="preview-stage">
        <div className="frame-wrap">
          <canvas ref={canvasRef} aria-label="preview" hidden={!hasFrame} />
          {hasFrame && !playing && shownSlide && (shownSlide.texts.length > 0 || zoomTarget) && (
            <div className="text-layer" ref={overlayRef}>
              {zoomTarget && (
                <button
                  className="zoom-handle"
                  style={{
                    left: `${(zoomTarget.rect.x + zoomTarget.motion.origin[0] * zoomTarget.rect.w) * 100}%`,
                    top: `${(zoomTarget.rect.y + zoomTarget.motion.origin[1] * zoomTarget.rect.h) * 100}%`,
                  }}
                  title="Drag to aim the zoom"
                  onPointerDown={(e) => {
                    if (e.button !== 0) return;
                    e.stopPropagation();
                    zoomDrag.current = {
                      startX: e.clientX,
                      startY: e.clientY,
                      origin: [...zoomTarget.motion.origin] as [number, number],
                      moved: false,
                    };
                    try {
                      (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
                    } catch {
                      // Synthetic pointers have no capturable id.
                    }
                  }}
                  onPointerMove={moveZoomDrag}
                  onPointerUp={() => {
                    zoomDrag.current = null;
                  }}
                >
                  ◎
                </button>
              )}
              {shownSlide.texts.map((t, ti) => {
                const pos = handleFor(t);
                const active = selectedText === ti && currentSlide === useEditor.getState().selectedSlide;
                return (
                  <button
                    key={ti}
                    className={`text-handle ${active ? "active" : ""}`}
                    style={{
                      left: pos.left,
                      top: pos.top,
                      transform: `translate(${pos.tx}, ${pos.ty})`,
                    }}
                    title="Drag to place; click to edit in the panel"
                    onPointerDown={(e) => beginTextDrag(e, ti)}
                    onPointerMove={moveTextDrag}
                    onPointerUp={endTextDrag}
                  >
                    T
                  </button>
                );
              })}
            </div>
          )}
        </div>
        {!hasFrame && <div className="hint">No preview yet</div>}
      </div>
      <div className="transport">
        <button onClick={() => selectSlide(currentSlide - 1)} title="Previous slide">
          ⏮
        </button>
        <button className="play" onClick={() => setPlaying(!playing)}>
          {playing ? "❚❚" : "▶"}
        </button>
        <button onClick={() => selectSlide(currentSlide + 1)} title="Next slide">
          ⏭
        </button>
        <span className="time">{fmt(time)}</span>
        <input
          type="range"
          min={0}
          max={Math.max(total, 0.001)}
          step={0.05}
          value={Math.min(time, total)}
          onChange={(e) => {
            setPlaying(false);
            setTime(parseFloat(e.target.value));
          }}
        />
        <span className="time">{fmt(total)}</span>
      </div>
    </main>
  );
}
