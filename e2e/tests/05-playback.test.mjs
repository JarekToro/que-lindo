import { dropFiles, expect, IMG, makeSuite, st, waitFor } from "../harness.mjs";
import { sleep } from "../client.mjs";

const suite = makeSuite("Playback & audio");
export default suite;

suite.test("time advances 1:1 with the wall clock", async (app) => {
  await dropFiles(app, [IMG("img_ONE.png"), IMG("img_THREE.png"), IMG("music.mp3")], 3);
  await app.evalJs(`(() => {
    const shelfBtn = [...document.querySelectorAll(".shelf-item button")].find(b => b.textContent.includes("Music"));
    shelfBtn?.click();
    return true;
  })()`);
  await sleep(600);
  const drift = await app.evalJs(`(async () => {
    const wait = (ms) => new Promise((r) => setTimeout(r, ms));
    const s = window.__editorStore.getState();
    s.setTime(0);
    s.setPlaying(true);
    await wait(600); // mix decode + start latency
    const t0 = window.__editorStore.getState().time;
    const w0 = performance.now();
    await wait(2000);
    const t1 = window.__editorStore.getState().time;
    window.__editorStore.getState().setPlaying(false);
    return (t1 - t0) - (performance.now() - w0) / 1000;
  })()`);
  // Time is anchored to audioContext.currentTime, but the UI tick that
  // publishes it is throttled to ~1Hz while the window isn't key — the
  // sampled value can lag one tick. The pre-fix drifting loop would advance
  // only ~0.17s here and still fail this bound hard.
  expect(Math.abs(drift)).toBeLessThan(1.2);
});

suite.test("the audio mix carries its revision header and real PCM", async (app) => {
  const info = await app.evalJs(`(async () => {
    const buf = await window.__TAURI_INTERNALS__.invoke("render_audio_mix", {});
    const rev = Number(new DataView(buf).getBigUint64(0, true));
    const pcm = new Int16Array(buf, 8, Math.floor((buf.byteLength - 8) / 2));
    let peak = 0;
    for (let i = 0; i < pcm.length; i += 97) peak = Math.max(peak, Math.abs(pcm[i]));
    return { rev, bytes: buf.byteLength, peak };
  })()`);
  expect(info.rev).toBeGreaterThan(0);
  expect(info.bytes).toBeGreaterThan(100000);
  expect(info.peak).toBeGreaterThan(50);
});

suite.test("▶ Slide auditions exactly one slide and stops at its end", async (app) => {
  const result = await app.evalJs(`(async () => {
    const wait = (ms) => new Promise((r) => setTimeout(r, ms));
    const s = window.__editorStore.getState();
    const span = s.timing.spans[1];
    s.playSlide(1);
    await wait(300);
    const started = window.__editorStore.getState().time;
    await wait((span.end - span.start) * 1000 + 1200);
    const after = window.__editorStore.getState();
    return { span, started, playing: after.playing, at: after.time, until: after.playUntil };
  })()`, 20000);
  expect(result.started).toBeLessThan(result.span.start + 1);
  expect(result.playing).toBe(false);
  expect(result.at).toBeCloseTo(result.span.end, 0.1);
  expect(result.until).toBe(null);
});

suite.test("selecting the first slide lands playback at 0:00", async (app) => {
  await app.evalJs(`(() => {
    const s = window.__editorStore.getState();
    s.setTime(5);
    s.selectSlide(0);
    return true;
  })()`);
  await sleep(200);
  expect(await app.evalJs(st("time"))).toBe(0);
});

suite.test("entering Time mode starts the music; Arrange pauses it", async (app) => {
  await app.evalJs(
    "document.querySelectorAll('.mode-toggle button')[1]?.click(); true",
  );
  await waitFor(app, st("playing === true"), 6000);
  await app.evalJs(
    "document.querySelectorAll('.mode-toggle button')[0]?.click(); true",
  );
  await waitFor(app, st("playing === false"), 6000);
});
