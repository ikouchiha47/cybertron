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

**BNO085 not found after DFU upload / reset (I2C bus lockup):**

DFU upload or a sudden reset can interrupt an in-flight I2C transaction, leaving
the BNO085 holding SDA low indefinitely. The bus appears dead — scan finds nothing.

This is covered by **NXP UM10204 §3.1.16 "Bus Clear"** (the official I2C spec):
send 9 SCL clock pulses to force the stuck slave to release SDA, then issue a
STOP condition to reset bus state.

The firmware already does this automatically in `setup()` before `Wire.begin()`.
If you are writing a new sketch and hit this issue, add before `Wire.begin()`:

```cpp
Wire.end();
pinMode(PIN_WIRE_SDA, OUTPUT); pinMode(PIN_WIRE_SCL, OUTPUT);
// STOP condition
digitalWrite(PIN_WIRE_SDA, LOW);  delayMicroseconds(20);
digitalWrite(PIN_WIRE_SCL, HIGH); delayMicroseconds(20);
digitalWrite(PIN_WIRE_SDA, HIGH); delayMicroseconds(20);
// 9 clock pulses
pinMode(PIN_WIRE_SDA, INPUT_PULLUP);
for (int i = 0; i < 9; i++) {
  digitalWrite(PIN_WIRE_SCL, LOW);  delayMicroseconds(20);
  digitalWrite(PIN_WIRE_SCL, HIGH); delayMicroseconds(20);
}
// Final STOP
pinMode(PIN_WIRE_SDA, OUTPUT);
digitalWrite(PIN_WIRE_SDA, LOW);  delayMicroseconds(20);
digitalWrite(PIN_WIRE_SCL, HIGH); delayMicroseconds(20);
digitalWrite(PIN_WIRE_SDA, HIGH); delayMicroseconds(20);
delay(50);
Wire.begin();
delay(100);
```

Source: https://www.nxp.com/docs/en/user-guide/UM10204.pdf

---

## 7. Sleep / Wake (Firmware)

The firmware enters light sleep after 5 minutes of inactivity (no BLE connection,
no gestures). During sleep:
- All high-frequency IMU reports are disabled
- `SH2_SIGNIFICANT_MOTION` (sensor ID `0x12`) is armed on the BNO085 — a
  hardware one-shot detector that fires when the BNO085 detects a clear limb
  movement. Source: BNO085 datasheet §3.4 / SH-2 Reference Manual
- BLE advertising continues at a slow interval (~2–3s) so the phone can still
  find the device and the SoftDevice generates events to periodically wake the
  nRF52840 CPU to poll the IMU

**Why slow advertising instead of stopping completely:**
The BNO085 INT pin is not wired to the nRF52840 in the current hardware.
Without an INT-pin GPIO interrupt, `waitForEvent()` would sleep the CPU
indefinitely with no way to poll the IMU. Slow advertising keeps the SoftDevice
alive, which wakes the CPU every ~2s to check for sensor events.

**Hardware fix (next revision):**
Wire BNO085 INT pin → XIAO D1 (nRF52840 P0.03), then add in setup():
```cpp
pinMode(1, INPUT_PULLUP);
attachInterrupt(digitalPinToInterrupt(1), [](){}, FALLING);
```
Then `enterSleep()` can call `Bluefruit.Advertising.stop()` cleanly, and
`waitForEvent()` will wake on the BNO085 interrupt instead.

**Known issue with 7Semi BNO085 variant:**
The SparkFun BNO08x library may not enable the INT output pin by default in I2C mode
for the 7Semi variant. If `digitalRead(1)` stays HIGH after `enableReports()`, the INT
signal is not being driven. The slow-advertising workaround handles this case — the
interrupt is registered and will work if INT ever activates, but is not required.
Proper INT configuration needs investigation with a logic analyzer on the next revision.

**Confirmed sources:**
- BNO085 INT pin: active-low, separate 0.1" header on SparkFun breakout (not
  on Qwiic connector). Ref: https://docs.sparkfun.com/SparkFun_VR_IMU_Breakout_BNO086_QWIIC/hardware_overview/
- nRF52840 GPIOTE: all 48 GPIO pins can be assigned to one of 8 GPIOTE channels
  for external interrupts. P0.03 (D1) is confirmed compatible.
  Ref: https://docs.nordicsemi.com/bundle/ps_nrf52840/page/gpio.html

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
