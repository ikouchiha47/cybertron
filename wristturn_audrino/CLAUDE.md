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

Target board: **Seeed XIAO nRF52840 Sense** (FQBN `Seeeduino:nrf52:xiaonRF52840Sense`).
The active sketch is `wristturn/wristturn.ino`.

```bash
cd wristturn_audrino
make build      # compile + produce firmware.uf2 and wristturn/firmware.hex
make flash      # build + drag-drop to /Volumes/XIAO-SENSE (double-tap reset first)
```

`firmware.uf2` at the repo root is the committed snapshot of the most recent build —
refresh it with `make build` whenever the sketch is updated.

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

---

## C++ coding conventions

The firmware runs two execution contexts:

1. **Main task** — `setup()` and `loop()`, the Arduino sketch.
2. **Bluefruit / SoftDevice task** — every BLE callback (`connect_callback`, `disconnect_callback`, `onWrite`, `onCccd`, …) runs on a separate FreeRTOS task scheduled by the SoftDevice.

Anything touched by both is **shared mutable state across tasks**. Treat it that way.

### Rules

1. **Tag every cross-task variable.** Any global written by a BLE callback and read by `loop()` (or vice versa) must be `volatile`. Examples in this codebase: `armed`, `sleeping`, `calInProgress`, `baselineCaptured`, `currentMode`, `lastActivityMs`. Without `volatile` the compiler is free to cache the value in a register and never re-read it (`while (!armed) {}` becomes an infinite loop in `-O2`).

2. **Single-task locals stay plain.** `static` locals inside `loop()` (e.g. `loopIter`, `lastLoggedState`, `lastHbMs` in the heartbeat block) are only touched by the main task — no `volatile` needed. Document this with a one-line comment if the file also handles cross-task state, so the next reader doesn't have to derive it.

3. **`volatile` is not atomicity.** It guarantees the load/store isn't elided or reordered by the compiler — it does **not** guarantee a multi-step read-modify-write is uninterruptible. For counters incremented from both tasks, or for multi-field invariants, use a critical section (`taskENTER_CRITICAL()` / `taskEXIT_CRITICAL()` under FreeRTOS, or `noInterrupts()/interrupts()` for ISR-shared state).

4. **Aligned 32-bit reads/stores are atomic on Cortex-M4 — but only single-word.** `bool`, `uint8_t`, `uint32_t`, and pointers won't tear. Anything wider (`uint64_t`, structs, strings) can. If you log or copy a multi-field snapshot from the other task, expect transient inconsistency — fine for logs, not fine for control decisions.

5. **Check return values.** Every `imu.enableReport(...)`, `Bluefruit.begin(...)`, `Wire.endTransmission()` returns success/failure. Discarding the result is a Power-of-10 Rule 7 violation. Either act on it or log it with a tag.

6. **Bound every wait.** `Bluefruit.waitForEvent()` and similar must have an upper bound or sit behind the hardware watchdog. The 8s WDT is the backstop — don't rely on it as the primary mechanism.

7. **Assert on invariants** (Power-of-10 Rule 5). Use a `LOG_E` + safe fallback rather than `assert()` (which would halt). Density target: at least one assertion per non-trivial function.

8. **Bounded loops** (Power-of-10 Rule 2). Every `while`/`for` must have a statically provable upper bound or an explicit iteration cap with a logged break. Drain loops on the BNO08x FIFO are a common offender — cap at e.g. 32 events per pass.

9. **No dynamic allocation on hot paths.** No `new`, no `malloc`, no STL containers that allocate (`std::vector`, `std::string`). Fixed-size buffers only. Allocation in `setup()` is fine; allocation in `loop()` or any callback is not.

10. **Pedantic warnings on** (Power-of-10 Rule 10). Build with `-Wall -Wextra -Wpedantic -Wshadow -Wconversion`. Treat warnings as bugs. `if constexpr` requires `-std=c++17` — Arduino IDE default is gnu++11, so plain `if (CONSTEXPR_BOOL)` with a `static constexpr bool` is the portable form (the dead branch still folds).

### Tools — what helps, what doesn't

- **No `go -race` equivalent for nRF52.** ThreadSanitizer / Helgrind / DRD all need host runtime — won't fit in 256 KB RAM and aren't supported by the Cortex-M4 toolchain.
- **Host-side TSan is reachable** for any pure-C++ logic factored out of Arduino headers. The `wristturn/Makefile.test` host harness already builds `StillnessDetector` with `g++` — adding `-fsanitize=thread` to a host build would catch races in classifier/state-machine code if we ever spawn host-side threads to exercise them. Today everything runs single-threaded in tests, so TSan would find nothing.
- **Static checkers**: `clang-tidy` with `concurrency-*`, `bugprone-*`, `cert-*` checks runs on Arduino sources directly. `cppcheck --enable=all` is lighter and catches missing `volatile` on globals touched from ISRs in many cases. Either is worth wiring into CI.
- **Compile-time concurrency annotations**: Clang's `-Wthread-safety` plus `__attribute__((guarded_by(...)))` lets you annotate which mutex protects each variable and have the compiler enforce it. Heavier than this codebase needs today, but the right answer if cross-task state grows.

### Future work — atomics and a small concurrency primitive

When the cross-task variable count grows past a handful, replace ad-hoc `volatile` with a thin wrapper:

```cpp
// Future: drop-in for cross-task scalars. Documents intent and centralizes
// the memory-order story so we don't relitigate it per call site.
template <typename T>
class Atomic {
  static_assert(sizeof(T) <= 4, "Cortex-M4 atomic single-word only");
  volatile T v_;
public:
  T  load()  const { return v_; }            // atomic on aligned 32-bit
  void store(T x)  { v_ = x; }
  // No fetch_add / CAS yet — add via __atomic_* builtins when needed.
};
```

Or, once a build switches to `-std=c++17` consistently, just `std::atomic<bool>` / `std::atomic<uint32_t>` from `<atomic>` — the GCC ARM port lowers these to `LDREX/STREX` on Cortex-M4, no library needed for word-sized types.

Trigger to do this work: the next time we add a cross-task variable, OR the next time a race is suspected (symptom: stale read of `armed`, `sleeping`, or similar — heartbeat shows one value, behaviour reflects another).
