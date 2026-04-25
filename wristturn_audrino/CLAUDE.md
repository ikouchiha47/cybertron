# WristTurn Firmware — Claude instructions

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

### Backup sketches

- `wristturn_nrf52840.ino.bkp` — archived LSM6DS3 version (nRF52840 Sense, 6DOF)
- `wristturn_bno085.ino.bkp`   — earlier BNO085 iteration
- `wristturn.ino.bkp2`         — prior art for angle tracking / baseline logic
