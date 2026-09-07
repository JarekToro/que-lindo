// Playback & audio.
import { browser, expect } from "@wdio/globals";
import { act, clickButton, IMG, importAndPlace, resetApp, setMode, store, waitForStore } from "../page/app.js";

describe("Playback & audio", () => {
  before(async () => {
    await resetApp();
    await importAndPlace([IMG("img_ONE.png"), IMG("img_THREE.png"), IMG("music.mp3")], 3);
    await clickButton("Music", ".shelf-item");
    await browser.pause(600);
  });

  it("time advances 1:1 with the wall clock", async () => {
    await act((s) => {
      s.setTime(0);
      s.setPlaying(true);
    });
    await browser.pause(600); // mix decode + start latency
    const t0 = await store((s) => s.time);
    const w0 = Date.now();
    await browser.pause(2000);
    const t1 = await store((s) => s.time);
    const wall = (Date.now() - w0) / 1000;
    await act((s) => s.setPlaying(false));
    // Time is anchored to audioContext.currentTime, but the UI tick that
    // publishes it is throttled to ~1Hz while the window isn't key — the
    // sampled value can lag one tick. The pre-fix drifting loop would advance
    // only ~0.17s here and still fail this bound hard.
    expect(Math.abs(t1 - t0 - wall)).toBeLessThan(1.2);
  });

  it("the audio mix carries its revision header and real PCM", async () => {
    const info = await browser.execute(async () => {
      const buf = (await window.__TAURI_INTERNALS__.invoke("render_audio_mix", {})) as ArrayBuffer;
      const rev = Number(new DataView(buf).getBigUint64(0, true));
      const pcm = new Int16Array(buf, 8, Math.floor((buf.byteLength - 8) / 2));
      let peak = 0;
      for (let i = 0; i < pcm.length; i += 97) peak = Math.max(peak, Math.abs(pcm[i]));
      return { rev, bytes: buf.byteLength, peak };
    });
    expect(info.rev).toBeGreaterThan(0);
    expect(info.bytes).toBeGreaterThan(100000);
    expect(info.peak).toBeGreaterThan(50);
  });

  it("▶ Slide auditions exactly one slide and stops at its end", async () => {
    const span = await store((s) => s.timing!.spans[1]);
    await act((s) => s.playSlide(1), undefined, 300);
    const started = await store((s) => s.time);
    await browser.pause((span.end - span.start) * 1000 + 1200);
    const after = await store((s) => ({ playing: s.playing, at: s.time, until: s.playUntil }));
    expect(started).toBeLessThan(span.start + 1);
    expect(after.playing).toBe(false);
    expect(Math.abs(after.at - span.end)).toBeLessThan(0.1);
    expect(after.until).toBe(null);
  });

  it("selecting the first slide lands playback at 0:00", async () => {
    await act((s) => {
      s.setTime(5);
      s.selectSlide(0);
    }, undefined, 200);
    expect(await store((s) => s.time)).toBe(0);
  });

  it("entering Time mode starts the music; Arrange pauses it", async () => {
    await setMode("time");
    expect(await store((s) => s.mode)).toBe("time");
    await waitForStore((s) => s.playing === true, undefined, 6000);
    await setMode("arrange");
    await waitForStore((s) => s.playing === false, undefined, 6000);
  });
});
