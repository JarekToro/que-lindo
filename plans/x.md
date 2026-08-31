# Implementation plan — Slideshow Studio

Derived from `PRODUCT.md` and the editor-shell surface brief at
the editor-shell surface brief ("One frame, two modes", seed `3e1ce0f7`).

Status: proposed, not started. Date: 2026-08-31.
Branch: `editor-shell-plan-and-mcp` (not `main`).

---

## Handoff

Read these three first. They are the authority; do not re-decide what they
settle.

| Document | Owns |
|---|---|
| `PRODUCT.md` | Product truth — users, purpose, positioning, what is out of scope, what is explicitly undecided |
| the editor-shell surface brief | The editor-shell design contract: the chosen direction, the group viewer, the dissolve rule, the keyboard grammar, the constraints, and the alternatives already rejected |
| `docs/editor-shell-schematic.html` | The same direction drawn — Arrange, Time, the reflow, and a capability ledger mapping every control in the app today to where it lives afterwards |

Open the schematic in a browser; it is a self-contained HTML file.

Anything the surface brief lists under "Open design questions" (repeated at the
bottom of this plan) is genuinely open and belongs to the owner, not to whoever
picks this up. Do not resolve them silently.

### Setting up the machine

**A clean checkout does not build.** `tauri-build` needs ffmpeg sidecars that
are gitignored, and fails with `resource path binaries/ffmpeg-<triple> doesn't
exist`. Either fetch static builds:

```sh
scripts/fetch-ffmpeg.sh          # macOS / Linux
scripts\fetch-ffmpeg.ps1         # Windows
```

…or, for local development only, copy the ffmpeg and ffprobe already on your
PATH into `app/src-tauri/binaries/` renamed to `ffmpeg-<target-triple>` and
`ffprobe-<target-triple>` (e.g. `ffmpeg-aarch64-apple-darwin`). Those are
dynamically linked, so use the fetch script before building installers.

The engine also needs `ffmpeg` and `ffprobe` reachable at runtime — next to the
executable, then `binaries/`, then `PATH`; `SLIDESHOW_FFMPEG_DIR` overrides.

### Commands

```sh
cargo build --workspace                 # Rust: engine, CLI, Tauri app
cd app && npx tsc --noEmit              # frontend typecheck
cd app && npm install && npm run tauri dev
cd app && npm run dev:mcp               # same, plus the MCP agent bridge
```

End-to-end check without the GUI, which is the fastest way to confirm the engine
still renders after a core change:

```sh
examples/make-test-media.sh
cargo run --release -p slideshow-cli -- render examples/test.slideshow.json -o examples/out/test.mp4
```

Every phase should land with `cargo build --workspace` and `npx tsc --noEmit`
both clean.

### Constraints on the work

- **Never use the TypeScript `any` type.** Not as a cast, not as a stopgap. It
  is not an accepted solution in this repo.
- **No base64 for binary payloads** — see finding 3 below. This is the one rule
  most likely to be violated by copying the existing code, because the existing
  code violates it.
- **Capability is hidden, never removed.** Everything reachable in the app today
  stays reachable; the schematic's capability ledger is the checklist.
- **Occasion-neutral.** Memorial is one preset among several. Nothing in the
  interface may presume grief, or presume celebration.
- **Desktop only**, minimum window 1100×700. There is no mobile or touch target.
- Do not add Claude attribution or `Co-Authored-By` lines to commits.

---

## Where the code actually is

| Layer | State |
|---|---|
| Rust core (`crates/slideshow-core`) | Complete — model, timeline, layout, compositor, text, transitions, audio *plan*, export |
| Tauri commands (`app/src-tauri/src/lib.rs`) | 11, incl. `set_project`→`Timing`, `render_preview(time, scale)` |
| Store (`app/src/store.ts`) | zustand, whole-`Project` immutable mutate, 120 ms debounced backend sync |
| Preview (`app/src-tauri/src/preview.rs`) | one render thread, one job in flight, **no cache** |
| Playback (`app/src/components/Preview.tsx`) | 12 fps `setInterval`, wall-clock independent |
| Audio (`crates/slideshow-core/src/audio.rs`) | `audio::plan` builds an ffmpeg `filter_complex` — **export only**, no playback path |

### Three findings that shape everything below

**1. Grouping needs no model change.** A group *is* a `Slide` with more than one
`cell`. Bind = merge cell arrays and pick a layout. Split = move one cell into a
new `Slide` inserted after. Dissolve-at-one = a 1-cell slide with
`layout: single` already *is* an ordinary slide. The whole feature is array
manipulation over the existing model.

**2. Audio should become the clock.** `Preview.tsx` advances `time` by `1/12`
per `setInterval` tick regardless of elapsed wall time — it already drifts, and
against audio it would drift audibly. Do not sync audio to that loop; invert it.
Render the mix once through the *existing* `audio::plan` graph to WAV instead of
muxing it, hand the frontend the raw buffer, and drive `time` from
`audioContext.currentTime`. Preview frames chase the audio clock. This gives
audio the same property video already has: preview matches export because it is
one plan.

**3. No base64 anywhere, for any binary payload.** Values returned from a
command are serialised to JSON, which is wrong for images, audio and any other
buffer. Return `tauri::ipc::Response` instead:

```rust
use tauri::ipc::Response;

#[tauri::command]
fn read_file() -> Response {
    let data = std::fs::read("/path/to/file").unwrap();
    tauri::ipc::Response::new(data)
}
```

This is a standing rule for this codebase, not a phase. Current violations:

