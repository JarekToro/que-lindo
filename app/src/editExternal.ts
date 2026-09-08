//! "Edit in <app>" — hand a photo to an external editor, then notice when it
//! comes back changed. The OS answers "which apps edit this file type" once
//! per extension (cached below); a window-focus check re-reads whatever the
//! editor actually saved: backend caches purge, thumbnail re-renders, and a
//! revision bump redraws the preview.

import { changedMedia, editApps, mediaThumb, openInApp } from "./api";
import type { EditorApp } from "./api";
import { useEditor } from "./store";

const extOf = (path: string) => {
  const dot = path.lastIndexOf(".");
  return dot < 0 ? "" : path.slice(dot + 1).toLowerCase();
};

/** Editor lists keyed by file extension — same type, same apps. */
const appsByExt = new Map<string, EditorApp[]>();
const fetching = new Set<string>();

/** Warm the cache so the context menu can build its entries synchronously. */
export function prefetchEditorApps(path: string): void {
  const ext = extOf(path);
  if (appsByExt.has(ext) || fetching.has(ext)) return;
  fetching.add(ext);
  editApps(path)
    .then((apps) => appsByExt.set(ext, apps))
    .catch((e) => {
      console.warn("edit_apps failed", path, e);
      appsByExt.set(ext, []);
    })
    .finally(() => fetching.delete(ext));
}

/** Cached editor list, or null while the first fetch is still in flight
 * (a fetch is kicked off either way). */
export function editorAppsFor(path: string): EditorApp[] | null {
  const cached = appsByExt.get(extOf(path));
  if (!cached) prefetchEditorApps(path);
  return cached ?? null;
}

/** Files handed to an external editor; every window focus re-checks them. */
const editing = new Set<string>();

export function beginExternalEdit(path: string, app: EditorApp | null): void {
  editing.add(path);
  void openInApp(path, app?.path ?? null).catch((e) => console.error("open editor failed", path, e));
}

/** A photo's bytes were rewritten from inside the app (the Restore view):
 * same refresh as coming back from an external editor. */
export async function notePhotoRewritten(path: string): Promise<void> {
  editing.add(path);
  await refreshEditedMedia();
}

/** Called when the window regains focus: re-read whatever changed on disk. */
export async function refreshEditedMedia(): Promise<void> {
  if (!editing.size) return;
  const changed = await changedMedia([...editing]).catch((): string[] => []);
  if (!changed.length) return;
  // The backend already dropped its decoded pixels; a new revision makes the
  // preview render the current frame afresh.
  useEditor.getState().refreshPreview();
  for (const path of changed) {
    const m = useEditor.getState().media.find((x) => x.path === path);
    if (m?.status !== "ready") continue;
    const thumb = await mediaThumb(m).catch(() => null);
    if (!thumb) continue; // keep the old thumbnail over a broken one
    const cur = useEditor.getState().media.find((x) => x.path === path);
    if (cur?.status === "ready" && cur.thumb) URL.revokeObjectURL(cur.thumb);
    useEditor.getState().setThumb(path, thumb, m.focus, m.focusRect, m.faceCount, m.embedding, m.faces);
  }
}
