import { dropFiles, expect, IMG, makeSuite, st, waitFor } from "../harness.mjs";
import { sleep } from "../client.mjs";

const suite = makeSuite("Time mode");
export default suite;

suite.test("card widths are proportional to the timing spans", async (app) => {
  await dropFiles(app, [IMG("img_ONE.png"), IMG("img_THREE.png"), IMG("clip.mp4")], 4);
  await waitFor(app, st("timing !== null"));
  await app.evalJs("document.querySelectorAll('.mode-toggle button')[1]?.click(); true");
  await waitFor(app, "!!document.querySelector('.time-strip')");
  await app.evalJs(`${st("setPlaying(false)")}; true`);
  await sleep(1400); // FLIP settles
  // Computed width, not the bounding rect: the mode-switch FLIP transform
  // can freeze mid-flight while the window isn't key, and this asserts the
  // proportional layout, not compositor timing.
  const widths = await app.evalJs(`(() => {
    const spans = window.__editorStore.getState().timing.spans;
    const total = window.__editorStore.getState().timing.total;
    const cards = [...document.querySelectorAll(".time-row .slide-card")];
    return cards.map((c, i) => {
      const next = i + 1 < spans.length ? spans[i + 1].start : total;
      return { px: parseFloat(getComputedStyle(c).width), want: (next - spans[i].start) * 24 };
    });
  })()`);
  for (const w of widths) expect(Math.abs(w.px - w.want)).toBeLessThan(2);
});

suite.test("seam markers include the intro and the outro", async (app) => {
  const info = await app.evalJs(`(() => {
    const p = window.__editorStore.getState().project;
    const nonCut = p.slides.filter(s => s.transition.kind.type !== "cut").length;
    const outro = p.outro.kind.type !== "cut" ? 1 : 0;
    return { expected: nonCut + outro, actual: document.querySelectorAll(".seam-marker").length };
  })()`);
  expect(info.actual).toBe(info.expected);
});

suite.test("scrubbing the ruler seeks proportionally", async (app) => {
  await app.evalJs(`(() => {
    const ruler = document.querySelector(".time-ruler");
    const r = ruler.getBoundingClientRect();
    ruler.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, cancelable: true, clientX: r.left + 120, clientY: r.top + 5, pointerId: 996, buttons: 1, isPrimary: true }));
    return true;
  })()`);
  await sleep(300);
  expect(await app.evalJs(st("time"))).toBeCloseTo(5, 0.2); // 120px / 24px-per-s
});

suite.test("the audio lane draws the mix waveform aligned to the clock", async (app) => {
  await app.evalJs(`window.__TAURI_INTERNALS__.invoke("plugin:event|emit", {
    event: "tauri://drag-drop",
    payload: { paths: ${JSON.stringify([IMG("music.mp3")])}, position: { x: 0, y: 0 } } })`);
  await waitFor(app, st("media.some(m => m.status === 'ready' && m.info.has_audio && !m.info.has_video)"), 10000);
  await app.evalJs(`(() => {
    const shelfBtn = [...document.querySelectorAll(".shelf-item button")].find(b => b.textContent.includes("Music"));
    if (!shelfBtn) return "no shelf button";
    shelfBtn.click();
    return true;
  })()`);
  await waitFor(app, st("project.audio.length === 1"), 6000);
  await waitFor(app, `(() => {
    const c = document.querySelector(".audio-lane canvas");
    if (!c) return false;
    const g = c.getContext("2d");
    const d = g.getImageData(0, 0, c.width, c.height).data;
    for (let i = 3; i < d.length; i += 160) if (d[i] > 0) return true;
    return false;
  })()`, 15000);
  await waitFor(app, `(() => {
    const c = document.querySelector(".audio-lane canvas");
    const content = document.querySelector(".time-content");
    if (!c || !content || !content.style.width) return false;
    return Math.abs(c.getBoundingClientRect().width - parseFloat(content.style.width)) < 4;
  })()`, 10000);
});

suite.test("the playhead follows playback", async (app) => {
  const moved = await app.evalJs(`(async () => {
    const wait = (ms) => new Promise((r) => setTimeout(r, ms));
    const s = window.__editorStore.getState();
    s.setTime(0);
    s.setPlaying(true);
    await wait(1500);
    window.__editorStore.getState().setPlaying(false);
    return parseFloat(document.querySelector(".playhead").style.left);
  })()`);
  expect(moved).toBeGreaterThan(10);
});
