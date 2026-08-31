import { useEffect, useState } from "react";
import { open } from "@tauri-apps/plugin-dialog";
import { checkFfmpeg, loadProject, onFileDrop, probeMedia, startupProject } from "./api";
import ExportDialog from "./components/ExportDialog";
import Filmstrip from "./components/Filmstrip";
import Inspector from "./components/Inspector";
import MediaBin from "./components/MediaBin";
import Preview from "./components/Preview";
import TopBar from "./components/TopBar";
import { audioTrackFor, slideForMedia } from "./presets";
import { useEditor } from "./store";
import type { FfmpegStatus, ImportedMedia, Project } from "./types";

export const MEDIA_EXTENSIONS = {
  visual: ["jpg", "jpeg", "png", "gif", "webp", "bmp", "tif", "tiff", "mp4", "mov", "m4v", "mkv", "avi", "webm"],
  audio: ["mp3", "m4a", "aac", "wav", "flac", "ogg"],
};

/** Every media file a project references (for seeding the media bin). */
export function projectMediaPaths(p: Project): string[] {
  const out = new Set<string>();
  for (const s of p.slides)
    for (const c of s.cells)
      if (c.source.type === "image" || c.source.type === "video") out.add(c.source.path);
  for (const a of p.audio) out.add(a.path);
  return [...out];
}

export async function importPaths(paths: string[]): Promise<ImportedMedia[]> {
  const results: ImportedMedia[] = [];
  for (const path of paths) {
    try {
      results.push(await probeMedia(path));
    } catch (e) {
      console.error("import failed", path, e);
    }
  }
  return results;
}

export default function App() {
  const [ffmpeg, setFfmpeg] = useState<FfmpegStatus | null>(null);
  const [exporting, setExporting] = useState(false);
  const addMedia = useEditor((s) => s.addMedia);
  const mutate = useEditor((s) => s.mutate);
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
        addMedia(await importPaths(projectMediaPaths(p)));
      })
      .catch(console.error);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // OS file drops land in the media bin; audio also becomes a track offer.
  useEffect(() => {
    const un = onFileDrop(async (paths) => {
      const items = await importPaths(paths);
      addMedia(items);
    });
    return () => {
      un.then((f) => f());
    };
  }, [addMedia]);

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
      } else if (e.key === "ArrowLeft") {
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
    const items = await importPaths(Array.isArray(picked) ? picked : [picked]);
    addMedia(items);
  };

  const addAsSlide = (m: ImportedMedia) =>
    mutate((p) => ({ ...p, slides: [...p.slides, slideForMedia(m)] }));
  const addAsAudio = (m: ImportedMedia) =>
    mutate((p) => ({ ...p, audio: [...p.audio, audioTrackFor(m)] }));

  return (
    <div className="app">
      <TopBar ffmpeg={ffmpeg} onExport={() => setExporting(true)} />
      <div className="workspace">
        <MediaBin onImport={importMedia} onAddSlide={addAsSlide} onAddAudio={addAsAudio} />
        <Preview />
        <Inspector />
      </div>
      <Filmstrip />
      {exporting && <ExportDialog onClose={() => setExporting(false)} ffmpegFound={!!ffmpeg?.found} />}
    </div>
  );
}
