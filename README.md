# WristTurn

A wrist-worn gesture controller built on the Seeed XIAO nRF52840 and BNO085 IMU.
Detects wrist motions and broadcasts them over BLE to a macOS receiver that maps
them to keyboard shortcuts — currently for switching desktops, with more actions planned.

## Hardware

- Seeed Studio XIAO nRF52840 Sense
- SparkFun BNO085 Qwiic breakout
- Connected via Qwiic/Stemma QT cable, soldered to perfboard

## Gestures

| Motion | Gesture string | Default action |
|---|---|---|
| Wrist twist right | `turn_right` | Next desktop (`Ctrl+→`) |
| Wrist twist left | `turn_left` | Previous desktop (`Ctrl+←`) |
| Wrist flex up | `pitch_up` | — |
| Wrist flex down | `pitch_down` | — |
| Forearm swing right | `yaw_right` | — |
| Forearm swing left | `yaw_left` | — |
| Shake | `shake` | — |
| Step | `step` | — |

Combos of up to 3 gestures are supported — define them in `macos_receiver.py`.

## Running

Flash `wristturn.ino` to the XIAO via Arduino IDE, then:

```bash
uv run src/wristturn/adapters/macos_receiver.py
```

Requires macOS Accessibility permission for Terminal:
System Settings → Privacy & Security → Accessibility.

## Docs

- [Architecture](architecture.md) — how motion detection, BLE, and the Python receiver work
- [Parts](PARTS.md) — hardware components
- [Production notes](PRODUCTION.md) — hardware hardening, connection options, roadmap
