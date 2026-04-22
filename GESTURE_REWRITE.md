# Gesture Detection Rewrite Plan

## Context

Current firmware detects gestures by comparing Euler angle deltas to a stored baseline.
This causes: axis cross-contamination, baseline drift sensitivity, missed gestures, magic
inhibit timers. All production systems (Joy-Con, Steam Deck, DualSense, Android HAL) use
angular velocity (gyro rate) instead of position.

This document is the implementation plan. Each phase is independently testable and
independently assignable to an agent or developer.

---

## Architecture Overview

```
BNO085
  │
  ├─ ROTATION_VECTOR → MountingAdapter (axis remap + coupling correction)
  │
  └─ GYROSCOPE_CALIBRATED ──► GestureDetector
                                    │
                              ┌─────┴──────┐
                         AxisDetector  AxisDetector  AxisDetector
                           (roll)        (pitch)       (yaw)
                                    │
                              GestureArbitrator
                              (dominant-axis ratio test)
                                    │
                              gesture string → BLE notify
                                    │
                              [App: ComboEngine]
                              (sequences → commands)
```

**Split of responsibility:**
- Firmware: single atomic gesture per BLE notify. No sequences.
- App (ComboEngine.ts): sequences of gestures → combo strings → commands.

---

## Phases

---

### Phase 1 — AxisDetector: Ring Buffer + Gyro Integral

**Goal:** Replace angle-delta threshold with windowed gyro integration.
Immune to baseline drift by design.

**Files to create:**
- `wristturn_audrino/wristturn/gesture/AxisDetector.h`
- `wristturn_audrino/wristturn/gesture/AxisDetector.cpp` (or header-only)

**Algorithm:**
1. Maintain a 32-sample circular ring buffer of gyro values for this axis.
2. On each gyro sample, compute jerk = `(gyro_current - gyro_prev) / dt`.
3. If `|jerk| > JERK_ONSET_THRESHOLD (8.0 rad/s²)`, set `accumulating = true`.
4. While `accumulating`, sum `gyro[i] * dt` across the ring buffer window.
5. If `|window_sum| > INTEGRAL_THRESHOLD (0.25 rad ≈ 14°)`, emit candidate.
6. ZUPT: if `|gyro| < 0.03 rad/s` for 20 consecutive samples, reset baseline
   (replaces stability classifier rebase).

**Constants (all tunable):**
```cpp
JERK_ONSET_THRESHOLD  = 8.0f   // rad/s²
INTEGRAL_THRESHOLD    = 0.25f  // rad (~14°)
ZUPT_GYRO_THRESHOLD   = 0.03f  // rad/s
ZUPT_MIN_SAMPLES      = 20     // @ ~50Hz = 400ms of stillness
RING_BUFFER_SIZE      = 32     // samples
```

**Interface:**
```cpp
struct AxisCandidate {
    bool    valid;
    float   integral;   // signed — positive or negative determines direction
    float   peakRate;   // peak gyro rate during window
};

class AxisDetector {
public:
    AxisDetector();
    void        reset();
    AxisCandidate update(float gyroVal, float dt);  // call on every gyro sample
    bool        isQuiet() const;                    // true during ZUPT window
};
```

**Memory:** 32 × 1 float × 4 bytes = 128 bytes per axis, 384 bytes for three.

**Testability:**
- Header-only or pure C++ with no Arduino dependencies.
- Test harness: replay gyro columns from session JSONL on desktop (Python or C++ main).
- Assert: clean pronation sweep → valid candidate; slow drift → no candidate.

**Checklist:**
- [ ] `AxisDetector.h` — ring buffer, jerk gate, window integral, ZUPT
- [ ] Unit test harness (`tests/test_axis_detector.cpp` or Python replay script)
- [ ] Replay session JSONL and assert no false positives on yaw during roll moves
- [ ] Tune `INTEGRAL_THRESHOLD` and `JERK_ONSET_THRESHOLD` from session data
- [ ] Confirm 384 bytes fits in nRF52840 stack (it does — 256KB RAM)

**Dependencies:** None. Runs standalone on desktop.

---

### Phase 2 — GestureArbitrator: Dominant-Axis Ratio Test

**Goal:** Given candidates from all three AxisDetectors, pick at most one winner.
Replaces `CROSS_INHIBIT_MS` hack entirely.

**Files to create:**
- `wristturn_audrino/wristturn/gesture/GestureArbitrator.h`

**Algorithm:**
1. Collect candidates from roll, pitch, yaw AxisDetectors.
2. Find the axis with highest `|integral|`.
3. Compute ratio = `|dominant_integral| / (|other1_integral| + |other2_integral| + 0.001f)`.
4. If `ratio < 1.5`, motion is ambiguous — emit nothing.
5. If `ratio >= 1.5`, emit the dominant axis gesture (direction = sign of integral).

**Interface:**
```cpp
enum class Axis { ROLL, PITCH, YAW };

struct GestureEvent {
    bool    valid;
    Axis    axis;
    int8_t  direction;   // +1 or -1
};

class GestureArbitrator {
public:
    GestureEvent arbitrate(
        AxisCandidate roll,
        AxisCandidate pitch,
        AxisCandidate yaw
    );
};
```

