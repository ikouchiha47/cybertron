# WristTurn Firmware — Claude instructions

## Hardware

| Component | Part | Notes |
|-----------|------|-------|
| MCU | Seeed XIAO nRF52840 Sense | BLE 5.0, ARM Cortex-M4, 256KB RAM, 1MB flash |
| IMU | Bosch BNO085 (SH-2) | 9-DOF fusion, rotation vector, shake/tap/step/sig-motion |
| Battery | LiPo single-cell | Managed by onboard BQ25101 charger (CHRG pin = P0.17) |
| Interface | I2C (QWIIC) | BNO085 SDA→D4, SCL→D5, addr 0x4B |
| INT pin | BNO085 → XIAO D1 (P0.03) | FALLING edge, INPUT_PULLUP. Used for WFE wake and sleep/wake detection |

**Nothing else on the board is used.** No LSM6DS3, no PDM mic (powered down in setup), no external flash.

---

## Flashing

Use the Arduino IDE or `arduino-cli`. Target board: **Seeed XIAO nRF52840 Sense**.
The active sketch is `wristturn/wristturn.ino`.

---

## Project structure

```
wristturn/
  wristturn.ino              ← main sketch: BLE setup, event loop, dispatch table
  StillnessDetector.h        ← IStillnessDetector interface + two implementations
  gesture/
    AxisDetector.h           ← per-axis FSM (IDLE → ACTIVE → DECAY → IDLE)
    GestureDetector.h        ← combines axes, fires gesture events
    GestureArbitrator.h      ← prevents conflicting gestures firing simultaneously
  shake_detector.h
  log.h
  mounting_adapter.h         ← physical mount geometry constants

  test_stillness.cpp         ← unit tests for StillnessDetector (no Arduino toolchain)
  Makefile.test              ← builds and runs tests with g++
```

### Key design points

- **Dispatch table** in `loop()` — one handler function per sensor report ID, no
  if-else chain. Adding a new sensor = new handler + one table entry.

- **IStillnessDetector** — polymorphic interface; `StabilityClassifierDetector` is
  the production implementation (uses BNO085 hardware fusion). `ManualZUPTDetector`
  is guarded with `#ifdef ENABLE_MANUAL_ZUPT` — not calibrated against real motion data,
  disabled by default.

- **Headers are self-contained** — each `.h` can be compiled with `g++` for host-side
  tests. No Arduino-specific includes inside testable headers.

### Running tests

```bash
cd wristturn
make -f Makefile.test          # StabilityClassifierDetector only (default)
make -f Makefile.test test-all # includes ManualZUPTDetector (calibration required)
```

Tests exit non-zero on failure.

### BNO08x INT pin — known library bug

The SparkFun BNO08x Cortex library (`SparkFun_BNO08x_Cortex_Based_IMU`) has a
race condition in its INT pin synchronization. When `begin()` receives an INT
pin (e.g. `imu.begin(0x4B, Wire, INT_PIN, RST_PIN)`), the library sets
`_int_pin` and then **every** `enableReport()` call invokes `hal_wait_for_int()`
**before** sending the command to the BNO08x. This means the library waits for
an INT pulse that the BNO08x will never send because it hasn't received the
command yet. After 500ms it times out, calls `hal_hardwareReset()`, and the
enable fails.

**Correct usage:** Call `imu.begin(address, Wire)` with **2 arguments only**.
This leaves `_int_pin = -1` and bypasses the broken `hal_wait_for_int()` path.
The BNO08x still works fine — I2C communication is synchronous and the INT
pin is not needed for reliable operation.

**Do NOT** pass INT/RST pins to `begin()` for this library. This was
discovered and confirmed 2026-04-27.

### Backup sketches

- `wristturn_nrf52840.ino.bkp` — archived LSM6DS3 version (nRF52840 Sense, 6DOF)
- `wristturn_bno085.ino.bkp`   — earlier BNO085 iteration
- `wristturn.ino.bkp2`         — prior art for angle tracking / baseline logic

### BNO085 modeSleep() / shake-to-wake — architecture

When `modeSleep()` puts the SH-2 hub to sleep, wake-enabled sensors (e.g.
shake detector with `wakeupEnabled=true`) continue to run internally. On a
wake event the BNO085 **asserts INT LOW**, but the SH-2 I2C transport is
suspended — `getSensorEvent()` / `sh2_service()` cannot read data until
`modeOn()` is called to wake the hub.

**Correct wake sequence** (implemented 2026-04-28):
1. Detect INT pin LOW in `loop()` while `sleeping == true`
2. Call `imu.modeOn()` + delay(50ms) to wake the SH-2 transport
3. Drain pending events from the FIFO via `getSensorEvent()` loop
4. Call `exitSleep()` to restore normal sensor reports

**Wrong approach** (the original bug): Trying to call `getSensorEvent()`
while the hub is asleep → I2C reads return nothing → shake event is never
decoded → `handleSleepShake()` never fires → device stays asleep forever.

---

## Debugging with firmware logs

Firmware logs come from the XIAO nRF52840's USB serial port (`Serial.printf` via `LOG_I`).
Capture them with a serial monitor or redirect to a file, then analyze with:

```bash
python3 tools/analyze_firmware_log.py tmp/logs.NN.txt
python3 tools/analyze_firmware_log.py tmp/logs.NN.txt --tags Cal Stab RVRate CalBuf
```

### Key log tags

| Tag | What it means |
|-----|--------------|
| `[Reports]` | `enableReports()` called; shows `armed=` and whether rotation vector was enabled |
| `[Arm]` | Device armed or disarmed by app |
| `[Stab]` | BNO085 stability class change (0=unknown,1=table,2=stationary,3=stable,4=motion) |
| `[GravPose]` | Arm pose classified (flat/hanging/raised) from rotation vector gravity projection |
| `[GravDiag]` | Rotation vector gravity diag every 50 RV samples (~1/s at 50Hz) |
| `[RVRate]` | Rotation vector call rate — every 10 samples; shows actual Hz and calBuf count |
| `[CalBuf]` | Every calBuffer.push() during calibration; shows fill progress |
| `[Cal]` | Calibration milestones: cleared / captured / confirmed |
| `[Baseline]` | App wrote a baseline to firmware |

### What to look for

**Calibration takes too long:**
1. Check `[RVRate]` — if Hz << 50, rotation vector is throttled. Expected ~50Hz.
2. Check `[CalBuf]` — if samples trickle in slowly, confirms the RV rate issue.
3. Check `[Arm]` — if armed/disarmed cycles appear, calBuffer resets each disarm.
4. Check `[Reports]` — multiple enableReports() calls can restart RV, causing startup delay.

**Normal expected flow (calibration in <1s):**
```
[Arm] armed
[Reports] rotation vector enabled   ← armed=1
[RVRate] sample=10 elapsed_10=200ms (~50Hz)  ← RV firing at 50Hz
[CalBuf] count=1/25 ...             ← filling fast
[CalBuf] count=25/25 ...            ← full after 25 samples (~500ms)
[Cal] baseline captured             ← done
```
