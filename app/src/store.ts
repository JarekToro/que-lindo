import { create } from "zustand";
import { setProjectBackend } from "./api";
import { emptyProject } from "./presets";
import type { MediaInfo, MediaItem, Project, Slide, Timing } from "./types";

const UNDO_LIMIT = 100;
const UI_PREFS_KEY = "slideshow-ui-prefs";

/** Where the timeline lives: one docked panel, or split into two (Arrange on
 * the left, Time at the bottom). */
export type Dock = "bottom" | "left" | "right" | "split";

export interface UiPrefs {
  dock: Dock;
  /** Timeline panel size: height when docked bottom, width when docked aside.
   * In split view, the Time panel's height. */
  timelineSize: number;
  inspectorWidth: number;
  /** Split view: the Arrange panel's width. */
  arrangeWidth: number;
  /** Split view: panels hidden independently. */
  arrangeCollapsed: boolean;
  timeCollapsed: boolean;
}

const DEFAULT_UI: UiPrefs = {
  dock: "split",
  timelineSize: 260,
  inspectorWidth: 300,
  arrangeWidth: 340,
  arrangeCollapsed: false,
  timeCollapsed: false,
};

function loadUiPrefs(): UiPrefs {
  try {
    const raw = localStorage.getItem(UI_PREFS_KEY);
    if (!raw) return DEFAULT_UI;
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object") return DEFAULT_UI;
    const p = parsed as Partial<UiPrefs>;
    const docks: Dock[] = ["bottom", "left", "right", "split"];
    return {
      dock: docks.includes(p.dock as Dock) ? (p.dock as Dock) : DEFAULT_UI.dock,
      timelineSize: typeof p.timelineSize === "number" ? p.timelineSize : DEFAULT_UI.timelineSize,
      inspectorWidth:
        typeof p.inspectorWidth === "number" ? p.inspectorWidth : DEFAULT_UI.inspectorWidth,
      arrangeWidth: typeof p.arrangeWidth === "number" ? p.arrangeWidth : DEFAULT_UI.arrangeWidth,
      arrangeCollapsed: p.arrangeCollapsed === true,
      timeCollapsed: p.timeCollapsed === true,
    };
  } catch {
    return DEFAULT_UI;
  }
}

function saveUiPrefs(ui: UiPrefs) {
  try {
    localStorage.setItem(UI_PREFS_KEY, JSON.stringify(ui));
  } catch {
    // Storage unavailable — prefs simply don't persist.
  }
}

export interface EditorState {
  project: Project;
  /** Bumped on every project mutation; cache-busts preview URLs. */
  rev: number;
  path: string | null;
  dirty: boolean;
  timing: Timing | null;

  selectedSlide: number;
  /** Multi-selection as slide ids (survives reorder); always contains the
   * anchor `selectedSlide`'s id. */
  selectedIds: string[];
  selectedCell: number | null;
  selectedText: number | null;

  media: MediaItem[];
  time: number;
  playing: boolean;
  /** Playback stops at this time (auditioning one slide); null = play out. */
  playUntil: number | null;
  /** Which face the timeline shows: space (arrange) or time. */
  mode: "arrange" | "time";
  /** Panel layout preferences (persisted per machine, not per project). */
  ui: UiPrefs;

  past: Project[];
  future: Project[];

  // actions
  replaceProject(p: Project, opts?: { path?: string | null; keepHistory?: boolean }): void;
  /** `history: false` folds the change into the previous undo step (batch
   * imports land as one gesture). */
  mutate(fn: (p: Project) => Project, opts?: { history?: boolean }): void;
  setMode(mode: "arrange" | "time"): void;
  setUi(patch: Partial<UiPrefs>): void;
  updateSlide(index: number, patch: Partial<Slide>): void;
  selectSlide(index: number, seek?: boolean): void;
  /** Replace the multi-selection (ids) and move the anchor. */
  setSelection(ids: string[], anchor: number): void;
  selectCell(index: number | null): void;
  selectText(index: number | null): void;
  beginImport(paths: string[]): void;
  finishImport(path: string, result: { info: MediaInfo } | { error: string }): void;
  setThumb(
    path: string,
    thumb: string | null,
    focus?: [number, number] | null,
    focusRect?: [number, number, number, number] | null,
  ): void;
  removeMedia(path: string): void;
  setTime(t: number): void;
  setPlaying(playing: boolean): void;
  /** Audition one slide: seek to its start and play just through its end. */
  playSlide(index: number): void;
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
  selectedIds: [],
  selectedCell: null,
  selectedText: null,
  media: [],
  time: 0,
  playing: false,
  playUntil: null,
  mode: "arrange",
  ui: loadUiPrefs(),
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

