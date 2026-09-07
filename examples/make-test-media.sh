#!/usr/bin/env bash
# Generates the placeholder media referenced by test.slideshow.json.
set -euo pipefail
cd "$(dirname "$0")"

# Prefer a system ffmpeg, then fall back to the sidecar scripts/fetch-ffmpeg.sh
# downloads. The macOS e2e runner has no ffmpeg on PATH but does fetch the
# sidecar, so either one is enough to generate fixtures.
FFMPEG=ffmpeg
if ! command -v ffmpeg >/dev/null 2>&1; then
  case "$(uname -s)/$(uname -m)" in
    Darwin/arm64) TRIPLE=aarch64-apple-darwin ;;
    Darwin/*)     TRIPLE=x86_64-apple-darwin ;;
    *)            TRIPLE=x86_64-unknown-linux-gnu ;;
  esac
  FFMPEG="../app/src-tauri/binaries/ffmpeg-$TRIPLE"
  if [ ! -x "$FFMPEG" ]; then
    echo "error: no ffmpeg on PATH and no sidecar at examples/$FFMPEG" >&2
    echo "  install ffmpeg, or run scripts/fetch-ffmpeg.sh $TRIPLE" >&2
    exit 1
  fi
fi

mkdir -p media out

# The label burned into each frame is a human convenience — specs match
# fixtures by filename — and drawtext needs libfreetype, which some static
# builds omit. Fall back to a plain colour field rather than failing.
if "$FFMPEG" -hide_banner -filters 2>/dev/null | grep -qw drawtext; then
  VF="drawtext=text='LABEL':fontsize=120:fontcolor=white:x=(w-text_w)/2:y=(h-text_h)/2"
else
  echo "note: this ffmpeg has no drawtext filter — writing unlabelled frames" >&2
  VF="null"
fi

for spec in "red:1600x1000:ONE" "royalblue:1000x1500:TWO-portrait" "seagreen:1600x1000:THREE" "goldenrod:1200x1200:FOUR" "mediumpurple:1600x900:FIVE" "chocolate:1400x1000:SIX"; do
  c=${spec%%:*}; rest=${spec#*:}; s=${rest%%:*}; label=${rest#*:}
  "$FFMPEG" -v error -y -f lavfi -i "color=c=$c:s=$s" -frames:v 1 \
    -vf "${VF//LABEL/$label}" \
    "media/img_$label.png"
done
"$FFMPEG" -v error -y -f lavfi -i "testsrc2=s=1280x720:r=30:d=6" -f lavfi -i "sine=frequency=520:d=6" \
  -c:v libx264 -pix_fmt yuv420p -c:a aac -shortest media/clip.mp4
"$FFMPEG" -v error -y -f lavfi -i "sine=frequency=220:beep_factor=4:d=40" -c:a libmp3lame media/music.mp3
"$FFMPEG" -v error -y -f lavfi -i "sine=frequency=330:beep_factor=3:d=30" -c:a libmp3lame media/music2.mp3
echo "test media written to $(pwd)/media"
