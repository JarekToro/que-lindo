# End-to-end tests

WebdriverIO suites that drive the **real app** — Rust backend, compositor,
ffmpeg, WKWebView — through the W3C WebDriver protocol, the way Tauri's
docs recommend. `@wdio/tauri-service` launches the binary and talks to a
WebDriver server embedded in it (`tauri-plugin-wdio-webdriver`), so macOS
needs no external driver.

```sh
cd app
npm run e2e:build            # once, and after any Rust or frontend change
npm run e2e                  # every suite
npm run e2e -- --spec e2e/specs/import.spec.ts
```

`e2e:build` is `tauri build --debug --no-bundle` with the `e2e` cargo feature
and `VITE_E2E=1`. The feature compiles in `tauri-plugin-wdio` (execute, mocks,
logs) and the embedded WebDriver server; the env var switches the frontend to
`src/e2e/tauriCore.ts`, a shim of `@tauri-apps/api/core` whose `invoke`
honours `browser.tauri.mock(...)`. Neither is part of a normal build.

**Every suite reloads the webview and clears localStorage** — save your work
before running against an app you started yourself. Fixture media comes from
`examples/make-test-media.sh`, generated on first run. Backend and frontend
logs land in `e2e/logs/`.

## Layout

```
wdio.conf.ts        service config, binary path, hooks
page/fixtures.ts    fixture media
page/app.ts         store access, import helpers, gestures
specs/*.spec.ts     one file per area, Mocha + expect-webdriverio
```

## Writing tests

Interactions go through WebDriver where the driver delivers them faithfully:
`$(sel).click()`, `browser.keys(...)`, `browser.tauri.execute(...)`,
`browser.tauri.mock(...)`. Assertions read the DOM first and the editor
store (`window.__editorStore`, exposed in dev and e2e builds) only where the
UI has no readable surface: timing totals, revision counters, cached frames.

Two rules the helpers enforce:

- **No closures in page functions.** `store(fn, arg)`, `dom(fn, arg)`,
  `waitForStore(pred, arg)` serialize `fn`; spec-local values must travel
  through `arg`.
- **Gestures use the page-object helpers.** `tauri-plugin-wdio-webdriver`
  1.4 synthesizes pointer actions as bare `MouseEvent`s, ignores click
  modifiers and has no `contextmenu`, while the app's drag system listens
  for `PointerEvent`s. `dragTo`, `dragBy`, `clickWith`, `contextMenu`,
  `pressKey` dispatch the real event types from inside the page until that
  lands upstream. Plain keys (`Enter`, arrows, `Backspace`, ⌘-combos) go
  through `browser.keys`, which the driver handles with modifier state.

And two learned the hard way: dispatch keyboard or pointer events **after**
a store write settles (~250 ms), because React handlers read render-scope
state; and never assert on `getBoundingClientRect` of anything the FLIP
animates, since WKWebView suspends rAF and throttles timers to ~1 Hz while
the window isn't key.

## Status

76 tests across 11 specs, all passing on macOS as of 2026-09-07 (about two
minutes wall clock). Two app bugs surfaced while porting and are fixed:
the audio lane could stay blank after a webview reload (the Time face asked
for the mix before the first project sync), and nothing else.
