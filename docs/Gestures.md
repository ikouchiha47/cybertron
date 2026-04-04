# Gesture Recognition — Physics, Maths, and Implementation

## Scope

Single air-drawn letters only. No combos, no words, no sequences.
One letter gesture = one action. The user draws a single letter in the air
with their wrist, the device recognises it and fires the mapped command.

---

## Hardware

**BNO085** (SparkFun Qwiic breakout)

The BNO085 contains an ARM Cortex M0 running onboard sensor fusion.
It fuses accelerometer + gyroscope + magnetometer internally and outputs
clean, drift-corrected reports. This means:

- The rotation vector quaternion is already filtered — no Kalman needed in firmware
- Linear acceleration report already has gravity removed using the orientation estimate
- Yaw drift is anchored by the magnetometer internally
- The `w` component of the quaternion is handled by the BNO085 fusion — you do not
  need to reason about it separately

Reports used for gesture recognition:
| Report | Output | Rate |
|---|---|---|
| `ROTATION_VECTOR` | Quaternion `(w,x,y,z)` | ~100Hz |
| `LINEAR_ACCELERATION` | `(ax, ay, az)` gravity-removed, body frame | ~100Hz |
| `GYROSCOPE` | `(ωx, ωy, ωz)` angular velocity rad/s | ~100Hz |

---

## What You Have at Each Timestep

```
a(t)  = [ax, ay, az]   — linear acceleration (gravity removed), m/s², body frame
ω(t)  = [ωx, ωy, ωz]  — angular velocity, rad/s
m(t)  = [mx, my, mz]   — magnetic field, µT (used internally by BNO085)
q(t)  = [w, x, y, z]   — orientation quaternion, BNO085 fusion output
Δt                      — time since last sample (~10ms at 100Hz)
t                       — epoch counter, increments each sample
```

---

## What You Can Derive

### From acceleration

```
velocity     v(t) = v(t-1) + a(t) · Δt       — integrate once
position     p(t) = p(t-1) + v(t) · Δt       — integrate twice
```

Dead reckoning. Drifts over time — usable for short bursts (~1s) with zero
velocity correction at rest.

### From angular velocity

```
angle        θ(t) = θ(t-1) + ω(t) · Δt       — integrate once
```

How fast and in which rotational direction the wrist is moving at any instant.
Useful for detecting flicks, spins, direction changes within a stroke.

### From orientation quaternion

```
euler angles      roll, pitch, yaw             — already used for basic gestures
rotation matrix   R(t)                         — 3×3 matrix, exact frame orientation
gravity vector    g(t) = R(t) · [0, 0, 1]     — which way is down in world frame
```

#### Quaternion → Rotation Matrix

```
R = | 1-2(y²+z²)   2(xy-wz)    2(xz+wy)  |
    | 2(xy+wz)    1-2(x²+z²)   2(yz-wx)  |
    | 2(xz-wy)    2(yz+wx)    1-2(x²+y²) |
```

### Rotating acceleration into world frame

**This is the key operation for air letter recognition.**

The BNO085 outputs `a_body` — acceleration in the sensor's own frame (moves with
your wrist). Multiplying by R gives acceleration in the fixed world frame:

```
a_world(t) = R(t) · a_body(t)
```

World frame: X always East, Y always North, Z always Up — regardless of wrist
orientation. Integrating world-frame acceleration gives world-frame position.
This is significantly better than integrating body-frame accel because gravity
residuals do not rotate into horizontal axes as the wrist rotates.

### From time series — signal features

```
jerk            j(t) = (a(t) - a(t-1)) / Δt
```
Derivative of acceleration. Spikes sharply at gesture start and end.
Primary signal for **segmentation** — detecting when a letter starts and stops.

```
frequency       FFT(a(t))
```
Dominant frequency of the motion. Circles have a single dominant frequency.
Letters have broadband energy. Useful as a feature for classification.

```
autocorrelation R(τ) = Σ a(t) · a(t+τ)
```
Detects repeating patterns. Periodic gestures show clear peaks at the period.

### Cross products

```
centripetal     ac = ω × (ω × r)            — circular motion component
coriolis        ac = 2ω × v                 — rotation + translation interaction
```

Useful for distinguishing circular letters (O, C) from angular ones (L, Z, V).

---

## The Drift Problem and Why ZVU Solves It

Pure double integration of accelerometer data accumulates error fast:
- Gyro bias → heading error grows linearly with time → position error grows with time³
- Accel noise → position error grows with time^1.5

For a single letter (~0.5–1.5s), this is manageable if you bound each stroke.

**Zero Velocity Update (ZVU):**

When the hand stops between strokes (or before/after drawing), both `|a|` and `|ω|`
drop near zero. At that moment you know velocity is exactly zero. Reset `v = 0`.

```
if |a(t)| < ε_a  AND  |ω(t)| < ε_ω  for duration > T_still:
    v = [0, 0, 0]
    // optionally reset position origin for next stroke
```

This bounds drift to within a single stroke. Each letter starts from a fresh
velocity=0 state. Combined with world-frame integration, single-letter recognition
is feasible with no external anchor.

---

## Why Other Systems Need External References

| System | Sensor | Anchor |
|---|---|---|
| Nintendo Wii | Accel + IR camera | IR sensor bar on TV — absolute screen position |
| Wii MotionPlus | + Gyro | Still needs IR bar for position |
| Google Soli | mmWave radar | Direct spatial measurement, no integration |
| Leap Motion | Stereo IR cameras | Triangulation, no integration |
| Apple Watch Double Tap | Accel + gyro + optical HR | Brief kinematic signature, no position needed |
| **Psytrix** | BNO085 9-DOF | ZVU — bounded per stroke, single letters only |

The single-letter constraint is what makes pure IMU viable. No need to maintain
position coherence across multiple strokes or words.

---

## Recognition Approach

Do **not** reconstruct XY position and compare shapes visually.
Instead, treat it as a **time-series classification problem** on raw sensor signals.

**Input feature vector per timestep:**
```
[ax_world, ay_world, az_world, ωx, ωy, ωz]   — 6 channels
```

**Segmentation** (when does the letter start/end):
- Jerk threshold: `|j(t)| > J_min` → gesture started
- Still detection: `|a| < ε` AND `|ω| < ε` for >200ms → gesture ended
- Cap maximum gesture window at ~2s

**Classification options:**
1. **DTW (Dynamic Time Warping)** — template matching, no training, record one
   example per letter and compare. Works for 5–10 letters. Pure JS, no model.
2. **1D CNN** — small model (~50–200KB), trained offline in Python/TF, deployed
   via `react-native-fast-tflite`. Scales to full alphabet.

Start with DTW for proof of concept. Graduate to TFLite when the letter set grows.

---

## Visualisation (HTML Canvas)

For initial development — stream raw 6-axis data from the BNO085 via BLE to a
browser page. Plot waveforms per channel in real time. Draw a letter, see what
the signal looks like. This is how you build intuition before writing a classifier.

Do **not** plot reconstructed XY position — it will look like noise.
Plot the raw `[ax_w, ay_w, az_w, ωx, ωy, ωz]` channels as time-series lines.
Each letter will have a visually distinctive waveform signature.

BLE characteristic for raw stream: `19B10002-E8F2-537E-4F6C-D104768A1214`
Format: `ax,ay,az,wx,wy,wz` as comma-separated floats, notified at ~20Hz.
