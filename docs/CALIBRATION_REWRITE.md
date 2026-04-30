# Calibration Algorithm Rewrite

## Problem

The current calibration takes 1–2 minutes. Root cause: BNO085 MASR (Motion Adaptive
Sample Rate) throttles `ROTATION_VECTOR` to ~0.12 Hz during stillness. The current
algorithm waits for 25 samples to fill — at 0.12 Hz that is ~125 seconds worst case.

## Design

### Collection window
- Arm command starts a 3-second collection window.
- All RV samples go into `calBuffer` (existing, unchanged role).
- RV samples received while `stab=3 (STABLE)` also go into `stableCalBuffer` (new).
- At 3-second expiry, finalize regardless of sample count.

### Stable window tracking
- `stab=3` → activate stable window (`inStableWindow = true`).
- `stab≥4` → deactivate stable window (`inStableWindow = false`). `stableCalBuffer`
  is NOT cleared — prior stable-window samples are retained across brief motion spikes.
- Flag `CAL_LAST_WINDOW_ONLY`: if defined, clear `stableCalBuffer` on `stab≥4`
  (only the most recent stable window is kept). Off by default.

### Finalization priority
1. `stableCalBuffer.count > 0` → baseline = mean of `stableCalBuffer`.
2. `stableCalBuffer.count == 0 && calBuffer.count > 0` → baseline = mean of `calBuffer`.
3. Both empty → log failure, leave calibration incomplete, app retries.

### Timer
Checked in `loop()` on every iteration before `waitForEvent()` — fires regardless of
whether any IMU or BLE events arrive.

---

## EARS Requirements

| ID | Requirement |
|----|-------------|
| REQ-1 | The firmware shall maintain `calBuffer` — rolling buffer of all RV readings while calibration is in progress, regardless of stability state. |
| REQ-2 | The firmware shall maintain `stableCalBuffer` — buffer of RV readings received only while `stab=3 (STABLE)`, within the 3-second window. |
| REQ-3 | The firmware shall update `lastRoll`, `lastPitch`, `lastYaw` on every RV event. |
| REQ-4 | When a RV event arrives and `armed && !calibrationComplete && !baselineCaptured && !calInProgress`, the firmware shall reset both buffers, set `calInProgress=true`, `inStableWindow=false`, and record `calStartMs=millis()`. |
| REQ-5 | When a RV event arrives and `calInProgress` and `millis()-calStartMs < CAL_WINDOW_MS`, the firmware shall push the sample into `calBuffer`. |
| REQ-6 | When a RV event arrives and `calInProgress` and `inStableWindow` and `millis()-calStartMs < CAL_WINDOW_MS`, the firmware shall also push the sample into `stableCalBuffer`. |
| REQ-7 | When `stab=3` fires and `calInProgress`, the firmware shall set `inStableWindow=true`. |
| REQ-8 | When `stab≥4` fires and `calInProgress`, the firmware shall set `inStableWindow=false`. `stableCalBuffer` is NOT cleared. |
| REQ-9 | When disarmed and `!calibrationComplete`, the firmware shall reset `calBuffer`, `stableCalBuffer`, `calInProgress`, `inStableWindow`. |
| REQ-10 | When app writes `-999,-999,-999` to baseline characteristic, the firmware shall reset `calBuffer`, `stableCalBuffer`, `calInProgress`, `inStableWindow`, `baselineCaptured`, `calibrationComplete`. |
| REQ-11 | When BLE disconnects, the firmware shall reset `calBuffer`, `stableCalBuffer`, `calInProgress`, `inStableWindow`, `baselineCaptured`, `calibrationComplete`. |
| REQ-12 | When a RV event arrives and `!armed && !calibrationComplete`, the firmware shall reset `baselineCaptured`, `calInProgress`, `inStableWindow`. |
| REQ-13 | While `calInProgress && !baselineCaptured`, the firmware shall check on every `loop()` iteration whether `millis()-calStartMs >= CAL_WINDOW_MS`, independent of IMU/BLE events. |
| REQ-14 | While finalizing: if `stableCalBuffer.count > 0`, baseline = mean of `stableCalBuffer`. |
| REQ-15 | While finalizing: if `stableCalBuffer.count==0 && calBuffer.count > 0`, baseline = mean of `calBuffer`. |
| REQ-16 | While finalizing: if both buffers empty, log failure, leave calibration incomplete. |
| REQ-17 | Where `CAL_LAST_WINDOW_ONLY` is defined, the firmware shall clear `stableCalBuffer` on `stab≥4` (amends REQ-8). |
| REQ-18 | (App-side) The app shall not forward gestures to the host while `calibrationComplete` is false. No firmware change. |

---

## Implementation Checklist

All changes are in `wristturn_audrino/wristturn/wristturn.ino` unless noted.

### T1 — New globals (after line 190, after `bool calInProgress = false;`)
- [ ] Add `CalibrationBuffer stableCalBuffer;`
- [ ] Add `bool inStableWindow = false;`
- [ ] Add `unsigned long calStartMs = 0;`
- [ ] Add `static constexpr unsigned long CAL_WINDOW_MS = 3000;`
- [ ] Add `// #define CAL_LAST_WINDOW_ONLY` (commented out = accumulate mode default)

