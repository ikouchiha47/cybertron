
# Changelog

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
