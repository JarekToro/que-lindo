import { useEffect, useMemo, useState } from "react";
import type { CSSProperties } from "react";
import { open } from "@tauri-apps/plugin-dialog";
import {
  checkFfmpeg,
  detectFocus,
  embedMedia,
  faceEmbeddings,
  loadProject,
  mediaThumb,
  missingPaths,
  onFileDrop,
  probeMedia,
  startupProject,
} from "./api";
import { PILE_SIZE, needsRebuildConfirm } from "./autobuild";
import { checkRecovery, useAutosave, useRecovery } from "./autosave";
import { refreshEditedMedia } from "./editExternal";
import ExportDialog from "./components/ExportDialog";
import Inspector from "./components/Inspector";
import Preview from "./components/Preview";
import RecoveryDialog from "./components/RecoveryDialog";
import RelinkDialog from "./components/RelinkDialog";
import Splitter from "./components/Splitter";
import Timeline from "./components/Timeline";
import TopBar from "./components/TopBar";
import { tracksWithMark } from "./marks";
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

declare global {
  interface Window {
    /** Test/automation handles — same instances the app uses (HMR-safe). */
  }
}

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
        useEditor.getState().finishImport(path, {
          info: probed.info,
          captured_at: probed.captured_at,
        });
        const thumb = await mediaThumb(probed);
        // Aim zoom defaults at faces; failures just mean a centered zoom.
        // A run that found nothing still counts as zero faces — that absence
        // is a grouping signal; only a failed run leaves the count unknown.
        let focus: [number, number] | null = null;
        let focusRect: [number, number, number, number] | null = null;
        let faceCount: number | null = null;
        if (probed.info.is_image) {
          try {
            const det = await detectFocus(path);
            faceCount = det?.count ?? 0;
            focus = det?.point ?? null;
            focusRect = det?.region ?? null;
          } catch {
            faceCount = null;
          }
        }
        const embedding = probed.info.is_image
          ? await embedMedia(path).catch(() => null)
          : null;
        const faces = probed.info.is_image
          ? await faceEmbeddings(path).catch((): number[][] => [])
          : [];
        useEditor
          .getState()
          .setThumb(path, thumb, focus, focusRect, faceCount, embedding, faces);
        done[slot] = { ...probed, thumb, focus, focusRect, faceCount, embedding, faces };
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
 * Import lands on the "Not used" shelf: nothing becomes a slide until it is
 * dragged into Arrange or the whole bin is built. A pile of photos into an
 * otherwise blank project still gets the one-click "Build slideshow" nudge.
 */
export async function importToShelf(paths: string[]): Promise<void> {
  // Whether there was anything to lose *before* the import decides whether
  // Arrange offers to build the whole thing afterwards.
  const wasBlank = !needsRebuildConfirm(useEditor.getState().project.slides);
  const items = await importFiles(paths);
  // A whole pile into an empty project is exactly the case one click handles.
  if (wasBlank && items.filter((m) => m.info.is_image).length >= PILE_SIZE) {
    useEditor.getState().setSuggestBuild(true);
  }
}

export default function App() {
  const [ffmpeg, setFfmpeg] = useState<FfmpegStatus | null>(null);
  const [winW, setWinW] = useState(() => window.innerWidth);
  const [exporting, setExporting] = useState(false);
  const [missing, setMissing] = useState<string[]>([]);
  const [relinking, setRelinking] = useState(false);
  const undo = useEditor((s) => s.undo);
  const redo = useEditor((s) => s.redo);
  const playing = useEditor((s) => s.playing);
  const setPlaying = useEditor((s) => s.setPlaying);
  const selectSlide = useEditor((s) => s.selectSlide);
  const selectedSlide = useEditor((s) => s.selectedSlide);

  const replaceProject = useEditor((s) => s.replaceProject);

  useEffect(() => {
    const onResize = () => setWinW(window.innerWidth);
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);

  // Coming back from an external editor ("Edit in …"): re-read whatever
  // photos changed on disk.
  useEffect(() => {
    const onFocus = () => void refreshEditedMedia();
    window.addEventListener("focus", onFocus);
    return () => window.removeEventListener("focus", onFocus);
  }, []);

  useEffect(() => {
    checkFfmpeg().then(setFfmpeg).catch(console.error);
    // A project file passed on the command line opens on launch.
    startupProject()
      .then(async (path) => {
        if (path) {
          const p = await loadProject(path);
          replaceProject(p, { path });
          void importFiles(projectMediaPaths(p));
        }
        // Whatever the session starts as, a snapshot left behind by a crash
        // belongs to it.
        await checkRecovery(path);
      })
      .catch(console.error);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // OS file drops land on the "Not used" shelf like any other import.
  useEffect(() => {
    const un = onFileDrop((paths) => {
      void importToShelf(paths);
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
    const unknown = projectMediaPaths(project).filter((p) => !known.has(p));
    if (unknown.length) void importFiles(unknown);
  }, [project]);

  // A failed import is only offered for relinking once the disk agrees the
  // file is gone — a corrupt file or a missing ffmpeg fails too, and pointing
  // at a new location would not help those. Keyed on the failed set alone (NUL
  // can't occur in a path) so thumbnails filling in don't re-stat everything.
  const media = useEditor((s) => s.media);
  const failedKey = useMemo(() => {
    const referenced = new Set(projectMediaPaths(project));
    return media
      .filter((m) => m.status === "error" && referenced.has(m.path))
      .map((m) => m.path)
      .join("\0");
  }, [media, project]);
  useEffect(() => {
    if (!failedKey) {
      setMissing([]);
      return;
    }
    let live = true;
    missingPaths(failedKey.split("\0"))
      .then((gone) => {
        if (live) setMissing(gone);
      })
      .catch(console.error);
    return () => {
      live = false;
    };
  }, [failedKey]);

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
        // Space is a focused button's own activation key — taking it here
        // would leave every button unreachable from the keyboard.
        if (target.tagName === "BUTTON") return;
        e.preventDefault();
        setPlaying(!playing);
        return;
      }
      if (e.key.toLowerCase() === "m" && !mod && !e.altKey) {
        // Catching beats is a listening job: mark wherever the playhead is,
        // whatever has focus. The mark joins the song playing under it.
        const st = useEditor.getState();
        if (!st.project.audio.length) return;
        e.preventDefault();
        st.mutate((p) => ({
          ...p,
          audio: tracksWithMark(p.audio, st.time, st.timing?.total ?? 0, st.media),
        }));
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
    void importToShelf(Array.isArray(picked) ? picked : [picked]);
  };

  useAutosave(exporting);
  const recovery = useRecovery((s) => s.offer);

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
      // The frame yields to the grid: Arrange may take everything except a
      // still-usable frame + inspector strip.
      max={Math.max(640, winW - 560)}
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
      <TopBar
        ffmpeg={ffmpeg}
        missingCount={missing.length}
        onRelink={() => setRelinking(true)}
        onExport={() => setExporting(true)}
      />
      <div className={`shell shell-${dock}`}>
        {dock === "split" ? (
          <>
            {ui.arrangeCollapsed ? (
              <button
                className="panel-rail rail-side"
                title="Show the Arrange panel"
                aria-label="Show the Arrange panel"
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
                  aria-label="Show the Time panel"
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
      {recovery && <RecoveryDialog offer={recovery} />}
      {relinking && <RelinkDialog missing={missing} onClose={() => setRelinking(false)} />}
    </div>
  );
}

