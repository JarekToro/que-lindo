import { dragSnippet, dropFiles, expect, IMG, makeSuite, st, waitFor } from "../harness.mjs";
import { sleep } from "../client.mjs";

// Whole user journeys, each a chain of real gestures with asserts at every
// waypoint — the way an actual session flows.

const suite = makeSuite("User flows");
export default suite;

const CARDS = ".arrange-grid .slide-card, .face-arrange .slide-card";
const SAVE = "/tmp/e2e-flow.slideshow.json";

suite.test("flow: build a show — import, group, title, music, outro, audition, save, reopen", async (app) => {
  // 1 · import photos and a song
  await dropFiles(
    app,
    [IMG("img_ONE.png"), IMG("img_THREE.png"), IMG("img_FOUR.png"), IMG("img_FIVE.png"), IMG("music.mp3")],
    5,
  );

  // 2 · group two photos by drag
  await app.evalJs(dragSnippet);
  await app.evalJs(`window.__e2eDrag(${JSON.stringify(CARDS)}, 2, ${JSON.stringify(CARDS)}, 1)`);
  await waitFor(app, st("project.slides[1].cells.length === 2"));

  // 3 · title the group via the chip
  await app.evalJs(dragSnippet);
  await app.evalJs(`window.__e2eDrag(".title-chip", 0, ${JSON.stringify(CARDS)}, 1)`);
  await waitFor(app, st("project.slides[1].texts.length === 1"));
  await app.evalJs(`(() => {
    const ta = document.querySelector(".outcome textarea");
    const set = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, "value").set;
    set.call(ta, "The Party");
    ta.dispatchEvent(new Event("input", { bubbles: true }));
    return true;
  })()`);
  await waitFor(app, st("project.slides[1].texts[0].text === 'The Party'"));

  // 4 · music from the shelf
  await app.evalJs(`(() => {
    [...document.querySelectorAll(".shelf-item button")].find(b => b.textContent.includes("Music"))?.click();
    return true;
  })()`);
  await waitFor(app, st("project.audio.length === 1"));

  // 5 · ending: last slide → Ends with → Black
  await app.evalJs(
    "(() => { const s = window.__editorStore.getState(); s.selectSlide(s.project.slides.length - 1, false); return true; })()",
  );
  await sleep(300);
  await app.evalJs(`(() => {
    const group = [...document.querySelectorAll(".verb-group")].find(g => g.textContent.includes("Ends with"));
    [...group.querySelectorAll("button")].find(b => b.textContent === "Black")?.click();
    return true;
  })()`);
  await waitFor(app, st("project.outro.kind.type === 'fade_black'"));

  // 6 · audition the group slide from the panel header
  await app.evalJs(`${st("selectSlide(1, false)")}; true`);
  await sleep(250);
  await app.evalJs(`(() => {
    [...document.querySelectorAll(".outcome-head button")].find(b => b.textContent.includes("▶"))?.click();
    return true;
  })()`);
  await waitFor(app, st("playing === true"), 5000);
  await waitFor(app, st("playing === false"), 15000); // stops on its own at the slide end
  const stoppedAt = await app.evalJs(st("time"));
  const spanEnd = await app.evalJs(st("timing.spans[1].end"));
  expect(stoppedAt).toBeCloseTo(spanEnd, 0.15);

  // 7 · save, wipe, reopen — the show survives whole
  await app.evalJs(`window.__TAURI_INTERNALS__.invoke("save_current_project", { path: ${JSON.stringify(SAVE)} })`);
  await sleep(300);
  await app.evalJs(`(async () => {
    const p = await window.__TAURI_INTERNALS__.invoke("load_project", { path: ${JSON.stringify(SAVE)} });
    window.__editorStore.getState().replaceProject(p, { path: ${JSON.stringify(SAVE)} });
    return true;
  })()`);
  await sleep(600);
  const reopened = await app.evalJs(`(() => {
    const p = window.__editorStore.getState().project;
    return {
      slides: p.slides.length,
      groupMembers: p.slides[1].cells.length + p.slides[1].texts.length,
      title: p.slides[1].texts[0]?.text,
      audio: p.audio.length,
      outro: p.outro.kind.type,
    };
  })()`);
  expect(reopened.groupMembers).toBe(3);
  expect(reopened.title).toBe("The Party");
  expect(reopened.audio).toBe(1);
  expect(reopened.outro).toBe("fade_black");
  // thumbnails self-heal for the reopened project
  await waitFor(app, "document.querySelectorAll('.arrange-grid .slide-card img, .face-arrange .slide-card img').length >= 2", 15000);
});

