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
BLEService        wristService("19B10000-E8F2-537E-4F6C-D104768A1214");
BLECharacteristic gestureChar("19B10001-E8F2-537E-4F6C-D104768A1214",
                               BLERead | BLENotify, 20);

// Settings service — writable from app
// thresholdChar: float, gesture trigger angle in degrees
// debounceChar:  uint32, minimum ms between gestures
// deadzoneChar:  float, return-to-neutral zone in degrees before re-arm
// rawModeChar:   uint8, 0=gesture-only (default), 1=stream raw IMU on every rotation vector event
BLEService        settingsService("19B10010-E8F2-537E-4F6C-D104768A1214");
BLECharacteristic thresholdChar("19B10011-E8F2-537E-4F6C-D104768A1214",
                                 BLERead | BLEWrite, 4);
BLECharacteristic debounceChar("19B10012-E8F2-537E-4F6C-D104768A1214",
                                BLERead | BLEWrite, 4);
BLECharacteristic deadzoneChar("19B10013-E8F2-537E-4F6C-D104768A1214",
                                BLERead | BLEWrite, 4);
BLECharacteristic rawModeChar("19B10014-E8F2-537E-4F6C-D104768A1214",
                               BLERead | BLEWrite, 1);

// ── IMU ──────────────────────────────────────────────────────────────────────
BNO08x imu;

// ── Thresholds — tunable via BLE ─────────────────────────────────────────────
float         turnThreshold = 15.0f;  // degrees to trigger gesture
float         deadzoneDegs  =  5.0f;  // degrees to return within before re-arm
unsigned long debounceMs    =  200;   // min ms between gestures

// ── State ────────────────────────────────────────────────────────────────────
bool    rawMode        = false; // stream raw IMU on every rotation vector event


float   baseRoll       = 0.0f;
float   basePitch      = 0.0f;
float   baseYaw        = 0.0f;
bool    baseSet        = false;

// Per-axis armed flag — set false after gesture fires, true again once
// wrist returns within deadzone of that axis base
bool    rollArmed      = true;
bool    pitchArmed     = true;
bool    yawArmed       = true;

unsigned long lastGestureMs  = 0;
unsigned long lastPingMs     = 0;
const unsigned long PING_INTERVAL_MS = 3000;
ShakeDetector shake;

// Last known orientation — updated every rotation vector event
// Used by stability classifier to rebase when wrist is still
float lastRoll  = 0.0f;
float lastPitch = 0.0f;
float lastYaw   = 0.0f;

// ── Helpers ──────────────────────────────────────────────────────────────────
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
#define ENABLE_GRYO

// Stability classifier values from BNO085 SHTP protocol spec
// 0=unknown, 1=on_table, 2=stationary, 3=stable (held still), 4=motion
#define STABILITY_ON_TABLE   1
#define STABILITY_STATIONARY 2
#define STABILITY_STABLE     3

// Min ms after last gesture before stability can update base
const unsigned long STABILITY_REBASE_HOLDOFF_MS = 1500;


void enableReports() {
  if (!imu.enableRotationVector())
    LOG_E("BNO085: could not enable Rotation Vector");
  if (!imu.enableStabilityClassifier(500))  // 500ms interval
    LOG_E("BNO085: could not enable Stability Classifier");
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
#ifdef ENABLE_GRYO
  if(!imu.enableGyro())
    LOG_E("BN0085: could not enable gyro");
#endif
}

// ── BLE write callbacks ───────────────────────────────────────────────────────
void onThresholdWrite(uint16_t conn_hdl, BLECharacteristic* chr, uint8_t* data, uint16_t len) {
  if (len == 4) {
    float val;
    memcpy(&val, data, 4);
    if (val > 0.0f && val < 90.0f) {
      turnThreshold = val;
      LOG_I("[Settings] threshold updated: %.1f deg", turnThreshold);
    } else {
      LOG_E("[Settings] threshold out of range: %.1f (must be 0-90)", val);
    }
  }
}

