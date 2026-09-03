// Audio beat marks: the moments the user taps out on the music, and the nudge
// that walks slide transitions onto them.
//
// A mark is stored on its AudioTrack in the *track's* own time base (seconds
// into the source file), never in timeline seconds — so it rides along when
// the track is placed elsewhere (`start`) or trimmed at the head (`offset`).
// Timeline instants are always derived through `markTime`.

import type { AudioTrack, MediaItem } from "./types";

/** How far a mark reaches for a boundary; farther marks are left alone. */
const WINDOW = 2.5;
/** Slides preceding a boundary that share one mark's shift. */
const SPREAD = 4;
/** No slide is nudged below this. */
const MIN_DURATION = 1.0;
/** No slide's duration moves more than this fraction of what it was. */
const MAX_STRETCH = 0.35;
/** A boundary this close to its mark counts as aligned. */
const TOLERANCE = 0.05;
/** Clamp-aware redistribution passes per mark (transition clamps are not
 * linear in duration, so one proportional pass can undershoot). */
const PASSES = 6;
const EPS = 1e-4;

/** Timeline instant of a mark stored on `track`. */
export function markTime(track: AudioTrack, mark: number): number {
  return track.start + (mark - track.offset);
}

/** What to store for a mark the user placed at timeline instant `t`. */
export function markValue(track: AudioTrack, t: number): number {
  return track.offset + (t - track.start);
}

/** Insert `value`, keeping the list sorted; reports where it landed. */
export function insertMark(markers: number[], value: number): { markers: number[]; index: number } {
  let index = 0;
  while (index < markers.length && markers[index] <= value) index++;
  const next = markers.slice();
  next.splice(index, 0, value);
  return { markers: next, index };
}

/** Retime one mark, keeping the list sorted. Equal times hold their relative
 * order, so the moved mark's new index comes back with it. */
export function moveMark(
  markers: number[],
  index: number,
  value: number,
): { markers: number[]; index: number } {
  const decorated = markers.map((m, i) => ({ v: i === index ? value : m, i }));
  decorated.sort((a, b) => a.v - b.v || a.i - b.i);
  return {
    markers: decorated.map((d) => d.v),
    index: decorated.findIndex((d) => d.i === index),
  };
}

/** How long a track runs on the timeline, mirroring `plan_track` in
 * crates/slideshow-core/src/audio.rs: a looping track fills the room left on
 * the timeline, and so does one whose file hasn't been probed yet. */
export function trackLength(track: AudioTrack, total: number, sourceLength?: number): number {
  const window = Math.max(total - track.start, 0);
  let take =
    track.loop || sourceLength === undefined || sourceLength <= 0
      ? window
      : Math.min(Math.max(sourceLength - track.offset, 0), window);
  if (track.duration !== null) take = Math.min(take, Math.max(track.duration, 0));
  return take;
}

/** Which track is playing at timeline instant `t`. Songs that overlap — a
 * cross-fade from one to the next — resolve to the earlier one, so the answer
 * never depends on where the pointer happened to land; a `t` in a gap between
 * tracks falls back to the first. */
export function trackAt(
  tracks: AudioTrack[],
  t: number,
  total: number,
  media: MediaItem[],
): number {
  for (let i = 0; i < tracks.length; i++) {
    const item = media.find((m) => m.path === tracks[i].path);
    const source = item && item.status === "ready" ? item.info.duration : undefined;
    if (t >= tracks[i].start && t < tracks[i].start + trackLength(tracks[i], total, source)) return i;
  }
  return 0;
}

/** Drop a mark at timeline instant `t` on whichever track is playing there.
 * Tracks come back untouched when the project has no music to mark. */
export function tracksWithMark(
  tracks: AudioTrack[],
  t: number,
  total: number,
  media: MediaItem[],
): AudioTrack[] {
  const target = trackAt(tracks, t, total, media);
  const track = tracks[target];
  if (!track) return tracks;
  const { markers } = insertMark(track.markers, markValue(track, t));
  return tracks.map((tr, i) => (i === target ? { ...tr, markers } : tr));
}

/**
 * Where each slide seam sits on the global clock: entry `j` is the boundary
 * between slide `j` and slide `j + 1`, taken at the transition's *midpoint*.
 * Mirrors `Timeline::new` in crates/slideshow-core/src/timeline.rs, including
 * its clamps, so the strip and the renderer agree.
 */
