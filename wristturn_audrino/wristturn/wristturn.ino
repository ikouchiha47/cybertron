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

#include "PowerManager.h"
#include "StillnessDetector.h"
#include "gesture/GestureDetector.h"
#include "log.h"
#include "mounting_adapter.h"
#include "shake_detector.h"
#include "state_packet.h"
#include <SparkFun_BNO08x_Arduino_Library.h>
#include <Wire.h>
#include <bluefruit.h>
#include <string.h> // for memcpy

// Wrist-mounted chip orientation. See mounting_adapter.h for encoding.
// Current mounting: roll=+roll, pitch=+pitch, yaw=-yaw.
MountingAdapter mountAdapter({1, 2, -3});

// ── Battery monitoring
// ──────────────────────────────────────────────────────── PIN_VBAT (32 /
// P0.31) already defined in variant.h — battery voltage divider
#define PIN_CHARGE_STATUS 17 // P0.17 — BQ25101 CHRG, active LOW = charging

const unsigned long BATTERY_POLL_MS = 30000; // read every 30s
unsigned long lastBatteryMs = 0;
uint8_t lastBatteryPct = 0;

float readBatteryVoltage() {
  analogReference(AR_INTERNAL_3_0);
  analogReadResolution(12);
  long sum = 0;
  for (int i = 0; i < 20; i++) {
    sum += analogRead(PIN_VBAT);
    delay(5);
  }
  float avgRaw = sum / 20.0f;
  // Divider: 1000k top / 510k bottom → ratio (1510/510).
  // XIAO nRF52840 has a consistent ~5% low-bias in ADC+ref tolerance;
  // CAL matches honvl/Seeed-Xiao-NRF52840-Battery community constant.
  const float CAL = 1.053f;
  return avgRaw * (3.0f / 4095.0f) * (1510.0f / 510.0f) * CAL;
}

// Battery voltage thresholds — tunable via BLE (19B10015/16)
// Defaults match standard LiPo: 4.2V full, 3.0V empty
float battVMax = 4.2f;
float battVMin = 3.0f;

uint8_t voltageToPercent(float v) {
  if (v >= battVMax)
    return 100;
  if (v <= battVMin)
    return 0;
  // piecewise: 3.0→3.7V = bottom 50%, 3.7→4.2V = top 50%
  float mid = battVMin + (battVMax - battVMin) * 0.583f; // ~3.7V
  if (v >= mid)
    return (uint8_t)(50.0f + (v - mid) / (battVMax - mid) * 50.0f);
  return (uint8_t)((v - battVMin) / (mid - battVMin) * 50.0f);
}

bool isCharging() { return digitalRead(PIN_CHARGE_STATUS) == LOW; }

// ── BLE setup (Bluefruit / Adafruit nRF52 stack) ─────────────────────────────
// Fixed payload sizes for BLE characteristics.
// Bluefruit requires notify() length to exactly match setFixedLen() /
// constructor len — shorter payloads are silently dropped. Pad with spaces
// before every notify() call.
#define GESTURE_CHAR_LEN 40
#define STATE_CHAR_LEN                                                         \
  80 // largest JSON event fits in 80 bytes; within 247-byte ATT MTU

BLEService wristService("19B10000-E8F2-537E-4F6C-D104768A1214");
BLECharacteristic gestureChar("19B10001-E8F2-537E-4F6C-D104768A1214",
                              BLERead | BLENotify, GESTURE_CHAR_LEN);
// stateChar: JSON-line notifications for arm/disarm + baseline-set events.
BLECharacteristic stateChar("19B10002-E8F2-537E-4F6C-D104768A1214",
                            BLERead | BLENotify, STATE_CHAR_LEN);
// baselineChar: current baseline roll/pitch/yaw as three little-endian floats.
BLECharacteristic baselineChar("19B10003-E8F2-537E-4F6C-D104768A1214",
                               BLERead | BLENotify, 12);

// Emit a per-axis arm/disarm event. Binary schema defined in state_packet.h.
// `axis` maps: "roll"→0, "pitch"→1, "yaw"→2. Unknown axis is ignored.
void emitState(const char *evt, const char *axis, const char *state, float d) {
  (void)evt; // reserved for future multi-event dispatch; today only ARM_EVT
             // uses this
  if (!axis || !state)
    return;

  uint8_t axisId;
  if (strcmp(axis, "roll") == 0)
    axisId = AXIS_ROLL;
  else if (strcmp(axis, "pitch") == 0)
    axisId = AXIS_PITCH;
  else if (strcmp(axis, "yaw") == 0)
    axisId = AXIS_YAW;
  else
    return;

  uint8_t stateId =
      (strcmp(state, "armed") == 0) ? ARM_STATE_ARMED : ARM_STATE_DISARMED;

  uint8_t buf[STATE_PACKET_MAX_LEN];
  uint8_t n = pkt_arm_evt(buf, axisId, stateId, d);
  stateChar.notify(buf, n);
}

void publishBaseline(float r, float p, float y) {
  float vals[3] = {r, p, y};
  baselineChar.write(vals, 12);
  baselineChar.notify(vals, 12);

  uint8_t buf[STATE_PACKET_MAX_LEN];
  uint8_t n = pkt_baseline(buf, r, p, y);
  stateChar.notify(buf, n);
}

// Standard BLE Battery Service (0x180F / 0x2A19)
BLEBas bleBattery;

// Settings service — writable from app
// debounceChar:   uint32, minimum ms between gestures (shake/tap)
// rawModeChar:    uint8, 0=gesture-only (default), 1=stream raw IMU
// battVMaxChar:   float, battery full voltage (default 4.2V)
// battVMinChar:   float, battery empty voltage (default 3.0V)
BLEService settingsService("19B10010-E8F2-537E-4F6C-D104768A1214");
BLECharacteristic debounceChar("19B10012-E8F2-537E-4F6C-D104768A1214",
                               BLERead | BLEWrite, 4);
BLECharacteristic rawModeChar("19B10014-E8F2-537E-4F6C-D104768A1214",
                              BLERead | BLEWrite, 1);
BLECharacteristic battVMaxChar("19B10015-E8F2-537E-4F6C-D104768A1214",
                               BLERead | BLEWrite, 4);
BLECharacteristic battVMinChar("19B10016-E8F2-537E-4F6C-D104768A1214",
                               BLERead | BLEWrite, 4);
// Interaction mode: 0=gesture (default), 1=knob, 2=symbol
BLECharacteristic modeChar("19B10018-E8F2-537E-4F6C-D104768A1214",
                           BLERead | BLEWrite, 1);
// Arm/disarm: 1=arm (capture baseline + enable rotation vector), 0=disarm
BLECharacteristic armChar("19B10019-E8F2-537E-4F6C-D104768A1214",
                          BLERead | BLEWrite, 1);
// Delta from baseline: 3x LE float [deltaRoll, deltaPitch, deltaYaw] in degrees
BLECharacteristic deltaChar("19B1001A-E8F2-537E-4F6C-D104768A1214",
                            BLERead | BLENotify, 12);

// ── IMU ──────────────────────────────────────────────────────────────────────
BNO08x imu;
constexpr int BNO085_INT_PIN = 1;  // XIAO D1 / P0.03
constexpr int BNO085_RST_PIN = -1; // not used

// ── Thresholds — tunable via BLE ─────────────────────────────────────────────
unsigned long debounceMs = 200; // min ms between gestures (kept for shake/tap)

// ── State ────────────────────────────────────────────────────────────────────
bool rawMode = false; // stream raw IMU on every rotation vector event
GestureDetector gestureDetector;

// Interaction modes (written by app via modeChar)
#define MODE_GESTURE 0
#define MODE_KNOB 1
#define MODE_SYMBOL 2
uint8_t currentMode = MODE_GESTURE;

// Arm state — when armed, baseline is captured via rolling-window calibration
bool armed = false;
float baselineRoll = 0.0f;
float basePitch_arm = 0.0f;
float baselineYaw = 0.0f;

// Calibration state globals
bool calibrationComplete =
    false;                     // set on first confirmed baseline after connect
bool baselineCaptured = false; // moved from static inside handleRotationVector

