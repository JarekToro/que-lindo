// Shared helpers for the WebdriverIO suites. Interactions go through
// WebDriver (clicks, keys, pointer actions); the editor store is read for
// assertions the DOM cannot express and written only to arrange fixtures.

import { browser, $ } from "@wdio/globals";
import { IMG } from "./fixtures.js";

export const CARDS = ".arrange-grid .slide-card, .face-arrange .slide-card";

/** Minimal shape of the zustand store the tests reach into. Everything is
 * accessed through `browser.execute`, so this only has to be honest about the
 * members the specs use. */
export interface EditorState {
  project: {
    slides: Array<{
      id: string;
      duration: number;
      margin: number;
      cells: Array<{ source: { path: string }; motion: { type: string; origin?: [number, number] } }>;
      texts: Array<{ text: string; offset: [number, number] }>;
      transition: { kind: { type: string }; duration: number };
      layout: { type: string };
    }>;
    audio: Array<{ start: number; offset: number; duration: number | null; fade_in: number; fade_out: number; loop: boolean }>;
    outro: { kind: { type: string }; duration: number };
  };
  media: Array<{ path: string; status: string; info: { is_image: boolean; has_video: boolean; has_audio: boolean } }>;
  timing: { total: number; spans: Array<{ start: number; end: number; transition_in: number }> } | null;
  time: number;
  playing: boolean;
  playUntil: number | null;
  selectedSlide: number;
  selectedIds: string[];
  selectedText: number | null;
  selectedTrack: number | null;
  rev: number;
  past: unknown[];
  mode: "arrange" | "time";
  /** Photo open in the Restore view, or null. */
  restoring: string | null;
  setRestoring(path: string | null): void;
  mutate(fn: (p: EditorState["project"]) => EditorState["project"]): void;
  selectSlide(i: number, exclusive?: boolean): void;
  selectCell(i: number | null): void;
  selectText(i: number | null): void;
  setSelection(ids: string[], anchor: number): void;
  setTime(t: number): void;
  setPlaying(p: boolean): void;
  playSlide(i: number): void;
  undo(): void;
  redo(): void;
  removeMedia(path: string): void;
  refreshPreview(): void;
  replaceProject(p: EditorState["project"], meta: { path: string }): void;
}

declare global {
  interface Window {
    __editorStore: { getState(): EditorState };
    __TAURI_INTERNALS__: { invoke(cmd: string, args?: Record<string, unknown>): Promise<unknown> };
  }
}

/** Serialize a function + one argument, run it in the webview, JSON the
 * result back. Keeps WebdriverIO's element-transforming generics out of the
 * way and makes the "no closures" rule explicit. */
async function evalIn<T>(src: string, arg: unknown, withStore: boolean): Promise<T> {
  const out = await browser.execute(
    (payload: string): string => {
      const { src: code, arg: a, withStore: ws } = JSON.parse(payload) as { src: string; arg: unknown; withStore: boolean };
      const f = new Function("return " + code)() as (...xs: unknown[]) => unknown;
      const v = ws ? f(window.__editorStore.getState(), a) : f(a);
      return JSON.stringify(v === undefined ? null : v);
    },
    JSON.stringify({ src, arg: arg ?? null, withStore }),
  );
  return JSON.parse(out) as T;
}

/**
 * Run `fn` inside the webview against the store. `fn` is serialized, so it
 * must not close over spec-local variables: pass them through `arg`.
 */
export function store<T, A = undefined>(fn: (s: EditorState, arg: A) => T, arg?: A): Promise<T> {
  return evalIn<T>(fn.toString(), arg, true);
}

/** Run a store mutation and give React a beat to commit it. */
export async function act<A = undefined>(fn: (s: EditorState, arg: A) => void, arg?: A, settleMs = 250): Promise<void> {
  await store(fn, arg);
  await browser.pause(settleMs);
}

export const sleep = (ms: number): Promise<void> => browser.pause(ms);

