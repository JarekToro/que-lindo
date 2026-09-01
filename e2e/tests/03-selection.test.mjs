import { dropFiles, expect, IMG, makeSuite, st, waitFor } from "../harness.mjs";
import { sleep } from "../client.mjs";

const suite = makeSuite("Multi-selection & context menus");
export default suite;

const CARDS = ".arrange-grid .slide-card, .face-arrange .slide-card";

suite.test("shift-click ranges, cmd-click toggles", async (app) => {
  await dropFiles(
    app,
    [IMG("img_ONE.png"), IMG("img_THREE.png"), IMG("img_FOUR.png"), IMG("img_FIVE.png"), IMG("img_SIX.png")],
    6,
  );
  await app.evalJs(`(() => {
    const cards = document.querySelectorAll(${JSON.stringify(CARDS)});
    cards[1].dispatchEvent(new MouseEvent("click", { bubbles: true }));
    cards[3].dispatchEvent(new MouseEvent("click", { bubbles: true, shiftKey: true }));
    return true;
  })()`);
  await sleep(200);
  expect(await app.evalJs(st("selectedIds.length"))).toBe(3);
  await app.evalJs(`document.querySelectorAll(${JSON.stringify(CARDS)})[5]
    .dispatchEvent(new MouseEvent("click", { bubbles: true, metaKey: true }))`);
  await sleep(200);
  expect(await app.evalJs(st("selectedIds.length"))).toBe(4);
});

suite.test("shift+arrow extends the selection from the anchor", async (app) => {
  await app.evalJs(`${st("selectSlide(1, false)")}; true`);
  await sleep(250);
  for (let i = 0; i < 2; i++) {
    await app.evalJs(`document.querySelector(".arrange-grid").dispatchEvent(
      new KeyboardEvent("keydown", { key: "ArrowRight", shiftKey: true, bubbles: true, cancelable: true })); true`);
    await sleep(200); // each press reads the previous render's selection
  }
  expect(await app.evalJs(st("selectedIds.length"))).toBe(3);
});

suite.test("right-click on a multi-selection offers group / duplicate / hide", async (app) => {
  await app.evalJs(`(() => {
    const s = window.__editorStore.getState();
    s.setSelection(s.project.slides.slice(1, 4).map(x => x.id), 2);
    return true;
  })()`);
  await sleep(250);
  await app.evalJs(`(() => {
    const card = document.querySelectorAll(${JSON.stringify(CARDS)})[2];
    const r = card.getBoundingClientRect();
    card.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: r.left + 10, clientY: r.top + 10 }));
    return true;
  })()`);
  await waitFor(app, "!!document.querySelector('.context-menu')");
  const labels = await app.evalJs(
    "[...document.querySelectorAll('.context-menu button')].map(b => b.textContent)",
  );
  expect(labels.some((l) => l.startsWith("Group"))).toBe(true);
  expect(labels.some((l) => l.startsWith("Duplicate"))).toBe(true);
  expect(labels.some((l) => l.startsWith("Hide"))).toBe(true);
  await app.evalJs("window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' })); true");
});

suite.test("hide moves photos to the Not used shelf; the shelf restores them", async (app) => {
  await app.evalJs(`${st("selectSlide(2, false)")}; true`);
  await sleep(300);
  const before = await app.evalJs(st("project.slides.length"));
  await app.evalJs(`(() => {
    const card = document.querySelectorAll(${JSON.stringify(CARDS)})[2];
    const r = card.getBoundingClientRect();
    card.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: r.left + 10, clientY: r.top + 10 }));
    return true;
  })()`);
  await waitFor(app, "!!document.querySelector('.context-menu')");
  await app.evalJs(
    "[...document.querySelectorAll('.context-menu button')].find(b => b.textContent.startsWith('Hide'))?.click(); true",
  );
  await waitFor(app, st(`project.slides.length === ${before - 1}`));
  await waitFor(app, "document.querySelectorAll('.shelf-item').length >= 1");
  // restore via the shelf context menu
  await app.evalJs(`(() => {
    const item = document.querySelector(".shelf-item");
    const r = item.getBoundingClientRect();
    item.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: r.left + 8, clientY: r.top + 8 }));
    return true;
  })()`);
  await waitFor(app, "!!document.querySelector('.context-menu')");
  await app.evalJs(
    "[...document.querySelectorAll('.context-menu button')].find(b => b.textContent.startsWith('Add to'))?.click(); true",
  );
  await waitFor(app, st(`project.slides.length === ${before}`));
});

suite.test("Delete hides the selection; undo restores it as one step per action", async (app) => {
  const before = await app.evalJs(st("project.slides.length"));
  await app.evalJs(`(() => {
    const s = window.__editorStore.getState();
    s.setSelection(s.project.slides.slice(1, 3).map(x => x.id), 1);
    return true;
  })()`);
  await sleep(250);
  await app.evalJs(`document.querySelector(".arrange-grid").dispatchEvent(
    new KeyboardEvent("keydown", { key: "Delete", bubbles: true, cancelable: true })); true`);
  await waitFor(app, st(`project.slides.length === ${before - 2}`));
  await app.evalJs(`${st("undo()")}; true`);
  await waitFor(app, st(`project.slides.length === ${before}`));
});

suite.test("duplicate inserts a copy with a fresh id", async (app) => {
  const [count, id1] = await app.evalJs(
    `[${st("project.slides.length")}, ${st("project.slides[1].id")}]`,
  );
  await app.evalJs(`${st("selectSlide(1, false)")}; true`);
  await sleep(250);
  await app.evalJs(`document.querySelector(".arrange-grid").dispatchEvent(
    new KeyboardEvent("keydown", { key: "d", metaKey: true, bubbles: true, cancelable: true })); true`);
  await waitFor(app, st(`project.slides.length === ${count + 1}`));
  const [idA, idB] = await app.evalJs(
    `[${st("project.slides[1].id")}, ${st("project.slides[2].id")}]`,
  );
  expect(idA).toBe(id1);
  expect(idB === id1).toBe(false);
});
