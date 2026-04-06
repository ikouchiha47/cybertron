/**
 * WristTurn - LSM6DS3TR-C (XIAO nRF52840 Sense onboard IMU)
 *
 * Drop-in replacement for wristturn_bno085.ino.
 * Same BLE UUIDs, same output format:
 *   raw|roll|pitch|yaw   (IMU stream, degrees)
 *   gyr|x|y|z            (gyro stream, rad/s)
 *
 * No external wiring — uses the onboard LSM6DS3TR-C at I2C 0x6A.
 * Madgwick 6DOF filter replaces BNO085 onboard fusion.
 *
 * Library required (install via Library Manager):
 *   - "Seeed Arduino LSM6DS3"
 *   - bluefruit.h (built into nRF52840 board package)
 */

#include <Wire.h>
#include <LSM6DS3.h>
#include <bluefruit.h>
#include "log.h"

// ── BLE (same UUIDs as BNO085 version — Python server unchanged) ──────────────
BLEService        wristService("19B10000-E8F2-537E-4F6C-D104768A1214");
BLECharacteristic gestureChar("19B10001-E8F2-537E-4F6C-D104768A1214",
                               BLERead | BLENotify, 20);

BLEService        settingsService("19B10010-E8F2-537E-4F6C-D104768A1214");
BLECharacteristic thresholdChar("19B10011-E8F2-537E-4F6C-D104768A1214",
                                 BLERead | BLEWrite, 4);
BLECharacteristic debounceChar("19B10012-E8F2-537E-4F6C-D104768A1214",
                                BLERead | BLEWrite, 4);
BLECharacteristic deadzoneChar("19B10013-E8F2-537E-4F6C-D104768A1214",
                                BLERead | BLEWrite, 4);
BLECharacteristic rawModeChar("19B10014-E8F2-537E-4F6C-D104768A1214",
                               BLERead | BLEWrite, 1);

// ── Onboard IMU ───────────────────────────────────────────────────────────────
LSM6DS3 imu(I2C_MODE, 0x6A);

// ─────────────────────────────────────────────────────────────────────────────
// State machine
// ─────────────────────────────────────────────────────────────────────────────

// States:
//   WARMUP  – first WARMUP_SAMPLES iterations; Madgwick hasn't converged yet.
//             Gesture detection and baseline-setting are both suppressed.
//   IDLE    – at rest, baseline is fresh. No rebase needed yet.
//   MOVING  – gyroMag ≥ STILL_THRESH; gesture detection active.
//   STILL   – gyroMag < STILL_THRESH after moving; waiting to confirm stillness
//             before rebasing.
//
// Transitions:
//   WARMUP → IDLE    : sampleCount reaches WARMUP_SAMPLES; baseline is set here.
//   IDLE   → MOVING  : gyroMag ≥ STILL_THRESH
//   MOVING → STILL   : gyroMag < STILL_THRESH (records stillSinceMs)
//   STILL  → MOVING  : gyroMag ≥ STILL_THRESH before timeout
//   STILL  → IDLE    : still for STILL_MS AND gesture holdoff expired
//                       → rebase baseline, re-arm all axes (breaks deadlock)

enum class MotionState : uint8_t { WARMUP, IDLE, MOVING, STILL };

// Hot path: all fields accessed every 20ms loop tick.
// alignas(4) keeps the struct word-aligned; grouping quaternion + baseline
// in the first 28 bytes means they share the first ARM bus-word burst.
struct alignas(4) SensorState {
    // Madgwick quaternion — 16 bytes
    float q0 = 1.0f, q1 = 0.0f, q2 = 0.0f, q3 = 0.0f;

    // Orientation baseline — 12 bytes
    float baseRoll = 0.0f, basePitch = 0.0f, baseYaw = 0.0f;

    // Gyro bias (startup + runtime correction) — 12 bytes
    float biasX = 0.0f, biasY = 0.0f, biasZ = 0.0f;

    // Smoothed accel magnitude for accel-based stillness detection — 4 bytes
    // Used independently of gyroMag so gyro bias can't fool the still check.
    float smoothAccelMag = 1.0f;

    // State machine + arm flags — packed into one 32-bit word boundary
    MotionState motionState = MotionState::WARMUP;  // 1 byte
    bool rollArmed  = true;   // 1 byte
    bool pitchArmed = true;   // 1 byte
    bool yawArmed   = true;   // 1 byte

