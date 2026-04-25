
# Changelog

---

## v3 — Back to BNO085, power optimizations, LSM6DS3 archived

**Decision:** Reverted active firmware to BNO085. LSM6DS3 firmware archived as
`wristturn_nrf52840.ino.bkp`. XIAO nRF52840 Sense will be replaced with Raytac MDBT50Q
module + BNO085 bare chip on a custom PCB.

**What triggered the revert:**
After implementing Madgwick, then EKF (6DOF), yaw gestures fired continuously every ~1.3s
regardless of filter quality. See detailed analysis below. BNO085 with onboard 9DOF fusion
resolved all issues immediately on first test.

**Power optimizations added to firmware:**
- `PIN_PDM_PWR LOW` at boot — disables XIAO Sense onboard PDM microphone, saves ~1.5mA
- `Bluefruit.setTxPower(-20)` — reduces BLE TX from 0dBm default to -20dBm, adequate for
  wrist-to-laptop (<2m), saves ~5mA during advertising/connection events
- LSM6DS3 enters power-down automatically if not initialized (~6µA quiescent)

**Case implications:**
- Custom PCB path: Raytac MDBT50Q (smaller than XIAO) + BNO085 bare chip
- Target case height: 11–12mm (WHOOP territory) vs current 16mm
- XIAO Sense board no longer needed; saves ~3mm height from USB-C port thickness

**BOM change:**
```
XIAO nRF52840 Sense:  ₹1100  OUT
Raytac MDBT50Q:        ₹450   IN
BNO085 bare chip:      ₹400   IN  (was breakout ₹900)
Net saving vs v1:      ~₹250/unit, smaller/flatter form factor
```

---

## Why 6-DOF IMU fusion fails for yaw — technical evidence

### The fundamental problem: yaw is unobservable from accelerometer

A 6-DOF IMU has a 3-axis gyroscope and 3-axis accelerometer. No magnetometer.

**What the accelerometer actually measures:**
At rest, the accelerometer measures the gravity vector rotated into the sensor's body frame.
When you rotate around the vertical axis (yaw), the gravity vector — pointing straight down —
does not change direction relative to any horizontal rotation. Therefore the accelerometer
output is **identical for all yaw angles**.

Mathematically: the predicted accelerometer measurement in the EKF is:
```
h(q) = [ 2(q1·q3 − q0·q2) ]
        [ 2(q0·q1 + q2·q3) ]
        [ 1 − 2(q1² + q2²) ]
```
The Jacobian H = ∂h/∂q (3×4). Its last row `[0, −4q1, −4q2, 0]` has zero in the q0 and q3
columns. The Kalman gain K = P·Hᵀ·(H·P·Hᵀ + R)⁻¹. When H has zero sensitivity to the
yaw-driving quaternion components, K's contribution to yaw correction is zero — the update
step cannot move the yaw estimate regardless of what the accelerometer measures.

**Result:** Only the gyroscope integration updates yaw. Gyro has a zero-rate offset of
±10°/s on LSM6DS3. After 10 seconds that is ±100° of accumulated error. After 30 seconds the
baseline is meaningless. Our 15° gesture threshold is crossed every ~1.5s on a stationary wrist.

**Evidence from serial log (LSM6DS3 + EKF, wrist held still):**
```
[2052-11-10 00:00:09.450] [Gesture] yaw_left
[2052-11-10 00:00:11.549] [Gesture] yaw_left   ← 2.1s gap = debounce + force-rebase cycle
[2052-11-10 00:00:13.650] [Gesture] yaw_left   ← 2.1s
[2052-11-10 00:00:15.690] [Gesture] yaw_left   ← 2.0s
[2052-11-10 00:00:17.790] [Gesture] yaw_left   ← 2.1s
```
The 2s periodicity exactly matches the force-rebase guard (`lastGestureMs > 2000`). The
force-rebase re-arms yaw, but gyro drift immediately re-crosses the 15° threshold, firing
again. Accelerometer correction does nothing because yaw is unobservable. This happens with
Madgwick (BETA=0.4), EKF (Q=1e-5, R=1e-2), and any other 6-DOF filter — they are all
equivalent in their inability to correct yaw.

**Why the same code works fine for roll and pitch:**
Roll and pitch ARE observable. Roll = rotation around the long axis of the forearm — tilting
the wrist changes which way gravity points in the X/Y body axes. The accelerometer sees this
change. Pitch is identical logic. Both axes get real correction from accel; gyro drift is
suppressed. Roll and pitch gestures were reliable throughout all firmware iterations.

### What a magnetometer would fix

