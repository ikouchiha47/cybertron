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
#include "shake_detector.h"

// ── BLE setup (Bluefruit / Adafruit nRF52 stack) ─────────────────────────────
BLEService     wristService("19B10000-E8F2-537E-4F6C-D104768A1214");
BLECharacteristic gestureChar("19B10001-E8F2-537E-4F6C-D104768A1214",
                               BLERead | BLENotify, 20);

// ── IMU ──────────────────────────────────────────────────────────────────────
BNO08x imu;

// ── Thresholds ───────────────────────────────────────────────────────────────
// Roll change (radians) required to trigger a gesture
const float TURN_THRESHOLD   = 0.70f;  // ~40°
// Minimum ms between gestures (debounce)
const unsigned long DEBOUNCE_MS = 600;

// ── State ────────────────────────────────────────────────────────────────────
float   baseRoll       = 0.0f;
float   basePitch      = 0.0f;
float   baseYaw        = 0.0f;
bool    baseSet        = false;
unsigned long lastGestureMs  = 0;
unsigned long lastPingMs     = 0;
const unsigned long PING_INTERVAL_MS = 3000;
ShakeDetector shake;

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

// Feature flags — comment out to disable
#define ENABLE_TAP
// #define ENABLE_SHAKE      // uses linear accelerometer
// #define ENABLE_STEP

void enableReports() {
  if (!imu.enableRotationVector())
    LOG_E("BNO085: could not enable Rotation Vector");
#ifdef ENABLE_SHAKE
  if (!imu.enableLinearAccelerometer())
    LOG_E("BNO085: could not enable Linear Accelerometer");
#endif
#ifdef ENABLE_TAP
  if (!imu.enableTapDetector(100))
    LOG_E("BNO085: could not enable Tap Detector");
#endif
#ifdef ENABLE_STEP
  if (!imu.enableStepCounter(1000))
    LOG_E("BNO085: could not enable Step Counter");
#endif
}

// ── BLE callbacks ─────────────────────────────────────────────────────────────
void onConnect(uint16_t conn_hdl) {
  LOG_I("BLE connected. conn_hdl=%u peers=%u", conn_hdl, Bluefruit.Periph.connected());
}

void onDisconnect(uint16_t conn_hdl, uint8_t reason) {
  LOG_I("BLE disconnected. conn_hdl=%u reason=0x%02X", conn_hdl, reason);
  Bluefruit.Advertising.start(0);
  LOG_I("BLE advertising restarted.");
}

// ── Setup ─────────────────────────────────────────────────────────────────────
void setup() {
  Serial.begin(115200);
  // Give serial monitor time to connect (skip delay in production)
  // while (!Serial) { delay(10); }  // only needed when Serial Monitor is attached

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
  enableReports();

  // ── BLE init ──
  LOG_I("BLE init...");
  Bluefruit.begin();
  Bluefruit.setName("WristTurn");
  // Short supervision timeout — detects dead connections (e.g. app force-killed) within ~2s
  Bluefruit.Periph.setConnInterval(6, 12);       // 7.5ms–15ms connection interval
  Bluefruit.Periph.setConnSupervisionTimeout(200); // 2000ms = 2s
  LOG_I("BLE supervision timeout set to 2s.");

  wristService.begin();

  gestureChar.setProperties(CHR_PROPS_READ | CHR_PROPS_NOTIFY);
  gestureChar.setPermission(SECMODE_OPEN, SECMODE_NO_ACCESS);
  gestureChar.setFixedLen(40);
  gestureChar.begin();
  gestureChar.write("idle                                   ", 40);

  Bluefruit.Advertising.addFlags(BLE_GAP_ADV_FLAGS_LE_ONLY_GENERAL_DISC_MODE);
  Bluefruit.Advertising.addTxPower();
  Bluefruit.Advertising.addService(wristService);
  Bluefruit.ScanResponse.addName();
  Bluefruit.Periph.setConnectCallback(onConnect);
  Bluefruit.Periph.setDisconnectCallback(onDisconnect);
  Bluefruit.Advertising.restartOnDisconnect(true);
  Bluefruit.Advertising.start(0);
  LOG_I("BLE advertising as 'WristTurn'.");
}

