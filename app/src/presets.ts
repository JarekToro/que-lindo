// Factories and memorial-oriented presets. These stamp out plain model
// objects — nothing here is special-cased in the renderer.

import type {
  AudioTrack,
  Cell,
  ImportedMedia,
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
  return index % 2 === 0 ? { type: "zoom", from: 1.0, to: 1.12 } : { type: "zoom", from: 1.12, to: 1.0 };
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
  };
}