    // Warmup counter + raw mode flag — 4 bytes
    int16_t warmupCount = 0;
    bool    rawMode     = false;
    uint8_t _pad        = 0;
};  // 52 bytes

// Timing: millisecond timestamps — updated every tick but separated from
// SensorState so the hot quaternion/baseline block stays compact.
struct TimingState {
    unsigned long lastSampleMs  = 0;
    unsigned long lastGestureMs = 0;
    unsigned long lastPingMs    = 0;
    unsigned long stillSinceMs  = 0;
};  // 16 bytes

// Settings: written only via BLE callbacks, never on the hot path.
struct Settings {
    float         turnThreshold = 15.0f;
    float         deadzoneDegs  =  5.0f;
    unsigned long debounceMs    =  200;
};  // 12 bytes

static SensorState ss;
static TimingState timing;
static Settings    cfg;

// ── Constants ─────────────────────────────────────────────────────────────────
static const float         STILL_THRESH      = 0.08f;   // rad/s
static const unsigned long STILL_MS          = 600;     // ms motionless before rebase
static const unsigned long REBASE_HOLDOFF_MS = 400;     // ms after gesture before rebase
static const int           WARMUP_SAMPLES    = 100;     // samples for Madgwick to converge
static const float         BETA              = 0.4f;    // Madgwick convergence rate
static const unsigned long PING_INTERVAL_MS  = 3000;
static const unsigned long SAMPLE_INTERVAL_MS = 20;    // 50 Hz

// ── Madgwick 6DOF filter ──────────────────────────────────────────────────────
static inline float clampf(float v, float lo, float hi) {
  return v < lo ? lo : (v > hi ? hi : v);
}

void madgwickUpdate(float gx, float gy, float gz,
                    float ax, float ay, float az,
                    float dt) {
  float &q0 = ss.q0, &q1 = ss.q1, &q2 = ss.q2, &q3 = ss.q3;
  float recipNorm;
  float s0, s1, s2, s3;
  float qDot0 = 0.5f * (-q1*gx - q2*gy - q3*gz);
  float qDot1 = 0.5f * ( q0*gx + q2*gz - q3*gy);
  float qDot2 = 0.5f * ( q0*gy - q1*gz + q3*gx);
  float qDot3 = 0.5f * ( q0*gz + q1*gy - q2*gx);

  float accNorm = sqrtf(ax*ax + ay*ay + az*az);
  if (accNorm > 0.001f) {
    recipNorm = 1.0f / accNorm;
    ax *= recipNorm; ay *= recipNorm; az *= recipNorm;

    float _2q0 = 2*q0, _2q1 = 2*q1, _2q2 = 2*q2, _2q3 = 2*q3;
    float q0q0 = q0*q0, q1q1 = q1*q1, q2q2 = q2*q2, q3q3 = q3*q3;

    s0 = 4*q0*q2q2 + _2q2*ax + 4*q0*q1q1 - _2q1*ay;
    s1 = 4*q1*q3q3 - _2q3*ax + 4*q0q0*q1 - _2q0*ay - 4*q1
       + 8*q1*q1q1 + 8*q1*q2q2 + 4*q1*az;
    s2 = 4*q0q0*q2 + _2q0*ax + 4*q2*q3q3 - _2q3*ay - 4*q2
       + 8*q2*q1q1 + 8*q2*q2q2 + 4*q2*az;
    s3 = 4*q1q1*q3 - _2q1*ax + 4*q2q2*q3 - _2q2*ay;

    recipNorm = 1.0f / sqrtf(s0*s0 + s1*s1 + s2*s2 + s3*s3);
    s0 *= recipNorm; s1 *= recipNorm; s2 *= recipNorm; s3 *= recipNorm;

    qDot0 -= BETA * s0;
    qDot1 -= BETA * s1;
    qDot2 -= BETA * s2;
    qDot3 -= BETA * s3;
  }

  q0 += qDot0 * dt; q1 += qDot1 * dt;
  q2 += qDot2 * dt; q3 += qDot3 * dt;

  recipNorm = 1.0f / sqrtf(q0*q0 + q1*q1 + q2*q2 + q3*q3);
  q0 *= recipNorm; q1 *= recipNorm; q2 *= recipNorm; q3 *= recipNorm;
}

