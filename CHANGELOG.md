# Changelog

## [Current] — 2026-04-05

### Fixed: white screen / stream dropping

**Problem reported:** After running for a while the camera stream would go white
and stop rendering, while inference kept running in the background. Restarting
the app temporarily fixed it but it would recur.

**Root cause:** Two simultaneous HTTP connections to the ESP32-CAM — one from
the JS layer opening the MJPEG stream for display, and a second polling
`/capture` repeatedly for inference frames. The OV3660 sensor can only serve
one client at a time. Under dual-client load it sent garbage data that rendered
as white frames, then the display connection died entirely.

**Fix — Kotlin native bridge (`MjpegStreamView`):**

A single OkHttp connection opens the MJPEG stream. Inside that connection two
things happen simultaneously on one background thread:

- Each decoded JPEG frame is drawn directly to a `TextureView` for smooth
  display (no JS involvement, renders via GPU)
- Once per second a copy of the frame bytes is emitted to JS via
  `DeviceEventEmitter` for inference

Single connection → zero contention → ESP32 stays stable.

**Why not JS:** React Native's JS thread cannot drive smooth video — every
frame would cross the native bridge adding latency and jank. Native `TextureView`
bypasses JS entirely for display.

**Why `TextureView` not `SurfaceView`:** `SurfaceView` punches a transparent
hole in the window compositor. The app theme colour (dark navy) bled through
the edges as a purple flash on every frame transition. `TextureView` composites
normally like any other view.

**Related:** Purple flashes also occurred during ESP32 sensor AWB/night-mode
recalibration. The OV3660 sends malformed frames (red+blue channels >> green)
during the transition. These are discarded in `MjpegStreamView.isBadFrame()`
which samples the centre pixels and drops frames where the green channel is
much weaker than red+blue combined.

---

### Added: hardware gamma toggle (G button)

Night-mode detection was poor because the IR image is too dark for the model.
A **G** button in the header hits `http://{ip}/control?var=raw_gma&val=1` to
enable hardware gamma on the ESP32 camera directly. Tap again to disable.

When gamma is on the detection threshold is also softened (0.45 → ~0.29)
because IR images score lower even after brightening.

---

### Changed: inference model experimenting

Tried YOLOv8n TFLite (exported via ONNX → onnx2tf) for better night detection.
Output tensor is `[1, 84, 2100]` — 4 box coords + 80 class scores × 2100
anchor positions. Person score at row index 4 (`raw[4 * 2100 + i]`).

Result: SSD MobileNet v1 performs better in practice for this use case.
YOLOv8n hook kept in `src/hooks/usePersonDetectionYolo.ts` for reference.

---

### Changed: inference interval

Polling interval reduced from 2s to 1s (`DETECTION_INTERVAL_MS = 1000`).

---

### Changed: release build HTTP

Added `android:usesCleartextTraffic="true"` to `AndroidManifest.xml`.
Release builds block plain HTTP by default — this was silently killing the
stream on non-debug APKs.

---

## [Initial]

- ESP32-CAM MJPEG stream displayed via WebView
- SSD MobileNet v1 inference on `/capture` frames
- Proximity detection via bounding box height
- Local push notification on person detected
- WiFiManager-based ESP32 setup hotspot
