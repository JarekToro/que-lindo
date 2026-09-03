import { ask, message, open, save } from "@tauri-apps/plugin-dialog";
import { clearAutosave, loadProject, saveProject } from "../api";
import { importFiles, projectMediaPaths } from "../App";
import { checkRecovery } from "../autosave";
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
  const selectSlide = useEditor((s) => s.selectSlide);
  const selectText = useEditor((s) => s.selectText);
  // Native async dialog — window.confirm blocks the webview thread and is
  // stubbed to "no" under the dev MCP bridge, which made Open look dead.
  const confirmDiscard = async () =>
    !dirty ||
    (await ask("Discard unsaved changes?", { title: "Unsaved changes", kind: "warning" }));

  const doNew = async () => {
    if (!(await confirmDiscard())) return;
    replaceProject(emptyProject(), { path: null });
  };

  const doOpen = async () => {
    if (!(await confirmDiscard())) return;
    const picked = await open({
      title: "Open project",
      filters: [{ name: "Slideshow project", extensions: ["json"] }],
    });
    if (typeof picked !== "string") return;
    try {
      const p = await loadProject(picked);
      replaceProject(p, { path: picked });
      void importFiles(projectMediaPaths(p));
      void checkRecovery(picked);
    } catch (e) {
      void message(`Could not open project:\n${e}`, { title: "Open failed", kind: "error" });
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
      // The snapshot the session was writing to is now redundant — and after
      // Save As that is the old file's (or the untitled buffer's) snapshot.
      void clearAutosave(target).catch((e: unknown) => console.warn("autosave cleanup", e));
      if (path !== target)
        void clearAutosave(path).catch((e: unknown) => console.warn("autosave cleanup", e));
    } catch (e) {
      void message(`Save failed:\n${e}`, { title: "Save failed", kind: "error" });
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
                // Placeholders instead of blocking prompts: the card lands
                // and its name opens in the panel ready to type.
                mutate((p) => ({ ...p, slides: [titleCard("", ""), ...p.slides] }));
                selectSlide(0);
                selectText(1);
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
