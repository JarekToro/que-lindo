// Shared helpers every e2e file uses: app reset, fixtures, DOM/pointer
// simulation snippets, and a tiny test runner with assertions.

import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { sleep } from "./client.mjs";

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export const MEDIA = path.join(ROOT, "examples", "media");

export function ensureFixtures() {
  if (!existsSync(path.join(MEDIA, "img_ONE.png"))) {
    execFileSync("bash", [path.join(ROOT, "examples", "make-test-media.sh")], {
      cwd: ROOT,
      stdio: "inherit",
    });
  }
}

export const IMG = (name) => path.join(MEDIA, name);

/** Reload the webview → pristine store (empty project, empty bin, default
 * panel layout — persisted UI prefs would otherwise leak between suites). */
export async function resetApp(app) {
  await app.evalJs("try { localStorage.clear(); } catch {} location.reload(); 'reloading'").catch(() => {});
  for (let i = 0; i < 40; i++) {
    await sleep(500);
    const ok = await app
      .evalJs("!!window.__editorStore && !!document.querySelector('.app')")
      .catch(() => false);
    if (ok === true) {
      await sleep(400); // initial project sync
      return;
    }
  }
  throw new Error("app did not come back after reload");
}

/** Drop OS files (the real import path) and wait for the timeline count. */
export async function dropFiles(app, paths, expectSlides) {
  await app.evalJs(`
    (async () => {
      await window.__TAURI_INTERNALS__.invoke("plugin:event|emit", {
        event: "tauri://drag-drop",
        payload: { paths: ${JSON.stringify(paths)}, position: { x: 0, y: 0 } },
      });
      return true;
    })()`);
  await waitFor(
    app,
    `window.__editorStore.getState().project.slides.length >= ${expectSlides}`,
    20000,
  );
  await sleep(400); // debounced backend sync + thumbs settling
}

export async function waitFor(app, expr, timeoutMs = 10000) {
  const start = Date.now();
  for (;;) {
    const v = await app.evalJs(`!!(${expr})`).catch(() => false);
    if (v === true) return;
    if (Date.now() - start > timeoutMs) throw new Error(`timeout waiting for: ${expr}`);
    await sleep(250);
  }
}

/** State snapshot helpers — everything the tests assert against. */
export const st = (expr) => `window.__editorStore.getState().${expr}`;

/** Pointer-drag one element onto another (the app's real drag system). */
export const dragSnippet = `
  window.__e2eDrag = async (srcSel, srcIdx, dstSel, dstIdx, zone = "center") => {
    const wait = (ms) => new Promise((r) => setTimeout(r, ms));
    const src = document.querySelectorAll(srcSel)[srcIdx];
    const dst = document.querySelectorAll(dstSel)[dstIdx];
    if (!src || !dst) return "missing element";
    const pe = (el, type, x, y) => el.dispatchEvent(new PointerEvent(type, {
      bubbles: true, cancelable: true, clientX: x, clientY: y,
      pointerId: 999, isPrimary: true, button: 0, buttons: 1,
    }));
    const sr = src.getBoundingClientRect();
    pe(src, "pointerdown", sr.left + 12, sr.top + 12);
    pe(src, "pointermove", sr.left + 24, sr.top + 20);
    await wait(60);
    const dr = dst.getBoundingClientRect();
    const x = zone === "left" ? dr.left + 4 : zone === "right" ? dr.right - 4 : dr.left + dr.width / 2;
    pe(src, "pointermove", x, dr.top + dr.height / 2);
    await wait(160);
    pe(src, "pointerup", x, dr.top + dr.height / 2);
    await wait(250);
    return "ok";
  };
  true`;

// ---- runner ----

export function makeSuite(name) {
  const tests = [];
  return {
    name,
    test: (title, fn) => tests.push({ title, fn }),
    tests,
  };
}

export function expect(actual) {
  const fail = (msg) => {
    throw new Error(`${msg} (got ${JSON.stringify(actual)})`);
  };
  return {
    toBe: (v) => {
      if (actual !== v) fail(`expected ${JSON.stringify(v)}`);
    },
    toEqual: (v) => {
      if (JSON.stringify(actual) !== JSON.stringify(v)) fail(`expected ${JSON.stringify(v)}`);
    },
    toBeTruthy: () => {
      if (!actual) fail("expected truthy");
    },
    toBeGreaterThan: (v) => {
      if (!(actual > v)) fail(`expected > ${v}`);
    },
    toBeLessThan: (v) => {
      if (!(actual < v)) fail(`expected < ${v}`);
    },
    toBeCloseTo: (v, eps = 0.05) => {
      if (Math.abs(actual - v) > eps) fail(`expected ≈ ${v} ±${eps}`);
    },
    toContain: (v) => {
      if (!actual?.includes?.(v)) fail(`expected to contain ${JSON.stringify(v)}`);
    },
  };
}
