// Cause → effect: an edit must visibly reach the rendered frame (or the
// timeline geometry). Frames are compared by sampled pixel deltas on the
// preview canvas, after the debounced project sync + a fresh render.
import { browser, $, expect } from "@wdio/globals";
import { act, clickButton, contextMenu, countChanged, dom, grabFrame, IMG, importAndPlace, pickMenu, resetApp, setSlider, setValue, sliderValue, store, waitForDom, waitForStore } from "../page/app.js";

async function framesDiffer(mutation: () => Promise<void>): Promise<number> {
  const before = await grabFrame();
  await mutation();
  await browser.pause(1100); // 120ms sync debounce + render + blit
  const after = await grabFrame();
  return countChanged(before, after, 10);
}

const CARDS = ".arrange-grid .slide-card";

describe("Preview reactivity", () => {
  before(async () => {
    await resetApp();
    await importAndPlace([IMG("img_ONE.png"), IMG("img_THREE.png"), IMG("img_FOUR.png")], 4);
  });

  it("setup: photos on screen, playhead parked mid-slide", async () => {
    await act((s) => {
      s.selectSlide(1, false);
      const span = s.timing!.spans[1];
      s.setTime((span.start + span.end) / 2); // mid-slide: motion is visible here
    });
    await waitForDom(() => !!document.querySelector(".preview-stage canvas") && !document.querySelector(".preview-stage canvas[hidden]"));
    await browser.pause(800);
    expect(await store((s) => s.selectedSlide)).toBe(1);
  });

  it("changing motion re-renders the frame", async () => {
    // Imported photos already zoom; Still is the guaranteed change.
    expect(await framesDiffer(() => clickButton("Still", ".verb-row"))).toBeGreaterThan(20);
  });

  it("the Margin slider letterboxes the photo live", async () => {
    const changed = await framesDiffer(() => setSlider("Margin", 0.15));
    expect(changed).toBeGreaterThan(20);
    expect(Math.abs((await store((s) => s.project.slides[1].margin)) - 0.15)).toBeLessThan(0.001);
  });

  it("a custom background color shows up around the photo", async () => {
    const changed = await framesDiffer(() =>
      store((s) => s.mutate((p) => ({ ...p, slides: p.slides.map((sl, i) => (i === 1 ? { ...sl, background: { type: "color", color: "#3355ff" } } : sl)) }))),
    );
    expect(changed).toBeGreaterThan(10);
  });

  it("adding a title paints it onto the frame", async () => {
    const changed = await framesDiffer(async () => {
      await contextMenu({ sel: CARDS, idx: 1 });
      await pickMenu("Add title");
    });
    expect(changed).toBeGreaterThan(10);
  });

  it("typing new text re-renders the overlay", async () => {
    await $("textarea[aria-label='Text content']").waitForExist();
    const changed = await framesDiffer(() => setValue({ sel: "textarea[aria-label='Text content']" }, "MMMMMMMMMMMM"));
    expect(changed).toBeGreaterThan(10);
  });

  it("changing text alignment moves the block against its anchor", async () => {
    const changed = await framesDiffer(() =>
      store((s) =>
        s.mutate((p) => ({
          ...p,
          slides: p.slides.map((sl, i) => (i === 1 ? { ...sl, texts: sl.texts.map((t) => ({ ...t, align: (t as { align?: string }).align === "right" ? "left" : "right" })) } : sl)),
        })),
      ),
    );
    expect(changed).toBeGreaterThan(5);
  });

  it("a font change re-renders the title", async () => {
    const changed = await framesDiffer(() =>
      store((s) =>
        s.mutate((p) => ({
          ...p,
          slides: p.slides.map((sl, i) =>
            i === 1 ? { ...sl, texts: sl.texts.map((t) => ({ ...t, font: (t as { font?: string }).font === "Impact" ? "Courier New" : "Impact" })) } : sl,
          ),
        })),
      ),
    );
    expect(changed).toBeGreaterThan(5);
  });

  it("the Size slider grows the rendered text", async () => {
    const size = await sliderValue("Size");
    const changed = await framesDiffer(() => setSlider("Size", Math.min(0.3, size * 2)));
    expect(changed).toBeGreaterThan(10);
  });

  it("the On screen slider moves the whole timeline's geometry", async () => {
    // back to slide scope through the member strip
    await dom(() => document.querySelector<HTMLElement>(".member-chip.slide .chip-body")?.click());
    await browser.pause(250);
    const before = await store((s) => ({ total: s.timing!.total, duration: s.project.slides[1].duration }));
    await setSlider("On screen", before.duration + 4);
    await waitForStore((s, b) => s.timing!.total > b + 3.5, before.total, 6000);
    expect(await store((s) => s.project.slides[1].duration)).toBeGreaterThan(before.duration + 3.5);
  });

  it("a transition change re-renders inside the seam", async () => {
    // park the playhead inside slide 2's transition-in window
    await act((s) => {
      const span = s.timing!.spans[2];
      s.setTime(span.start + span.transition_in * 0.5);
    }, undefined, 800);
    const changed = await framesDiffer(() =>
      store((s) =>
        s.mutate((p) => ({
          ...p,
          slides: p.slides.map((sl, i) => (i === 2 ? { ...sl, transition: { kind: { type: "wipe", dir: "left" } as { type: string }, duration: sl.transition.duration } } : sl)),
        })),
      ),
    );
    expect(changed).toBeGreaterThan(10);
  });

  it("group layout changes recompose the frame", async () => {
    await act((s) => {
      s.mutate((p) => {
        const cells = [...p.slides[1].cells, ...p.slides[2].cells].map((c) => ({ ...c, fit: "cover", motion: { type: "none" } }));
        const slides = p.slides
          .map((sl, i) => (i === 1 ? { ...sl, cells, layout: { type: "columns", weights: [] } as { type: string }, margin: 0.04 } : sl))
          .filter((_, i) => i !== 2);
        return { ...p, slides };
      });
      s.selectSlide(1, true);
    }, undefined, 900);
    const changed = await framesDiffer(() =>
      store((s) =>
        s.mutate((p) => ({
          ...p,
          slides: p.slides.map((sl, i) => (i === 1 ? { ...sl, layout: { type: "featured", side: "left", ratio: 0.62 } as { type: string } } : sl)),
        })),
      ),
    );
    expect(changed).toBeGreaterThan(20);
  });

  it("a no-op edit does not bump the revision or the frame", async () => {
    const revBefore = await store((s) => s.rev);
    const changed = await framesDiffer(() => store((s) => s.mutate((p) => p))); // identical object
    expect(await store((s) => s.rev)).toBe(revBefore);
    expect(changed).toBeLessThan(3);
  });
});
