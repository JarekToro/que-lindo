// Import & the shelf: every way media enters the project.
import { browser, $, expect } from "@wdio/globals";
import {
  dom,
  dropFiles,
  IMG,
  importAndPlace,
  importViaDialog,
  resetApp,
  store,
  waitForDom,
  waitForImport,
  waitForStore,
} from "../page/app.js";

describe("Import & media shelf", () => {
  before(resetApp);

  it("a drop lands everything on the shelf and leaves the film alone", async () => {
    const before = await store((s) => s.project.slides.length);
    await dropFiles([IMG("img_TWO-portrait.png")]);
    await waitForStore((s) => s.media.some((m) => m.path.endsWith("img_TWO-portrait.png") && m.status === "ready"), undefined, 15_000);
    expect(await store((s) => s.project.slides.length)).toBe(before);
    await waitForDom(() => [...document.querySelectorAll<HTMLElement>(".shelf-item")].some((el) => el.title.endsWith("img_TWO-portrait.png")), undefined, 6000);
    await browser.execute((p: string) => window.__editorStore.getState().removeMedia(p), IMG("img_TWO-portrait.png"));
  });

  it("the Import button opens the file dialog and imports what it returns", async () => {
    const paths = [IMG("img_SIX.png")];
    await importViaDialog(paths);
    expect(await store((s) => s.media.some((m) => m.path.endsWith("img_SIX.png") && m.status === "ready"))).toBe(true);
    await browser.execute((p: string) => window.__editorStore.getState().removeMedia(p), paths[0]);
  });

  it("placed photos and clips keep drop order; audio stays on the shelf", async () => {
    await importAndPlace([IMG("img_ONE.png"), IMG("img_THREE.png"), IMG("clip.mp4"), IMG("music.mp3")], 4);
    const slides = await store((s) => s.project.slides.map((sl) => sl.cells[0]?.source.path ?? "none"));
    expect(slides.length).toBe(4); // title card + 3 visual
    expect(slides[1]).toContain("img_ONE");
    expect(slides[2]).toContain("img_THREE");
    expect(slides[3]).toContain("clip.mp4");
    const unusedAudio = await store((s) => s.media.filter((m) => m.status === "ready" && m.info.has_audio && !m.info.has_video).length);
    expect(unusedAudio).toBe(1);
  });

  it("thumbnails stream in as object URLs", async () => {
    await waitForDom(() => document.querySelectorAll(".arrange-grid .slide-card img, .face-arrange .slide-card img").length >= 3, undefined, 15_000);
    const src = await $(".slide-card img").getAttribute("src");
    expect((src ?? "").slice(0, 5)).toBe("blob:");
  });

  it("re-dropping the same files adds nothing", async () => {
    const before = await store((s) => s.project.slides.length);
    await dropFiles([IMG("img_ONE.png")]);
    await browser.pause(1500);
    expect(await store((s) => s.project.slides.length)).toBe(before);
  });

  it("a bogus path shows an error item, and stays out of the film", async () => {
    await dropFiles(["/tmp/does-not-exist-e2e.png"]);
    await waitForStore((s) => s.media.some((m) => m.status === "error"), undefined, 8000);
    expect(await store((s) => s.project.slides.length)).toBe(4);
  });

  it("focal detection returns null gracefully for faceless images", async () => {
    const focus = await browser.tauri.execute(({ core }, path: string) => core.invoke("detect_focus", { path }), IMG("img_ONE.png"));
    expect(focus).toBe(null); // testsrc patterns have no faces
  });

  it("imported photo slides carry aimed-or-centered zoom motion", async () => {
    const motions = await store((s) => s.project.slides.slice(1, 3).map((sl) => sl.cells[0].motion.type));
    expect(motions).toEqual(["zoom", "zoom"]);
    const origin = await store((s) => s.project.slides[1].cells[0].motion.origin);
    expect(origin?.length).toBe(2);
  });
});
