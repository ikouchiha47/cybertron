# Changelog

Reverse-chronological. Each entry: rationale > what changed > files > risk.

---

## 2026-05-08

### Firmware resilience: calibration timer fix, hardware watchdog, state heartbeat

Three related changes landed together. All driven by an incident where the
firmware loop wedged for 49–63 seconds at a time after a disarm-rearm
sequence, only recovering on the next BLE write or supervision-timeout
disconnect. Symptoms looked intermittent ("calibration sometimes finishes,
sometimes hangs"); they were not — they were a deterministic interaction
between two bugs and one missing safety net.

#### 1. Calibration timer decoupling (root cause of "endless calibration")

**Why.** `handleStabilityClassifier()` overwrote `calStartMs = now` on every
stab=3 sample (~25 Hz). Same variable was used to gate the 3s collection
window AND the stability check. Result: while the user held the wrist still
(stab=3), `calStartMs` kept sliding forward → `(now - calStartMs >= 3000)`
never fired → finalization only happened via the 12s hard backstop.
Calibration "while moving" finished in 3s; calibration "while still" took
12s. Inverse of UX intent.

**What changed.**
- Renamed `CAL_WINDOW_MS` → `CAL_COLLECT_MS` (still 3000) — name now
  matches the job (sample collection), not the misleading "stable window".
- Reduced `CAL_DEADLINE_MS` 12000 → 6000 — 3s past collect window is
  enough margin; no human holds an arm out for 12s.
- Added `stableStartMs` separate from `calStartMs` — diagnostic only,
  tracks when current stab=3 window opened. Never gates finalization.
- Stab=3 handler no longer touches `calStartMs`. Logs window
  open/close transitions only.
- Finalization gate variable names: `collectDone` (3s) and `deadlineHit` (6s).

**Files.** `wristturn_audrino/wristturn/wristturn.ino` (~6 small edits).

**Validated.** Firmware logs show single-cycle calibration completing in
~3s when the wrist is still; stab=3 stable-window open/close events trace
cleanly without resetting the master timer.

#### 2. Hardware watchdog + reset-reason logging (recovery from any future wedge)

**Why.** Even after the calibration fix, the disarm-rearm path produced 49s
silences in firmware logs — the loop sat in `Bluefruit.waitForEvent()` and
SoftDevice BLE callbacks fired without waking the loop body. No explicit
fix was applied for that root cause; instead we made the system
self-recover so any future wedge resolves in 8s without manual intervention.

**What changed.**
- nRF52840 hardware WDT enabled with 8s timeout. `SLEEP_Run` config so it
  counts during WFE — required, otherwise wedge-in-WFE never trips the dog.
- WDT pat at the top of `loop()` — first thing after entry, so any
  subsequent hang is caught.
- RESETREAS read via Seeeduino core's `readResetReason()` (the core's
  `init()` clears the raw register before `setup()` runs; the saved value
  is the only way to know the cause). Logged with decoded flags
  (POWER_ON / PIN / DOG / SREQ / LOCKUP) after IMU init when USB CDC is
  enumerated.
- `WDT_SELFTEST` constexpr toggle (default false) — when true, deliberate
  hang at iter 5 verifies dog actually bites. Boot-loop safety: the
  selftest skips if `bootResetReas & 0x02` (we just woke from WDT). One
  cycle, then device runs normally even if the flag is left on.
- Verified end-to-end: deliberate hang → ~8s silence → reboot →
  `[BOOT] resetreas=0x00000002 DOG` → guard skips selftest → device
  resumes operation.

**Files.** `wristturn_audrino/wristturn/wristturn.ino` (~50 lines, mostly
in `setup()` and top of `loop()`).

**Risk.** Low. WDT is purely additive — doesn't change any control flow
unless the loop genuinely wedges. Pat is unconditional, so a healthy loop
never trips it. If a regression introduced a real loop hang, WDT now
auto-reboots within 8s instead of staying dead until BLE drop (~63s).

#### 3. State transition heartbeat (post-mortem for future wedges)

**Why.** WDT recovers from a wedge but says nothing about what state the
device was in before the hang. Without breadcrumbs, post-reset analysis
shows only "rebooted via DOG" — useless for diagnosis.

**What changed.**
- `[HB]` log emits on every transition between (armed × sleeping) states:
  DISARMED ↔ ARMED ↔ ARMED+SLEEPING ↔ DISARMED+SLEEPING. Each line
  includes prev state, iteration counter, BLE connection state.
- Backstop: `[HB] alive armed=1 iter=N` every 60s while actively armed,
  in case the device sits in one state for a long time. Quiet when
  disarmed or sleeping — no per-second noise.
- iter counter is `uint32_t` — wraps after ~1.4 years of continuous
  uptime. Defined behavior (wrap to zero, no UB). Acceptable; device
  will reboot from any of {power cycle, BLE disconnect, sleep wake,
  WDT} long before that.

**Files.** `wristturn_audrino/wristturn/wristturn.ino` (~25 lines added
at top of `loop()`).

**Risk.** Negligible. Pure observability. If `[HB]` lines turn out too
noisy in real traces they can be silenced by gating on a debug flag — but
the design is already quiet by default (logs only on transitions and
once per minute when armed).

