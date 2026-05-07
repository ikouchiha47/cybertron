# Unified Gesture Design

A single gesture system that handles both quick flicks and held deflections,
with no user-facing modes, no separate vocabularies, and no engagement
ceremony. Replaces the current gesture-mode / knob-mode / symbol-mode split
with one motion-shape recognizer that feeds the same mapping table.

This doc captures the design *and* the reasoning behind every decision so
future readers can judge edge cases without re-running the analysis.

---

## Why this rewrite

Three problems in the current system motivate it:

1. **Mode regression.** Commit `c4e7ad2` swapped the engine's rule set to
   `KNOB_RULES` whenever knob mode was active, dropping every flick mapping
   the user configured. The original `642b856` design kept user rules loaded
   in knob mode; a later refactor broke this. Step 1 of this rewrite reverts
   that. Already shipped.

2. **Vocabulary split.** Knob mode emits synthetic `knob_tick±` tokens that
   bypass the engine entirely (`useBLE.ts:245-249`). The user must map both
   `turn_right → action` (for flicks) and `knob_tick+ → action` (for ticks)
   even though the *intent* is the same. The mapping table double-counts.

3. **Layered policy in transport.** `useBLE` decides what `tap` means
   (engage knob, cycle mode, capture symbol) globally — but `tap` should
   mean different things on different screens. Connect on Discovery, engage
   on ActiveControl, etc. The current global handling is the source of the
   "tap means different things" smell.

4. **Fatigue.** Today, achieving N right-steps requires N flicks with full
   return-to-rest between each. AxisDetector can't fire on sustained roll
   (no DECAY phase), so users stuck in fatigue have no faster path. The
   current rejection of slow motion via `min_integ` / `ratio` thresholds
   acts as an *accidental fatigue filter* — it makes the system less
   responsive precisely when the user is tired.

The unified design solves (2), (3), and (4) by recognising that flicks and
holds are two different motion *shapes* of the same gesture intent, and
both should fire from the same vocabulary.

---

## Core primitive — `SettleGate`

The deepest pattern in this design is the **settle gate**: a small reusable
abstraction that distinguishes *intent* (the user has arrived at and chosen
a state) from *transit* (the user is briefly passing through a condition on
their way to something else).

Most state transitions in a gesture system have both shapes. Position alone
can't tell them apart — a wrist crossing +12° during a flick looks
identical, in that instant, to a wrist crossing +12° during a deliberate
hold. The discriminator is **sustained low-velocity** at the destination.

`SettleGate` is parameterised on duration and velocity threshold:

```ts
class SettleGate {
  constructor(durationMs: number, gyroMaxDps: number) {...}

  /** Feed a per-sample gyro magnitude. Returns true once settled. */
  feed(gyroMag: number, nowMs: number): boolean;

  /** Reset the timer (motion happened, must re-accumulate stillness). */
  reset(): void;
}
```

Internally: track `firstSettledAt` since gyro_mag dropped below threshold.
If gyro spikes above threshold, reset. Settled = `(now - firstSettledAt) ≥
durationMs` while still below threshold.

Same mechanism, different parameters per use. Live as
`gestures/SettleGate.ts` and reused throughout the system.

### Where settle gates apply across the system

| Use site | Duration | Why this duration |
|---|---|---|
| Hold-fire arming | 150 ms | must feel instantaneous (within human perception window) |
| Re-arm to NEUTRAL | 100 ms | edge-chatter prevention only |
| Tap discrimination | 100 ms | quick gesture, can't make user wait |
| Cooldown short-circuit | 200–300 ms | spring-back stops quickly when it stops |
| Combo abandonment | 300 ms | "decided not to" timing |
| LOCKED_SETTLING → LOCKED_ARMED | 1000 ms | user takes a deliberate beat to relax |
| Symbol-mode auto-finalize | 500 ms | comfortable pen-lift duration |
| Calibration baseline capture | 1000–2000 ms | high-stakes; can afford to wait |
| Grav-pose transition re-baseline | adaptive (settle-based, no max) | wait until new pose stabilises |

Different durations because they serve different urgencies and
commitments. Don't unify the durations. Do unify the implementation.

### Where settle gates already exist (implicitly) in the codebase

Pre-existing settle-like behavior, scattered and inconsistent:

- `MotionClassifier` calibration dwell (`MotionClassifier.ts:22-25`)
  — `DWELL_MS` (1000) and `DWELL_NO_MOTION_MS` (2000) are settle
  durations.
- `AxisDetector` DECAY phase — implicit firmware settle, waits for gyro
  to return to ~0 before firing.
- `KnobQuantizer` velocity floor (`minVelocityDps: 15`) — per-sample
  velocity gate, not duration-aware. To-be-replaced.

The unified design factors all of these into uses of `SettleGate`,
making the pattern explicit and uniform.

---

## Architecture

```
BNO085 raw stream  ─────────────────► Firmware (unchanged for v1)
                                          │
                                          ├─► velocity-domain detector
                                          │    (existing AxisDetector + Arbitrator)
                                          │    → fires gesture string on flicks
                                          │
                                          └─► pose stream (existing PKT_POSE)
                                                │
                                       BLE notify → App
                                                │
                                ┌───────────────┴───────────────┐
                                │                               │
                       gesture token (flick)            delta-from-baseline
                                │                       (10 Hz, continuous)
                                │                               │
                                ▼                               ▼
                       ┌──────────────────┐        ┌──────────────────────┐
                       │ InteractionEngine│        │ HoldDetector (NEW)   │
                       │  refractory      │        │ position FSM         │
                       │  snap-back       │        │ per-axis             │
                       │  combos          │        │ velocity-settled gate│
                       │  (ban same-tok)  │        │ cruise-lock state    │
                       └────────┬─────────┘        └─────────┬────────────┘
                                │                            │
                                │   gesture name token       │
                                │   (turn_right, etc.)       │
                                ▼                            ▼
                          ┌──────────────────────────────────────┐
                          │  Single mapping table                │
                          │  ComboMap — gesture names only       │
                          └──────────────┬───────────────────────┘
                                         │
                                         ▼
                                   action dispatch
                                         │
                                         ▼
                                  device adapter
```

Two detectors, one vocabulary, one mapping table, one dispatch path.
Velocity detector and position detector are independent — both read the same
firmware stream, both emit the same gesture names, both feed the same
engine's terminal rules.

---

## The two detectors

### Velocity-domain detector — AxisDetector (existing, unchanged)

Already implemented in `wristturn_audrino/wristturn/gesture/AxisDetector.h`.
Per-axis FSM `IDLE → ONSET → PEAK → DECAY → IDLE`. Fires on the DECAY→IDLE
transition. Detects impulse-shaped motion: a flick has a brief high-velocity
burst that returns to rest within ~400 ms.

