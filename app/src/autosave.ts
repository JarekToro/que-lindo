import { useEffect, useRef } from "react";
import { create } from "zustand";
import { autosaveInfo, writeAutosave, writeAutosaveCurrent } from "./api";
import type { AutosaveInfo } from "./api";
import { useEditor } from "./store";

/** A dirty project snapshots at most this often; edits inside the window
 * collapse into the one trailing write. */
const AUTOSAVE_INTERVAL_MS = 30_000;

export interface RecoveryOffer {
  info: AutosaveInfo;
  /** The project the snapshot belongs to; null for the untitled buffer. */
  projectPath: string | null;
}

interface RecoveryState {
  offer: RecoveryOffer | null;
  setOffer(offer: RecoveryOffer | null): void;
}

export const useRecovery = create<RecoveryState>((set) => ({
  offer: null,
  setOffer(offer) {
    set({ offer });
  },
}));

/**
 * Raise the recovery modal if `projectPath` (null = the untitled buffer) has
 * a snapshot newer than the file it shadows. Never throws: a failed check
 * just means no offer.
 */
export async function checkRecovery(projectPath: string | null): Promise<void> {
  try {
    const info = await autosaveInfo(projectPath);
    if (info) useRecovery.getState().setOffer({ info, projectPath });
  } catch (e) {
    console.warn("autosave check failed", e);
  }
}

/** "4 minutes ago" for a Unix-millisecond timestamp. */
export function relativeTime(ms: number): string {
  const seconds = Math.max(0, Math.round((Date.now() - ms) / 1000));
  if (seconds < 45) return "moments ago";
  const units: [number, string][] = [
    [60, "minute"],
    [3600, "hour"],
    [86400, "day"],
  ];
  let value = seconds / 60;
  let unit = "minute";
  for (const [size, name] of units) {
    if (seconds >= size) {
      value = seconds / size;
      unit = name;
    }
  }
  const n = Math.round(value);
  return `${n} ${unit}${n === 1 ? "" : "s"} ago`;
}

/**
 * Keeps a recovery snapshot behind the dirty project. The first edit after a
 * quiet stretch arms a timer; whatever the project looks like when it fires
 * is what lands, so an edit burst costs one write. Nothing here may interrupt
 * editing — a failed write only warns and re-arms.
 */
export function useAutosave(exporting: boolean): void {
  const rev = useEditor((s) => s.rev);
  const dirty = useEditor((s) => s.dirty);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Read at fire time, not capture time: an export that starts mid-window
  // must still push the write past itself.
  const exportingRef = useRef(exporting);
  exportingRef.current = exporting;

  useEffect(() => {
    if (!dirty || timer.current) return;
    const arm = () => {
      timer.current = setTimeout(() => {
        timer.current = null;
        const { project, path, dirty: stillDirty } = useEditor.getState();
        if (!stillDirty) return;
        // An export has the disk and ffmpeg; snapshot after it.
        if (exportingRef.current) {
          arm();
          return;
        }
        writeAutosave(path, project).catch((e: unknown) => {
          console.warn("autosave failed", e);
          arm();
        });
      }, AUTOSAVE_INTERVAL_MS);
    };
    arm();
  }, [rev, dirty]);

  useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current);
    },
    [],
  );

  useEffect(() => {
    const onUnload = () => {
      const { dirty: unsaved, path } = useEditor.getState();
      if (!unsaved) return;
      // Best effort: the window may die before this lands, so send the
      // payload-free form and don't wait on it.
      void writeAutosaveCurrent(path).catch(() => {});
    };
    window.addEventListener("beforeunload", onUnload);
    return () => window.removeEventListener("beforeunload", onUnload);
  }, []);
}
