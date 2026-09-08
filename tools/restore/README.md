# restore

Photo restoration engine for Qué lindo, and a standalone comparison lab.
Restoration models (denoise, deblur, faces), PMRF blind face restoration and
Microsoft's *Bringing Old Photos Back to Life*, run locally on Apple Silicon
(MPS), CUDA or CPU. The app's **Restore** view (right-click a photo → *Restore
photo…*) drives this same engine; the web UIs in `static/` are for comparing
models and parameters side by side.

## Setup

Needs [uv](https://docs.astral.sh/uv/) and git. Everything installs into this
folder (all of it git-ignored):

```bash
tools/restore/setup.sh            # main env + starter weights
tools/restore/setup.sh --all      # + PMRF and Bringing Old Photos Back to Life
```

`setup.sh` is idempotent; re-run it to add the optional engines later. The app
looks for this folder at `SLIDESHOW_RESTORE_DIR`, then
`<app data>/restore`, then (debug builds) the repository's `tools/restore`, and
starts the server itself on a free localhost port when the Restore view opens.

## Run the standalone UI

```bash
tools/restore/run.sh            # http://127.0.0.1:8787
```

- `/` compare many pipelines on one image in a synced zoomable grid
- `/curate.html` walk a folder, run a preset per photo, replace or save as
- `/folders.html` compare two folders of results

## Models

Drop `.pth` / `.safetensors` files into `models/`. Architecture is auto-detected by
[spandrel](https://github.com/chaiNNer-org/spandrel): SCUNet, NAFNet, Restormer, SwinIR,
ESRGAN/Compact/etc 1x models from [OpenModelDB](https://openmodeldb.info/?t=1x),
GFPGAN, CodeFormer, RestoreFormer, and many more.

Starter set (GitHub-hosted weights):

```bash
.venv/bin/python download_models.py            # list
.venv/bin/python download_models.py all        # SCUNet, Restormer, GFPGAN, CodeFormer, SwinIR...
```

NAFNet weights are on Google Drive; download by hand from the NAFNet README.

Face models (GFPGAN / CodeFormer / RestoreFormer) run through facexlib
detect → align → restore → paste back automatically. Detector weights download
on first use into `models/facexlib/`. Any other model can be forced onto aligned
face crops with the `face` checkbox.

## Variants

A variant is a pipeline of steps, each with a `blend` (0..1) against the step's input:

| step | params | notes |
|---|---|---|
| `model` | model, tile, w, face | `w` = CodeFormer fidelity; tile 0 = whole image |
| `pmrf` | steps, seed, mmse | PMRF blind face restoration, see below |
| `bopbtl` | scratch, hr | Microsoft "Bringing Old Photos Back to Life", see below |
| `cmd` | shell template | `{in}` `{out}` `{tmp}` substituted. For research code in its own venv (PMRF etc). |
| `resize` | scale, method | e.g. downscale before a denoiser, upscale after |
| `sharpen` | amount, radius | unsharp mask |
| `grain` | amount, size, seed | add grain back after an over-clean denoise |
| `autocrop` | quad, inset, rotate | straighten + crop a photographed print ([tools/autocrop](../autocrop)); `quad` = four corners as fractions, or null to detect |

`blend 0.35` on GFPGAN = mild reconstruction; `blend 1` = full model output.

Blend is a pixel-space mix applied after the step, so the raw (blend 1) output of every
step is cached in `cache/steps/`. A blend sweep such as `1, 0.7, 0.4` on PMRF 25 costs one
PMRF run; the other values are instant. Changing seed, steps, or any earlier step is a new run.

**Matrix builder**: check models, give lists for blend / w, and it emits one variant
per combination.

## PMRF

[PMRF](https://github.com/ohayonguy/PMRF) is built in as its own step type (`pmrf`), with
params `steps` (flow steps, 25 default; fewer = closer to the posterior mean), `seed`, and
`mmse` (return only the SwinIR posterior-mean estimate, the "minimal distortion" baseline).
It runs on aligned faces through the same detect / align / paste-back path as GFPGAN, so
`blend` behaves the same way.

It lives in `external/`: the upstream repo is cloned to `external/PMRF`, deps are in
`external/pmrf-venv`, and `external/pmrf_worker.py` keeps the model loaded in a separate
process that the app starts on first use (weights download from Hugging Face on first run,
about 2 GB). `natten` (CUDA-only) is replaced by [na_tiled.py](na_tiled.py): exact NATTEN
neighborhood attention expressed as tiled dense attention (8x8 query tiles, 3px halo, window
mask), which runs as batched matmuls on MPS. About 0.4 s per flow step on an M2 Pro, so a
25-step face is ~12 s; the posterior mean alone is under a second.

Setup: `tools/restore/setup.sh --pmrf` (clone + venv; weights come from Hugging
Face on first use). Self-test: `external/pmrf-venv/bin/python external/pmrf_worker.py --selftest`.

PMRF only, no UI:

```bash
.venv/bin/python pmrf.py in.jpg out.png --steps 25 --blend 0.6
.venv/bin/python pmrf.py photos/ restored/            # whole folder
.venv/bin/python pmrf.py in.jpg out.png --mmse        # posterior-mean estimate only
```

Worker log: `external/pmrf_worker.log`. Env: `RC_PMRF_PORT` (default 8788), `RC_PMRF_DEVICE`.

## Old Photos (Microsoft)

[Bringing Old Photos Back to Life](https://github.com/microsoft/Bringing-Old-Photos-Back-to-Life)
is the `bopbtl` step: global restoration (unstructured degradation), optional scratch
detection + inpainting (`scratches`), dlib face detection, face enhancement (`HR faces` uses
the 512px face model), and warp-back. Upstream code is CUDA/CPU only; the global stage
(the `faces` checkbox off, or `bopbtl.py` without `--faces`) runs on MPS through
`external/bopbtl_mps.py`, a launcher that redirects `.cuda()` / `torch.cuda.*` to MPS
without editing upstream files: ~7 s per 2000px image instead of ~4 min. The scratch and
face stages still run on CPU. Clone lives in `external/BOPBTL`, deps in
`external/bopbtl-venv`, last run's output in `external/bopbtl_last.log`.
`RC_BOPBTL_DEVICE=cpu` forces CPU. Scratch mode uses upstream's global non-local attention
whose memory is quadratic in image size; photos above roughly 800x800 are switched to the
`HR` patch-attention model automatically (also selectable with the `HR faces`/`--hr` flag).

## Curate (`/curate.html`)

Pick a folder, see every photo, run a preset on one, compare original vs result, then
either **Replace** (original moved to `_originals/` in that folder, result written under the
original name and format) or **Save as** a new file. Presets are editable step lists
(☰) and can be saved. Mobile-first, same touch controls as the folder comparer.

Setup: `tools/restore/setup.sh --bopbtl` (clone, venv, Synchronized-BatchNorm,
dlib landmarks, both checkpoint archives). It also applies
`patches/bopbtl-blend-mask-dtype.patch`: upstream multiplies a uint8 mask in
place, which numpy ≥ 1.24 refuses.

Other research code still fits the generic `cmd` step:

```
/path/to/venv/bin/python /path/to/script.py --input {in} --output {out}
```

Variants persist in the browser (localStorage) and can be exported / imported as JSON.

## Compare view

- wheel = zoom, drag = pan, synced across all cells; double-click / `F` = fit, `1` = 100%
- hold `space` = show original in every cell
- `D` = diff mode (|result − reference| × gain); click a cell's label to pin it as the reference
- crop mode: drag a rectangle on the source preview to run variants on that region only (fast iteration)
- results cache in `cache/` keyed by image + pipeline; `↻ fresh` clears and reruns

## Env

- `RC_DEVICE=cpu|mps|cuda` override device
- `RC_FACE_DEVICE` device for face detection (default `cpu`)
- `RC_MAX_LOADED` models kept in memory (default 3)
- `RC_MODELS_DIR`, `RC_CACHE_DIR` relocate weights and the result cache (default: here)
- `RC_ROOTS` folders the folder/curate APIs may touch, `os.pathsep`-separated (default: home)
- `RC_CORS=1` answer cross-origin requests (the app sets this; its webview is another origin)
- `PORT` server port (default 8787); `HOST=0.0.0.0` to reach it from a phone

## Layout

```
engine.py            model loading, face pipeline, PMRF/BOPBTL bridges, step runner + cache
server.py            FastAPI: compare / folder / curate APIs, static UIs
pmrf.py, bopbtl.py   command-line runners over a file or folder
na_tiled.py          NATTEN neighborhood attention as tiled dense attention (MPS)
download_models.py   starter weights
external/            pmrf_worker.py, bopbtl_mps.py (tracked); PMRF/, BOPBTL/, *-venv (ignored)
patches/             local fixes applied to the upstream clones by setup.sh
static/              index.html (compare), curate.html, folders.html
```
