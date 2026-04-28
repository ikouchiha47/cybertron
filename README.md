# WristTurn

A wrist-worn gesture controller. The BNO085 IMU on a XIAO nRF52840 detects wrist
motion, broadcasts gestures over BLE to a React Native Android app, which maps them
to actions on paired smart devices (Android TV, Mac, Wiz lights, etc.).

---

## Hardware

| Component | Part |
|-----------|------|
| MCU | Seeed XIAO nRF52840 Sense |
| IMU | BNO085 (9-DOF, onboard fusion) |
| Connection | Qwiic / I2C |
| Power | USB-C or 3.7V LiPo |

The BNO085 outputs a rotation vector (quaternion) at ~100Hz. Firmware converts this
to Euler angles, runs gesture detection, and notifies the phone over BLE GATT.

---

## Repository layout

```
wristturn_audrino/       firmware (Arduino, XIAO nRF52840)
wristturn-app/           React Native app (Android)
writstturn_adapter/      Mac daemon — receives BLE events, fires keystrokes
docs/                    design iterations, case renders
architecture.md          deep-dive on firmware signal pipeline and BLE protocol
```

---

## UX flow

### 1. First open / new session

1. User puts device on wrist and opens the app.
2. App scans for `"WristTurn"` over BLE and connects.
3. **Arm baseline calibration**: app prompts "raise your arm to your natural
   browse position and hold". User raises arm; after 1s of stability, the current
   wrist orientation is captured as the **arm baseline**. This baseline is recomputed
   every session.
4. App moves to the **Discovery screen**.

### 2. Discovery (browse mode)

- **Raise arm near baseline** → device enters **browse mode** (arm is up, user
  is pointing at/scanning devices in the environment).
- **Rotate wrist** (roll left / right) → cycles through discovered devices in the
  UI list.
- **Pitch down** or **tap** → connects to the highlighted device. App moves to
  the **Active session screen**.
- **Lower arm** → exits browse mode, arm rests, device stays awake.

### 3. Active session (device control)

1. Brief calibration on connect: device needs ~1s stable reading to zero the
   gesture baseline. A calibration overlay shows and dismisses automatically when
   stable.
2. Gestures are mapped to device actions via the combo engine:
   - `turn_right` / `turn_left` — primary navigation (next/prev, volume up/down, etc.)
   - `pitch_up` / `pitch_down` — secondary navigation (scroll, seek)
   - `tap` — select / confirm
   - `tap,tap` — combo (device-specific, e.g. Netflix shortcut on Android TV)
3. **Shake** = back / disconnect:
   - While controlling a device → disconnect, return to Discovery browse mode
   - While in browse mode → exit browse, return to idle Discovery, prepare for sleep

### 4. Sleep and wake

- **Sleep trigger**: no activity (no gestures, no arm raise) for 1–5 minutes
  (configurable). Device powers down BLE advertising; app marks as sleeping.
- **Wake trigger**: any wrist motion wakes the device. BLE reconnects automatically.
- After wake: raise arm near baseline → browse mode resumes from step 2.

### 5. Gesture semantics

| Gesture | Meaning |
|---------|---------|
| `turn_right` | Forward / next / volume up |
| `turn_left` | Back / previous / volume down |
| `pitch_down` | Select / confirm |
| `pitch_up` | Context up |
| `tap` | Click / primary action |
| `shake` | Back / disconnect / cancel |
| `tap,tap` | Secondary action (device-specific combo) |
| `tap,tap,tap` | Mode switch: gesture → knob → symbol → gesture |

**Deliberate reverse vs snap-back**: a return motion immediately after a gesture
(wrist snapping back to neutral) is not counted as a separate gesture in the
opposite direction. The gesture filter distinguishes ballistic returns (snap-back)
from deliberate turns.

---

## BLE protocol

See `architecture.md` for the full GATT service layout, characteristic UUIDs,
MTU negotiation, ping/keepalive, and zombie-connection handling.

Quick reference:

| Characteristic | UUID suffix | Direction | Content |
|----------------|-------------|-----------|---------|
| gestureChar | `...0001` | notify | gesture string, e.g. `"turn_right"` |
| stateChar | `...0002` | notify | JSON, e.g. `{"evt":"stab","s":3}` |
| baselineChar | `...0003` | notify | baseline Euler on arm-command |
| rawModeChar | `...0004` | write | `0x01` = enable raw Euler stream |
| batteryChar | `2A19` | notify | battery % (0–100) |
| settingsChar | `...0010` | write | JSON settings (debounce, etc.) |

---

## Interaction modes (planned)

The gesture mode above is live. Two additional modes are planned (see plan file):

- **Knob mode** — continuous rotary dial. `tap` to engage, rotate for incremental
  ticks (volume/scrub), `pitch_down_hold` to commit, quick `pitch_down` to cancel.
- **Symbol mode** — air-drawn shapes ($P point-cloud recognizer). `tap` to start
  drawing, `pitch_down_hold` to classify and dispatch.

Triple-tap (`tap,tap,tap`) cycles through modes.

---

## Build

### Firmware

```bash
# Flash with Arduino IDE or:
arduino-cli compile --fqbn Seeed.nrf52:Seeed_nRF52840_Sense wristturn_audrino/wristturn/wristturn.ino
arduino-cli upload  --fqbn Seeed.nrf52:Seeed_nRF52840_Sense --port /dev/cu.usbmodemXXXX
```

Unit tests (no device required):
```bash
cd wristturn_audrino/wristturn
make -f Makefile.test
```

### App

```bash
cd wristturn-app
npm install
npx react-native run-android
```

### Mac adapter

```bash
cd writstturn_adapter
pip install -e .
wristturn-adapter
```
