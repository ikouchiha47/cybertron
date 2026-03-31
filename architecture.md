# WristTurn Architecture

## Overview

WristTurn is a wrist-worn gesture controller. The BNO085 IMU detects wrist rotation,
the XIAO nRF52840 processes it and broadcasts the gesture over BLE, and a macOS
Python script receives it and fires keyboard shortcuts.

```
┌─────────────────────────────────────────────────┐
│  Wrist Device (hardware)                        │
│                                                 │
│  BNO085 IMU ──I2C──► XIAO nRF52840             │
│  (quaternion)         (gesture logic + BLE TX)  │
└──────────────────────────────┬──────────────────┘
                               │ BLE Notify
                               │ UUID: 19B10001-...
                               ▼
┌─────────────────────────────────────────────────┐
│  macOS (software)                               │
│                                                 │
│  macos_receiver.py                              │
│  bleak (BLE) ──► gesture string ──► pyautogui  │
│                                    (keystrokes) │
└─────────────────────────────────────────────────┘
```

---

## Hardware Layer

**BNO085** (SparkFun Qwiic breakout)
- 9-DOF IMU with onboard sensor fusion
- Outputs a rotation vector as a quaternion (w, x, y, z) at ~100Hz
- Connected to XIAO via Qwiic/Stemma QT cable over I2C

**XIAO nRF52840 Sense**
- Nordic nRF52840 SoC: ARM Cortex-M4 + BLE 5.0 radio
- Runs the Arduino firmware
- Powered via USB-C or 3.7V LiPo battery

**Connection:** Qwiic JST-SH 4-pin cable (VCC / GND / SDA / SCL). Soldered to a perfboard for vibration resistance.

---

## Firmware Layer (`wristturn.ino`)

### Step 1 — Physical motion to raw signal

The BNO085 contains a 3-axis accelerometer, gyroscope, and magnetometer. Its onboard
processor fuses all three at ~100Hz and outputs a **rotation vector** — a quaternion
`(w, x, y, z)` representing the absolute orientation of the board in 3D space.

This is what arrives over I2C every ~10ms:
```
w=0.978  x=0.012  y=-0.034  z=0.203
```
A quaternion has no drift (unlike raw gyro integration) and no gimbal lock (unlike
Euler angles), which is why the BNO085's fusion output is used directly rather than
raw accelerometer/gyro data.

### Step 2 — Quaternion to human-readable angles

The firmware converts the quaternion into three Euler angles, each describing one
axis of wrist motion:

```
Roll  = atan2( 2(wx + yz),  1 - 2(x² + y²) )   ← wrist twist L/R
Pitch = asin(  2(wy - zx) )                      ← wrist flex up/down
Yaw   = atan2( 2(wz + xy),  1 - 2(y² + z²) )   ← forearm swing L/R
```

All three are logged every frame in degrees:
```
roll=12.3  pitch=-5.1  yaw=88.4  delta=0.0
```

Only **roll** is used for gesture detection — it directly maps to wrist
supination (palm up) and pronation (palm down).

### Step 3 — Gesture detection

The firmware uses a **delta from baseline** approach rather than absolute angle,
so the device works regardless of how the wrist is resting at startup.

```
On first frame:
    baseRoll = roll          ← capture resting position

Every frame:
    delta = roll - baseRoll

    if |delta| > 0.45 rad (~26°)
    and time since last gesture > 600ms:
        if delta > 0 → gesture = "turn_right"   (supination)
        if delta < 0 → gesture = "turn_left"    (pronation)
        baseRoll = roll      ← reset so next gesture is relative to here
```

The 600ms debounce prevents the same gesture firing repeatedly while the wrist
is held in the turned position.

### Step 4 — BLE transmission

On gesture, the firmware sends a **BLE Notify** packet — a push from device to
host with no polling needed.

```
gestureChar.notify("turn_right\0\0\0\0\0\0\0\0\0\0", 20)
```

- Fixed 20-byte payload, null-padded
- BLE characteristic UUID: `19B10001-E8F2-537E-4F6C-D104768A1214`
- Only sent on gesture events — idle wrist generates zero BLE traffic

