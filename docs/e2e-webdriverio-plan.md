# Plan: move e2e to WebdriverIO (the Tauri way)

Status: implemented 2026-09-07 (see "Spike results" at the end). Replaces the custom socket harness in `e2e/`
with the testing stack Tauri documents: WebDriver via WebdriverIO and
`@wdio/tauri-service`.

## What the ecosystem looks like today

Tauri's official test docs describe three layers: the mock runtime for Rust
unit tests, WebDriver for end-to-end, and `tauri-action` for CI. For
end-to-end, the docs say WebdriverIO is "the recommended way to use it with
Tauri", and that driven directly `tauri-driver` supports only Windows and
Linux "as macOS has no WKWebView driver tool available".

macOS is covered by one of these:

| Provider | macOS | How | Cost |
|---|---|---|---|
| `embedded` (default in `@wdio/tauri-service`) | yes | `tauri-plugin-wdio-webdriver` runs a W3C WebDriver HTTP server inside the debug app; 47 endpoints incl. actions, screenshots, alerts, cookies, frames | free, MIT |
| `external` (`tauri-driver` 2.0.6) | no | WebKitWebDriver on Linux, msedgedriver on Windows | free |
| `crabnebula` (`@crabnebula/tauri-driver` 2.0.9) | yes | fork of tauri-driver plus `tauri-plugin-automation`; needs `CN_API_KEY` | subscription for macOS |
| community: Choochmeque/tauri-webdriver, danielraffel/tauri-webdriver | yes | own embedded plugin + intermediary node | free, ~10 stars each |

Playwright is not an option: it drives its own bundled browsers, not the
WKWebView/WebView2/WebKitGTK the app actually runs in.

Versions as of 2026-09-06: `@wdio/tauri-service` 1.4.0, `@wdio/tauri-plugin`
1.4.0, `tauri-plugin-wdio` 1.4.0, `tauri-plugin-wdio-webdriver` 1.4.0
(requires tauri >= 2.10; we are on 2.11.5), WebdriverIO 9.31.6. The service
lives in the WebdriverIO org monorepo (`webdriverio/desktop-mobile`) under its
stable `latest` tag and is maintained by WebdriverIO's core team. It is young
(1.0 was three months ago) but it is the path both Tauri and WebdriverIO
document.

**Decision: embedded provider on macOS, WebdriverIO 9, Mocha framework,
TypeScript specs.** CrabNebula only if the embedded server turns out to lack
something we need; nothing in our tests suggests it will.

## What changes in the app

1. Cargo, in `app/src-tauri/Cargo.toml`:
   ```toml
   [dependencies]
   tauri-plugin-wdio = "1"

   [target.'cfg(debug_assertions)'.dependencies]
   tauri-plugin-wdio-webdriver = "1"
   ```
   Both registered under `#[cfg(debug_assertions)]` in `lib.rs`, next to the
   existing `mcp` feature block. The docs warn the webdriver plugin "exposes
   automation capabilities via HTTP. Never include it in production builds."
   Release builds already exclude it through `debug_assertions`; keeping the
   `wdio` plugin behind the same cfg keeps release clean of both.
2. Capability `wdio:default` added to `app/src-tauri/capabilities/default.json`.
   `tauri-build` scans capabilities unconditionally, which is why the mcp
   capability is added at runtime today; check whether `wdio:default`
   resolves in a release build without the plugin, else add it at runtime
   the same way.
3. `withGlobalTauri: true` in `tauri.conf.json` (required by the plugin).
4. `import "@wdio/tauri-plugin"` in `app/src/main.tsx`, guarded like the mcp
   import so production bundles do not carry it.
5. Test binary: `npm run tauri build -- --debug --no-bundle`. That produces
   `target/debug/slideshow-app` with the frontend embedded (no Vite server
   needed) and `debug_assertions` on (plugins present). Sidecars are copied
   next to it, so ffmpeg resolves. The service launches this binary itself
   with `TAURI_WEBDRIVER_PORT` set.
6. Drop the test-only globals `window.__slideForMedia` and
   `window.__importFiles` from `App.tsx`. Keep `window.__editorStore` but
   assign it only under `import.meta.env.DEV`, as an assertion escape hatch.
7. `tauri-plugin-mcp` stays as the agent debugging bridge (`npm run dev:mcp`,
   `.mcp.json`). Tests stop depending on it. If nobody uses the bridge in
   three months, remove it in a follow-up.

## Test project layout

```
e2e/
  wdio.conf.ts            service config, hooks (build check, fixtures, reset)
  tsconfig.json
  fixtures.ts             ensureFixtures() (unchanged logic, TS)
  page/
    App.ts                selectors and actions: import, mode switch, reset
    Arrange.ts            cards, selection, context menu, drag
    Time.ts               strip, marks, tracks
    Values.ts             panel scopes and fields
    Preview.ts            transport, clock, frame sampling
  specs/
    import.spec.ts        from 01
    grouping.spec.ts      from 02
    selection.spec.ts     from 03
    titles.spec.ts        from 04
    playback.spec.ts      from 05
    timemode.spec.ts      from 06
    panels.spec.ts        from 07
    frame.spec.ts         from 08
    persistence.spec.ts   from 09
    reactivity.spec.ts    from 10
    flows.spec.ts         from 11
```