/** Poll a store predicate (same serialization rule as `store`). */
export async function waitForStore<A = undefined>(
  pred: (s: EditorState, arg: A) => boolean,
  arg?: A,
  timeout = 10_000,
  msg?: string,
): Promise<void> {
  await browser.waitUntil(() => store(pred, arg), { timeout, timeoutMsg: msg ?? `timeout waiting for ${pred.toString()}` });
}

/** Evaluate a DOM expression once (same serialization rule as `store`). */
export function dom<T, A = undefined>(fn: (arg: A) => T, arg?: A): Promise<T> {
  return evalIn<T>(fn.toString(), arg, false);
}

/** Poll a DOM predicate. */
export async function waitForDom<A = undefined>(fn: (arg: A) => boolean, arg?: A, timeout = 10_000, msg?: string): Promise<void> {
  await browser.waitUntil(() => dom(fn, arg), { timeout, timeoutMsg: msg ?? `timeout waiting for ${fn.toString()}` });
}

/** Reload the webview → pristine store (empty project, empty shelf, default
 * panel layout). Persisted UI prefs would otherwise leak between suites. */
export async function resetApp(): Promise<void> {
  await browser.execute(() => {
    try {
      localStorage.clear();
    } catch {
      /* private mode */
    }
    location.reload();
  });
  await browser.waitUntil(
    () => browser.execute(() => !!window.__editorStore && !!document.querySelector(".app")).catch(() => false),
    { timeout: 20_000, timeoutMsg: "app did not come back after reload" },
  );
  await browser.pause(400); // initial project sync
}

/** Drop OS files onto the window (the real drag-drop import path). They
 * land on the "Not used" shelf; nothing is placed in the film. */
export async function dropFiles(paths: string[]): Promise<void> {
  await browser.execute((p: string[]) => {
    void window.__TAURI_INTERNALS__.invoke("plugin:event|emit", {
      event: "tauri://drag-drop",
      payload: { paths: p, position: { x: 0, y: 0 } },
    });
  }, paths);
}

/** Wait until every path has finished probing (ready or error). */
export async function waitForImport(paths: string[], timeout = 20_000): Promise<void> {
  await browser.waitUntil(
    () =>
      browser.execute((p: string[]) => {
        const media = window.__editorStore.getState().media;
        return p.every((x) => media.some((m) => m.path === x && m.status !== "pending"));
      }, paths),
    { timeout, timeoutMsg: "import did not settle" },
  );
}

/** Import through the Import button with the OS file dialog mocked to return
 * `paths`. Exercises the same pipeline as a real user click. */
export async function importViaDialog(paths: string[]): Promise<void> {
  const dialog = await browser.tauri.mock("plugin:dialog|open");
  await dialog.mockResolvedValue(paths);
  await $("button=+ Import").click();
  await waitForImport(paths);
  await browser.tauri.restoreAllMocks("plugin:dialog");
}

/** Place every ready photo/clip among `paths` at the end of the film, in
 * order, through the shelf's own "Add to the timeline" control. */
export async function placeInFilm(paths: string[], expectSlides: number): Promise<void> {
  for (const path of paths) {
    const visual = await store(
      (s, p) => s.media.some((m) => m.path === p && m.status === "ready" && (m.info.is_image || m.info.has_video)),
      path,
    );
    if (!visual) continue;
    const clicked = await dom((p) => {
      const item = [...document.querySelectorAll<HTMLElement>(".shelf-item")].find((el) => el.title === p);
      const btn = item?.querySelector<HTMLButtonElement>("button[title*='Add to the timeline']");
      btn?.click();
      return !!btn;
    }, path);
    if (!clicked) throw new Error(`no shelf entry for ${path}`);
    await browser.pause(250); // the shelf re-renders; the next lookup must see fresh nodes
  }
  await waitForStore((s, n) => s.project.slides.length >= n, expectSlides, 20_000, `expected ${expectSlides} slides`);
  await browser.pause(400); // debounced backend sync + thumbs settling
}

/** Import (drag-drop path) then place the visual files into the film. */
export async function importAndPlace(paths: string[], expectSlides: number): Promise<void> {
  await dropFiles(paths);
  await waitForImport(paths);
  await placeInFilm(paths, expectSlides);
}

