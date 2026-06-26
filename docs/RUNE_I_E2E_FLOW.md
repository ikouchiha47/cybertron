# End-to-end UX trace, by code
 
Working from the user's POV, every step traced to the file/line that drives it.

1. App launch
  - index.ts → React Native registers the root component, AppNavigator.tsx:51 mounts the Tab navigator.
  - Default tab: Home = DiscoveryScreen (AppNavigator.tsx:54).
  - useBLE runs startRuntime() once (useBLE.ts:236) → instantiates ModeManager, KnobEngagement, MotionClassifier, SymbolCapture and subscribes to native BLE events.
  - MotionClassifier initial state = uncalibrated.

2. Discovery — auto-connect to last known band
  - DiscoveryScreen shows scanned bands. On tap, BLEServiceNative.connect(...) runs.
  - BLE_CONNECTED arrives (useBLE.ts:325):
    - state.connected = true, state.batteryPct = null, state.armPose = null.
    - console.log("[CAL] BLE_CONNECTED").
    - PrefsStore.getDefaultMode().then(applyMode) → restores user's default mode (KNOB/GESTURE/SYMBOL).

3. Home baseline restoration (Discovery E1)
  - DiscoveryScreen.tsx:337 — useEffect on [connected, wristAddress].
  - Reads BaselineStore.load(wristAddress):
    - Found → sendBaselineToFirmware(b) writes orientation reference to firmware. discState → WAIT_RAISED. No MC change (per your design — MC is per-session, not per-device-connect).
    - Not found (first ever connect) → setStoredBaseline(null) → triggers E2.

4. First-time-only ceremony (Discovery E2)
  - DiscoveryScreen.tsx:367 — only fires when storedBaseline === null.
  - Calls startCalibration() (useBLE.ts:649):
    - motionClassifier.reset() + startCalibration() — MC enters calibrating.
    - BLEServiceNative.setArmed(true) — firmware enables RV + sends PKT_BASELINE on stillness.
  - User does the "raise arm and hold" prompt → [GravPose] → flat → MC reaches stable → fresh baseline written by E3 to BaselineStore.
  - Subsequent app launches skip this entirely (E1 finds the saved baseline).

5. Discovery state choreography (E4–E8)
  - E4 (armPose === flat for 1s) → discState = browsing (device in arm-up posture).
  - E5 (armPose === hanging for 1.5s) → discState = wait_raised (user dropped arm).
  - E7 transitions any non-CALIBRATING state → arm device + setArmed(true).
  - E8 fires on screen focus → request fresh recal of firmware baseline.
    The user sees: a list of bands, status pills (battery, signal, posture), tap to enter a device.

6. Tap a device → enter ActiveControl
  - Stack push to ActiveControl (AppNavigator.tsx:83) with { deviceId }.
  - Mount sequence:
    - NEW: ActiveControlScreen.tsx:138-147 runs recalibrate() ([CANARY:AC_MC_ENTER]). MC fresh ceremony begins; firmware stab events drive it to stable in 1–2s.
    - MappingStore.get(deviceId, proxy.defaultMapping()) loads the user's saved gesture→action map.
    - setActiveComboMap(map) — engine's gesture rules are loaded.
    - useEffect for interactionMode:
        - GESTURE mode: setSessionBaseline(homeBaseline) — instant, no overlay.
      - KNOB mode: setSessionCalibrating(true) → overlay shows → armDevice() → requestRecalibration() → wait for fresh PKT_BASELINE → seq fence accepts it → setSessionBaseline(baseline) → overlay dismisses. Safety: 5s timeout falls back to homeBaseline.
  - User sees: device-specific control screen (e.g., bulb dial), pose indicator, calibration overlay if KNOB mode.

7. Live gesture flow
  - Firmware classifies gesture → gestureChar.notify("turn_right|gx|gy|gz|integ|peak").
  - Native module emits BLE_GESTURE; useBLE.ts:371 parses it.
  - Engagement gate (useBLE.ts:386): if armPose === HANGING AND not SHAKE → drop, log [GESTURE_DROP].
  - Snap detection (useBLE.ts:401): peakRate ≥ threshold → log [GESTURE] SNAP_DISCARD and drop.
  - Mode routing (useBLE.ts:415):
    - KNOB:
        - TAP → knobEngagement.engage(lastRawSample) (knob now active).
      - PITCH_DOWN → counted toward triple-pitch_down commit.
      - NEW: anything else → drop with [CANARY:KNOB_DROP] log (was: misrouted to engine with wrong rules).
    - SYMBOL: TAP starts capture, PITCH_DOWN finalizes, others suppressed.
    - GESTURE (else): log [GESTURE], push to engine → engine matches refractory/sequence/repeat rules → fires onCombo(action).