The `GestureArbitrator` picks the dominant axis via ratio test (≥1.5)
to suppress cross-axis coupling.

**Output:** discrete tokens `turn_right`, `turn_left`, `pitch_up`,
`pitch_down`, `yaw_right`, `yaw_left`, `tap`, `shake`. Each token is one
event. No sustained semantics.

**Strengths:** clean impulse detection, drift-immune, axis-pure.

**Weaknesses:** completely deaf to slow deliberate motion. Sustained roll
past +12° produces no token because there's no DECAY back to rest. This is
the gap the position detector fills.

### Position-domain detector — HoldDetector (NEW)

A per-axis state machine driven by the pose-delta stream that the firmware
already emits. Detects: deflection past threshold, sustained presence, lock
via double-deflection, release, and pose-related invalidation.

Inputs per BLE pose sample:
- `delta_from_baseline` per axis (degrees)
- `gyro_magnitude` (for the velocity-settled gate)
- `armPose` (`flat` / `hanging` / `raised`) and grav-pose transitions
- timestamp

Outputs gesture-name tokens identical to those from AxisDetector
(`turn_right`, `turn_left`, etc.). Downstream consumers do not distinguish
which detector emitted a token.

---

## Full state machine — per axis-direction

Roll axis has two mirror state machines: one for `+` (turn_right) and one
for `-` (turn_left). Same logic, signs flipped. Pitch and yaw axes likewise.
Symbol mode is unchanged and sits outside this FSM.

```
                  ┌──────────────────────────┐
                  │         NEUTRAL          │ ◄────────────┐
                  └────────────┬─────────────┘              │
                               │                            │
            delta > +12°       │                            │
            gyro_mag < 5 dps   │                            │
            settled ≥ 150 ms   │                            │
            armPose stable     │                            │
                               ▼                            │
                  ┌──────────────────────────┐              │
                  │       ENGAGED+           │              │
                  │   (FIRE turn_right ×1)   │              │
                  │   start dwell timer      │              │
                  └────────────┬─────────────┘              │
                               │                            │
            dwell ≥ 400 ms     │  delta drops below +12°    │
            still past +12°    │  → COOLDOWN+               │
                               ▼                            │
                  ┌──────────────────────────┐              │
                  │      REPEATING+          │              │
                  │  (FIRE turn_right @5Hz)  │              │
                  └────────────┬─────────────┘              │
                               │                            │
              within           │  delta drops below +12°    │
              LOCK_WINDOW      │  → COOLDOWN+               │
              and second       │                            │
              deflection past  ▼                            │
              +12° detected ┌──────────────────────────┐    │
                            │      COOLDOWN+           │    │
                            │  no opposite fires       │    │
                            │  re-arm at ±2°           │    │
                            │  cooldown 1 s            │    │
                            └──────┬───────────┬───────┘    │
                                   │           │            │
              second deflection    │           │ cooldown   │
              within LOCK_WINDOW   │           │ expires    │
                                   ▼           ▼            │
                  ┌──────────────────────────┐ NEUTRAL ─────┘
                  │   LOCKED_SETTLING+       │
                  │ (FIRE turn_right @5Hz)   │
                  │ all position-based       │
                  │ exits DISABLED           │
                  │ user can relax wrist     │
                  │ to chosen rest position  │
                  │                          │
                  │ Exit on:                 │
                  │  - armPose = hanging     │ ──► STOP, no fire
                  │  - shake event           │ ──► STOP, no fire
                  │  - gravPose transition   │ ──► STOP, no fire
                  │  - LOCKED_MAX_MS elapsed │ ──► STOP, no fire
                  └────────────┬─────────────┘
                               │
            SettleGate(1000ms) │  gyro_mag < 5 dps
            satisfied:         │  for 1000 ms continuous
                               ▼
                  ┌──────────────────────────┐
                  │  snapshot delta as       │
                  │  lock_baseline           │
                  │  (per-axis-direction)    │
                  └────────────┬─────────────┘
                               │
                               ▼
                  ┌──────────────────────────┐
                  │     LOCKED_ARMED+        │
                  │ (FIRE turn_right @5Hz)   │
                  │ exits now active         │
                  │                          │
                  │ Exit on:                 │
                  │  - delta - lock_baseline │ ──► fire turn_left ×1
                  │    < -12° + settled gyro │     both COOLDOWN
                  │  - armPose = hanging     │ ──► STOP, no fire
                  │  - shake event           │ ──► STOP, no fire
                  │  - gravPose transition   │ ──► STOP, no fire
                  │  - LOCKED_MAX_MS elapsed │ ──► STOP, no fire
                  └──────────────────────────┘
```

State transitions in plain English:

- **NEUTRAL → ENGAGED+**: user crossed the fire threshold deliberately. One
  immediate fire. Start counting dwell.
- **ENGAGED+ → REPEATING+**: dwell elapsed, user is still holding. Begin
  auto-repeat at TV-remote rate. The 400 ms initial delay distinguishes
  "deflect briefly and release" (one event) from "deflect and hold" (event
  stream).
- **ENGAGED+ → COOLDOWN+**: user released before dwell finished. One fire
  total, then cooldown to protect the return motion.
- **REPEATING+ → COOLDOWN+**: user released after holding. Auto-repeat ends
  immediately (the moment delta drops below +12°). Cooldown protects against
  involuntary spring-back overshoot crossing −12°.
- **REPEATING+ → LOCKED_SETTLING+**: this transition is conditional on
  history. See next section.
- **COOLDOWN+ → NEUTRAL**: cooldown expired AND wrist is inside dead band
  (±2°). System is fully ready for next deliberate motion in either
  direction.
- **LOCKED_SETTLING+ → LOCKED_ARMED+**: gyro magnitude has been below
  `SETTLE_GYRO_DPS` continuously for `SETTLE_DURATION_MS`. System
  snapshots current delta as `lock_baseline` for this axis-direction.
  Exit conditions become active.
- **LOCKED_ARMED+ → exits**: see exit conditions below.

### Cruise-lock entry (the double-deflection trigger)

LOCKED is reached by a *temporal pattern*, not a deeper threshold:

- User completes a hold (REPEATING+ → COOLDOWN+ → NEUTRAL).
- Within `LOCK_WINDOW_MS` of leaving REPEATING+, user makes a second
  deflection past +12° in the same direction.
- The second deflection's first fire transitions directly to
  LOCKED_SETTLING+ (instead of ENGAGED+ → REPEATING+).

