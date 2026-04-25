# Arm Aligner UX — Plan

## What & Why

The refractory period (500ms opposite-direction suppression) handles the common snap-back case.
The arm aligner adds a second layer: capture the user's "neutral arm position" at session start,
then use it to suppress gestures that fire when the arm has drifted back to that baseline angle.

This solves the case where the user holds their wrist rotated 20-40° for a while and then
relaxes — the relaxation snap fires a gesture even though refractory period has expired.

---

## Lifecycle Scope

State is **per device session** — it arms when a device is selected/connected and
clears automatically when the user exits the device (back to DiscoveryScreen) or
the device disconnects. No state persists across sessions.

---

## UX Flow

### 1. Arm (session start or re-arm)

- Triggered by: `tap` or `pitch_down` gesture (the device-selection gesture)
- Before opening the device, show a **2s circular progress overlay** on the current screen
- Text: "Hold arm steady…"
- While the 2s fills: sample the BNO085 Euler angles continuously (or at end)
- On completion: store `armBaseline = { roll, pitch, yaw }` in session state
- Proceed to open/connect the selected device

### 2. Armed State

- Session is now "armed" — gestures flow normally through GestureFilter
- At each `DECAY→IDLE` fire point (inside `GestureDetector` callback), check:
  - Current Euler angles vs `armBaseline`
  - If `|currentRoll - armBaseline.roll| < NEUTRAL_THRESHOLD_DEG` AND gesture is a roll axis gesture → suppress it
  - `NEUTRAL_THRESHOLD_DEG` = 15° (tunable)
- This check is **not continuous** — only at gesture fire time, so no polling overhead

### 3. Disarm (2s hold)

- Triggered by: user holds `pitch_down` for 2s (long-hold, not tap)
  - OR: inactivity timeout (e.g. 5 min) auto-disarms
- Show a **2s circular progress overlay** with text "Disarming…"
- On completion: clear `armBaseline`, show "Disarmed" toast
- Device stays connected — just suppresses gesture dispatch until re-armed

### 4. Re-arm

- Same flow as initial arm (tap / pitch_down → 2s fill → new baseline captured)
- Useful when user changes seated position mid-session

---

## State Machine

```
UNARMED
  → (tap or pitch_down held 2s) → [show 2s arm overlay] → ARMING
ARMING
  → (2s complete) → capture baseline → ARMED
ARMED
  → gestures flow, neutral-position suppression active
  → (pitch_down held 2s) → [show 2s disarm overlay] → DISARMING
  → (inactivity 5min) → UNARMED
DISARMING
  → (2s complete) → clear baseline → UNARMED
```

---

## Implementation Checklist

### App (React Native)

- [ ] `ArmAlignerContext` (or add to existing session state):
  - `armState: 'unarmed' | 'arming' | 'armed' | 'disarming'`
  - `baseline: { roll: number; pitch: number; yaw: number } | null`
  - `startArm()`, `confirmArm(angles)`, `startDisarm()`, `confirmDisarm()`

- [ ] `CircularProgressOverlay` component:
  - SVG arc that fills over `durationMs` (2000ms)
  - Accepts `label` prop ("Hold arm steady…" / "Disarming…")
  - Cancellable (user moves arm during fill → cancel and reset)

- [ ] Long-hold detection for `pitch_down`:
  - In `useBLE` gesture handler: if `pitch_down` fires while ARMED, start a
    `longHoldTimer` (2s); if another gesture fires before timer expires, cancel it
  - Alternatively: firmware-side long-hold detection (simpler but less flexible)

- [ ] Euler angle feed:
  - BNO085 already sends rotation vector over BLE (when not in raw mode)
  - Parse Euler angles in `useBLE` and expose via context or ref
  - Snapshot at end of ARMING 2s window → `confirmArm(currentAngles)`

- [ ] Neutral suppression in `GestureFilter.ts`:
  ```typescript
  // Add to filterGesture():
  if (baseline && ROLL_GESTURES.has(gesture)) {
    const delta = Math.abs(currentRoll - baseline.roll);
    if (delta < NEUTRAL_THRESHOLD_DEG) return false; // suppress
  }
  ```

- [ ] `ActiveControlScreen` shows arm state indicator (small icon: locked/unlocked)

### Firmware (optional — long-hold assist)

- Optionally add a long-hold gesture type (`pitch_down_hold`) to BNO085 gesture
  handler to make long-hold detection cleaner on the app side

---

## Open Questions

1. **Cancel during arming**: if the user moves arm while the 2s circle is filling,
   should we cancel and restart, or just capture whatever angle they end at?
   → Recommendation: cancel + restart (show brief "Move detected, retry" message)

2. **What counts as "neutral"**: just roll axis? or roll + pitch?
   → Start with roll only (wrist rotation is the dominant gesture axis)

3. **Inactivity timeout value**: 5 min feels right but needs testing with real use

4. **Euler source**: BNO085 rotation vector → quaternion → Euler is already in firmware;
   confirm it's being sent over BLE characteristic and parsed in app

---

## Files to Create / Modify

| File | Change |
|------|--------|
| `src/context/ArmAlignerContext.tsx` | New — arm state machine |
| `src/ui/CircularProgressOverlay.tsx` | New — 2s fill SVG component |
| `src/gestures/GestureFilter.ts` | Add neutral-position suppression |
| `src/screens/ActiveControlScreen.tsx` | Show arm state indicator + overlay |
| `src/ble/useBLE.ts` | Long-hold timer for pitch_down, euler angle feed |