// ---- gestures -------------------------------------------------------------
//
// tauri-plugin-wdio-webdriver 1.4 synthesizes pointer actions as MouseEvents
// without modifiers and has no contextmenu; the app's drag system listens for
// PointerEvents. Until that lands upstream, these helpers dispatch the real
// event types from inside the page. Keyboard input goes through `browser.keys`,
// which the driver handles properly (modifier state included).

/** An element addressed by selector + index, resolvable inside the page. */
export interface Target {
  sel: string;
  idx?: number;
}

type PointerScript = { target: Target; dst?: Target; zone?: string; dx?: number; dy?: number; steps?: number; from?: string; hold?: boolean };

/** Start an in-page pointer gesture and return once it has been dispatched.
 * The gesture itself runs asynchronously in the page (React drag handlers
 * need real time between moves), so callers pause for `settleMs`. */
async function pointerGesture(script: PointerScript, settleMs: number): Promise<void> {
  const started = await browser.execute(
    (payload: string): string => {
      const g = JSON.parse(payload) as PointerScript;
      const q = (t: Target) => document.querySelectorAll<HTMLElement>(t.sel)[t.idx ?? 0];
      const el = q(g.target);
      if (!el) return "missing source";
      const dstEl = g.dst ? q(g.dst) : null;
      if (g.dst && !dstEl) return "missing destination";
      const pe = (type: string, x: number, y: number, buttons: number) =>
        el.dispatchEvent(new PointerEvent(type, { bubbles: true, cancelable: true, clientX: x, clientY: y, pointerId: 977, isPrimary: true, button: 0, buttons }));
      const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
      const r = el.getBoundingClientRect();
      const from = g.from ?? "corner";
      const x0 = from === "start" ? r.left + 3 : from === "end" ? r.right - 3 : from === "center" ? r.left + r.width / 2 : r.left + 12;
      const y0 = from === "corner" ? r.top + 12 : r.top + r.height / 2;
      void (async () => {
        pe("pointerdown", x0, y0, 1);
        pe("pointermove", x0 + 12, y0 + 8, 1);
        await wait(60);
        let x1: number;
        let y1: number;
        if (dstEl) {
          const dr = dstEl.getBoundingClientRect();
          x1 = g.zone === "left" ? dr.left + 4 : g.zone === "right" ? dr.right - 4 : dr.left + dr.width / 2;
          y1 = dr.top + dr.height / 2;
          pe("pointermove", x1, y1, 1);
        } else {
          const steps = g.steps ?? 5;
          x1 = x0 + (g.dx ?? 0);
          y1 = y0 + (g.dy ?? 0);
          for (let i = 1; i <= steps; i++) {
            pe("pointermove", x0 + ((g.dx ?? 0) * i) / steps, y0 + ((g.dy ?? 0) * i) / steps, 1);
            await wait(40);
          }
        }
        await wait(160);
        if (g.hold) {
          (window as unknown as { __e2eRelease?: () => void }).__e2eRelease = () => pe("pointerup", r.left, r.top - 200, 0);
        } else {
          pe("pointerup", x1, y1, 0);
        }
      })();
      return "ok";
    },
    JSON.stringify(script),
  );
  if (started !== "ok") throw new Error(`gesture failed: ${started}`);
  await browser.pause(settleMs);
}

/** Pointer-drag `src` onto `dst`; `zone` picks the drop side of `dst`. */
export function dragTo(src: Target, dst: Target, zone: "center" | "left" | "right" = "center"): Promise<void> {
  return pointerGesture({ target: src, dst, zone }, 650);
}

/** Drag `src` over `dst` and keep the button down; inspect, then `dragRelease`. */
export function dragHold(src: Target, dst: Target): Promise<void> {
  return pointerGesture({ target: src, dst, hold: true }, 500);
}

/** Drop a held drag nowhere (above the source's original position). */
export async function dragRelease(): Promise<void> {
  await dom(() => (window as unknown as { __e2eRelease?: () => void }).__e2eRelease?.());
  await browser.pause(300);
}