`app/package.json` gains `@wdio/cli`, `@wdio/tauri-service`,
`@wdio/tauri-plugin`, `@wdio/mocha-framework`, `expect-webdriverio`,
`ts-node` or `tsx`, and scripts:

```json
"e2e:build": "tauri build --debug --no-bundle",
"e2e": "wdio run ../e2e/wdio.conf.ts"
```

`wdio.conf.ts` sketch:

```ts
export const config: WebdriverIO.Config = {
  runner: "local",
  specs: ["./specs/**/*.spec.ts"],
  maxInstances: 1,                       // one app, one window, shared state
  capabilities: [{
    browserName: "tauri",
    "tauri:options": { application: "../target/debug/slideshow-app" },
  }],
  services: [["@wdio/tauri-service", {
    driverProvider: "embedded",
    startTimeout: 90000,
    captureBackendLogs: true,
    captureFrontendLogs: true,
    logDir: "./logs",
  }]],
  framework: "mocha",
  mochaOpts: { timeout: 60000 },
  reporters: ["spec"],
  onPrepare: () => ensureFixtures(),
  beforeSuite: () => resetApp(),          // clear localStorage + reload
};
```

## Translating the harness

| Today | WebdriverIO equivalent |
|---|---|
| `app.evalJs(code)` (200 uses) | `browser.execute(fn, ...args)`; `browser.tauri.execute(({core}) => ...)` when Tauri APIs are needed |
| `waitFor(app, expr)` (72) | `browser.waitUntil(() => browser.execute(...))` or, better, `$(sel).waitForDisplayed()` / `waitForExist` on the DOM |
| `dropFiles(app, paths, n)` (24) | Two flavours. **Real path:** `browser.tauri.mock("plugin:dialog\|open").mockResolvedValue(paths)` then `await $("button=Import").click()`. This exercises the Import button and the Rust import pipeline. **Drag-drop path:** `browser.tauri.execute(({core}, paths) => core.invoke("plugin:event\|emit", { event: "tauri://drag-drop", payload: { paths, position: {x:0,y:0} } }), paths)`, same as today, for suites specifically about dropping. Then place onto the film via the UI (Build button / drag), not `__slideForMedia`. |
| `dispatchEvent(new MouseEvent("click", {shiftKey}))` (32) | `browser.action("key").down("Shift").perform()` around `$(card).click()`, or `browser.keys(["Shift"])` |
| `KeyboardEvent` keydown on a container (12) | `$(".arrange-grid").click()` to focus, then `browser.keys("ArrowRight")` |
| `dragSnippet` / `__e2eDrag` (12) | `browser.action("pointer").move({origin: src}).down().move({origin: dst, x, y}).up().perform()` |
| `st("selectedIds.length")` store reads (54) | Prefer DOM: `$$(".slide-card.selected").length`, `$(".clock").getText()`. Fall back to `browser.execute(() => window.__editorStore.getState().x)` where the UI has no readable surface (timing totals, revision counters, cached frame identity). |
| `localStorage.clear(); location.reload()` | same via `browser.execute`, then `browser.waitUntil` for `.app` |
| export produces MP4 (09) | mock `plugin:dialog\|save` to a temp path, click Export, wait, `ffprobe` from the spec via `child_process` |
| frame pixel sampling (08, 10) | keep: `browser.execute` reading the preview canvas, or `browser.saveScreenshot` plus `sharp`/`pngjs` sampling in Node |

Rule for the rewrite: interactions go through WebDriver (click, keys,
actions); assertions read the DOM first and the store only when the DOM
cannot answer. That is what makes these tests catch handler regressions
that synthetic `dispatchEvent` calls cannot.

## Phases

### Phase 0: spike (half a day)

Answer the questions that decide whether the embedded provider is enough.
Ship nothing until these pass on this Mac.

- [ ] App launches under the service, `browser.$(".app")` resolves, one
      `browser.tauri.execute` round-trip works.
- [ ] `browser.action("pointer")` drag between two `.slide-card`s reorders
      them (does the embedded server perform real pointer actions in
      WKWebView, or synthesize DOM events?). If synthesized, our React
      pointer handlers still fire, same as today; note it.
- [ ] `browser.keys` with Shift + click yields a range selection.
- [ ] `browser.tauri.mock("plugin:dialog|open")` intercepts
      `@tauri-apps/plugin-dialog`'s `open()`; import completes through the
      Rust pipeline; thumbnails appear.
- [ ] WKWebView timer throttling: with the app window not key, does
      playback advance? If not, `browser.execute(() => window.focus())` or
      the service's window-focus command before transport tests.
- [ ] `browser.saveScreenshot` works (bonus: README screenshots from tests).

