import { useEffect, useRef, useState } from "react";
import { isSuperseded, renderPreview } from "../api";
import { ensureAudioCtx, mixForRev } from "../mixcache";
import { slideAt, useEditor } from "../store";

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
  const project = useEditor((s) => s.project);

  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const [hasFrame, setHasFrame] = useState(false);
  const inFlight = useRef(false);
  const wanted = useRef({ time: 0, rev: 0 });
  const served = useRef({ time: -1, rev: -1 });

  const scale = project.settings.width > 2000 ? 0.33 : 0.5;

  // Fetch the newest wanted frame, one request in flight at a time.
  const pump = async () => {
    if (inFlight.current) return;
    inFlight.current = true;
    try {
      let failures = 0;
      while (
        served.current.time !== wanted.current.time ||
        served.current.rev !== wanted.current.rev
      ) {
        const target = { ...wanted.current };
        try {
          const frame = await renderPreview(target.time, scale);
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

  useEffect(() => {
    wanted.current = { time, rev };
    void pump();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [time, rev, scale]);

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

  return (
    <main className="preview">
      <div className="preview-stage">
        <canvas ref={canvasRef} aria-label="preview" hidden={!hasFrame} />
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
