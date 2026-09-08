# Going public: checklist

Tracking what stands between this repository and a public GitHub repo named
**Qué lindo**. Tick items as they land; delete this file when it is empty.

## Done (2026-09-07)

- [x] Rename the product to **Qué lindo** everywhere the name is user- or
      tool-visible: Tauri `productName`, window title, bundle identifier
      (`com.jarektoro.quelindo`), npm package name, HTML title, top bar brand,
      MCP plugin name and socket (`/tmp/que-lindo-mcp.sock`), CI artifact name,
      design-system docs, editor schematic.
- [x] Point `Cargo.toml` `repository` at `https://github.com/JarekToro/que-lindo`.
- [x] Rewrite `README.md`: dedication, honest feature list, build steps,
      optional models, CLI, project format, tools, development.
- [x] Add `THIRD_PARTY.md` (fonts, ffmpeg, SeetaFace model, CLIP, FaceNet,
      DEW dataset attribution).
- [x] Stop tracking `app/src-tauri/gen/schemas` (Tauri regenerates them) and
      ignore `__pycache__`, `*.pyc`, `.DS_Store`.
- [x] Remove `plans/x.md` (an Aug 31 plan whose phases 0 to 5 have shipped;
      the leftovers are listed under "Later" below).
- [x] Add `tools/autocrop` (print scanning helpers) to the repo.
- [x] Add `tools/restore` (photo restoration engine, formerly the separate
      Image-restore-compare folder) and the in-app Restore view that drives it.
      Weights, clones and venvs are git-ignored; `tools/restore/setup.sh`
      rebuilds them. Licenses listed in `THIRD_PARTY.md` (CodeFormer and
      Restormer are non-commercial).

## Before the first push

- [ ] **Decide what to do with the uncommitted work.** The tree has an
      in-flight feature (Edit in external app, font weight snapping, track
      values pane, time-mode e2e tests). `cargo check` and `tsc` pass with it.
      Commit it as its own change before the rename commit, or stash it.
      Note that the README already lists "Edit in an external app" as a
      feature; drop that bullet if the work is shelved.
- [x] GitHub repo renamed to `que-lindo`, local remote updated (2026-09-07).
      The local folder is still `memorial-slideshow-gen`; rename it when
      convenient. Nothing in the build depends on the folder name.
- [x] Screenshots re-taken 2026-09-07 with generated gradient media via
      `app/e2e/tools/screenshots.spec.ts` (see its header for the command).
      Swap in shots with real photos whenever you have some you can publish.
- [ ] Make a real app icon. `app/src-tauri/icons/` is still the Tauri
      placeholder.
- [ ] Read the dedication paragraph at the top of `README.md` and make it
      yours. It is written in your voice from what you said; adjust freely.
- [ ] Skim `git log` for anything you would not want public. History has 95
      commits from you and from Claude sessions; there are no tracked media or
      personal paths.
- [ ] Move the ML models you already have into the new app-data folder. The
      bundle identifier changed, so the app now reads
      `~/Library/Application Support/com.jarektoro.quelindo/models/` and
      recovery/autosave state from the same new folder. Copy or `mv` from
      `com.jarektoro.slideshow-studio`.
- [x] Run the e2e suites after the rename. Done 2026-09-07 on the new
      WebdriverIO suite: 76 of 76 pass. The specs that targeted the old
      Values pane were rewritten against the current inspector (member strip,
      labelled sliders, "▶ Slide" in the scope head). Re-run with
      `cd app && npm run e2e:build && npm run e2e`.
- [x] GitHub repo renamed to `que-lindo`, local remote updated (2026-09-07).
      The local folder is still `memorial-slideshow-gen`; rename it when
      convenient. Nothing in the build depends on the folder name.
- [x] Screenshots re-taken 2026-09-07 with generated gradient media via
      `app/e2e/tools/screenshots.spec.ts` (see its header for the command).
      Swap in shots with real photos whenever you have some you can publish.
