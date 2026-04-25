# Production / Hardware Notes

## Known Issues & Mitigations

### BNO085 spontaneous reset under movement
**Symptom:** `BNO085 reset – re-enabling reports.` appears in serial log when the device is moved around.
**Root cause:** Vibration loosens jumper wire contacts (breadboard prototype), causing momentary I2C glitch or VDD brownout that triggers the sensor's internal watchdog.
**Mitigations for production PCB:**
- Add a **100nF ceramic decoupling capacitor** (X5R/X7R, 10V+) between BNO085 VDD and GND, placed as close to the VDD pin as possible (< 2mm trace length).
- Add a second **10µF bulk cap** on the 3.3V rail near the sensor for low-frequency ripple from BLE TX bursts.
- Keep I2C traces short (< 10cm on PCB). Add 4.7kΩ pull-ups on SDA and SCL if not already present on the breakout board.
- Use a solid solder joint / connector instead of jumper wires — see "Better Connections" section below.

---

## Better Connections (no jumper wires)

For a wearable prototype without jumper wires, in rough order of effort:

1. **QWIIC / Stemma QT cable** — Both the SparkFun BNO085 breakout and the XIAO have Qwiic/Stemma QT connectors. A short JST-SH 4-pin cable (50mm) gives a solid, keyed connection with no loose wires. Cheapest / fastest fix.

2. **Perfboard with female pin headers** — Solder both modules to a small perfboard and run short solid-core wire between pads. Much more vibration-resistant than a breadboard.

3. **Custom PCB** — Design a small 2-layer PCB (e.g. in KiCad, EasyEDA) that hosts both the XIAO footprint and a Qwiic connector for the BNO085, with the decoupling caps built in. Services like JLCPCB do 5 copies for ~$2.

---

## Gesture Expansion Roadmap

Current gestures (roll axis only):
- `turn_right` — wrist supination > 26°
- `turn_left`  — wrist pronation  > 26°

Planned / possible additions:
- **Pitch up/down** — wrist flex/extend (bend toward palm / back of hand)
- **Yaw** — forearm rotation around vertical axis (less useful for wrist)
- **Tap** — use BNO085 tap detection report (SENSOR_REPORTID_TAP_DETECTOR)
- **Shake** — linear acceleration spike above threshold
- **Compound gestures** — e.g. tilt-then-turn as a modifier
