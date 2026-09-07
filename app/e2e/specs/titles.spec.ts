// Titles as members: the T chip, the band, the frame handle.
import { browser, $, expect } from "@wdio/globals";
import { CARDS, dom, doubleClick, dragBy, dragTo, IMG, importAndPlace, resetApp, store, waitForDom, waitForStore } from "../page/app.js";

const card = (idx: number) => ({ sel: CARDS, idx });

describe("Titles as members", () => {
  before(async () => {
    await resetApp();
    await importAndPlace([IMG("img_ONE.png"), IMG("img_THREE.png")], 3);
  });

  it("dragging the T Title chip onto a photo adds a title member", async () => {
    await dragTo({ sel: ".title-chip" }, card(1));
    await waitForStore((s) => s.project.slides[1].texts.length === 1);
    await browser.pause(300);
    // photo + title = a group of 2, badge on that card
    expect(await store((s) => s.project.slides[1].cells.length + s.project.slides[1].texts.length)).toBe(2);
    await waitForDom(() => document.querySelectorAll(".arrange-grid .slide-card, .face-arrange .slide-card")[1]?.querySelector(".card-count")?.textContent === "2", undefined, 5000);
  });

  it("the title renders in the card thumbnail", async () => {
    expect(await dom(() => document.querySelectorAll(".arrange-grid .slide-card, .face-arrange .slide-card")[1]?.querySelector(".thumb-text")?.textContent ?? null)).toBe("Title");
  });

  it("the band lists the title as a member; clicking it opens the editor", async () => {
    await doubleClick(card(1));
    await waitForDom(() => document.querySelectorAll(".band-member").length === 2);
    expect((await $$(".band-member.band-text")).length).toBe(1);
    await $(".band-member.band-text").click();
    await browser.pause(300);
    expect(await store((s) => s.selectedText)).toBe(0);
    await $("textarea[aria-label='Text content']").waitForExist();
  });

  it("the frame shows a draggable handle; dragging writes the offset", async () => {
    await $(".text-handle").waitForExist({ timeout: 8000 });
    await dragBy({ sel: ".text-handle" }, 62, 42, 1);
    const offset = await store((s) => s.project.slides[1].texts[0].offset);
    expect(Math.abs(offset[0]) + Math.abs(offset[1])).toBeGreaterThan(0.02);
  });

  it("while a text is selected the frame reveals it at full opacity", async () => {
    // The title has fade 0.6 and the playhead sits at the slide start; without
    // reveal the canvas around it stays dark.
    await browser.pause(900);
    const bright = await dom(() => {
      const canvas = document.querySelector<HTMLCanvasElement>(".preview-stage canvas");
      const g = canvas?.getContext("2d");
      if (!canvas || !g) return -1;
      const d = g.getImageData(0, 0, canvas.width, canvas.height).data;
      let n = 0;
      for (let i = 0; i < d.length; i += 64) if (d[i] > 200) n++;
      return n;
    });
    expect(bright).toBeGreaterThan(0);
  });

  it("splitting the title out makes a title-card slide", async () => {
    await $(".group-band").click();
    await browser.keys("ArrowRight");
    await browser.pause(250); // member focus commits before the split reads it
    await browser.keys("Backspace");
    await waitForStore((s) => s.project.slides[2].cells.length === 0 && s.project.slides[2].texts.length === 1);
  });

  it("binding a title card into a photo carries the text along", async () => {
    await dragTo(card(2), card(3));
    await waitForStore((s) => s.project.slides[2].texts.length === 1 && s.project.slides[2].cells.length === 1);
  });
});
