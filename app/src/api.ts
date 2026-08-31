import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import type { FfmpegStatus, ImportedMedia, Project, Timing } from "./types";

export const checkFfmpeg = () => invoke<FfmpegStatus>("check_ffmpeg");
export const startupProject = () => invoke<string | null>("startup_project");
export const probeMedia = (path: string) => invoke<ImportedMedia>("probe_media", { path });
export const listFonts = () => invoke<string[]>("list_fonts");
export const loadProject = (path: string) => invoke<Project>("load_project", { path });
export const saveProject = (path: string, project: Project) =>
  invoke<void>("save_project", { path, project });
export const revealPath = (path: string) => invoke<void>("reveal_path", { path });
export const cancelExport = () => invoke<void>("cancel_export");
export const exportVideo = (project: Project, outPath: string, scale: number, crf: number) =>
  invoke<void>("export_video", { project, outPath, scale, crf });

export const setProjectBackend = (project: Project, rev: number) =>
  invoke<Timing>("set_project", { project, rev });

/** Render a preview frame (same compositor as export); returns a data URL. */
export const renderPreview = (time: number, scale: number) =>
  invoke<string>("render_preview", { time, scale });

export interface ExportProgress {
  done: number;
  total: number;
}
export interface ExportDone {
  ok: boolean;
  cancelled: boolean;
  error: string | null;
  path: string | null;
}

export const onExportProgress = (cb: (p: ExportProgress) => void) =>
  listen<ExportProgress>("export:progress", (e) => cb(e.payload));
export const onExportDone = (cb: (p: ExportDone) => void) =>
  listen<ExportDone>("export:done", (e) => cb(e.payload));

/** Native file drops from the OS (returns unlisten). */
export const onFileDrop = (cb: (paths: string[]) => void) =>
  listen<{ paths: string[] }>("tauri://drag-drop", (e) => cb(e.payload.paths));
