// Frame rendering: intro, outro, zoom focus, fit modes, the preview cache.
import { browser, $, expect } from "@wdio/globals";
import { act, countChanged, frameLuminance, grabFrame, IMG, importAndPlace, resetApp, store, waitForStore } from "../page/app.js";

async function lumAt(t: number): Promise<number> {
  await act((s, time) => s.setTime(time), t, 900);
  return frameLuminance();
}

describe("Frame rendering: intro, outro, zoom focus", () => {
  before(async () => {
    await resetApp();
    await importAndPlace([IMG("img_ONE.png"), IMG("img_THREE.png")], 3);
  });

  it("the first slide's transition plays as an intro from the background", async () => {
    // drop the default title card so a bright photo is first, with a 1s fade
    await act((s) =>
      s.mutate((p) => ({
        ...p,
        slides: p.slides.slice(1).map((sl, i) => (i === 0 ? { ...sl, transition: { kind: { type: "cross_fade" }, duration: 1.0 } } : sl)),
      })),
    );
    await waitForStore((s) => s.timing?.spans[0].transition_in === 1);
    const early = await lumAt(0.05);
    const settled = await lumAt(2.5);
    expect(settled).toBeGreaterThan(early + 20);
  });

  it("the outro fades the last frame into the background", async () => {
    await act((s) => s.mutate((p) => ({ ...p, outro: { kind: { type: "fade_black" }, duration: 1.5 } })), undefined, 500);
    const total = await store((s) => s.timing!.total);
    const mid = await lumAt(total - 3);
    const end = await lumAt(total - 0.05);
    expect(end).toBeLessThan(Math.max(mid / 2, 30));
  });

  it("moving the zoom focus visibly changes the rendered frame", async () => {
    const setOrigin = (o: [number, number]) =>
      act(
        (s, origin) =>
          s.mutate((p) => ({
            ...p,
            slides: p.slides.map((sl, i) =>
              i === 0 ? { ...sl, cells: sl.cells.map((c) => ({ ...c, motion: { type: "zoom", from: 2.0, to: 2.0, origin } })) } : sl,
            ),
          })),
        o,
        1100,
      );
    await act((s) => s.setTime(2.5));
    await setOrigin([0.1, 0.1]);
    const a = await grabFrame();
    await setOrigin([0.9, 0.9]);
    const b = await grabFrame();
    expect(countChanged(a, b, 12)).toBeGreaterThan(100);
  });

  it("zooming a whole-photo (contain) cell grows the box, not a crop inside it", async () => {
    const setZ = (z: number) =>
      act(
        (s, zoom) =>
          s.mutate((p) => ({
            ...p,
            slides: p.slides.map((sl, i) =>
              i === 1
                ? {
                    ...sl,
                    margin: 0.1,
                    background: { type: "color", color: "#000000" },
                    cells: sl.cells.map((c) => ({ ...c, fit: "contain", motion: { type: "zoom", from: zoom, to: zoom, origin: [0.5, 0.5] } })),
                  }
                : sl,
            ),
          })),
        z,
        1100,
      );
    const photoArea = () =>
      browser.execute(() => {
        const c = document.querySelector<HTMLCanvasElement>(".preview-stage canvas");
        const g = c?.getContext("2d");
        if (!c || !g) return -1;
        const d = g.getImageData(0, 0, c.width, c.height).data;
        let lit = 0;
        for (let i = 0; i < d.length; i += 64) if (d[i] + d[i + 1] + d[i + 2] > 45) lit++;
        return lit;
      });
    await act((s) => {
      const span = s.timing!.spans[1];
      s.setTime((span.start + span.end) / 2);
    });
    await setZ(1.0);
    const small = await photoArea();
    await setZ(1.6);
    const grown = await photoArea();
    // The letterbox must grow with the zoom (constant = the old bug), and the
    // slide margin must not cage it: a lone photo grows through the margin
    // toward the frame (margin-clipped growth measured only ~1.23×).
    expect(grown).toBeGreaterThan(small * 1.4);
  });

  it("the ◎ aim handle appears for a selected zooming photo", async () => {
    await act((s) => {
      s.selectSlide(0, true);
      s.selectCell(0);
    });
    await $(".zoom-handle").waitForExist({ timeout: 6000 });
  });

  it("preview frames come back as raw RGBA with a size header", async () => {
    const info = await browser.execute(async () => {
      const buf = (await window.__TAURI_INTERNALS__.invoke("render_preview", { time: 1, scale: 0.5, revealTexts: false, minRev: 0 })) as ArrayBuffer;
      const v = new DataView(buf);
      const w = v.getUint32(0, true);
      const h = v.getUint32(4, true);
      return { ok: buf.byteLength === 8 + w * h * 4, w, h };
    });
    expect(info.ok).toBe(true);
    expect(info.w).toBeGreaterThan(100);
  });

  it("the frame cache answers repeats instantly", async () => {
    const times = await browser.execute(async () => {
      const inv = (args: Record<string, unknown>) => window.__TAURI_INTERNALS__.invoke("render_preview", args);
      const t0 = performance.now();
      await inv({ time: 2.75, scale: 0.5, revealTexts: false, minRev: 0 });
      const cold = performance.now() - t0;
      const t1 = performance.now();
      await inv({ time: 2.75, scale: 0.5, revealTexts: false, minRev: 0 });
      return { cold, warm: performance.now() - t1 };
    });
    expect(times.warm).toBeLessThan(Math.max(times.cold, 20));
  });

  it("smart fit shifts the fill crop toward the stored face region", async () => {
    const setCell = (patch: Record<string, unknown>) =>
      act(
        (s, p) =>
          s.mutate((proj) => ({
            ...proj,
            slides: proj.slides.map((sl, i) => (i === 0 ? { ...sl, cells: sl.cells.map((c) => ({ ...c, motion: { type: "none" }, ...p })) } : sl)),
          })),
        patch,
        1100,
      );
    await act((s) => s.setTime(2.5));
    await setCell({ fit: "cover", smart_focus: null });
    const cover = await grabFrame();
    // A face box pinned to the top-left corner must drag the crop there.
    await setCell({ fit: "smart", smart_focus: { x: 0.0, y: 0.0, w: 0.2, h: 0.2 } });
    const smart = await grabFrame();
    await setCell({ fit: "cover", smart_focus: null });
    expect(countChanged(cover, smart, 12)).toBeGreaterThan(50);
  });

  it("smart fit with no stored region renders exactly like a centered fill", async () => {
    const setFit = (fit: string) =>
      act(
        (s, f) =>
          s.mutate((proj) => ({
            ...proj,
            slides: proj.slides.map((sl, i) => (i === 0 ? { ...sl, cells: sl.cells.map((c) => ({ ...c, motion: { type: "none" }, fit: f, smart_focus: null })) } : sl)),
          })),
        fit,
        1100,
      );
    await act((s) => s.setTime(2.5));
    await setFit("cover");
    const cover = await grabFrame();
    await setFit("smart");
    const smart = await grabFrame();
    expect(countChanged(cover, smart, 12)).toBeLessThan(20);
  });
});