**Axis → gesture name mapping** (in firmware, not arbitrator):
```
roll  +1 → "turn_right"    roll  -1 → "turn_left"
pitch +1 → "pitch_up"      pitch -1 → "pitch_down"
yaw   +1 → "yaw_right"     yaw   -1 → "yaw_left"
```

**Checklist:**
- [ ] `GestureArbitrator.h` — ratio test, dominant-axis selection
- [ ] Unit tests: inject synthetic candidates with known ratios, assert correct winner
- [ ] Test: `roll=0.30, pitch=0.08, yaw=0.05` → roll wins (ratio = 0.30/0.13 = 2.3 ✓)
- [ ] Test: `roll=0.20, pitch=0.15, yaw=0.05` → ambiguous (ratio = 0.20/0.20 = 1.0 ✗)
- [ ] Test: all zero → no event

**Dependencies:** Phase 1 (`AxisCandidate` type).

---

### Phase 3 — 4-State FSM per Axis

**Goal:** Replace `bool armed` with a proper motion primitive state machine.
Handles re-arm, combos, and held-position rejection cleanly without timers.

**States:**
```
IDLE ──(jerk onset)──► ONSET ──(integral crosses threshold)──► PEAK
                                                                  │
                                                              (gyro drops)
                                                                  │
                                                               DECAY ──(gyro near zero)──► IDLE + fire
```

**State transition rules:**
- `IDLE → ONSET`: `|jerk| > JERK_ONSET_THRESHOLD`
- `ONSET → PEAK`: `|window_integral| > INTEGRAL_THRESHOLD` within `ONSET_TIMEOUT_MS (300ms)`
- `ONSET → IDLE`: timeout expired without reaching PEAK (jitter/noise rejected)
- `PEAK → DECAY`: `|gyro| < DECAY_THRESHOLD (0.15 rad/s)`
- `DECAY → IDLE`: `|gyro| < ZUPT_GYRO_THRESHOLD (0.03 rad/s)` — gesture fires here
- `PEAK → IDLE`: `PEAK_TIMEOUT_MS (200ms)` exceeded without DECAY (held position rejected)

**Why fire on DECAY→IDLE (not PEAK):**
Firing on PEAK would fire before the user finishes the motion and returns.
Firing on DECAY completion means the motion is confirmed complete. For combos,
the axis is back in IDLE ~100ms after the gesture, ready for a second gesture.

**Combo timing implication:**
- DECAY typically completes in 80–150ms after PEAK.
- ComboEngine window should be **250ms** (up from 150ms) to accommodate.
- This is a one-line change in `ComboEngine.ts`: `const COMBO_TIMEOUT_MS = 250`.

**Checklist:**
- [ ] Extend `AxisDetector` with 4-state FSM (replaces simple accumulating bool)
- [ ] Add `ONSET_TIMEOUT_MS`, `PEAK_TIMEOUT_MS`, `DECAY_THRESHOLD` constants
- [ ] Replay session JSONL through FSM, assert gestures fire on DECAY not PEAK
- [ ] Test held-position rejection: gyro stays elevated → PEAK timeout → no fire
- [ ] Test combo scenario: two quick rolls → two IDLE→ONSET→PEAK→DECAY cycles
- [ ] Update `ComboEngine.ts`: `COMBO_TIMEOUT_MS = 250`

**Dependencies:** Phase 1, Phase 2.

---

### Phase 4 — Coupling Correction Matrix (Calibration)

**Goal:** Account for physical axis coupling in your specific wrist+chip placement.
Extends `MountingAdapter` from int8 axis-swap to float 3×3 correction.

**Files to modify:**
- `wristturn_audrino/wristturn/mounting_adapter.h`

**Calibration procedure:**
1. Flash firmware with `rawMode = true`.
2. Record 20 clean pronation sweeps (turn_right only, no other motion).
3. Compute average `gyro_pitch / gyro_roll` and `gyro_yaw / gyro_roll` ratios.
4. These ratios are the off-diagonal entries of the correction matrix.

**Extended MountingAdapter:**
```cpp
struct CorrectionMatrix {
    float m[3][3];   // applied: [roll_out, pitch_out, yaw_out] = M × [roll_in, pitch_in, yaw_in]
};

// Identity (no correction):
// { 1,0,0, 0,1,0, 0,0,1 }

// Example after calibration (10% pitch bleed from roll, 5% yaw bleed):
// { 1.0, -0.10, -0.05,
//  -0.10,  1.0,   0.0,
//  -0.05,  0.0,   1.0 }
```

**Checklist:**
- [ ] Modify `MountingAdapter` to accept optional `CorrectionMatrix`
- [ ] Record calibration session (rawMode, 20 pronation sweeps)
- [ ] Compute correction coefficients from JSONL
- [ ] Hardcode into `wristturn.ino` instantiation
- [ ] Verify: replay calibration session, confirm off-axis bleed reduced