#### Process notes — what we got wrong along the way

- **First attempted firmware fix** modified only the `calStartMs = now;`
  line in the stability handler. Worked, but did not address the root
  cause (variable doing two jobs). Final fix decouples by adding a
  separate `stableStartMs`. Lesson: name-driven design — overloaded
  variable names hide bugs.
- **First WDT integration** read `NRF_POWER->RESETREAS` directly in
  `setup()`. Always returned 0 because Seeeduino's `cores/nRF5/wiring.c`
  `init()` clears it before user code runs. Initially attributed (wrongly)
  to "the bootloader". Verified by reading the Adafruit and Seeeduino
  source on disk — Seeed core does the clear. Fix: use
  `readResetReason()` which returns the saved copy.
- **First selftest implementation** had no boot-loop safety, only the
  flag itself. If left on across a power cycle, the device would
  re-trigger the WDT every boot indefinitely. Added
  `!(bootResetReas & 0x02)` guard so selftest fires at most once per
  power-on cycle.
- **App-side disarm-rearm churn** is the original trigger of the wedge
  scenario. Not yet root-caused on the app side. WDT makes it harmless
  for now; the actual `disarm → 100ms → rearm` flow should still be
  investigated and removed.

---

## 2026-05-05

### Mount adapter: gravity vector unified through `MountingAdapter`

**Why.** `handleGravity()` had a hardcoded `gfz = -gz` mount transform that
duplicated logic already encapsulated in `MountingAdapter::transform()`. Two
places to keep in sync as the PCB / wear position evolves. Easy to drift.

**What changed.**
- `wristturn.ino:handleGravity()` — replaced inline `{x, y, -z}` with
  `mountAdapter.transform(gfx, gfy, gfz)`. Single call, same result.
- `mounting_adapter.h` — comments updated to make explicit that the same
  three-slot remap works for Euler angles, gyro vector, and gravity vector
  (all originate in the same chip body frame, so one map governs all).
- `pick()` parameter names renamed `r/p/y → a/b/c` to match the slot-generic
  intent.

**Files.**
- `wristturn_audrino/wristturn/wristturn.ino`
- `wristturn_audrino/wristturn/mounting_adapter.h`

**Validated.** Empirical: GravPose still classifies HANGING/FLAT/RAISED
correctly with the unified call, exactly as before the refactor (`{+1, +2, -3}`
already in use for Euler at line 1204 and gyro at line 1041, so the gravity
vector now follows the same convention by construction).

**Risk.** Zero behavioural change expected — the inline transform we removed
matched the existing AxisMap. Any future re-orientation of the band only
requires changing the AxisMap once at `wristturn.ino:32`.

---

### Engagement gate: drop gestures while arm is hanging

**Why.** A persistent prod problem: pitch_down, turn, etc. firing while the
user's arm dangled at their side (a hanging arm is "disengaged" intent).
Selections happened by accident; commands fired on idle motion. The `armPose`
signal from firmware was already available — wasn't being consulted.

**What changed.**
- `useBLE.ts:onGesture` — at the top of the BLE gesture handler (after parse,
  before mode routing), drop any gesture whose `armPose === HANGING` unless
  it's `SHAKE`. Shake is reserved as the always-on system abort signal so
  users always have an escape hatch even while disengaged.
- Logs `GESTURE_DROP` entries to `DebugLog` when suppression fires, so
  recordings/logcat tell you why a gesture didn't take effect.

**Files.**
- `wristturn-app/src/ble/useBLE.ts`

**Behavioural change.**
| Scenario | Before | After |
|---|---|---|
| Arm hanging + accidental motion | Fires gesture | Dropped |
| Arm hanging + shake | Fires (passes through) | Same — passes through |
| Arm flat/raised + any gesture | Fires | Same — fires |

**Risk.**
- 500ms gravity debounce means there's a window after arm-drop where
  `armPose` lags. Gestures fired in that window still pass. Acceptable.
- Knob ticks are synthesised in `MotionClassifier`, not here. They are NOT
  gated by this change. If we want them gated too, that's a second small
  change in `MotionClassifier.onMotion`.
- No pose-vs-baseline drift gate yet (different signal). Held back deliberately
  pending a decision on whether the persistent baseline is even meaningful
  across sessions.

---

### Firmware: arm-pose now driven by SH2_GRAVITY (independent of RV)

**Why.** Arm-pose classification (FLAT/HANGING/RAISED) lived inside
`handleRotationVector`. That handler stops being called when the BNO085's
sensor hub suspends fusion on a stationary wrist — and a stationary wrist is
exactly the condition we want to detect ("arm held still at side"). Result: the
classifier could never see HANGING because RV stopped emitting samples right
when the user wanted detection.

**What changed.**
- New `handleGravity()` handler reads the dedicated SH2_GRAVITY sensor
  (`imu.getGravityX/Y/Z()`). Continues emitting at the requested rate even when
  the wrist is held still — fundamentally just a low-rate accelerometer
  reading, not a fused orientation that needs continuous integration.