- [ ] Make a real app icon. `app/src-tauri/icons/` is still the Tauri
      placeholder.
- [ ] Read the dedication paragraph at the top of `README.md` and make it
      yours. It is written in your voice from what you said; adjust freely.
- [ ] Skim `git log` for anything you would not want public. History has 95
      commits from you and from Claude sessions; there are no tracked media or
      personal paths.
- [ ] Move the ML models you already have into the new app-data folder. The
      bundle identifier changed, so the app now reads
      `~/Library/Application Support/com.jarektoro.quelindo/models/` and
      recovery/autosave state from the same new folder. Copy or `mv` from
      `com.jarektoro.slideshow-studio`.
- [x] Run the e2e suites after the rename. Done 2026-09-07 on the new
      WebdriverIO suite: 67 of 76 pass. Eight failures reference Values-pane
      UI that the uncommitted Inspector work removed or renamed ("Bigger",
      "Longer", "← Slide", the "▶" audition button in `.outcome-head`, the
      "Members" scope, the margin slider) — the same tests failed under the
      old harness. Fix the specs or the UI when that work lands. The ninth,
      "the audio lane draws the mix waveform", passes alone and fails when
      another suite ran first; the lane effect gets a null mix once and never
      redraws. Diagnosis notes in `app/e2e/README.md`. Re-run with
      `cd app && npm run e2e:build && npm run e2e`.

## Repo polish

- [x] Migrate e2e from the custom socket harness to WebdriverIO with
      `@wdio/tauri-service` (embedded provider, works on macOS). Done
      2026-09-07; see `app/e2e/README.md` and `docs/e2e-webdriverio-plan.md`
      for what the spike found.
- [ ] Upstream: pointer events, click modifiers and `contextmenu` in
      `tauri-plugin-wdio-webdriver` (github.com/webdriverio/desktop-mobile),
      so `app/e2e/page/app.ts` can drop its in-page gesture helpers.

- [ ] Add a short `CONTRIBUTING.md` or a "Contributing" section (how to run
      tests, that `dev:mcp` is dev-only, that PRs should keep `tsc` clean).
- [ ] Add a `.github/ISSUE_TEMPLATE/bug_report.md` asking for OS, ffmpeg
      source, and a project file.
- [ ] Add a release workflow (tag → `tauri build` → GitHub Release with the
      `.dmg`/`.msi`). `build.yml` already produces the bundles as artifacts.
- [ ] Publish a script or documentation for producing the two optional ONNX
      models (CLIP ViT-B/32 int8 and FaceNet), or host them and add a fetch
      script like `fetch-ffmpeg.sh`. Today a new user cannot reproduce the
      full auto-build quality.
- [ ] Consider a Homebrew cask or notarized macOS build. Unsigned builds show
      Gatekeeper warnings.
- [ ] `docs/editor-shell-schematic.html` is a design artifact from the
      Arrange/Time redesign. Keep it if it still reflects the app; otherwise
      delete it.

## Code low-hanging fruit

Observed while surveying; none are blockers.

- [ ] `app/src/presets.ts` still calls its presets "memorial-oriented" in the
      header comment and the Presets menu offers "Apply memorial pacing" only.
      Decide whether defaults stay memorial-flavoured or other occasion
      presets join it.
- [ ] The UI has no ARIA roles or labels beyond a few `aria-label`s.
      Phase 6 of the old plan.

- [ ] Windows: "Edit in external app" returns no editors outside macOS;
      confirm the fallback ("open with default app") works there.
- [ ] `ort` uses `download-binaries`, which fetches ONNX Runtime at build
      time. Document a vendored path for offline builds, or accept it.

## Later (leftovers from the retired plan)

- [ ] Accessibility pass (keyboard grammar exists; labels and roles do not).
- [ ] Occasion presets beyond memorial.
- [ ] Open design questions from the editor-shell brief: band layout at 7 to
      8 members, keeping an opened group's row in view during reflow, card
      size at the 1100 px minimum width, the `Values ▸` disclosure pattern.
