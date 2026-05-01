# Power Management — RUNE-I

## Overview

Two independent but coordinated systems manage power:

1. **Adaptive RV Rate** — scales the rotation vector report frequency based on
   motion state while the device is active (armed or in use).
2. **PowerManager** — a composable sleep policy engine that governs BNO085
   sleep tiers when the device has been inactive for `SLEEP_TIMEOUT_MS` (5 min
   production, 30s debug).

They share a common driver: the BNO085 stability classifier (stab 0–4).

---

## 1. Adaptive RV Rate

### What it does

The BNO085 fusion engine always runs at ~400Hz internally. The "report rate"
we configure controls how often the hub pushes data to the nRF52840 over I2C.
Lower report rate = fewer CPU wakeups per second = less MCU active time.

| Rate | Interval | When |
|------|----------|------|
| 50Hz | 20ms | Default on arm/wake; always during MOTION |
| 10Hz | 100ms | Knob/symbol mode only, after 5s stationary |

### State machine

Driven by `handleStabilityClassifier()` on every stab change:

```
stab=4 (MOTION)
  → snap to 50Hz immediately
  → reset rvIdleSinceMs

stab=3 (STABLE — arm raised, user resting between gestures)
  → reset rvIdleSinceMs (no countdown)
  → hold current rate

stab≤2 (STATIONARY / TABLE — device truly at rest)
  → if MODE_GESTURE: reset timer, hold 50Hz (never drop in gesture mode)
  → if MODE_KNOB / MODE_SYMBOL: start 5s countdown
      → after 5s: drop to 10Hz

Any arm/wake event
  → enableReports() always resets to 50Hz
```

### Why gesture mode never drops

In gesture mode the arm rests at `stab=3` (STABLE) between flicks — the user
is holding their wrist up, not moving, waiting to gesture again. Dropping to
10Hz at stab=3 would mean a cold start at the next gesture: the BNO085 report
rate takes one interval to ramp up, so the first 100ms of a gesture could be
missed. Keeping 50Hz continuously means zero latency on gesture onset.

Knob and symbol modes have no such constraint — the user is in deliberate
sustained motion, so they tolerate a short ramp from 10Hz back to 50Hz.

### Flow into power

Lower report rate reduces how often `waitForEvent()` returns in `loop()`,
which reduces MCU active time and I2C bus traffic. The BNO085 chip power is
dominated by its fusion engine, not the output rate, so savings are primarily
on the nRF52840 side.

---

## 2. PowerManager — Sleep Tiers

### Entry

`enterSleep()` fires from `loop()` when:
```
(millis() - lastMotionMs) > SLEEP_TIMEOUT_MS
```

`lastMotionMs` is updated by stab=4 (MOTION) events, shake/tap, and
`exitSleep()`. So the path to sleep is: **no MOTION events for 5 min →
enterSleep()**.

### How stability drives the countdown to sleep

The adaptive rate system and sleep entry share the same root signal:

```
User puts device down
  → stab drops: 4 → 3 → 2 → 1
  → stab=4 (MOTION) stops firing → lastMotionMs freezes
  → sleep countdown begins (5 min timer)
  → adaptive rate: stab≤2 for 5s → drops to 10Hz (non-gesture modes)
  → at 5 min: enterSleep()
```

The two timers are independent: rate drops at 5s of stillness, sleep fires at
5 min. Both are reset by the same MOTION signal.

### Sleep tiers (StagedPolicy)

```
enterSleep()
  → disable high-freq reports (RV, linear accel, gyro, stability)
  → drain FIFO (clears ack events from the disable calls)
  → powerMgr.onInactivity(hw) → StagedPolicy.arm()

Stage 0: ShakeSleepPolicy  (light sleep, runs for 4.5 min)
─────────────────────────────────────────────────────────
  arm():
    configureSensor(SHAKE_DETECTOR, 200ms interval, wakeupEnabled=false)
    modeSleep()
    start 30s software timer

  tick() called every ~10ms from loop():
    if timer < 30s → return false (stay asleep)
    on 30s expiry:
      modeOn() + drainFifo(200ms)   ← BNO085 wakes, shake detector runs
      if 0x19 (shake) seen → return true → full wake
      else → modeSleep() + reset 30s timer

Stage 1: SigMotionSleepPolicy  (deep sleep, indefinite)
──────────────────────────────────────────────────────
  arm():
    configureSensor(SIG_MOTION, 2s interval, wakeupEnabled=true)
    modeSleep()                      ← always-on domain handles wake

  tick() called every ~10ms from loop():
    if INT pin HIGH → return false
    if INT pin LOW:
      modeOn() + drainFifo(300ms)
      if 0x12 (significant motion) seen → return true → full wake
```

