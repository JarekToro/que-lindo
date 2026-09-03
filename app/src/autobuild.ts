// One-click auto-build: a pile of photos becomes a finished draft. Photos
// from the same moment land on one collage, moments are ordered oldest-first
// by apparent age, and pacing, motion and transitions are already chosen —
// the user opens the result to adjust it, not to assemble it.
//
// Moment discovery lives in Rust (`slideshow_core::grouping`): an
// order-independent correlation clustering over the features the import
// pipeline caches backend-side, reached through one `groupMoments` call.
// Everything after that call is pure and deterministic — the same clusters
// always assemble the same film.

import { groupMoments } from "./api";
import { eraScore } from "./era";
import { smartScatterPatch } from "./layouts";
import { GENTLE_CROSSFADE, autoLayout, cellFor, defaultSlide } from "./presets";
import type { Cell, ImportedMedia, MediaItem, Settings, Slide, Transition } from "./types";

/** Most photos one auto-built collage holds (mirrors Rust's GROUP_SIZE). */
export const GROUP_SIZE = 4;

/** A pile this size is what the button was built for — enough photos that
 * placing them by hand is the boring part. */
export const PILE_SIZE = 10;

const SINGLE_SECONDS = 5;
const GROUP_SECONDS = 7;
const CLIP_MAX_SECONDS = 8;
/** Even a half-second clip needs long enough to register as a shot. */
const CLIP_MIN_SECONDS = 2;

/** Every Nth slide arrives out of black — a breath between stretches of
 * crossfades (the first one included, so the film fades up rather than
 * starting mid-thought). */
const BREATH_EVERY = 8;
const BREATH: Transition = { kind: { type: "fade_black" }, duration: 1.5 };

function clamp(v: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(v, hi));
}

/** A built cell prefers Smart fit whenever the photo has detected faces —
 * the fill crop then slides to keep them in frame instead of centering. */
function builtCell(m: ImportedMedia, index = 0): Cell {
  const cell = cellFor(m, index);
  if (m.info.is_image && m.focusRect) cell.fit = "smart";
  return cell;
}

/** One photo or clip on its own slide. `index` alternates the zoom so
 * consecutive photos don't drift identically. */
function soloSlide(m: ImportedMedia, index: number, settings: Settings): Slide {
  if (!m.info.is_image) {
    return defaultSlide({
      duration: clamp(m.info.duration, CLIP_MIN_SECONDS, CLIP_MAX_SECONDS),
      cells: [cellFor(m)],
    });
  }
  const slide = defaultSlide({ duration: SINGLE_SECONDS, cells: [builtCell(m, index)] });
  // A tall photo in a wide frame stands over its own blur rather than being
  // cropped to a strip. In a vertical or square frame it already fills, so it
  // gets the plain cover-and-drift treatment instead.
  if (m.info.height > m.info.width && settings.width >= settings.height) {
    slide.margin = 0.05;
    slide.cells[0].fit = "contain";
    slide.cells[0].motion = { type: "none" };
    slide.background = { type: "blur", cell: 0, sigma: 0.02, dim: 0.35 };
  }
  return slide;
}

/** One collage. Even groups take the composed layout for their count; odd
 * groups alternate between a face-dealt scatter pile and a mosaic, so a long
 * run of moments cycles composed → pile → composed → mosaic instead of
 * repeating one look. Motion stays off: several photos drifting at once is
 * noise, not movement. */
function groupSlide(run: readonly ImportedMedia[], ordinal: number, bin: MediaItem[]): Slide {
  const cells: Cell[] = run.map((m): Cell => ({ ...builtCell(m), motion: { type: "none" } }));
  const slide = defaultSlide({
    duration: GROUP_SECONDS,
    cells,
    layout: autoLayout(cells.length),
    margin: 0.04,
    gutter: 0.02,
  });
  if (ordinal % 2 === 0) return slide;
  if (ordinal % 4 === 3) {
    slide.layout = {
      type: "mosaic",
      aspects: run.map((m) => (m.info.height > 0 ? m.info.width / m.info.height : 1.5)),
    };
    return slide;
  }
  const patch = smartScatterPatch(slide, bin);
  if (!patch) return slide;
  slide.layout = patch.layout;
  if (patch.cells) slide.cells = patch.cells;
  if (patch.background) slide.background = patch.background;
  return slide;
}

/**
 * The whole film, from the bin. Audio (and anything that failed to import)
 * is not a slide and stays on the shelf.
 *
 * Slide ids are positional (`auto-1`, `auto-2`, …) rather than minted from
 * the clock — the build replaces every slide, so nothing can collide, and two
 * runs over the same bin produce byte-identical output.
 */
/** When a run happened, in comparable pseudo-years: real capture dates win,
 * otherwise the apparent era of the oldest-looking member. */
function runEra(run: readonly ImportedMedia[]): number {
  let best = Infinity;
  for (const m of run) {
    const y =
      m.captured_at !== null
        ? 1970 + m.captured_at / 31_556_952
        : m.embedding
          ? eraScore(m.embedding)
          : 1999.5;
    best = Math.min(best, y);
  }
  return best;
}

export async function buildSlides(
  media: readonly ImportedMedia[],
  settings: Settings,
): Promise<Slide[]> {
  const visual = media.filter((m) => m.info.is_image || m.info.has_video);
  const bin: MediaItem[] = visual.map((m): MediaItem => ({ status: "ready", ...m }));
  // Discovery is order-independent: Rust clusters on the cached features and
  // a shuffled bin yields the same moments. Whole runs then sort by apparent
  // age, so the film opens with the oldest-looking moments without a
  // reshuffle ever splitting one.
  const byPath = new Map(visual.map((m) => [m.path, m]));
  const clusters = await groupMoments(visual.map((m) => m.path));
  const discovered = clusters
    .map((c) => c.map((p) => byPath.get(p)).filter((m): m is ImportedMedia => m !== undefined))
    .filter((run) => run.length > 0);
  const runs = discovered
    .map((run, slot) => ({ run, slot, era: runEra(run) }))
    .sort((a, b) => a.era - b.era || a.slot - b.slot)
    .map((x) => x.run);
  let groups = 0;
  return runs.map((run, i) => {
    const slide = run.length > 1 ? groupSlide(run, groups++, bin) : soloSlide(run[0], i, settings);
    slide.id = `auto-${i + 1}`;
    slide.transition = i % BREATH_EVERY === 0 ? { ...BREATH } : { ...GENTLE_CROSSFADE };
    return slide;
  });
}

/** Ready bin entries, in bin order — what `buildSlides` takes. */
export function buildableMedia(media: readonly MediaItem[]): ImportedMedia[] {
  return media.filter((m): m is { status: "ready" } & ImportedMedia => m.status === "ready");
}

/** A slide nobody has put anything into: the untouched title card a new
 * project opens with, or a blank slide just added. */
export function isEmptySlide(s: Slide): boolean {
  return s.cells.length === 0 && s.texts.every((t) => t.text.trim() === "");
}

/** Whether building would throw work away. Only then is the user asked. */
export function needsRebuildConfirm(slides: readonly Slide[]): boolean {
  return slides.some((s) => !isEmptySlide(s));
}
