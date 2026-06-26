# RUNE

Control smart devices at a distance using gestures. One can control tv, smart bulbs, smart plug.
It is also possible to run a client on other devices, and map gestures to actions. This allows switching between desktops or screens and monitors.

It's like an universal air-mouse. I mean you dont need an accent to control a smart device. (alexa :wink: :wink:)

> Caution: Your grandma might start dancing to chammak challo.

The initial version of this app uses a 9-axis DOF to handle only gesture based recognisiton.
The whole system has been divided into two parts.

- The device firmware is responsible for gesture segmentation and handling events sent from the client.
- The mobile application is the client which acts as a bridge between: `gesture - device + execution`

This has been done, because it allows:
- Quickly experimenting with matching algorithms, (cpp is not my forte rn, and I aint trusting an llm with things i d k)
- Running some AI or pattern matching system, reduce complex operations to reduce battery consumption and heating.
- Deaing with optimizations for space and stuff.

However as a con, the device needs to be able to be connected to BLE. And that's not great, especially on a bare, `nRF52840`

Delivery Targets:

|-------|---------------|
| **RUNE-I** |  Might just ship to real users with this. Needing the mobile device reachable. Have OTA updates. |
| **RUNE-II** | Push more of computation and device storage stuff on device or an added memory module. OTA and APP updates |
| **RUNE-III** | Complex gestures, or DMT running either in firmware or on device. Might split it into `3A` and `3B` |
| **RUNE-IV** | Custom PCB with a lower profile and maybe an IR transmitter receiver|
| **RUNE-V** | Introducing EMG pads to enable |

---

## Memory — non-negotiable

**Using `/huh` is not optional.** Every session costs tokens. Every compaction loses precision. Memory is how we solve both.

Before reading any large file, run `/huh search-path <path>`. If a fresh summary exists, use it — do not open the file.

After reading a file you had to open, run `/huh index <path>` to generate a semantic summary and save it. This pays for itself the next session.

After anything works, breaks through, or represents a milestone — run `/huh changelog finally-works` or `/huh changelog milestone`. These feed the consolidation chain that builds long-term architectural understanding.

The layers:
- **L0 (1 day)** — raw observations, written automatically by hooks on every Read/Write
- **L1 (1 week)** — session summaries, consolidated from L0 automatically on SessionEnd
- **L2 (1 month)** — topic clusters, promoted from L1 by `huh reflect`
- **L3 (permanent)** — corrections, hard facts, architectural constraints that must never be forgotten

Run `/huh tree` at the start of a session to see what's indexed and what isn't. Unindexed files are token debt.

---

## Dev cycle

Applies to all components: firmware, app (frontend/core), adapter (backend), hardware.

1. **Understand the problem in the real world first.** What does a real user actually
   do? What are the physical constraints, edge cases, failure modes? Write those down
   before writing any code.

2. **Identify what changes.** Before designing, find the seams — parts of the system
   likely to be swapped, tuned, or replaced. Those become interfaces. Everything else
   is an implementation detail.

3. **Read the library before assuming.** Check what the SDK/library actually provides
   before inventing an API. Don't assume method names, event shapes, or capabilities.

4. **Write tests first.** Tests describe real scenarios — not synthetic inputs chosen
   to make things pass. A test that only passes because you picked convenient numbers
   is not a test.

5. **Confirm tests fail** before implementing. If they pass with no implementation,
   the test is wrong.

6. **Implement** to make the tests pass. No more, no less.

7. **Re-run tests.** For refactors: results must be identical before and after.
   For new features: all previous tests still pass.

8. **Analyze failures honestly.** A failing test is information. Don't adjust the
   test to match the implementation. Fix the understanding or the code.

---

## Interfaces and substitutability (Liskov)

Every interface seam must be fully substitutable — swapping one implementation for
another must not require changes to the code that depends on it.

If a constant or threshold is not validated against real-world data, it is not
production ready. Guard it, disable it by default, document why it's unvalidated.

---

## Separation of concerns

- **Core logic**: pure, no framework imports, no hardware dependencies. Testable
  with plain Node/Bun/C++ without a device or UI.
- **Infrastructure**: hardware drivers, BLE, native modules. Thin — delegates to core.
- **UI**: displays state, captures input. No business logic.

Dependencies point inward: UI → core, infrastructure → core. Core knows nothing
about UI or infrastructure.

---

## Test harness

No framework required. Same pattern across firmware (C++) and app (TypeScript):
named test, PASS/FAIL per test, assertion detail on failure, summary at end.
Tests run with a single command and exit non-zero on failure so CI can gate on them.

---

## Allowed dependencies

Avoid adding dependencies. When something is genuinely needed, stay within the
allowlist below. Anything outside this list requires an explicit decision documented
in the component's README before it's added.

### Firmware (`wristturn_audrino/`)
- Arduino core for ESP32
- NimBLE-Arduino (BLE)
- Adafruit BNO08x (IMU)
- Standard C++17. No STL containers that allocate on hot paths.

### React Native app (`wristturn-app/`)
- React Native core + React
- React Navigation (stack + bottom-tabs)
- `@react-native-async-storage/async-storage`
- `react-native-vector-icons`
- `react-native-safe-area-context`
- `react-native-ble-plx` (via native bridge)
- `react-native-zeroconf` (mDNS)
- **RxJS** — for event-sequence modeling in core state machines and tests
- Native modules authored in this repo (`modules/androidtv`, etc.)

### Adapter / backend (`wristturn-adapter/`, if/when present)
- Bun runtime
- Standard library + Bun APIs

### Tests
- Test harness is hand-rolled per `Test harness` section above.
- RxJS marble testing is permitted for app-side state machines.
- No Jest, no Mocha, no Vitest unless explicitly added to this list.