Sequence:
```
t=0      deflect past +12°               → ENGAGED+, fire turn_right
t=400    still past +12°                  → REPEATING+, fires at 5 Hz
t=2000   delta drops below +12°           → COOLDOWN+, fires stop
t=2500   re-arm crossed (delta < +2°)     → NEUTRAL
                                            (lock window still open
                                             until t=3500 — i.e.
                                             1500 ms after t=2000)
t=2800   deflect past +12° again          → LOCKED_SETTLING+,
                                            fire turn_right, 5 Hz auto-repeat
                                            (position-based exits disabled)
…user relaxes wrist back toward neutral…
t=3000   wrist relaxing, gyro non-zero    → SettleGate counting reset
t=3400   wrist still, gyro_mag < 5 dps    → SettleGate accumulating
t=4400   1000 ms of stillness elapsed     → snapshot delta as lock_baseline
                                            → LOCKED_ARMED+
                                            (exits now active relative to
                                             lock_baseline)
…cruise continues…
t=60000  user deflects past lock_baseline -12°, gyro settled 150 ms
                                          → LOCKED_ARMED+ exits
                                            fire turn_left ×1
                                            both axes COOLDOWN 1 s
```

If the user takes longer than `LOCK_WINDOW_MS` (1500 ms) between holds, the
second deflection is just another regular hold (`ENGAGED+ → REPEATING+`).
No lock.

The 1500 ms window is calibrated to give the user ~500 ms of deliberate
"second tap" time after the cooldown clears.

### Why no spatial lock threshold

Earlier drafts considered "press deeper past +17° to lock" as an
alternative. Rejected because:

- Single threshold (12°) keeps muscle memory simple.
- Spatial lock thresholds depend on each user's DOF; double-deflection is
  invariant.
- Symmetric with the cooldown timer already in the design — no new
  spatial concept introduced.
- Users can stumble into cruise by accident — discoverable, easy to learn.

---

## Universal exits — apply from ANY state

The following events force the position FSM (every axis-direction slot) to
NEUTRAL with no fire, regardless of current state. They're checked before
any state-specific transition logic:

| Universal exit | When | Effect |
|---|---|---|
| Shake event from firmware | always | all axis-direction slots → NEUTRAL, no fire, all SettleGates reset |
| `armPose === hanging` | always | all axis-direction slots → NEUTRAL, no fire |
| BLE disconnect | always | full detector reset |
| Grav-pose transition (e.g. raised↔flat) | always | all axis-direction slots → NEUTRAL, no fire; baseline marked stale until firmware emits a fresh `PKT_BASELINE` |

Shake is the user's always-on system-level abort. It must work from
NEUTRAL, ENGAGED, REPEATING, COOLDOWN, LOCKED_SETTLING, *and* LOCKED_ARMED
— including mid-flick, mid-combo, and mid-hold. The firmware emits shake
through the existing velocity path (`gestureChar` with token `shake`); the
app routes it to the FSM as a universal-exit signal *before* engine
dispatch.

Arm-down and grav-pose transitions are similar safety nets: when the
user's whole arm position changes, baseline-relative position becomes
meaningless. Better to reset cleanly than to fire spurious actions on
stale references.

## Exit conditions for LOCKED states — state-specific table

In addition to the universal exits above, LOCKED has two sub-states with
distinct *position-based* exit semantics:

### LOCKED_SETTLING+ position-based exits

All position-based exits are *disabled* during settling. The user's
relaxation motion (returning wrist toward chosen rest position) must not
trigger a false exit. Universal exits (shake, arm-down, grav-pose change,
BLE disconnect) still apply — see table above.

| Exit | What fires | When it triggers |
|---|---|---|
| (no position-based exits during settling) | — | — |
| `LOCKED_MAX_MS` elapsed | nothing | safety auto-exit if user never settles |

### LOCKED_ARMED+ position-based exits

After settle, `lock_baseline` is captured. Position-based exit becomes
active. Universal exits (shake, arm-down, grav-pose change, BLE
disconnect) also apply — see table above.

| Exit | What fires | When it triggers |
|---|---|---|
| `delta - lock_baseline < -12°` + gyro settled 150 ms | `turn_left` × 1 | user actively reverses past threshold |
| `LOCKED_MAX_MS` elapsed | nothing | safety auto-exit (forgotten cruise) |

### Notes on LOCKED behaviour

- The opposite-deflection exit *fires the opposite token once* because the
  user's intent is "stop and step back one." If they only wanted to stop,
  shake or arm-down does it cleanly.
- Single flicks in *other* axes (e.g., pitch_up while right-locked) fire
  normally through the velocity detector. LOCKED is per-axis-direction; it
  doesn't suppress unrelated gestures.
- Exit threshold is **−12° from `lock_baseline`**, not from the original
  calibration baseline. This adapts to whatever rest position the user
  chose during LOCKED_SETTLING. If the user settled at delta=+5°, exit
  fires at delta=−7°. If they settled near delta=0°, exit fires at
  delta=−12°.

---

## All thresholds and timing constants

| Constant | Value | Job | Validation status |
|---|---|---|---|
| `FIRE_THRESHOLD_DEG` | ±12° | enter ENGAGED state from NEUTRAL | unvalidated |
| `REARM_THRESHOLD_DEG` | ±2° | exit COOLDOWN to NEUTRAL | unvalidated, may need widening |
| `GYRO_SETTLED_DPS` | 5 dps | discriminate hold from flick-passing-through (also reused as `SETTLE_GYRO_DPS`) | unvalidated |
| `SETTLE_DWELL_MS` | 150 ms | hold-fire arming: stillness needed before counting as "held" | unvalidated |
| `REPEAT_START_DELAY_MS` | 400 ms | from first fire to auto-repeat (TV-remote feel) | unvalidated |
| `REPEAT_INTERVAL_MS` | 200 ms | 5 Hz repeat rate | matches TV remotes |
| `COOLDOWN_MS` | 1000 ms | post-hold opposite-direction suppression | unvalidated |
| `LOCK_WINDOW_MS` | 1500 ms | second deflection triggers cruise within this | unvalidated |
| `POSE_PENDING_MS` | settle-based, no max | detector pause after grav-pose transition until new pose stabilises | unvalidated |
| `SETTLE_DURATION_MS` | 1000 ms | LOCKED_SETTLING → LOCKED_ARMED transition (lock_baseline capture) | unvalidated |
| `LOCKED_MAX_MS` | 300000 ms (5 min) | safety auto-exit from LOCKED_* (silent, no fire) | unvalidated |
| `REARM_SETTLE_MS` | 100 ms | optional: brief settle inside dead band before NEUTRAL | unvalidated, low priority |
| `COMBO_ABANDON_MS` | 300 ms | optional: stillness during partial combo abandons match | unvalidated, low priority |

