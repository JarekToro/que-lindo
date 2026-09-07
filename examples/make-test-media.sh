#!/usr/bin/env bash
# Generates the placeholder media referenced by test.slideshow.json.
set -euo pipefail
cd "$(dirname "$0")"

# Prefer the sidecar scripts/fetch-ffmpeg.sh downloads, then fall back to a
# system ffmpeg. The sidecar is the build the app itself resolves at runtime
# (Ffmpeg::locate looks beside the executable before PATH), so the fixtures get
# made by the same ffmpeg the specs go on to exercise. It is also the one whose
# filters we know: a distro or Homebrew ffmpeg may be built without drawtext.
case "$(uname -s)/$(uname -m)" in
  Darwin/arm64) TRIPLE=aarch64-apple-darwin ;;
  Darwin/*)     TRIPLE=x86_64-apple-darwin ;;
  *)            TRIPLE=x86_64-unknown-linux-gnu ;;
esac
FFMPEG="../app/src-tauri/binaries/ffmpeg-$TRIPLE"
if [ ! -x "$FFMPEG" ]; then
  if command -v ffmpeg >/dev/null 2>&1; then
    FFMPEG=ffmpeg
  else
    echo "error: no sidecar at examples/$FFMPEG and no ffmpeg on PATH" >&2
    echo "  run scripts/fetch-ffmpeg.sh $TRIPLE, or install ffmpeg" >&2
    exit 1
  fi
fi

mkdir -p media out

# Frames need visible detail: several specs assert that a zoom or crop change
# alters the rendered frame, and a flat colour field is identical under any
# such transform. drawtext supplies that detail but needs libfreetype and a
# font it can actually load, so probe it by actually running it — `-filters |
# grep -q` trips SIGPIPE under `set -o pipefail`, and would miss a fontless
# build either way. Naming a font file comes first: static builds carry no
# fontconfig configuration, so asking for a font by name fails on them even
# though the filter is there. The fallback draws boxes, which every build can do.
FONT=""
FOUND=""
for candidate in \
  /System/Library/Fonts/Supplemental/Arial.ttf \
  /System/Library/Fonts/Helvetica.ttc \
  /usr/share/fonts/truetype/dejavu/DejaVuSans.ttf \
  ""; do
  [ -z "$candidate" ] || [ -f "$candidate" ] || continue
  prefix=""
  [ -z "$candidate" ] || prefix="fontfile=$candidate:"
  if "$FFMPEG" -v error -f lavfi -i "color=c=black:s=64x64" -frames:v 1 \
       -vf "drawtext=${prefix}text=probe:fontsize=12:fontcolor=white" -f null - >/dev/null 2>&1; then
    FONT="$prefix"
    FOUND=yes
    break
  fi
done
if [ -n "$FOUND" ]; then
  VF="drawtext=${FONT}text='LABEL':fontsize=120:fontcolor=white:x=(w-text_w)/2:y=(h-text_h)/2"
else
  echo "note: no usable drawtext filter — labelling frames with boxes instead" >&2
  VF="drawbox=x=iw*0.12:y=ih*0.12:w=iw*0.32:h=ih*0.26:color=white@0.95:t=fill,drawbox=x=iw*0.54:y=ih*0.56:w=iw*0.30:h=ih*0.28:color=black@0.75:t=fill"
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
