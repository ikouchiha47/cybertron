# IMU Calibration & Gesture Segmentation — Reference Notes

How flight controllers (ArduPilot, PX4) calibrate IMUs, how the robotics/HCI
literature does gesture segmentation from raw IMU streams, and what's
directly actionable for `wristturn_audrino/wristturn/gesture/`.

Compiled 2026-09-01 after diagnosing the cross-axis gesture bleed bug fixed
in `GestureDetector.h` (see git history / `tests/test_gesture_detector.cpp`).

---

## 1. ArduPilot — accelerometer & gyro calibration

Source: [`AP_InertialSensor.cpp`](https://github.com/ArduPilot/ardupilot/blob/master/libraries/AP_InertialSensor/AP_InertialSensor.cpp) · [`.h`](https://github.com/ArduPilot/ardupilot/blob/master/libraries/AP_InertialSensor/AP_InertialSensor.h) · [docs](https://ardupilot.org/copter/docs/common-accelerometer-calibration.html)

**Accel:** 6-position calibration (level, left, right, nose-up, nose-down,
inverted), held stationary at each position, solving for per-axis bias
offset + off-axis cross-coupling correction. A "Simple Accel Cal" variant
skips the cross-axis terms and only solves offsets. ±20° position tolerance,
except "level" which anchors the whole attitude reference and is stricter.

**Gyro:** recalibrated fresh every boot (not persisted). `_init_gyro()` holds
the device still, signals via LED, and gates valid samples with a stillness
threshold (`_still_threshold` — 0.1 for planes, 1 for multirotors, 5 for
heli), controlled by the `_GYR_CAL` param.

**Relevance:** this is the same core idea as our `CALIBRATION_REWRITE.md`'s
stable-window buffer — stillness-gated sample averaging for baseline capture
— just simpler (no separate "all samples" fallback path like our
`stableCalBuffer`/`calBuffer` split). Our design is already at parity here,
arguably more robust.

---

## 2. PX4-Autopilot — same shape, different codebase

Source: [`gyro_calibration.cpp`](https://github.com/PX4/PX4-Autopilot/blob/main/src/modules/commander/gyro_calibration.cpp) · [`accelerometer_calibration.cpp`](https://github.com/PX4/PX4-Autopilot/blob/main/src/modules/commander/accelerometer_calibration.cpp)

`do_gyro_calibration()` uses median filtering over a stillness window.
`do_accel_calibration()` collects orientation-tagged samples and solves
offset+scale correction matrices — same conceptual shape as ArduPilot's
6-point method.

**Both projects converge on the same two ideas** for this layer: (a)
multi-orientation static capture for accel bias/scale, (b) stillness-gated
averaging for gyro bias. **Neither uses ML.** Real-time attitude/rate control
needs deterministic, explainable, low-latency math — ML in these projects is
reserved for higher-level tasks (vision-based obstacle avoidance etc.), not
raw gyro calibration or classification.

---

## 3. Allan Variance — the tool to actually validate our thresholds

Source: [`ori-drs/allan_variance_ros`](https://github.com/ori-drs/allan_variance_ros)

A statistical method (borrowed from oscillator frequency-stability analysis)
that computes Allan deviation σ(τ) across log-spaced averaging times
(0.1s–1000s) from a stillness recording. The slope of the resulting log-log
plot identifies noise-process types (random walk, bias instability, rate
random walk) and gives you the sensor's **actual measured noise floor** —
not a guess.

**This is the single most actionable finding here.** Every threshold in
`AxisDetector.h` — `JERK_ONSET_THRESHOLD` (3.0 rad/s²), `ZUPT_GYRO_THRESHOLD`
(0.03 rad/s), `INTEGRAL_THRESHOLD` (0.15 rad) — and in
`GestureArbitrator.h` — `minIntegralPitch`/`minIntegralRollYaw` (0.30 rad
default) — is currently unvalidated per `UNIFIED_GESTURE_DESIGN.md`'s own
threshold table. A few minutes recording the BNO085 sitting still, run
through this tool, would turn "unvalidated" into a real measured number for
every noise-floor-related constant. Complements — doesn't replace — the
vision-ground-truth protocol in `docs/THRESHOLD_VALIDATION.md` (that
validates *angle* accuracy; Allan variance validates *noise floor*).

---

## 4. Gesture segmentation architecture — the important one

Sources: general IMU-gesture-segmentation literature — [arXiv 2512.07997](https://arxiv.org/html/2512.07997v1) · [PLOS ONE 0227039](https://journals.plos.org/plosone/article?id=10.1371/journal.pone.0227039)

The literature converges on a **two-phase architecture**:

1. **Segmentation** — compute one combined-magnitude envelope across *all*
   axes (L2 norm of accel+gyro, or a sliding-window energy sum). Find a
   single onset/offset boundary for the whole gesture from this one signal.
2. **Classification** — *only after* the gesture window is bounded, decide
   which axis/direction it was, using data *within* that already-segmented
   window.

**Our `AxisDetector` does the opposite.** Three independent per-axis FSMs
(`roll`, `pitch`, `yaw`) each run their *own* `IDLE→ONSET→PEAK→DECAY→IDLE`
segmentation in parallel, on their own axis's raw gyro signal, with no shared
combined-envelope step. Axis identity is decided *implicitly* by whichever
FSM happens to segment first and pass `GestureArbitrator`'s ratio test — not
decided *after* a real physical gesture has already been isolated as one
event.

**Why this matters for the bug we just fixed:** there's no published
precedent for three-independent-parallel-FSMs as a segmentation strategy —
it's not wrong, but it's a non-standard, ad-hoc engineering choice. It's
structurally why cross-axis bleed happens at all: nothing stops two axes
from each independently deciding "this is a gesture" for what's
biomechanically one coupled motion, because there's no shared segmentation
step that would have bounded it to a single event in the first place.

The `CROSS_AXIS_REFRACTORY_MS` fix (`GestureDetector.h`) is a real, working
patch — verified via `tests/test_gesture_detector.cpp`, not a guess — and
it's the right size of fix for tonight. But it's fixing a symptom of the
architecture (multiple independent segmenters) after the fact, via a
lockout window, rather than fixing the segmentation step itself.

**If cross-axis bleed keeps surfacing after threshold tuning**, the
standard-architecture fix would be: replace the three-independent-FSM
segmentation with one shared jerk/energy-envelope FSM (combined magnitude
across roll+pitch+yaw gyro) that opens ONE gesture window, and only *then*
run the existing per-axis integral comparison (`GestureArbitrator`'s
dominant-axis-by-ratio logic, basically unchanged) to decide which axis it
was. This is a bigger refactor than tonight's fix — worth treating as its
own scoped piece of work, not bolted on reactively.

---

## Open questions this doesn't answer

- Whether `CROSS_AXIS_REFRACTORY_MS = 250` is the right value — needs real
  motion-data validation like everything else in this file, not a guess
  that happened to make one test pass.
- Whether the single-envelope segmentation redesign is worth the rewrite
  cost given the refractory patch may be "good enough" in practice — only
  real-world testing after reflashing will tell.
