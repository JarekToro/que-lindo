// Multi-selection & context menus.
import { browser, $, $$, expect } from "@wdio/globals";
import { act, CARDS, clickWith, contextMenu, IMG, importAndPlace, pickMenu, pressKey, resetApp, store, waitForDom, waitForStore } from "../page/app.js";

const GRID = { sel: ".arrange-grid" };

const card = (idx: number) => ({ sel: CARDS, idx });

describe("Multi-selection & context menus", () => {
  before(async () => {
    await resetApp();
    await importAndPlace(
      [IMG("img_ONE.png"), IMG("img_THREE.png"), IMG("img_FOUR.png"), IMG("img_FIVE.png"), IMG("img_SIX.png")],
      6,
    );
  });

  it("shift-click ranges, cmd-click toggles", async () => {
    await (await $$(CARDS))[1].click();
    await clickWith(card(3), { shift: true });
    await waitForStore((s) => s.selectedIds.length === 3);
    await clickWith(card(5), { meta: true });
    await waitForStore((s) => s.selectedIds.length === 4);
  });

  it("shift+arrow extends the selection from the anchor", async () => {
    await (await $$(CARDS))[1].click();
    await browser.pause(250);
    for (let i = 0; i < 2; i++) {
      await pressKey(GRID, "ArrowRight", { shift: true }); // each press reads the previous render's selection
    }
    await waitForStore((s) => s.selectedIds.length === 3);
  });

  it("right-click on a multi-selection offers group / duplicate / hide", async () => {
    await act((s) => s.setSelection(s.project.slides.slice(1, 4).map((x) => x.id), 2));
    const labels = await contextMenu(card(2));
    expect(labels.some((l) => l.startsWith("Group"))).toBe(true);
    expect(labels.some((l) => l.startsWith("Duplicate"))).toBe(true);
    expect(labels.some((l) => l.startsWith("Hide"))).toBe(true);
    await browser.keys("Escape");
    await waitForDom(() => !document.querySelector(".context-menu"));
  });

  it("hide moves photos to the Not used shelf; the shelf restores them", async () => {
    await act((s) => s.selectSlide(2, false), undefined, 300);
    const before = await store((s) => s.project.slides.length);
    await contextMenu(card(2));
    await pickMenu("Hide");
    await waitForStore((s, n) => s.project.slides.length === n, before - 1);
    await $(".shelf-item").waitForExist();
    await contextMenu({ sel: ".shelf-item" });
    await pickMenu("Add to");
    await waitForStore((s, n) => s.project.slides.length === n, before);
  });

  it("Delete hides the selection; undo restores it as one step per action", async () => {
    const before = await store((s) => s.project.slides.length);
    await act((s) => s.setSelection(s.project.slides.slice(1, 3).map((x) => x.id), 1));
    await pressKey(GRID, "Delete");
    await waitForStore((s, n) => s.project.slides.length === n, before - 2);
    await browser.keys(["Meta", "z"]);
    await waitForStore((s, n) => s.project.slides.length === n, before);
  });

  it("duplicate inserts a copy with a fresh id", async () => {
    const [count, id1] = await store((s) => [s.project.slides.length, s.project.slides[1].id] as const);
    await (await $$(CARDS))[1].click();
    await browser.pause(250);
    await browser.keys(["Meta", "d"]);
    await waitForStore((s, n) => s.project.slides.length === n, count + 1);
    const [idA, idB] = await store((s) => [s.project.slides[1].id, s.project.slides[2].id] as const);
    expect(idA).toBe(id1);
    expect(idB === id1).toBe(false);
  });
});