Per `CLAUDE.md`: every unvalidated constant must be guarded behind a feature
flag and not enabled in production until validated against real session
data. See `docs/THRESHOLD_VALIDATION.md` for the protocol.

### Anatomical reference

- Wrist circumference (test subject): 17.5 cm → radius ≈ 2.79 cm.
- Wrist roll DOF (pronation + supination): ~80° each direction from neutral.
- 12° threshold corresponds to ~5.8 mm of skin travel at the wrist surface.
- 2° re-arm corresponds to ~1 mm of skin travel.

The 12° threshold is ~15% of usable DOF — small enough to be a comfortable
intentional motion, large enough to clear normal posture micromotion.

---

## Mapping table semantics

### One vocabulary, gesture names only

The `ComboMap` holds entries keyed by gesture names:

```ts
{
  "turn_right":   "volume_up",
  "turn_left":    "volume_down",
  "pitch_up":     "channel_up",
  "tap":          "play_pause",
  "shake":        "abort",
  // ...
}
```

No `knob_tick+` keys. No `knob_tick-` keys. The mapping is mode-agnostic
because there are no modes.

### Heterogeneous combos only

Combos remain supported for the velocity detector. Same-token combos are
banned at registration time:

```
"turn_right"             → ok (terminal)
"turn_right,pitch_up"    → ok (heterogeneous combo)
"turn_right,turn_left"   → ok (heterogeneous combo)
"turn_right,turn_right"  → REJECTED — use a hold instead
"pitch_up,pitch_up"      → REJECTED
```

Reasoning:
- Repetition of the same token is exactly what auto-repeat (hold) does
  better. Same-token combos collide with auto-repeat firing rates.
- Forbidding them at registration eliminates the entire class of
  hold-vs-combo conflict.
- Users who want fast-forward-on-double-flick should map to a hold instead
  ("hold turn_right fires fast-forward at 5 Hz") or use a heterogeneous
  combo (`turn_right,pitch_up`).

`ComboValidator.ts` enforces this rule. See migration steps below.

### How combos and holds coexist

Both detectors emit into the same engine. The engine's existing rule
priority handles disambiguation:

- A token enters the engine. If it's the start of a known combo sequence,
  the engine holds it (partial match) up to `windowMs`.
- If the next token within window completes a combo, fire combo action.
- If the window expires without completion, the held token flushes to
  lower-priority terminal rules — fires `turn_right → volume_up`.

For the position detector specifically: each tick of auto-repeat is one
engine-push. The first one might briefly enter a partial-match state for
heterogeneous combos that start with `turn_right` (e.g.,
`turn_right,pitch_up`). If no `pitch_up` arrives within window, the held
`turn_right` flushes to terminal and fires the user's mapped action — same
as a flick.

If the user *does* deflect right then quickly flick pitch_up, the combo
fires. Acceptable: the user clearly issued a heterogeneous sequence.

The same-token ban prevents the pathological case where auto-repeat itself
forms a combo (`turn_right,turn_right`).

---

## Symbol mode

Out of scope for this rewrite. Symbol mode is fundamentally different
(modal capture of a trajectory, not analog control), and the existing
`SymbolCapture` machinery handles it cleanly. Keep as-is for now. A future
revision may unify symbol mode under a different mechanism (e.g., explicit
"capture" gesture) but that's not this doc.

For v1 of the unified design:
- Symbol mode stays as a separate explicit mode toggled via settings only.
- Triple-tap mode cycle is *removed* (see "What goes away" below) — symbol
  mode is reachable only from the settings screen.
- This is a slight loss of reachability for symbol users, accepted because
  triple-tap-cycling-mode is otherwise a layering bug.

---

## What gets removed

| Code | File(s) | Reason |
|---|---|---|
| `KnobEngagement` class | `gestures/KnobEngagement.ts` | Engagement is no longer a concept; deflect-and-hold is implicit |
| `KnobQuantizer` class | `gestures/KnobQuantizer.ts` | Folded into `HoldDetector` |
| `ModeManager` class | `gestures/ModeManager.ts` | Only knob/gesture distinction goes away; symbol mode read directly from `PrefsStore` |
| `knob_tick+` / `knob_tick-` vocabulary | `useBLE.ts:296-301`, `comboMapToRules:94` | Single vocabulary; gesture names only |
| `KNOB_RULES` (already removed in step 1) | `useBLE.ts` | n/a |
| Triple-tap mode cycle (`handleTapForModeCycle`) | `useBLE.ts:232-242, :419` | Layering bug; mode change goes through settings |
| `dispatchSyntheticCombo` for `knob_tick*` | `useBLE.ts:245-249, :298-300` | Direct dispatch path no longer needed |
| `if (mode === Mode.KNOB)` branch in `onGesture` | `useBLE.ts:436-450` | No mode-specific gesture handling |
| `BLEServiceNative.setMode` calls | `useBLE.ts:283` | Firmware doesn't need to know mode anymore |
| `interactionMode`, `knobEngaged` from `SharedState` | `useBLE.ts:25-27` | Replaced with single `motionState` |

---

## What stays

| Code | Why |
|---|---|
| `InteractionEngine` | Still drives flick combos, refractory, snap-back |
| `MotionClassifier` | Calibration ceremony still needed; baseline establishment |
| `AxisDetector` and `GestureArbitrator` (firmware) | Velocity detector unchanged |
| `state_packet.h` and `parseStatePacket` | Pose stream is the input to the new detector |
| `mounting_adapter.h` | Axis remapping for left/right wrist still required |
| `SymbolCapture` and recognizer | Symbol mode preserved as explicit-only mode |
| `ComboMap` schema | Same shape; just no `knob_tick*` keys |
| `ComboValidator` | Extended with same-token ban |

---

## What gets added

| New code | File | Purpose |
|---|---|---|
| `HoldDetector` class | `gestures/HoldDetector.ts` | Per-axis position FSM with all states above |
| Same-token combo rejection | `gestures/ComboValidator.ts` | Reject `turn_right,turn_right` etc. at registration |
| `HoldDetector` test scenarios | `gestures/__tests__/HoldDetector.test.ts` | Cover every state transition with synthetic deltas |

---

## Migration order

Each step is independently shippable and independently testable.

### Step 1 — `KNOB_RULES` revert ✅

Already done. `useBLE.ts` no longer swaps the engine rule set in knob mode.
User flick mappings fire correctly while in knob mode.

### Step 2 — `ComboValidator` extension

Add same-token rejection. Show validator errors in the GestureMapping
screen. Migrate any existing default mappings that violate
(e.g., `turn_right,turn_right → fast_forward` becomes
`hold turn_right → fast_forward` once Step 4 lands).

