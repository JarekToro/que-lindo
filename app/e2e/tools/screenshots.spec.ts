// README screenshots. Not part of the default run; invoke explicitly:
//
//   e2e/tools/fetch-shot-media.sh
//   SHOT_MEDIA=$PWD/e2e/tools/shot-media SHOT_OUT=$PWD/../docs/screenshots \
//     npx wdio run e2e/wdio.conf.ts --spec e2e/tools/screenshots.spec.ts
//
// SHOT_MEDIA holds photos, an optional clip and an mp3; fetch-shot-media.sh
// fills it with the pinned Unsplash set the committed shots were taken from.
// SHOT_OUT receives numbered JPEGs at the window's native (retina) resolution.
import { browser, $, $$ } from "@wdio/globals";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, rmSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { act, CARDS, clickButton, dom, dragTo, dropFiles, resetApp, setMode, setValue, store, waitForDom, waitForImport, waitForStore } from "../page/app.js";

const MEDIA = process.env.SHOT_MEDIA ?? "";
const OUT = process.env.SHOT_OUT ?? "";

// WebDriver only writes PNG, which is the wrong container once the frames hold
// photographs rather than flat colour: the same five captures are 15 MB as PNG
// and under 3 MB as JPEG, indistinguishable at the size a README renders them.
// Re-encode with the ffmpeg sidecar the app itself resolves at runtime.
const TRIPLE = process.platform === "darwin"
  ? (process.arch === "arm64" ? "aarch64-apple-darwin" : "x86_64-apple-darwin")
  : "x86_64-unknown-linux-gnu";
const SIDECAR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "src-tauri", "binaries", `ffmpeg-${TRIPLE}`);

describe("README screenshots", () => {
  it("captures the main views", async () => {
    if (!MEDIA || !OUT) throw new Error("set SHOT_MEDIA and SHOT_OUT");
    const files = readdirSync(MEDIA)
      .filter((f) => /\.(jpe?g|png|mp4|mov|mp3|m4a)$/i.test(f))
      .sort()
      .map((f) => path.join(MEDIA, f));
    mkdirSync(OUT, { recursive: true });
    const ffmpeg = existsSync(SIDECAR) ? SIDECAR : "ffmpeg";
    const shot = async (name: string) => {
      const png = path.join(OUT, `${name}.png`);
      await browser.saveScreenshot(png);
      execFileSync(ffmpeg, ["-v", "error", "-y", "-i", png, "-q:v", "3", path.join(OUT, `${name}.jpg`)]);
      rmSync(png);
    };

    await resetApp();
    await dropFiles(files);
    await waitForImport(files, 60_000);
    // The button stays disabled until every photo's fingerprint is in.
    await waitForDom(() => {
      const b = [...document.querySelectorAll<HTMLButtonElement>("button")].find((x) => (x.textContent ?? "").trim() === "Build slideshow");
      return !!b && !b.disabled;
    }, undefined, 60_000);
    await clickButton("Build slideshow");
    // A project with real slides asks first; the fresh title card should not,
    // but accept the dialog either way.
    await browser.pause(400);
    if (await dom(() => !!document.querySelector(".modal-backdrop"))) {
      await dom(() => document.querySelector<HTMLButtonElement>(".modal-backdrop button.primary")?.click());
    }
    await waitForStore((s) => s.project.slides.length >= 2 && s.project.slides[0].id.startsWith("auto-"), undefined, 60_000);
    console.log("BUILT", JSON.stringify(await store((s) => s.project.slides.map((sl) => [sl.cells.length, sl.layout.type]))));
    await browser.pause(2500); // thumbnails and the first frames
    await dom(() => [...document.querySelectorAll<HTMLButtonElement>(".shelf-item button")].find((b) => b.title === "Add as a music track")?.click());
    await waitForStore((s) => s.project.audio.length === 1);

    // A title card up front, named.
    await clickButton("Presets", ".topbar");
    await clickButton("Add title card (start)");
    await $("textarea[aria-label='Text content']").waitForExist();
    await setValue({ sel: "textarea[aria-label='Text content']" }, "Qué lindo");
    await act((s) => s.setTime(1.2), undefined, 1500);
    await shot("01-title");

    // A collage, opened as a band. Auto-build folds together only frames that
    // are near-identical, so across a set of distinct photographs it yields at
    // most a pair of lookalikes — which shows the band but not what a collage
    // is for. Bind the first four single-photo slides by hand instead, using
    // the same drop gesture the grouping spec drives; four cells is where
    // autoLayout reaches for a 2x2 grid.
    const groupIndex = await store((s) => s.project.slides.findIndex((sl) => sl.cells.length === 1 && sl.texts.length === 0));
    for (let n = 2; n <= 4; n++) {
      // Each bind removes the source, so the next single is always the card
      // immediately after the target.
      await dragTo({ sel: CARDS, idx: groupIndex + 1 }, { sel: CARDS, idx: groupIndex });
      await waitForStore((s, a) => s.project.slides[a.i].cells.length === a.n, { i: groupIndex, n });
    }
    await act((s, i) => s.selectSlide(i, true), groupIndex);
    await act((s, i) => {
      const span = s.timing!.spans[i];
      s.setTime((span.start + span.end) / 2);
    }, groupIndex);
    await (await $$(CARDS))[groupIndex].click(); // real click: focus for ↵
    await browser.keys("Enter");
    await waitForDom(() => !!document.querySelector(".group-band"));
    await browser.pause(1500);
    await shot("02-group");
    await browser.keys("Escape");

    // Leave the group as a scatter pile. The grid is already in 02, and the
    // pile — tilted prints with white borders, dealt around the faces — is
    // the arrangement worth a second look, so the Time view's preview shows
    // that instead of the same grid twice.
    await act((s, i) => s.selectSlide(i, true), groupIndex, 400);
    await $(".layout-picker button.layout-tile[title='Scatter']").click();
    await waitForStore((s, i) => s.project.slides[i].layout.type === "custom", groupIndex);

    // One photo, with its framing controls and the zoom aim handle.
    const photoIndex = await store((s) => s.project.slides.findIndex((sl) => sl.cells.length === 1 && sl.texts.length === 0));
    await act((s, i) => {
      s.selectSlide(i, true);
      s.selectCell(0);
      const span = s.timing!.spans[i];
      s.setTime((span.start + span.end) / 2);
    }, photoIndex, 1500);
    await shot("03-photo");

    // Time view with the waveform.
    await setMode("time");
    await act((s) => s.setPlaying(false));
    await waitForDom(() => {
      const c = document.querySelector<HTMLCanvasElement>(".audio-lane canvas");
      const g = c?.getContext("2d");
      if (!c || !g) return false;
      const d = g.getImageData(0, 0, c.width, c.height).data;
      for (let i = 3; i < d.length; i += 160) if (d[i] > 0) return true;
      return false;
    }, undefined, 20_000);
    // Park the playhead on a real slide: a fixed second lands on the title
    // card, whose black frame says nothing about the Time view.
    await act((s, i) => {
      const span = s.timing!.spans[i];
      s.setTime((span.start + span.end) / 2);
    }, groupIndex > 0 ? groupIndex : photoIndex, 1200);
    await shot("04-time");
    await setMode("arrange");

    // Export dialog.
    await clickButton("Export…", ".topbar");
    await $(".modal").waitForExist();
    await browser.pause(500);
    await shot("05-export");
    await browser.keys("Escape");
  });
});
