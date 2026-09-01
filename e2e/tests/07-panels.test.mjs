import { dropFiles, expect, IMG, makeSuite, st, waitFor } from "../harness.mjs";
import { sleep } from "../client.mjs";

const suite = makeSuite("Panels: dock, split, resize, Values scopes");
export default suite;

suite.test("the timeline docks left, right, bottom, and split", async (app) => {
  await dropFiles(app, [IMG("img_ONE.png"), IMG("img_THREE.png")], 3);
  for (const [i, cls] of [[0, "dock-left"], [2, "dock-right"], [3, "dock-split"], [1, "dock-bottom"]]) {
    await app.evalJs(`document.querySelectorAll(".dock-toggle button")[${i}]?.click(); true`);
    await sleep(300);
    const c = await app.evalJs("document.querySelector('.app').className");
    expect(c).toContain(cls);
  }
});

suite.test("split view shows Arrange and Time at once, independently collapsible", async (app) => {
  await app.evalJs("document.querySelectorAll('.dock-toggle button')[3]?.click(); true");
  await waitFor(app, "!!document.querySelector('.face-arrange') && !!document.querySelector('.face-time')");
  await app.evalJs(
    "[...document.querySelectorAll('.face-time button')].find(b => b.title.includes('Hide the Time'))?.click(); true",
  );
  await waitFor(app, "!document.querySelector('.face-time') && !!document.querySelector('.rail-bottom')");
  expect(await app.evalJs("!!document.querySelector('.face-arrange')")).toBe(true);
  await app.evalJs("document.querySelector('.rail-bottom')?.click(); true");
  await waitFor(app, "!!document.querySelector('.face-time')");
});

suite.test("splitter drags persist to localStorage", async (app) => {
  const w = await app.evalJs(`(async () => {
    const wait = (ms) => new Promise((r) => setTimeout(r, ms));
    const sp = document.querySelector(".shell .splitter");
    const r = sp.getBoundingClientRect();
    const pe = (type, x) => sp.dispatchEvent(new PointerEvent(type, { bubbles: true, cancelable: true, clientX: x, clientY: r.top + 40, pointerId: 995, buttons: 1, isPrimary: true }));
    pe("pointerdown", r.left + 2);
    pe("pointermove", r.left + 82);
    await wait(250);
    pe("pointerup", r.left + 82);
    return JSON.parse(localStorage.getItem("slideshow-ui-prefs"));
  })()`);
  expect(typeof w.arrangeWidth).toBe("number");
  expect(w.dock).toBe("split");
});

suite.test("Values scopes follow the selection", async (app) => {
  await app.evalJs("document.querySelectorAll('.dock-toggle button')[1]?.click(); true");
  await sleep(300);
  await app.evalJs(`(() => {
    window.__editorStore.getState().selectSlide(1, false);
    const v = document.querySelector(".inspector details.values");
    if (v) v.open = true;
    return true;
  })()`);
  await sleep(300);
  let groups = await app.evalJs(
    "[...document.querySelectorAll('.values .vgroup-label')].map(e => e.textContent)",
  );
  expect(groups).toContain("Members");
  expect(groups).toContain("Canvas");
  await app.evalJs("document.querySelector('.member-chip .chip-body')?.click(); true");
  await sleep(300);
  groups = await app.evalJs(
    "[...document.querySelectorAll('.values .vgroup-label')].map(e => e.textContent)",
  );
  expect(groups).toContain("Framing");
  expect(await app.evalJs("document.querySelector('.values-scope')?.textContent")).toContain("Photo");
});

suite.test("a Values slider writes through to the model", async (app) => {
  await app.evalJs(`(() => {
    // back to slide scope
    [...document.querySelectorAll(".outcome-head button")].find(b => b.textContent.includes("← Slide"))?.click();
    return true;
  })()`);
  await sleep(200);
  await app.evalJs(`(() => {
    const sliders = [...document.querySelectorAll(".values input[type=range]")];
    const margin = sliders[0]; // Margin
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value").set;
    setter.call(margin, "0.1");
    margin.dispatchEvent(new Event("input", { bubbles: true }));
    margin.dispatchEvent(new Event("change", { bubbles: true }));
    return true;
  })()`);
  await sleep(300);
  expect(await app.evalJs(st("project.slides[1].margin"))).toBeCloseTo(0.1, 0.001);
});

suite.test("Project & Music survives an empty selection state", async (app) => {
  const there = await app.evalJs(`(() => {
    const all = [...document.querySelectorAll(".inspector details.values summary")];
    return all.some(s => s.textContent.includes("Project"));
  })()`);
  expect(there).toBe(true);
});