BLE stack used: Adafruit Bluefruit (built into Seeed nRF52840 board package).
The device advertises as `"WristTurn"` and auto-restarts advertising on disconnect.

| | UUID |
|---|---|
| Service | `19B10000-E8F2-537E-4F6C-D104768A1214` |
| Gesture characteristic | `19B10001-E8F2-537E-4F6C-D104768A1214` |

---

## Software Layer (`macos_receiver.py`)

### Step 5 — BLE discovery and subscription

```python
device = await BleakScanner.find_device_by_name("WristTurn")
async with BleakClient(device) as client:
    await client.start_notify(GESTURE_CHAR_UUID, on_gesture)
```

`start_notify` tells the OS BLE stack to call `on_gesture` whenever the device
sends a notify packet on that characteristic. No polling — the callback fires
only when a gesture arrives.

### Step 6 — Decode and act

```python
def on_gesture(_, data: bytearray):
    gesture = data.decode("utf-8").rstrip("\x00 ")  # strip null padding
    ACTION.get(gesture)()                           # fire hotkey
```

The 20-byte payload is decoded from UTF-8 and null bytes are stripped, giving
a clean string like `"turn_right"`. This is looked up in the action table:

| Gesture string | Hotkey | Effect |
|---|---|---|
| `turn_right` | `Ctrl + →` | Next macOS desktop |
| `turn_left` | `Ctrl + ←` | Previous macOS desktop |

`pyautogui.hotkey()` injects the keystroke via the macOS Accessibility API.
This requires Terminal (or the Python process) to be granted Accessibility
permission in System Settings → Privacy & Security → Accessibility.

---

## Data flow summary

```
Physical motion (wrist twist)
  → BNO085: accelerometer + gyro + magnetometer sampled at ~100Hz
    → BNO085 onboard fusion: quaternion (w, x, y, z)
      → I2C to XIAO every ~10ms
        → firmware: quaternion → roll angle → delta from baseline
          → threshold crossed + debounce passed
            → BLE Notify: "turn_right" or "turn_left" (20 bytes)
              → macOS bleak: on_gesture() callback
                → decode bytes → gesture string
                  → pyautogui: Ctrl+Arrow
                    → macOS: desktop switch
```

---

## BLE Protocol Stack (GATT)

BLE communication is layered. From bottom to top:

```
Physical Radio (2.4GHz)
  → Link Layer       — connection intervals, supervision timeout
    → L2CAP          — logical channels
      → ATT           — Attribute Protocol (read/write raw attributes)
        → GATT        — Generic Attribute Profile (structure on top of ATT)
          → Application (gesture strings)
```

**GATT** defines how data is organised between a server and a client:

- **Server** = the nRF52840. Exposes a tree of **Services** → **Characteristics**.
  - `Service 19B10000-...` — the WristTurn service namespace
  - `Characteristic 19B10001-...` — the gesture value. Supports `READ` (pull) and `NOTIFY` (push).
- **Client** = the Android app. Subscribes to notifications on the characteristic via a GATT connection.

**NOTIFY** is how gestures are pushed: the nRF calls `gestureChar.notify(buf, 40)` and the phone's callback fires instantly — no polling.

### Connection lifecycle

```
nRF advertising  ←──── phone scans ────── connects ──── subscribes to NOTIFY
                                              │
                                         GATT connection open
                                              │
                                    phone sends connection events
                                    every 7.5–15ms (conn interval)
                                              │
                           app force-killed ──┘
                                              │
                          Android OS holds GATT connection open
                          (does NOT send disconnect to nRF)
                                              │
                          supervision timeout expires (2s)
                                              │
                          nRF declares connection dead → onDisconnect()
                          → Bluefruit.Advertising.start(0)
                          → nRF visible to scanners again
```

### Why Android holds the GATT connection after force-kill

Android's Bluetooth stack runs in a system service (`bluetooth.default`), separate from the app process. When the app is force-killed from recents, the GATT connection is owned by the system process and **stays open indefinitely** — Android continues sending BLE link-layer keepalive packets on behalf of the dead app. The nRF52840 never sees a disconnect event.