**Dependencies:** Phase 1 complete (need gyro ring buffer data to calibrate from).

---

### Phase 5 — Wire Into Firmware (Integration)

**Goal:** Remove all old gesture detection code from `wristturn.ino`, replace with
`GestureDetector` facade.

**Files to modify:**
- `wristturn_audrino/wristturn/wristturn.ino`

**What gets deleted:**
- `rollArmed`, `pitchArmed`, `yawArmed` bools
- `rollDisarmedAt`, `pitchDisarmedAt`, `yawDisarmedAt`
- `FORCE_REARM_MS`, `CROSS_INHIBIT_MS`
- `baseRoll`, `basePitch`, `baseYaw`, `baseSet`
- `deadzoneDegs` (replaced by ZUPT)
- Stability classifier rebase block
- The entire `if (rollArmed && fabsf(dRoll) > turnThreshold)` block

**What gets added:**
```cpp
#include "gesture/GestureDetector.h"
GestureDetector gestureDetector;

// In loop(), on GYROSCOPE_CALIBRATED event:
float gx = imu.getGyroX();
float gy = imu.getGyroY();
float gz = imu.getGyroZ();
GestureEvent evt = gestureDetector.update(gx, gy, gz, dt);
if (evt.valid) {
    // emit BLE gesture string same as before
}
```

**What stays:**
- Shake detector (uses linear accelerometer, separate pipeline)
- Tap detector (BNO085 hardware, separate pipeline)
- Sleep/wake logic (SH2_SIGNIFICANT_MOTION)
- Battery, BLE, settings service — untouched

**Checklist:**
- [ ] Create `GestureDetector.h` facade (owns 3 AxisDetectors + 1 Arbitrator)
- [ ] Wire `dt` calculation (track `lastGyroMicros`, divide by 1e6)
- [ ] Remove all old gesture state variables from `wristturn.ino`
- [ ] Smoke test: flash, confirm gestures appear in serial monitor
- [ ] Session recording: record JSONL, verify no yaw_left spam during roll moves
- [ ] Tune thresholds via BLE settings service (expose `INTEGRAL_THRESHOLD` on a new char)

**Dependencies:** Phases 1–3 complete.

---

## Parallel Execution Map

Phases 1 and 2 have no dependencies on each other beyond the `AxisCandidate` type.
They can be written in parallel by two agents once the interface is agreed.

```
Phase 1 (AxisDetector)  ──┐
                           ├──► Phase 3 (FSM) ──► Phase 5 (Integration)
Phase 2 (Arbitrator)   ──┘

Phase 4 (Calibration)  ── can start after Phase 1 hardware test, independent otherwise
ComboEngine.ts update  ── one line, can be done anytime before Phase 5 ships
```

---

## Files Summary

| File | Action | Phase |
|---|---|---|
| `gesture/AxisDetector.h` | Create | 1 |
| `gesture/GestureArbitrator.h` | Create | 2 |
| `gesture/GestureDetector.h` | Create | 5 |
| `mounting_adapter.h` | Extend with 3×3 matrix | 4 |
| `wristturn.ino` | Remove old gesture code, wire new | 5 |
| `wristturn-app/src/gestures/ComboEngine.ts` | `COMBO_TIMEOUT_MS = 250` | 3 |
| `tests/test_axis_detector.cpp` | Create | 1 |
| `tests/test_arbitrator.cpp` | Create | 2 |

---

## Constants Reference

| Constant | Value | Phase | Tunable via BLE |
|---|---|---|---|
| `JERK_ONSET_THRESHOLD` | 8.0 rad/s² | 1 | maybe |
| `INTEGRAL_THRESHOLD` | 0.25 rad | 1 | yes (replaces turnThreshold) |
| `ZUPT_GYRO_THRESHOLD` | 0.03 rad/s | 1 | no |
| `ZUPT_MIN_SAMPLES` | 20 | 1 | no |
| `RING_BUFFER_SIZE` | 32 | 1 | no |
| `DOMINANT_RATIO` | 1.5 | 2 | no |
| `ONSET_TIMEOUT_MS` | 300 | 3 | no |
| `PEAK_TIMEOUT_MS` | 200 | 3 | no |
| `DECAY_THRESHOLD` | 0.15 rad/s | 3 | no |
| `COMBO_TIMEOUT_MS` | 250 (up from 150) | 3 | n/a (app side) |

---

## What Gets Removed from Current Firmware

These are the things the new architecture replaces. Do not port them forward:

- `rollArmed / pitchArmed / yawArmed` — replaced by FSM states
- `FORCE_REARM_MS` — replaced by DECAY→IDLE transition
- `CROSS_INHIBIT_MS` — replaced by ratio test
- `deadzoneDegs` — replaced by ZUPT
- `baseRoll / basePitch / baseYaw` — replaced by ZUPT reset
- `STABILITY_REBASE_HOLDOFF_MS` — replaced by ZUPT
- Stability classifier gesture rebase block — replaced by ZUPT
- `lastGestureMs` debounce — FSM can't re-fire until DECAY completes, no timer needed
