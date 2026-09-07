// Persistence, undo, export. File dialogs are mocked to fixed /tmp paths so
// the real Save / Open / Export paths run end to end.
import { browser, expect } from "@wdio/globals";
import { act, clickButton, dragBy, IMG, importAndPlace, resetApp, store } from "../page/app.js";
import { $ } from "@wdio/globals";

const SAVE = "/tmp/e2e-roundtrip.slideshow.json";
const OUT = "/tmp/e2e-export.mp4";

describe("Persistence, undo, export", () => {
  before(async () => {
    await resetApp();
    await importAndPlace([IMG("img_ONE.png"), IMG("img_THREE.png"), IMG("music.mp3")], 3);
    await act((s) => s.mutate((p) => ({ ...p, outro: { kind: { type: "fade_black" }, duration: 2 } })));
    await clickButton("Music", ".shelf-item");
    await browser.pause(700);
  });

  it("save → load round-trips the whole project", async () => {
    const save = await browser.tauri.mock("plugin:dialog|save");
    await save.mockResolvedValue(SAVE);
    await clickButton("Save As…", ".topbar");
    await browser.waitUntil(() => browser.execute(() => !!document.querySelector(".topbar-title")?.textContent?.includes("e2e-roundtrip")), {
      timeout: 5000,
      timeoutMsg: "title bar did not pick up the saved file name",
    });
    const same = await browser.execute(async (path: string) => {
      const loaded = await window.__TAURI_INTERNALS__.invoke("load_project", { path });
      return JSON.stringify(loaded) === JSON.stringify(window.__editorStore.getState().project);
    }, SAVE);
    expect(same).toBe(true);
    await browser.tauri.restoreAllMocks("plugin:dialog");
  });

  it("placing a drop's photos lands as one undo step", async () => {
    const before = await store((s) => s.project.slides.length);
    await importAndPlace([IMG("img_FOUR.png"), IMG("img_FIVE.png"), IMG("img_SIX.png")], before + 3);
    // Three shelf clicks are three steps; the drag-drop placement is one.
    await act((s) => {
      s.undo();
      s.undo();
      s.undo();
    }, undefined, 300);
    expect(await store((s) => s.project.slides.length)).toBe(before);
    await act((s) => {
      s.redo();
      s.redo();
      s.redo();
    }, undefined, 300);
    expect(await store((s) => s.project.slides.length)).toBe(before + 3);
  });

  it("a frame drag coalesces into one undo step", async () => {
    await act((s) => {
      s.mutate((p) => ({
        ...p,
        slides: p.slides.map((sl, i) =>
          i === 1
            ? {
                ...sl,
                texts: [
                  {
                    text: "T", role: "title", font: null, weight: 400, italic: false, size: 0.08, color: "#ffffff", align: "center",
                    anchor: "center", offset: [0, 0], max_width: 0.85, line_height: 1.25, shadow: true, box_color: null,
                    start: 0, end: null, fade: 0.5, fade_out: null,
                  } as unknown as (typeof p.slides)[number]["texts"][number],
                ],
              }
            : sl,
        ),
      }));
      s.selectSlide(1, true);
      s.selectText(0);
    });
    await $(".text-handle").waitForExist({ timeout: 8000 });
    await dragBy({ sel: ".text-handle" }, 60, 40, 5);
    const offAfter = await store((s) => s.project.slides[1].texts[0].offset[0]);
    expect(Math.abs(offAfter)).toBeGreaterThan(0.01);
    await browser.keys(["Meta", "z"]);
    await browser.pause(300);
    expect(await store((s) => s.project.slides[1].texts[0].offset[0])).toBe(0);
  });

  it("export renders a playable MP4 of the right length", async () => {
    // Trim to two short slides for a fast encode.
    await act(
      (s) =>
        s.mutate((p) => ({ ...p, outro: { kind: { type: "cut" }, duration: 0 }, slides: p.slides.slice(0, 2).map((sl) => ({ ...sl, duration: 1.5 })) })),
      undefined,
      500,
    );
    await browser.execute(async (out: string) => {
      const project = window.__editorStore.getState().project;
      await window.__TAURI_INTERNALS__.invoke("export_video", { project, outPath: out, scale: 0.25, crf: 30 });
    }, OUT);
    // export_video returns as soon as the encode thread is spawned, so the
    // wait belongs here rather than inside one long-running execute: a failed
    // export would otherwise sit there until mocha killed the test with a bare
    // "Timeout" that says nothing about why. Completion shows up as a
    // probe-able MP4 — ffprobe fails until the file is finalized.
    let info: { has_video: boolean; duration: number } | null = null;
    await browser.waitUntil(
      async () => {
        info = await browser.execute(async (out: string) => {
          const r = (await window.__TAURI_INTERNALS__.invoke("probe_media", { path: out }).catch(() => null)) as { info: { has_video: boolean; duration: number } } | null;
          return r?.info ?? null;
        }, OUT);
        return !!info && info.has_video && info.duration > 0.5;
      },
      { timeout: 60_000, interval: 500, timeoutMsg: `export never produced a playable MP4 at ${OUT}` },
    );
    expect(info!.duration).toBeGreaterThan(1.5);
    expect(info!.has_video).toBe(true);
  });
});
