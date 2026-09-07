// README screenshots. Not part of the default run; invoke explicitly:
//
//   SHOT_MEDIA=/path/to/photos SHOT_OUT=/path/to/out \
//     npx wdio run e2e/wdio.conf.ts --spec e2e/tools/screenshots.spec.ts
//
// SHOT_MEDIA holds photos, an optional clip and an mp3; SHOT_OUT receives
// numbered PNGs at the window's native (retina) resolution.
import { browser, $, $$ } from "@wdio/globals";
import { readdirSync } from "node:fs";
import path from "node:path";
import { act, clickButton, dom, dropFiles, resetApp, setMode, setValue, store, waitForDom, waitForImport, waitForStore } from "../page/app.js";

const MEDIA = process.env.SHOT_MEDIA ?? "";
const OUT = process.env.SHOT_OUT ?? "";

describe("README screenshots", () => {
  it("captures the main views", async () => {
    if (!MEDIA || !OUT) throw new Error("set SHOT_MEDIA and SHOT_OUT");
    const files = readdirSync(MEDIA)
      .filter((f) => /\.(jpe?g|png|mp4|mov|mp3|m4a)$/i.test(f))
      .sort()
      .map((f) => path.join(MEDIA, f));
    const shot = (name: string) => browser.saveScreenshot(path.join(OUT, name));

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
    await setValue({ sel: "textarea[aria-label='Text content']" }, "Que lindo");
    await act((s) => s.setTime(1.2), undefined, 1500);
    await shot("01-title.png");

    // A collage, opened as a band.
    const groupIndex = await store((s) => s.project.slides.findIndex((sl) => sl.cells.length > 1));
    if (groupIndex > 0) {
      await act((s, i) => s.selectSlide(i, true), groupIndex);
      await act((s, i) => {
        const span = s.timing!.spans[i];
        s.setTime((span.start + span.end) / 2);
      }, groupIndex);
      await (await $$(".arrange-grid .slide-card, .face-arrange .slide-card"))[groupIndex].click(); // real click: focus for ↵
      await browser.keys("Enter");
      await waitForDom(() => !!document.querySelector(".group-band"));
      await browser.pause(1500);
      await shot("02-group.png");
      await browser.keys("Escape");
    }

    // One photo, with its framing controls and the zoom aim handle.
    const photoIndex = await store((s) => s.project.slides.findIndex((sl) => sl.cells.length === 1 && sl.texts.length === 0));
    await act((s, i) => {
      s.selectSlide(i, true);
      s.selectCell(0);
      const span = s.timing!.spans[i];
      s.setTime((span.start + span.end) / 2);
    }, photoIndex, 1500);
    await shot("03-photo.png");

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
    await act((s) => s.setTime(4), undefined, 1200);
    await shot("04-time.png");
    await setMode("arrange");

    // Export dialog.
    await clickButton("Export…", ".topbar");
    await $(".modal").waitForExist();
    await browser.pause(500);
    await shot("05-export.png");
    await browser.keys("Escape");
  });
});
