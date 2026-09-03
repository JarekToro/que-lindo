// One AudioContext for the app's lifetime, and the project's mixed audio
// decoded once per revision. Playback (Preview) and the Time-mode audio lane
// (Timeline) share both.

import { renderAudioMix } from "./api";

let audioCtx: AudioContext | null = null;
let mixCache: { rev: number; buffer: AudioBuffer | null } | null = null;
let inFlight: { rev: number; promise: Promise<AudioBuffer | null> } | null = null;

/** Created lazily; resume() it from a user gesture before playing. */
export function ensureAudioCtx(): AudioContext {
  if (!audioCtx) audioCtx = new AudioContext();
  return audioCtx;
}

/** The mix for a project revision (backend renders + caches per rev too).
 * The backend may briefly lag the frontend behind the debounced project
 * sync; stale answers are retried until the revisions agree. */
export function mixForRev(ctx: AudioContext, rev: number): Promise<AudioBuffer | null> {
  if (mixCache && mixCache.rev >= rev) return Promise.resolve(mixCache.buffer);
  if (inFlight && inFlight.rev >= rev) return inFlight.promise;
  const promise = (async () => {
    for (let attempt = 0; ; attempt++) {
      const { rev: gotRev, buffer } = await renderAudioMix(ctx);
      if (gotRev >= rev) {
        mixCache = { rev: gotRev, buffer };
        return buffer;
      }
      if (attempt >= 5) {
        // The backend never caught up; hand back the stale answer but do NOT
        // cache it — caching would pin a possibly-silent mix on this rev.
        return buffer;
      }
      await new Promise((r) => setTimeout(r, 200));
    }
  })().finally(() => {
    if (inFlight?.rev === rev) inFlight = null;
  });
  inFlight = { rev, promise };
  return promise;
}