/** Pointer-drag an element by a pixel delta (handles, clips, splitters). */
export function dragBy(target: Target, dx: number, dy: number, steps = 5, from: "center" | "start" | "end" | "corner" = "corner"): Promise<void> {
  return pointerGesture({ target, dx, dy, steps, from }, 60 + steps * 40 + 500);
}

/** Dispatch a keydown with modifiers on a specific element. Plain keys go
 * through `browser.keys`; this exists for modifier combos the driver's
 * key path does not reliably deliver, and for targeting a container. */
export async function pressKey(target: Target, key: string, mods: { shift?: boolean; meta?: boolean; alt?: boolean } = {}): Promise<void> {
  await dom(
    ({ t, k, m }) => {
      const el = document.querySelectorAll<HTMLElement>(t.sel)[t.idx ?? 0];
      el?.dispatchEvent(new KeyboardEvent("keydown", { key: k, bubbles: true, cancelable: true, shiftKey: !!m.shift, metaKey: !!m.meta, altKey: !!m.alt }));
    },
    { t: target, k: key, m: mods },
  );
  await browser.pause(200);
}

/** Double-click (the driver has no dblclick synthesis). */
export async function doubleClick(target: Target): Promise<void> {
  await dom((t) => {
    document.querySelectorAll<HTMLElement>(t.sel)[t.idx ?? 0]?.dispatchEvent(new MouseEvent("dblclick", { bubbles: true, cancelable: true }));
  }, target);
  await browser.pause(200);
}

/** Click with modifier keys (the driver's element click ignores them). */
export async function clickWith(target: Target, mods: { shift?: boolean; meta?: boolean; alt?: boolean } = {}): Promise<void> {
  await dom(
    ({ t, m }) => {
      const el = document.querySelectorAll<HTMLElement>(t.sel)[t.idx ?? 0];
      el?.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, shiftKey: !!m.shift, metaKey: !!m.meta, altKey: !!m.alt }));
    },
    { t: target, m: mods },
  );
  await browser.pause(200);
}

/** Open the context menu on an element and return its entries. */
export async function contextMenu(target: Target): Promise<string[]> {
  await dom((t) => {
    const el = document.querySelectorAll<HTMLElement>(t.sel)[t.idx ?? 0];
    if (!el) return;
    const r = el.getBoundingClientRect();
    el.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: r.left + 10, clientY: r.top + 10 }));
  }, target);
  await $(".context-menu").waitForExist();
  return dom(() => [...document.querySelectorAll(".context-menu button")].map((b) => b.textContent ?? ""));
}

/** Pick a context-menu entry by prefix. */
export async function pickMenu(prefix: string): Promise<void> {
  const ok = await dom((p) => {
    const b = [...document.querySelectorAll<HTMLButtonElement>(".context-menu button")].find((x) => (x.textContent ?? "").startsWith(p));
    b?.click();
    return !!b;
  }, prefix);
  if (!ok) throw new Error(`no context-menu entry starting with ${prefix}`);
  await browser.pause(150);
}

/** Set a React-controlled input/textarea value and fire input+change. */
export async function setValue(target: Target, value: string): Promise<void> {
  await dom(
    ({ t, v }) => {
      const el = document.querySelectorAll<HTMLInputElement | HTMLTextAreaElement>(t.sel)[t.idx ?? 0];
      if (!el) return;
      const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
      const set = Object.getOwnPropertyDescriptor(proto, "value")?.set;
      set?.call(el, v);
      el.dispatchEvent(new Event("input", { bubbles: true }));
      el.dispatchEvent(new Event("change", { bubbles: true }));
    },
    { t: target, v: value },
  );
  await browser.pause(200);
}

