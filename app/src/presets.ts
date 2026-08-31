// Factories and memorial-oriented presets. These stamp out plain model
// objects — nothing here is special-cased in the renderer.

import type {
  AudioTrack,
  Cell,
  ImportedMedia,
  Layout,
  MediaInfo,
  Motion,
  Project,
  Slide,
  TextOverlay,
  Transition,
} from "./types";

let counter = 0;
export const freshId = (prefix: string) => `${prefix}-${Date.now().toString(36)}-${counter++}`;

export const GENTLE_CROSSFADE: Transition = { kind: { type: "cross_fade" }, duration: 1.2 };

export function defaultText(partial: Partial<TextOverlay> = {}): TextOverlay {
  return {
    text: "",
    role: "caption",
    font: null,
    weight: 400,
    italic: false,
    size: 0.045,
    color: "#ffffff",
    align: "center",
    anchor: "bottom_center",
    offset: [0, -0.06],
    max_width: 0.85,
    line_height: 1.25,
    shadow: true,
    box_color: null,
    start: 0,
    end: null,
    fade: 0.35,
    ...partial,
  };
}

export function defaultSlide(partial: Partial<Slide> = {}): Slide {
  return {
    id: freshId("slide"),
    duration: 5,
    layout: { type: "single" },
    margin: 0,
    gutter: 0.02,
    cells: [],
    texts: [],
    transition: { ...GENTLE_CROSSFADE },
    background: { type: "default" },
    ...partial,
  };
}

/** Alternate slow zoom in/out so consecutive photos don't move identically. */
export function autoMotion(index: number): Motion {
  return index % 2 === 0
    ? { type: "zoom", from: 1.0, to: 1.12, origin: [0.5, 0.5] }
    : { type: "zoom", from: 1.12, to: 1.0, origin: [0.5, 0.5] };
}

export function cellFor(media: ImportedMedia, index = 0): Cell {
  const source = media.info.is_image
    ? ({ type: "image", path: media.path } as const)
    : ({ type: "video", path: media.path, start: 0, mute: true } as const);
  return {
    source,
    fit: "cover",
    motion: media.info.is_image ? autoMotion(index) : { type: "none" },
    corner_radius: 0,
    border: null,
  };
}

export function slideForMedia(media: ImportedMedia): Slide {
  const portrait = media.info.height > media.info.width;
  const slide = defaultSlide({
    duration: media.info.is_image ? 5 : Math.min(Math.max(media.info.duration, 2), 12),
    cells: [cellFor(media)],
  });
  if (portrait && media.info.is_image) {
    // Portrait photo over its own blur, letterboxed.
    slide.margin = 0.05;
    slide.cells[0].fit = "contain";
    slide.cells[0].motion = { type: "none" };
    slide.background = { type: "blur", cell: 0, sigma: 0.02, dim: 0.35 };
  }
  return slide;
}

/** Anchor name → its (x, y) point as frame fractions (mirrors Anchor::point
 * in model.rs; the renderer aligns the text box to this point). */
export const ANCHOR_POINTS: Record<string, [number, number]> = {
  top_left: [0, 0],
  top_center: [0.5, 0],
  top_right: [1, 0],
  center_left: [0, 0.5],
  center: [0.5, 0.5],
  center_right: [1, 0.5],
  bottom_left: [0, 1],
  bottom_center: [0.5, 1],
  bottom_right: [1, 1],
};

// ---- grouping (a group is just a Slide with more than one cell) ----

/** Most photos a group holds; past this a drop refuses to bind. */
export const GROUP_MAX = 8;

/** The composed layout the product chooses for an n-photo group. The user can
 * still change it per slide — this is a default, not a rule. */
export function autoLayout(n: number): Layout {
  if (n <= 1) return { type: "single" };
  if (n === 2) return { type: "columns", weights: [] };
  if (n === 3) return { type: "featured", side: "left", ratio: 0.62 };
  if (n === 4) return { type: "grid", rows: 2, cols: 2 };
  if (n <= 6) return { type: "grid", rows: 2, cols: 3 };
  return { type: "grid", rows: 2, cols: 4 };
}

/** Merge `source`'s members into `target` — the bind gesture. Photos join
 * the collage, titles join the slide's text layer; target keeps its
 * identity, duration and transition. */
export function bindSlides(target: Slide, source: Slide): Slide {
  const cells = [...target.cells, ...source.cells].map(
    (c): Cell => ({ ...c, fit: "cover", motion: { type: "none" } }),
  );
  return {
    ...target,
    cells,
    texts: [...target.texts, ...source.texts],
    layout: autoLayout(cells.length),
    margin: cells.length > 1 ? 0.04 : target.margin,
    gutter: 0.02,
    background: cells.length > 1 ? { type: "default" } : target.background,
  };
}

/** A slide member: a photo/video cell, or a title/caption text. Groups are
 * made of members — photos, videos, titles alike. */