// Rolling-window calibration accumulator (populates during first stable window)
CalibrationBuffer calBuffer;
CalibrationBuffer stableCalBuffer;   // samples collected only during stab=3
bool calInProgress = false;
bool inStableWindow = false;
unsigned long calStartMs = 0;     // resets on every stab=3 — 3s from last stable moment
unsigned long calDeadlineMs = 0;  // hard deadline: set once on calInProgress, never resets
static constexpr unsigned long CAL_WINDOW_MS    = 3000;   // stable window length
static constexpr unsigned long CAL_DEADLINE_MS  = 12000;  // max total cal time
// #define CAL_LAST_WINDOW_ONLY  // uncomment to keep only the most recent stable window

// Deferred flags — set in callbacks/event handlers, consumed in loop() where
// I2C is safe. Never do I2C (enableReport, modeOn, etc.) from inside a BLE
// callback or an IMU event handler — those run inside
// getSensorEvent()/SoftDevice context. Set a flag instead; loop() picks it up
// on the next iteration (same pattern as Go's select-on-channel).
static volatile bool pendingEnableReports = false;
static volatile bool pendingExitSleep = false;

// Last logged stability value — used to suppress duplicate logs and drive
// heartbeat. Initialised to 1 (on_table) so the very first post-connect
// heartbeat has a valid value to re-emit even if no stab event fired before the
// first connection.
static uint8_t lastLoggedStab = 1;

// Delta rate limiter — emit at most every 20ms (~50Hz)
unsigned long lastDeltaMs = 0;

// Gravity-based arm pose — reset to sentinel on connect so first stable reading
// always emits.
static uint8_t lastStableGravPose = UINT8_MAX;

// Last known Euler angles — updated every rotation vector event for stability
// rebase
float lastRoll = 0.0f;
float lastPitch = 0.0f;
float lastYaw = 0.0f;

// Stillness detector — swap implementation without touching event handlers
StabilityClassifierDetector _stabDetector;
IStillnessDetector *stillDetector = &_stabDetector;

unsigned long lastPingMs = 0;
const unsigned long PING_INTERVAL_MS = 3000;
ShakeDetector shake;

// ── Adaptive rotation-vector rate ────────────────────────────────────────────
// 50Hz (20ms) when motion detected; drops to 10Hz (100ms) after device has
// been still (stab ≤ 2) for IDLE_RATE_DROP_MS.
static constexpr uint32_t RV_INTERVAL_ACTIVE_MS = 20;   // 50Hz
static constexpr uint32_t RV_INTERVAL_IDLE_MS   = 100;  // 10Hz
static constexpr unsigned long IDLE_RATE_DROP_MS = 5000; // 5s still → drop rate
static bool     rvAtIdleRate    = false;
static unsigned long rvIdleSinceMs = 0; // when device first went still

// ── Sleep / wake
// ────────────────────────────────────────────────────────────── Define
// DEBUG_SLEEP to use 30s timeout for bench testing sleep/wake via serial.
// #define DEBUG_SLEEP
#ifdef DEBUG_SLEEP
const unsigned long SLEEP_TIMEOUT_MS = 30UL * 1000UL; // 30 seconds (test)
#else
const unsigned long SLEEP_TIMEOUT_MS =
    5UL * 60UL * 1000UL; // 5 minutes (production)
#endif
bool sleeping = false;
unsigned long lastMotionMs = 0;
unsigned long sleepStartMs = 0; // when enterSleep() was called
static const unsigned long MIN_SLEEP_MS = 10000;

// ── PowerManager wiring ──────────────────────────────────────────────────────
// Concrete IHardware that delegates to the BNO085 driver.
// drainFifo(): polls getSensorEvent() for msMax ms, tracking the last event ID.
// Breaks early on INT going HIGH (all events drained) to avoid over-spinning.
struct WristTurnHW : IHardware {
  uint8_t _lastId = 0;

  void modeSleep() override { imu.modeSleep(); }

  void modeOn() override { imu.modeOn(); delay(50); }

  void drainFifo(uint32_t msMax) override {
    _lastId = 0;
    unsigned long start = millis();
    while ((millis() - start) < msMax) {
      if (imu.getSensorEvent()) {
        uint8_t eid = imu.getSensorEventID();
        if (eid) {
          _lastId = eid;
          if (eid == WAKE_SENSOR_SHAKE || eid == WAKE_SENSOR_SIGMOTION)
            break;
        }
      }
      if (digitalRead(BNO085_INT_PIN) == HIGH && (millis() - start) > 20)
        break;
      delayMicroseconds(2000);
    }
  }

  bool configureSensor(uint8_t sensorId, uint32_t intervalUs,
                       bool wakeupEnabled) override {
    sh2_SensorConfig_t cfg = {};
    cfg.reportInterval_us = intervalUs;
    cfg.wakeupEnabled = wakeupEnabled;
    return sh2_setSensorConfig((sh2_SensorId_t)sensorId, &cfg) == SH2_OK;
  }

  uint8_t lastDrainedEventId() override { return _lastId; }
  bool    intPinLow()          override { return digitalRead(BNO085_INT_PIN) == LOW; }
  uint32_t nowMs()             override { return (uint32_t)millis(); }
};

WristTurnHW         hw;
ShakeSleepPolicy    shakePol(30000);   // 30 s light-sleep cycles
SigMotionSleepPolicy sigMotPol;
StagedPolicy        staged;
PowerManager        powerMgr;

// ── Helpers ──────────────────────────────────────────────────────────────────
float quaternionToRoll(float w, float x, float y, float z) {
  float sinr = 2.0f * (w * x + y * z);
  float cosr = 1.0f - 2.0f * (x * x + y * y);
  return atan2f(sinr, cosr);
}

float quaternionToPitch(float w, float x, float y, float z) {
  float sinp = 2.0f * (w * y - z * x);
  if (fabsf(sinp) >= 1.0f)
    return copysignf(M_PI / 2.0f, sinp);
  return asinf(sinp);
}

float quaternionToYaw(float w, float x, float y, float z) {
  float siny = 2.0f * (w * z + x * y);
  float cosy = 1.0f - 2.0f * (y * y + z * z);
  return atan2f(siny, cosy);
}

// Feature flags — comment out to disable
#define ENABLE_TAP
#define ENABLE_SHAKE // uses linear accelerometer
// #define ENABLE_STEP
#define ENABLE_GRYO

// ── Shake-to-wake report interval ────────────────────────────────────────────
// Controls the BNO085 native shake detector's reportInterval_us in modeSleep().
//
// OPTION A (default): 2000000 µs (0.5 Hz). Longer interval → fewer ack events
//   during the MIN_SLEEP_MS drain window → less spurious activity. Max wake
//   latency after a real shake: ~2 s.
//
// OPTION B (#define SOFT_SHAKE_WAKE): 200000 µs (5 Hz). Original behaviour —
//   same code as before logs.35. Use this to compare against Option A.
//
// #define SOFT_SHAKE_WAKE

#ifdef SOFT_SHAKE_WAKE
static constexpr uint32_t SHAKE_WAKE_INTERVAL_US = 200000;  // 5 Hz — original
#else
static constexpr uint32_t SHAKE_WAKE_INTERVAL_US = 2000000; // 0.5 Hz — Option A
#endif

void enableReports() {
  // Reset adaptive rate state — always start at 50Hz on arm/wake.
  rvAtIdleRate  = false;
  rvIdleSinceMs = 0;

  LOG_I("[Reports] enable start rawMode=%d armed=%d sleeping=%d", rawMode,
        armed, sleeping);
  LOG_I("[Reports] INT pin %d level before config=%d", BNO085_INT_PIN,
        digitalRead(BNO085_INT_PIN));
  // Rotation vector needed for rawMode streaming or when armed (knob/symbol
  // modes)
  if (rawMode || armed) {
    if (imu.enableRotationVector(RV_INTERVAL_ACTIVE_MS))
      LOG_I("[Reports] rotation vector enabled at %ums (%uHz)",
            RV_INTERVAL_ACTIVE_MS, 1000 / RV_INTERVAL_ACTIVE_MS);
    else
      LOG_E("BNO085: could not enable Rotation Vector");
  }
#ifdef ENABLE_SHAKE
  if (imu.enableLinearAccelerometer())
    LOG_I("[Reports] linear accelerometer enabled");
  else
    LOG_E("BNO085: could not enable Linear Accelerometer");
#endif
#ifdef ENABLE_TAP
  if (imu.enableTapDetector(100))
    LOG_I("[Reports] tap detector enabled");
  else
    LOG_E("BNO085: could not enable Tap Detector");
#endif
#ifdef ENABLE_STEP
  if (imu.enableStepCounter(1000))
    LOG_I("[Reports] step counter enabled");
  else
    LOG_E("BNO085: could not enable Step Counter");
#endif
#ifdef ENABLE_GRYO
  if (imu.enableGyro())
    LOG_I("[Reports] gyro enabled");
  else
    LOG_E("BN0085: could not enable gyro");
#endif
  if (imu.enableStabilityClassifier(500))
    LOG_I("[Reports] stability classifier enabled");
  else
    LOG_E("BNO085: could not enable Stability Classifier");
}