/** Set a labelled inspector slider (SliderField) through its range input. */
export async function setSlider(label: string, value: number): Promise<void> {
  const ok = await dom(
    ({ l, v }) => {
      const lab = [...document.querySelectorAll<HTMLLabelElement>(".inspector .vlabel")].find((x) => (x.textContent ?? "").trim() === l);
      const input = lab?.htmlFor ? document.getElementById(lab.htmlFor) : null;
      if (!(input instanceof HTMLInputElement)) return false;
      const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
      set?.call(input, String(v));
      input.dispatchEvent(new Event("input", { bubbles: true }));
      input.dispatchEvent(new Event("change", { bubbles: true }));
      return true;
    },
    { l: label, v: value },
  );
  if (!ok) throw new Error(`no slider labelled "${label}" in the inspector`);
  await browser.pause(250);
}

/** Current value of a labelled inspector slider. */
export function sliderValue(label: string): Promise<number> {
  return dom((l) => {
    const lab = [...document.querySelectorAll<HTMLLabelElement>(".inspector .vlabel")].find((x) => (x.textContent ?? "").trim() === l);
    const input = lab?.htmlFor ? document.getElementById(lab.htmlFor) : null;
    return input instanceof HTMLInputElement ? parseFloat(input.value) : NaN;
  }, label);
}

/** Labels of every value group currently shown in the inspector. */
export function inspectorGroups(): Promise<string[]> {
  return dom(() => [...document.querySelectorAll(".inspector .vgroup-label")].map((e) => (e.textContent ?? "").trim()));
}

/** Switch the timeline between Arrange and Time through its toggle. The
 * default split dock shows both faces and has no toggle, so this docks the
 * timeline to the bottom first when needed. */
export async function setMode(mode: "arrange" | "time"): Promise<void> {
  const hasToggle = await dom(() => document.querySelectorAll(".mode-toggle button").length === 2);
  if (!hasToggle) {
    await dom(() => document.querySelectorAll<HTMLButtonElement>(".dock-toggle button")[1]?.click()); // bottom
    await waitForDom(() => document.querySelectorAll(".mode-toggle button").length === 2, undefined, 5000);
  }
  await dom((m) => document.querySelectorAll<HTMLButtonElement>(".mode-toggle button")[m === "arrange" ? 0 : 1]?.click(), mode);
  await browser.pause(300);
}

/** Click a button by its visible text, searching every container that
 * matches `within` (exact text first, then substring). */
export async function clickButton(text: string, within = "body"): Promise<void> {
  const ok = await dom(
    ({ t, w }) => {
      const roots = [...document.querySelectorAll(w)];
      const buttons = roots.flatMap((r) => [...r.querySelectorAll<HTMLButtonElement>("button")]);
      const label = (b: HTMLButtonElement) => (b.textContent ?? "").trim();
      const b = buttons.find((x) => label(x) === t) ?? buttons.find((x) => label(x).includes(t));
      b?.click();
      return !!b;
    },
    { t: text, w: within },
  );
  if (!ok) throw new Error(`no button "${text}" in ${within}`);
  await browser.pause(200);
}

/** Sampled red-channel luminance of the preview canvas. */
export function frameLuminance(): Promise<number> {
  return browser.execute(() => {
    const canvas = document.querySelector<HTMLCanvasElement>(".preview-stage canvas");
    if (!canvas) return -1;
    const g = canvas.getContext("2d");
    if (!g) return -1;
    const d = g.getImageData(0, 0, canvas.width, canvas.height).data;
    let sum = 0;
    for (let i = 0; i < d.length; i += 64) sum += d[i];
    return Math.round(sum / (d.length / 64));
  });
}

/** Sparse sample of the preview canvas for before/after comparison. */
export function grabFrame(): Promise<number[]> {
  return browser.execute(() => {
    const c = document.querySelector<HTMLCanvasElement>(".preview-stage canvas");
    if (!c) return [];
    const g = c.getContext("2d");
    if (!g) return [];
    const d = g.getImageData(0, 0, c.width, c.height).data;
    const out: number[] = [];
    for (let i = 0; i < d.length; i += 61) out.push(d[i]);
    return out;
  });
}

export function countChanged(a: number[], b: number[], threshold = 10): number {
  let changed = 0;
  for (let i = 0; i < Math.min(a.length, b.length); i++) if (Math.abs(a[i] - b[i]) > threshold) changed++;
  return changed;
}

export { IMG };