export function boundaryTimes(durations: number[], transitions: number[]): number[] {
  const starts: number[] = [];
  const trans: number[] = [];
  let cursor = 0;
  for (let i = 0; i < durations.length; i++) {
    const dur = Math.max(durations[i], 0.1);
    let t = Math.max(transitions[i] ?? 0, 0);
    if (i > 0) {
      // A transition can't outlast either slide it joins.
      t = Math.min(t, Math.max(durations[i - 1], 0.1) * 0.5, dur * 0.5);
      cursor -= t;
    } else {
      t = Math.min(t, dur * 0.5);
    }
    starts.push(cursor);
    trans.push(t);
    cursor += dur;
  }
  const out: number[] = [];
  for (let k = 1; k < durations.length; k++) out.push(starts[k] + trans[k] / 2);
  return out;
}

export interface SnapInput {
  /** Slide durations in playback order, seconds. */
  durations: number[];
  /** Effective transition-in per slide (0 for a cut, and for the first slide
   * whose transition is the film's intro). */
  transitions: number[];
  /** Mark instants in timeline seconds, any order. */
  marks: number[];
}

export interface SnapResult {
  durations: number[];
  /** Marks whose boundary ended within `TOLERANCE`. */
  aligned: number;
  /** Marks considered — including the ones no boundary was near. */
  total: number;
}

/** Push `amount` seconds of total change into slides `[from, to)`,
 * proportional to their durations and inside each slide's budget. Returns how
 * much of it actually landed. */
function spread(
  durations: number[],
  lo: number[],
  hi: number[],
  from: number,
  to: number,
  amount: number,
): number {
  const room: number[] = [];
  for (let i = from; i < to; i++) {
    if ((amount > 0 ? hi[i] - durations[i] : durations[i] - lo[i]) > EPS) room.push(i);
  }
  const weight = room.reduce((a, i) => a + durations[i], 0);
  if (weight <= 0) return 0;
  let applied = 0;
  for (const i of room) {
    const next = Math.min(hi[i], Math.max(lo[i], durations[i] + amount * (durations[i] / weight)));
    applied += next - durations[i];
    durations[i] = next;
  }
  return applied;
}

/** Change one slide by `amount` within its budget; returns what landed. */
function absorb(durations: number[], lo: number[], hi: number[], i: number, amount: number): number {
  const next = Math.min(hi[i], Math.max(lo[i], durations[i] + amount));
  const applied = next - durations[i];
  durations[i] = next;
  return applied;
}

/**
 * Nudge slide durations so transitions land on the marks.
 *
 * Marks are walked left→right. Each takes the nearest boundary no earlier mark
 * has claimed, within ±2.5s; anything farther is skipped. The shift is spread
 * over the (up to) four slides before that boundary in proportion to their
 * durations, and the *opposite* shift is absorbed by the slide right after it,
 * so the film's total length is preserved and this composes with anything that
 * fits the film to the music. Every slide is clamped: never under 1.0s, never
 * more than 35% off the duration it had when this mark's turn began. Clamped
 * slides simply get as close as they can — later boundaries then move with the
 * change, and the walk continues on the updated timeline.
 *
 * Pure and deterministic: same input, same durations out.
 */
export function snapDurationsToMarks(input: SnapInput): SnapResult {
  const durations = input.durations.slice();
  const { transitions } = input;
  const marks = [...input.marks].sort((a, b) => a - b);
  const claimed = new Set<number>();
  let aligned = 0;

  for (const mark of marks) {
    const bounds = boundaryTimes(durations, transitions);
    let best = -1;
    let bestDist = Infinity;
    for (let j = 0; j < bounds.length; j++) {
      if (claimed.has(j)) continue;
      const d = Math.abs(bounds[j] - mark);
      // Strictly nearer, so a tie keeps the earlier boundary.
      if (d < bestDist - 1e-9) {
        bestDist = d;
        best = j;
      }
    }
    if (best < 0 || bestDist > WINDOW) continue;
    claimed.add(best);

    // The boundary sits between `best` and the slide that follows it.
    const after = best + 1;
    const from = Math.max(0, after - SPREAD);
    // The budget is measured against the durations this mark started from.
    const base = durations.slice();
    const lo = base.map((d) => Math.min(d, Math.max(MIN_DURATION, d * (1 - MAX_STRETCH))));
    const hi = base.map((d) => d * (1 + MAX_STRETCH));

    for (let pass = 0; pass < PASSES; pass++) {
      const residual = mark - boundaryTimes(durations, transitions)[best];
      if (Math.abs(residual) < EPS) break;
      const applied = spread(durations, lo, hi, from, after, residual);
      absorb(durations, lo, hi, after, -applied);
      if (Math.abs(applied) < EPS) break;
    }

    if (Math.abs(boundaryTimes(durations, transitions)[best] - mark) <= TOLERANCE) aligned++;
  }

  return { durations, aligned, total: marks.length };
}