- Gravity sensor enabled in `enableReports()` at 100 ms (10 Hz), gated on
  `armed || rawMode` (same gating as RV).
- Added to the dispatch table next to RV.
- Disabled in cleanup paths (`enterSleep`, both disarm-with-and-without-cal-
  complete branches) so we don't bleed power.
- Classification logic (threshold 0.75, 5-sample debounce) preserved
  identically — only the input source changed.
- The old gravity block inside `handleRotationVector` was deleted to prevent
  drift between the two implementations.

**Files.**
- `wristturn_audrino/wristturn/wristturn.ino` — new constant
  `GRAVITY_INTERVAL_MS`, new `handleGravity()`, dispatch entry, enableReports
  block, cleanup paths.

**Validated.** Logs show `[GravPose] → hanging` firing reliably ~500 ms after
arm-drop, with `gfx_n ≈ ±0.95` (X dominant for arm-along-forearm).
`[GravPose] → flat` fires on horizontal arm with `gfz_n ≈ ±0.95`.
`[GravDiag]` heartbeat continues even when stationary, confirming the sensor
keeps emitting where RV would have gone silent.

**Risk.**
- 10 Hz × 5-sample debounce = 500 ms latency on transitions. Crisp enough.
- Mount-orientation sensitivity unchanged from before — same threshold, same
  classifier rules. If the user wears the band rotated differently than
  validated, mapping needs updating (in the AxisMap, single point of change).

---

### App: knob-mode session calibration race fix (fencing tokens)

**Why.** Entering ActiveControl in knob mode silently re-used the baseline
captured during Discovery instead of forcing a fresh capture. Cause: shared
`baselineCandidate` state in `useBLE` was never cleared, and the completion
effect's dependency `[sessionCalibrating, baselineCandidate]` triggered
immediately with stale data.

**What changed.**
- `useBLE.ts` — `baselineCandidate` now carries a monotonic `seq` counter,
  bumped on every `PKT_BASELINE` from firmware. Counter is module-level so it
  survives BLE reconnects.
- New `currentBaselineSeq()` exposes the current counter value to consumers.
- New `requestRecalibration()` writes the firmware "magic" `(-999, -999, -999)`
  baseline to clear firmware calibration state, returns the snapshot seq the
  caller should beat to accept a candidate as fresh.
- `ActiveControlScreen.tsx` — knob calibration entry now does:
  `armDevice() → requestRecalibration() → store snapshot in ref`. Completion
  effect ignores any candidate with `seq ≤ snapshot`. Safety timeout extended
  3 s → 5 s to match BNO settle window after `-999` write.
- `DiscoveryScreen.tsx` — same fencing pattern applied to E2 (cold connect)
  and E8 (focus-recalibrate). Snapshot taken at every entry into CALIBRATING,
  cleared on success/failure/timeout/skip. Focus paths now also call
  `requestRecalibration()` so firmware actually re-emits a fresh baseline
  (previously the re-arm did nothing because firmware retained
  `calibrationComplete=true`).

**Files.**
- `wristturn-app/src/ble/useBLE.ts`
- `wristturn-app/src/screens/ActiveControlScreen.tsx`
- `wristturn-app/src/screens/DiscoveryScreen.tsx`

**Risk.**
- Pre-existing flow with stored baseline (Discovery cold-connect) is
  unchanged — the snapshot fence only activates when CALIBRATING is entered.
- The `-999` write triggers firmware recalibration which can fail to complete
  if user holds the wrist with persistent motion. The 5 s timeout covers this
  by falling back to the previous home baseline.

---

### Build / env

- `wristturn-app/Makefile` — default APK switched from debug to release per
  `wristturn-app/CLAUDE.md`. APK path updated to `app-release.apk`.
- `~/.config/fish/config.fish` — appended `fish_add_path --move
  "$HOME/.asdf/shims"` so asdf-managed node always wins over a stray
  homebrew node. Triggered by a `brew upgrade` of simdjson breaking
  `/opt/homebrew/bin/node` (dyld load error), which surfaced as a Gradle
  build failure (`Process 'command 'node'' finished with non-zero exit value
  134`).

---

## Pending / not yet done

- Switch `1.0f / sqrtf(...)` + 3 divisions in `handleGravity()` to fast
  inverse sqrt (Quake-style). Benchmark in `tmp/bench_invsqrt.c` shows
  ~45-77% cycle reduction on Cortex-M4.
- Tune gesture thresholds — recent logs show `peak=2-4` gestures being
  rejected by `min_integ` arbitration. Need a deliberate "normal-use motion"
  log to establish real-world peak distribution before adjusting.
- Pose-drift engagement gate — currently we gate only on `armPose=HANGING`.
  Adding `|pose - baseline| > THRESHOLD` would catch the "wrist twisted way
  off baseline" case from the screenshot. Held back: the persistent home
  baseline drifts visibly across sessions in real use, so the threshold is
  hard to set without knowing whether baseline should be session-scoped
  instead.
- Discovery FSM refactor (paused) — replace the 8 useEffect blocks +
  `discStateRef` ref-based escape hatches with `useReducer` + epoch-stamped
  actions. Reducer pattern was sketched, not implemented.