A magnetometer measures Earth's magnetic field vector. In a horizontal plane, this points
roughly North. When you rotate around the vertical axis (yaw), the horizontal component of
the mag vector rotates with you — giving a direct yaw reference.

The 9-DOF Madgwick/Mahony filter adds a second objective function term for the magnetic
reference direction. The gradient descent correction now has a non-zero yaw component.
Yaw drift is bounded the same way roll/pitch drift is bounded by the accel.

**If LSM6DS3 had an onboard magnetometer (e.g. LSM9DS1 = LSM6DS3 + LIS3MDL on same die):**
```cpp
// 9-DOF Madgwick — mag term adds yaw observability
s0 += (existing accel terms) + 2*bx*(0.5f - q2q2 - q3q3) + ... // mag correction
s1 += ...
s2 += ...
s3 += ...  // now non-zero contribution to yaw quaternion components
```
Yaw would converge and hold stable. Gestures like `yaw_left`/`yaw_right` would work.

**Why BNO085 works and LSM6DS3 doesn't:**
BNO085 is a 9-DOF sensor (accelerometer + gyroscope + magnetometer) with a dedicated
ARM Cortex-M0+ running Bosch's SH-2 sensor fusion firmware. It runs the full Madgwick
9-DOF algorithm at 400Hz internally, outputs a stable fused quaternion. Yaw drift is
corrected by the magnetometer reference in real time, and additionally the BNO085 has
temperature-compensated gyro bias estimation that runs 24/7. The host MCU receives
pre-fused orientation with all three axes stable — no filter code needed in the Arduino sketch.

**Summary table:**

| Sensor | Axes | Yaw observable | Typical yaw drift | Gesture reliability |
|--------|------|---------------|-------------------|---------------------|
| LSM6DS3 (6DOF) | accel + gyro | No | ±100°/10s | Roll/pitch only |
| LSM9DS1 (9DOF) | + magnetometer | Yes (indoors: variable) | <5°/min | All axes (if low mag interference) |
| BNO085 (9DOF fused) | + mag + fusion CPU | Yes | <2°/min compensated | All axes, reliable |

---

## v2 — LSM6DS3 onboard IMU (nRF52840 Sense only, no external sensor)

**Motivation:** Remove the BNO085 breakout board entirely. The XIAO nRF52840 Sense has a
LSM6DS3TR-C 6DOF IMU soldered onboard. Using it eliminates one board from the sandwich stack,
reduces BOM cost by ~₹800–1000, and removes 4 jumper wires.

**What changed in firmware:**
- Replaced SparkFun BNO08x library with Seeed Arduino LSM6DS3
- Replaced BNO085 SHTP rotation vector with inline Madgwick 6DOF filter (BETA=0.4)
- Added 100-sample gyro bias calibration at startup (keep still for ~2s after power-on)
- Added WARMUP state (100 samples) — Madgwick starts at identity quaternion (1,0,0,0);
  baseline must not be set until filter converges to actual orientation
- Rewrote state machine into typed structs (SensorState, TimingState, Settings) for
  clarity and ARM cache line alignment
- Fixed rebase deadlock: removed allArmedAgain condition; re-arm all axes on rebase
- Added smoothGyroMag (IIR low-pass) so Madgwick correction noise doesn't prevent
  STILL state from being entered
- Added accel-based runtime gyro bias correction: when accel magnitude is stable
  (physical stillness, immune to gyro bias), slowly subtract residual gyro reading
  from bias estimate (BIAS_ALPHA=0.003). Converges 14°/s residual to <2°/s in ~30s.

**Why this was hard:**
The BNO085 has a dedicated ARM Cortex-M0+ running Bosch SH-2 firmware that continuously
tracks and removes gyro bias across temperature and time. The LSM6DS3 is a raw sensor —
zero-rate offset spec is ±10°/s. Startup calibration alone is insufficient. The runtime
accel-based correction partially replicates what BNO085 does in hardware.

**Tradeoffs vs BNO085:**
- Yaw takes ~30s to fully converge after power-on (BNO085: immediate)
- After large physical movement, brief false gesture burst before rebase fires
- No tap detection (LSM6DS3 has tap interrupt register, not yet wired up)
- Roll/pitch are equally stable on both chips

**Cost delta:**
```
BNO085 breakout:  ₹800–1000  removed
Jumper wires:     ₹20        removed
Net saving:       ~₹820–1020
```

**Verdict:** Viable for gesture control and training data collection after ~30s warmup.
Not recommended if yaw accuracy matters from cold start. BNO085 remains the better
choice for production if budget allows.

---

## Where magnetometers are actually used (and why not here)

A magnetometer measures Earth's magnetic field vector — it gives you absolute compass
heading (which way is North) without any drift over time.

