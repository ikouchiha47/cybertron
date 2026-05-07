# Validating Wrist-Roll Thresholds With Vision Ground Truth

## Why this exists

The unified gesture design (`docs/UNIFIED_GESTURE_DESIGN.md`) introduces several
position-domain thresholds — fire at ±12°, re-arm at ±2°, gyro-settled at 5 dps,
and so on. Per `CLAUDE.md`:

> If a constant or threshold is not validated against real-world data, it is not
> production ready.

The IMU reports its own roll angle, but that's the thing we're evaluating — we
can't validate it against itself. We need an *independent* measurement of wrist
orientation that we can record alongside the IMU stream.

This doc covers how to do that with vision-based ground truth, the honest
limitations of each approach, and a practical recipe to start with.

---

## What we are actually trying to measure

Wrist **roll** = pronation/supination = rotation of the hand about the forearm's
long axis. Anatomically ~80° each way from neutral.

Important: this is *not* the same as wrist flexion (palm toward forearm) or
ulnar/radial deviation (hand side-to-side). Those are pitch and yaw in our axis
naming. We're concerned with roll.

The motion is a rotation, not a translation. The wrist joint barely moves in
space during pronation/supination — only its *orientation* changes. That makes
this harder to measure from monocular video than, say, an arm flick would be.

---

## Why OpenPose 2D alone is poor for this

OpenPose's body model gives 2D keypoints (shoulder, elbow, wrist) — useless for
roll. The wrist *position* doesn't move during pronation/supination; only its
rotation about the forearm axis changes.

OpenPose's hand model (21 keypoints per hand) is closer — finger keypoints
*do* shift in 2D as the hand rotates — but:

- 2D keypoints lose depth, so the same 2D positions can correspond to different
  3D orientations (especially near the palm-edge-on view).
- Foreshortening at non-frontal camera angles distorts angle estimates by
  10–30% depending on geometry.
- Hand keypoint accuracy degrades sharply when the hand is partially occluded
  or near image edges.

Practical accuracy for roll angle from monocular 2D OpenPose hand: roughly
**±10–15°**. That's bigger than the threshold we're trying to validate. So
OpenPose 2D alone cannot validate a 12° threshold.

---

## Three approaches, ranked by difficulty and accuracy

### Approach 1 — Fiducial marker on back of hand (recommended for v1)

**Setup:** print an AprilTag or ArUco marker (~3 cm square), tape to the back
of the hand near the wrist so it sits flat on the bone surface. Record video
with a single phone camera (1080p, 30 fps, locked exposure) while the user
performs the motions.

**Processing:** `opencv-python` + `pupil-apriltags` or `cv2.aruco`. For each
frame, the library returns the marker's 6-DoF pose (3D rotation + 3D
translation) relative to the camera. Decompose the rotation matrix into Euler
angles in the wrist frame. The forearm-axis component is your ground-truth
roll.

**Accuracy:** ±1–2° at typical phone-camera distances. More than enough to
validate a 12° threshold.

**Effort:** few hours including printing the marker, taping, recording, and
writing the parser. Reusable for every future session.

**Limitation:** the marker must remain visible. If the hand rotates so the
marker faces away from the camera, you lose the frame. Solve by keeping the
camera roughly above the hand and limiting roll range to ±60° from the
camera-facing pose. Or use two cameras.

This is the right starting point. It's simple, accurate, and the parser code
is ~50 lines.

### Approach 2 — MediaPipe Hands (no marker, monocular)

**Setup:** Google's MediaPipe Hands gives 21 hand landmarks with a partial
3D component (z relative to wrist) from a single RGB camera. Some loss of
absolute depth but good relative geometry.

**Processing:** Python `mediapipe` package. Per frame, take the wrist
landmark and the metacarpal landmarks to define a hand-plane normal. The
angle of that normal projected into the forearm-perpendicular plane is the
roll estimate.

**Accuracy:** ±5–8° in good lighting with full hand visibility. Worse than
markers; better than raw OpenPose 2D.

**Effort:** install MediaPipe, write ~100 lines for the geometry. No physical
setup beyond pointing a phone at the hand.

**Limitation:** model accuracy varies with hand pose, lighting, skin tone, and
camera distance. Degrades when fingers curl. Not suitable for validating
±2° thresholds; OK for ±12°.

Use this when you need to validate motions where a marker would be awkward
(e.g., thumb-side rotations, gripping a phone).

### Approach 3 — Multi-camera OpenPose 3D

**Setup:** two or more synchronized cameras, calibrated extrinsics
(checkerboard procedure). OpenPose with 3D module enabled triangulates
keypoints across views.

**Accuracy:** ±2–3° comparable to markers, no marker required.

**Effort:** significant — camera sync, calibration, OpenPose build with CUDA,
3D pipeline. Days, not hours.

**Limitation:** infrastructure cost. Worth it only if you're running many
sessions and the marker-on-skin approach has become impractical.

Skip this for v1. Revisit if marker-based validation becomes a bottleneck.

---

## Recommended recipe for the first validation session

1. **Print** an AprilTag (e.g., `tag36h11_id0`) at 30 mm. Free generators
   exist online; pick the standard family supported by `pupil-apriltags`.
