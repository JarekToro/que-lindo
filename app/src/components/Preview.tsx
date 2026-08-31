import { useEffect, useRef, useState } from "react";
import { previewUrl } from "../api";
import { slideAt, useEditor } from "../store";

const PLAYBACK_FPS = 12;

/** Scrubbable preview backed by the preview:// protocol (real compositor). */
export default function Preview() {
  const time = useEditor((s) => s.time);
  const setTime = useEditor((s) => s.setTime);
  const timing = useEditor((s) => s.timing);
  const rev = useEditor((s) => s.rev);
  const playing = useEditor((s) => s.playing);
  const setPlaying = useEditor((s) => s.setPlaying);
  const selectSlide = useEditor((s) => s.selectSlide);
  const project = useEditor((s) => s.project);

  const imgRef = useRef<HTMLImageElement>(null);
  const [src, setSrc] = useState<string>("");
  const inFlight = useRef<{ time: number; rev: number } | null>(null);
  const wanted = useRef({ time: 0, rev: 0 });

  const scale = project.settings.width > 2000 ? 0.33 : 0.5;

  // Request the newest wanted frame, one request in flight at a time.
  const pump = () => {
    if (inFlight.current) return;
    inFlight.current = { ...wanted.current };
    setSrc(previewUrl(wanted.current.time, scale, wanted.current.rev));
  };

  useEffect(() => {
    wanted.current = { time, rev };
    pump();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [time, rev, scale]);

  const onLoaded = () => {
    const served = inFlight.current;
    inFlight.current = null;
    const cur = wanted.current;
    if (!served || served.time !== cur.time || served.rev !== cur.rev) {
      pump();
    }
  };

  // Playback loop (video preview only — audio plays in the export).
  useEffect(() => {
    if (!playing) return;
    const total = timing?.total ?? 0;
    const id = setInterval(() => {
      const t = useEditor.getState().time + 1 / PLAYBACK_FPS;
      if (t >= total) {
        setPlaying(false);
        setTime(total);
      } else {
        setTime(t);
      }
    }, 1000 / PLAYBACK_FPS);
    return () => clearInterval(id);
  }, [playing, timing, setPlaying, setTime]);

  const total = timing?.total ?? 0;
  const currentSlide = slideAt(timing, time);

  const fmt = (t: number) => {
    const m = Math.floor(t / 60);
    const s = (t % 60).toFixed(1).padStart(4, "0");
    return `${m}:${s}`;
  };

  return (
    <main className="preview">
      <div className="preview-stage">
        {src ? (
          <img ref={imgRef} src={src} onLoad={onLoaded} onError={onLoaded} alt="preview" />
        ) : (
          <div className="hint">No preview yet</div>
        )}
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
      <p className="hint center">Preview is video-only; audio is mixed into the export.</p>
    </main>
  );
}
