---
name: doorcam-device-harness
description: >-
  Live-device test harness for the DoorCam Android app. Captures timestamped
  screenshots + logcat from a connected device via adb, then detects/tracks
  bounding boxes and correlates them with the native detection engine's
  confirm/lost events. Use when asked to observe person detection, bounding-box
  tracking, box lag/staleness, detection latency, or choppy rendering on the
  real device; when someone says "watch the camera", "take continuous shots",
  "is the box tracking", "when do people get detected", or to verify a
  detection/overlay change end-to-end without the user supplying screenshots.
---

# DoorCam live-device harness

Drive the real Android device with `adb` and analyze detection behaviour
without asking the user for screenshots. Everything runs from the repo root.

## When to use
- Verify person-detection / bounding-box changes on the device end-to-end.
- Diagnose "the box is stale / lags / doesn't track / appears after people left".
- Measure detection latency, source fps, inference cadence.
- Watch a camera live and report what actually happened over a time window.

## Prerequisites
- A connected device: `adb devices` must list it (USB or `adb connect <ip>`),
  with USB debugging enabled.
- `python3` with `PIL` (Pillow) for `analyze.py`. Check: `python3 -c "import PIL"`.
- The DoorCam release/dev build installed and running.

## Capture
```sh
bash .opencode/skills/doorcam-device-harness/scripts/capture.sh [duration_s] [interval_s] [outdir]
# defaults: 30s, 0.25s, /tmp/doorcam-cap
```
It clears logcat, starts `adb logcat -v time -s DoorCam:V ReactNativeJS:V` to
`<outdir>/logcat.txt`, grabs screenshots (`<outdir>/fNNN.png`) until the
duration elapses, then stops logcat and prints the count. Frame times come from
file mtimes; event times come from logcat.

## Analyze
```sh
python3 .opencode/skills/doorcam-device-harness/scripts/analyze.py /tmp/doorcam-cap
```
For every frame it reports whether a bounding box is present, its pixel
center/size, and the box color (teal = score >= threshold, orange = candidate),
then prints a summary: box first/last times, total lifetime, static-vs-moving
(center travel), gaps, and the engine's `person confirmed`/`person lost`
timestamps for correlation.

## How to read the result
- Box **center does not move** across many frames while the video advances →
  the overlay is frozen/stale (async overlay redrawing last detection).
- Box **lifetime** far shorter than the `person confirmed → person lost` window →
  JS box state desynced from the engine (or boxes cleared early).
- Box present over an area with **no person** → false positive or stale box.
- `person lost` much later than the box vanished (or never arrives while the
  scene is still) → the motion gate starved the loss/reset path.
- Count gaps between consecutive box frames → detection cadence.

## Related device commands
```sh
adb logcat -c && adb logcat -v time -s DoorCam:V ReactNativeJS:V   # live logs
adb exec-out screencap -p > shot.png                               # one frame
adb pull /sdcard/Android/data/com.doorcam.app/files/ ./captured/   # event videos
adb shell am force-stop com.doorcam.app
cd android && ./gradlew assembleRelease && cd .. && \
  adb install -r android/app/build/outputs/apk/release/app-release.apk && \
  adb shell am start -n com.doorcam.app/.MainActivity
```

## Notes
- The app's Stats button exposes live per-camera metrics (src/draw fps,
  inference ms, detection latency) — a screenshot of that is a quick sanity check.
- One ESP32-CAM serves a single client; don't hold a host `curl /stream` open
  while the app is streaming, or you'll wedge the camera.
- `analyze.py` scans the lower 55% of the screen for box colors by default
  (grid layout); adjust the region constants if the layout changes.