### Full timeline after device goes still

```
T+0s      stab=4 (MOTION) stops → lastMotionMs freezes
T+5s      RV rate drops to 10Hz (knob/symbol modes only)
T+5min    enterSleep() → Stage 0 (ShakeSleepPolicy) begins
          BNO085: modeSleep, shake at 5Hz, no INT dependency
T+5m30s   tick fires: modeOn 200ms, check shake, back to sleep
T+6m00s   tick fires: modeOn 200ms, check shake, back to sleep
...       (every 30s)
T+9m30s   Stage 0 ends (4.5 min elapsed)
T+9m30s   Stage 1 (SigMotionSleepPolicy) begins
          BNO085: SIG_MOTION armed wakeupEnabled=true, modeSleep
          nRF52840: WFE, wakes only on SIG_MOTION INT or FreeRTOS tick
```

### Wake sequence

```
powerMgr.tick() returns true
  → exitSleep()
      → sleeping = false
      → imu.modeOn() + safety drain
      → enableReports()  ← resets to 50Hz, adaptive rate starts fresh
      → Bluefruit.Advertising.start()
```

---

## 3. Validated Behaviour (from hardware logs)

### logs.39 — DEADLOCK bug (old firmware, pre-fix)

This log captured the firmware before the `return` fix in the sleep loop.
After `enterSleep()`, `loop()` fell through to the DEADLOCK check every
iteration because there was no `return` after `delay(10)`. The modeSleep()
SHTP ACK held INT LOW, triggering 301 consecutive warnings over ~3 seconds:

```
[00:05:03.247] [Sleep] inactivity timeout — entering light sleep
[00:05:03.284] [Sleep] pre-sleep drain: 5 cycles, INT=1
[00:05:03.376] E [DEADLOCK WARNING] CPU about to sleep but BNO085 INT is LOW!
[00:05:03.386] E [DEADLOCK WARNING] ...   ← repeats 301 times over 3 seconds
...
[00:05:06.287] E [DEADLOCK WARNING] ...   ← last warning
[00:10:00.312] E [DEADLOCK WARNING] ...   ← two more just before wake
[00:10:00.462] E [DEADLOCK WARNING] ...
[00:10:00.579] [Sleep] PowerManager: wake event confirmed — exiting sleep
[00:10:00.641] [Sleep] reports restored — restarting BLE advertising
```

Key observations:
- 301 DEADLOCK warnings fired in a ~3s burst immediately after sleep entry
- Despite the spam, the device did NOT actually deadlock — FreeRTOS RTC tick
  continued waking the CPU from WFE every ~1ms
- Device eventually woke correctly (~5 min later) from the shake cycle
- **Root cause**: missing `return` in sleep block → loop fell through to
  DEADLOCK check and `waitForEvent()` on every 10ms iteration

**Fix**: added `return` after `delay(10)` in the sleeping block. The DEADLOCK
warning check and `waitForEvent()` are now skipped entirely while sleeping.

---

### Session log — stage transitions working (new firmware)

Captured after PowerManager wiring was complete. Shows clean light→deep sleep
transition and confirmed SigMotion wake:

```
[00:05:03.247] [Sleep] inactivity timeout — entering light sleep (armed=0 lastMotionAge=300004ms)
[00:05:03.284] [Sleep] pre-sleep drain: 5 cycles, INT=1
                        ↑ 5 min idle, clean drain, INT=1 before sleep

[00:09:33.452] [Sleep] stage=1 deep sleep (SigMotion, INT-based)
                        ↑ exactly 4.5 min after sleep entry → StagedPolicy
                          disarmed ShakeSleepPolicy, armed SigMotionSleepPolicy

[00:14:07.756] [Sleep] PowerManager: wake event confirmed — exiting sleep
[00:14:07.756] [Sleep] waking — restoring reports
[00:14:07.813] [Sleep] exitSleep drained 1 residual events, INT=1
[00:14:07.813] [Reports] enable start rawMode=0 armed=0 sleeping=0
[00:14:07.825] [Sleep] reports restored — restarting BLE advertising for reconnect
[00:14:08.259] [Stab] stab=4
                        ↑ ~4.5 min in deep sleep, SigMotion fired on motion
```