// ── Loop ──────────────────────────────────────────────────────────────────────
void loop() {
  if (!imu.wasReset() && imu.getSensorEvent()) {
    uint8_t eventId = imu.getSensorEventID();

#ifdef ENABLE_SHAKE
    if (eventId == SENSOR_REPORTID_LINEAR_ACCELERATION) {
      float ax = imu.getLinAccelX();
      float ay = imu.getLinAccelY();
      float az = imu.getLinAccelZ();
      if (shake.update(ax, ay, az)) {
        char buf[40] = {};
        snprintf(buf, sizeof(buf), "shake");
        LOG_I("%s", buf);
        gestureChar.notify(buf, 40);
      }
    }
#endif
#ifdef ENABLE_TAP
    if (eventId == SENSOR_REPORTID_TAP_DETECTOR) {
      char buf[40] = {};
      snprintf(buf, sizeof(buf), "tap");
      LOG_I("%s", buf);
      gestureChar.notify(buf, 40);
    }
#endif
#ifdef ENABLE_STEP
    if (eventId == SENSOR_REPORTID_STEP_COUNTER) {
      uint16_t steps = imu.getStepCount();
      char buf[40] = {};
      snprintf(buf, sizeof(buf), "step|%u", steps);
      LOG_I("%s", buf);
      gestureChar.notify(buf, 40);
    }
#endif

    else if (eventId == SENSOR_REPORTID_ROTATION_VECTOR) {
      float w = imu.getQuatReal();
      float x = imu.getQuatI();
      float y = imu.getQuatJ();
      float z = imu.getQuatK();

      float roll  = quaternionToRoll(w, x, y, z);
      float pitch = quaternionToPitch(w, x, y, z);
      float yaw   = quaternionToYaw(w, x, y, z);

      // Initialise baseline on first good reading
      if (!baseSet) {
        baseRoll  = roll;
        basePitch = pitch;
        baseYaw   = yaw;
        baseSet   = true;
      }

      float dRoll  = roll  - baseRoll;
      float dPitch = pitch - basePitch;
      float dYaw   = yaw   - baseYaw;
      unsigned long now = millis();

      LOG_D("roll=%.1f  pitch=%.1f  yaw=%.1f  dR=%.1f  dP=%.1f  dY=%.1f",
            roll * 57.296f, pitch * 57.296f, yaw * 57.296f,
            dRoll * 57.296f, dPitch * 57.296f, dYaw * 57.296f);

      if ((now - lastGestureMs) > DEBOUNCE_MS) {
        const char* gesture = nullptr;

        if (fabsf(dRoll) > TURN_THRESHOLD) {
          gesture = (dRoll > 0) ? "turn_right" : "turn_left";
          baseRoll = roll;
        } else if (fabsf(dPitch) > TURN_THRESHOLD) {
          gesture = (dPitch > 0) ? "pitch_up" : "pitch_down";
          basePitch = pitch;
        } else if (fabsf(dYaw) > TURN_THRESHOLD) {
          gesture = (dYaw > 0) ? "yaw_right" : "yaw_left";
          baseYaw = yaw;
        }

        if (gesture) {
          char buf[40] = {};
          snprintf(buf, sizeof(buf), "%s|%.1f|%.1f|%.1f",
                   gesture, roll * 57.296f, pitch * 57.296f, yaw * 57.296f);
          LOG_I("%s", buf);
          gestureChar.notify(buf, 40);
          lastGestureMs = now;
        }
      }
    }
  }

  // If IMU reset, re-enable report
  if (imu.wasReset()) {
    LOG_E("BNO085 reset - re-enabling reports.");
    enableReports();
  }

  // Keepalive ping — forces Android to close zombie GATT connections
  // when the app is dead (Android can't deliver the notify → fires disconnect)
  if (Bluefruit.Periph.connected()) {
    unsigned long now = millis();
    if (now - lastPingMs > PING_INTERVAL_MS) {
      lastPingMs = now;
      gestureChar.notify("ping", 4);
    }
  }
}
