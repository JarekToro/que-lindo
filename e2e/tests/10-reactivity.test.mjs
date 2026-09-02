import { dropFiles, expect, IMG, makeSuite, st, waitFor } from "../harness.mjs";
import { sleep } from "../client.mjs";

// Cause → effect: an edit must visibly reach the rendered frame (or the
// timeline geometry). Frames are compared by sampled pixel deltas on the
// preview canvas, after the debounced project sync + a fresh render.

const suite = makeSuite("Preview reactivity");
export default suite;

const GRAB = `(() => {
  const c = document.querySelector(".preview-stage canvas");
  const d = c.getContext("2d").getImageData(0, 0, c.width, c.height).data;
  const out = [];
  for (let i = 0; i < d.length; i += 61) out.push(d[i]);
  return out;
})()`;

async function framesDiffer(app, mutationJs) {
  const before = await app.evalJs(GRAB);
  await app.evalJs(mutationJs);
  await sleep(1100); // 120ms sync debounce + render + blit
  const after = await app.evalJs(GRAB);
  let changed = 0;
  for (let i = 0; i < before.length; i++) if (Math.abs(before[i] - after[i]) > 10) changed++;
  return changed;
}

suite.test("setup: photos on screen, playhead parked mid-slide", async (app) => {
  await dropFiles(app, [IMG("img_ONE.png"), IMG("img_THREE.png"), IMG("img_FOUR.png")], 4);
  await app.evalJs(`(() => {
    const s = window.__editorStore.getState();
    s.selectSlide(1, false);
    const span = s.timing.spans[1];
    s.setTime((span.start + span.end) / 2); // mid-slide: motion is visible here
    return true;
  })()`);
  await waitFor(app, "!!document.querySelector('.preview-stage canvas') && !document.querySelector('.preview-stage canvas[hidden]')");
  await sleep(800);
  expect(await app.evalJs(st("selectedSlide"))).toBe(1);
});

suite.test("changing motion re-renders the frame", async (app) => {
  // Imported photos already zoom; Still is the guaranteed change.
  const changed = await framesDiffer(app, `(() => {
    const btn = [...document.querySelectorAll(".verb-row button")].find(b => b.textContent === "Still");
    btn?.click();
    return true;
  })()`);
  expect(changed).toBeGreaterThan(20);
});

suite.test("the margin slider letterboxes the photo live", async (app) => {
  await app.evalJs(`(() => {
    const v = document.querySelector(".inspector details.values");
    if (v) v.open = true;
    return true;
  })()`);
  await sleep(200);
  const changed = await framesDiffer(app, `(() => {
    const slider = [...document.querySelectorAll(".values input[type=range]")][0]; // Margin
    const set = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value").set;
    set.call(slider, "0.15");
    slider.dispatchEvent(new Event("input", { bubbles: true }));
    return true;
  })()`);
  expect(changed).toBeGreaterThan(20);
  expect(await app.evalJs(st("project.slides[1].margin"))).toBeCloseTo(0.15, 0.001);
});

suite.test("a custom background color shows up around the photo", async (app) => {
  const changed = await framesDiffer(app, `(() => {
    window.__editorStore.getState().mutate(p => ({ ...p, slides: p.slides.map((s, i) =>
      i === 1 ? { ...s, background: { type: "color", color: "#3355ff" } } : s) }));
    return true;
  })()`);
  expect(changed).toBeGreaterThan(10);
});

suite.test("adding a title paints it onto the frame", async (app) => {
  const changed = await framesDiffer(app, `(() => {
    const card = document.querySelectorAll(".arrange-grid .slide-card")[1];
    const r = card.getBoundingClientRect();
    card.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: r.left + 10, clientY: r.top + 10 }));
    setTimeout(() => {
      [...document.querySelectorAll(".context-menu button")].find(b => b.textContent.includes("Add title"))?.click();
    }, 150);
    return true;
  })()`);
  expect(changed).toBeGreaterThan(10);
});

