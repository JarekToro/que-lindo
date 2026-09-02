import { dropFiles, expect, IMG, makeSuite, st, waitFor } from "../harness.mjs";
import { sleep } from "../client.mjs";

const suite = makeSuite("Persistence, undo, export");
export default suite;

const SAVE = "/tmp/e2e-roundtrip.slideshow.json";
const OUT = "/tmp/e2e-export.mp4";

suite.test("save → load round-trips the whole project", async (app) => {
  await dropFiles(app, [IMG("img_ONE.png"), IMG("img_THREE.png"), IMG("music.mp3")], 3);
  await app.evalJs(`(() => {
    const s = window.__editorStore.getState();
    s.mutate(p => ({ ...p, outro: { kind: { type: "fade_black" }, duration: 2 } }));
    const shelfBtn = [...document.querySelectorAll(".shelf-item button")].find(b => b.textContent.includes("Music"));
    shelfBtn?.click();
    return true;
  })()`);
  await sleep(700);
  const same = await app.evalJs(`(async () => {
    const inv = window.__TAURI_INTERNALS__.invoke;
    await inv("save_current_project", { path: ${JSON.stringify(SAVE)} });
    const loaded = await inv("load_project", { path: ${JSON.stringify(SAVE)} });
    const current = window.__editorStore.getState().project;
    return JSON.stringify(loaded) === JSON.stringify(current);
  })()`);
  expect(same).toBe(true);
});

suite.test("an import lands as one undo step", async (app) => {
  const before = await app.evalJs(st("project.slides.length"));
  await dropFiles(app, [IMG("img_FOUR.png"), IMG("img_FIVE.png"), IMG("img_SIX.png")], before + 3);
  await app.evalJs(`${st("undo()")}; true`);
  await sleep(300);
  expect(await app.evalJs(st("project.slides.length"))).toBe(before);
  await app.evalJs(`${st("redo()")}; true`);
  await sleep(300);
  expect(await app.evalJs(st("project.slides.length"))).toBe(before + 3);
});

suite.test("a frame drag coalesces into one undo step", async (app) => {
  await app.evalJs(`(() => {
    const s = window.__editorStore.getState();
    s.mutate(p => ({ ...p, slides: p.slides.map((sl, i) => i === 1
      ? { ...sl, texts: [{ text: "T", role: "title", font: null, weight: 400, italic: false,
          size: 0.08, color: "#ffffff", align: "center", anchor: "center", offset: [0, 0],
          max_width: 0.85, line_height: 1.25, shadow: true, box_color: null, start: 0, end: null, fade: 0.5, fade_out: null }] }
      : sl) }));
    s.selectSlide(1, true);
    s.selectText(0);
    return true;
  })()`);
  await waitFor(app, "!!document.querySelector('.text-handle')", 8000);
  await app.evalJs(`(async () => {
    const wait = (ms) => new Promise((r) => setTimeout(r, ms));
    const h = document.querySelector(".text-handle");
    const r = h.getBoundingClientRect();
    const pe = (type, x, y) => h.dispatchEvent(new PointerEvent(type, { bubbles: true, cancelable: true, clientX: x, clientY: y, pointerId: 994, buttons: 1, isPrimary: true, button: 0 }));
    pe("pointerdown", r.left + 8, r.top + 8);
    for (let i = 1; i <= 5; i++) { pe("pointermove", r.left + 8 + i * 12, r.top + 8 + i * 8); await wait(60); }
    pe("pointerup", r.left + 68, r.top + 48);
    return true;
  })()`);
  await sleep(400);
  const offAfter = await app.evalJs(st("project.slides[1].texts[0].offset[0]"));
  expect(Math.abs(offAfter)).toBeGreaterThan(0.01);
  await app.evalJs(`${st("undo()")}; true`);
  await sleep(300);
  expect(await app.evalJs(st("project.slides[1].texts[0].offset[0]"))).toBe(0);
});

suite.test("export renders a playable MP4 of the right length", async (app) => {
  const done = await app.evalJs(`(async () => {
    const inv = window.__TAURI_INTERNALS__.invoke;
    // Trim to two short slides for a fast encode.
    const s = window.__editorStore.getState();
    s.mutate(p => ({ ...p, outro: { kind: { type: "cut" }, duration: 0 },
      slides: p.slides.slice(0, 2).map(sl => ({ ...sl, duration: 1.5 })) }));
    await new Promise(r => setTimeout(r, 500));
    const project = window.__editorStore.getState().project;
    await inv("export_video", { project, outPath: ${JSON.stringify(OUT)}, scale: 0.25, crf: 30 });
    // Completion shows up as a probe-able MP4 (ffprobe fails until the file
    // is finalized, so polling it doubles as the done signal).
    for (let i = 0; i < 120; i++) {
      await new Promise(r => setTimeout(r, 500));
      const probe = await inv("probe_media", { path: ${JSON.stringify(OUT)} }).catch(() => null);
      if (probe && probe.info.has_video && probe.info.duration > 0.5) return probe.info;
    }
    return null;
  })()`, 90000);
  expect(done).toBeTruthy();
  expect(done.duration).toBeGreaterThan(1.5);
  expect(done.has_video).toBe(true);
});
