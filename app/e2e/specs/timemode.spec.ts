// Time mode: the strip, the ruler, the audio lane, clip drags.
import { browser, $, expect } from "@wdio/globals";
import { act, dom, dragBy, dropFiles, IMG, importAndPlace, resetApp, setMode, store, waitForDom, waitForImport, waitForStore } from "../page/app.js";

async function addMusicFromShelf(file: string, expectTracks: number): Promise<void> {
  await dropFiles([IMG(file)]);
  await waitForImport([IMG(file)]);
  const clicked = await dom((p) => {
    const item = [...document.querySelectorAll<HTMLElement>(".shelf-item")].find((el) => el.title === p);
    const btn = [...(item?.querySelectorAll("button") ?? [])].find((b) => (b.textContent ?? "").includes("Music"));
    btn?.click();
    return !!btn;
  }, IMG(file));
  expect(clicked).toBe(true);
  await waitForStore((s, n) => s.project.audio.length === n, expectTracks, 6000);
}

describe("Time mode", () => {
  before(async () => {
    await resetApp();
    await importAndPlace([IMG("img_ONE.png"), IMG("img_THREE.png"), IMG("clip.mp4")], 4);
    await waitForStore((s) => s.timing !== null);
  });

  it("card widths are proportional to the timing spans", async () => {
    await setMode("time");
    await $(".time-strip").waitForExist();
    await act((s) => s.setPlaying(false));
    await browser.pause(1400); // FLIP settles
    // Computed width, not the bounding rect: the mode-switch FLIP transform
    // can freeze mid-flight while the window isn't key, and this asserts the
    // proportional layout, not compositor timing.
    const widths = await store((s) => {
      const spans = s.timing!.spans;
      const total = s.timing!.total;
      return [...document.querySelectorAll(".time-row .slide-card")].map((c, i) => {
        const next = i + 1 < spans.length ? spans[i + 1].start : total;
        return { px: parseFloat(getComputedStyle(c).width), want: (next - spans[i].start) * 24 };
      });
    });
    for (const w of widths) expect(Math.abs(w.px - w.want)).toBeLessThan(2);
  });

  it("seam markers include the intro and the outro", async () => {
    const info = await store((s) => {
      const nonCut = s.project.slides.filter((sl) => sl.transition.kind.type !== "cut").length;
      const outro = s.project.outro.kind.type !== "cut" ? 1 : 0;
      return { expected: nonCut + outro, actual: document.querySelectorAll(".seam-marker").length };
    });
    expect(info.actual).toBe(info.expected);
  });

  it("scrubbing the ruler seeks proportionally", async () => {
    await dom(() => {
      const ruler = document.querySelector<HTMLElement>(".time-ruler");
      if (!ruler) return;
      const r = ruler.getBoundingClientRect();
      ruler.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, cancelable: true, clientX: r.left + 120, clientY: r.top + 5, pointerId: 996, buttons: 1, isPrimary: true }));
    });
    await browser.pause(300);
    expect(Math.abs((await store((s) => s.time)) - 5)).toBeLessThan(0.2); // 120px / 24px-per-s
  });

  it("the audio lane draws the mix waveform aligned to the clock", async () => {
    await addMusicFromShelf("music.mp3", 1);
    await waitForDom(() => {
      const c = document.querySelector<HTMLCanvasElement>(".audio-lane canvas");
      const g = c?.getContext("2d");
      if (!c || !g) return false;
      const d = g.getImageData(0, 0, c.width, c.height).data;
      for (let i = 3; i < d.length; i += 160) if (d[i] > 0) return true;
      return false;
    }, undefined, 15_000);
    await waitForDom(() => {
      const c = document.querySelector<HTMLCanvasElement>(".audio-lane canvas");
      const content = document.querySelector<HTMLElement>(".time-content");
      if (!c || !content || !content.style.width) return false;
      return Math.abs(c.getBoundingClientRect().width - parseFloat(content.style.width)) < 4;
    }, undefined, 10_000);
  });

  it("a second song chains after the first with a cross-fade; clips drag and trim", async () => {
    await addMusicFromShelf("music2.mp3", 2);
    await browser.pause(400);
    const snap = () =>
      store((s) => ({
        total: s.timing!.total,
        selectedTrack: s.selectedTrack,
        past: s.past.length,
        a: s.project.audio.map((t) => ({ start: t.start, offset: t.offset, duration: t.duration, fade_in: t.fade_in, fade_out: t.fade_out, loop: t.loop })),
        clips: document.querySelectorAll(".audio-clip").length,
        scope: document.querySelector(".scope-head")?.textContent ?? "",
      }));
    const placed = await snap();
    expect(placed.clips).toBe(2);
    // The 40s song outlasts the film, so on the film it ends where the film
    // does; the newcomer starts 3s before that, both fading across the overlap,
    // and only the last song loops.
    expect(placed.a[0].loop).toBe(false);
    expect(placed.a[0].fade_out).toBe(3);
    expect(Math.abs(placed.a[1].start - (placed.total - 3))).toBeLessThan(0.05);
    expect(placed.a[1].fade_in).toBe(3);
    expect(placed.a[1].loop).toBe(true);

    // Pointer drags on a clip: whole body moves it, either edge trims it.
    // 24 px per second: 240px is ten seconds.
    await dragBy({ sel: ".audio-clip", idx: 1 }, -240, 0, 6, "center");
    const moved = await snap();
    expect(Math.abs(moved.a[1].start - (placed.a[1].start - 10))).toBeLessThan(0.05);
    expect(moved.a[1].duration).toBe(null);
    expect(moved.selectedTrack).toBe(1);
    expect(moved.scope).toContain("Music ·");
    expect(moved.past).toBe(placed.past + 1); // one undo step for the whole drag

    await dragBy({ sel: ".audio-clip", idx: 1 }, -120, 0, 6, "end");
    const trimmedEnd = await snap();
    const lengthBefore = moved.total - moved.a[1].start; // looping: filled to the film's end
    expect(Math.abs((trimmedEnd.a[1].duration ?? 0) - (lengthBefore - 5))).toBeLessThan(0.05);
    expect(Math.abs(trimmedEnd.a[1].start - moved.a[1].start)).toBeLessThan(0.05);

    // Trimming the head keeps the music where it is: start and file offset
    // move together, so beat marks (kept in file time) stay on their beats.
    await dragBy({ sel: ".audio-clip", idx: 0 }, 48, 0, 6, "start");
    const trimmedHead = await snap();
    expect(Math.abs(trimmedHead.a[0].start - (placed.a[0].start + 2))).toBeLessThan(0.05);
    expect(Math.abs(trimmedHead.a[0].offset - (placed.a[0].offset + 2))).toBeLessThan(0.05);
    expect(trimmedHead.selectedTrack).toBe(0);
  });

  it("the playhead follows playback", async () => {
    await act((s) => {
      s.setTime(0);
      s.setPlaying(true);
    });
    await browser.pause(1500);
    await act((s) => s.setPlaying(false));
    const left = await dom(() => parseFloat(document.querySelector<HTMLElement>(".playhead")?.style.left ?? "0"));
    expect(left).toBeGreaterThan(10);
  });
});
