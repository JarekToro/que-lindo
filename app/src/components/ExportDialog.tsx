import { useEffect, useState } from "react";
import { save } from "@tauri-apps/plugin-dialog";
import { cancelExport, exportVideo, onExportDone, onExportProgress, revealPath } from "../api";
import { useEditor } from "../store";

type Phase = "setup" | "running" | "done" | "failed";

export default function ExportDialog({
  onClose,
  ffmpegFound,
}: {
  onClose: () => void;
  ffmpegFound: boolean;
}) {
  const project = useEditor((s) => s.project);
  const timing = useEditor((s) => s.timing);
  const [scale, setScale] = useState(1);
  const [crf, setCrf] = useState(19);
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
  const w = Math.round(project.settings.width * scale) & ~1;
  const h = Math.round(project.settings.height * scale) & ~1;

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
              {project.slides.length} slides · {(timing?.total ?? 0).toFixed(1)}s · output {w}×{h} @{" "}
              {project.settings.fps} fps
            </p>
            <label className="field">
              <span>Resolution</span>
              <select value={scale} onChange={(e) => setScale(parseFloat(e.target.value))}>
                <option value={1}>Full ({project.settings.width}×{project.settings.height})</option>
                <option value={0.6667}>⅔</option>
                <option value={0.5}>Half</option>
              </select>
            </label>
            <label className="field">
              <span>Quality (CRF {crf})</span>
              <input
                type="range"
                min={16}
                max={30}
                value={crf}
                onChange={(e) => setCrf(parseInt(e.target.value, 10))}
              />
            </label>
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
