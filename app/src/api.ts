import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import type { FfmpegStatus, ProbedMedia, Project, Timing } from "./types";

export const checkFfmpeg = () => invoke<FfmpegStatus>("check_ffmpeg");
export const startupProject = () => invoke<string | null>("startup_project");
export const probeMedia = (path: string) => invoke<ProbedMedia>("probe_media", { path });

/**
 * Thumbnail for a probed file as an object URL (PNG bytes over binary IPC —
 * never base64). Returns null when the file has nothing to draw (audio) or
 * the thumbnail fails; callers show a fallback. The caller owns the URL and
 * must revoke it when the media leaves the app.
 */
export const mediaThumb = async (m: ProbedMedia): Promise<string | null> => {
  if (!m.info.is_image && !m.info.has_video) return null;
  try {
    const buf = await invoke<ArrayBuffer>("media_thumb", {
      path: m.path,
      isImage: m.info.is_image,
      duration: m.info.duration,
    });
    return URL.createObjectURL(new Blob([buf], { type: "image/png" }));
  } catch (e) {
    console.warn("thumbnail failed", m.path, e);
    return null;
  }
};
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

/** A decoded preview frame, ready to blit into a canvas. */
export interface PreviewFrame {
  width: number;
  height: number;
  pixels: Uint8ClampedArray<ArrayBuffer>;
}

/**
 * Render a preview frame (same compositor as export). Raw bytes over binary
 * IPC: 8-byte header (width u32 LE, height u32 LE) + straight-alpha RGBA.
 * `revealTexts` draws overlays at full opacity — the editing view only.
 */
export const renderPreview = async (
  time: number,
  scale: number,
  revealTexts = false,
): Promise<PreviewFrame> => {
  const buf = await invoke<ArrayBuffer>("render_preview", { time, scale, revealTexts });
  const view = new DataView(buf);
  return {
    width: view.getUint32(0, true),
    height: view.getUint32(4, true),
    pixels: new Uint8ClampedArray(buf, 8),
  };
};

/** Backend answer for a queued frame request that a newer one replaced. */
export const isSuperseded = (e: unknown): boolean => e === "superseded";

/** Face-weighted focal point of a photo, or null when nothing is detected. */
export const detectFocus = (path: string) =>
  invoke<[number, number] | null>("detect_focus", { path });

/** Sample rate / channel count of the backend's audio mix (aformat in the plan). */
const MIX_SAMPLE_RATE = 48000;
const MIX_CHANNELS = 2;

/**
 * The project's mixed audio as an AudioBuffer — rendered by the backend
 * through the same audio plan the export muxes, raw s16le stereo PCM over
 * binary IPC. The response opens with the backend's project revision (u64
 * LE): a request can race the debounced project sync, so callers compare
 * `rev` with their own and retry on a stale answer. Null buffer = the
 * project has no audible audio at that revision.
 */
export const renderAudioMix = async (
  ctx: AudioContext,
): Promise<{ rev: number; buffer: AudioBuffer | null }> => {
  const buf = await invoke<ArrayBuffer>("render_audio_mix");
  const rev = Number(new DataView(buf).getBigUint64(0, true));
  const pcm = new Int16Array(buf, 8, Math.floor((buf.byteLength - 8) / 2));
  const frames = Math.floor(pcm.length / MIX_CHANNELS);
  if (frames === 0) return { rev, buffer: null };
  const buffer = ctx.createBuffer(MIX_CHANNELS, frames, MIX_SAMPLE_RATE);
  for (let ch = 0; ch < MIX_CHANNELS; ch++) {
    const data = buffer.getChannelData(ch);
    for (let i = 0; i < frames; i++) data[i] = pcm[i * MIX_CHANNELS + ch] / 32768;
  }
  return { rev, buffer };
};

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