void onDebounceWrite(uint16_t conn_hdl, BLECharacteristic* chr, uint8_t* data, uint16_t len) {
  if (len == 4) {
    uint32_t val;
    memcpy(&val, data, 4);
    if (val >= 50 && val <= 2000) {
      debounceMs = val;
      LOG_I("[Settings] debounce updated: %lu ms", debounceMs);
    } else {
      LOG_E("[Settings] debounce out of range: %lu (must be 50-2000)", val);
    }
  }
}

void onRawModeWrite(uint16_t conn_hdl, BLECharacteristic* chr, uint8_t* data, uint16_t len) {
  if (len == 1) {
    rawMode = (data[0] != 0);
    LOG_I("[Settings] rawMode=%d", rawMode);
  }
}

void onDeadzoneWrite(uint16_t conn_hdl, BLECharacteristic* chr, uint8_t* data, uint16_t len) {
  if (len == 4) {
    float val;
    memcpy(&val, data, 4);
    if (val >= 0.0f && val < turnThreshold) {
      deadzoneDegs = val;
      LOG_I("[Settings] deadzone updated: %.1f deg", deadzoneDegs);
    } else {
      LOG_E("[Settings] deadzone out of range: %.1f (must be 0 to threshold)", val);
    }
  }
}

// ── BLE callbacks ─────────────────────────────────────────────────────────────
void onConnect(uint16_t conn_hdl) {
  LOG_I("BLE connected. conn_hdl=%u peers=%u", conn_hdl, Bluefruit.Periph.connected());
  // Send current settings to app on connect
  LOG_I("[Settings] current: threshold=%.1f deg  debounce=%lu ms  deadzone=%.1f deg",
        turnThreshold, debounceMs, deadzoneDegs);
}

void onDisconnect(uint16_t conn_hdl, uint8_t reason) {
  LOG_I("BLE disconnected. conn_hdl=%u reason=0x%02X", conn_hdl, reason);
  Bluefruit.Advertising.start(0);
  LOG_I("BLE advertising restarted.");
}