**Real products that use magnetometers:**

- **Phone compass** — Maps app needs to know which direction you're facing. The phone
  is outdoors or near a window. Mag is calibrated by the figure-8 wave gesture you do
  when it loses calibration.

- **Drones / aircraft** — Need to know absolute heading to hold a GPS waypoint course.
  Flown outdoors, far from interference.

- **Ship/vehicle navigation** — Mounted away from the engine, compensated for the
  metal hull.

- **VR headsets (some)** — Oculus DK1 used mag for yaw. They removed it in DK2 because
  indoor interference made it unreliable. Now they use camera-based outside-in tracking.

- **SlimeVR full-body tracking** — Ships BNO085 with magnetometer DISABLED by default,
  explicitly because home environments have too much interference.

**Why not for WristTurn:**
- Wrist is near a metal table, desk, laptop, cables, wiring in walls
- Every time the wrist moves near a different object, mag heading changes
- Result: worse yaw than the drifting gyro you already have
- The rebase approach (detect stillness → reset baseline) is the correct solution
  for a discrete gesture device. Absolute heading is not needed — only relative
  movement from a rest position.

---

LEVEL 2 — “Sandwich board” (best practical wearable)

Think like this:

[ nRF board ]
   ||
[ spacer (foam/3D printed) ]
   ||
[ BNO085 board ]

explain

----

Think of the “sandwich board” like a tiny electronics burger 🍔 — stacked layers, each doing one job, held together cleanly so nothing flops around.

Let’s break it down **physically + electrically + ergonomically** so you can actually build it.

---

# 🧠 What “sandwich” actually means

Instead of this mess:

```text
board → wires → board → wires → battery (floating chaos)
```

You make a **compact stack**:

```text
Top layer     → Sensor (BNO085)
Middle layer  → Spacer (gap + structure)
Bottom layer  → MCU (nRF52840)
Back          → Battery
```

---

# 📦 Visual mental model

## 🔝 TOP (touches wrist / environment)

👉 This is your **BNO085**

Why top?

```text
- needs clean motion data
- should not be buried near noisy electronics
- closer to skin = better signal
```

---

## 🧱 MIDDLE (spacer layer)

This layer is **CRITICAL** but people ignore it.

### What it does:

```text
- prevents short circuits
- gives airflow + space
- reduces noise coupling
- creates structure
```

### You can use:

* double-sided foam tape (fast)
* 3D printed frame (clean)
* nylon spacers (pro)

Thickness:

```text
~3–8 mm ideal
```

---

## 🔻 BOTTOM (brain layer)

👉 This is your **nRF52840 board**

Why bottom?

```text
- generates heat + noise
- has radio (BLE)
- needs separation from IMU
```

---

## 🔋 BACK (battery)

👉 Flat LiPo stuck behind MCU

Placement:

```text
[ wrist ]
[ sensor ]
[ spacer ]
[ MCU ]
[ battery ]
```

---

# 🔌 Wiring (super minimal)

Because you already have Qwiic:

```text
BNO085 ↔ nRF52840
(SDA, SCL, VCC, GND)
```

👉 Use:

```text
short JST SH cable (5 cm max)
```

No dupont nonsense.

---

# 🧠 Why this works (deep reason)

## 1. Signal integrity

```text
Sensor ≠ next to noisy power + radio
```

---

## 2. Mechanical stability

```text
Stack > wires
```

No flexing, no loose connections.

---

## 3. Wearability

Flat stack:

```text
✔ sits on wrist
✔ easy to enclose
✔ looks like product
```

---

# 🔥 Real-world analogy

This is literally how:

* smartwatches
* fitness bands
* VR trackers

are internally structured:

```text
sensor → isolated
MCU → shielded below
battery → backplate
```

---

# ⚠️ Common mistakes (don’t do this)

❌ Sensor under MCU
❌ Long loose wires
❌ No spacer (short circuit risk)
❌ Thick headers (adds height)

---

# ⚡ Quick build checklist

```text
1. Remove headers (important)
2. Use short Qwiic cable
3. Stick foam between boards
4. Align boards flat
5. Tape battery behind MCU
```

---

# 🧠 Final mental picture

```text
[ SENSOR ]
   ↑ clean data
[ SPACER ]
   ↑ isolation
[ MCU ]
   ↑ compute + BLE
[ BATTERY ]
   ↑ power
```

---

# 🚀 Next step (if you want)

I can:

* sketch your exact stack with dimensions
* or design a 3D printable enclosure for this sandwich

Right now, this is the difference between
👉 “prototype wires”
and
👉 “something that actually looks like a product.”
