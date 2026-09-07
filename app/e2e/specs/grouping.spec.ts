// Grouping & the band: binding cards into one slide and editing its members.
import { browser, $, $$, expect } from "@wdio/globals";
import { act, CARDS, clickWith, dom, dragHold, dragRelease, dragTo, IMG, importAndPlace, resetApp, store, waitForDom, waitForStore } from "../page/app.js";

const card = (idx: number) => ({ sel: CARDS, idx });

describe("Grouping & the band", () => {
  before(async () => {
    await resetApp();
    await importAndPlace([IMG("img_ONE.png"), IMG("img_THREE.png"), IMG("img_FOUR.png"), IMG("img_FIVE.png")], 5);
  });

  it("drop a card onto another → they bind into one slide", async () => {
    await dragTo(card(2), card(1));
    await waitForStore((s) => s.project.slides[1].cells.length === 2);
    expect(await store((s) => s.project.slides.length)).toBe(4);
  });

  it("the group card shows a member-count badge", async () => {
    await browser.pause(300);
    const texts = await dom(() => [...document.querySelectorAll(".arrange-grid .card-count")].map((b) => b.textContent));
    expect(texts).toContain("2");
  });

  it("Enter opens the band after its row, in flow", async () => {
    await (await $$(CARDS))[1].click();
    await browser.keys("Enter");
    await $(".group-band").waitForExist();
    expect((await $(".group-band").getSize()).height).toBeGreaterThan(100);
    expect(await dom(() => document.querySelectorAll(".band-member").length)).toBe(2);
  });

  it("dropping a photo into the open band joins the group", async () => {
    await dragTo(card(2), { sel: ".group-band" });
    await waitForStore((s) => s.project.slides[1].cells.length === 3);
    expect(await dom(() => document.querySelectorAll(".band-member").length)).toBe(3);
  });

  it("Backspace splits the focused member out, directly after the group", async () => {
    await $(".group-band").click();
    await browser.keys("Backspace");
    await waitForStore((s) => s.project.slides[1].cells.length === 2);
    expect(await store((s) => s.project.slides[2].cells.length === 1)).toBe(true);
  });

  it("splitting to one member dissolves the group", async () => {
    await $(".group-band").click();
    await browser.keys("Backspace");
    await waitForDom(() => !document.querySelector(".group-band"), undefined, 6000);
    expect(await store((s) => s.project.slides[1].cells.length)).toBe(1);
    expect(await store((s) => s.project.slides[1].layout.type)).toBe("single");
  });

  it("⌘G merges a multi-selection into one group, capped at 8 photos", async () => {
    await (await $$(CARDS))[1].click();
    await clickWith(card(3), { shift: true });
    await waitForStore((s) => s.selectedIds.length === 3);
    await $(".arrange-grid").click();
    await browser.keys(["Meta", "g"]);
    await waitForStore((s) => s.project.slides[1].cells.length === 3);
    expect(await store((s) => s.project.slides.length)).toBe(3);
  });

  it("the bind drop-target opens a visible empty seat", async () => {
    await dragHold(card(2), card(1));
    const seats = await dom(() => document.querySelectorAll(".thumb-seat").length);
    await dragRelease();
    expect(seats).toBe(1);
    await act((s) => s.selectSlide(1, true));
  });
});