suite.test("flow: pacing edit ripples through the Time strip", async (app) => {
  await app.evalJs("document.querySelectorAll('.mode-toggle button')[1]?.click(); true");
  await waitFor(app, "!!document.querySelector('.time-strip')");
  await app.evalJs(`${st("setPlaying(false)")}; true`);
  await sleep(600);
  const before = await app.evalJs(`(() => {
    const s = window.__editorStore.getState();
    return { total: s.timing.total, w: parseFloat(getComputedStyle(document.querySelectorAll(".time-row .slide-card")[1]).width) };
  })()`);
  // make slide 2 four seconds longer from the panel
  await app.evalJs(`${st("selectSlide(1, false)")}; true`);
  await sleep(250);
  for (let i = 0; i < 4; i++) {
    await app.evalJs(`[...document.querySelectorAll(".verb-row button")].find(b => b.textContent === "Longer")?.click(); true`);
    await sleep(150);
  }
  await waitFor(app, `${st("timing.total")} >= ${before.total + 3.9}`, 8000);
  await sleep(600);
  const after = await app.evalJs(
    `parseFloat(getComputedStyle(document.querySelectorAll(".time-row .slide-card")[1]).width)`,
  );
  expect(after - before.w).toBeCloseTo(4 * 24, 8);
  await app.evalJs("document.querySelectorAll('.mode-toggle button')[0]?.click(); true");
  await sleep(400);
});

suite.test("flow: rearrange, then walk the undo chain back home", async (app) => {
  const order0 = await app.evalJs(st("project.slides.map(s => s.id)"));
  // keyboard move
  await app.evalJs(`${st("selectSlide(1, false)")}; true`);
  await sleep(250);
  await app.evalJs(`document.querySelector(".arrange-grid").dispatchEvent(
    new KeyboardEvent("keydown", { key: "ArrowRight", altKey: true, bubbles: true, cancelable: true })); true`);
  await sleep(300);
  // drag reorder: put card 3 before card 1
  await app.evalJs(dragSnippet);
  await app.evalJs(`window.__e2eDrag(${JSON.stringify(CARDS)}, 3, ${JSON.stringify(CARDS)}, 1, "left")`);
  await sleep(400);
  const order1 = await app.evalJs(st("project.slides.map(s => s.id)"));
  expect(JSON.stringify(order1) === JSON.stringify(order0)).toBe(false);
  // two undos restore the original order exactly
  await app.evalJs(`${st("undo()")}; true`);
  await sleep(200);
  await app.evalJs(`${st("undo()")}; true`);
  await sleep(300);
  const orderBack = await app.evalJs(st("project.slides.map(s => s.id)"));
  expect(orderBack).toEqual(order0);
});

suite.test("flow: hide two photos, rescue one, discard one", async (app) => {
  const slides0 = await app.evalJs(st("project.slides.length"));
  const media0 = await app.evalJs(st("media.length"));
  await app.evalJs(`(() => {
    const s = window.__editorStore.getState();
    s.setSelection(s.project.slides.slice(2, 4).map(x => x.id), 2);
    return true;
  })()`);
  await sleep(250);
  await app.evalJs(`document.querySelector(".arrange-grid").dispatchEvent(
    new KeyboardEvent("keydown", { key: "Delete", bubbles: true, cancelable: true })); true`);
  await waitFor(app, st(`project.slides.length === ${slides0 - 2}`));
  await waitFor(app, "document.querySelectorAll('.shelf-item').length >= 2", 6000);
  // rescue one back into the film
  await app.evalJs(`(() => {
    [...document.querySelectorAll(".shelf-item button")].find(b => b.title.includes("Add to the timeline"))?.click();
    return true;
  })()`);
  await waitFor(app, st(`project.slides.length === ${slides0 - 1}`));
  // discard the other from the project entirely
  await app.evalJs(`(() => {
    const item = [...document.querySelectorAll(".shelf-item")].find(el => el.querySelector("button[title*='Add to the timeline']"));
    item?.querySelector("button[title='Remove from the project']")?.click();
    return true;
  })()`);
  await waitFor(app, st(`media.length === ${media0 - 1}`), 6000);
});
