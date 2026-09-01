import { dragSnippet, dropFiles, expect, IMG, makeSuite, st, waitFor } from "../harness.mjs";
import { sleep } from "../client.mjs";

const suite = makeSuite("Titles as members");
export default suite;

const CARDS = ".arrange-grid .slide-card, .face-arrange .slide-card";

suite.test("dragging the T Title chip onto a photo adds a title member", async (app) => {
  await dropFiles(app, [IMG("img_ONE.png"), IMG("img_THREE.png")], 3);
  await app.evalJs(dragSnippet);
  const r = await app.evalJs(
    `window.__e2eDrag(".title-chip", 0, ${JSON.stringify(CARDS)}, 1)`,
  );
  expect(r).toBe("ok");
  await waitFor(app, st("project.slides[1].texts.length === 1"));
  await sleep(300);
  // photo + title = a group of 2, badge on that card
  const members = await app.evalJs(
    "(() => { const p = window.__editorStore.getState().project; return p.slides[1].cells.length + p.slides[1].texts.length; })()",
  );
  expect(members).toBe(2);
  await waitFor(
    app,
    `document.querySelectorAll(${JSON.stringify(CARDS)})[1]?.querySelector(".card-count")?.textContent === "2"`,
    5000,
  );
});

suite.test("the title renders in the card thumbnail", async (app) => {
  const text = await app.evalJs(
    `document.querySelectorAll(${JSON.stringify(CARDS)})[1].querySelector(".thumb-text")?.textContent ?? null`,
  );
  expect(text).toBe("Title");
});

suite.test("the band lists the title as a member; clicking it opens the editor", async (app) => {
  await app.evalJs(`(() => {
    document.querySelectorAll(${JSON.stringify(CARDS)})[1]
      .dispatchEvent(new MouseEvent("dblclick", { bubbles: true, cancelable: true }));
    return true;
  })()`);
  await waitFor(app, "document.querySelectorAll('.band-member').length === 2");
  expect(await app.evalJs("document.querySelectorAll('.band-member.band-text').length")).toBe(1);
  await app.evalJs("document.querySelector('.band-member.band-text').click(); true");
  await sleep(300);
  expect(await app.evalJs(st("selectedText"))).toBe(0);
  expect(await app.evalJs("!!document.querySelector('.outcome textarea')")).toBe(true);
});

suite.test("the frame shows a draggable handle; dragging writes the offset", async (app) => {
  await waitFor(app, "!!document.querySelector('.text-handle')", 8000);
  await app.evalJs(`(async () => {
    const wait = (ms) => new Promise((r) => setTimeout(r, ms));
    const h = document.querySelector(".text-handle");
    const r = h.getBoundingClientRect();
    const pe = (el, type, x, y) => el.dispatchEvent(new PointerEvent(type, { bubbles: true, cancelable: true, clientX: x, clientY: y, pointerId: 997, isPrimary: true, button: 0, buttons: 1 }));
    pe(h, "pointerdown", r.left + 8, r.top + 8);
    pe(h, "pointermove", r.left + 70, r.top + 50);
    await wait(200);
    pe(h, "pointerup", r.left + 70, r.top + 50);
    return true;
  })()`);
  await sleep(400);
  const offset = await app.evalJs(st("project.slides[1].texts[0].offset"));
  expect(Math.abs(offset[0]) + Math.abs(offset[1])).toBeGreaterThan(0.02);
});

suite.test("while a text is selected the frame reveals it at full opacity", async (app) => {
  // The title has fade 0.6 and the playhead sits at the slide start; without
  // reveal the canvas around it stays dark.
  const lum = await app.evalJs(`(async () => {
    const wait = (ms) => new Promise((r) => setTimeout(r, ms));
    await wait(900);
    const canvas = document.querySelector(".preview-stage canvas");
    const g = canvas.getContext("2d");
    const d = g.getImageData(0, 0, canvas.width, canvas.height).data;
    let bright = 0;
    for (let i = 0; i < d.length; i += 64) if (d[i] > 200) bright++;
    return bright;
  })()`);
  expect(lum).toBeGreaterThan(0);
});

suite.test("splitting the title out makes a title-card slide", async (app) => {
  await app.evalJs(`(() => {
    const band = document.querySelector(".group-band");
    band.focus();
    band.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true, cancelable: true }));
    return true;
  })()`);
  await sleep(250); // member focus commits before the split reads it
  await app.evalJs(`document.querySelector(".group-band").dispatchEvent(
    new KeyboardEvent("keydown", { key: "Backspace", bubbles: true, cancelable: true })); true`);
  await waitFor(app, "(() => { const p = window.__editorStore.getState().project; return p.slides[2].cells.length === 0 && p.slides[2].texts.length === 1; })()");
});

suite.test("binding a title card into a photo carries the text along", async (app) => {
  await app.evalJs(dragSnippet);
  await app.evalJs(`window.__e2eDrag(${JSON.stringify(CARDS)}, 2, ${JSON.stringify(CARDS)}, 3)`);
  await waitFor(app, "(() => { const p = window.__editorStore.getState().project; return p.slides[2].texts.length === 1 && p.slides[2].cells.length === 1; })()");
});
