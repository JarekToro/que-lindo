#!/usr/bin/env bash
# Generates the placeholder media referenced by test.slideshow.json.
set -euo pipefail
cd "$(dirname "$0")"
mkdir -p media out
for spec in "red:1600x1000:ONE" "royalblue:1000x1500:TWO-portrait" "seagreen:1600x1000:THREE" "goldenrod:1200x1200:FOUR" "mediumpurple:1600x900:FIVE" "chocolate:1400x1000:SIX"; do
  c=${spec%%:*}; rest=${spec#*:}; s=${rest%%:*}; label=${rest#*:}
  ffmpeg -v error -y -f lavfi -i "color=c=$c:s=$s" -frames:v 1 \
    -vf "drawtext=text='$label':fontsize=120:fontcolor=white:x=(w-text_w)/2:y=(h-text_h)/2" \
    "media/img_$label.png"
done
ffmpeg -v error -y -f lavfi -i "testsrc2=s=1280x720:r=30:d=6" -f lavfi -i "sine=frequency=520:d=6" \
  -c:v libx264 -pix_fmt yuv420p -c:a aac -shortest media/clip.mp4
ffmpeg -v error -y -f lavfi -i "sine=frequency=220:beep_factor=4:d=40" -c:a libmp3lame media/music.mp3
ffmpeg -v error -y -f lavfi -i "sine=frequency=330:beep_factor=3:d=30" -c:a libmp3lame media/music2.mp3
echo "test media written to $(pwd)/media"
