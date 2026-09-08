// Restore view: opens for a photo from the shelf menu and the inspector, owns
// the window while open, browses photos with the arrow keys, closes on Esc.
//
// The Python engine may or may not be installed on the machine running the
// suite (CI has none); either way the view must open and explain itself, so
// these specs accept both the pipeline panel and the setup notice.
import { browser, $, expect } from "@wdio/globals";
import { act, dom, IMG, importAndPlace, resetApp, store, waitForDom } from "../page/app.js";

const ONE = IMG("img_ONE.png");
const TWO = IMG("img_THREE.png");

describe("Restore view", () => {
  before(async () => {
    await resetApp();
    await importAndPlace([ONE, TWO], 2);
  });

  it("opens from the shelf's context menu", async () => {
    // Drop the last slide (THREE) so that photo sits on the shelf with an
    // entry to right-click; slide 0 is the empty project's title card.
    await act((s) => s.mutate((p) => ({ ...p, slides: p.slides.slice(0, -1) })));
    await waitForDom(() => document.querySelectorAll(".shelf-item").length === 1);
    await dom(() => {
      const item = document.querySelector<HTMLElement>(".shelf-item");
      item?.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, clientX: 300, clientY: 300 }));
    });
    await waitForDom(() => !!document.querySelector(".context-menu"));
    const clicked = await dom(() => {
      const b = [...document.querySelectorAll<HTMLButtonElement>(".context-menu button")].find((x) =>
        x.textContent?.includes("Restore photo"),
      );
      b?.click();
      return !!b;
    });
    expect(clicked).toBe(true);
    await waitForDom(() => !!document.querySelector(".restore"));
    expect(await store((s) => s.restoring)).toBe(TWO);
    // The film editor is gone while restoring.
    expect(await dom(() => !!document.querySelector(".topbar"))).toBe(false);
    expect(await $(".restore-title").getText()).toContain("img_THREE.png");
  });

  it("either the engine answers or the setup notice explains what to install", async () => {
    // The pipeline panel is always there; what proves the connection is the
    // "Engine on <device>" line (info fetched) or, without an install, the notice.
    await browser.waitUntil(
      () =>
        dom(
          () =>
            !!document.querySelector(".restore-setup") ||
            [...document.querySelectorAll(".restore-side .hint")].some((h) => (h.textContent ?? "").startsWith("Engine on")),
        ),
      { timeout: 90_000, timeoutMsg: "neither the setup notice nor the engine appeared" },
    );
    const state = await dom(() => (document.querySelector(".restore-setup") ? "setup" : "engine"));
    if (state === "setup") {
      expect(await $(".restore-setup").getText()).toContain("tools/restore/setup.sh");
    } else {
      expect(await dom(() => document.querySelectorAll(".restore-step").length)).toBeGreaterThan(0);
      expect(await dom(() => !document.querySelector(".restore-run")?.hasAttribute("disabled"))).toBe(true);
    }
  });

  it("arrow keys browse the shelf's photos; Esc returns to the film", async () => {
    await browser.keys("ArrowLeft");
    await browser.waitUntil(async () => (await store((s) => s.restoring)) === ONE, { timeout: 5_000 });
    await browser.keys("ArrowRight");
    await browser.waitUntil(async () => (await store((s) => s.restoring)) === TWO, { timeout: 5_000 });
    await browser.keys("Escape");
    await waitForDom(() => !document.querySelector(".restore") && !!document.querySelector(".topbar"));
    expect(await store((s) => s.restoring)).toBe(null);
  });

  it("opens from the inspector's Photo group", async () => {
    // Slide 1 holds ONE (slide 0 is the title card).
    await act((s) => s.selectSlide(1, false), undefined, 300);
    const clicked = await dom(() => {
      const b = [...document.querySelectorAll<HTMLButtonElement>(".inspector button")].find((x) =>
        x.textContent?.includes("Restore photo"),
      );
      b?.click();
      return !!b;
    });
    expect(clicked).toBe(true);
    await waitForDom(() => !!document.querySelector(".restore"));
    expect(await store((s) => s.restoring)).toBe(ONE);
    await browser.keys("Escape");
    await waitForDom(() => !document.querySelector(".restore"));
  });
});
