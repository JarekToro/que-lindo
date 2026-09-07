# Third-party notices

Que Lindo's own code is MIT licensed (see `LICENSE`). It ships or relies on
the following work under other terms.

## Fonts (bundled, `assets/fonts/`)

- **Crimson Text** and **Lato** are distributed under the SIL Open Font
  License 1.1. The full license texts are in `assets/fonts/OFL-CrimsonText.txt`
  and `assets/fonts/OFL-Lato.txt`.

## ffmpeg (sidecar, not in this repository)

`scripts/fetch-ffmpeg.*` download static ffmpeg and ffprobe builds from
evermeet.cx (macOS), johnvansickle.com (Linux) and gyan.dev (Windows). Those
builds are GPL-licensed. If you distribute an installer that bundles them,
keep their license and attribution, and provide their source on request as
the GPL requires. Building ffmpeg is out of scope for this project; see
https://ffmpeg.org/legal.html.

## Face detection model (bundled, `app/src-tauri/assets/`)

`seeta_fd_frontal_v1.0.bin` is the SeetaFace frontal face detection model,
used through the `rustface` crate. SeetaFace Engine is released under the
BSD 2-Clause license by the Visual Information Processing and Learning group
at the Institute of Computing Technology, Chinese Academy of Sciences.

## Optional models (user supplied, not in this repository)

- **CLIP ViT-B/32** vision tower (`clip-vision-b32-int8.onnx`): OpenAI,
  MIT license. Obtain and quantize it yourself; the app works without it.
- **FaceNet (VGGFace2)** (`facenet-vggface2.onnx`): check the license of
  whichever conversion you use.

## Era ordering

The linear probe in `app/src/era.ts` was trained on the *Date Estimation in
the Wild* dataset (Müller, Springstein, Ewerth, 2017), distributed under
CC BY 4.0. Only the learned weights are included here, not the dataset.

## Rust and npm dependencies

See `Cargo.lock` and `app/package-lock.json` for the complete dependency
graph. `cargo license` and `npx license-checker` will list their licenses.