Risk: low. Pure validation logic, no runtime change.

### Step 3 — `HoldDetector` implementation behind a feature flag

Build the new class. Wire into `useBLE` as an additional input alongside
existing `KnobEngagement`. Both fire to the same dispatch path. Feature
flag (`PrefsStore.experimentalHoldDetector`) gates whether `HoldDetector`
output is dispatched.

Risk: medium. Side-by-side coexistence with old code. Test thoroughly with
session-replay before promoting.

### Step 4 — Remove `KnobEngagement` / `KnobQuantizer` / mode infrastructure

Once `HoldDetector` validates against session data, rip out the old
mode/engagement machinery and the `knob_tick*` vocabulary. Remove triple-tap
mode cycle. Drop `BLEServiceNative.setMode` if the firmware doesn't actually
use the mode info (it doesn't, per the firmware analysis).

Risk: medium-high. Touches `useBLE`, screens that read `interactionMode`,
PrefsStore default-mode persistence. Done via codemod over the affected
files.

### Step 5 — Lift screen-policy out of `useBLE`

Separate concern from the gesture rewrite, but enabled by it. Move `tap`
semantics, mode toggle, calibration triggers from `useBLE` into per-screen
hooks (`useActiveControl`, `useDiscovery`). `useBLE` becomes pure
event-source.

Risk: medium. Larger refactor but mechanical once gesture vocabulary is
unified.

Steps 1, 2, 3 can land before any screen rework. Steps 4 and 5 require
coordinated screen changes.

---

## Implementation notes for `HoldDetector`

### File: `wristturn-app/src/gestures/HoldDetector.ts`

Public API:

```ts
export interface HoldDetectorCallbacks {
  onFire:        (token: string) => void;
  onStateChange: (axis: Axis, dir: "+" | "-", state: HoldState) => void;
}

export type Axis = "roll" | "pitch" | "yaw";
export type HoldState =
  | "neutral"
  | "engaged"
  | "repeating"
  | "cooldown"
  | "locked";

export class HoldDetector {
  constructor(callbacks: HoldDetectorCallbacks, config?: Partial<Config>);

  /** Feed a per-sample pose delta. Drives the FSM. */
  onDelta(delta: { roll: number; pitch: number; yaw: number },
          gyroMag: number,
          nowMs?: number): void;

  /** Notify of an arm-pose transition. Triggers POSE_PENDING gate. */
  onArmPoseChange(prev: ArmPose, next: ArmPose, nowMs?: number): void;

  /** Soft reset (e.g., baseline re-captured by firmware). */
  reset(): void;
}
```

Internal: per-(axis, direction) state slot, six in total (roll±, pitch±,
yaw±). Each slot independent except for the cross-axis cooldown enforcement
on opposite-direction unlock from LOCKED.

Token names produced match firmware's GestureDetector vocabulary exactly:

| Axis | Direction | Token |
|---|---|---|
| roll | + | `turn_right` |
| roll | − | `turn_left` |
| pitch | + | `pitch_up` |
| pitch | − | `pitch_down` |
| yaw | + | `yaw_right` |
| yaw | − | `yaw_left` |

### Position dominance check

Unlike velocity dominance (axis with largest gyro magnitude must exceed
others by 1.5×), position dominance is looser: axis with largest |delta|
must exceed others by 1.2×, and the deflection on dominated axes must be
below `FIRE_THRESHOLD_DEG / 2` (so a 12°/8°/8° distribution is not a clean
roll hold, while 12°/3°/3° is).

This handles the `armPose === raised` case where gravity coupling adds
small but non-trivial offsets to non-roll axes.

### Wiring into `useBLE`

```ts
// existing onDelta callback in startRuntime
BLEServiceNative.onDelta?.((p) => {
  lastDeltaSample = p;
  motionClassifier?.onDelta(p);
  // NEW: feed hold detector
  holdDetector?.onDelta(p, lastGyroMag, Date.now());
});

// new gyro magnitude tracker — derived from existing pose stream or
// added to the BLE pose packet. (Decision needed in step 3.)
```

The detector emits via `engine.push(token)` for the *first* fire of any
state transition (so heterogeneous combos still match), then via direct
dispatch for subsequent auto-repeats (to skip combo participation and
avoid the same-token shadow problem covered above).

This dual-path is internal to the detector; the rest of the app sees one
token stream.

---

## Visual feedback — surfacing timed states to the user

The position FSM has many time-bounded states (lock window, settle,
cooldown, dwell, safety timeout). Without feedback, users have to learn
these durations by trial and error. With feedback, every timed state
becomes self-explanatory and the system feels like a game with clear
input affordances.

### Principle

**Temporal states need temporal indicators.** Position alone can't tell
the user whether they're in cooldown, in the lock window, in
LOCKED_SETTLING, etc. — those are states defined by *time since the last
transition*, not by current wrist position. A small persistent visual
HUD that reflects the current `DetectorPhase` makes the entire FSM legible
without docs.

### State-to-visual mapping

A single ~80 px circular HUD on `ActiveControlScreen`. Color carries
semantics, geometry carries timing.

| Detector state | Visual | Meaning to user |
|---|---|---|
| `NEUTRAL` | no HUD (or dim outline) | system idle, ready for input |
| `ENGAGED+` (dwell building) | small filling green arc | "if you keep holding, repeat starts in N ms" |
| `REPEATING+` | solid green ring + faint pulse on each fire | "auto-repeat active, release to stop" |
| `COOLDOWN+` | red depleting arc | "post-hold cooldown, opposite direction blocked" |
| `COOLDOWN+` *with lock window open* | gold-on-red split arc | "deflect again to lock cruise" — the discoverability cue |
| `LOCKED_SETTLING+` | blue filling arc | "system is capturing your rest position; relax" |
| `LOCKED_ARMED+` | solid blue + slow breathing pulse | "cruising; deflect opposite to exit" |
| `LOCKED_*` near `LOCKED_MAX_MS` | thin red ring at outer edge | "auto-exit imminent" |

Direction conveys progress: *filling* arcs build toward an event
(dwell complete, settle achieved); *depleting* arcs run down to a
deadline (cooldown end, lock window close).

### State exposure on `SharedState`

For any screen to render this, `useBLE` publishes a `DetectorPhase`
discriminated union with timing deadlines:

```ts
type DetectorPhase =
  | { kind: "neutral" }
  | { kind: "engaged";          axis: Axis; dir: "+" | "-";
      startedAt: number; dwellEndsAt: number }
  | { kind: "repeating";        axis: Axis; dir: "+" | "-";
      startedAt: number; lockWindowEndsAt: number | null }
  | { kind: "cooldown";         axis: Axis; dir: "+" | "-";
      cooldownEndsAt: number; lockWindowEndsAt: number }
  | { kind: "locked_settling";  axis: Axis; dir: "+" | "-";
      lockedAt: number; settleEndsAt: number; safetyEndsAt: number }
  | { kind: "locked_armed";     axis: Axis; dir: "+" | "-";
      lockedAt: number; lockBaseline: number; safetyEndsAt: number };

interface SharedState {
  // ...existing fields
  detectorPhase: DetectorPhase;
}
```

Phase transitions emit on `notify()` like any other state change. Within
a phase, the deadline fields are static — the renderer animates by
diffing `Date.now()` against the deadlines via `requestAnimationFrame`,
not via React re-renders. This keeps the FSM at its native event rate
and the animation at 60 Hz independently.

### Rendering note

The HUD component (`ui/DetectorPhaseRing.tsx`) takes the current
`DetectorPhase`, snapshots `Date.now()` once, and uses RAF to update an
SVG circle's `stroke-dasharray` from there. No setState in the loop. On
phase change, the screen passes a new prop and the component restarts
with the new deadlines.

### Implementation-optional but strongly recommended

The `DetectorPhase` field is part of the contract. The HUD that consumes
it is per-screen — `ActiveControlScreen` should render it; other screens
can ignore the field. This way:

- Headless integrations (e.g., the daemon adapter) don't need to know
  about the visual.
- Screens that *do* benefit (live control feedback) get a clean,
  composable HUD.
- The FSM doesn't grow UI dependencies.

### Test contract

`gestures/__tests__/DetectorPhase.test.ts` should assert that, for each
input sequence the FSM consumes, the emitted `DetectorPhase` payload has
the right `kind`, the right axis/dir, and deadlines that satisfy
invariants like `dwellEndsAt > startedAt + REPEAT_START_DELAY_MS - epsilon`.
This gives the renderer a stable contract to build against and protects
against silent regressions in timing semantics.

---

## Validation needs — empirical, gated by session data

These have measurable answers. Each requires a recorded session with
ground-truth instrumentation (camera + AprilTag, per
`docs/THRESHOLD_VALIDATION.md`) to confirm. Constants tied to these
questions stay behind a feature flag until the data lands.

| # | Question | What we measure | What it gates |
|---|---|---|---|
| V1 | Linearity of IMU roll vs. true roll | Slow full-range sweep; expect slope 1.0 ±5% | trust in any position-domain threshold |
| V2 | Deliberate-fire angle distribution | Subjects mark "fire" verbally; measure true roll at those instants | `FIRE_THRESHOLD_DEG = 12°` |
| V3 | Fatigue drift bounds | With user instructed to *not* deflect, max roll over 60 s of arm-rest | confirms 12° is clear of drift |
| V4 | Gyro-settled distribution during verified holds | Gyro magnitude during stable held positions | `GYRO_SETTLED_DPS = 5 dps` |
| V5 | Ballistic release overshoot | Hold at +75° (near DOF max), release ballistically; measure peak opposite-side overshoot | `COOLDOWN_MS = 1000 ms` (widen if overshoot > 12° at >1 s post-release) |
| V6 | Lock_baseline drift over long ARMED cruise | 30+ minute cruise; track `delta - lock_baseline` over time | whether v1 needs periodic re-settle within ARMED |
| V7 | Euler-coupling during cross-pose motion | AprilTag (true axis-angle) vs. IMU Euler delta during wrist twist + arm pose change | whether v1.1 needs quaternion-relative deltas |

`docs/THRESHOLD_VALIDATION.md` describes the recording protocol. A single
5-minute session covers V1–V5 and partially answers V6/V7. A separate
30-minute "long cruise" session is needed for V6.

---

## Open design questions — decisions still pending

These don't have empirical answers. They're choices about feel, scope, or
integration behaviour that need a call from the maintainer before code
lands.

| # | Question | Tradeoff |
|---|---|---|
| Q1 | Does `LOCK_WINDOW_MS` feel natural? Test with HUD ring vs. without. | With HUD: probably 800–1000 ms (user has explicit timing feedback). Without HUD: probably 1500 ms (must be generous since user is guessing). Settle the *base* number for non-visual contexts (daemon, headless), then optionally tighten when HUD is rendered. |
| Q2 | Is 1000 ms `SETTLE_DURATION_MS` right for the LOCKED_SETTLING grace? | Too short = user still holding entry deflection when baseline pins. Too long = user thinks lock is broken. Subjective. |
| Q3 | Same-token combo migration path | Inventory existing default mappings (`turn_right,turn_right → fast_forward`, `turn_left,turn_left → rewind`, etc.), decide migration: convert to holds, drop, or replace with heterogeneous combos? Affects user docs and existing prefs. |
| Q4 | Universal-exit ordering with engine | When shake fires, the FSM treats it as universal abort and resets. The engine *also* sees it as a `shake` token through the normal velocity-detector path. Does the engine's mapped `shake → action` still fire? Spec says yes (FSM reset and engine fire are independent). Confirm on integration. |
| Q5 | Should `COMBO_ABANDON_MS` be enabled in v1? | Stillness mid-combo abandons the partial match. Could feel responsive ("I changed my mind, system noticed") or surprising ("why didn't my combo register?"). Default off in v1; enable after subject test. |
| Q6 | Should symbol mode also receive the universal-exit treatment? | Currently symbol stays modal and outside the FSM. Universal exits (shake, arm-down) probably should still cancel an in-progress symbol capture. Confirm by walking through `SymbolCapture.cancel()` callers. |
| Q7 | LOCKED_MAX_MS — 5 min or different? | Forgotten-cruise safety. 5 min is a guess. Could be 1 min (more conservative) or 30 min (more permissive). No measurable answer; pick a default and adjust based on field reports. |

---

## What this design does NOT solve

Honest list of out-of-scope concerns:

- **Roll dominance during raised-arm reversals.** A user with arm raised
  who reverses through baseline mid-motion may have roll, pitch, yaw all
  contributing roughly equally for a brief window. Both detectors will
  reject. This is correct behavior (input is genuinely ambiguous) but may
  feel like a dead spot. Mitigation: re-baseline after grav-pose change.
  Long-term fix: better forearm-frame correction in `mounting_adapter`.
- **Multi-axis simultaneous holds and Euler coupling.** "Delta from
  baseline" is reported in Euler angles. Euler-angle deltas are not
  three independent per-axis motions — they're a decomposition of total
  rotation in a fixed sequence (yaw-pitch-roll). When the user moves arm
  pose significantly (raised → flat) or composes wrist twist with arm
  pitch, a pure single-axis physical motion can show up as changes in
  multiple Euler angles. This means a "multi-axis simultaneous hold"
  detection is sometimes a single-axis intent bleeding into other axes,
  not two distinct intents.
  
  Mitigations in v1:
  - `mounting_adapter.h` corrects chip-to-wrist axis remap.
  - Grav-pose universal exit invalidates baseline on large arm
    repositioning (raised↔flat↔hanging) — prevents Euler coupling at
    gimbal regions from feeding the FSM stale references.
  - Position dominance ratio (1.2×) and `FIRE_THRESHOLD/2` bleed cap
    in `HoldDetector` filter low-magnitude coupling.
  - `MotionClassifier`'s existing 2° bleed threshold during roll
    motion handles the in-pose case.
  
  These are good for typical single-axis deliberate motion in a stable
  pose. They are *not* mathematically clean — true rotation
  decomposition would need quaternion/axis-angle deltas, not Euler.
  Documented as a known approximation; revisit if validation sessions
  show users hitting multi-axis confusion in practice.
  
  If it becomes a real problem, the fix is firmware streaming
  quaternion-relative deltas (`q_baseline^-1 * q_current`) decomposed
  to axis-angle in the app. Order-independent, no Euler coupling.
- **Adaptive thresholds per user.** Some users will have less DOF or
  more tremor. v1 ships fixed thresholds; v2 may auto-tune from a
  per-user calibration session.
- **Variable repeat rate scaled with deflection magnitude** (the v2
  improvement noted earlier). User confirmed v1 ships fixed 5 Hz. v2 may
  scale rate from 3 Hz at +12° to 10 Hz at +60° deflection.
- **Symbol mode unification.** Symbol stays modal in v1.

---

## Worked examples — what the FSM does for common user motions

Each example traces the timeline of detector states, fires, and what the
user perceives. These exist to (a) help new readers build intuition, and
(b) serve as test scenarios for `HoldDetector.test.ts`.

All times in ms from the start of the motion. Assumes default constants:
`FIRE_THRESHOLD_DEG=12°`, `GYRO_SETTLED_DPS=5`, `SETTLE_DWELL_MS=150`,
`REPEAT_START_DELAY_MS=400`, `REPEAT_INTERVAL_MS=200`, `COOLDOWN_MS=1000`,
`LOCK_WINDOW_MS=1500`, `SETTLE_DURATION_MS=1000`.

### Example 1 — fast flick to neutral (single command)

User flicks wrist right, returns immediately. Classic gesture-mode flick.

```
t=0     gyro spikes positive
t=80    delta crosses +12°, gyro high
t=160   delta peaks at +30°, gyro past peak
t=240   delta returning, crosses +12° on way back
t=320   delta near 0°, gyro decaying
t=350   AxisDetector DECAY → fires turn_right (one fire)
t=400   wrist at rest, fully neutral
```

Position detector never fires (SettleGate's gyro-settled requirement
never satisfied during the brief peak — the user was already returning by
the time settle would have started accumulating). Single fire, no
auto-repeat. **User sees: one `turn_right` action.**

### Example 2 — fast big motion, stop and hold (covered earlier)

User snaps wrist to −40° and holds. Walk-through above; result is one
immediate `turn_left` fire (from velocity detector, position detector
suppressed by engine refractory), then 5 Hz auto-repeat starting +400 ms
after first fire. Continues until release.

### Example 3 — slow deliberate left, stop and hold

User takes 1 s to roll wrist to −40°, then holds.

```
t=0      slow motion begins, gyro low (~40°/s)
t=500    delta crosses -12°, but gyro still moving
         → AxisDetector never reaches ONSET (velocity below threshold)
         → position SettleGate not satisfied (gyro not settled)
t=1000   wrist arrives at -40°, gyro decaying
t=1100   gyro below 5 dps
t=1250   SettleGate satisfied (150 ms of stillness)
         → ENGAGED-, fires turn_left via engine.push
t=1650   400 ms dwell → REPEATING-, auto-repeat begins at 5 Hz
…        continues until release
```

**User sees: one delayed `turn_left` action ~1.25 s after starting the
motion, then auto-repeat.** This is the case the old system silently
dropped.

### Example 4 — drift (should fire nothing)

User instructed to relax arm without intentional motion. Slight posture
creep over 60 s.

```
t=0      delta=0, gyro near 0
t=15000  delta slowly drifted to +6° from posture creep
t=30000  delta at +9°, still slow
t=45000  delta at +11°, just below threshold
t=60000  delta plateaus at +11°
```

Never crosses +12°. Even if it did, gyro is below 5 dps the whole time,
but the velocity-detector also doesn't fire (no ONSET). Position
detector's *first-fresh-deflection* logic would catch it: the wrist must
have been in NEUTRAL recently (delta < +2°) before the threshold crossing
counts as a fresh fire. Drift from neutral isn't a fresh deflection in
that sense — the SettleGate has been satisfied continuously, so any
crossing of +12° during continuous-stillness counts as drift, not intent.

The implementation must enforce this: **ENGAGED+ entry requires both a
position threshold crossing AND a recent transit (gyro non-zero recently)
that brought the wrist there.** Pure-creep into the threshold zone
without any motion event is filtered.

**User sees: nothing.** Correct behaviour.

### Example 5 — cruise lock entry and exit

User holds turn_right for 2 s, releases, re-deflects within 1.5 s,
relaxes wrist; later reverses to exit.

```
t=0      deflect right past +12°, gyro settles at +30°
t=400    SettleGate satisfied → ENGAGED+, fire turn_right
t=800    REPEAT_START_DELAY_MS elapsed → REPEATING+ at 5 Hz
t=2000   user releases, delta drops below +12°
         → COOLDOWN+, fires stop, lock window opens
t=2200   delta crosses below +2° → re-armed inside dead band
         (still in COOLDOWN+, lock window still open until t=3500)
t=2800   user deflects right past +12° again
         → LOCKED_SETTLING+, fire turn_right, 5 Hz auto-repeat
         (position-based exits disabled)
t=3000   user begins relaxing wrist back toward neutral
         gyro non-zero → SettleGate counter resets
t=3400   wrist still at +5°, gyro < 5 dps
         → SettleGate accumulating
t=4400   1000 ms of stillness elapsed
         → snapshot lock_baseline = +5°
         → LOCKED_ARMED+ (exits now active relative to +5°)
…        cruise continues, user fully relaxed, action repeats at 5 Hz
…
…30 minutes later…
…
t=1804400 user deflects left, wrist now at lock_baseline - 12° = -7°
          gyro settled 150 ms
          → LOCKED_ARMED+ exits
          → fires turn_left ×1
          → both axes COOLDOWN 1 s
          → NEUTRAL after cooldown
```

**User sees: continuous `turn_right` actions for the duration, ending
with a single `turn_left` action when they reverse to exit.**

### Example 6 — wrong-direction deflection during cruise (no exit)

While in LOCKED_ARMED+ at lock_baseline = +5°, user accidentally jiggles
right past +12°.

```
state    LOCKED_ARMED+ (cruising right, lock_baseline = +5°)
event    delta jumps to +25°, gyro settled
         → same direction as the lock; not an exit condition
         → no state change, cruise continues
         → no fire (already at 5 Hz auto-repeat)
```

**User sees: nothing changes.** Same-direction deflection during cruise
is informational at most; doesn't add or break the cruise.

### Example 7 — shake during cruise (universal exit)

User in LOCKED_ARMED+, decides to abort.

```
state    LOCKED_ARMED+ at any axis-direction
event    AxisDetector emits "shake"
         → universal exit, applies before any state-specific logic
         → all axis-direction slots → NEUTRAL, no fire from the FSM
         → engine still receives the "shake" token via velocity path
         → if the user has shake → mapped_action, that action fires
           through the engine's normal terminal path (unrelated to the
           FSM reset)
```

**User sees: cruise stops immediately. If `shake` is mapped to an action
(e.g., `abort_to_home`), that action fires once.**

### Example 8 — pose change during cruise (silent exit)

User in LOCKED_ARMED+, drops arm to side.

```
state    LOCKED_ARMED+
event    armPose transitions from "raised" to "hanging"
         → universal exit
         → all axis-direction slots → NEUTRAL, no fire
         → velocity detector also stops emitting (firmware gates
           gestures while armPose=hanging, except shake)
```

**User sees: cruise stops, no extra action fires.** Sensible when the
user has clearly disengaged from the device.

### Example 9 — partial hold then release (single fire only)

User deflects right past +12°, holds for 200 ms, releases.

```
t=0      deflect past +12°
t=150    SettleGate satisfied → ENGAGED+, fire turn_right
t=350    user releases before REPEAT_START_DELAY_MS (400 ms) elapses
         → COOLDOWN+, no auto-repeat reached
t=350+   wrist returning, COOLDOWN+ counts down
t=550    delta below +2° → re-armed
t=1350   COOLDOWN+ expires → NEUTRAL
```

**User sees: one `turn_right` action.** Same as a flick. The 400 ms
REPEAT_START_DELAY_MS is the dividing line between "single command" and
"begin auto-repeat" — released before that, you got one fire only.

---

## Glossary

- **Flick** — quick wrist motion with onset, peak, and return-to-rest
  within ~400 ms. Detected by velocity detector. One event per flick.
- **Hold** — sustained deflection past fire threshold with gyro settled.
  Detected by position detector. One initial fire + auto-repeat at 5 Hz.
- **Cruise / Lock** — auto-repeat that continues regardless of wrist
  position. Engaged via double-deflection within `LOCK_WINDOW_MS`.
- **Cooldown** — brief post-hold window during which opposite-direction
  fires are suppressed. Protects involuntary spring-back from registering
  as a deliberate reversal.
- **Re-arm** — return inside the dead band (±2°) required before the
  same axis can fire again from a fresh deflection.
- **Snap-back** — colloquial term for cooldown; covers both flick-return
  suppression (engine layer) and hold-release suppression (detector layer).
  Same physical principle, two layers.
- **Settled gyro** — gyro magnitude below 5 dps, indicating wrist has
  arrived at a position rather than passing through it.

---

## Reasoning archive — why some choices were rejected

To prevent re-litigating these in future:

- **Alias dispatch (`map["knob_tick+"] ?? map["turn_right"]`):** rejected.
  Two keys for one intent; engine snap-back inheritance double-filters
  ticks. Direct gesture-name lookup with single mapping is cleaner.
- **Routing ticks through engine.push:** rejected. Combo rules shadow
  terminal rules at any tick rate faster than `windowMs`, breaking
  bidirectional control. Engine snap-back additionally suppresses
  deliberate reversals.
- **Press-deeper-to-lock (spatial threshold at +17°):** rejected. Adds
  anatomy guesswork; double-deflection is timing-based and DOF-invariant.
- **Modal engagement (tap to engage, triple-pitch-down to commit):**
  rejected. Adds a ceremony for what should be implicit. Position
  detector's state machine handles it without user-visible ceremony.
- **Loosening firmware GestureArbitrator thresholds to catch slow
  motion:** rejected. Velocity detector should stay strict; slow motion
  is the position detector's job. Each detector clean in its domain.
- **Auto-engage knob on first roll motion:** rejected. Conflicts with
  natural arm motion during conversation. Tap-or-deflect-past-threshold
  is the explicit signal.
- **Shake or arm-down as the *only* exit from cruise:** rejected as too
  restrictive. Opposite-deflection-past-threshold is the symmetric undo
  and matches the lock-entry mechanism. Shake and arm-down still serve
  as universal aborts, applicable from any state.
- **Immediate lock_baseline pinning at LOCKED entry:** rejected. The
  entry deflection is at +12° or beyond — that's not where the user
  intends to rest. Pinning at entry would force the user to deflect
  +24° total to exit (+12° lock-entry minus 12° threshold equals 0°,
  which feels neutral). Settle-then-pin captures the user's *chosen*
  rest position instead.
- **Fixed `POSE_PENDING_MS` timer:** rejected. Pose transition durations
  vary widely. Fixed timer either misses fast transitions or wastes time
  on slow ones. Settle-based — wait until gyro stabilises in the new
  pose, no max — adapts to whatever the user actually does.
- **Single global `SETTLE_DURATION_MS` constant:** rejected. Different
  use sites have different urgencies — hold-fire arming needs 150 ms
  (must feel instant); lock-arming wants 1000 ms (deliberate beat);
  calibration tolerates 2000 ms (high-stakes capture). Same mechanism
  via `SettleGate`, different parameters per use.
- **Per-direction independent COOLDOWN on LOCKED_ARMED exit:** rejected.
  Both axes COOLDOWN simultaneously on exit because the unlocking
  deflection's spring-back can cross either dead band; protecting only
  one direction would let the other false-fire.
- **No safety timeout on LOCKED:** rejected. Forgotten cruise (user
  walked away, fell asleep, etc.) is a real failure mode. Five-minute
  silent auto-exit is belt-and-suspenders alongside arm-down detection.
- **Shake firing opposite-action token before reset:** rejected. Shake
  is system-level abort; firing any axis-direction token would dilute
  its semantics. If the user has mapped `shake → some_action`, that
  action fires through the engine's normal terminal rule path; the FSM
  reset is a separate concern.
