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

## 3. Known Limitations (RUNE-I)

**Shake detection is sampling-based.** `SH2_SHAKE_DETECTOR` does not run in
the BNO085 always-on domain during `modeSleep()`. The 30s software cycle wakes
the BNO085 and samples for 200ms. The user must be shaking during that window.
Typical wake latency: 0–30s. User should shake and hold a few seconds.

**SigMotion not yet validated on hardware.** `SH2_SIGNIFICANT_MOTION` (0x12)
is documented as an always-on sensor. Whether it actually asserts INT from
`modeSleep()` on this specific BNO085 revision is unconfirmed — needs a flash
and a log capture.

**nRF52840 WFE and software timer.** `waitForEvent()` uses `sd_app_evt_wait()`
which wakes on any interrupt including the FreeRTOS RTC tick (~1ms). This is
how `powerMgr.tick()` runs without a dedicated hardware timer. The `delay(10)`
in the sleep path rate-limits tick checks to ~100/s.

---

## RUNE-II Direction

Push significant motion detection further onto the BNO085 always-on domain, or
evaluate adding a dedicated low-power motion interrupt source external to the
BNO085 (accelerometer with hardware wake output). Goal: true deep sleep with
sub-µA idle current on the motion sensing path, wake on genuine gross motion
only (walking, picking up device).
