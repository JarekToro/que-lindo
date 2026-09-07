// Whole user journeys, each a chain of real gestures with asserts at every
// waypoint — the way an actual session flows.
import { browser, $, expect } from "@wdio/globals";
import { act, CARDS, clickButton, dom, dragTo, IMG, importAndPlace, pressKey, resetApp, setMode, setSlider, setValue, store, waitForDom, waitForStore } from "../page/app.js";

const card = (idx: number) => ({ sel: CARDS, idx });
const GRID = { sel: ".arrange-grid" };
const SAVE = "/tmp/e2e-flow.slideshow.json";

describe("User flows", () => {
  before(resetApp);

  it("flow: build a show — import, group, title, music, outro, audition, save, reopen", async () => {
    // 1 · import photos and a song
    await importAndPlace([IMG("img_ONE.png"), IMG("img_THREE.png"), IMG("img_FOUR.png"), IMG("img_FIVE.png"), IMG("music.mp3")], 5);

    // 2 · group two photos by drag
    await dragTo(card(2), card(1));
    await waitForStore((s) => s.project.slides[1].cells.length === 2);

    // 3 · title the group via the chip
    await dragTo({ sel: ".title-chip" }, card(1));
    await waitForStore((s) => s.project.slides[1].texts.length === 1);
    await $("textarea[aria-label='Text content']").waitForExist();
    await setValue({ sel: "textarea[aria-label='Text content']" }, "The Party");
    await waitForStore((s) => s.project.slides[1].texts[0].text === "The Party");

    // 4 · music from the shelf
    await clickButton("Music", ".shelf-item");
    await waitForStore((s) => s.project.audio.length === 1);

    // 5 · ending: last slide → Ends with → Black
    await act((s) => s.selectSlide(s.project.slides.length - 1, false), undefined, 300);
    await dom(() => {
      const group = [...document.querySelectorAll<HTMLElement>(".verb-group")].find((g) => (g.textContent ?? "").includes("Ends with"));
      [...(group?.querySelectorAll("button") ?? [])].find((b) => b.textContent === "Black")?.click();
    });
    await waitForStore((s) => s.project.outro.kind.type === "fade_black");

    // 6 · audition the group slide from the inspector's scope head
    await act((s) => s.selectSlide(1, false));
    await clickButton("▶ Slide", ".scope-head");
    await waitForStore((s) => s.playing === true, undefined, 5000);
    // The clock is the audio context, which only starts once the mix has been
    // rendered and decoded; on a slow machine that start-up outlasts the slide
    // itself, so give the audition its own budget before timing the stop.
    await waitForStore((s) => s.playing === false || s.time > s.timing!.spans[1].start + 0.2, undefined, 30_000, "audition never started playing");
    await waitForStore((s) => s.playing === false, undefined, 15_000); // stops on its own at the slide end
    const stoppedAt = await store((s) => s.time);
    const spanEnd = await store((s) => s.timing!.spans[1].end);
    expect(Math.abs(stoppedAt - spanEnd)).toBeLessThan(0.15);

    // 7 · save, wipe, reopen — the show survives whole
    const save = await browser.tauri.mock("plugin:dialog|save");
    await save.mockResolvedValue(SAVE);
    await clickButton("Save As…", ".topbar");
    await browser.pause(400);
    const open = await browser.tauri.mock("plugin:dialog|open");
    await open.mockResolvedValue(SAVE);
    await clickButton("Open…", ".topbar");
    await browser.pause(600);
    await browser.tauri.restoreAllMocks("plugin:dialog");
    const reopened = await store((s) => ({
      slides: s.project.slides.length,
      groupMembers: s.project.slides[1].cells.length + s.project.slides[1].texts.length,
      title: s.project.slides[1].texts[0]?.text,
      audio: s.project.audio.length,
      outro: s.project.outro.kind.type,
    }));
    expect(reopened.groupMembers).toBe(3);
    expect(reopened.title).toBe("The Party");
    expect(reopened.audio).toBe(1);
    expect(reopened.outro).toBe("fade_black");
    // thumbnails self-heal for the reopened project
    await waitForDom(() => document.querySelectorAll(".arrange-grid .slide-card img, .face-arrange .slide-card img").length >= 2, undefined, 15_000);
  });

  it("flow: pacing edit ripples through the Time strip", async () => {
    await setMode("time");
    try {
      await $(".time-strip").waitForExist();
      await act((s) => s.setPlaying(false), undefined, 600);
      const before = await store((s) => ({
        total: s.timing!.total,
        w: parseFloat(getComputedStyle(document.querySelectorAll(".time-row .slide-card")[1]).width),
      }));
      // make slide 2 four seconds longer from the inspector
      await act((s) => s.selectSlide(1, false));
      const duration = await store((s) => s.project.slides[1].duration);
      await setSlider("On screen", duration + 4);
      await waitForStore((s, t) => s.timing!.total >= t + 3.9, before.total, 8000);
      await browser.pause(600);
      const after = await dom(() => parseFloat(getComputedStyle(document.querySelectorAll(".time-row .slide-card")[1]).width));
      expect(Math.abs(after - before.w - 4 * 24)).toBeLessThan(8);
    } finally {
      await setMode("arrange"); // the flows after this one start from the grid
    }
  });

  it("flow: rearrange, then walk the undo chain back home", async () => {
    const order0 = await store((s) => s.project.slides.map((sl) => sl.id));
    // keyboard move
    await act((s) => s.selectSlide(1, false));
    await pressKey(GRID, "ArrowRight", { alt: true });
    await browser.pause(300);
    // drag reorder: put card 3 before card 1
    await dragTo(card(3), card(1), "left");
    await browser.pause(400);
    const order1 = await store((s) => s.project.slides.map((sl) => sl.id));
    expect(JSON.stringify(order1) === JSON.stringify(order0)).toBe(false);
    // two undos restore the original order exactly
    await act((s) => s.undo(), undefined, 200);
    await act((s) => s.undo(), undefined, 300);
    expect(await store((s) => s.project.slides.map((sl) => sl.id))).toEqual(order0);
  });

  it("flow: hide two photos, rescue one, discard one", async () => {
    const slides0 = await store((s) => s.project.slides.length);
    const media0 = await store((s) => s.media.length);
    await act((s) => s.setSelection(s.project.slides.slice(2, 4).map((x) => x.id), 2));
    await pressKey(GRID, "Delete");
    await waitForStore((s, n) => s.project.slides.length === n, slides0 - 2);
    await waitForDom(() => document.querySelectorAll(".shelf-item").length >= 2, undefined, 6000);
    // rescue one back into the film
    await dom(() => [...document.querySelectorAll<HTMLButtonElement>(".shelf-item button")].find((b) => b.title.includes("Add to the timeline"))?.click());
    await waitForStore((s, n) => s.project.slides.length === n, slides0 - 1);
    // discard the other from the project entirely
    await dom(() => {
      const item = [...document.querySelectorAll<HTMLElement>(".shelf-item")].find((el) => el.querySelector("button[title*='Add to the timeline']"));
      item?.querySelector<HTMLButtonElement>("button[title='Remove from the project']")?.click();
    });
    await waitForStore((s, n) => s.media.length === n, media0 - 1, 6000);
  });
});
