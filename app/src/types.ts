// TypeScript mirror of the Rust project model (crates/slideshow-core/src/model.rs).
// Field names/serde tags must match exactly.

export interface Project {
  version: number;
  settings: Settings;
  slides: Slide[];
  audio: AudioTrack[];
  /** How the film ends: the last slide leaves into the background. */
  outro: Transition;
}

export interface Settings {
  width: number;
  height: number;
  fps: number;
  background: string; // #rrggbb[aa]
  /** Title-safe margin: anchor regions inset from the frame edges. */
  text_margin: number;
}

export type Side = "left" | "right" | "top" | "bottom";
export type Direction = "left" | "right" | "up" | "down";

export interface NormRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export type Layout =
  | { type: "single" }
  | { type: "rows"; weights: number[] }
  | { type: "columns"; weights: number[] }
  | { type: "grid"; rows: number; cols: number }
  | { type: "featured"; side: Side; ratio: number }
  | { type: "custom"; rects: NormRect[] };

export type SlideBackground =
  | { type: "default" }
  | { type: "color"; color: string }
  | { type: "blur"; cell: number; sigma: number; dim: number };

export type MediaSource =
  | { type: "image"; path: string }
  | { type: "video"; path: string; start: number; mute: boolean }
  | { type: "solid"; color: string };

export type Fit = "cover" | "contain";

export type Motion =
  | { type: "none" }
  | { type: "ken_burns"; from: NormRect; to: NormRect }
  | { type: "zoom"; from: number; to: number; origin: [number, number] };

export interface Border {
  width: number;
  color: string;
}

export interface Cell {
  source: MediaSource;
  fit: Fit;
  motion: Motion;
  corner_radius: number;
  border: Border | null;
}

export type TextRole = "title" | "subtitle" | "caption" | "lower_third" | "credit";
export type Align = "left" | "center" | "right";
export type Anchor =
  | "top_left"
  | "top_center"
  | "top_right"
  | "center_left"
  | "center"
  | "center_right"
  | "bottom_left"
  | "bottom_center"
  | "bottom_right";

export interface TextOverlay {
  text: string;
  role: TextRole;
  font: string | null;
  weight: number;
  italic: boolean;
  size: number;
  color: string;
  align: Align;
  anchor: Anchor;
  offset: [number, number];
  max_width: number;
  line_height: number;
  shadow: boolean;
  box_color: string | null;
  start: number;
  end: number | null;
  /** Fade-in seconds (also the fade-out when fade_out is null). */
  fade: number;
  /** Fade-out seconds; null = same as fade, 0 = no exit fade. */
  fade_out: number | null;
}

export type TransitionKind =
  | { type: "cut" }
  | { type: "cross_fade" }
  | { type: "fade_black" }
  | { type: "fade_white" }
  | { type: "slide"; dir: Direction }
  | { type: "wipe"; dir: Direction };

export interface Transition {
  kind: TransitionKind;
  duration: number;
}

export interface Slide {
  id: string;
  duration: number;
  layout: Layout;
  margin: number;
  gutter: number;
  cells: Cell[];
  texts: TextOverlay[];
  transition: Transition;
  background: SlideBackground;
}

export interface AudioTrack {
  path: string;
  start: number;
  offset: number;
  duration: number | null;
  gain_db: number;
  fade_in: number;
  fade_out: number;
  loop: boolean;
}

// ---- backend result types ----

export interface MediaInfo {
  width: number;
  height: number;
  duration: number;
  fps: number;
  has_video: boolean;
  has_audio: boolean;
  is_image: boolean;
  rotation: number;
}

/** What `probe_media` returns: metadata only, no pixels. */
export interface ProbedMedia {
  path: string;
  info: MediaInfo;
}

/** A probed file plus its thumbnail (object URL) and detected focal point,
 * both fetched separately after the probe. */
export interface ImportedMedia extends ProbedMedia {
  thumb: string | null;
  /** Face-weighted focal point as frame fractions; null = nothing found. */
  focus: [number, number] | null;
}

/**
 * A media-bin entry. Imports appear instantly as pending placeholders, turn
 * ready as metadata arrives (thumbnail fills in behind), or error out.
 */
export type MediaItem =
  | { status: "pending"; path: string }
  | ({ status: "ready" } & ImportedMedia)
  | { status: "error"; path: string; error: string };

export interface Timing {
  total: number;
  spans: { start: number; end: number; transition_in: number }[];
}

export interface FfmpegStatus {
  found: boolean;
  path: string | null;
  error: string | null;
}
