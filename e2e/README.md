# End-to-end tests

Drives the **real app** — Rust backend, compositor, ffmpeg, webview UI —
through the MCP bridge socket (`/tmp/slideshow-studio-mcp.sock`, newline-JSON,
auth token read from the `.token` sibling file).

```sh
node e2e/run.mjs            # all suites
node e2e/run.mjs 04         # filename filter
cd app && npm run e2e       # same
```

If the socket exists the runner attaches to the running `npm run dev:mcp`
instance; otherwise it spawns one and tears it down. **Every suite resets the
app's in-memory state (and localStorage panel prefs) — save your project
before running.** Test fixtures come from `examples/make-test-media.sh`,
generated on first run.

Suites: import & bin · grouping/band · multi-selection & context menus ·
titles as members · playback & audio · Time mode · panels/dock/Values ·
frame rendering (intro, outro, zoom focus, cache) · persistence/undo/export.

Writing tests: see `harness.mjs` (`dropFiles`, `waitFor`, `st`, `dragSnippet`,
`expect`). Two rules learned the hard way:

- Dispatch keyboard/pointer events **after** a store write settles (~250ms):
  React handlers read render-scope state, exactly like a real user's timing.
- Never assert on `getBoundingClientRect` of anything the FLIP animates, and
  keep clock tolerances ≥1 tick: WKWebView suspends rAF/WAAPI and throttles
  timers to ~1Hz while the window isn't key.
