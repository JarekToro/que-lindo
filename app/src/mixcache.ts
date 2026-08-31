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

/** The mix for a project revision (backend renders + caches per rev too). */
export function mixForRev(ctx: AudioContext, rev: number): Promise<AudioBuffer | null> {
  if (mixCache?.rev === rev) return Promise.resolve(mixCache.buffer);
  if (inFlight?.rev === rev) return inFlight.promise;
  const promise = renderAudioMix(ctx).then((buffer) => {
    mixCache = { rev, buffer };
    if (inFlight?.rev === rev) inFlight = null;
    return buffer;
  });
  inFlight = { rev, promise };
  return promise;
}