// ── BLE write callbacks
// ───────────────────────────────────────────────────────
void onDebounceWrite(uint16_t conn_hdl, BLECharacteristic *chr, uint8_t *data,
                     uint16_t len) {
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

void onRawModeWrite(uint16_t conn_hdl, BLECharacteristic *chr, uint8_t *data,
                    uint16_t len) {
  if (len == 1) {
    bool newMode = (data[0] != 0);
    if (newMode != rawMode) {
      rawMode = newMode;
      if (rawMode) {
        imu.enableRotationVector(20);
      } else {
        imu.enableReport(SENSOR_REPORTID_ROTATION_VECTOR, 0);
      }
    }
    LOG_I("[Settings] rawMode=%d", rawMode);
  }
}

void onBattVMaxWrite(uint16_t conn_hdl, BLECharacteristic *chr, uint8_t *data,
                     uint16_t len) {
  if (len == 4) {
    float val;
    memcpy(&val, data, 4);
    if (val > battVMin && val <= 4.35f) {
      battVMax = val;
      LOG_I("[Settings] battVMax updated: %.2fV", battVMax);
    } else {
      LOG_E("[Settings] battVMax out of range: %.2f (must be battVMin..4.35)",
            val);
    }
  }
}

void onBattVMinWrite(uint16_t conn_hdl, BLECharacteristic *chr, uint8_t *data,
                     uint16_t len) {
  if (len == 4) {
    float val;
    memcpy(&val, data, 4);
    if (val >= 2.5f && val < battVMax) {
      battVMin = val;
      LOG_I("[Settings] battVMin updated: %.2fV", battVMin);
    } else {
      LOG_E("[Settings] battVMin out of range: %.2f (must be 2.5..battVMax)",
            val);
    }
  }
}

void onModeWrite(uint16_t conn_hdl, BLECharacteristic *chr, uint8_t *data,
                 uint16_t len) {
  if (len == 1 && data[0] <= MODE_SYMBOL) {
    currentMode = data[0];
    LOG_I("[Mode] switched to %d (0=gesture,1=knob,2=symbol)", currentMode);
  }
}

void onArmWrite(uint16_t conn_hdl, BLECharacteristic *chr, uint8_t *data,
                uint16_t len) {
  if (len != 1)
    return;
  bool newArmed = (data[0] != 0);
  if (newArmed == armed)
    return;
  armed = newArmed;
  if (armed) {
    pendingEnableReports = true;
    LOG_I("[Arm] queued report enable");
    // If we already have a captured baseline and calibration not yet marked
    // complete, confirm it now
    if (baselineCaptured && !calibrationComplete) {
      calibrationComplete = true;
      LOG_I("[Cal] calibration confirmed via arm");
    }
    LOG_I("[Arm] armed");
  } else {
    // Disarm: only clear baseline and calibration state if calibration not
    // complete
    if (!calibrationComplete) {
      if (!rawMode) {
        imu.enableReport(SENSOR_REPORTID_ROTATION_VECTOR, 0);
      }
      baselineRoll = 0.0f;
      basePitch_arm = 0.0f;
      baselineYaw = 0.0f;
      float zeros[3] = {0, 0, 0};
      deltaChar.write(zeros, 12);
      publishBaseline(0, 0, 0);
      LOG_I("[Arm] disarmed — rotation vector disabled");
      calBuffer.reset();
      stableCalBuffer.reset();
      calInProgress = false;
      inStableWindow = false;
    } else {
      // Calibration already done: keep baseline, just disable rotation vector
      // if not rawMode
      if (!rawMode) {
        imu.enableReport(SENSOR_REPORTID_ROTATION_VECTOR, 0);
      }
      LOG_I("[Arm] disarmed — baseline retained (calibration complete)");
    }
  }
}

// Baseline write from app — overwrites current baseline immediately
void onBaselineWrite(uint16_t conn_hdl, BLECharacteristic *chr, uint8_t *data,
                     uint16_t len) {
  if (len != 12) {
    LOG_E("[Baseline] write invalid length: %u", len);
    return;
  }
  float r, p, y;
  memcpy(&r, data, 4);
  memcpy(&p, data + 4, 4);
  memcpy(&y, data + 8, 4);

  // Special magic value to trigger a fresh recalibration without disconnecting
  if (r == -999.0f && p == -999.0f && y == -999.0f) {
    calibrationComplete = false;
    baselineCaptured = false;
    calInProgress = false;
    inStableWindow = false;
    calBuffer.reset();
    stableCalBuffer.reset();
    LOG_I("[Cal] calibration cleared by app — awaiting new flat pose");
    return;
  }

  baselineRoll = r;
  basePitch_arm = p;
  baselineYaw = y;
  baselineCaptured = true;
  // If armed, this write also confirms calibration (first write after connect)
  if (armed && !calibrationComplete) {
    calibrationComplete = true;
    LOG_I("[Cal] calibration confirmed via baseline write");
  }
  LOG_I("[Baseline] overwritten by app: r=%.1f p=%.1f y=%.1f", r, p, y);
}

// Forward declaration — blinkLED is defined later in the file
void blinkLED(int pin, int times, int onMs, int offMs);

// ── Sleep / wake helpers
// ──────────────────────────────────────────────────────
void enterSleep() {
  if (sleeping)
    return;
  sleeping = true;
  sleepStartMs = millis();
  LOG_I("[Sleep] inactivity timeout — entering light sleep (armed=%d "
        "lastMotionAge=%lums)",
        armed, millis() - lastMotionMs);
  if (Bluefruit.Periph.connected()) {
    uint8_t sbuf[STATE_PACKET_MAX_LEN];
    uint8_t sn = pkt_sleep(sbuf);
    stateChar.notify(sbuf, sn);
    delay(80); // let the notification flush before disconnect
    Bluefruit.disconnect(0);
    delay(50);
  }
  // ── Power-optimised sleep: stop advertising entirely ──────────────────
  // Wake path: PowerManager.tick() runs a software timer (30s cycles).
  // On each cycle: modeOn() + drain FIFO + check for shake (0x19). If found
  // → exitSleep() + advertising restarts at fast interval for reconnect.
  // After 4.5 min: transitions to SigMotion deep sleep (always-on INT wake).
  //
  // Trade-off: phone cannot reconnect via BLE while sleeping. User must
  // shake to wake first, then the phone can reconnect within a few seconds.
  Bluefruit.Advertising.stop();

  // Clear arm state on sleep — app re-arms when waking
  if (armed) {
    armed = false;
    float zeros[3] = {0, 0, 0};
    deltaChar.write(zeros, 12);
  }

  // Disable high-frequency reports — SH-2 protocol: reportInterval_us = 0 stops
  // the report. The library has no disable* methods; enableReport(..., 0) is
  // the correct approach. NOTE: do NOT call enableReport on TAP_DETECTOR with 0
  // — for event sensors, 0 ARMS them.
  imu.enableReport(SENSOR_REPORTID_ROTATION_VECTOR, 0);
  imu.enableReport(SENSOR_REPORTID_LINEAR_ACCELERATION, 0);
  imu.enableReport(SENSOR_REPORTID_STABILITY_CLASSIFIER, 0);
  imu.enableReport(SENSOR_REPORTID_GYROSCOPE_CALIBRATED, 0);
  // Drain FIFO: clear any ack events from the enableReport(0) calls above
  // so INT goes HIGH before modeSleep(). This prevents immediate false wakes.
  {
    uint8_t preDrained = 0;
    unsigned long drainStart = millis();
    while (digitalRead(BNO085_INT_PIN) == LOW && (millis() - drainStart) < 300) {
      imu.getSensorEvent();
      preDrained++;
      delayMicroseconds(2000);
    }
    LOG_I("[Sleep] pre-sleep drain: %u cycles, INT=%d", preDrained,
          digitalRead(BNO085_INT_PIN));
  }

  blinkLED(LED_BLUE, 1, 80, 0);
  // Hand off to PowerManager: starts staged policy (ShakeSleepPolicy → SigMotion)
  powerMgr.onInactivity(hw);
}

void exitSleep() {
  if (!sleeping)
    return;
  sleeping = false;
  lastMotionMs = millis();
  LOG_I("[Sleep] waking — restoring reports");

  // PowerManager.tick() already called modeOn() + drainFifo() before returning
  // true. If exitSleep is called from onConnect() (BLE reconnect path), the hub
  // may not have been woken yet — modeOn() is idempotent, safe to call again.
  imu.modeOn();
  delay(50); // settle time

  // Safety-net drain in case onConnect() woke us without a prior modeOn/drain.
  uint8_t drained = 0;
  unsigned long drainStart = millis();
  while (digitalRead(BNO085_INT_PIN) == 0 && (millis() - drainStart) < 200) {
    imu.getSensorEvent();
    drained++;
    delayMicroseconds(2000);
  }
  if (drained > 0) {
    LOG_I("[Sleep] exitSleep drained %u residual events, INT=%d", drained,
          digitalRead(BNO085_INT_PIN));
  }

  enableReports(); // restores all reports at their original rates
  LOG_I("[Sleep] reports restored — restarting BLE advertising for reconnect");
  // Advertising was fully stopped in enterSleep() — restart at fast interval
  Bluefruit.Advertising.setInterval(32, 244);
  Bluefruit.Advertising.start(0);
  blinkLED(LED_BLUE, 2, 60, 60);
}

// ── BLE callbacks
// ─────────────────────────────────────────────────────────────
void onConnect(uint16_t conn_hdl) {
  // ── Guard: reject spurious reconnect right after sleep ────────────────
  // Race condition: onDisconnect() restarts advertising, enterSleep() stops
  // it ~50ms later. In that window the phone begins a BLE handshake that
  // completes ~1-2s later, triggering onConnect while we're sleeping.
  // Without this guard, exitSleep() fires, the phone auto-arms, and the
  // next sleep cycle leaves the BNO085 shake detector in a bad state.
  if (sleeping) {
    unsigned long elapsed = millis() - sleepStartMs;
    if (elapsed < MIN_SLEEP_MS) {
      LOG_I("[Sleep] spurious BLE connect %lums after sleep — rejecting",
            elapsed);
      Bluefruit.disconnect(conn_hdl);
      Bluefruit.Advertising.stop(); // prevent further reconnect attempts
      return;
    }
    // Legitimate wake-then-connect: proceed with exitSleep
    exitSleep();
  }

  lastMotionMs = millis();
  lastPingMs = 0; // fire stab heartbeat within PING_INTERVAL_MS of connect
  lastStableGravPose =
      UINT8_MAX; // force PKT_GRAV emit on first stable pose after connect
  // Do NOT reset lastLoggedStab here — BNO085 only fires stab on class change,
  // so if the class didn't change across reconnect, no new event arrives and
  // the heartbeat (which guards on lastLoggedStab <= 4) would never re-emit.
  if (!sleeping) {
    // Not sleeping (either we just exited, or we were never sleeping)
    pendingEnableReports =
        true; // defer I2C ops to loop() — unsafe in BLE callback
  }
  LOG_I("BLE connected. conn_hdl=%u peers=%u", conn_hdl,
        Bluefruit.Periph.connected());
  LOG_I("[Settings] current: debounce=%lu ms", debounceMs);
}

void onDisconnect(uint16_t conn_hdl, uint8_t reason) {
  LOG_I("BLE disconnected. conn_hdl=%u reason=0x%02X", conn_hdl, reason);
  // Reset calibration state for fresh start on next connect
  calibrationComplete = false;
  baselineCaptured = false;
  calInProgress = false;
  inStableWindow = false;
  calBuffer.reset();
  stableCalBuffer.reset();
  // Don't restart advertising if we're sleeping — enterSleep() already
  // stopped it, and restarting here creates a race where the phone
  // reconnects before enterSleep() can stop advertising again.
  if (sleeping) {
    LOG_I("BLE disconnect while sleeping — advertising stays off.");
  } else {
    Bluefruit.Advertising.start(0);
    LOG_I("BLE advertising restarted.");
  }
}

// ── Setup
// ─────────────────────────────────────────────────────────────────────
void blinkLED(int pin, int times, int onMs = 150, int offMs = 150) {
  pinMode(pin, OUTPUT);
  for (int i = 0; i < times; i++) {
    digitalWrite(pin, HIGH); // LED_STATE_ON = HIGH on XIAO nRF52840
    delay(onMs);
    digitalWrite(pin, LOW);
    delay(offMs);
  }
}

void setup() {
  // Blink blue 3 times at boot — visible confirmation firmware is running
  // whether on USB or battery power (no serial monitor needed)
  blinkLED(LED_BLUE, 5); // 5 blinks = new firmware confirmed

  Serial.begin(115200);

  // ── Power optimizations ───────────────────────────────────────────────────
  // Disable onboard PDM microphone (XIAO nRF52840 Sense: mic power on P1.10)
  // Saves ~1.5mA continuously. Must be done before Wire.begin().
  pinMode(PIN_PDM_PWR, OUTPUT);
  digitalWrite(PIN_PDM_PWR, LOW);

  // Battery monitoring pins
  pinMode(VBAT_ENABLE, OUTPUT);
  digitalWrite(VBAT_ENABLE,
               LOW); // hold LOW permanently — divider draws only ~3µA
  pinMode(PIN_CHARGE_STATUS, INPUT_PULLUP);

  // Disable onboard LSM6DS3TR-C — not used (BNO085 is external IMU).
  // Hold it in power-down by never calling Wire.begin() for its address,
  // but we also pull its VDD line low via its CS pin to cut quiescent current.
  // The LSM6DS3 enters power-down automatically if not configured; ~6µA in that
  // state.

  // Set BLE TX power to minimum — adequate for wrist-to-laptop distances (<2m).
  // sd_ble_gap_tx_power_set() equivalent via Bluefruit: done after
  // Bluefruit.begin().

  // ── IMU init ──
  // I2C bus recovery: DFU/reset can interrupt a transaction, leaving SDA stuck
  // low. Full recovery: STOP condition → 9 SCL pulses → STOP condition → reinit
  // Wire.
  Wire.end();
  pinMode(PIN_WIRE_SDA, OUTPUT);
  pinMode(PIN_WIRE_SCL, OUTPUT);
  // STOP: SDA low → SCL high → SDA high
  digitalWrite(PIN_WIRE_SDA, LOW);
  delayMicroseconds(20);
  digitalWrite(PIN_WIRE_SCL, HIGH);
  delayMicroseconds(20);
  digitalWrite(PIN_WIRE_SDA, HIGH);
  delayMicroseconds(20);
  // 9 clock pulses to release stuck slave
  pinMode(PIN_WIRE_SDA, INPUT_PULLUP);
  for (int i = 0; i < 9; i++) {
    digitalWrite(PIN_WIRE_SCL, LOW);
    delayMicroseconds(20);
    digitalWrite(PIN_WIRE_SCL, HIGH);
    delayMicroseconds(20);
  }
  // Final STOP
  pinMode(PIN_WIRE_SDA, OUTPUT);
  digitalWrite(PIN_WIRE_SDA, LOW);
  delayMicroseconds(20);
  digitalWrite(PIN_WIRE_SCL, HIGH);
  delayMicroseconds(20);
  digitalWrite(PIN_WIRE_SDA, HIGH);
  delayMicroseconds(20);
  delay(50);
  Wire.begin();
  delay(100);
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
  if (found == 0)
    LOG_E("I2C: no devices found.");
  LOG_D("I2C scan done.");
  blinkLED(LED_BLUE, 2, 100, 100); // ★ 2 blinks = I2C recovered

  bool imuOk = false;
  for (int attempt = 0; attempt < 5 && !imuOk; attempt++) {
    // Using 2-arg begin: INT pin is physically wired but the Cortex library's
    // hal_wait_for_int() has a race condition — it waits for INT *before*
    // sending enableReport(), so the BNO08x never receives the command and
    // never asserts INT. Skipping INT pin in begin() bypasses that check and
    // works reliably.
    if (imu.begin(0x4B, Wire) || imu.begin(0x4A, Wire)) {
      imuOk = true;
      break;
    }
    LOG_E("BNO085 not found (attempt %d/5), retrying...", attempt + 1);
    delay(200);
  }
  if (!imuOk) {
    LOG_E("BNO085 not found - check wiring!");
    while (true) {
      blinkLED(LED_RED, 3, 100, 100);
      delay(500);
    }
  }
  LOG_I("BNO085 ready.");
  LOG_I("[IMU] INT pin %d level after begin=%d", BNO085_INT_PIN,
        digitalRead(BNO085_INT_PIN));

  // Attach interrupt on BNO085 INT pin so waitForEvent() wakes when IMU data
  // is ready. We do NOT pass INT to imu.begin() (see CLAUDE.md for why), but
  // we still need this for CPU wake from low-power sleep.
  pinMode(BNO085_INT_PIN, INPUT_PULLUP);
  attachInterrupt(digitalPinToInterrupt(BNO085_INT_PIN), []() {}, FALLING);

  enableReports();
  blinkLED(LED_BLUE, 3, 100, 100); // ★ 3 blinks = IMU ready

  // ── BLE init ──
  LOG_I("BLE init...");
  Bluefruit.begin();
  Bluefruit.setTxPower(
      -20); // dBm: -40,-20,-16,-12,-8,-4,0,4. -20 sufficient for <2m
  Bluefruit.setName("RUNE-I");
  Bluefruit.Periph.setConnInterval(6, 12);
  Bluefruit.Periph.setConnSupervisionTimeout(200);
  LOG_I("BLE supervision timeout set to 2s.");

  // Battery service (must begin before advertising)
  bleBattery.begin();

  // Read and log initial battery state
  float v = readBatteryVoltage();
  lastBatteryPct = voltageToPercent(v);
  bleBattery.write(lastBatteryPct);
  LOG_I("[Battery] %.2fV  %u%%  charging=%d", v, lastBatteryPct, isCharging());

  // Gesture service
  wristService.begin();
  gestureChar.setProperties(CHR_PROPS_READ | CHR_PROPS_NOTIFY);
  gestureChar.setPermission(SECMODE_OPEN, SECMODE_NO_ACCESS);
  gestureChar.setFixedLen(GESTURE_CHAR_LEN);
  gestureChar.begin();
  gestureChar.write("idle                                   ", 40);

  // stateChar — JSON line events (arm/disarm/baseline/stab/pose)
  // Use variable-length (setMaxLen) not setFixedLen — fixed-len forces every
  // notification to be exactly STATE_CHAR_LEN bytes, which gets silently
  // dropped when the negotiated ATT MTU is smaller than that (e.g. 23 on some
  // MediaTek devices). Variable-length lets us notify only the JSON we emit.
  stateChar.setProperties(CHR_PROPS_READ | CHR_PROPS_NOTIFY);
  stateChar.setPermission(SECMODE_OPEN, SECMODE_NO_ACCESS);
  stateChar.setMaxLen(STATE_CHAR_LEN);
  stateChar.begin();
  stateChar.write("{}", 2);

  // baselineChar — 3 floats, little-endian; writable by app to set baseline
  baselineChar.setProperties(CHR_PROPS_READ | CHR_PROPS_NOTIFY |
                             CHR_PROPS_WRITE);
  baselineChar.setPermission(SECMODE_OPEN, SECMODE_OPEN);
  baselineChar.setFixedLen(12);
  baselineChar.setWriteCallback(onBaselineWrite);
  baselineChar.begin();
  {
    float zeros[3] = {0, 0, 0};
    baselineChar.write(zeros, 12);
  }

  // Settings service
  settingsService.begin();

  debounceChar.setProperties(CHR_PROPS_READ | CHR_PROPS_WRITE);
  debounceChar.setPermission(SECMODE_OPEN, SECMODE_OPEN);
  debounceChar.setFixedLen(4);
  debounceChar.setWriteCallback(onDebounceWrite);
  debounceChar.begin();
  uint32_t dms = (uint32_t)debounceMs;
  debounceChar.write(&dms, 4);

  rawModeChar.setProperties(CHR_PROPS_READ | CHR_PROPS_WRITE);
  rawModeChar.setPermission(SECMODE_OPEN, SECMODE_OPEN);
  rawModeChar.setFixedLen(1);
  rawModeChar.setWriteCallback(onRawModeWrite);
  rawModeChar.begin();
  uint8_t rm = 0;
  rawModeChar.write(&rm, 1);

  battVMaxChar.setProperties(CHR_PROPS_READ | CHR_PROPS_WRITE);
  battVMaxChar.setPermission(SECMODE_OPEN, SECMODE_OPEN);
  battVMaxChar.setFixedLen(4);
  battVMaxChar.setWriteCallback(onBattVMaxWrite);
  battVMaxChar.begin();
  battVMaxChar.write(&battVMax, 4);

  battVMinChar.setProperties(CHR_PROPS_READ | CHR_PROPS_WRITE);
  battVMinChar.setPermission(SECMODE_OPEN, SECMODE_OPEN);
  battVMinChar.setFixedLen(4);
  battVMinChar.setWriteCallback(onBattVMinWrite);
  battVMinChar.begin();
  battVMinChar.write(&battVMin, 4);

  modeChar.setProperties(CHR_PROPS_READ | CHR_PROPS_WRITE);
  modeChar.setPermission(SECMODE_OPEN, SECMODE_OPEN);
  modeChar.setFixedLen(1);
  modeChar.setWriteCallback(onModeWrite);
  modeChar.begin();
  modeChar.write(&currentMode, 1);

  armChar.setProperties(CHR_PROPS_READ | CHR_PROPS_WRITE);
  armChar.setPermission(SECMODE_OPEN, SECMODE_OPEN);
  armChar.setFixedLen(1);
  armChar.setWriteCallback(onArmWrite);
  armChar.begin();
  uint8_t armVal = 0;
  armChar.write(&armVal, 1);

  deltaChar.setProperties(CHR_PROPS_READ | CHR_PROPS_NOTIFY);
  deltaChar.setPermission(SECMODE_OPEN, SECMODE_NO_ACCESS);
  deltaChar.setFixedLen(12);
  deltaChar.begin();
  {
    float zeros[3] = {0, 0, 0};
    deltaChar.write(zeros, 12);
  }

  Bluefruit.Advertising.addFlags(BLE_GAP_ADV_FLAGS_LE_ONLY_GENERAL_DISC_MODE);
  Bluefruit.Advertising.addTxPower();
  Bluefruit.Advertising.addService(wristService);
  Bluefruit.Advertising.addService(bleBattery);
  Bluefruit.ScanResponse.addName();
  Bluefruit.Periph.setConnectCallback(onConnect);
  Bluefruit.Periph.setDisconnectCallback(onDisconnect);
  Bluefruit.Advertising.restartOnDisconnect(true);
  Bluefruit.Advertising.start(0);
  lastMotionMs = millis();

  // ── PowerManager: assemble staged sleep policy ──────────────────────────
  // Stage 0: light sleep (shake-based, software timer, 30s cycles) for 4.5 min.
  // Stage 1: deep sleep (SH2_SIGNIFICANT_MOTION with wakeupEnabled) forever.
  staged.addStage(&shakePol, 270UL * 1000UL);  // 4.5 min = 270 s
  staged.addStage(&sigMotPol, 0);
  powerMgr.policy = &staged;

  LOG_I("BLE advertising as 'RUNE-I'.");
  blinkLED(LED_BLUE, 4, 100, 100); // ★ 4 blinks = setup complete, entering loop
}

// ── IMU event handlers
// ──────────────────────────────────────────────────────── One function per
// sensor report. Registered in IMU_HANDLERS dispatch table below. Adding a new
// sensor = add a handler function + one entry in the table.

#ifdef ENABLE_SHAKE
static void handleLinearAcceleration() {
  float ax = imu.getLinAccelX();
  float ay = imu.getLinAccelY();
  float az = imu.getLinAccelZ();
  float mag = sqrtf(ax * ax + ay * ay + az * az);

  // ── DIAG: Log accel magnitude every 20 samples (~2 Hz) ───────────────
  // ShakeDetector threshold: ACCEL_THRESHOLD_MS2 = 2.5 m/s² (~0.25g).
  // If mag stays below 2.5 during shake attempts, the threshold is still too
  // high.
  {
    static unsigned long shakeDiagCount = 0;
    if (++shakeDiagCount % 20 == 0 && Bluefruit.Periph.connected()) {
      LOG_I("[ShakeDiag] ax=%.2f ay=%.2f az=%.2f mag=%.2f (thresh=%.1f)", ax,
            ay, az, mag, ShakeDetector::ACCEL_THRESHOLD_MS2);
    }
  }

  if (shake.update(ax, ay, az)) {
    char buf[40] = {};
    snprintf(buf, sizeof(buf), "shake");
    LOG_I("%s", buf);
    gestureChar.notify(buf, 40);
    lastMotionMs = millis();
  }
}
#endif

#ifdef ENABLE_TAP
static void handleTapDetector() {
  char buf[40] = {};
  snprintf(buf, sizeof(buf), "tap");
  LOG_I("%s", buf);
  gestureChar.notify(buf, 40);
  lastMotionMs = millis();
}
#endif

#ifdef ENABLE_STEP
static void handleStepCounter() {
  uint16_t steps = imu.getStepCount();
  char buf[40] = {};
  snprintf(buf, sizeof(buf), "step|%u", steps);
  LOG_I("%s", buf);
  gestureChar.notify(buf, 40);
}
#endif

#ifdef ENABLE_GRYO
static void handleGyroCalibrated() {
  float gx = imu.getGyroX();
  float gy = imu.getGyroY();
  float gz = imu.getGyroZ();
  mountAdapter.transform(gx, gy, gz);

  if (rawMode && Bluefruit.Periph.connected()) {
    char buf[40] = {};
    snprintf(buf, sizeof(buf), "gyr|%.3f|%.3f|%.3f", gx, gy, gz);
    gestureChar.notify(buf, 40);
  }

  // ── DIAG: Sampled gyro + axis-state logging ─────────────────────────
  // Fires ~1/50 samples (~1 Hz at 50 Hz gyro rate) to show why movements
  // are rejected. Current AxisDetector/GestureArbitrator thresholds:
  //   JERK_ONSET_THRESHOLD  = 3.0 rad/s²  (jerk to enter ONSET)
  //   INTEGRAL_THRESHOLD    = 0.15 rad    (~8.6°) to enter PEAK
  //   MIN_INTEGRAL          = 0.20 rad    (~11.5°) to pass arbitrator
  {
    static unsigned long gyroDiagCount = 0;
    if (++gyroDiagCount % 50 == 0 && Bluefruit.Periph.connected()) {
      auto rs = gestureDetector.rollState();
      auto ps = gestureDetector.pitchState();
      auto ys = gestureDetector.yawState();
      const char *sname[] = {"IDLE", "ONSET", "PEAK", "DECAY"};
      LOG_I("[GyroDiag] gx=%.3f gy=%.3f gz=%.3f | R:%s P:%s Y:%s", gx, gy, gz,
            sname[(uint8_t)rs], sname[(uint8_t)ps], sname[(uint8_t)ys]);
    }
  }

  const char *gesture = gestureDetector.update(gx, gy, gz);
  if (gesture) {
    float integ = gestureDetector.lastIntegral();
    float peakRate = gestureDetector.lastPeakRate();
    char buf[GESTURE_CHAR_LEN] = {};
    snprintf(buf, sizeof(buf), "%s|%.2f|%.2f|%.2f|%.2f|%.2f", gesture, gx, gy,
             gz, integ, peakRate);
    gestureChar.notify(buf, GESTURE_CHAR_LEN);
    lastMotionMs = millis();
    _stabDetector.markMotion(lastMotionMs);
    LOG_I("[Gesture] %s gx=%.2f gy=%.2f gz=%.2f integ=%.2f peak=%.2f", gesture,
          gx, gy, gz, integ, peakRate);
  } else {
    const ArbDebug& d = gestureDetector.lastArbDebug();
    if (d.hadCandidate && d.reject != ArbReject::NO_CAND) {
      static const char* axName[] = {"roll", "pitch", "yaw"};
      static const char* rejName[] = {"ok", "no_cand", "min_integ", "ratio"};
      LOG_I("[ArbReject] axis=%s integ=%.3f otherSum=%.3f ratio=%.2f reason=%s",
            axName[(uint8_t)d.dominantAxis],
            d.dominantInteg, d.otherSum, d.ratio,
            rejName[(uint8_t)d.reject]);
    }
  }
}
#endif

static void handleSleepShake() {
  // Hardware shake detector fired. Signal wakeup via flag — do NOT call
  // exitSleep() here. exitSleep() issues I2C commands; calling it from inside
  // getSensorEvent() dispatch is re-entrant against the SH-2 transport. loop()
  // consumes pendingExitSleep safely.
  if (!sleeping)
    return; // spurious event after wake — ignore
  unsigned long elapsed = millis() - sleepStartMs;
  if (elapsed < MIN_SLEEP_MS) {
    LOG_I("[Sleep] shake ignored — too soon after sleep (%lums < %lums)",
          elapsed, MIN_SLEEP_MS);
    return;
  }
  LOG_I("[Sleep] shake confirmed after %lums — scheduling wakeup", elapsed);
  pendingExitSleep = true;
}

static void handleRotationVector() {
  if (sleeping)
    return;

  // [RVRate] Log rotation vector call rate every 10 samples.
  {
    static unsigned long rvCount = 0;
    static unsigned long rvLastLogMs = 0;
    rvCount++;
    unsigned long now = millis();
    if (rvCount % 10 == 0) {
      unsigned long elapsed = now - rvLastLogMs;
      LOG_I("[RVRate] sample=%lu elapsed_10=%lums (~%.1fHz) calBuf=%u armed=%d calDone=%d",
            rvCount, elapsed, elapsed > 0 ? 10000.0f / elapsed : 0.0f,
            calBuffer.count, (int)armed, (int)calibrationComplete);
      rvLastLogMs = now;
    }
  }

  float w = imu.getQuatReal();
  float x = imu.getQuatI();
  float y = imu.getQuatJ();
  float z = imu.getQuatK();
  float roll = quaternionToRoll(w, x, y, z) * 57.296f;
  float pitch = quaternionToPitch(w, x, y, z) * 57.296f;
  float yaw = quaternionToYaw(w, x, y, z) * 57.296f;
  mountAdapter.transform(roll, pitch, yaw);
  lastRoll = roll; lastPitch = pitch; lastYaw = yaw;

  // ── Gravity-based arm pose classification ────────────────────────────────
  // Rotate Earth gravity [0,0,-9.81] into sensor frame via conjugate
  // quaternion, then apply mount transform {1,2,-3} to get forearm-frame
  // gravity. Dominant axis of the normalised forearm gravity = arm pose.
  // Validated against logs.13-17: flat Z′≈0.99, hanging X′≈-0.97, raised
  // mixed≈0.73. Threshold 0.75 (≈41° cone) — more forgiving than original 0.85
  // (≈32° cone).
  {
    static constexpr float GRAV_THRESHOLD = 0.75f;
    static constexpr uint8_t STABLE_SAMPLES = 5;

    // Conjugate quaternion (inverse for unit quaternion): negate vector part
    float cq0 = w, cq1 = -x, cq2 = -y, cq3 = -z;
    float g2 = -9.81f;
    // cross(cq_vec, [0,0,g2])
    float crx = cq2 * g2;
    float cry = -cq1 * g2;
    float crz = 0.0f;
    // cross(cq_vec, cr)
    float c2x = cq2 * crz - cq3 * cry;
    float c2y = cq3 * crx - cq1 * crz;
    float c2z = cq1 * cry - cq2 * crx;
    // Rotated gravity in sensor frame
    float gsx = 2.0f * (cq0 * crx + c2x);
    float gsy = 2.0f * (cq0 * cry + c2y);
    float gsz = g2 + 2.0f * (cq0 * crz + c2z);
    // Apply mount transform {1,2,-3}: Z is negated
    float gfx = gsx;
    float gfy = gsy;
    float gfz = -gsz;
    float gf_mag = sqrtf(gfx * gfx + gfy * gfy + gfz * gfz);
    float gfx_n = gfx / gf_mag;
    float gfy_n = gfy / gf_mag;
    float gfz_n = gfz / gf_mag;

    // Classify pose
    StatePacketGravPose newPose;
    if (fabsf(gfz_n) > GRAV_THRESHOLD)
      newPose = GRAV_POSE_FLAT;
    else if (fabsf(gfx_n) > GRAV_THRESHOLD)
      newPose = GRAV_POSE_HANGING;
    else
      newPose = GRAV_POSE_RAISED;

    // Debounce: require STABLE_SAMPLES consecutive matching readings
    static StatePacketGravPose candidatePose = GRAV_POSE_RAISED;
    static uint8_t stableCount = 0;
    if (newPose == candidatePose) {
      if (stableCount < STABLE_SAMPLES)
        stableCount++;
    } else {
      candidatePose = newPose;
      stableCount = 1;
    }

    // Emit on stable pose change (including first emit after connect, via
    // sentinel reset)
    if (stableCount >= STABLE_SAMPLES &&
        (uint8_t)candidatePose != lastStableGravPose) {
      lastStableGravPose = (uint8_t)candidatePose;
      if (Bluefruit.Periph.connected()) {
        uint8_t gbuf[STATE_PACKET_MAX_LEN];
        uint8_t gn = pkt_grav(gbuf, lastStableGravPose);
        stateChar.notify(gbuf, gn);
        const char *pnames[] = {"flat", "hanging", "raised"};
        LOG_I("[GravPose] → %s  gfx_n=%.3f gfy_n=%.3f gfz_n=%.3f",
              pnames[lastStableGravPose], gfx_n, gfy_n, gfz_n);
      }
    }

    // DIAG: log forearm gravity every ~5s at 10Hz rotation vector rate
    static unsigned long gravDiagCount = 0;
    if (++gravDiagCount % 50 == 0 && Bluefruit.Periph.connected()) {
      const char *pnames[] = {"flat", "hanging", "raised"};
      LOG_I("[GravDiag] gfx_n=%.3f gfy_n=%.3f gfz_n=%.3f → %s (stable=%u)",
            gfx_n, gfy_n, gfz_n,
            (uint8_t)candidatePose <= 2 ? pnames[(uint8_t)candidatePose] : "?",
            stableCount);
    }
  }

  stillDetector->onRotationVector(roll, pitch, yaw, millis());
  // Stability-triggered rebasing removed entirely. Baseline only changes via:
  //   onArmWrite()  — initial calibration
  //   onBaselineWrite() — manual rezero

  if (!Bluefruit.Periph.connected())
    return;

  if (rawMode) {
    char buf[40] = {};
    snprintf(buf, sizeof(buf), "raw|%.1f|%.1f|%.1f", roll, pitch, yaw);
    gestureChar.notify(buf, 40);
  }

  // ── Calibration: accumulate samples for 3 seconds, finalize on timer expiry
  // ── stableCalBuffer collects only during stab=3 windows; calBuffer is fallback
  if (armed) {
    if (!calibrationComplete) {
      if (!baselineCaptured) {
        if (!calInProgress) {
          calBuffer.reset();
          stableCalBuffer.reset();
          inStableWindow = false;
          calStartMs    = millis();
          calDeadlineMs = calStartMs + CAL_DEADLINE_MS;
          calInProgress = true;
        }
        if (millis() - calStartMs < CAL_WINDOW_MS) {
          calBuffer.push(roll, pitch, yaw);
          LOG_I("[CalBuf] count=%u/%u r=%.1f p=%.1f y=%.1f",
                calBuffer.count, MAX_CAL_SAMPLES, roll, pitch, yaw);
          if (inStableWindow) {
            stableCalBuffer.push(roll, pitch, yaw);
            LOG_I("[StabCal] count=%u r=%.1f p=%.1f y=%.1f",
                  stableCalBuffer.count, roll, pitch, yaw);
          }
        }
      }
    }

    unsigned long now = millis();
    // Any armed rotation data = user activity → keep device awake.
    // Without this, knob mode never refreshes lastMotionMs and the
    // device sleeps after SLEEP_TIMEOUT_MS even while actively in use.
    lastMotionMs = now;
    if (now - lastDeltaMs >= 20) {
      lastDeltaMs = now;
      if (currentMode == MODE_KNOB) {
        float dr = roll - baselineRoll;
        float dp = pitch - basePitch_arm;
        float dy = yaw - baselineYaw;
        while (dr > 180.0f)
          dr -= 360.0f;
        while (dr < -180.0f)
          dr += 360.0f;
        while (dp > 180.0f)
          dp -= 360.0f;
        while (dp < -180.0f)
          dp += 360.0f;
        while (dy > 180.0f)
          dy -= 360.0f;
        while (dy < -180.0f)
          dy += 360.0f;
        float deltas[3] = {dr, dp, dy};
        deltaChar.notify(deltas, 12);
      }
      // Emit pose for HUD (current vs baseline) at throttled rate — all modes
      {
        static unsigned long lastPoseMs = 0;
        if (now - lastPoseMs >= 100) {
          lastPoseMs = now;
          uint8_t pbuf[STATE_PACKET_MAX_LEN];
          uint8_t pn = pkt_pose(pbuf, roll, pitch, yaw);
          stateChar.notify(pbuf, pn);
        }
      }
    }
  } else {
    // Disarmed: only reset calibration state if we haven't completed initial
    // calibration
    if (!calibrationComplete) {
      baselineCaptured = false;
      calInProgress = false;
      inStableWindow = false;
      stableCalBuffer.reset();
    }
  }
}

static void handleStabilityClassifier() {
  if (sleeping) return;
  uint8_t stab = imu.getStabilityClassifier();
  unsigned long now = millis();

  stillDetector->onStabilityClass(stab, now);

  // 4=motion, 5=unreliable — treat as user activity
  if (stab >= 4) {
    lastMotionMs = now;
  }

  // Calibration stable-window gating
  if (calInProgress && !baselineCaptured) {
    if (stab == STABILITY_STABLE) {
      inStableWindow = true;
      // Restart the 3s collection window from this stable moment — arm just settled
      calStartMs = now;
      LOG_I("[Cal] stab=3: stable window started, calStartMs reset");
    } else if (stab >= 4) {
      inStableWindow = false;
#ifdef CAL_LAST_WINDOW_ONLY
      stableCalBuffer.reset();
#endif
    }
  }

  // Only log + notify on class change — classifier fires ~25Hz.
  if (stab != lastLoggedStab) {
    lastLoggedStab = stab;
    LOG_I("[Stab] stab=%u (0=unknown,1=table,2=stationary,3=stable,4=motion)",
          stab);
    if (Bluefruit.Periph.connected()) {
      uint8_t sbuf[STATE_PACKET_MAX_LEN];
      uint8_t sn = pkt_stab(sbuf, stab);
      stateChar.notify(sbuf, sn);
    }
  }

  // ── Adaptive RV rate ───────────────────────────────────────────────────
  // MOTION (stab=4) → snap to 50Hz immediately.
  // STATIONARY/TABLE (stab≤2) → drop to 10Hz after 5s, but only in non-gesture
  //   modes. In gesture mode the arm rests at stab=3 between gestures — dropping
  //   rate there would clip the start of the next gesture.
  // STABLE (stab=3) → reset idle timer in all modes; user is holding arm up.
  if (!armed) return;

  if (stab >= 4) { // MOTION
    rvIdleSinceMs = 0;
    if (rvAtIdleRate) {
      rvAtIdleRate = false;
      imu.enableRotationVector(RV_INTERVAL_ACTIVE_MS);
      LOG_I("[RVRate] motion → 50Hz");
    }
  } else if (stab <= STABILITY_STATIONARY && currentMode != MODE_GESTURE) {
    // knob/symbol mode + device on table → allow rate drop
    if (rvIdleSinceMs == 0) rvIdleSinceMs = now;
    if (!rvAtIdleRate && (now - rvIdleSinceMs) >= IDLE_RATE_DROP_MS) {
      rvAtIdleRate = true;
      imu.enableRotationVector(RV_INTERVAL_IDLE_MS);
      LOG_I("[RVRate] still >5s (mode=%u) → 10Hz", currentMode);
    }
  } else {
    // stab=3, or stab≤2 in gesture mode — reset idle timer, stay at current rate
    rvIdleSinceMs = 0;
  }
}

// ── IMU dispatch table
// ──────────────────────────────────────────────────────── Add new sensors here
// — no changes needed in loop().

static const struct {
  uint8_t id;
  void (*fn)();
} IMU_HANDLERS[] = {
#ifdef ENABLE_SHAKE
    {SENSOR_REPORTID_LINEAR_ACCELERATION, handleLinearAcceleration},
#endif
#ifdef ENABLE_TAP
    {SENSOR_REPORTID_TAP_DETECTOR, handleTapDetector},
#endif
#ifdef ENABLE_STEP
    {SENSOR_REPORTID_STEP_COUNTER, handleStepCounter},
#endif
#ifdef ENABLE_GRYO
    {SENSOR_REPORTID_GYROSCOPE_CALIBRATED, handleGyroCalibrated},
#endif
    {(uint8_t)SH2_SHAKE_DETECTOR, handleSleepShake},
    {SENSOR_REPORTID_ROTATION_VECTOR, handleRotationVector},
    {SENSOR_REPORTID_STABILITY_CLASSIFIER, handleStabilityClassifier},
};

static void dispatchIMUEvent(uint8_t eventId) {
  for (const auto &h : IMU_HANDLERS) {
    if (h.id == eventId) {
      h.fn();
      return;
    }
  }
  LOG_I("[IMU] unhandled eventId=0x%02X", eventId);
}

// ── Calibration finalization
// ─────────────────────────────────────────────────────
void finalizeCalibration() {
  calInProgress = false;
  inStableWindow = false;
  float r, p, y;
  if (stableCalBuffer.count > 0) {
    stableCalBuffer.getAverage(r, p, y);
    LOG_I("[Cal] stable window: %u samples", stableCalBuffer.count);
    for (uint8_t i = 0; i < stableCalBuffer.count; i++) {
      LOG_I("[Cal]   [%u] r=%.1f p=%.1f y=%.1f",
            i, stableCalBuffer.roll[i], stableCalBuffer.pitch[i], stableCalBuffer.yaw[i]);
    }
  } else if (calBuffer.count > 0) {
    calBuffer.getAverage(r, p, y);
    LOG_I("[Cal] fallback: %u samples", calBuffer.count);
    for (uint8_t i = 0; i < calBuffer.count; i++) {
      LOG_I("[Cal]   [%u] r=%.1f p=%.1f y=%.1f",
            i, calBuffer.roll[i], calBuffer.pitch[i], calBuffer.yaw[i]);
    }
  } else {
    LOG_E("[Cal] failed — no samples. App must retry.");
    return;
  }
  baselineRoll = r;
  basePitch_arm = p;
  baselineYaw = y;
  baselineCaptured = true;
  if (armed && !calibrationComplete) {
    calibrationComplete = true;
  }
  publishBaseline(r, p, y);
  LOG_I("[Cal] baseline: r=%.1f p=%.1f y=%.1f (stable=%u all=%u)",
        r, p, y, stableCalBuffer.count, calBuffer.count);
}

// ── Loop
// ──────────────────────────────────────────────────────────────────────
void loop() {
  static bool firstLoop = true;

  if (pendingEnableReports) {
    pendingEnableReports = false;
    enableReports();
  }

  // ── PowerManager tick while sleeping ──────────────────────────────────
  // ShakeSleepPolicy: wakes every 30s, calls modeOn() + drainFifo(), looks
  // for 0x19 (shake). If found → exitSleep(). If not → modeSleep() + reset timer.
  // After 10 min, StagedPolicy advances to SigMotionSleepPolicy (INT-based deep sleep).
  if (sleeping) {
    if (powerMgr.tick(hw)) {
      LOG_I("[Sleep] PowerManager: wake event confirmed — exiting sleep");
      exitSleep();
    }
    delay(10);
  }

  bool imuReset = imu.wasReset();
  if (imuReset) {
    if (!firstLoop) {
      LOG_E("[IMU] BNO085 reset detected — re-enabling reports");
      if (sleeping) {
        imu.enableReport((sh2_SensorId_t)SH2_SHAKE_DETECTOR, 0);
      } else {
        enableReports();
      }
    } else {
      LOG_I("[IMU] boot-time reset flag cleared");
    }
  }
  firstLoop = false;
  if (!imuReset && !sleeping) {
    // Drain ALL pending events. If we only read one per wakeup, the INT pin 
    // may stay LOW, which prevents the FALLING edge interrupt from firing 
    // for the next waitForEvent(), causing the IMU reporting to crawl.
    while (digitalRead(BNO085_INT_PIN) == LOW) {
      if (imu.getSensorEvent()) {
        uint8_t eid = imu.getSensorEventID();
        dispatchIMUEvent(eid);
      } else {
        break; // INT is LOW but no event, prevent infinite loop
      }
    }
    // Also try once even if INT is HIGH, as the library might have an event buffered
    if (imu.getSensorEvent()) {
      uint8_t eid = imu.getSensorEventID();
      dispatchIMUEvent(eid);
    }
  }

  // ── Below here: skip all periodic work when sleeping ────────────────────
  // When sleeping, the only thing loop() does is check the INT pin (above),
  // handle pendingExitSleep, and call waitForEvent(). No BLE is connected,
  // advertising is stopped, so keepalive/battery/sleep-entry are pointless.
  if (!sleeping) {
    // Keepalive ping
    if (Bluefruit.Periph.connected()) {
      unsigned long now = millis();
      if (now - lastPingMs > PING_INTERVAL_MS) {
        lastPingMs = now;
        gestureChar.notify("ping", 4);
        // Re-emit last known stability class every ping cycle.
        // BNO085 only fires stab events on class change — if the device was
        // already stable before the phone connected, the app never gets a stab
        // event and calibration hangs forever. This heartbeat guarantees one
        // delivery within PING_INTERVAL_MS of the CCCD being written.
        if (lastLoggedStab <= 4) {
          uint8_t hbuf[STATE_PACKET_MAX_LEN];
          uint8_t hn = pkt_stab(hbuf, lastLoggedStab);
          stateChar.notify(hbuf, hn);
        }
      }
    }

    // ── Sleep entry check ──────────────────────────────────────────────────
    // Trigger even when connected — a connected-but-idle device (no gestures
    // for SLEEP_TIMEOUT_MS) should still sleep. enterSleep() disconnects the
    // phone; onConnect() calls exitSleep() if the phone reconnects.
    {
      unsigned long now = millis();
      if ((now - lastMotionMs) > SLEEP_TIMEOUT_MS) {
        enterSleep();
      }
    }

    // Battery poll — every 30s, update BLE Battery Service + log charging state
    {
      unsigned long now = millis();
      if (now - lastBatteryMs > BATTERY_POLL_MS) {
        lastBatteryMs = now;
        float v = readBatteryVoltage();
        uint8_t pct = voltageToPercent(v);
        bool charging = isCharging();
        if (pct != lastBatteryPct) {
          lastBatteryPct = pct;
          bleBattery.write(pct);
        }
        LOG_I("[Battery] %.2fV  %u%%  charging=%d", v, pct, charging);
      }
    }
  }

  // Yield CPU every loop — lets SoftDevice put nRF52840 to sleep between BLE
  // connection events and IMU interrupts.
  // When sleeping with advertising stopped, WFE only wakes on GPIO (INT pin).
  // Only warn when actually sleeping — INT LOW during active IMU reporting is normal.
  if (sleeping && digitalRead(BNO085_INT_PIN) == LOW) {
    LOG_E("[DEADLOCK WARNING] CPU about to sleep (waitForEvent) but BNO085 INT is LOW! Wake interrupt will never fire!");
  }

  // Calibration timeout — fires regardless of IMU/BLE events
  if (calInProgress && !baselineCaptured) {
    unsigned long now = millis();
    bool stableWindowDone = (now - calStartMs >= CAL_WINDOW_MS);
    bool hardDeadline     = (now >= calDeadlineMs);
    if (stableWindowDone || hardDeadline) {
      if (hardDeadline && !stableWindowDone)
        LOG_E("[Cal] hard deadline hit (%lums) — finalizing with partial data", CAL_DEADLINE_MS);
      finalizeCalibration();
    }
  }

  waitForEvent();
}