Key observations:
- `stage=0` was never logged in this run — bug: `lastStage` initialised to `0`
  same as `staged.currentStage`, so first stage change was never detected.
  **Fixed**: initialise `lastStage = 0xFF` so stage 0 always logs on entry.
- SigMotion (`SH2_SIGNIFICANT_MOTION`, 0x12) **confirmed working** on this
  hardware revision — asserts INT from modeSleep with wakeupEnabled=true.
- `exitSleep drained 1 residual events` — normal, the SigMotion event itself.
- No DEADLOCK warnings — confirms the `return` fix works.
- Light sleep duration changed to **10 min** after validation
  (`staged.addStage(&shakePol, 600UL * 1000UL)`).

---

## 4. History — What We Tried and Why It Failed

### Approach 1: INT-pin wake with `wakeupEnabled=true` on shake detector (logs.34)

**What we tried**: Enable `SH2_SHAKE_DETECTOR` with `wakeupEnabled=true` before
`modeSleep()`. In `loop()`, poll INT pin — INT LOW while sleeping = shake event =
wake up.

**What happened**: INT pin stayed LOW continuously from the moment `modeSleep()`
was called. The SHTP transport sends an ACK pulse (INT LOW) every time a sensor
command is processed. With shake configured at 200ms intervals and wakeupEnabled,
the BNO085 drove INT LOW again almost immediately after each drain. The sleep
loop spent 9+ hours in a continuous "INT pin LOW during MIN_SLEEP_MS window —
draining to clear INT" spin, never transitioning out of the guard window.

```
[04:21:42.827] [Sleep] INT pin LOW during MIN_SLEEP_MS window (elapsed=4335ms) — draining to clear INT
[04:21:43.389] E [DEADLOCK WARNING] ...
... (repeating every 63ms for ~9 hours)
[13:11:04.152] [Sleep] INT pin LOW while sleeping (elapsed=417ms) — waking SH-2 hub
[13:11:04.278] [Sleep] reports restored — restarting BLE advertising for reconnect
```

**Root cause**: `SH2_SHAKE_DETECTOR` with `wakeupEnabled=true` sends a report at
its configured interval (~200ms) regardless of whether the device is shaking. It
is not a latched edge-triggered interrupt — it is a periodic sensor report. INT
never goes HIGH for long enough to sleep on.

---

### Approach 2: Longer guard window to absorb SHTP ACKs (logs.35)

**What we tried**: After `modeSleep()`, enter a 10-second "guard window" where
INT LOW → drain without waking. After the guard window expires, treat the next
INT LOW as a real shake wake.

**What happened**: The drain log showed 54 consecutive 0x19 (shake) events at
~196ms spacing in the first 10 seconds:

```
[00:05:03.611] [Sleep] drain[5] event=0x19 elapsed=361ms
[00:05:04.784] [Sleep] drain[11] event=0x19 elapsed=1534ms
...
[00:05:13.191] [Sleep] drain[53] event=0x19 elapsed=9746ms
[00:05:13.247] [Sleep] drain window ended (elapsed=10000ms drainCycles=54) — re-sleeping hub
[00:05:13.253] [Sleep] INT pin LOW after MIN_SLEEP_MS (elapsed=10006ms) — waking
```

Device woke immediately after the guard window because the next shake report
arrived at ~10006ms — just 6ms after the window closed. The shake detector fires
every ~196ms without pause; the guard window approach just delayed the false wake,
it didn't solve it.

**Root cause confirmed**: `SH2_SHAKE_DETECTOR` at any interval with
`wakeupEnabled=true` is a periodic sensor, not an edge sensor. There is no way
to distinguish a "real shake" from a "periodic report" via the INT pin alone.

---

### Approach 3: Guard window drain + INT-based wake after guard (logs.36, logs.37)

**What we tried**: Change shake interval to 2s to reduce ACK frequency. Keep a
shorter guard window (10s, ~6 drain cycles at ~2s each). After the guard window,
treat the first INT LOW as a real shake wake.

