#!/usr/bin/env bash
# Downloads static ffmpeg + ffprobe builds into app/src-tauri/binaries/ with
# the target-triple names Tauri expects for sidecar bundling.
#
# Usage: scripts/fetch-ffmpeg.sh [target-triple]
#   default target: this machine's
set -euo pipefail
cd "$(dirname "$0")/.."
DEST="app/src-tauri/binaries"
mkdir -p "$DEST"

detect_triple() {
  local os arch
  os=$(uname -s)
  arch=$(uname -m)
  case "$os" in
    Darwin)
      case "$arch" in
        arm64) echo "aarch64-apple-darwin" ;;
        *) echo "x86_64-apple-darwin" ;;
      esac ;;
    Linux) echo "x86_64-unknown-linux-gnu" ;;
    *) echo "unsupported OS $os (use fetch-ffmpeg.ps1 on Windows)" >&2; exit 1 ;;
  esac
}

TRIPLE="${1:-$(detect_triple)}"
echo "fetching ffmpeg for $TRIPLE -> $DEST"
TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT

fetch_macos() {
  # Martin Riedl's build server serves per-tool zips of static builds for both
  # macOS architectures. The arch matters beyond speed: VideoToolbox only
  # offers constant-quality H.264 on Apple Silicon, so an x86_64 ffmpeg under
  # Rosetta fails every export outright with "qscale not available for
  # encoder". evermeet.cx, which this used to fetch, is Intel-only by policy.
  local arch
  case "$TRIPLE" in
    aarch64-*) arch=arm64 ;;
    *) arch=amd64 ;;
  esac
  for tool in ffmpeg ffprobe; do
    echo "  downloading $tool (macos/$arch) ..."
    curl -fL --retry 3 "https://ffmpeg.martin-riedl.de/redirect/latest/macos/$arch/release/$tool.zip" -o "$TMP/$tool.zip"
    unzip -oq "$TMP/$tool.zip" -d "$TMP"
    install -m 755 "$TMP/$tool" "$DEST/$tool-$TRIPLE"
  done
}

fetch_linux() {
  echo "  downloading johnvansickle static build ..."
  curl -fL --retry 3 "https://johnvansickle.com/ffmpeg/releases/ffmpeg-release-amd64-static.tar.xz" -o "$TMP/ffmpeg.tar.xz"
  tar -xJf "$TMP/ffmpeg.tar.xz" -C "$TMP"
  local dir
  dir=$(find "$TMP" -maxdepth 1 -type d -name "ffmpeg-*" | head -1)
  install -m 755 "$dir/ffmpeg" "$DEST/ffmpeg-$TRIPLE"
  install -m 755 "$dir/ffprobe" "$DEST/ffprobe-$TRIPLE"
}

case "$TRIPLE" in
  *apple-darwin) fetch_macos ;;
  *linux*) fetch_linux ;;
  *) echo "unknown triple $TRIPLE" >&2; exit 1 ;;
esac

# Verify the sidecars actually landed (a silent partial fetch must fail CI).
for tool in ffmpeg ffprobe; do
  if [ ! -x "$DEST/$tool-$TRIPLE" ]; then
    echo "error: $DEST/$tool-$TRIPLE was not created" >&2
    exit 1
  fi
done

# And that they are the architecture the triple claims. A binary of the wrong
# arch still runs under Rosetta, so the mismatch shows up not as a crash but as
# missing hardware encoders — worth failing here rather than at export time.
case "$TRIPLE" in
  *apple-darwin)
    want=$([ "${TRIPLE%%-*}" = "aarch64" ] && echo arm64 || echo x86_64)
    for tool in ffmpeg ffprobe; do
      got=$(file -b "$DEST/$tool-$TRIPLE")
      case "$got" in
        *"$want"*) ;;
        *) echo "error: $tool-$TRIPLE is not $want: $got" >&2; exit 1 ;;
      esac
    done
    ;;
esac

echo "done:"
ls -la "$DEST"
echo
echo "note: bundled ffmpeg builds are GPL-licensed - keep the attribution if you distribute the app."