// ── BLE write callbacks ───────────────────────────────────────────────────────
void onThresholdWrite(uint16_t, BLECharacteristic*, uint8_t* data, uint16_t len) {
  if (len == 4) {
    float val; memcpy(&val, data, 4);
    if (val > 0.0f && val < 90.0f) {
      cfg.turnThreshold = val;
      LOG_I("[Settings] threshold=%.1f deg", cfg.turnThreshold);
    }
  }
}

void onDebounceWrite(uint16_t, BLECharacteristic*, uint8_t* data, uint16_t len) {
  if (len == 4) {
    uint32_t val; memcpy(&val, data, 4);
    if (val >= 50 && val <= 2000) {
      cfg.debounceMs = val;
      LOG_I("[Settings] debounce=%lu ms", cfg.debounceMs);
    }
  }
}

void onDeadzoneWrite(uint16_t, BLECharacteristic*, uint8_t* data, uint16_t len) {
  if (len == 4) {
    float val; memcpy(&val, data, 4);
    if (val >= 0.0f && val < cfg.turnThreshold) {
      cfg.deadzoneDegs = val;
      LOG_I("[Settings] deadzone=%.1f deg", cfg.deadzoneDegs);
    }
  }
}

void onRawModeWrite(uint16_t, BLECharacteristic*, uint8_t* data, uint16_t len) {
  if (len == 1) {
    ss.rawMode = (data[0] != 0);
    LOG_I("[Settings] rawMode=%d", ss.rawMode);
  }
}

// ── BLE callbacks ─────────────────────────────────────────────────────────────
void onConnect(uint16_t conn_hdl) {
  LOG_I("BLE connected conn_hdl=%u", conn_hdl);
}

void onDisconnect(uint16_t conn_hdl, uint8_t reason) {
  LOG_I("BLE disconnected conn_hdl=%u reason=0x%02X", conn_hdl, reason);
  Bluefruit.Advertising.start(0);
}

// ── Setup ─────────────────────────────────────────────────────────────────────
void setup() {
  Serial.begin(115200);

  if (imu.begin() != 0) {
    LOG_E("LSM6DS3 not found — check board is nRF52840 Sense");
    while (true) { delay(100); }
  }
  LOG_I("LSM6DS3TR-C ready.");

  // ── Gyro bias calibration — keep wrist still for ~2s after power-on ──────
  LOG_I("Calibrating gyro bias (keep still)...");
  const int CAL_SAMPLES = 100;
  float sumX = 0, sumY = 0, sumZ = 0;
  for (int i = 0; i < CAL_SAMPLES; i++) {
    sumX += imu.readFloatGyroX() * DEG_TO_RAD;
    sumY += imu.readFloatGyroY() * DEG_TO_RAD;
    sumZ += imu.readFloatGyroZ() * DEG_TO_RAD;
    delay(10);
  }
  ss.biasX = sumX / CAL_SAMPLES;
  ss.biasY = sumY / CAL_SAMPLES;
  ss.biasZ = sumZ / CAL_SAMPLES;
  LOG_I("Gyro bias: x=%.4f y=%.4f z=%.4f rad/s", ss.biasX, ss.biasY, ss.biasZ);

  // ── BLE ──
  Bluefruit.begin();
  Bluefruit.setName("WristTurn");
  Bluefruit.Periph.setConnInterval(6, 12);
  Bluefruit.Periph.setConnSupervisionTimeout(200);

  wristService.begin();
  gestureChar.setProperties(CHR_PROPS_READ | CHR_PROPS_NOTIFY);
  gestureChar.setPermission(SECMODE_OPEN, SECMODE_NO_ACCESS);
  gestureChar.setFixedLen(40);
  gestureChar.begin();
  gestureChar.write("idle                                   ", 40);

  settingsService.begin();

  thresholdChar.setProperties(CHR_PROPS_READ | CHR_PROPS_WRITE);
  thresholdChar.setPermission(SECMODE_OPEN, SECMODE_OPEN);
  thresholdChar.setFixedLen(4);
  thresholdChar.setWriteCallback(onThresholdWrite);
  thresholdChar.begin();
  thresholdChar.write(&cfg.turnThreshold, 4);

  debounceChar.setProperties(CHR_PROPS_READ | CHR_PROPS_WRITE);
  debounceChar.setPermission(SECMODE_OPEN, SECMODE_OPEN);
  debounceChar.setFixedLen(4);
  debounceChar.setWriteCallback(onDebounceWrite);
  debounceChar.begin();
  uint32_t dms = (uint32_t)cfg.debounceMs;
  debounceChar.write(&dms, 4);

  deadzoneChar.setProperties(CHR_PROPS_READ | CHR_PROPS_WRITE);
  deadzoneChar.setPermission(SECMODE_OPEN, SECMODE_OPEN);
  deadzoneChar.setFixedLen(4);
  deadzoneChar.setWriteCallback(onDeadzoneWrite);
  deadzoneChar.begin();
  deadzoneChar.write(&cfg.deadzoneDegs, 4);

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
}