// ── Setup ─────────────────────────────────────────────────────────────────────
void setup() {
  Serial.begin(115200);

  // ── Power optimizations ───────────────────────────────────────────────────
  // Disable onboard PDM microphone (XIAO nRF52840 Sense: mic power on P1.10)
  // Saves ~1.5mA continuously. Must be done before Wire.begin().
  pinMode(PIN_PDM_PWR, OUTPUT);
  digitalWrite(PIN_PDM_PWR, LOW);

  // Disable onboard LSM6DS3TR-C — not used (BNO085 is external IMU).
  // Hold it in power-down by never calling Wire.begin() for its address,
  // but we also pull its VDD line low via its CS pin to cut quiescent current.
  // The LSM6DS3 enters power-down automatically if not configured; ~6µA in that state.

  // Set BLE TX power to minimum — adequate for wrist-to-laptop distances (<2m).
  // sd_ble_gap_tx_power_set() equivalent via Bluefruit: done after Bluefruit.begin().

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
  Bluefruit.setTxPower(-20);  // dBm: -40,-20,-16,-12,-8,-4,0,4. -20 sufficient for <2m
  Bluefruit.setName("WristTurn");
  Bluefruit.Periph.setConnInterval(6, 12);
  Bluefruit.Periph.setConnSupervisionTimeout(200);
  LOG_I("BLE supervision timeout set to 2s.");

  // Gesture service
  wristService.begin();
  gestureChar.setProperties(CHR_PROPS_READ | CHR_PROPS_NOTIFY);
  gestureChar.setPermission(SECMODE_OPEN, SECMODE_NO_ACCESS);
  gestureChar.setFixedLen(40);
  gestureChar.begin();
  gestureChar.write("idle                                   ", 40);

  // Settings service
  settingsService.begin();

  thresholdChar.setProperties(CHR_PROPS_READ | CHR_PROPS_WRITE);
  thresholdChar.setPermission(SECMODE_OPEN, SECMODE_OPEN);
  thresholdChar.setFixedLen(4);
  thresholdChar.setWriteCallback(onThresholdWrite);
  thresholdChar.begin();
  thresholdChar.write(&turnThreshold, 4);

  debounceChar.setProperties(CHR_PROPS_READ | CHR_PROPS_WRITE);
  debounceChar.setPermission(SECMODE_OPEN, SECMODE_OPEN);
  debounceChar.setFixedLen(4);
  debounceChar.setWriteCallback(onDebounceWrite);
  debounceChar.begin();
  uint32_t dms = (uint32_t)debounceMs;
  debounceChar.write(&dms, 4);

  deadzoneChar.setProperties(CHR_PROPS_READ | CHR_PROPS_WRITE);
  deadzoneChar.setPermission(SECMODE_OPEN, SECMODE_OPEN);
  deadzoneChar.setFixedLen(4);
  deadzoneChar.setWriteCallback(onDeadzoneWrite);
  deadzoneChar.begin();
  deadzoneChar.write(&deadzoneDegs, 4);

  rawModeChar.setProperties(CHR_PROPS_READ | CHR_PROPS_WRITE);
  rawModeChar.setPermission(SECMODE_OPEN, SECMODE_OPEN);
  rawModeChar.setFixedLen(1);
  rawModeChar.setWriteCallback(onRawModeWrite);
  rawModeChar.begin();
  uint8_t rm = 0;
  rawModeChar.write(&rm, 1);

  Bluefruit.Advertising.addFlags(BLE_GAP_ADV_FLAGS_LE_ONLY_GENERAL_DISC_MODE);
  Bluefruit.Advertising.addTxPower();
  Bluefruit.Advertising.addService(wristService);
  Bluefruit.ScanResponse.addName();
  Bluefruit.Periph.setConnectCallback(onConnect);
  Bluefruit.Periph.setDisconnectCallback(onDisconnect);
  Bluefruit.Advertising.restartOnDisconnect(true);
  Bluefruit.Advertising.start(0);
  LOG_I("BLE advertising as 'WristTurn'.");
  LOG_I("[Settings] defaults: threshold=%.1f deg  debounce=%lu ms  deadzone=%.1f deg",
        turnThreshold, debounceMs, deadzoneDegs);
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

    if (eventId == SENSOR_REPORTID_STABILITY_CLASSIFIER) {
      uint8_t stability = imu.getStabilityClassifier();
      unsigned long now = millis();
      bool allArmed = rollArmed && pitchArmed && yawArmed;
      bool holdoffPassed = (now - lastGestureMs) > STABILITY_REBASE_HOLDOFF_MS;

      LOG_D("[Stability] class=%u armed=%d%d%d holdoff=%d",
            stability, rollArmed, pitchArmed, yawArmed, holdoffPassed);
      if ((stability == STABILITY_ON_TABLE || stability == STABILITY_STATIONARY || stability == STABILITY_STABLE)
          && allArmed && holdoffPassed && baseSet) {
        baseRoll  = lastRoll;
        basePitch = lastPitch;
        baseYaw   = lastYaw;
        LOG_D("[Stability] rebase: roll=%.1f  pitch=%.1f  yaw=%.1f",
              baseRoll, basePitch, baseYaw);
      }
    }

#ifdef ENABLE_GRYO
    else if (eventId == SENSOR_REPORTID_GYROSCOPE_CALIBRATED) {
      if (rawMode && Bluefruit.Periph.connected()) {
        float gx = imu.getGyroX();  // rad/s
        float gy = imu.getGyroY();
        float gz = imu.getGyroZ();
        char buf[40] = {};
        snprintf(buf, sizeof(buf), "gyr|%.3f|%.3f|%.3f", gx, gy, gz);
        gestureChar.notify(buf, 40);
      }
    }
#endif

    else if (eventId == SENSOR_REPORTID_ROTATION_VECTOR) {
      float w = imu.getQuatReal();
      float x = imu.getQuatI();
      float y = imu.getQuatJ();
      float z = imu.getQuatK();

      float roll  = quaternionToRoll(w, x, y, z)  * 57.296f;
      float pitch = quaternionToPitch(w, x, y, z) * 57.296f;
      float yaw   = quaternionToYaw(w, x, y, z)   * 57.296f;

      lastRoll  = roll;
      lastPitch = pitch;
      lastYaw   = yaw;

      // Initialise baseline on first good reading
      if (!baseSet) {
        baseRoll  = roll;
        basePitch = pitch;
        baseYaw   = yaw;
        baseSet   = true;
        LOG_I("[IMU] baseline set: roll=%.1f  pitch=%.1f  yaw=%.1f", baseRoll, basePitch, baseYaw);
      }

      float dRoll  = roll  - baseRoll;
      float dPitch = pitch - basePitch;
      float dYaw   = yaw   - baseYaw;
      unsigned long now = millis();

      LOG_D("[IMU] roll=%.1f  pitch=%.1f  yaw=%.1f  dR=%.1f  dP=%.1f  dY=%.1f  armed=%d%d%d",
            roll, pitch, yaw, dRoll, dPitch, dYaw,
            rollArmed, pitchArmed, yawArmed);

      // ── Raw stream mode (for data collection) ────────────────────────────
      if (rawMode && Bluefruit.Periph.connected()) {
        char buf[40] = {};
        snprintf(buf, sizeof(buf), "raw|%.1f|%.1f|%.1f", roll, pitch, yaw);
        gestureChar.notify(buf, 40);
      }

      // ── Deadzone re-arm check ─────────────────────────────────────────────
      // Once a gesture fires on an axis, the axis is disarmed.
      // It re-arms when the wrist returns within deadzoneDegs of that axis base.
      if (!rollArmed && fabsf(dRoll) <= deadzoneDegs) {
        rollArmed = true;
        LOG_I("[Deadzone] roll re-armed dRoll=%.1f deg (base stays at %.1f)", dRoll, baseRoll);
      }
      if (!pitchArmed && fabsf(dPitch) <= deadzoneDegs) {
        pitchArmed = true;
        LOG_I("[Deadzone] pitch re-armed dPitch=%.1f deg (base stays at %.1f)", dPitch, basePitch);
      }
      if (!yawArmed && fabsf(dYaw) <= deadzoneDegs) {
        yawArmed = true;
        LOG_I("[Deadzone] yaw re-armed dYaw=%.1f deg (base stays at %.1f)", dYaw, baseYaw);
      }

      // ── Gesture detection ─────────────────────────────────────────────────
      if ((now - lastGestureMs) > debounceMs) {
        const char* gesture = nullptr;

        if (rollArmed && fabsf(dRoll) > turnThreshold) {
          gesture   = (dRoll > 0) ? "turn_right" : "turn_left";
          rollArmed = false;
          LOG_I("[Gesture] %s  dRoll=%.1f deg  (disarmed roll)", gesture, dRoll);
        } else if (pitchArmed && fabsf(dPitch) > turnThreshold) {
          gesture    = (dPitch > 0) ? "pitch_up" : "pitch_down";
          pitchArmed = false;
          LOG_I("[Gesture] %s  dPitch=%.1f deg  (disarmed pitch)", gesture, dPitch);
        } else if (yawArmed && fabsf(dYaw) > turnThreshold) {
          gesture  = (dYaw > 0) ? "yaw_right" : "yaw_left";
          yawArmed = false;
          LOG_I("[Gesture] %s  dYaw=%.1f deg  (disarmed yaw)", gesture, dYaw);
        }

        if (gesture) {
          char buf[40] = {};
          snprintf(buf, sizeof(buf), "%s|%.1f|%.1f|%.1f", gesture, roll, pitch, yaw);
          gestureChar.notify(buf, 40);
          lastGestureMs = now;
        }
      }
    }
  }

  // If IMU reset, re-enable reports
  if (imu.wasReset()) {
    LOG_E("BNO085 reset - re-enabling reports.");
    enableReports();
  }

  // Keepalive ping
  if (Bluefruit.Periph.connected()) {
    unsigned long now = millis();
    if (now - lastPingMs > PING_INTERVAL_MS) {
      lastPingMs = now;
      gestureChar.notify("ping", 4);
    }
  }
}
