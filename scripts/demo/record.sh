#!/usr/bin/env bash
# Records the README video (macOS): starts the demo (demo.sh), clicks through
# it, records the window and writes demo.mp4 to a temporary folder. Upload it
# by dragging it into README.md while editing it on github.com (videos aren't
# kept in the repo).
#
#   scripts/demo/record.sh
#
# Needs ffmpeg and swiftc (Xcode command line tools), and the Screen Recording
# and Accessibility permissions for your terminal. Don't touch the mouse or
# keyboard while it runs (about a minute). The positions below are for a
# 1680x1000 window with spaceherd's default layout; if the layout changes,
# check them against a screenshot.

set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
DEMO_DIR="${DEMO_DIR:-$HOME/spaceherd-demo}"
OUT="$(mktemp -d)"

# Places in the window, in points from its top-left corner.
WEATHER_API="69 75"        # sidebar: weather-api
PIXEL_GARDEN="74 108"      # sidebar: pixel-garden
FILE_LINK="610 210"        # "src/forecast.ts:17" in the agent's last line
SRC_FOLDER="798 135"       # src in VS Code's Explorer
CACHE_TS="822 158"         # cache.ts in VS Code's Explorer, once src is open
SERVER_TS="822 201"        # server.ts, likewise
PROMPT="420 336"           # the terminal, where the dropped path goes
REST="900 600"             # where the pointer waits

swiftc -O "$HERE/drive.swift" -o "$OUT/drive"
drive() { "$OUT/drive" "$PID" "$@"; }

"$HERE/demo.sh" reset >/dev/null
sleep 2
"$HERE/demo.sh" start
PID="$(cat "$DEMO_DIR/spaceherd.pid")"
trap '"$HERE/demo.sh" reset >/dev/null' EXIT
sleep 6

osascript -e "tell application \"System Events\" to tell (first process whose unix id is $PID)
  set frontmost to true
  set position of window 1 to {100, 100}
  set size of window 1 to {1680, 1000}
end tell"
sleep 1

# Off camera: open VS Code once in pixel-garden and close it again (the first
# open of a new VS Code profile flashes the light theme), then leave it open
# in weather-api with server.ts open, so the video's first frame shows code.
drive click $PIXEL_GARDEN wait 1.5 toggle wait 8 toggle wait 2 \
  click $WEATHER_API wait 1.5 toggle wait 8 click $SRC_FOLDER wait 1 click $SERVER_TS wait 2 \
  move $REST wait 1

echo "recording"
screencapture -v -V 22 -k -R"$(drive bounds)" "$OUT/take.mov" &
REC=$!
sleep 2
drive wait 1.5 click $PIXEL_GARDEN wait 1.5 toggle wait 3 click $WEATHER_API wait 2 \
  cmdclick $FILE_LINK wait 2.5 drag $CACHE_TS $PROMPT wait 2.5
wait "$REC"

# Cut the idle start and end and play 1.1x.
ffmpeg -v error -y -ss 1.5 -to 18.8 -i "$OUT/take.mov" \
  -vf "setpts=PTS/1.1,fps=30,scale=1680:-2:flags=lanczos" -an \
  -c:v libx264 -preset slow -crf 22 -pix_fmt yuv420p -movflags +faststart "$OUT/demo.mp4"
echo "wrote $OUT/demo.mp4 ($(du -h "$OUT/demo.mp4" | cut -f1))"
open -R "$OUT/demo.mp4"
