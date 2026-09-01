import { dropFiles, expect, IMG, makeSuite, st, waitFor } from "../harness.mjs";
import { sleep } from "../client.mjs";

const suite = makeSuite("Import & media bin");
export default suite;

suite.test("photos and clips become slides in drop order; audio goes to the shelf", async (app) => {
  await dropFiles(app, [IMG("img_ONE.png"), IMG("img_THREE.png"), IMG("clip.mp4"), IMG("music.mp3")], 4);
  const slides = await app.evalJs(st("project.slides.map(s => s.cells[0]?.source.path ?? 'none')"));
  expect(slides.length).toBe(4); // title card + 3 visual
  expect(slides[1]).toContain("img_ONE");
  expect(slides[2]).toContain("img_THREE");
  expect(slides[3]).toContain("clip.mp4");
  const unusedAudio = await app.evalJs(
    st("media.filter(m => m.status === 'ready' && m.info.has_audio && !m.info.has_video).length"),
  );
  expect(unusedAudio).toBe(1);
});

suite.test("thumbnails stream in as object URLs", async (app) => {
  await waitFor(app, "document.querySelectorAll('.arrange-grid .slide-card img, .face-arrange .slide-card img').length >= 3", 15000);
  const src = await app.evalJs("document.querySelector('.slide-card img')?.src.slice(0, 5)");
  expect(src).toBe("blob:");
});

suite.test("re-dropping the same files adds nothing", async (app) => {
  const before = await app.evalJs(st("project.slides.length"));
  await app.evalJs(`window.__TAURI_INTERNALS__.invoke("plugin:event|emit", {
    event: "tauri://drag-drop",
    payload: { paths: ${JSON.stringify([IMG("img_ONE.png")])}, position: { x: 0, y: 0 } } })`);
  await sleep(1500);
  expect(await app.evalJs(st("project.slides.length"))).toBe(before);
});

suite.test("a bogus path shows an error item, and stays out of the film", async (app) => {
  await app.evalJs(`window.__TAURI_INTERNALS__.invoke("plugin:event|emit", {
    event: "tauri://drag-drop",
    payload: { paths: ["/tmp/does-not-exist-e2e.png"], position: { x: 0, y: 0 } } })`);
  await waitFor(app, st("media.some(m => m.status === 'error')"), 8000);
  const slides = await app.evalJs(st("project.slides.length"));
  expect(slides).toBe(4);
});

suite.test("focal detection returns null gracefully for faceless images", async (app) => {
  const focus = await app.evalJs(
    `window.__TAURI_INTERNALS__.invoke("detect_focus", { path: ${JSON.stringify(IMG("img_ONE.png"))} })`,
  );
  expect(focus).toBe(null); // testsrc patterns have no faces
});

suite.test("imported photo slides carry aimed-or-centered zoom motion", async (app) => {
  const motions = await app.evalJs(
    st("project.slides.slice(1, 3).map(s => s.cells[0].motion.type)"),
  );
  expect(motions).toEqual(["zoom", "zoom"]);
  const origin = await app.evalJs(st("project.slides[1].cells[0].motion.origin"));
  expect(origin.length).toBe(2);
});