  mutate(fn, opts = {}) {
    const prev = get().project;
    const next = fn(prev);
    if (next === prev) return;
    const history = opts.history !== false;
    set({
      project: next,
      rev: get().rev + 1,
      dirty: true,
      past: history ? [...get().past.slice(-UNDO_LIMIT + 1), prev] : get().past,
      future: [],
    });
    scheduleSync(get, set);
  },

  setMode(mode) {
    set({ mode });
  },

  setUi(patch) {
    const ui = { ...get().ui, ...patch };
    set({ ui });
    saveUiPrefs(ui);
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
    const id = project.slides[clamped]?.id;
    set({
      selectedSlide: clamped,
      selectedIds: id ? [id] : [],
      selectedCell: null,
      selectedText: null,
    });
    if (seek && timing && timing.spans[clamped]) {
      // Land just past the transition-in so the selected slide itself shows.
      // The first slide's transition is the intro — it IS the slide showing,
      // so going back lands on the film's true start.
      const span = timing.spans[clamped];
      const lead = clamped === 0 ? 0 : span.transition_in + 0.05;
      set({ time: Math.min(span.start + lead, span.end - 0.05), playing: false });
    }
  },

  setSelection(ids, anchor) {
    const { project } = get();
    const clamped = Math.max(0, Math.min(anchor, project.slides.length - 1));
    set({ selectedSlide: clamped, selectedIds: ids, selectedCell: null, selectedText: null });
  },

  selectCell(index) {
    set({ selectedCell: index, selectedText: null });
  },

  selectText(index) {
    set({ selectedText: index, selectedCell: null });
  },

  beginImport(paths) {
    // A failed item re-imports as a fresh placeholder; anything else stands.
    const keep = new Set(
      get().media.filter((m) => m.status !== "error" || !paths.includes(m.path)).map((m) => m.path),
    );
    const placeholders = paths
      .filter((p) => !keep.has(p))
      .map((path): MediaItem => ({ status: "pending", path }));
    set({
      media: [...get().media.filter((m) => keep.has(m.path)), ...placeholders],
    });
  },

  finishImport(path, result) {
    // Removed mid-import → drop the result silently.
    set({
      media: get().media.map((m): MediaItem => {
        if (m.path !== path || m.status !== "pending") return m;
        return "error" in result
          ? { status: "error", path, error: result.error }
          : { status: "ready", path, info: result.info, thumb: null, focus: null, focusRect: null };
      }),
    });
  },

  setThumb(path, thumb, focus = null, focusRect = null) {
    const item = get().media.find((m) => m.path === path);
    if (!item || item.status !== "ready") {
      // The item left the bin while its thumbnail rendered.
      if (thumb) URL.revokeObjectURL(thumb);
      return;
    }
    set({
      media: get().media.map((m): MediaItem =>
        m.path === path && m.status === "ready" ? { ...m, thumb, focus, focusRect } : m,
      ),
    });
  },

  removeMedia(path) {
    for (const m of get().media)
      if (m.path === path && m.status === "ready" && m.thumb) URL.revokeObjectURL(m.thumb);
    set({ media: get().media.filter((m) => m.path !== path) });
  },

  setTime(t) {
    const total = get().timing?.total ?? 0;
    set({ time: Math.max(0, Math.min(t, Math.max(total - 0.001, 0))) });
  },

  setPlaying(playing) {
    // Any ordinary play/pause ends a one-slide audition.
    set({ playing, playUntil: null });
  },

  playSlide(index) {
    const { timing, project } = get();
    const clamped = Math.max(0, Math.min(index, project.slides.length - 1));
    const span = timing?.spans[clamped];
    if (!span) return;
    set({
      selectedSlide: clamped,
      selectedIds: project.slides[clamped] ? [project.slides[clamped].id] : [],
      time: span.start,
      playing: true,
      playUntil: span.end,
    });
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

declare global {
  interface Window {
    /** The live store, for dev tooling (MCP bridge) and crash recovery. */
    __editorStore?: typeof useEditor;
  }
}
window.__editorStore = useEditor;

/** Current slide index for a timeline position. */
export function slideAt(timing: Timing | null, t: number): number {
  if (!timing) return 0;
  let idx = 0;
  timing.spans.forEach((s, i) => {
    if (t >= s.start) idx = i;
  });
  return idx;
}
