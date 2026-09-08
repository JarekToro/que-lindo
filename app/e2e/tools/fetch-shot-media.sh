#!/usr/bin/env bash
# Media for the README screenshots: photographs from Unsplash under the
# Unsplash License, plus a music track made with the ffmpeg sidecar.
#
#   app/e2e/tools/fetch-shot-media.sh [outdir]     # default: e2e/tools/shot-media
#
# The photo list is pinned by Unsplash id so a re-shoot gets the same film:
# a plaza, a fort, a flower, a square, a car, a family lined up for a portrait,
# a child — the spread of a real album rather than a set chosen to flatter the
# app. Three frames of that family and two of the square come from the same
# scans: runs of near-duplicates are what auto-build folds into a collage, and
# without a run there is no collage for the README to show. Every one is under the plain Unsplash License; Unsplash+ photographs are
# licensed to the subscriber, not to whoever clones this repo, so they stay out.
set -euo pipefail
cd "$(dirname "$0")"

OUT=${1:-shot-media}
mkdir -p "$OUT"

# name|unsplash id|CDN slug|photographer|username
PHOTOS=(
  "01-plaza-yellow-church|LT_L1s54Fe4|photo-1737902629483-d00f49b623dd|Kyle Hinkson|whereiskylenow"
  "02-fort-by-the-sea|NebB2Lv_XPw|photo-1578867853811-10622df7a399|Stephanie Klepacki|sklepacki"
  "03-hibiscus|jTdtaVvgZTg|photo-1579997177684-dbaaf573e36e|Ronald Flores-Gunkle|ronald1"
  "04-yellow-car|8_U8iRY6OzQ|photo-1593606214413-618d3ccef78c|Brett Jordan|brett_jordan"
  "05-cathedral-square|j0GaM64waWk|photo-1701341289345-0bf48bedee6c|Annie Spratt|anniespratt"
  "06-cathedral-square-wide|KK06fX-Vyh8|photo-1701341117085-48d78c131e97|Annie Spratt|anniespratt"
  "07-family-portrait|Ar9j8V6oMzo|photo-1542216515-4e6a586c1ca0|Annie Spratt|anniespratt"
  "08-family-seated|AuOuX46ny1c|photo-1542216516-519a107c644a|Annie Spratt|anniespratt"
  "09-family-group|_0F_03SEF-M|photo-1542216765-7b2793f379a9|Annie Spratt|anniespratt"
  "10-girl-eating|mnOBoI5Bm94|photo-1645968094392-93803370ed67|Chris Curry|chriscurry92"
)

CREDITS="$OUT/CREDITS.md"
{
  echo "# Screenshot media"
  echo
  echo "Photographs from [Unsplash](https://unsplash.com), used under the"
  echo "[Unsplash License](https://unsplash.com/license). Fetched by"
  echo "\`app/e2e/tools/fetch-shot-media.sh\`."
  echo
} > "$CREDITS"

for entry in "${PHOTOS[@]}"; do
  IFS='|' read -r name id slug who user <<< "$entry"
  # 2400px wide: enough detail for the retina captures, small enough to import
  # a dozen of them quickly.
  url="https://images.unsplash.com/$slug?w=2400&q=80&fm=jpg"
  echo "fetching $name ($id)"
  curl -fsSL --retry 3 "$url" -o "$OUT/$name.jpg"
  echo "- \`$name.jpg\` — [$who](https://unsplash.com/@$user), <https://unsplash.com/photos/$id>" >> "$CREDITS"
done

# The music track is synthesized, not fetched: Unsplash has no audio, and the
# waveform in the Time view only needs beats to draw.
case "$(uname -s)/$(uname -m)" in
  Darwin/arm64) TRIPLE=aarch64-apple-darwin ;;
  Darwin/*)     TRIPLE=x86_64-apple-darwin ;;
  *)            TRIPLE=x86_64-unknown-linux-gnu ;;
esac
FFMPEG="../../src-tauri/binaries/ffmpeg-$TRIPLE"
if [ ! -x "$FFMPEG" ]; then
  if command -v ffmpeg >/dev/null 2>&1; then
    FFMPEG=ffmpeg
  else
    echo "error: no sidecar at app/src-tauri/binaries/ffmpeg-$TRIPLE and no ffmpeg on PATH" >&2
    echo "  run scripts/fetch-ffmpeg.sh $TRIPLE, or install ffmpeg" >&2
    exit 1
  fi
fi
# The beeps give the beat detector something to mark; the slow tremolo gives
# the waveform in the Time view a shape rather than a flat bar.
"$FFMPEG" -v error -y -f lavfi -i "sine=frequency=220:beep_factor=4:d=90" \
  -af "tremolo=f=0.12:d=0.85" -c:a libmp3lame "$OUT/music.mp3"

echo "screenshot media written to $(pwd)/$OUT"
