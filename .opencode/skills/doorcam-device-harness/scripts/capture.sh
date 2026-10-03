#!/usr/bin/env bash
# DoorCam device capture harness: timestamped screenshots + logcat.
# usage: capture.sh [duration_seconds] [interval_seconds] [outdir]
set -euo pipefail

DUR=${1:-30}
INT=${2:-0.25}
OUT=${3:-/tmp/doorcam-cap}

if ! adb get-state >/dev/null 2>&1; then
  echo "ERROR: no adb device. Run 'adb devices' and connect one." >&2
  exit 1
fi

rm -rf "$OUT"
mkdir -p "$OUT"

adb logcat -c >/dev/null 2>&1 || true
adb logcat -v time -s DoorCam:V ReactNativeJS:V > "$OUT/logcat.txt" 2>/dev/null &
LC_PID=$!

# Capture until the wall-clock budget elapses.
END=$(python3 -c "import time;print(time.time()+$DUR)")
i=0
while python3 -c "import time,sys;sys.exit(0 if time.time()<$END else 1)"; do
  i=$((i+1))
  n=$(printf %03d "$i")
  adb exec-out screencap -p > "$OUT/f$n.png" 2>/dev/null || true
  echo "$(python3 -c 'import time;print(f"{time.time():.3f}")') f$n" >> "$OUT/index.txt"
  sleep "$INT"
done

kill "$LC_PID" 2>/dev/null || true
wait "$LC_PID" 2>/dev/null || true

echo "captured $i frames -> $OUT"
echo "logcat: $OUT/logcat.txt"
grep -E "person confirmed|person lost" "$OUT/logcat.txt" | tail -20 || true
