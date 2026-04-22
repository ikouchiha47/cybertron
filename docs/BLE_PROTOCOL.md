# WristTurn BLE Protocol

These UUIDs are a **stable contract** between firmware and app.
Do not change them without bumping the protocol version and updating both sides.

---

## Services

### Gesture Service  `19B10000-E8F2-537E-4F6C-D104768A1214`

| Characteristic | UUID | Properties | Format |
|---|---|---|---|
| Gesture | `19B10001-…1214` | Read, Notify | UTF-8 string, 40 bytes, null-padded |

#### Gesture payload formats

```
<gesture>                          — tap, shake
<gesture>|<roll>|<pitch>|<yaw>    — turn_right, turn_left, pitch_up, pitch_down, yaw_left, yaw_right
gyr|<gx>|<gy>|<gz>                — raw gyro stream (rawMode=1), rad/s
raw|<roll>|<pitch>|<yaw>          — raw orientation stream (rawMode=1), degrees
step|<count>                       — step counter
ping                               — keepalive every 3s
```

#### Gesture names

| Name | Axis | Direction |
|---|---|---|
| `turn_right` | Roll | Pronation (palm down) |
| `turn_left` | Roll | Supination (palm up) |
| `pitch_up` | Pitch | Wrist flexion |
| `pitch_down` | Pitch | Wrist extension |
| `yaw_right` | Yaw | Wrist abduction |
| `yaw_left` | Yaw | Wrist adduction |
| `tap` | — | Single tap (BNO085 tap detector) |
| `shake` | — | Shake (linear accel threshold) |

---

### Settings Service  `19B10010-E8F2-537E-4F6C-D104768A1214`

All characteristics are Read + Write, open permissions, no encryption required.

| Characteristic | UUID | Type | Default | Range | Description |
|---|---|---|---|---|---|
| Threshold | `19B10011-…1214` | float32 LE | 15.0 | 0–90 | Gesture trigger angle (degrees) |
| Debounce | `19B10012-…1214` | uint32 LE | 200 | 50–2000 | Min ms between gestures |
| Deadzone | `19B10013-…1214` | float32 LE | 5.0 | 0–threshold | Return-to-neutral zone (degrees) |
| Raw Mode | `19B10014-…1214` | uint8 | 0 | 0/1 | 0=gesture only, 1=stream raw IMU |
| Batt V Max | `19B10015-…1214` | float32 LE | 4.2 | battVMin–4.35 | Battery full voltage |
| Batt V Min | `19B10016-…1214` | float32 LE | 3.0 | 2.5–battVMax | Battery empty voltage |

---

### Battery Service  `0000180F-0000-1000-8000-00805F9B34FB` (standard BLE)

| Characteristic | UUID | Properties | Format |
|---|---|---|---|
| Battery Level | `00002A19-…34FB` | Read, Notify | uint8, 0–100 (percent) |

Updated every 30 seconds. Notifies on change only.

---

## Advertising

- Name: `WristTurn`
- Advertised services: Gesture Service, Battery Service
- TX power: −20 dBm (adequate for <2m wrist-to-device)
- Supervision timeout: 2s

---

## Hardware independence

These UUIDs are firmware-defined and hardware-agnostic. The same protocol works on:

- XIAO nRF52840 Sense + BNO085 breakout (v2/v3 prototype)
- Custom PCB: Raytac MDBT50Q + BNO085 bare chip (v4 target)
- Any future nRF52840-based revision

To make a breaking change: increment the last segment of the service UUID (e.g. `…1215`) and handle both versions in the app during transition.
