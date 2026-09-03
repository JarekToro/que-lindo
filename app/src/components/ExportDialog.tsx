import { useEffect, useState } from "react";
import { save } from "@tauri-apps/plugin-dialog";
import { cancelExport, exportVideo, onExportDone, onExportProgress, revealPath } from "../api";
import { useEditor } from "../store";

type Phase = "setup" | "running" | "done" | "failed";

type PresetId = "keepsake" | "share" | "compact" | "custom";

const PRESETS: { id: PresetId; name: string; desc: string }[] = [
  { id: "keepsake", name: "Keepsake", desc: "Full quality, for safekeeping" },
  { id: "share", name: "Share", desc: "Great quality, easy to send" },
  { id: "compact", name: "Compact", desc: "Smaller file for email and messaging" },
  { id: "custom", name: "Custom", desc: "Choose resolution and quality" },
];

/// Rough H.264 size model, calibrated on this app's own output
/// (~2 Mbps at 1080p, CRF 19; halves every +6 CRF; scales with area).
function estimateBytes(seconds: number, w: number, h: number, crf: number): number {
  const mbps = 2.0 * Math.pow(2, (19 - crf) / 6) * Math.pow((w * h) / (1920 * 1080), 0.85);
  return (mbps / 8) * 1e6 * seconds;
}

function formatSize(bytes: number): string {
  if (bytes >= 1e9) return `≈ ${(bytes / 1e9).toFixed(1)} GB`;
  return `≈ ${Math.max(1, Math.round(bytes / 1e6))} MB`;
}

export default function ExportDialog({
  onClose,
  ffmpegFound,
}: {
  onClose: () => void;
  ffmpegFound: boolean;
}) {
  const project = useEditor((s) => s.project);
  const timing = useEditor((s) => s.timing);
  const [preset, setPreset] = useState<PresetId>("share");
  const [customScale, setCustomScale] = useState(1);
  const [customCrf, setCustomCrf] = useState(19);
  const [phase, setPhase] = useState<Phase>("setup");
  const [progress, setProgress] = useState({ done: 0, total: 1 });
  const [error, setError] = useState<string | null>(null);
  const [outPath, setOutPath] = useState<string | null>(null);

  useEffect(() => {
    const unsubs = [
      onExportProgress((p) => setProgress(p)),
      onExportDone((d) => {
        if (d.ok) {
          setPhase("done");
          setOutPath(d.path);
        } else if (d.cancelled) {
          onClose();
        } else {
          setPhase("failed");
          setError(d.error);
        }
      }),
    ];
    return () => {
      unsubs.forEach((u) => u.then((f) => f()));
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // The knobs each preset resolves to. Compact targets ~720p regardless of
  // the project's own resolution.
  const settingsFor = (id: PresetId): { scale: number; crf: number } => {
    switch (id) {
      case "keepsake":
        return { scale: 1, crf: 17 };
      case "share":
        return { scale: 1, crf: 19 };
      case "compact":
        return { scale: Math.min(1, 720 / project.settings.height), crf: 24 };
      case "custom":
        return { scale: customScale, crf: customCrf };
    }
  };

  const { scale, crf } = settingsFor(preset);

  const start = async () => {
    const picked = await save({
      title: "Export video",
      defaultPath: "slideshow.mp4",
      filters: [{ name: "MP4 video", extensions: ["mp4"] }],
    });
    if (!picked) return;
    setError(null);
    setPhase("running");
    setProgress({ done: 0, total: 1 });
    try {
      await exportVideo(project, picked, scale, crf);
    } catch (e) {
      setPhase("failed");
      setError(String(e));
    }
  };

  const pct = Math.round((progress.done / Math.max(progress.total, 1)) * 100);
  const dims = (s: number) => ({
    w: Math.round(project.settings.width * s) & ~1,
    h: Math.round(project.settings.height * s) & ~1,
  });
  const { w, h } = dims(scale);
  const duration = timing?.total ?? 0;

  return (
    <div className="modal-backdrop" onClick={() => phase !== "running" && onClose()}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <h2>Export video</h2>
        {phase === "setup" && (
          <>
            {!ffmpegFound && (
              <p className="warn">
                ffmpeg was not found — install it on your PATH or run scripts/fetch-ffmpeg, then
                restart the app.
              </p>
            )}
            <p className="hint">
              {project.slides.length} slide{project.slides.length === 1 ? "" : "s"} ·{" "}
              {duration.toFixed(1)}s · output {w}×{h} @ {project.settings.fps} fps
            </p>
            <div className="preset-list" role="radiogroup" aria-label="Export preset">
              {PRESETS.map((p) => {
                const s = settingsFor(p.id);
                const d = dims(s.scale);
                return (
                  <button
                    key={p.id}
                    role="radio"
                    aria-checked={preset === p.id}
                    className={`preset${preset === p.id ? " selected" : ""}`}
                    onClick={() => setPreset(p.id)}
                  >
                    <span className="preset-text">
                      <span className="preset-name">{p.name}</span>
                      <span className="preset-desc">{p.desc}</span>
                    </span>
                    <span className="preset-size">
                      {formatSize(estimateBytes(duration, d.w, d.h, s.crf))}
                    </span>
                  </button>
                );
              })}
            </div>
            {preset === "custom" && (
              <div className="preset-custom">
                <label className="field">
                  <span>Resolution</span>
                  <select
                    value={customScale}
                    onChange={(e) => setCustomScale(parseFloat(e.target.value))}
                  >
                    <option value={1}>
                      Full ({project.settings.width}×{project.settings.height})
                    </option>
                    <option value={0.6667}>⅔</option>
                    <option value={0.5}>Half</option>
                  </select>
                </label>
                <label className="field">
                  <span>Quality (CRF {customCrf})</span>
                  <input
                    type="range"
                    min={16}
                    max={30}
                    value={customCrf}
                    onChange={(e) => setCustomCrf(parseInt(e.target.value, 10))}
                  />
                </label>
              </div>
            )}
            <div className="row right">
              <button onClick={onClose}>Cancel</button>
              <button className="primary" onClick={start} disabled={!ffmpegFound}>
                Choose file & export
              </button>
            </div>
          </>
        )}
        {phase === "running" && (
          <>
            <progress value={progress.done} max={progress.total} />
            <p className="hint center">
              frame {progress.done} / {progress.total} ({pct}%)
            </p>
            <div className="row right">
              <button onClick={() => cancelExport()}>Cancel export</button>
            </div>
          </>
        )}
        {phase === "done" && (
          <>
            <p>✅ Export finished.</p>
            <div className="row right">
              {outPath && <button onClick={() => revealPath(outPath)}>Show in folder</button>}
              <button className="primary" onClick={onClose}>
                Close
              </button>
            </div>
          </>
        )}
        {phase === "failed" && (
          <>
            <p className="warn">Export failed:</p>
            <pre className="error-box">{error}</pre>
            <div className="row right">
              <button onClick={() => setPhase("setup")}>Back</button>
              <button className="primary" onClick={onClose}>
                Close
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