suite.test("typing new text re-renders the overlay", async (app) => {
  await waitFor(app, "!!document.querySelector('.outcome textarea')");
  const changed = await framesDiffer(app, `(() => {
    const ta = document.querySelector(".outcome textarea");
    const set = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, "value").set;
    set.call(ta, "MMMMMMMMMMMM");
    ta.dispatchEvent(new Event("input", { bubbles: true }));
    return true;
  })()`);
  expect(changed).toBeGreaterThan(10);
});

suite.test("changing text alignment moves the block against its anchor", async (app) => {
  const changed = await framesDiffer(app, `(() => {
    window.__editorStore.getState().mutate(p => ({ ...p, slides: p.slides.map((s, i) =>
      i === 1 ? { ...s, texts: s.texts.map(t => ({ ...t, align: t.align === "right" ? "left" : "right" })) } : s) }));
    return true;
  })()`);
  expect(changed).toBeGreaterThan(5);
});

suite.test("Bigger grows the rendered text", async (app) => {
  const changed = await framesDiffer(app, `(() => {
    const btn = [...document.querySelectorAll(".verb-row button")].find(b => b.textContent === "Bigger");
    btn?.click(); btn?.click();
    return true;
  })()`);
  expect(changed).toBeGreaterThan(10);
});

suite.test("Shorter/Longer moves the whole timeline's geometry", async (app) => {
  await app.evalJs(`(() => {
    const s = window.__editorStore.getState();
    s.selectCell(null); s.selectText(null);
    return true;
  })()`);
  await sleep(250);
  const before = await app.evalJs(st("timing.total"));
  await app.evalJs(`(() => {
    const btn = [...document.querySelectorAll(".verb-row button")].find(b => b.textContent === "Longer");
    btn?.click();
    return true;
  })()`);
  await waitFor(app, `${st("timing.total")} > ${before + 0.5}`, 6000);
  expect(await app.evalJs(st("project.slides[1].duration"))).toBeGreaterThan(5);
});

suite.test("a transition change re-renders inside the seam", async (app) => {
  // park the playhead inside slide 2's transition-in window
  await app.evalJs(`(() => {
    const s = window.__editorStore.getState();
    const span = s.timing.spans[2];
    s.setTime(span.start + span.transition_in * 0.5);
    return true;
  })()`);
  await sleep(800);
  const changed = await framesDiffer(app, `(() => {
    window.__editorStore.getState().mutate(p => ({ ...p, slides: p.slides.map((s, i) =>
      i === 2 ? { ...s, transition: { kind: { type: "wipe", dir: "left" }, duration: s.transition.duration } } : s) }));
    return true;
  })()`);
  expect(changed).toBeGreaterThan(10);
});

suite.test("group layout changes recompose the frame", async (app) => {
  await app.evalJs(`(() => {
    const s = window.__editorStore.getState();
    s.mutate(p => {
      const cells = [...p.slides[1].cells, ...p.slides[2].cells].map(c => ({ ...c, fit: "cover", motion: { type: "none" } }));
      const slides = p.slides.map((sl, i) => i === 1
        ? { ...sl, cells, layout: { type: "columns", weights: [] }, margin: 0.04 } : sl)
        .filter((_, i) => i !== 2);
      return { ...p, slides };
    });
    s.selectSlide(1, true);
    return true;
  })()`);
  await sleep(900);
  const changed = await framesDiffer(app, `(() => {
    window.__editorStore.getState().mutate(p => ({ ...p, slides: p.slides.map((s, i) =>
      i === 1 ? { ...s, layout: { type: "featured", side: "left", ratio: 0.62 } } : s) }));
    return true;
  })()`);
  expect(changed).toBeGreaterThan(20);
});

suite.test("a no-op edit does not bump the revision or the frame", async (app) => {
  const revBefore = await app.evalJs(st("rev"));
  const changed = await framesDiffer(app, `(() => {
    window.__editorStore.getState().mutate(p => p); // identical object
    return true;
  })()`);
  expect(await app.evalJs(st("rev"))).toBe(revBefore);
  expect(changed).toBeLessThan(3);
});
