<p align="center">
  <img src="assets/brand/logo-full.png" alt="Qué lindo" width="420">
</p>

<p align="center"><em>pronounced keh LEEN-doh</em></p>

A small, local slideshow-video maker. Drop in photos, clips and music; get an
MP4 with collage layouts, gentle Ken Burns motion, titles and transitions.
No account, no upload, no timeline editor to learn.

*Qué lindo* is Spanish for "how lovely", something my Abuela used to say all
the time, and it still makes me think of her. I built this to make the video
for her memorial, after finding that every option was either a cloud service
that owned the result or a full video editor that was far more tool than the
job needed. This project is named for her.

> **Status:** early. Developed and used on macOS. Windows builds in CI but has
> had far less use.

## Install

macOS on Apple Silicon, with [Homebrew](https://brew.sh):

```sh
brew install --no-quarantine JarekToro/apps/que-lindo
```

Or download the `.dmg` from [Releases](https://github.com/JarekToro/que-lindo/releases).
The app is not yet signed with an Apple Developer ID, so macOS calls it
"damaged" until the quarantine flag is cleared; `--no-quarantine` does that,
or run `xattr -d com.apple.quarantine "/Applications/Qué lindo.app"` once.

Windows and Intel Macs: build from source (below).

## Screenshots

| | |
|---|---|
| ![Title card, text controls, split Arrange and Time view](docs/screenshots/01-title.jpg) | ![A four-photo moment opened as a band, arrangement picker](docs/screenshots/02-group.jpg) |
| ![One photo: motion, fit and framing controls](docs/screenshots/03-photo.jpg) | ![Time view: the same moment as a scatter pile, over the music waveform and beat marks](docs/screenshots/04-time.jpg) |
| ![Export dialog with size presets](docs/screenshots/05-export.jpg) | ![Crop a photographed print: the detected corners on the photo, ready to drag](docs/screenshots/06-crop.jpg) |
| ![Restore view: a scanned family photo with faces restored, original on the left of the split, result on the right](docs/screenshots/07-restore.jpg) | |

Photographs from [Unsplash](https://unsplash.com), under the
[Unsplash License](https://unsplash.com/license).

## What it does

### From a pile of photos to a draft in one click

**Auto-build** takes everything on the shelf and assembles a film you adjust
rather than build:

- **Moments, not files.** Photos taken together become one collage. Grouping
  runs in Rust as order-independent correlation clustering (average-linkage
  agglomeration with a local-search pass), so a shuffled import builds the
  same film. The pairwise signal combines:
  - capture time from EXIF, with a 90-second window when both photos are dated;
  - a 6×6 mean-colour fingerprint, cheap and always available;
  - a scene embedding from a CLIP vision model, which recognises the same
    moment shot from different angles or rooms (optional model, see below);
  - face identity embeddings, a bounded bonus that can tip a pair whose
    scenes are already close but never joins strangers on its own;
  - the detector's face count, which widens or narrows how far the colour
    fingerprint is trusted: matching counts loosen it, a portrait against a
    crowd tightens it.
- **Oldest first.** Moments are ordered by real capture date when they have
  one, otherwise by *apparent* age: a linear probe trained on the Date
  Estimation in the Wild dataset reads the scene embedding as a year (held-out
  error about nine years, 1930–1999), with a modern-photo gate so undated
  phone shots sort after the prints.
- **Pacing chosen for you.** Single photos hold for 5 s, collages for 7 s,
  clips run 2–8 s, transitions are gentle crossfades, and every eighth slide
  arrives out of black as a breath. Consecutive collages cycle through a
  composed layout, a face-dealt scatter pile and a mosaic, so a long run of
  moments never repeats one look.

### Faces steer the framing

A bundled, offline face detector (SeetaFace via `rustface`) runs on import.

- **Zoom aims at faces.** The default Ken Burns motion for a photo zooms
  toward the detected faces instead of the centre.
- **Smart fit.** A cell can fill its frame with the crop pulled toward the
  faces rather than a centred crop, so nobody loses their head in a 16:9
  frame. Auto-build picks Smart fit whenever faces were found; you can move
  the aim point by hand in the preview.

### Layouts and motion

- Collage layouts for one to eight members: single, rows, columns, grid,
  featured, plus a catalog of presets over the engine's custom rectangles
  (inset, tower, band, pinwheel, hero row, quilt, hero quilt, scatter with
  per-print rotation and paper frames).
- Backgrounds: a project colour, a slide colour, or a blurred, dimmed cover
  of one of the slide's own photos.
- Motion per cell: still, zoom in or out toward a focus point, or a full Ken
  Burns crop-to-crop move. Corner radius and borders per cell.
- Sizes and offsets are fractions of the frame, so one project renders at
  720p, 1080p, 4K, vertical 9:16 or square 1:1 without re-editing.

### Titles and captions

- Roles with sensible defaults: title, subtitle, caption, lower third,
  credit. Ready-made title and end cards, and a "memorial pacing" preset
  that lengthens slides, softens every transition and eases the music in
  and out.
- Any system font or the bundled Crimson Text and Lato. Requested weights
  snap to what the family actually has, so a font never silently falls
  back to the system face. Shaped and wrapped by `cosmic-text`, including
  right-to-left scripts.
- Nine-point anchoring with offsets, wrap width, shadows, backing boxes,
  timed appearance with fade in and out. Text can be dragged in the preview.
- Titles are members of a slide: drag the T chip onto a photo and the title
  lives with that photo, splits out into its own card, and rides along when
  cards are regrouped.

### Music and clips

- Several tracks with placement, trim, gain, fades and looping to fill the
  film. A second song chains after the first with a 3 s crossfade; only the
  last one loops. Video clips can contribute their own audio.
- **Beat marks.** Tap marks on the music while it plays; a nudge walks
  nearby slide boundaries onto the beats within bounded stretch, so the cut
  lands on the downbeat without anything jumping.
- The preview plays the same mix the export muxes, rendered by one ffmpeg
  filter graph, and the Time view draws its waveform under the cards.

### Editing

- **Arrange** is a grid of moments: drag to reorder, drop a card on another
  to bind them, ↵ opens a group as a band you can rearrange or split,
  rubber-band and ⌘/⇧ selection, context menus, a "Not used" shelf that
  holds anything you hide. **Time** stretches the same cards to their
  durations with a ruler, seam markers and the audio lane. Dock either to
  the bottom, left or right, or split to see both.
- **Edit in an external app** (macOS): send a photo to Photos, Preview or
  any registered editor; when it comes back changed the thumbnail and
  preview refresh.
- Preview and export share one Rust compositor, so what you scrub is what
  ffmpeg encodes. Frames come back over binary IPC and are cached.
- Undo and redo for everything, autosave every 30 s with crash recovery on
  next launch, and a relink dialog for media that moved on disk.

### Export

MP4 with H.264: hardware VideoToolbox on macOS when available, otherwise
libx264 with a quality (CRF) and speed preset. Transitions: cut, crossfade,
fade through black or white, slide and wipe in any direction, each with its
own duration, plus an outro fade.

### Formats

Photos: JPEG, PNG, GIF, WebP, BMP, TIFF, with EXIF orientation honoured.
Video: MP4, MOV, M4V, MKV, AVI, WebM. Audio: MP3, M4A, AAC, WAV, FLAC, OGG.
Anything ffmpeg can decode works as a clip.

Everything runs on your machine. There is no telemetry.

## Building from source

Prerequisites: Rust (stable), Node 20+, and **ffmpeg + ffprobe**.

ffmpeg is used for decoding video and encoding the MP4. Either install it
(`brew install ffmpeg`, `winget install ffmpeg`) or fetch static builds that
Tauri bundles as sidecars:

```sh
scripts/fetch-ffmpeg.sh        # macOS / Linux
scripts\fetch-ffmpeg.ps1       # Windows (PowerShell)
```

The Tauri build needs the sidecars present even for `dev`; without them it
fails with `resource path binaries/ffmpeg-<triple> doesn't exist`. At runtime
the engine looks next to the executable, then in `binaries/`, then on PATH.
`SLIDESHOW_FFMPEG_DIR` overrides all three.

The first build also downloads ONNX Runtime (via the `ort` crate), so it
needs network access once.

```sh
cd app
npm install
npm run tauri dev      # run the app
npm run tauri build    # installers in target/release/bundle/
```

### Optional models

Auto-build works out of the box using capture dates, colour fingerprints and
a bundled face detector. Two optional ONNX models make it much better at
recognising the same moment across angles and rooms, and enable ordering by
apparent era:

| File | Purpose |
|---|---|
| `clip-vision-b32-int8.onnx` | Scene embeddings (CLIP ViT-B/32, int8) |
| `facenet-vggface2.onnx` | Face identity embeddings |

Place them in `<app data>/models/`, which on macOS is
`~/Library/Application Support/com.jarektoro.quelindo/models/`.
`SLIDESHOW_EMBED_MODEL` points at the CLIP model directly. The app gates the
related features off when the files are absent.

## Command line

The same engine ships as a headless CLI, `slideshow`, for scripting and CI:

```sh
cargo run --release -p slideshow-cli -- new myshow                          # scaffold a project
cargo run --release -p slideshow-cli -- info project.slideshow.json          # duration and per-slide timing
cargo run --release -p slideshow-cli -- probe photo.jpg                      # media metadata as JSON
cargo run --release -p slideshow-cli -- frame project.slideshow.json -t 3.2 -o frame.png
cargo run --release -p slideshow-cli -- render project.slideshow.json -o out.mp4
```

`render` takes `--scale`, `--crf`, `--preset` and `--encoder` (software x264
or VideoToolbox on macOS). Try the full-feature example:

```sh
examples/make-test-media.sh
cargo run --release -p slideshow-cli -- render examples/test.slideshow.json -o examples/out/test.mp4
```

## Project files

A project is JSON with `settings` (size, fps, background), `slides`, and
`audio` tracks. The main knobs:

- **Slides**: duration, layout (`single`, `rows`, `columns`, `grid`,
  `featured`, `custom` rects), margin/gutter, background (colour or a blurred
  cover of one of the slide's own photos), transition into the slide.
- **Cells** (one per photo or clip): `cover`/`contain` fit, motion (`zoom` or
  `ken_burns` from/to crop windows), corner radius, border. Video cells can
  seek (`start`) and contribute audio (`mute: false`).
- **Text overlays**: role, font, weight, size, colour, align, anchor and
  offset, wrap width, shadow, backing box, `start`/`end` with fades.
- **Audio tracks**: placement, seek offset, gain, fade in/out, loop to fill.

See [examples/test.slideshow.json](examples/test.slideshow.json) for every
feature in one file.

## Scanning old prints

[tools/autocrop](tools/autocrop) is a companion for the step before the
slideshow: photographs of printed photos laid on a plain background.
`autocrop.py` finds each print, straightens it and crops it at full
resolution. `review.py` opens the same detection in a browser so you can nudge
the corners before committing. Both are single-file Python scripts with inline
dependencies (`uv run tools/autocrop/review.py scans/`).

## Restoring old photos

The photos that matter most at a memorial are often the worst ones: prints
photographed on a kitchen table, scans of faded snapshots, faces gone soft.
The **Restore** view is a small photo-restoration studio inside the app for
exactly those. Right-click a photo (on the shelf, a card, or a member of a
group) and choose **Restore photo…**, or press *Restore photo…* in the
inspector's Photo group. The photo opens on its own, full window.

### The view

- **Left, the photo.** Wheel to zoom, drag to pan, `F` fits, `1` is actual
  pixels. Once there is a result, the *Original / Result / Split* buttons swap
  what you see; *Split* draws a divider you drag across the photo, and holding
  **Space** peeks at the original from anywhere.
- **Right, the pipeline.** A preset picker, then the list of steps the run
  applies in order. Every step has a *blend* against its own input, so "faces
  at 60%" is a slider, not a repaint, and moving it after a run is free.
  Steps reorder with the arrows; **+ Add step** offers the whole vocabulary.
- **Run** shows what the engine is doing ("step 2/3: PMRF, 25 flow steps") and
  keeps a log. Results are cached per step, so changing a later step or a
  blend does not re-run the earlier ones.
- `←` `→` walk the shelf photo by photo, so a pile of scans can be worked
  through without leaving the view. `Esc` returns to the film.

### The steps

- **Crop a photographed print** — [tools/autocrop](tools/autocrop) as a step.
  **Detect corners** finds the print on its background (a towel, a table) and
  drops four handles on the photo; **Adjust corners** lets you place them by
  hand; *Inset* trims a sliver of background, *Turn* rotates in quarter turns.
  The run straightens the print at full resolution. As the first step it feeds
  a clean print into everything after it.
- **Faces: PMRF** — [PMRF](https://github.com/ohayonguy/PMRF) blind face
  restoration. Faces are detected, aligned, restored and pasted back; nothing
  else in the photo is touched. *Flow steps* trades time for fidelity;
  *Posterior mean only* gives the minimal-distortion estimate with no
  hallucinated detail.
- **Old print: Bringing Old Photos Back to Life** — Microsoft's model for
  faded, noisy, damaged prints, with optional scratch detection and inpainting
  and an optional face pass of its own.
- **Model** — any 1× model [spandrel](https://github.com/chaiNNer-org/spandrel)
  loads from `tools/restore/models/`: SCUNet and Restormer for denoising and
  deblurring, SwinIR for JPEG cleanup, GFPGAN, CodeFormer and RestoreFormer
  for faces, and the 1× models on [OpenModelDB](https://openmodeldb.info/?t=1x).
  Large photos run tiled.
- **Resize, Sharpen, Add grain** — the plain tools around the models: shrink a
  huge scan before a denoiser, sharpen after, put a little grain back on a
  result that came out too smooth.
- **Shell command** — a `{in}` `{out}` template for research code in its own
  environment.

Presets cover the common cases (*Crop a scanned print*, *Old print + faces*,
*Faces, gentle*, *Denoise*…) and any pipeline can be saved as your own.

### Keeping the result

Nothing touches the file until you say so. **Replace original** writes the
result over the photo and moves the original to `_originals/` beside it; the
film refreshes the way it does after editing in an external app. **Save as
copy** writes a new file, puts it on the shelf, and offers to use it in the
film in place of the original. JPEG quality is a field next to both.

### The engine

The restoration models run in Python, in [tools/restore](tools/restore): a
small local server the app starts on demand on a free localhost port and stops
when it quits. Nothing leaves the machine. It is optional and installs once:

```sh
tools/restore/setup.sh            # models for faces, denoising, deblurring (about 2 GB)
tools/restore/setup.sh --all      # plus PMRF and Bringing Old Photos Back to Life
```

Without it the Restore view says so and shows the command. Apple Silicon runs
everything on the GPU; PMRF's CUDA-only neighbourhood attention is
re-implemented there as tiled dense attention, about 0.4 s per flow step on an
M2 Pro. The same folder is a standalone lab for model work: a web UI that
compares many pipelines on one image in a synced, zoomable grid, a folder
curator, and command-line runners for PMRF and Old Photos over a whole folder.
See [tools/restore/README.md](tools/restore/README.md). The models carry their
own licenses (CodeFormer and Restormer are non-commercial); they are listed in
[THIRD_PARTY.md](THIRD_PARTY.md).

## Development

```
crates/slideshow-core   engine: project model, timeline, layouts, compositor,
                        text, media decode, audio mix, moment grouping, export
crates/slideshow-cli    headless CLI (bin: slideshow)
app/                    Tauri v2 app (React + TypeScript), face detection,
                        embeddings, preview server
app/e2e/                WebdriverIO end-to-end suites against the real app
                        (tools/screenshots.spec.ts regenerates the README shots;
                        see its header, the last two need the restore engine)
examples/               full-feature project + placeholder media generator
scripts/                ffmpeg sidecar fetchers
tools/autocrop          print scanning helper
tools/restore           photo restoration engine (Python) behind the Restore view
assets/fonts/           bundled OFL fonts (Crimson Text, Lato)
assets/brand/           logo (full, mark, wordmark) and the icon source
docs/                   screenshots and the editor-shell schematic
```

```sh
cargo test -p slideshow-core -p slideshow-cli   # engine unit tests
cd app && npx tsc --noEmit                      # frontend typecheck
cd app && npm run e2e:build && npm run e2e     # end-to-end suites (see app/e2e/README.md)
cd app && npm run dev:mcp                       # app with the MCP debug bridge for agents
```

End-to-end tests use WebdriverIO with `@wdio/tauri-service`, the setup Tauri
documents, against a debug build that embeds a WebDriver server. `dev:mcp`
enables the `mcp` Cargo feature, an agent debugging bridge over a local
socket. Both are development-only and never part of a distributed build.

## License

MIT. See [LICENSE](LICENSE). Bundled fonts, models and ffmpeg builds carry
their own licenses; see [THIRD_PARTY.md](THIRD_PARTY.md).
