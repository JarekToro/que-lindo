import { create } from "zustand";
import { setProjectBackend } from "./api";
import { emptyProject } from "./presets";
import type { ImportedMedia, Project, Slide, Timing } from "./types";

const UNDO_LIMIT = 100;

export interface EditorState {
  project: Project;
  /** Bumped on every project mutation; cache-busts preview URLs. */
  rev: number;
  path: string | null;
  dirty: boolean;
  timing: Timing | null;

  selectedSlide: number;
  selectedCell: number | null;
  selectedText: number | null;

  media: ImportedMedia[];
  time: number;
  playing: boolean;

  past: Project[];
  future: Project[];

  // actions
  replaceProject(p: Project, opts?: { path?: string | null; keepHistory?: boolean }): void;
  mutate(fn: (p: Project) => Project): void;
  updateSlide(index: number, patch: Partial<Slide>): void;
  selectSlide(index: number, seek?: boolean): void;
  selectCell(index: number | null): void;
  selectText(index: number | null): void;
  addMedia(items: ImportedMedia[]): void;
  removeMedia(path: string): void;
  setTime(t: number): void;
  setPlaying(playing: boolean): void;
  setPath(path: string | null): void;
  markSaved(): void;
  undo(): void;
  redo(): void;
}

let syncTimer: ReturnType<typeof setTimeout> | null = null;

/** Debounced push of the project to the Rust side (preview + timing). */
function scheduleSync(get: () => EditorState, set: (p: Partial<EditorState>) => void) {
  if (syncTimer) clearTimeout(syncTimer);
  syncTimer = setTimeout(async () => {
    const { project, rev } = get();
    try {
      const timing = await setProjectBackend(project, rev);
      // Only accept timing for the latest revision.
      if (get().rev === rev) set({ timing });
    } catch (e) {
      console.error("set_project failed", e);
    }
  }, 120);
}

export const useEditor = create<EditorState>((set, get) => ({
  project: emptyProject(),
  rev: 0,
  path: null,
  dirty: false,
  timing: null,
  selectedSlide: 0,
  selectedCell: null,
  selectedText: null,
  media: [],
  time: 0,
  playing: false,
  past: [],
  future: [],

  replaceProject(p, opts = {}) {
    set({
      project: p,
      rev: get().rev + 1,
      path: opts.path !== undefined ? opts.path : get().path,
      dirty: false,
      past: opts.keepHistory ? get().past : [],
      future: [],
      selectedSlide: 0,
      selectedCell: null,
      selectedText: null,
      time: 0,
      playing: false,
    });
    scheduleSync(get, set);
  },

  mutate(fn) {
    const prev = get().project;
    const next = fn(prev);
    if (next === prev) return;
    set({
      project: next,
      rev: get().rev + 1,
      dirty: true,
      past: [...get().past.slice(-UNDO_LIMIT + 1), prev],
      future: [],
    });
    scheduleSync(get, set);
  },

  updateSlide(index, patch) {
    get().mutate((p) => ({
      ...p,
      slides: p.slides.map((s, i) => (i === index ? { ...s, ...patch } : s)),
    }));
  },

  selectSlide(index, seek = true) {
    const { timing, project } = get();
    const clamped = Math.max(0, Math.min(index, project.slides.length - 1));
    set({ selectedSlide: clamped, selectedCell: null, selectedText: null });
    if (seek && timing && timing.spans[clamped]) {
      // Land just past the transition-in so the selected slide itself shows.
      const span = timing.spans[clamped];
      set({ time: Math.min(span.start + span.transition_in + 0.05, span.end - 0.05), playing: false });
    }
  },

  selectCell(index) {
    set({ selectedCell: index, selectedText: null });
  },

  selectText(index) {
    set({ selectedText: index, selectedCell: null });
  },

  addMedia(items) {
    const existing = new Set(get().media.map((m) => m.path));
    const fresh = items.filter((m) => !existing.has(m.path));
    if (fresh.length) set({ media: [...get().media, ...fresh] });
    // Duplicates carry thumbnails the app will never show again.
    for (const m of items) if (existing.has(m.path) && m.thumb) URL.revokeObjectURL(m.thumb);
  },

  removeMedia(path) {
    for (const m of get().media) if (m.path === path && m.thumb) URL.revokeObjectURL(m.thumb);
    set({ media: get().media.filter((m) => m.path !== path) });
  },

  setTime(t) {
    const total = get().timing?.total ?? 0;
    set({ time: Math.max(0, Math.min(t, Math.max(total - 0.001, 0))) });
  },

  setPlaying(playing) {
    set({ playing });
  },

  setPath(path) {
    set({ path });
  },

  markSaved() {
    set({ dirty: false });
  },

  undo() {
    const { past, project, future } = get();
    if (!past.length) return;
    const prev = past[past.length - 1];
    set({
      project: prev,
      rev: get().rev + 1,
      dirty: true,
      past: past.slice(0, -1),
      future: [project, ...future].slice(0, UNDO_LIMIT),
    });
    scheduleSync(get, set);
  },

  redo() {
    const { future, project, past } = get();
    if (!future.length) return;
    const next = future[0];
    set({
      project: next,
      rev: get().rev + 1,
      dirty: true,
      past: [...past, project].slice(-UNDO_LIMIT),
      future: future.slice(1),
    });
    scheduleSync(get, set);
  },
}));

// Post the initial project so the first preview request doesn't race an
// empty backend (it would retry for seconds, then give up until an edit).
scheduleSync(useEditor.getState, useEditor.setState);

/** Current slide index for a timeline position. */
export function slideAt(timing: Timing | null, t: number): number {
  if (!timing) return 0;
  let idx = 0;
  timing.spans.forEach((s, i) => {
    if (t >= s.start) idx = i;
  });
  return idx;
}