// ── Loop ──────────────────────────────────────────────────────────────────────
void loop() {
  unsigned long now = millis();
  if (now - timing.lastSampleMs < SAMPLE_INTERVAL_MS) return;
  float dt = (now - timing.lastSampleMs) * 0.001f;
  timing.lastSampleMs = now;

  // ── Read sensors ─────────────────────────────────────────────────────────
  float ax = imu.readFloatAccelX();
  float ay = imu.readFloatAccelY();
  float az = imu.readFloatAccelZ();
  float gx = imu.readFloatGyroX() * DEG_TO_RAD - ss.biasX;
  float gy = imu.readFloatGyroY() * DEG_TO_RAD - ss.biasY;
  float gz = imu.readFloatGyroZ() * DEG_TO_RAD - ss.biasZ;

  // ── Madgwick update ───────────────────────────────────────────────────────
  madgwickUpdate(gx, gy, gz, ax, ay, az, dt);

  // ── Euler angles (degrees) ────────────────────────────────────────────────
  float roll  = atan2f(2*(ss.q0*ss.q1 + ss.q2*ss.q3), 1 - 2*(ss.q1*ss.q1 + ss.q2*ss.q2)) * 57.296f;
  float pitch = asinf(clampf(2*(ss.q0*ss.q2 - ss.q3*ss.q1), -1.0f, 1.0f))                 * 57.296f;
  float yaw   = atan2f(2*(ss.q0*ss.q3 + ss.q1*ss.q2), 1 - 2*(ss.q2*ss.q2 + ss.q3*ss.q3)) * 57.296f;

  float gyroMag = sqrtf(gx*gx + gy*gy + gz*gz);

  // Low-pass filter on gyroMag so Madgwick correction noise doesn't prevent
  // the STILL state from being entered. ~120ms smoothing window at 50Hz.
  static float smoothGyroMag = 0.0f;
  smoothGyroMag = 0.85f * smoothGyroMag + 0.15f * gyroMag;

  // ── Runtime gyro bias correction ─────────────────────────────────────────
  // The LSM6DS3 zero-rate offset can be ±10°/s — startup calibration reduces
  // this but residual drift can still be several °/s. When this is large,
  // smoothGyroMag stays above STILL_THRESH even when physically motionless,
  // blocking the rebase entirely.
  //
  // Fix: use accelerometer variance to detect true physical stillness,
  // independent of gyro bias. When accel magnitude is stable (device at rest,
  // gravity is constant), the remaining gyro reading IS the residual bias.
  // Slowly subtract it — same principle as BNO085's onboard compensation.
  //
  // alpha=0.003 → ~7s to halve a 14°/s residual at 50Hz (50*0.003=0.15/s)
  float accelMag = sqrtf(ax*ax + ay*ay + az*az);
  ss.smoothAccelMag = 0.98f * ss.smoothAccelMag + 0.02f * accelMag;
  bool accelStill = (fabsf(accelMag - ss.smoothAccelMag) < 0.02f)
                    && ss.motionState != MotionState::WARMUP;
  if (accelStill) {
    const float BIAS_ALPHA = 0.003f;
    ss.biasX += BIAS_ALPHA * gx;
    ss.biasY += BIAS_ALPHA * gy;
    ss.biasZ += BIAS_ALPHA * gz;
  }

  // ── State machine ─────────────────────────────────────────────────────────
  switch (ss.motionState) {

    case MotionState::WARMUP:
      // Madgwick starts at identity quaternion (1,0,0,0). If the chip is
      // tilted or sideways, the first Euler angles are wrong. Suppress both
      // baseline-setting and gesture detection until the filter converges.
      if (++ss.warmupCount >= WARMUP_SAMPLES) {
        ss.baseRoll  = roll;
        ss.basePitch = pitch;
        ss.baseYaw   = yaw;
        ss.motionState = MotionState::IDLE;
        timing.stillSinceMs = now;
        LOG_I("[IMU] warmup done, baseline: roll=%.1f pitch=%.1f yaw=%.1f",
              ss.baseRoll, ss.basePitch, ss.baseYaw);
      }
      return;  // skip raw stream + gesture detection during warmup

    case MotionState::IDLE:
      if (smoothGyroMag >= STILL_THRESH) {
        ss.motionState = MotionState::MOVING;
      }
      break;

    case MotionState::MOVING:
      if (smoothGyroMag < STILL_THRESH) {
        ss.motionState    = MotionState::STILL;
        timing.stillSinceMs = now;
      }
      break;

    case MotionState::STILL:
      if (smoothGyroMag >= STILL_THRESH) {
        // Moved again before we could rebase — back to MOVING.
        ss.motionState = MotionState::MOVING;
      } else if ((now - timing.stillSinceMs) > STILL_MS) {
        // Been still long enough.
        // FIX: no allArmedAgain check here — that check caused a deadlock
        // where a disarmed axis prevented rebase, which prevented re-arming.
        // We hold off only if a gesture fired very recently.
        bool holdoffOk = (now - timing.lastGestureMs) > REBASE_HOLDOFF_MS;
        if (holdoffOk) {
          ss.baseRoll  = roll;
          ss.basePitch = pitch;
          ss.baseYaw   = yaw;
          // Re-arm all axes: deltas are now zero by definition.
          ss.rollArmed = ss.pitchArmed = ss.yawArmed = true;
          LOG_D("[Still] rebased: roll=%.1f pitch=%.1f yaw=%.1f",
                ss.baseRoll, ss.basePitch, ss.baseYaw);
        }
        ss.motionState = MotionState::IDLE;
      }
      break;
  }

  // ── Raw stream (same format as BNO085 firmware) ───────────────────────────
  if (ss.rawMode && Bluefruit.Periph.connected()) {
    char buf[40] = {};
    snprintf(buf, sizeof(buf), "raw|%.1f|%.1f|%.1f", roll, pitch, yaw);
    gestureChar.notify(buf, 40);

    snprintf(buf, sizeof(buf), "gyr|%.3f|%.3f|%.3f", gx, gy, gz);
    gestureChar.notify(buf, 40);
  }

  // ── Gesture detection ─────────────────────────────────────────────────────
  float dRoll  = roll  - ss.baseRoll;
  float dPitch = pitch - ss.basePitch;
  float dYaw   = yaw   - ss.baseYaw;

  LOG_D("[IMU] r=%.1f p=%.1f y=%.1f  dr=%.1f dp=%.1f dy=%.1f",
        roll, pitch, yaw, dRoll, dPitch, dYaw);

  // Re-arm axes that returned within deadzone
  if (!ss.rollArmed  && fabsf(dRoll)  <= cfg.deadzoneDegs) ss.rollArmed  = true;
  if (!ss.pitchArmed && fabsf(dPitch) <= cfg.deadzoneDegs) ss.pitchArmed = true;
  if (!ss.yawArmed   && fabsf(dYaw)   <= cfg.deadzoneDegs) ss.yawArmed   = true;

  if ((now - timing.lastGestureMs) > cfg.debounceMs) {
    const char* gesture = nullptr;

    if (ss.rollArmed && fabsf(dRoll) > cfg.turnThreshold) {
      gesture = (dRoll > 0) ? "turn_right" : "turn_left";
      ss.rollArmed = false;
    } else if (ss.pitchArmed && fabsf(dPitch) > cfg.turnThreshold) {
      gesture = (dPitch > 0) ? "pitch_up" : "pitch_down";
      ss.pitchArmed = false;
    } else if (ss.yawArmed && fabsf(dYaw) > cfg.turnThreshold) {
      gesture = (dYaw > 0) ? "yaw_right" : "yaw_left";
      ss.yawArmed = false;
    }

    if (gesture) {
      char buf[40] = {};
      snprintf(buf, sizeof(buf), "%s|%.1f|%.1f|%.1f", gesture, roll, pitch, yaw);
      gestureChar.notify(buf, 40);
      timing.lastGestureMs = now;
      LOG_I("[Gesture] %s", gesture);
    }
  }

  // ── Keepalive ping ────────────────────────────────────────────────────────
  if (Bluefruit.Periph.connected() && (now - timing.lastPingMs > PING_INTERVAL_MS)) {
    timing.lastPingMs = now;
    gestureChar.notify("ping", 4);
  }
}