**What happened**: Pattern was consistent across all cycles. After guard window,
device always woke at ~11.85s (6 guard drains × ~1.95s). The "wake event=0x19"
was seen but `drained=0` — meaning the drain reported 0 events actually decoded
from FIFO, yet still triggered exit:

```
[00:05:05.353] [Sleep] BNO085 SH-2 sleep — INT=0 after modeSleep (waiting for shake)
[00:05:05.353] [Sleep] INT LOW in guard window (elapsed=125ms) — drain ACK, no re-sleep
[00:05:05.443] [Sleep] guard drain done — INT=1, hub in modeOn, waiting for real shake
[00:05:07.284] [Sleep] INT LOW in guard window (elapsed=2079ms) — drain ACK, no re-sleep
... (4 more guard drains at ~2s intervals)
[00:05:15.104] [Sleep] INT pin LOW while sleeping (elapsed=11854ms) — waking SH-2 hub
[00:05:15.159] [Sleep] wake event=0x19 drained=0
[00:05:15.161] [Sleep] wake drain: 1 cycles, INT=1 — scheduling exitSleep
```

Every sleep cycle woke after exactly ~12s regardless of user activity. Verified
across 5+ sleep cycles in logs.37.

**The actual wake trigger**: The 7th INT pulse (first one after the guard window)
was just the next periodic shake report, not a real shake. The approach could not
distinguish.

---

### Discovery: BNO085 manual — SigMotion and Shake are not always-on

Reading the BNO085 SH-2 Application Note revealed:

- **`SH2_SIGNIFICANT_MOTION`** (0x12): Requires a 5-step walking pattern with
  acceleration crossing a threshold. Designed for "user picked up and started
  walking" detection. Not "device moved" detection.

- **`SH2_SHAKE_DETECTOR`** (0x19): Documented as requiring "significant
  acceleration changes in rapid succession". In practice, sends periodic reports
  at its configured interval — the report payload indicates shake direction, but
  the report fires on schedule whether or not shaking occurred.

Neither sensor was wired up correctly for the use case: user resting wrist after
use, then picking it up and shaking to wake.

---

### Resolution: Software timer approach (logs.39 era)

Inspired by SparkFun BNO08x Example20-Sleep. Instead of depending on the INT
pin to signal a shake event, use a software timer:

1. Configure shake detector with `wakeupEnabled=false` — no INT-pin dependency
2. `modeSleep()` — hub sleeps, shake configured but not sending to MCU
3. Every 30s: software timer fires → `modeOn()` + drain FIFO for 200ms → check
   for 0x19 event → if found, full wake; else `modeSleep()` again

This completely avoids the periodic-report-as-interrupt problem. The BNO085 only
runs its fusion engine briefly during the 200ms sample window. Wake latency is
0–30s (user must shake during the sample window).

This is the approach encoded in `ShakeSleepPolicy` in `PowerManager.h`.

---

## 5. Known Limitations (RUNE-I)

**Shake detection is sampling-based.** `SH2_SHAKE_DETECTOR` does not run in
the BNO085 always-on domain during `modeSleep()`. The 30s software cycle wakes
the BNO085 and samples for 200ms. The user must be shaking during that window.
Typical wake latency: 0–30s. User should shake and hold a few seconds.

**SigMotion requires walking, not just motion.** `SH2_SIGNIFICANT_MOTION` (0x12)
uses a 5-step + acceleration pattern from the BNO085 always-on domain. It will
not fire from picking up the device or flicking a wrist — only from walking-scale
motion. Confirmed working from hardware log (stage transition + clean wake in
logs.39 session).

**nRF52840 WFE and software timer.** `waitForEvent()` uses `sd_app_evt_wait()`
which wakes on any interrupt including the FreeRTOS RTC tick (~1ms). This is
how `powerMgr.tick()` runs without a dedicated hardware timer. The `delay(10)`
in the sleep path rate-limits tick checks to ~100/s.

---

## 6. RUNE-II Direction

Push significant motion detection further onto the BNO085 always-on domain, or
evaluate adding a dedicated low-power motion interrupt source external to the
BNO085 (accelerometer with hardware wake output). Goal: true deep sleep with
sub-µA idle current on the motion sensing path, wake on genuine gross motion
only (walking, picking up device).