2. **Tape** to the back of the dominant hand, centered ~2 cm proximal of the
   knuckles, marker oriented with one edge along the forearm axis.
3. **Wear** the WristTurn device on the same wrist, as usual.
4. **Record video** with a phone or laptop camera positioned ~50 cm above the
   hand, hand resting palm-down on a table to start. 1080p, 30 fps, locked
   exposure. Run for 60–120 seconds.
5. **Simultaneously**, capture the IMU stream. Easiest: open the app's
   `LogsScreen` and screen-record the device, or pipe BLE notifications
   to a file via the daemon adapter (`wristturn-app/daemon/`). Both streams
   need a clock sync — clap once at the start within camera frame to give a
   visible+audible event you can correlate against the IMU's gyro spike.
6. **Perform a script** of motions, with verbal annotation:
   - 5× neutral hold (3 s each) to establish baseline
   - 3× slow roll right to comfortable max, hold 3 s, return slowly
   - 3× fast flick right + return
   - 3× double-deflect cruise (deflect, return, deflect again)
   - 3× release-from-DOF-limit (roll to physical max, let go ballistically)
   - 3× slow drift (try to *not* deflect, let arm relax) — to test the
     fatigue-drift filter
7. **Process offline:**
   - Run the AprilTag parser over the video → produce `(t_video, roll_deg)` CSV.
   - Sync the clap event between camera audio and IMU gyro spike → compute
     time offset.
   - Re-base IMU timestamps to the video clock.
   - Plot both roll-angle traces on the same axes.

A single-page Jupyter notebook can do steps 7a–c in under 100 lines.

---

## What the validation actually answers

For each threshold in the design doc, we want to know: *at the moment the
firmware/app considered the threshold crossed, what did the ground-truth
camera see?* Concretely:

| Question | How the data answers it |
|---|---|
| Does +12° IMU roll correspond to ~+12° true roll? | Plot IMU roll vs. AprilTag roll. Slope should be 1.0; offsets reveal calibration drift. |
| Does the user's "deliberate fire" correspond to ≥12°? | Mark the timestamps where user said "fire" verbally. Read AprilTag roll at those instants. Histogram. |
| Does fatigue drift stay below 12°? | Look at the drift script (step 6.6). Max true roll during "rest" should be well under 12°. |
| Is 5 dps a safe gyro-settled threshold? | During a held position, the IMU's gyro magnitude over a 200 ms window should drop below 5 dps; check that the AprilTag roll is stable (<1° change) during those windows. |
| Does ballistic release overshoot past −12°? | From the release script (step 6.5), measure peak true roll on the opposite side after releasing from +75°. Tells us whether the release-cooldown of 1 s is necessary. |

The output of one session is a table: each design constant, its current
proposed value, and the empirically-supported value range. Constants that
validate get unblocked for production. Constants that don't get re-tuned and
re-validated.

---

## Alternative: skip vision, use a second IMU as ground truth

A simpler ground-truth source: a second IMU in known stable orientation
(e.g., a phone strapped to the forearm). Measure its rotation, subtract from
the wrist IMU's rotation → forearm-relative wrist roll.

**Pros:** no camera, no marker, no lighting concerns. Synchronized via the
shared clock if both are on the same device or paired via NTP/BLE.

**Cons:** you've replaced "is the IMU right" with "is some other IMU right."
If both have the same calibration drift, you've validated nothing. Useful for
*relative* motion (did the wrist move more than the forearm?), not for
*absolute* angle.

Camera+marker stays the recommended primary; second-IMU is a useful sanity
check that catches gross errors but doesn't replace independent ground truth.

---

## Tools and rough costs

| Tool | License | Install difficulty | Accuracy for wrist roll |
|---|---|---|---|
| `pupil-apriltags` (Python) | LGPL | easy (`pip install`) | ±1–2° |
| `cv2.aruco` (Python OpenCV contrib) | BSD | easy (`pip install opencv-contrib-python`) | ±2–3° |
| `mediapipe` Hands (Python) | Apache 2.0 | easy (`pip install`) | ±5–8° |
| OpenPose body+hand 2D | non-commercial | hard (CMake, CUDA) | ±10–15° |
| OpenPose 3D (multi-view) | non-commercial | very hard | ±2–3° |

Start with `pupil-apriltags`. If markers become impractical, switch to
`mediapipe`. OpenPose isn't worth the build pain for this specific question.

---

## What I do NOT yet know

- The exact relationship between the device's reported roll and true
  forearm-relative roll given current `mounting_adapter.h` axis remapping.
  First session should record a slow, full-range sweep and confirm linearity.
- Whether ballistic release actually crosses the opposite threshold in real
  use, or whether the wrist's natural rest position keeps overshoot small.
  This is the (a)/(b) question from the design discussion that I asked you
  to eyeball.
- Whether 5 dps is a meaningful "gyro-settled" threshold in the presence of
  device-on-skin micromotion (clothing rustle, pulse, breathing). Could be
  too tight.

A single 5-minute recorded session with the marker setup above answers all
three.