If any of these fail on the embedded provider, evaluate
`@crabnebula/tauri-driver` for that one capability before writing tests.

### Phase 1: scaffolding

- [ ] Cargo plugins, capability, `withGlobalTauri`, frontend import.
- [ ] `e2e/wdio.conf.ts`, tsconfig, fixtures, `e2e:build` and `e2e` scripts.
- [ ] Page objects with the selectors the old tests already use
      (`.arrange-grid .slide-card`, `.face-arrange`, `.outcome textarea`,
      `.time-strip`, `.values-scope` and so on). Add `data-testid` where a
      class name is styling-only and likely to churn.
- [ ] `resetApp` and `importFixtures` helpers.
- [ ] One smoke spec: launch, import three photos, three cards appear.

### Phase 2: port suites in dependency order

Each suite ports as one PR, keeping test titles so the map from old to new
is obvious in review. Delete the old `.test.mjs` in the same PR.

1. import (7 tests) and grouping (8): needs import helper only.
2. selection (6) and titles (7): keys, clicks, context menus.
3. timemode (6) and panels (6): mode switch, dock, splitter drags.
4. frame (9) and reactivity (13): pixel sampling; largest suite.
5. playback (5): transport, audio lane, throttling caveat.
6. persistence (4): dialog mocks for save/open/export, ffprobe.
7. flows (4): composite; port last.

Expected count stays 75. Tests that only assert on store internals with no
user-visible effect get reviewed: keep if they guard a real regression,
otherwise drop with a note in the PR.

### Phase 3: retire the old harness

- [ ] Delete `e2e/client.mjs`, `e2e/harness.mjs`, `e2e/run.mjs`, old tests.
- [ ] Remove `__slideForMedia`, `__importFiles`; gate `__editorStore` to DEV.
- [ ] Rewrite `e2e/README.md` (WebdriverIO, embedded provider, how to run one
      spec, where logs land, the two rules learned the hard way if they still
      apply).
- [ ] README "Development" section: replace the `npm run e2e` line's
      description; note the MCP bridge is agent tooling only.

### Phase 4: CI

- [ ] Add a `e2e` job to `.github/workflows/build.yml` on `macos-latest`:
      fetch ffmpeg sidecar, `npm ci`, `npm run e2e:build`, `npm run e2e`,
      upload `e2e/logs` on failure. macOS runners have a window server, so
      no xvfb. Cache cargo and npm.
- [ ] Optional later: an `ubuntu-latest` leg with `webkit2gtk-driver` and
      `xvfb-run`, provider `external`, to prove Linux. Not a blocker.

## Risks

- **Embedded provider maturity.** 1.x for three months. Mitigation: the
  spike, plus pinning exact versions in `package.json` and `Cargo.toml`.
- **WKWebView input fidelity.** If the embedded server synthesizes events,
  we gain little realism over today for pointer paths; we still gain a
  standard runner, page objects, reporters, screenshots and CI parity.
- **Window focus and timers.** Known from the current harness. Handle in
  the spike.
- **Build time.** `tauri build --debug` plus the ort download on a cold CI
  runner. Cache `target/` and `~/.cargo`.
- **Capability scanning.** `tauri-build` may reject `wdio:default` when the
  plugin is absent from a release build; fall back to runtime
  `add_capability` like the mcp plugin does.

## Out of scope

Rust mock-runtime tests for commands (worth doing separately for
`edit_apps`, `changed_media`, preview cache), visual regression baselines,
Windows e2e.

## Spike results (2026-09-07)

Embedded provider, macOS 15, `@wdio/tauri-service` 1.4.0,
`tauri-plugin-wdio-webdriver` 1.4.0, Tauri 2.11.5.

- Session, element queries, `browser.keys`, `browser.tauri.execute`,
  screenshots, backend/frontend log capture: work.
- `browser.tauri.mock(...)` only proxies `window.__TAURI__.core.invoke`. A
  Vite-bundled frontend calls `__TAURI_INTERNALS__.invoke`, which is
  non-writable, so mocks never fired. Fixed by aliasing
  `@tauri-apps/api/core` to `app/src/e2e/tauriCore.ts` in e2e builds; the
  shim consults `window.__wdio_mocks__` first. Mocking the file dialogs then
  drives the real Import / Save As / Open buttons end to end.
- Pointer actions are synthesized as bare `MouseEvent`s (no `PointerEvent`,
  no modifiers), element click is `el.click()`, and there is no
  `contextmenu`. The app's drag system and multi-select need all three, so
  `app/e2e/page/app.ts` dispatches those event types from inside the page.
  Same fidelity as the old harness, inside the standard runner. Worth an
  upstream PR to `webdriverio/desktop-mobile`.
- Specs must live under `app/` so `@wdio/globals` resolves; they moved to
  `app/e2e/`.
- The e2e binary is `tauri build --debug --no-bundle -- --features e2e` with
  `VITE_E2E=1`, so no Vite dev server is involved and the plugins never enter
  a normal build.
