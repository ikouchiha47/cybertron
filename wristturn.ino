/**
 * WristTurn - BNO085 + XIAO nRF52840 Sense
 *
 * Detects wrist pronation/supination (turn left/right) using the BNO085
 * rotation vector and broadcasts the gesture over BLE.
 *
 * Wiring (QWIIC / I2C):
 *   BNO085 SDA  -> XIAO D4 (SDA)
 *   BNO085 SCL  -> XIAO D5 (SCL)
 *   BNO085 VCC  -> 3.3V
 *   BNO085 GND  -> GND
 *
 * Libraries required (install via Library Manager):
 *   - SparkFun BNO08x Arduino Library
 *   - bluefruit.h (built into Seeed nRF52840 board package – no install needed)
 */

#include <Wire.h>
#include <SparkFun_BNO08x_Arduino_Library.h>
#include <bluefruit.h>
#include "log.h"

// ── BLE setup (Bluefruit / Adafruit nRF52 stack) ─────────────────────────────
BLEService     wristService("19B10000-E8F2-537E-4F6C-D104768A1214");
BLECharacteristic gestureChar("19B10001-E8F2-537E-4F6C-D104768A1214",
                               BLERead | BLENotify, 20);

// ── IMU ──────────────────────────────────────────────────────────────────────
BNO08x imu;

// ── Thresholds ───────────────────────────────────────────────────────────────
// Roll change (radians) required to trigger a gesture
const float TURN_THRESHOLD   = 0.45f;  // ~26°
// Minimum ms between gestures (debounce)
const unsigned long DEBOUNCE_MS = 600;

// ── State ────────────────────────────────────────────────────────────────────
float   baseRoll       = 0.0f;
bool    baseSet        = false;
unsigned long lastGestureMs = 0;

// ── Helpers ──────────────────────────────────────────────────────────────────
// Convert quaternion to roll (rotation around forearm axis).
// BNO085 convention: i=x, j=y, k=z, r=w
float quaternionToRoll(float w, float x, float y, float z) {
  float sinr = 2.0f * (w * x + y * z);
  float cosr = 1.0f - 2.0f * (x * x + y * y);
  return atan2f(sinr, cosr);
}

float quaternionToPitch(float w, float x, float y, float z) {
  float sinp = 2.0f * (w * y - z * x);
  if (fabsf(sinp) >= 1.0f) return copysignf(M_PI / 2.0f, sinp);
  return asinf(sinp);
}

float quaternionToYaw(float w, float x, float y, float z) {
  float siny = 2.0f * (w * z + x * y);
  float cosy = 1.0f - 2.0f * (y * y + z * z);
  return atan2f(siny, cosy);
}

void enableRotationVector() {
  if (!imu.enableRotationVector()) {
    LOG_E("BNO085: could not enable Rotation Vector");
  }
}

// ── Setup ─────────────────────────────────────────────────────────────────────
void setup() {
  Serial.begin(115200);
  // Give serial monitor time to connect (skip delay in production)
  while (!Serial) { delay(10); }  // wait until Serial Monitor is open

  // ── IMU init ──
  Wire.begin();
  LOG_D("Scanning I2C bus...");
  int found = 0;
  for (byte addr = 8; addr < 120; addr++) {
    Wire.beginTransmission(addr);
    byte err = Wire.endTransmission();
    if (err == 0) {
      LOG_D("  Found device at 0x%02X", addr);
      found++;
    } else if (err == 4) {
      LOG_E("  I2C error at 0x%02X", addr);
    }
  }
  if (found == 0) LOG_E("I2C: no devices found.");
  LOG_D("I2C scan done.");

  if (!imu.begin(0x4B, Wire) && !imu.begin(0x4A, Wire)) {
    LOG_E("BNO085 not found - check wiring!");
    while (true) { delay(100); }
  }
  LOG_I("BNO085 ready.");
  enableRotationVector();

  // ── BLE init ──
  Bluefruit.begin();
  Bluefruit.setName("WristTurn");

  wristService.begin();

  gestureChar.setProperties(CHR_PROPS_READ | CHR_PROPS_NOTIFY);
  gestureChar.setPermission(SECMODE_OPEN, SECMODE_NO_ACCESS);
  gestureChar.setFixedLen(20);
  gestureChar.begin();
  gestureChar.write("idle               ", 20);

  Bluefruit.Advertising.addFlags(BLE_GAP_ADV_FLAGS_LE_ONLY_GENERAL_DISC_MODE);
  Bluefruit.Advertising.addTxPower();
  Bluefruit.Advertising.addService(wristService);
  Bluefruit.ScanResponse.addName();
  Bluefruit.Advertising.restartOnDisconnect(true);
  Bluefruit.Advertising.start(0);
  LOG_I("BLE advertising as 'WristTurn'.");
}

// ── Loop ──────────────────────────────────────────────────────────────────────
void loop() {
  if (!imu.wasReset() && imu.getSensorEvent()) {
    if (imu.getSensorEventID() == SENSOR_REPORTID_ROTATION_VECTOR) {
      float w = imu.getQuatReal();
      float x = imu.getQuatI();
      float y = imu.getQuatJ();
      float z = imu.getQuatK();

      float roll  = quaternionToRoll(w, x, y, z);
      float pitch = quaternionToPitch(w, x, y, z);
      float yaw   = quaternionToYaw(w, x, y, z);

      // Initialise baseline on first good reading
      if (!baseSet) {
        baseRoll = roll;
        baseSet  = true;
      }

      float delta = roll - baseRoll;
      unsigned long now = millis();

      LOG_D("roll=%.1f  pitch=%.1f  yaw=%.1f  delta=%.1f",
            roll * 57.296f, pitch * 57.296f, yaw * 57.296f, delta * 57.296f);

      if (fabsf(delta) > TURN_THRESHOLD && (now - lastGestureMs) > DEBOUNCE_MS) {
        const char* gesture = (delta > 0) ? "turn_right" : "turn_left";

        LOG_I("%s", gesture);

        // Pad to fixed 20 bytes
        char buf[20] = {};
        strncpy(buf, gesture, 20);
        gestureChar.notify(buf, 20);
        lastGestureMs = now;

        // Reset baseline so next gesture is relative to current position
        baseRoll = roll;
      }
    }
  }

  // If IMU reset, re-enable report
  if (imu.wasReset()) {
    LOG_E("BNO085 reset - re-enabling reports.");
    enableRotationVector();
  }
}
