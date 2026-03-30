# WristTurn Debug Guide

---

## 1. Wiring / Connection

**XIAO nRF52840 I2C pins:**
```
BNO085 SDA  → XIAO D4
BNO085 SCL  → XIAO D5
BNO085 VCC  → 3.3V
BNO085 GND  → GND
```

**Common mistakes:**
- SDA and SCL swapped → swap them and retry
- VCC connected to 5V instead of 3.3V
- Loose jumper wire on breadboard → press firmly

**Verify with blink test first** (`blink_test/blink_test.ino`) to confirm the board is alive before debugging I2C.

---

## 2. Uploading / DFU Issues

**"Timed out waiting for acknowledgement" error:**
1. Close Serial Monitor (click X on the tab) — it blocks the port
2. Double-tap the reset button on the XIAO — LED should pulse slowly
3. Switch port in Arduino IDE if needed (`usbmodem101` ↔ `usbmodem21201`)
4. Upload immediately after the LED starts pulsing

**"Bad CPU type in executable":**
- Install Rosetta 2: `softwareupdate --install-rosetta --agree-to-license`

**Board shows as "Unknown":**
- Add Seeed board URL in Preferences:
  `https://files.seeedstudio.com/arduino/package_seeeduino_boards_index.json`
- Install **Seeed nRF52 Boards** via Boards Manager

**Wrong board selected:**
- Must be `Seeed Studio XIAO nRF52840 Sense` (not MG24, not plain nRF52840)

---

## 3. Serial Monitor No Output

- Baud rate must be **115200** (bottom-right dropdown)
- Press reset button on XIAO after opening Serial Monitor to catch startup logs
- Close Serial Monitor before uploading, reopen after

---

## 4. BNO085 Not Found

**I2C scan shows `0x1` only (ghost address) or nothing:**
- Ghost address = no real device found, wiring issue
- BNO085 should appear at `0x4A` or `0x4B`
- Try swapping SDA/SCL
- Check 3.3V and GND connections

**I2C scan finds `0x4A` but `imu.begin()` fails:**
- Try calling `imu.begin(0x4A, Wire)` explicitly in the sketch

---

## 5. No Gesture Logs (IMU Connected)

**Roll value not changing:**
- Check which axis is the wrist rotation axis — may need to use pitch or yaw instead of roll depending on board orientation

**Gestures firing too easily / not enough:**
- Adjust `TURN_THRESHOLD` in `wristturn.ino`:
  - Lower (e.g. `0.3`) = more sensitive (~17°)
  - Higher (e.g. `0.6`) = less sensitive (~34°)

**Gestures firing repeatedly:**
- Increase `DEBOUNCE_MS` (default `600`)

---

## 6. BLE Not Visible

- Confirm `BLE advertising as 'WristTurn'` appears in Serial Monitor
- On iPhone/Mac use **LightBlue** or **nRF Connect** app to scan for `WristTurn`
- If not visible, check that `Bluefruit.Advertising.start(0)` is reached in setup