| Site | Today | Becomes |
|---|---|---|
| `preview.rs` → `render_preview` | `data:image/png;base64,…` string | `Response` of raw bytes; frontend wraps in a `Blob` + `URL.createObjectURL`, revoking the previous URL |
| `lib.rs` → `make_thumb` (inside `probe_media`) | `data:image/png;base64,…` string | `Response` from a separate thumbnail command/event |
| Audio playback (phase 2, new) | — | `Response` of WAV/PCM bytes straight into `decodeAudioData` |

Two notes on doing this:
- `render_preview` currently returns `Result<String, String>`. Confirm the exact
  shape Tauri v2 accepts for a fallible command returning `Response` before
  refactoring; if `Result<Response, E>` is not supported, move the error onto a
  separate channel rather than reintroducing a JSON-encoded payload.
- While in there, consider skipping PNG encode entirely on the preview hot path
  and returning raw RGBA for the frontend to blit through `ImageData` /
  `createImageBitmap`. At 12 fps the encode is paid every frame.

---

## Phases

Ordered by dependency. Each phase should land with the workspace building and
`npx tsc --noEmit` clean.

### Phase 0 — Binary IPC + preview frame cache

Two changes to the same hot path, so they land together.

- Convert `render_preview` and the thumbnail path to `tauri::ipc::Response` per
  the rule above. Frontend switches from `img.src = dataURL` to object URLs,
  with disciplined revocation — a leak here is a leak per frame.
- Add an LRU cache in `preview.rs` keyed on `(rev, quantised time, scale)`, plus
  "latest wanted frame wins" coalescing so a scrub discards superseded jobs
  instead of queueing them.

Unblocks proportional scrubbing in Time mode and makes Arrange feel instant.
Self-contained; no UI dependency.

### Phase 1 — Progressive import

`App.tsx :: importPaths` awaits `probe_media` one file at a time, and each call
also decodes a thumbnail. At 300 photos that is 300 sequential ffmpeg spawns
plus a large base64 payload over IPC.

- Split into a fast metadata-only `probe_media` and a separate streaming
  thumbnail path (binary, per phase 0).
- Emit per-file events so cards appear as placeholders immediately and fill in
  behind.
- Parallelise probing with a bounded worker pool.

### Phase 2 — Audio playback in preview

The largest single item. Required for Time mode to be honest, and
`PRODUCT.md` puts it in scope for v1.

- Reuse `audio::plan`; render the mix to WAV once per `rev` and cache it.
- New command returns the buffer as `tauri::ipc::Response`.
- Frontend owns an `AudioBufferSourceNode`; the playback loop is rewritten to
  read `audioContext.currentTime` and drive `time` from it.
- Scrub and seek reposition the source node.

**Acceptance test:** the line "Preview is video-only; audio is mixed into the
export" is deleted from both `Preview.tsx` and `README.md` because it is no
longer true.

### Phase 3 — Arrange mode

No audio dependency. The mode carrying the two decisions the user actually owns.

- Wrapping grid of equal-width slide cards in playback order.
- Drag reorder **and** keyboard reorder.
- Bind by drop, with the target card visibly opening to receive — not a
  highlight.
- Group cards render their real composed layout, every member, with a count
  badge.
- **The band**: opening a group expands it across the full grid width, inserted
  after its own row; in flow, occluding nothing. Members at readable size, each
  with a remove control. `↵` opens, `←/→` walks, `⌫` splits one out, `Esc`
  closes. Opening is independent of selection.
- Split returns a photo to the timeline as its own slide directly after the
  group. Down to one member, the group dissolves.
- The timeline caps its height and scrolls; the frame never shrinks.
- Media bin deleted. `Not used` shelf replaces it.

### Phase 4 — Time mode and the reflow

Depends on 0, 2, 3.

- The same timeline becomes proportional: card width *is* duration.
- Transition markers in the seams; audio lane beneath; music plays.
- Title text edited here — content and timing.
- **The signature interaction**: switching modes is one animated reflow. Cards
  stretch to true lengths, the audio lane rises, the music starts.

### Phase 5 — Contextual panel

Runs alongside 3 and 4. The permanent 300 px inspector is deleted; selection
summons 3–5 outcome-level controls ("Zoom in", "Pan →") with raw values behind a
`Values ▸` disclosure. Two permanent panes become zero.

### Phase 6 — Accessibility

The surface has no ARIA today and is dark-only. The brief calls a rebuild of
this size the honest moment to fix focus and roles; doing it after 3–5 means
retrofitting focus management into finished components. Roles and labels for the
grid, the band, the transport and the contextual panel.

### Phase 7 — Occasion-neutral presets

`applyMemorialTheme` and the `prompt()`-driven title card in `TopBar.tsx` are the
last place the interface assumes a funeral. `PRODUCT.md` principle 3: memorial is
a preset, not an assumption. How the other occasions are chosen, named and
offered is explicitly undecided — resolve it with the owner, do not invent it.

---

## Sequencing note

The surface brief says to sequence audio "before the UI work". This plan puts
the binary-IPC/cache work and progressive import ahead of it, and **Arrange
ahead of Time**. Arrange has no audio dependency, and audio still lands before
Time mode — so the constraint that actually matters, audio responsiveness
shaping Time's design, is preserved. Accepted by the owner 2026-08-31.

## Risks to watch

- **Undo/redo retains full `Project` copies, 100 deep** (`store.ts`). At 300
  slides that is significant retained memory per step, and reordering is about
  to become the most frequent action in the app.
- **41 slides is the tested scale; 300 is the target.** Nothing in the current
  filmstrip or preview has met 300. Generate a 300-photo test project early so
  phases 0–2 are measured rather than guessed.
- **Object-URL lifetime** replaces base64's accidental safety. Every preview
  frame allocates; revocation must be exact.

## Open design questions

- How the band lays out 7–8 members.
- How the grid keeps an opened group's row in view while the cards below reflow.
- Card size and column count at the 1100 px minimum window width.
- The disclosure pattern behind `Values ▸`.
