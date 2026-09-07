// Panels: dock, split, resize, Values scopes.
import { browser, $, expect } from "@wdio/globals";
import { act, dom, dragBy, IMG, importAndPlace, inspectorGroups, resetApp, setSlider, store, waitForDom } from "../page/app.js";

const dockButton = (i: number) => dom((n) => document.querySelectorAll<HTMLButtonElement>(".dock-toggle button")[n]?.click(), i);

describe("Panels: dock, split, resize, Values scopes", () => {
  before(async () => {
    await resetApp();
    await importAndPlace([IMG("img_ONE.png"), IMG("img_THREE.png")], 3);
  });

  it("the timeline docks left, right, bottom, and split", async () => {
    for (const [i, cls] of [
      [0, "dock-left"],
      [2, "dock-right"],
      [3, "dock-split"],
      [1, "dock-bottom"],
    ] as const) {
      await dockButton(i);
      await browser.pause(300);
      expect(await $(".app").getAttribute("class")).toContain(cls);
    }
  });

  it("split view shows Arrange and Time at once, independently collapsible", async () => {
    await dockButton(3);
    await waitForDom(() => !!document.querySelector(".face-arrange") && !!document.querySelector(".face-time"));
    await dom(() => [...document.querySelectorAll<HTMLButtonElement>(".face-time button")].find((b) => b.title.includes("Hide the Time"))?.click());
    await waitForDom(() => !document.querySelector(".face-time") && !!document.querySelector(".rail-bottom"));
    expect(await dom(() => !!document.querySelector(".face-arrange"))).toBe(true);
    await $(".rail-bottom").click();
    await waitForDom(() => !!document.querySelector(".face-time"));
  });

  it("splitter drags persist to localStorage", async () => {
    await dragBy({ sel: ".shell .splitter" }, 80, 0, 1, "corner");
    const prefs = await dom(() => JSON.parse(localStorage.getItem("slideshow-ui-prefs") ?? "{}") as { arrangeWidth?: unknown; dock?: string });
    expect(typeof prefs.arrangeWidth).toBe("number");
    expect(prefs.dock).toBe("split");
  });

  it("the inspector's scope follows the selection: slide, then a member, then back", async () => {
    await dockButton(1);
    await browser.pause(300);
    await act((s) => s.selectSlide(1, false), undefined, 300);
    let groups = await inspectorGroups();
    expect(groups).toContain("Timing");
    expect(groups).toContain("Arrangement");
    expect(await dom(() => document.querySelector(".scope-head")?.textContent ?? "")).toContain("Slide 2");
    // the member strip is the navigator: a photo chip scopes to that photo
    await dom(() => document.querySelector<HTMLElement>(".member-chip:not(.slide):not(.text) .chip-body")?.click());
    await browser.pause(300);
    groups = await inspectorGroups();
    expect(groups).toContain("Motion");
    expect(groups).toContain("Framing");
    expect(await dom(() => document.querySelector(".scope-head")?.textContent ?? "")).toContain("Photo");
    // the slide chip is the way back
    await dom(() => document.querySelector<HTMLElement>(".member-chip.slide .chip-body")?.click());
    await browser.pause(300);
    expect(await inspectorGroups()).toContain("Timing");
  });

  it("an inspector slider writes through to the model", async () => {
    await setSlider("Margin", 0.1);
    await browser.pause(300);
    expect(Math.abs((await store((s) => s.project.slides[1].margin)) - 0.1)).toBeLessThan(0.001);
  });

  it("Project & Music survives an empty selection state", async () => {
    const there = await dom(() => [...document.querySelectorAll(".inspector details.values summary")].some((s) => (s.textContent ?? "").includes("Project")));
    expect(there).toBe(true);
  });
});
