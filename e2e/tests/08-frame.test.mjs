import { dropFiles, expect, IMG, makeSuite, st, waitFor } from "../harness.mjs";
import { sleep } from "../client.mjs";

const suite = makeSuite("Frame rendering: intro, outro, zoom focus");
export default suite;

const lumSnippet = `(() => {
  const canvas = document.querySelector(".preview-stage canvas");
  const g = canvas.getContext("2d");
  const d = g.getImageData(0, 0, canvas.width, canvas.height).data;
  let sum = 0;
  for (let i = 0; i < d.length; i += 64) sum += d[i];
  return Math.round(sum / (d.length / 64));
})()`;

async function lumAt(app, t) {
  await app.evalJs(`${st(`setTime(${t})`)}; true`);
  await sleep(900);
  return app.evalJs(lumSnippet);
}

suite.test("the first slide's transition plays as an intro from the background", async (app) => {
  await dropFiles(app, [IMG("img_ONE.png"), IMG("img_THREE.png")], 3);
  await app.evalJs(`(() => {
    const s = window.__editorStore.getState();
    // drop the default title card so a bright photo is first, with a 1s fade
    s.mutate(p => ({ ...p, slides: p.slides.slice(1).map((sl, i) => i === 0
      ? { ...sl, transition: { kind: { type: "cross_fade" }, duration: 1.0 } } : sl) }));
    return true;
  })()`);
  await waitFor(app, st("timing?.spans[0].transition_in === 1"));
  const early = await lumAt(app, 0.05);
  const settled = await lumAt(app, 2.5);
  expect(settled).toBeGreaterThan(early + 20);
});

suite.test("the outro fades the last frame into the background", async (app) => {
  await app.evalJs(`(() => {
    window.__editorStore.getState().mutate(p => ({
      ...p, outro: { kind: { type: "fade_black" }, duration: 1.5 } }));
    return true;
  })()`);
  await sleep(500);
  const total = await app.evalJs(st("timing.total"));
  const mid = await lumAt(app, total - 3);
  const end = await lumAt(app, total - 0.05);
  expect(end).toBeLessThan(Math.max(mid / 2, 30));
});

suite.test("moving the zoom focus visibly changes the rendered frame", async (app) => {
  const diff = await app.evalJs(`(async () => {
    const wait = (ms) => new Promise((r) => setTimeout(r, ms));
    const s = window.__editorStore.getState();
    const setOrigin = (o) => s.mutate(p => ({ ...p, slides: p.slides.map((sl, i) => i === 0
      ? { ...sl, cells: sl.cells.map(c => ({ ...c, motion: { type: "zoom", from: 2.0, to: 2.0, origin: o } })) } : sl) }));
    const grab = () => {
      const canvas = document.querySelector(".preview-stage canvas");
      return canvas.getContext("2d").getImageData(0, 0, canvas.width, canvas.height).data;
    };
    s.setTime(2.5);
    setOrigin([0.1, 0.1]);
    await wait(1100);
    const a = grab();
    setOrigin([0.9, 0.9]);
    await wait(1100);
    const b = grab();
    let changed = 0;
    for (let i = 0; i < a.length; i += 64) if (Math.abs(a[i] - b[i]) > 12) changed++;
    return changed;
  })()`, 20000);
  expect(diff).toBeGreaterThan(100);
});

suite.test("the ◎ aim handle appears for a selected zooming photo", async (app) => {
  await app.evalJs(`(() => {
    const s = window.__editorStore.getState();
    s.selectSlide(0, true);
    s.selectCell(0);
    return true;
  })()`);
  await waitFor(app, "!!document.querySelector('.zoom-handle')", 6000);
});

suite.test("preview frames come back as raw RGBA with a size header", async (app) => {
  const info = await app.evalJs(`(async () => {
    const buf = await window.__TAURI_INTERNALS__.invoke("render_preview", { time: 1, scale: 0.5, revealTexts: false });
    const v = new DataView(buf);
    const w = v.getUint32(0, true), h = v.getUint32(4, true);
    return { ok: buf.byteLength === 8 + w * h * 4, w, h };
  })()`);
  expect(info.ok).toBe(true);
  expect(info.w).toBeGreaterThan(100);
});

suite.test("the frame cache answers repeats instantly", async (app) => {
  const times = await app.evalJs(`(async () => {
    const inv = window.__TAURI_INTERNALS__.invoke;
    const t0 = performance.now();
    await inv("render_preview", { time: 2.75, scale: 0.5, revealTexts: false });
    const cold = performance.now() - t0;
    const t1 = performance.now();
    await inv("render_preview", { time: 2.75, scale: 0.5, revealTexts: false });
    return { cold, warm: performance.now() - t1 };
  })()`);
  expect(times.warm).toBeLessThan(Math.max(times.cold, 20));
});
