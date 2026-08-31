# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

Delivered as a desktop application (Tauri v2 shell on macOS and Windows) whose
interface is web technology — React, TypeScript, CSS. It is not a mobile app
and has no mobile surface; the design language is desktop-web, not native iOS
or Android.

## Users

The primary user is a **non-technical person making a slideshow out of their own
photos, video clips and music**. They are not a video editor and will not learn
one. They are working on a personal occasion, usually with a deadline attached
to a real event, and they may use the product once or a handful of times rather
than daily. Success for them is a finished video they are willing to show other
people.

The project began as a memorial/tribute tool, and that history is visible in the
code (memorial theme preset, title and end cards, gentle-crossfade defaults).
It is no longer memorial-specific: **memorial is one use case among several**
(birthday, wedding, travel, year-in-review, and so on). Nothing in the interface
should assume the occasion is a funeral.

Technically comfortable users exist (the `.slideshow.json` format is
hand-editable and there is a headless CLI), but they are a secondary,
power-user audience — see Operating Context.

## Product Purpose

Turn a pile of photos, video clips and music into a finished MP4 slideshow:
collage layouts, gentle Ken Burns motion, titles and captions, transitions, and
a mixed music bed. The product exists because the shortest honest path between
"I have the photos" and "I have a video to share" currently runs through either
a template site that owns your output or a general video editor that is far more
tool than the job needs.

Success is a rendered video the user is happy to share, produced without the
user having to understand a timeline editor.

## Positioning

**Focused, not a video editor.** The feature set is deliberately narrow — photos,
clips, music, collage layouts, Ken Burns motion, titles, transitions, and an MP4
out — and that narrowness is the product, not a limitation to be apologised for
or grown out of. A general-purpose editor cannot truthfully make this claim, and
a template site cannot make it while also giving the user real control over
layout, motion and text.

Two implementation facts support this and are true, but were not confirmed as
positioning and should not be sold as the headline: one Rust compositor drives
both the scrub preview and the ffmpeg encode (preview matches export), and
sizes/offsets are stored as fractions of the frame (one project renders at 720p
through 4K, vertical or square).

## Operating Context

- **Local desktop application.** Everything runs on the user's own machine
  against local media files. There is no cloud service, account system, upload
  step, or telemetry in the codebase today.
- **ffmpeg and ffprobe are a hard runtime dependency.** The engine decodes video
  and encodes MP4 through them. They are found next to the executable, then in
  `binaries/`, then on PATH (`SLIDESHOW_FFMPEG_DIR` overrides), or fetched as
  static sidecars via `scripts/fetch-ffmpeg.{sh,ps1}`. Their absence is a real,
  reachable user state the interface already has to report.
- **Desktop window sizes only.** Default 1480×920, minimum 1100×700. There is no
  small-screen or touch context to design for.
- **Projects are files.** Versioned JSON (`*.slideshow.json`), hand-editable and
  version-controllable, with media paths that may be relative to the project file.
- **The CLI and the JSON format are internal / power-user surfaces.** The app is
  the product. `slideshow` (new / info / frame / render) stays supported, but
  design work is not required to surface, teach, or explain it to users.

## Capabilities and Constraints

Confirmed functionality (implemented today):

- Slides with duration, layout (`single`, `rows`, `columns`, `grid`, `featured`,
  `custom` rects), margin/gutter, and a background that is either a colour or a
  blurred cover of one of the slide's own photos.
- Cells (one per photo or clip in a collage): `cover`/`contain` fit, motion
  (`zoom` in/out, or full `ken_burns` from→to crop windows), corner radius,
  border. Video cells can seek and contribute their own audio.
- Text overlays with roles (title, subtitle, caption, lower third, credit),
  font/size/colour/align, 9-point anchor plus offset, wrap width, shadow,
  backing box, timed appearance with fades.
- Transitions into each slide: cut, crossfade, fade through black or white,
  slide, wipe in any direction, with per-slide duration.
- Audio tracks: placement, seek offset, gain, fade in/out, looping to fill.
- Editor shell: media bin, live preview with transport, inspector, filmstrip,
  export dialog; drag-and-drop import, undo/redo, keyboard transport.
- Output presets: 1080p, 4K, 720p 16:9, vertical 9:16, square 1:1.

Constraints and known limits:

- **Out of scope for v1:** per-word karaoke text, beat sync, GPU compositing,
  real-time full-resolution audio playback in preview, nested timelines.
- The preview plays video only. Audio is heard in the exported file, not while
  scrubbing.
- Bundled ffmpeg builds are GPL-licensed; attribution must survive distribution.
  The project's own code is MIT.

Explicitly undecided (do not resolve these silently):

- **Nothing about the current interface is fixed.** The three-pane editor
  (media bin / preview / inspector) plus filmstrip, the flow through it, and the
  set of surfaces are all open to restructuring. The current implementation is a
  starting point and evidence of intent, not a contract.
- How occasion presets beyond memorial are chosen, named, or offered.
- Whether the product is ever distributed as a paid or public release. Version
  is 0.1.0, there are no tags or releases, and no pricing, licensing-to-users, or
  availability claim may be invented.

## Brand Commitments

- Name: **Slideshow Studio**. Bundle identifier `com.jarektoro.slideshow-studio`.
- Bundled fonts shipped with the renderer: Crimson Text (serif, titles) and Lato
  (sans, captions), both SIL Open Font License, in `assets/fonts/`. These are
  render-side defaults for generated video text; they are not a stated brand
  typeface for the application UI.
- No logo, wordmark, brand palette, or voice guidelines exist in the repository.
  The app icons in `app/src-tauri/icons/` are placeholders. No visual direction
  was declared during init, by design — those decisions belong to the design work.

## Evidence on Hand

Real, in-repo:

- Six screenshots of the working application in `docs/screenshots/` (title card,
  portrait over blur, grid collage, featured layout with inspector, video cell,
  export dialog).
- A full-feature example project, `examples/test.slideshow.json`, plus
  `examples/make-test-media.sh` to generate its media.
- A working CI build workflow (`.github/workflows/build.yml`).

Absences future work must not paper over:

- **No users, no usage data, no testimonials, no case studies, no press, no
  customer logos, no benchmarks.** None may be invented or implied.
- No public release, download count, or distribution channel. No tags, no
  releases, version 0.1.0.
- No performance numbers for render or export times.
- No sample media in the repository — the screenshots are the only real imagery.

## Product Principles

1. **The narrow tool is the point.** Every added capability must earn its place
   against the promise that this is not a video editor. Depth belongs in the few
   things it does; breadth does not.
2. **Someone who has never edited video must reach a finished MP4.** Defaults
   should already be good — pacing, motion, transitions — so that doing nothing
   produces something worth sharing.
3. **Occasion-neutral by default, occasion-aware on request.** Memorial is a
   preset, not an assumption. Nothing in the interface should presume grief, or
   presume celebration.
4. **The user's media and files stay theirs and stay local.** Nothing implies
   upload, account, or cloud dependency unless that genuinely changes.
5. **Say what is actually true.** With no users and no released version, the
   product speaks about what it does, never about how many people use it or how
   well it has performed.

## Accessibility & Inclusion

No standard or specific user requirement was established during init. Two
factual notes so later work neither guesses nor overclaims: the application UI
today is dark-only (`color-scheme: dark`, fixed palette in `app/src/styles.css`)
and contains no ARIA roles or labels at all, and the base UI font size is 13px
with 11–12px secondary text. Nothing may claim conformance with any standard.