### T2 — Assign lastRoll/lastPitch/lastYaw on every RV event
- [ ] After `mountAdapter.transform(roll, pitch, yaw)` (line 1042), add:
  ```cpp
  lastRoll = roll; lastPitch = pitch; lastYaw = yaw;
  ```
  (globals declared at lines 215–217 but never assigned anywhere)

### T3 — `handleRotationVector` — `!calInProgress` init path (lines 1145–1148)
Current:
```cpp
if (!calInProgress) {
  calBuffer.reset();
  calInProgress = true;
}
```
- [ ] Add `stableCalBuffer.reset();`
- [ ] Add `inStableWindow = false;`
- [ ] Add `calStartMs = millis();`

### T4 — Gate `calBuffer.push` on window (line 1149)
- [ ] Wrap push in `if (millis() - calStartMs < CAL_WINDOW_MS)`

### T5 — Add `stableCalBuffer.push` when in stable window (after line 1149)
- [ ] Add:
  ```cpp
  if (inStableWindow && millis() - calStartMs < CAL_WINDOW_MS)
    stableCalBuffer.push(roll, pitch, yaw);
  ```

### T6 — Remove `calBuffer.isFull()` block (lines 1154–1167)
- [ ] Delete entire block (finalization moves to `loop()` via `finalizeCalibration()`)

### T7 — `handleRotationVector` disarmed path (lines 1211–1213)
Current:
```cpp
if (!calibrationComplete) {
  baselineCaptured = false;
  calInProgress = false;
}
```
- [ ] Add `stableCalBuffer.reset();`
- [ ] Add `inStableWindow = false;`

### T8 — `handleStabilityClassifier` — add calibration gating (after line 1226)
- [ ] Add after the existing `if (stab >= 4) { lastMotionMs = now; }` block:
  ```cpp
  if (calInProgress && !baselineCaptured) {
    if (stab == STABILITY_STABLE) {
      inStableWindow = true;
    } else if (stab >= 4) {
      inStableWindow = false;
#ifdef CAL_LAST_WINDOW_ONLY
      stableCalBuffer.reset();
#endif
    }
  }
  ```

### T9 — Add `finalizeCalibration()` function (before `loop()` at line 1277)
- [ ] Add:
  ```cpp
  void finalizeCalibration() {
    calInProgress = false;
    inStableWindow = false;
    float r, p, y;
    if (stableCalBuffer.count > 0) {
      stableCalBuffer.getAverage(r, p, y);
      LOG_I("[Cal] stable window used: %u samples", stableCalBuffer.count);
    } else if (calBuffer.count > 0) {
      calBuffer.getAverage(r, p, y);
      LOG_I("[Cal] fallback to all samples: %u samples", calBuffer.count);
    } else {
      LOG_E("[Cal] calibration failed — no samples collected. App must retry.");
      return;
    }
    baselineRoll = r;
    basePitch_arm = p;
    baselineYaw = y;
    baselineCaptured = true;
    if (armed && !calibrationComplete) {
      calibrationComplete = true;
    }
    publishBaseline(r, p, y);
    LOG_I("[Cal] baseline: r=%.1f p=%.1f y=%.1f (stable=%u all=%u)",
          r, p, y, stableCalBuffer.count, calBuffer.count);
  }
  ```

### T10 — Timer check in `loop()` before `waitForEvent()` (before line 1434)
- [ ] Add:
  ```cpp
  if (calInProgress && !baselineCaptured) {
    if (millis() - calStartMs >= CAL_WINDOW_MS) {
      finalizeCalibration();
    }
  }
  ```

### T11 — `onArmWrite` disarm path (lines 413–414)
Current resets: `calBuffer`, `calInProgress`
- [ ] Add `stableCalBuffer.reset();`
- [ ] Add `inStableWindow = false;`

### T12 — `onBaselineWrite` -999 path (lines 441–443)
Current resets: `calibrationComplete`, `baselineCaptured`, `calInProgress`, `calBuffer`
- [ ] Add `stableCalBuffer.reset();`
- [ ] Add `inStableWindow = false;`

### T13 — `onDisconnect` (lines 639–640)
Current resets: `calibrationComplete`, `baselineCaptured`, `calInProgress`, `calBuffer`
- [ ] Add `stableCalBuffer.reset();`
- [ ] Add `inStableWindow = false;`

---

## What does NOT change

- `CalibrationBuffer` struct in `StillnessDetector.h` — reused as-is for both buffers.
- `MAX_CAL_SAMPLES` — still controls max size of both buffers (25 slots each).
- `publishBaseline()` — called unchanged from `finalizeCalibration()`.
- BLE protocol — no characteristic changes.
- App side — no changes for the calibration fix itself (REQ-18 is separate work).

---

## Log tags to verify after flashing

```
[Cal] stable window used: N samples   → stableCalBuffer path taken
[Cal] fallback to all samples: N      → degraded fallback path taken
[Cal] calibration failed              → both buffers empty, app must retry
[Cal] baseline: r=X p=Y y=Z          → finalization complete
[Stab] stab=3                         → stable window activated
[Stab] stab=4                         → stable window deactivated
```

Expected happy path timing: arm → user raises arm (~1s motion) → stab=3 fires → stableCalBuffer collecting → 3s expiry → baseline set. Total: ~3–4 seconds.
