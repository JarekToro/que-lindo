import { useEffect, useState } from "react";
import type { CSSProperties } from "react";
import { open } from "@tauri-apps/plugin-dialog";
import { checkFfmpeg, detectFocus, loadProject, mediaThumb, onFileDrop, probeMedia, startupProject } from "./api";
import ExportDialog from "./components/ExportDialog";
import Inspector from "./components/Inspector";
import Preview from "./components/Preview";
import Splitter from "./components/Splitter";
import Timeline from "./components/Timeline";
import TopBar from "./components/TopBar";
import { slideForMedia } from "./presets";
import { useEditor } from "./store";
import type { FfmpegStatus, ImportedMedia, Project } from "./types";

export const MEDIA_EXTENSIONS = {
  visual: ["jpg", "jpeg", "png", "gif", "webp", "bmp", "tif", "tiff", "mp4", "mov", "m4v", "mkv", "avi", "webm"],
  audio: ["mp3", "m4a", "aac", "wav", "flac", "ogg"],
};

/** Every media file a project references (for seeding the shelf on open). */
export function projectMediaPaths(p: Project): string[] {
  const out = new Set<string>();
  for (const s of p.slides)
    for (const c of s.cells)
      if (c.source.type === "image" || c.source.type === "video") out.add(c.source.path);
  for (const a of p.audio) out.add(a.path);
  return [...out];
}

const PROBE_CONCURRENCY = 4;

/**
 * Progressive import: placeholder entries land immediately, then fill in per
 * file — metadata first, thumbnail behind it. Probing runs on a bounded
 * worker pool so 300 files don't mean 300 sequential ffmpeg spawns.
 * Resolves with the successfully imported items in the order given.
 */
export async function importFiles(paths: string[]): Promise<ImportedMedia[]> {
  const state = useEditor.getState();
  const present = new Set(state.media.filter((m) => m.status !== "error").map((m) => m.path));
  const fresh = [...new Set(paths)].filter((p) => !present.has(p));
  if (!fresh.length) return [];
  state.beginImport(fresh);

  const done: (ImportedMedia | null)[] = fresh.map(() => null);
  let next = 0;
  const worker = async () => {
    while (next < fresh.length) {
      const slot = next++;
      const path = fresh[slot];
      try {
        const probed = await probeMedia(path);
        useEditor.getState().finishImport(path, { info: probed.info });
        const thumb = await mediaThumb(probed);
        // Aim zoom defaults at faces; failures just mean a centered zoom.
        const det = probed.info.is_image ? await detectFocus(path).catch(() => null) : null;
        const focus = det?.point ?? null;
        const focusRect = det?.region ?? null;
        useEditor.getState().setThumb(path, thumb, focus, focusRect);
        done[slot] = { ...probed, thumb, focus, focusRect };
      } catch (e) {
        console.error("import failed", path, e);
        useEditor.getState().finishImport(path, { error: String(e) });
      }
    }
  };
  const workers = Math.min(PROBE_CONCURRENCY, fresh.length);
  await Promise.all(Array.from({ length: workers }, () => worker()));
  return done.filter((m): m is ImportedMedia => m !== null);
}

/**
 * Import straight into Arrange: every photo and clip becomes a slide, in the
 * order dropped, as one undo step. Audio (and anything that fails) stays on
 * the "Not used" shelf for an explicit decision.
 */
export async function importIntoTimeline(paths: string[]): Promise<void> {
  const items = await importFiles(paths);
  const visual = items.filter((m) => m.info.is_image || m.info.has_video);
  if (!visual.length) return;
  useEditor.getState().mutate((p) => ({
    ...p,
    slides: [...p.slides, ...visual.map(slideForMedia)],
  }));
}

