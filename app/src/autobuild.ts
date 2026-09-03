// One-click auto-build: a pile of photos becomes a finished draft. The bin is
// ordered by when the shots were taken, photos from the same moment land on
// one collage, and pacing, motion and transitions are already chosen — the
// user opens the result to adjust it, not to assemble it.
//
// Pure and deterministic on purpose: the same bin always builds the same
// film, and nothing here touches the store, the backend or the clock, so the
// whole thing is testable by calling `buildSlides` with plain objects. (The
// repo has no TS test runner yet; when one lands these exports are the unit.)

import { smartScatterPatch } from "./layouts";
import { GENTLE_CROSSFADE, autoLayout, cellFor, defaultSlide } from "./presets";
import type { Cell, ImportedMedia, MediaItem, Settings, Slide, Transition } from "./types";

/** Photos shot within this many seconds of the one before belong to the same
 * moment, and so to the same collage. */
export const GROUP_WINDOW = 90;

/** Most photos one auto-built collage holds; past this the moment gets a
 * second slide. */
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

/**
 * Dated media sorts by capture time; undated media never moves. Each undated
 * file keeps the bin slot it arrived in and the dated ones, in time order,
 * fill the slots that were theirs. Ties keep bin order, so the result is a
 * stable total order — no clock, no randomness.
 */
export function orderByCapture(media: readonly ImportedMedia[]): ImportedMedia[] {
  const slots: number[] = [];
  const dated: { media: ImportedMedia; at: number; slot: number }[] = [];
  media.forEach((m, slot) => {
    if (m.captured_at === null) return;
    slots.push(slot);
    dated.push({ media: m, at: m.captured_at, slot });
  });
  dated.sort((a, b) => a.at - b.at || a.slot - b.slot);
  const out = [...media];
  slots.forEach((slot, i) => {
    out[slot] = dated[i].media;
  });
  return out;
}

/** How far apart two thumbnail fingerprints may sit (mean absolute channel
 * difference, 0..255) and still read as "the same roll". Tuned loose enough
 * for scans of prints — same era, same cast — and tight enough that a beach
 * photo never joins a living-room one. */
export const SIGNATURE_WINDOW = 30;

/** Mean absolute channel difference between two fingerprints, 0..255. */
export function signatureDistance(a: readonly number[], b: readonly number[]): number {
  if (a.length !== b.length || a.length === 0) return Infinity;
  let sum = 0;
  for (let i = 0; i < a.length; i++) sum += Math.abs(a[i] - b[i]);
  return sum / a.length;
}

/** Whether `next` joins the run being gathered. */
function joins(run: readonly ImportedMedia[], next: ImportedMedia): boolean {
  if (run.length >= GROUP_SIZE) return false;
  const prev = run[run.length - 1];
  // Clips stand alone.
  if (!prev.info.is_image || !next.info.is_image) return false;
  // Both dated: the clock decides — shot within the window means one moment.
  if (prev.captured_at !== null && next.captured_at !== null) {
    return Math.abs(next.captured_at - prev.captured_at) <= GROUP_WINDOW;
  }
  // Metadata gone (scans, photos stripped by sharing services): fall back to
  // how the photos look. Neighbours whose thumbnails share tone and cast —
  // the same roll, the same room, the same era of film — still group.
  if (prev.signature && next.signature) {
    return signatureDistance(prev.signature, next.signature) <= SIGNATURE_WINDOW;
  }
  return false;
}

/** The ordered media cut into runs — one run per slide. */
export function groupRuns(ordered: readonly ImportedMedia[]): ImportedMedia[][] {
  const runs: ImportedMedia[][] = [];
  for (const m of ordered) {
    const open = runs[runs.length - 1];
    if (open && joins(open, m)) open.push(m);
    else runs.push([m]);
  }
  return runs;
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
  const slide = defaultSlide({ duration: SINGLE_SECONDS, cells: [cellFor(m, index)] });
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
  const cells: Cell[] = run.map((m): Cell => ({ ...cellFor(m), motion: { type: "none" } }));
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
export function buildSlides(media: readonly ImportedMedia[], settings: Settings): Slide[] {
  const visual = media.filter((m) => m.info.is_image || m.info.has_video);
  const bin: MediaItem[] = visual.map((m): MediaItem => ({ status: "ready", ...m }));
  const runs = groupRuns(orderByCapture(visual));
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
