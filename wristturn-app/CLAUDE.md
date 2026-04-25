# WristTurn App — Claude instructions

## Android builds

Always build and install the **release** APK:

```bash
cd android && ./gradlew assembleRelease
adb install -r app/build/outputs/apk/release/app-release.apk
```

Release signing is fully configured in `android/app/build.gradle` with `my-release-key.keystore`.

**Debug builds**: only if the user explicitly asks for a debug build. Confirm with the user before proceeding — debug and release APKs have different signatures, so switching requires an `adb uninstall` first (which clears paired device data like Android TV certificates).

---

## Project structure

Current layout (flat, organic):

```
src/gestures/    ComboEngine, GestureFilter, KnobEngagement, MotionClassifier, …
src/ble/         BLEServiceNative, useBLE
src/debug/       SessionRecorder, DebugLog
src/devices/     adapters, provisioning, registry
src/discovery/   useMDNSDiscovery
src/hooks/       useBLE (legacy), useTVDiscovery
src/mapping/     MappingStore
src/tv/          androidtv
src/screens/     all UI screens
src/navigation/  AppNavigator
src/ui/          shared visual components
src/shims/       type stubs for untyped native modules
```

Target layout (not yet migrated):

```
src/core/              ← pure TypeScript, zero React / RN imports
  motion/              MotionClassifier, StillnessDetector
  gestures/            ComboEngine, GestureFilter, KnobEngagement, KnobQuantizer,
                       ModeManager, SymbolCapture, HoldDetector, recognizer/
  sensors/
    ISensorSource.ts   ← the seam: core never imports BLE or RN

src/infrastructure/    ← React Native + BLE, not unit-testable in isolation
  BLEServiceNative.ts
  BLESensorSource.ts   ← implements ISensorSource

src/replay/            ← implements ISensorSource from recorded session files
  ReplaySensorSource.ts
  SessionPlayer.ts

src/hooks/             ← thin React layer, no business logic
  useBLE.ts            ← subscribes to ISensorSource, forwards to core

src/screens/           ← display state, capture input, no business logic
src/navigation/        AppNavigator — screen registry and route types
src/ui/                shared stateless visual components
```

`ISensorSource` is the target seam. Swap `BLESensorSource` for `ReplaySensorSource`
to replay any recorded session through core logic — no device, no UI needed.

Tests run with a single command and exit non-zero on failure:

```bash
make test   # runs all core unit tests via Bun
```

---

## UI layer

Screens display state and capture input. No business logic lives here.
Data comes from `useBLE` — screens never import from `src/core/` directly.

Navigation is two-level (`src/navigation/AppNavigator.tsx`):

```
Tabs (bottom bar)
  Home      → DiscoveryScreen     device list, connect/disconnect
  Settings  → SettingsScreen      BLE + app preferences
  Logs      → LogsScreen          debug event stream
  Sessions  → SessionScreen       recorded session list + playback

Stack (pushed over tabs)
  GestureMapping  ← { deviceId }  per-device combo → command map
  ActiveControl   ← { deviceId }  live gesture feedback
  Pairing         ← { deviceId }  BLE pairing ceremony
  WizProvision                    add a Wiz smart bulb

Overlay (rendered above stack)
  CalibrationOverlay              shown on connect; dismisses when motionState === "stable"
```

Rules:
- Screens read `motionState`, `interactionMode`, `knobEngaged`, `symbolCapturing`
  from `useBLE`. They do not drive those values.
- New screens go in `RootStackParams` / `TabParams` in `AppNavigator.tsx` first.
- `src/ui/` holds shared visual components — keep them stateless and prop-driven.
