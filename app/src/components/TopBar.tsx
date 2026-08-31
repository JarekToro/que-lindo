import { open, save } from "@tauri-apps/plugin-dialog";
import { loadProject, mediaThumb, probeMedia, saveProject } from "../api";
import { projectMediaPaths } from "../App";
import { applyMemorialTheme, emptyProject, endCard, titleCard } from "../presets";
import { useEditor } from "../store";
import type { FfmpegStatus } from "../types";

const RESOLUTIONS: { label: string; w: number; h: number }[] = [
  { label: "1080p 16:9", w: 1920, h: 1080 },
  { label: "4K 16:9", w: 3840, h: 2160 },
  { label: "720p 16:9", w: 1280, h: 720 },
  { label: "Vertical 9:16", w: 1080, h: 1920 },
  { label: "Square 1:1", w: 1080, h: 1080 },
];

export default function TopBar({
  ffmpeg,
  onExport,
}: {
  ffmpeg: FfmpegStatus | null;
  onExport: () => void;
}) {
  const project = useEditor((s) => s.project);
  const path = useEditor((s) => s.path);
  const dirty = useEditor((s) => s.dirty);
  const replaceProject = useEditor((s) => s.replaceProject);
  const mutate = useEditor((s) => s.mutate);
  const setPath = useEditor((s) => s.setPath);
  const markSaved = useEditor((s) => s.markSaved);
  const addMediaList = useEditor((s) => s.addMedia);
  const addMedia1 = (m: Parameters<typeof addMediaList>[0][number]) => addMediaList([m]);

  const doNew = () => {
    if (dirty && !confirm("Discard unsaved changes?")) return;
    replaceProject(emptyProject(), { path: null });
  };

  const doOpen = async () => {
    if (dirty && !confirm("Discard unsaved changes?")) return;
    const picked = await open({
      title: "Open project",
      filters: [{ name: "Slideshow project", extensions: ["json"] }],
    });
    if (typeof picked !== "string") return;
    try {
      const p = await loadProject(picked);
      replaceProject(p, { path: picked });
      for (const mp of projectMediaPaths(p)) {
        probeMedia(mp)
          .then(async (probed) => addMedia1({ ...probed, thumb: await mediaThumb(probed) }))
          .catch(() => {});
      }
    } catch (e) {
      alert(`Could not open project:\n${e}`);
    }
  };

  const doSave = async (as: boolean) => {
    let target = path;
    if (as || !target) {
      const picked = await save({
        title: "Save project",
        defaultPath: target ?? "project.slideshow.json",
        filters: [{ name: "Slideshow project", extensions: ["json"] }],
      });
      if (!picked) return;
      target = picked;
    }
    try {
      await saveProject(target, project);
      setPath(target);
      markSaved();
    } catch (e) {
      alert(`Save failed:\n${e}`);
    }
  };

  const resValue = `${project.settings.width}x${project.settings.height}`;
  const setResolution = (value: string) => {
    const r = RESOLUTIONS.find((r) => `${r.w}x${r.h}` === value);
    if (r) mutate((p) => ({ ...p, settings: { ...p.settings, width: r.w, height: r.h } }));
  };

  const fileName = path ? path.replace(/^.*[/\\]/, "") : "Untitled";

  return (
    <header className="topbar">
      <div className="topbar-group">
        <span className="brand">Slideshow Studio</span>
        <button onClick={doNew}>New</button>
        <button onClick={doOpen}>Open…</button>
        <button onClick={() => doSave(false)}>Save</button>
        <button onClick={() => doSave(true)}>Save As…</button>
      </div>
      <div className="topbar-group topbar-title">
        {fileName}
        {dirty ? " •" : ""}
      </div>
      <div className="topbar-group">
        <select value={resValue} onChange={(e) => setResolution(e.target.value)} title="Output size">
          {RESOLUTIONS.map((r) => (
            <option key={r.label} value={`${r.w}x${r.h}`}>
              {r.label}
            </option>
          ))}
        </select>
        <div className="menu">
          <button>Presets ▾</button>
          <div className="menu-items">
            <button
              onClick={() => {
                const name = prompt("Name (for the title card):") ?? "";
                const dates = prompt("Dates (e.g. 1943 – 2026):") ?? "";
                mutate((p) => ({ ...p, slides: [titleCard(name, dates), ...p.slides] }));
              }}
            >
              Add title card (start)
            </button>
            <button onClick={() => mutate((p) => ({ ...p, slides: [...p.slides, endCard()] }))}>
              Add end card
            </button>
            <button onClick={() => mutate((p) => applyMemorialTheme(p))}>
              Apply memorial pacing
            </button>
          </div>
        </div>
        {ffmpeg && !ffmpeg.found && (
          <span className="warn" title={ffmpeg.error ?? undefined}>
            ⚠ ffmpeg missing
          </span>
        )}
        <button className="primary" onClick={onExport}>
          Export…
        </button>
      </div>
    </header>
  );
}