8. Knob ticks (only path to fire knob actions)
  - BLE_DELTA → motionClassifier.onDelta(p) (useBLE.ts:471).
  - MC must be stable or moving; classifies as wrist_rotating if pitch/yaw bleed < 2°.
  - Fires onMotion("wrist_rotating") → in KNOB mode → knobEngagement.onDelta(lastDeltaSample).
  - KnobEngagement quantizes delta → fires onTick(±1) → dispatchSyntheticCombo("knob_tick±") → engine matches → action.
  - This whole chain depended on MC being calibrated. The new ActiveControl mount-effect is what unblocks it.

9. ActiveControl auto-exit
  - ActiveControlScreen.tsx:226 — if armPose === HANGING for 2s → navigation.goBack().
  - Idle timer (line 74) closes session after configurable timeout.

10. Exit ActiveControl
  - React unmounts the screen.
  - NEW cleanup (ActiveControlScreen.tsx:144): resetMotionClassifier() ([CANARY:AC_MC_EXIT]). MC → uncalibrated. Session forgotten.
  - ble disconnect (line 89 effect cleanup) proxy.disconnect() (the smart device, not the band).
  - User returns to Discovery tab. Band still connected. Home baseline still in storage.

11. GestureMapping side path
  - From Discovery → "Map Gestures" → GestureMappingScreen (AppNavigator.tsx:82).
  - useBLE() here just reads pose, connected, lastGesture — no callbacks.
  - NEW: lastGesture is now destructured + logged so the screen visibly reflects gestures ([CANARY:GMS]).
  - User edits the per-device ComboMap, saves to MappingStore → next ActiveControl mount loads the new map.

12. Settings
  - SettingsScreen lets user reset persistent data (including stored baselines).
  - Default mode lives in PrefsStore — affects what mode ActiveControl lands in on next session.

---

Lifecycle of state, in one table

┌──────────────────────────┬──────────────────────────────┬────────────────────────────┬───────────────────────────────────────────────────────────────┐
│          State           │         Lives where          │          Lifetime          │                           Reset by                            │
├──────────────────────────┼──────────────────────────────┼────────────────────────────┼───────────────────────────────────────────────────────────────┤
│ Home baseline            │ BaselineStore (AsyncStorage) │ Persistent across reboots  │ Settings → reset                                              │
├──────────────────────────┼──────────────────────────────┼────────────────────────────┼───────────────────────────────────────────────────────────────┤
│ Firmware orientation cal │ nRF52840 RAM                 │ Per BLE session            │ requestRecalibration() (KNOB session start), or device reboot │
├──────────────────────────┼──────────────────────────────┼────────────────────────────┼───────────────────────────────────────────────────────────────┤
│ MotionClassifier state   │ RN runtime (singleton)       │ Per ActiveControl session  │ New: recalibrate() on entry, resetMotionClassifier() on exit  │
├──────────────────────────┼──────────────────────────────┼────────────────────────────┼───────────────────────────────────────────────────────────────┤
│ Session baseline         │ ActiveControlScreen useState │ Per ActiveControl mount    │ Component unmount                                             │
├──────────────────────────┼──────────────────────────────┼────────────────────────────┼───────────────────────────────────────────────────────────────┤
│ Active combo map         │ useBLE module global         │ Per setActiveComboMap call │ Next mount overwrites                                         │
├──────────────────────────┼──────────────────────────────┼────────────────────────────┼───────────────────────────────────────────────────────────────┤
│ Default mode             │ PrefsStore (AsyncStorage)    │ Persistent                 │ Settings                                                      │
└──────────────────────────┴──────────────────────────────┴────────────────────────────┴───────────────────────────────────────────────────────────────┘

That's the whole journey, end to end, as the code currently expresses it (with the fixes from this session applied). Next: install the APK and re-capture so we can verify the canaries fire in order.

---
