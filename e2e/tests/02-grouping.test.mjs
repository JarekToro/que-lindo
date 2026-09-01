import { dragSnippet, dropFiles, expect, IMG, makeSuite, st, waitFor } from "../harness.mjs";
import { sleep } from "../client.mjs";

const suite = makeSuite("Grouping & the band");
export default suite;

const CARDS = ".arrange-grid .slide-card, .face-arrange .slide-card";

suite.test("drop a card onto another → they bind into one slide", async (app) => {
  await dropFiles(
    app,
    [IMG("img_ONE.png"), IMG("img_THREE.png"), IMG("img_FOUR.png"), IMG("img_FIVE.png")],
    5,
  );
  await app.evalJs(dragSnippet);
  const r = await app.evalJs(`window.__e2eDrag(${JSON.stringify(CARDS)}, 2, ${JSON.stringify(CARDS)}, 1)`);
  expect(r).toBe("ok");
  await waitFor(app, st("project.slides[1].cells.length === 2"));
  expect(await app.evalJs(st("project.slides.length"))).toBe(4);
});

suite.test("the group card shows a member-count badge", async (app) => {
  await sleep(300);
  const hasTwoBadge = await app.evalJs(
    "[...document.querySelectorAll('.arrange-grid .card-count')].some(b => b.textContent === '2')",
  );
  expect(hasTwoBadge).toBe(true);
});

suite.test("Enter opens the band after its row, in flow", async (app) => {
  await app.evalJs(`(() => {
    const s = window.__editorStore.getState();
    s.selectSlide(1, false);
    const card = document.querySelectorAll(${JSON.stringify(CARDS)})[1];
    card.focus();
    card.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }));
    return true;
  })()`);
  await waitFor(app, "!!document.querySelector('.group-band')");
  const h = await app.evalJs(
    "Math.round(document.querySelector('.group-band').getBoundingClientRect().height)",
  );
  expect(h).toBeGreaterThan(100);
  expect(await app.evalJs("document.querySelectorAll('.band-member').length")).toBe(2);
});

suite.test("dropping a photo into the open band joins the group", async (app) => {
  await app.evalJs(dragSnippet);
  await app.evalJs(
    `window.__e2eDrag(${JSON.stringify(CARDS)}, 2, ".group-band", 0)`,
  );
  await waitFor(app, st("project.slides[1].cells.length === 3"));
  expect(await app.evalJs("document.querySelectorAll('.band-member').length")).toBe(3);
});

suite.test("Backspace splits the focused member out, directly after the group", async (app) => {
  await app.evalJs(`(() => {
    const band = document.querySelector(".group-band");
    band.focus();
    band.dispatchEvent(new KeyboardEvent("keydown", { key: "Backspace", bubbles: true, cancelable: true }));
    return true;
  })()`);
  await waitFor(app, st("project.slides[1].cells.length === 2"));
  const nextHasCell = await app.evalJs(st("project.slides[2].cells.length === 1"));
  expect(nextHasCell).toBe(true);
});

suite.test("splitting to one member dissolves the group", async (app) => {
  await app.evalJs(`(() => {
    const band = document.querySelector(".group-band");
    band.focus();
    band.dispatchEvent(new KeyboardEvent("keydown", { key: "Backspace", bubbles: true, cancelable: true }));
    return true;
  })()`);
  await waitFor(app, "!document.querySelector('.group-band')", 6000);
  expect(await app.evalJs(st("project.slides[1].cells.length"))).toBe(1);
  expect(await app.evalJs(st("project.slides[1].layout.type"))).toBe("single");
});

suite.test("⌘G merges a multi-selection into one group, capped at 8 photos", async (app) => {
  await app.evalJs(`(() => {
    const s = window.__editorStore.getState();
    s.setSelection(s.project.slides.slice(1, 4).map(x => x.id), 1);
    return true;
  })()`);
  await sleep(250); // the key handler reads render-scope selection
  await app.evalJs(`(() => {
    const grid = document.querySelector(".arrange-grid, .face-arrange .arrange-grid");
    grid.dispatchEvent(new KeyboardEvent("keydown", { key: "g", metaKey: true, bubbles: true, cancelable: true }));
    return true;
  })()`);
  await waitFor(app, st("project.slides[1].cells.length === 3"));
  expect(await app.evalJs(st("project.slides.length"))).toBe(3);
});

suite.test("the bind drop-target opens a visible empty seat", async (app) => {
  await app.evalJs(dragSnippet);
  await app.evalJs(`(async () => {
    const wait = (ms) => new Promise((r) => setTimeout(r, ms));
    const cards = document.querySelectorAll(${JSON.stringify(CARDS)});
    const src = cards[2], dst = cards[1];
    const pe = (el, type, x, y) => el.dispatchEvent(new PointerEvent(type, { bubbles: true, cancelable: true, clientX: x, clientY: y, pointerId: 998, isPrimary: true, button: 0, buttons: 1 }));
    const sr = src.getBoundingClientRect();
    pe(src, "pointerdown", sr.left + 10, sr.top + 10);
    pe(src, "pointermove", sr.left + 22, sr.top + 18);
    await wait(60);
    const dr = dst.getBoundingClientRect();
    pe(src, "pointermove", dr.left + dr.width / 2, dr.top + dr.height / 2);
    await wait(180);
    window.__seatVisible = document.querySelectorAll(".thumb-seat").length;
    pe(src, "pointerup", sr.left, sr.top - 200); // drop nowhere
    return true;
  })()`);
  expect(await app.evalJs("window.__seatVisible")).toBe(1);
});