export default function App() {
  const [ffmpeg, setFfmpeg] = useState<FfmpegStatus | null>(null);
  const [exporting, setExporting] = useState(false);
  const undo = useEditor((s) => s.undo);
  const redo = useEditor((s) => s.redo);
  const playing = useEditor((s) => s.playing);
  const setPlaying = useEditor((s) => s.setPlaying);
  const selectSlide = useEditor((s) => s.selectSlide);
  const selectedSlide = useEditor((s) => s.selectedSlide);

  const replaceProject = useEditor((s) => s.replaceProject);

  useEffect(() => {
    checkFfmpeg().then(setFfmpeg).catch(console.error);
    // A project file passed on the command line opens on launch.
    startupProject()
      .then(async (path) => {
        if (!path) return;
        const p = await loadProject(path);
        replaceProject(p, { path });
        void importFiles(projectMediaPaths(p));
      })
      .catch(console.error);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // OS file drops go straight into Arrange: photos and clips become slides.
  useEffect(() => {
    const un = onFileDrop((paths) => {
      void importIntoTimeline(paths);
    });
    return () => {
      un.then((f) => f());
    };
  }, []);

  // Self-healing thumbnails: whatever path a project arrived by (Open, the
  // command line, crash recovery), any referenced media the bin doesn't know
  // yet gets probed and thumbed. importFiles no-ops when nothing is missing.
  const project = useEditor((s) => s.project);
  useEffect(() => {
    const known = new Set(useEditor.getState().media.map((m) => m.path));
    const missing = projectMediaPaths(project).filter((p) => !known.has(p));
    if (missing.length) void importFiles(missing);
  }, [project]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement;
      const typing = ["INPUT", "TEXTAREA", "SELECT"].includes(target.tagName) || target.isContentEditable;
      const mod = e.metaKey || e.ctrlKey;
      if (mod && e.key.toLowerCase() === "z") {
        e.preventDefault();
        e.shiftKey ? redo() : undo();
        return;
      }
      if (typing) return;
      if (e.key === " ") {
        e.preventDefault();
        setPlaying(!playing);
        return;
      }
      // The timeline owns arrows (and more) while focus is inside it.
      if (target.closest?.(".timeline")) return;
      if (e.key === "ArrowLeft") {
        selectSlide(selectedSlide - 1);
      } else if (e.key === "ArrowRight") {
        selectSlide(selectedSlide + 1);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [undo, redo, playing, setPlaying, selectSlide, selectedSlide]);

  const importMedia = async () => {
    const picked = await open({
      multiple: true,
      title: "Import photos, videos and music",
      filters: [
        { name: "Media", extensions: [...MEDIA_EXTENSIONS.visual, ...MEDIA_EXTENSIONS.audio] },
      ],
    });
    if (!picked) return;
    void importIntoTimeline(Array.isArray(picked) ? picked : [picked]);
  };

  const ui = useEditor((s) => s.ui);
  const setUi = useEditor((s) => s.setUi);
  const dock = ui.dock;

  const timelineSplitter = (
    <Splitter
      axis={dock === "bottom" || dock === "split" ? "y" : "x"}
      // Bottom: dragging up grows the panel. Left: dragging right grows it.
      sign={dock === "left" ? 1 : -1}
      value={ui.timelineSize}
      min={dock === "bottom" || dock === "split" ? 140 : 220}
      max={dock === "bottom" || dock === "split" ? 560 : 720}
      onChange={(v) => setUi({ timelineSize: v })}
      label="Resize timeline panel"
    />
  );

  const arrangeSplitter = (
    <Splitter
      axis="x"
      sign={1}
      value={ui.arrangeWidth}
      min={220}
      max={640}
      onChange={(v) => setUi({ arrangeWidth: v })}
      label="Resize Arrange panel"
    />
  );

  const workspace = (
    <div className="workspace">
      <Preview />
      <Splitter
        axis="x"
        sign={-1}
        value={ui.inspectorWidth}
        min={220}
        max={480}
        onChange={(v) => setUi({ inspectorWidth: v })}
        label="Resize inspector panel"
      />
      <Inspector />
    </div>
  );

  return (
    <div
      className={`app dock-${dock}`}
      style={
        {
          "--inspector-w": `${ui.inspectorWidth}px`,
          "--timeline-size": `${ui.timelineSize}px`,
          "--arrange-w": `${ui.arrangeWidth}px`,
        } as CSSProperties
      }
    >
      <TopBar ffmpeg={ffmpeg} onExport={() => setExporting(true)} />
      <div className={`shell shell-${dock}`}>
        {dock === "split" ? (
          <>
            {ui.arrangeCollapsed ? (
              <button
                className="panel-rail rail-side"
                title="Show the Arrange panel"
                onClick={() => setUi({ arrangeCollapsed: false })}
              >
                Arrange
              </button>
            ) : (
              <>
                <Timeline onImport={importMedia} face="arrange" />
                {arrangeSplitter}
              </>
            )}
            <div className="shell-main">
              {workspace}
              {ui.timeCollapsed ? (
                <button
                  className="panel-rail rail-bottom"
                  title="Show the Time panel"
                  onClick={() => setUi({ timeCollapsed: false })}
                >
                  Time
                </button>
              ) : (
                <>
                  {timelineSplitter}
                  <Timeline onImport={importMedia} face="time" />
                </>
              )}
            </div>
          </>
        ) : (
          <>
            {dock === "left" && (
              <>
                <Timeline onImport={importMedia} />
                {timelineSplitter}
              </>
            )}
            {dock === "bottom" ? (
              <div className="shell-main">
                {workspace}
                {timelineSplitter}
                <Timeline onImport={importMedia} />
              </div>
            ) : (
              workspace
            )}
            {dock === "right" && (
              <>
                {timelineSplitter}
                <Timeline onImport={importMedia} />
              </>
            )}
          </>
        )}
      </div>
      {exporting && <ExportDialog onClose={() => setExporting(false)} ffmpegFound={!!ffmpeg?.found} />}
    </div>
  );
}