This means:
- The supervision timeout on the nRF never fires (the connection looks healthy from the hardware's view)
- The nRF never restarts advertising
- When the app relaunches and scans, it finds nothing — the device is "connected" to a zombie

**How WristTurn solves this — two-layer fix:**

**Layer 1 — Firmware keepalive ping (nRF side)**

Every 3 seconds while connected, the firmware sends a `"ping"` BLE notify:
```cpp
if (Bluefruit.Periph.connected() && millis() - lastPingMs > 3000) {
  lastPingMs = millis();
  gestureChar.notify("ping", 4);
}
```
When the app is dead, Android's BLE stack cannot deliver the notification to any callback. After a few failed deliveries, the OS drops the GATT connection — the nRF fires `onDisconnect` (reason `0x13` = remote user terminated) and immediately restarts advertising. In testing this resolves the zombie connection within ~8 seconds of the app being force-killed.

**Layer 2 — Direct reconnect by cached MAC (app side)**

On relaunch, instead of scanning (which would find nothing if the nRF is still in zombie-connected state), the app tries to connect directly using the last known device MAC address stored in `AsyncStorage`:
```ts
const lastId = await AsyncStorage.getItem("@wristturn/lastDeviceId");
await manager.cancelDeviceConnection(lastId);   // evict zombie
const d = await manager.connectToDevice(lastId, { timeout: 5000 });
await d.discoverAllServicesAndCharacteristics();
monitorDevice(d);
```
`connectToDevice` by MAC bypasses scanning — Android attaches to the existing or newly advertised GATT connection for that address. `cancelDeviceConnection` first evicts any zombie handle. If direct connect fails (new device, first boot), it falls back to a normal scan.

---

## What is a quaternion?

A quaternion is a set of 4 numbers `(w, x, y, z)` that represent a 3D rotation
without any of the problems that come with plain angles.

The naive way to represent orientation is three angles: roll, pitch, yaw. The
problem is called **gimbal lock** — when two axes line up, you lose a degree of
freedom and rotations become ambiguous. Quaternions avoid this entirely.

You can think of a quaternion as:
- `w` — how much "no rotation" there is (1 = identity, pointing straight)
- `x, y, z` — the axis of rotation, scaled by how far you've rotated

The BNO085's onboard fusion processor outputs a quaternion ~100 times per second.
To get a single human-readable angle (e.g. "how far has the wrist twisted"), you
project it onto one axis using trig. There is no simpler way — the formulas are
the standard conversion from quaternion to Euler angles:

```
roll  = atan2( 2(wx + yz),  1 - 2(x² + y²) )
pitch = asin(  2(wy - zx) )
yaw   = atan2( 2(wz + xy),  1 - 2(y² + z²) )
```

`atan2` and `asin` are just inverses of sin/cos — they turn a ratio back into an
angle. The 2× terms come from the quaternion multiplication rules.

---

## Motion types supported by BNO085

| Motion | Report ID | Gesture strings | Notes |
|---|---|---|---|
| Roll | `ROTATION_VECTOR` | `turn_left`, `turn_right` | Wrist twist, active |
| Pitch | `ROTATION_VECTOR` | `pitch_up`, `pitch_down` | Wrist flex/extend, active |
| Yaw | `ROTATION_VECTOR` | `yaw_left`, `yaw_right` | Forearm swing, active |
| Tap | `TAP_DETECTOR` | `tap` | Sharp tap on board, active |
| Step count | `STEP_COUNTER` | `step` | Walking steps, active |
| Shake | `SHAKE_DETECTOR` | — | Not in SparkFun library, unavailable |
| Stability | `STABILITY_CLASSIFIER` | — | On table / in hand / moving, planned |
| Linear accel | `LINEAR_ACCELERATION` | — | Movement with gravity removed, planned |

---

## Roadmap / Vision

WristTurn is intended to grow into a full wrist-worn controller. Planned additions:

**Sensors**
- LiDAR — distance/proximity detection (e.g. finger pointing at surface)
- GPS — location context for gesture actions
- Heart rate / SpO2

**Gestures**
- Tap and double-tap via `TAP_DETECTOR`
- Combo gestures — sequences of up to 3 motions within a time window (implemented on Python side)

**Platform**
- Custom PCB with all components (no perfboard)
- LiPo battery + TP4056 charging
- Wireless OTA firmware updates
