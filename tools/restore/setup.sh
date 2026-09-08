#!/bin/sh
# One-time setup for tools/restore. Idempotent: re-run to fill in what is missing.
#
#   tools/restore/setup.sh            # main env + starter weights (spandrel models, GFPGAN, CodeFormer…)
#   tools/restore/setup.sh --pmrf     # + PMRF blind face restoration (clone, own venv; weights download on first run)
#   tools/restore/setup.sh --bopbtl   # + Microsoft "Bringing Old Photos Back to Life" (clone, own venv, weights)
#   tools/restore/setup.sh --all
#
# Needs `uv` (https://docs.astral.sh/uv/) and `git`. Everything lands inside this
# folder (.venv, models/, external/), all of it git-ignored.
set -eu
cd "$(dirname "$0")"

want_pmrf=0
want_bopbtl=0
for arg in "$@"; do
  case "$arg" in
    --pmrf) want_pmrf=1 ;;
    --bopbtl) want_bopbtl=1 ;;
    --all) want_pmrf=1; want_bopbtl=1 ;;
    -h|--help) sed -n '2,12p' "$0"; exit 0 ;;
    *) echo "unknown option: $arg" >&2; exit 2 ;;
  esac
done

command -v uv >/dev/null || { echo "uv not found: brew install uv (or see https://docs.astral.sh/uv/)" >&2; exit 1; }
PY=3.10

echo "== main environment (.venv)"
[ -x .venv/bin/python ] || uv venv --python "$PY" .venv
uv pip install --python .venv/bin/python -q \
  torch torchvision spandrel spandrel_extra_arches \
  fastapi "uvicorn[standard]" python-multipart pillow numpy opencv-python-headless facexlib certifi

echo "== starter weights (models/)"
.venv/bin/python download_models.py all

if [ "$want_pmrf" = 1 ]; then
  echo "== PMRF"
  [ -d external/PMRF ] || git clone --depth 1 https://github.com/ohayonguy/PMRF.git external/PMRF
  [ -x external/pmrf-venv/bin/python ] || uv venv --python "$PY" external/pmrf-venv
  uv pip install --python external/pmrf-venv/bin/python -q \
    torch torchvision pytorch_lightning torchmetrics torch-ema torch-fidelity einops timm \
    huggingface_hub safetensors opencv-python-headless scipy pillow numpy certifi
  echo "   PMRF ready; its ~2 GB of weights download from Hugging Face on first use."
fi

if [ "$want_bopbtl" = 1 ]; then
  echo "== Bringing Old Photos Back to Life"
  B=external/BOPBTL
  [ -d "$B" ] || git clone --depth 1 https://github.com/microsoft/Bringing-Old-Photos-Back-to-Life.git "$B"
  # numpy >= 1.24 refuses the in-place float multiply upstream does on a uint8 mask
  if ! git -C "$B" apply --reverse --check ../../patches/bopbtl-blend-mask-dtype.patch 2>/dev/null; then
    git -C "$B" apply ../../patches/bopbtl-blend-mask-dtype.patch
  fi
  [ -x external/bopbtl-venv/bin/python ] || uv venv --python "$PY" external/bopbtl-venv
  uv pip install --python external/bopbtl-venv/bin/python -q \
    torch torchvision dlib-bin scikit-image easydict PyYAML dominate dill tensorboardX scipy \
    opencv-python-headless einops matplotlib pillow numpy
  # Synchronized-BatchNorm, vendored the way upstream's download-weights does it
  if [ ! -d "$B/Face_Enhancement/models/networks/sync_batchnorm" ]; then
    git clone --depth 1 -q https://github.com/vacancy/Synchronized-BatchNorm-PyTorch "$B/_sbn"
    cp -R "$B/_sbn/sync_batchnorm" "$B/Face_Enhancement/models/networks/"
    cp -R "$B/_sbn/sync_batchnorm" "$B/Global/detection_models/"
    rm -rf "$B/_sbn"
  fi
  if [ ! -f "$B/Face_Detection/shape_predictor_68_face_landmarks.dat" ]; then
    curl -L -o "$B/Face_Detection/shape_predictor_68_face_landmarks.dat.bz2" http://dlib.net/files/shape_predictor_68_face_landmarks.dat.bz2
    bzip2 -d "$B/Face_Detection/shape_predictor_68_face_landmarks.dat.bz2"
  fi
  REL=https://github.com/microsoft/Bringing-Old-Photos-Back-to-Life/releases/download/v1.0
  if [ ! -d "$B/Face_Enhancement/checkpoints" ]; then
    curl -L -o "$B/Face_Enhancement/checkpoints.zip" "$REL/face_checkpoints.zip"
    (cd "$B/Face_Enhancement" && unzip -q checkpoints.zip && rm checkpoints.zip)
  fi
  if [ ! -d "$B/Global/checkpoints" ]; then
    curl -L -o "$B/Global/checkpoints.zip" "$REL/global_checkpoints.zip"
    (cd "$B/Global" && unzip -q checkpoints.zip && rm checkpoints.zip)
  fi
fi

echo
echo "done. Run the standalone UI with tools/restore/run.sh, or open a photo's Restore view in the app."