export type Member = { type: "cell"; index: number } | { type: "text"; index: number };

export function membersOf(s: Slide): Member[] {
  return [
    ...s.cells.map((_, index): Member => ({ type: "cell", index })),
    ...s.texts.map((_, index): Member => ({ type: "text", index })),
  ];
}

/** A slide carrying one text lifted out of a group — the text counterpart of
 * `slideForCell`. */
export function slideForText(text: TextOverlay): Slide {
  return defaultSlide({ texts: [{ ...text }] });
}

/** A single-photo slide for a cell lifted out of a group — the inverse of
 * bind. `info` (when the media is still in the bin) restores the portrait
 * and motion treatment `slideForMedia` would have chosen. */
export function slideForCell(cell: Cell, info?: MediaInfo): Slide {
  const portrait = info ? info.height > info.width && info.is_image : false;
  const isImage = cell.source.type === "image";
  const slide = defaultSlide({
    duration: info && !info.is_image ? Math.min(Math.max(info.duration, 2), 12) : 5,
    cells: [
      {
        ...cell,
        fit: portrait ? "contain" : "cover",
        motion: isImage && !portrait ? autoMotion(0) : { type: "none" },
      },
    ],
  });
  if (portrait) {
    slide.margin = 0.05;
    slide.background = { type: "blur", cell: 0, sigma: 0.02, dim: 0.35 };
  }
  return slide;
}

/** A group that shrank to one member stops being a group: the survivor
 * becomes an ordinary single slide in place. */
export function dissolveGroup(slide: Slide, info?: MediaInfo): Slide {
  const single = slideForCell(slide.cells[0], info);
  return {
    ...single,
    id: slide.id,
    duration: slide.duration,
    texts: slide.texts,
    transition: slide.transition,
  };
}

export function audioTrackFor(media: ImportedMedia): AudioTrack {
  return {
    path: media.path,
    start: 0,
    offset: 0,
    duration: null,
    gain_db: -3,
    fade_in: 1.5,
    fade_out: 3,
    loop: true,
  };
}

// ---- memorial presets ----

export function titleCard(name: string, dates: string): Slide {
  return defaultSlide({
    id: freshId("title"),
    duration: 5,
    transition: { kind: { type: "fade_black" }, duration: 1.5 },
    texts: [
      defaultText({
        text: "In Loving Memory",
        role: "title",
        size: 0.11,
        anchor: "center",
        offset: [0, -0.08],
        fade: 0.9,
      }),
      defaultText({
        text: name || "A Life Remembered",
        role: "subtitle",
        italic: true,
        size: 0.06,
        anchor: "center",
        offset: [0, 0.05],
        start: 0.6,
        fade: 0.9,
      }),
      defaultText({
        text: dates,
        role: "subtitle",
        size: 0.04,
        color: "#c9c9cf",
        anchor: "center",
        offset: [0, 0.13],
        start: 1.0,
        fade: 0.9,
      }),
    ],
  });
}

export function endCard(): Slide {
  return defaultSlide({
    id: freshId("end"),
    duration: 6,
    transition: { kind: { type: "fade_black" }, duration: 2 },
    texts: [
      defaultText({
        text: "Forever in our hearts",
        role: "title",
        italic: true,
        size: 0.08,
        anchor: "center",
        offset: [0, 0],
        fade: 1.2,
      }),
    ],
  });
}

export function lowerThird(name: string, dates: string): TextOverlay[] {
  return [
    defaultText({
      text: name,
      role: "lower_third",
      size: 0.05,
      align: "left",
      anchor: "bottom_left",
      offset: [0.05, -0.13],
      fade: 0.5,
    }),
    defaultText({
      text: dates,
      role: "lower_third",
      size: 0.032,
      color: "#d8d8de",
      align: "left",
      anchor: "bottom_left",
      offset: [0.05, -0.07],
      start: 0.3,
      fade: 0.5,
    }),
  ];
}

/** Gentle memorial pacing applied across the whole project. */
export function applyMemorialTheme(project: Project): Project {
  const slides = project.slides.map((s, i) => ({
    ...s,
    duration: Math.max(s.duration, 5),
    transition: i === 0 ? s.transition : { ...GENTLE_CROSSFADE },
    cells: s.cells.map((c, ci) =>
      c.source.type === "image" && c.motion.type === "none" && c.fit === "cover"
        ? { ...c, motion: autoMotion(i + ci) }
        : c,
    ),
  }));
  const audio = project.audio.map((a) => ({ ...a, fade_in: Math.max(a.fade_in, 1.5), fade_out: Math.max(a.fade_out, 3) }));
  return { ...project, slides, audio };
}

export function emptyProject(): Project {
  return {
    version: 1,
    settings: { width: 1920, height: 1080, fps: 30, background: "#101014" },
    slides: [titleCard("", "")],
    audio: [],
    outro: { kind: { type: "fade_black" }, duration: 1.5 },
  };
}
