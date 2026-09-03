// One-click auto-build: a pile of photos becomes a finished draft. The bin is
// ordered by when the shots were taken, photos from the same moment land on
// one collage, and pacing, motion and transitions are already chosen — the
// user opens the result to adjust it, not to assemble it.
//
// Pure and deterministic on purpose: the same bin always builds the same
// film, and nothing here touches the store, the backend or the clock, so the
// whole thing is testable by calling `buildSlides` with plain objects. (The
// repo has no TS test runner yet; when one lands these exports are the unit.)

import { eraScore } from "./era";
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

/** A built cell prefers Smart fit whenever the photo has detected faces —
 * the fill crop then slides to keep them in frame instead of centering. */
function builtCell(m: ImportedMedia, index = 0): Cell {
  const cell = cellFor(m, index);
  if (m.info.is_image && m.focusRect) cell.fit = "smart";
  return cell;
}

/**
 * Discovery order: dated media sorts by capture time and each undated file
 * keeps the bin slot it arrived in (the dated ones, in time order, fill the
 * slots that were theirs). Grouping walks THIS order — the adjacency every
 * signal was calibrated on; the life-story arrangement happens per run
 * afterwards, so a sort can never split a moment apart.
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
 * difference, 0..255) and still read as "the same roll". Tuned against a
 * real 98-photo memorial set with no EXIF at all: 30 grouped only the
 * dead-obvious moments, 40 started joining different events; 36 catches
 * same-event and same-roll pairs while the mistakes it risks are
 * era-adjacent prints that still read as deliberate pairings. */
export const SIGNATURE_WINDOW = 36;

/** Mean absolute channel difference between two fingerprints, 0..255. */
export function signatureDistance(a: readonly number[], b: readonly number[]): number {
  if (a.length !== b.length || a.length === 0) return Infinity;
  let sum = 0;
  for (let i = 0; i < a.length; i++) sum += Math.abs(a[i] - b[i]);
  return sum / a.length;
}

/** How far the tone window flexes on face evidence. Photos of one moment
 * hold the same people, so a matching face count buys the pair a looser
 * tone match, and a strongly different head count (a group photo next to a
 * portrait) all but vetoes one. Calibrated on the same real memorial set as
 * SIGNATURE_WINDOW. */
export function faceAwareWindow(a: number | null, b: number | null): number {
  // Zero is "the detector saw nothing", not "nobody is there" — it misses
  // small faces in wide group shots and blurred ones mid-dance, so zero
  // carries no evidence either way.
  if (a === null || b === null || a === 0 || b === 0) return SIGNATURE_WINDOW;
  const diff = Math.abs(a - b);
  if (diff === 0) return SIGNATURE_WINDOW + 4;
  if (diff === 1) return SIGNATURE_WINDOW + 3;
  // A big head-count gap involving a lone subject (portrait next to a group
  // photo) is near-proof of different moments; between two busy frames it
  // may just be someone stepping out of shot, so only lean, don't veto.
  return Math.min(a, b) <= 1 ? 20 : SIGNATURE_WINDOW - 3;
}

/** Scene-embedding decision bands (cosine similarity of the int8 CLIP
 * model). Above the join band two photos read as one moment regardless of
 * tone; below the reject band they read as different moments regardless of
 * it. The gap in between defers to the fingerprint + face-count rule.
 * Calibrated on the owner-labeled memorial set. */
export const EMBED_JOIN = 0.73;
export const EMBED_REJECT = 0.69;

/** Identity rescue: "the same person appears in both, and the scenes aren't
 * alien to each other" joins even when the scene band alone wouldn't — the
 * signal that finally groups the same face across different rooms and
 * decades. Floors calibrated with the scene bands on the owner-labeled set. */
export const FACE_MATCH = 0.65;
export const FACE_SCENE_FLOOR = 0.58;

/** Best cross-set face match between two photos' identity embeddings. */
export function bestFaceMatch(
  a: readonly (readonly number[])[],
  b: readonly (readonly number[])[],
): number {
  let best = 0;
  for (const x of a) for (const y of b) best = Math.max(best, embeddingSimilarity(x, y));
  return best;
}

/** Cosine similarity of two L2-normalized embeddings. */
export function embeddingSimilarity(a: readonly number[], b: readonly number[]): number {
  if (a.length !== b.length || a.length === 0) return 0;
  let dot = 0;
  for (let i = 0; i < a.length; i++) dot += a[i] * b[i];
  return dot;
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
  // Scene embeddings see through what tone can't: same moment from a
  // different angle joins, same tone over different content splits. A
  // strong shared identity rescues pairs the scene alone would leave —
  // the undecided middle falls through to the cheaper signals.
  if (prev.embedding && next.embedding) {
    const sim = embeddingSimilarity(prev.embedding, next.embedding);
    if (sim >= EMBED_JOIN) return true;
    if (
      sim >= FACE_SCENE_FLOOR &&
      prev.faces.length > 0 &&
      next.faces.length > 0 &&
      bestFaceMatch(prev.faces, next.faces) >= FACE_MATCH
    ) {
      return true;
    }
    if (sim < EMBED_REJECT) return false;
  }
  // Metadata gone (scans, photos stripped by sharing services): fall back to
  // how the photos look — tone and cast, with the face count as a second
  // witness for or against "this is one moment".
  if (prev.signature && next.signature) {
    const window = faceAwareWindow(prev.faceCount, next.faceCount);
    return signatureDistance(prev.signature, next.signature) <= window;
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

export function buildSlides(media: readonly ImportedMedia[], settings: Settings): Slide[] {
  const visual = media.filter((m) => m.info.is_image || m.info.has_video);
  const bin: MediaItem[] = visual.map((m): MediaItem => ({ status: "ready", ...m }));
  // Group on the stable bin/EXIF order — the adjacency every signal was
  // calibrated on — then sort whole runs by apparent age, so the film opens
  // with the oldest-looking moments without a reshuffle ever splitting one.
  const discovered = groupRuns(orderByCapture(visual));
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
