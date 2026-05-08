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
#include "fast_math.h"
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

// ── BLE radio tunables (EXPERIMENTAL — verify with logs in target rooms) ────
//
// These shape the radio link budget vs. battery / latency trade-off.
// Bumped from prior values to address poor through-wall range observed during
// room-mapping tests (device in one room, phone in next room → disconnects).
//
// Future: when room-mapping moves on-device, these can be adjusted dynamically
// — e.g. drop TX power and switch to 1M PHY when the wrist is near its paired
// gateway, raise them when roaming. See BLE_TX_POWER_NEAR / BLE_TX_POWER_FAR
// stubs (TODO) for the dynamic path.
//
// nRF52840 TX power ladder: -40,-20,-16,-12,-8,-4,0,4,8 dBm.
// +8 is the chip max. Each +6 dB ≈ 2× range in free space; expect less indoors.
// Higher TX power costs only during actual transmit bursts — duty cycle for
// our notify rate (~50 Hz, tiny payloads) keeps the average current bump small.
static constexpr int8_t BLE_TX_POWER_DBM = 8;

// Connection interval (units of 1.25 ms). Wider window = more time for the
// radio to retry on weak links + lower average current, at the cost of latency
// between gesture detection and notify delivery. Prior: 6–12 (7.5–15 ms);
// new: 12–24 (15–30 ms). One-step bump — revisit if gestures feel laggy.
static constexpr uint16_t BLE_CONN_INTERVAL_MIN_UNITS = 12; // 15 ms
static constexpr uint16_t BLE_CONN_INTERVAL_MAX_UNITS = 24; // 30 ms

// Supervision timeout (units of 10 ms). How long the link survives missed
// packets before declaring disconnect. Prior: 200 (2 s); new: 400 (4 s).
// Longer = fewer spurious disconnects on marginal signal; downside is slower
// detection of a genuinely dead peer. Must satisfy:
//   timeout > (1 + slave_latency) * conn_interval_max * 2
// With slave_latency=0 and conn_interval_max=30 ms, min is 60 ms — 4 s is fine.
static constexpr uint16_t BLE_CONN_SUPERVISION_TIMEOUT_UNITS = 400; // 4 s

// PHY negotiation. Advertise on 1M (universal — every BLE phone can scan it),
// then ask the peer to upgrade the data link to Coded PHY (S=8, "Long Range")
// after connect. Coded PHY adds ~12 dB link budget at the cost of throughput
// (125 kbps vs 1 Mbps) — fine for our small notify payloads. If the peer does
// not support Coded PHY, the request fails gracefully and the link stays on 1M.
static constexpr uint8_t BLE_DATA_PHY = BLE_GAP_PHY_CODED;

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
  LOG_I("[PKT_BASELINE] sent r=%.1f p=%.1f y=%.1f", r, p, y);
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
unsigned long calStartMs = 0;     // when cal began — set once at entry, never overwritten
unsigned long stableStartMs = 0;  // when current stab=3 window began — diagnostic only
unsigned long calDeadlineMs = 0;  // hard deadline: set once on calInProgress, never resets

// Captured in setup() before anything can clear it; logged later once USB CDC
// is enumerated. Decoded in loop() prologue on first iteration.
uint32_t bootResetReas = 0;

// Set to true to deliberately wedge after a few loop iterations so we can
// confirm WDT actually resets the MCU. Note: the Seeeduino/Adafruit bootloader
// clears RESETREAS before setup() runs, so "DOG" won't appear on the next
// boot — verify instead by observing the ~8s silence + setup() re-running.
static constexpr bool WDT_SELFTEST = false;
static constexpr unsigned long CAL_COLLECT_MS  = 3000;  // sample collection window
static constexpr unsigned long CAL_DEADLINE_MS = 6000;  // hard backstop (3s past collect)
// #define CAL_LAST_WINDOW_ONLY  // uncomment to keep only the most recent stable window

// Deferred flags — set in callbacks/event handlers, consumed in loop() where
// I2C is safe. Never do I2C (enableReport, modeOn, etc.) from inside a BLE
// callback or an IMU event handler — those run inside
// getSensorEvent()/SoftDevice context. Set a flag instead; loop() picks it up
// on the next iteration (same pattern as Go's select-on-channel).
static volatile bool pendingEnableReports = false;
static volatile bool pendingExitSleep = false;

// PHY upgrade scheduling — set in onConnect, consumed in loop() once the link
// has settled (MTU/DLE/initial discovery done) and sensor samples are flowing.
// Done in loop() (main task) rather than onConnect (SoftDevice task) so we can
// call sd_ble_gap_phy_update directly and capture the raw NRF err_code instead
// of letting Bluefruit's requestPHY swallow it via VERIFY_STATUS.
static volatile uint32_t bleConnectAtMs = 0; // 0 == no connection
static volatile bool phyUpgradeAttempted = false;
static constexpr uint32_t PHY_UPGRADE_DELAY_MS =
    1500; // wait this long after connect before requesting PHY change

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

// Gravity sensor (SH2_GRAVITY = 0x06) drives arm-pose classification independently
// of rotation vector. Unlike RV (which the SH-2 hub suspends when stationary),
// gravity continues at the requested rate so we can detect arm hanging even when
// the wrist is held still. 100ms (10Hz) × 5-sample debounce = 500ms confirm.
static constexpr uint32_t GRAVITY_INTERVAL_MS = 100;

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

// Most recent gyro magnitude in dps. Updated from handleGyroCalibrated (~50 Hz)
// and read by handleRotationVector when emitting PKT_POSE_EXT (~10 Hz). Both
// callbacks run on loop() — same thread — so no synchronisation needed, but
// the value is "most recent at emit time" rather than synchronised with the
// pose sample. Adequate for the app-side SettleGate which integrates over
// 150ms windows. Stays 0 until the gyro callback fires once.
static float latestGyroMagDps = 0.0f;
// Conversion factor: rad/s → dps. Cached as a constant to avoid recomputing.
static constexpr float RAD_PER_S_TO_DPS = 57.29577951308232f; // 180 / pi

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
      if (digitalRead(BNO085_INT_PIN) == HIGH && (millis() - start) > 150)
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

    // Gravity sensor — independent of RV so arm-pose detection survives RV
    // throttling and SH-2 fusion suspension on stationary wrist.
    if (imu.enableReport(SENSOR_REPORTID_GRAVITY, GRAVITY_INTERVAL_MS))
      LOG_I("[Reports] gravity enabled at %ums (%uHz)",
            GRAVITY_INTERVAL_MS, 1000 / GRAVITY_INTERVAL_MS);
    else
      LOG_E("BNO085: could not enable Gravity");
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
  // Diagnostic — uncomment to trace recalibration / arm-write flow.
  // LOG_I("[Arm] write req=%d cur=%d calComplete=%d baseCaptured=%d calInProg=%d sleeping=%d",
  //       (int)newArmed, (int)armed, (int)calibrationComplete,
  //       (int)baselineCaptured, (int)calInProgress, (int)sleeping);
  if (newArmed == armed) {
    // LOG_I("[Arm] no-op (already %d)", (int)armed);
    return;
  }
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
        imu.enableReport(SENSOR_REPORTID_GRAVITY, 0);
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
      // and gravity if not rawMode
      if (!rawMode) {
        imu.enableReport(SENSOR_REPORTID_ROTATION_VECTOR, 0);
        imu.enableReport(SENSOR_REPORTID_GRAVITY, 0);
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
    // Diagnostic — uncomment to log armed/sleeping at clear time.
    // LOG_I("[Cal] cleared state: armed=%d sleeping=%d", (int)armed, (int)sleeping);
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
  imu.enableReport(SENSOR_REPORTID_GRAVITY, 0);
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

  // Schedule deferred PHY upgrade (handled by servicePhyUpgrade() in loop()).
  bleConnectAtMs = millis();
  phyUpgradeAttempted = false;
}

// Drives the deferred PHY upgrade state machine. Called once per loop tick.
//
// Why this isn't done in onConnect: that callback runs in the SoftDevice task,
// during which a fresh link is still doing MTU/DLE/discovery exchanges. PHY
// updates issued in that window have been observed to fail with INVALID_STATE.
// We also want the raw NRF err_code, which Bluefruit::requestPHY hides behind
// VERIFY_STATUS — so we call sd_ble_gap_phy_update directly here.
//
// Two phases, gated on bleConnectAtMs (set in onConnect, cleared in onDisconnect):
//   1. At connect+PHY_UPGRADE_DELAY_MS: issue the request, log raw err_code.
//   2. At connect+PHY_UPGRADE_DELAY_MS+500: log getPHY() so we can see whether
//      the negotiation actually succeeded (peer accepted) or quietly stayed on 1M.
//
// err_code interpretation (from ble_gap.h / nrf_error.h):
//   0x00   NRF_SUCCESS                request accepted, outcome via BLE_GAP_EVT_PHY_UPDATE
//   0x07   NRF_ERROR_INVALID_PARAM    SoftDevice config doesn't enable requested PHY
//   0x08   NRF_ERROR_INVALID_STATE    link still negotiating something else
//   0x11   NRF_ERROR_BUSY             a previous PHY update is in flight
//   0x3002 BLE_ERROR_INVALID_CONN_HANDLE
static void servicePhyUpgrade() {
  static bool resultLogged = false;

  // Reset post-disconnect so the next connection re-logs.
  if (bleConnectAtMs == 0) {
    if (resultLogged)
      resultLogged = false;
    return;
  }
  if (!Bluefruit.Periph.connected())
    return;

  uint32_t elapsed = millis() - bleConnectAtMs;

  // Phase 1: issue the request once.
  if (!phyUpgradeAttempted && elapsed >= PHY_UPGRADE_DELAY_MS) {
    phyUpgradeAttempted = true;
    BLEConnection *conn = Bluefruit.Connection(0);
    if (!conn) {
      LOG_E("[BLE] PHY upgrade: no connection object");
      return;
    }
    uint8_t before = conn->getPHY();
    ble_gap_phys_t gap_phy = {.tx_phys = BLE_DATA_PHY,
                              .rx_phys = BLE_DATA_PHY};
    uint32_t err = sd_ble_gap_phy_update(conn->handle(), &gap_phy);
    LOG_I("[BLE] PHY upgrade req: target=0x%02X before=0x%02X "
          "sd_err=0x%04lX (0=ok, 7=invalid_param, 8=invalid_state, 11=busy)",
          BLE_DATA_PHY, before, (unsigned long)err);
    return;
  }

  // Phase 2: log the active PHY ~500 ms later.
  if (phyUpgradeAttempted && !resultLogged &&
      elapsed >= (PHY_UPGRADE_DELAY_MS + 500)) {
    resultLogged = true;
    BLEConnection *conn = Bluefruit.Connection(0);
    if (!conn)
      return;
    uint8_t phy = conn->getPHY();
    const char *name = (phy == BLE_GAP_PHY_CODED)   ? "CODED"
                       : (phy == BLE_GAP_PHY_2MBPS) ? "2M"
                       : (phy == BLE_GAP_PHY_1MBPS) ? "1M"
                                                    : "?";
    LOG_I("[BLE] active PHY: %s (0x%02X)", name, phy);
  }
}

void onDisconnect(uint16_t conn_hdl, uint8_t reason) {
  LOG_I("BLE disconnected. conn_hdl=%u reason=0x%02X", conn_hdl, reason);
  // Clear PHY upgrade state for next connection.
  bleConnectAtMs = 0;
  phyUpgradeAttempted = false;
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

  // ── Reset reason ──────────────────────────────────────────────────────────
  // RESETREAS bits: 0=PIN, 1=DOG (watchdog), 2=SREQ (soft), 3=LOCKUP,
  //                 16=OFF, 17=LPCOMP, 18=DIF, 19=NFC, 20=VBUS.
  // Don't read NRF_POWER->RESETREAS directly — the Seeeduino Arduino core's
  // init() (cores/nRF5/wiring.c:37) runs before setup() and already clears it
  // (write-1-to-clear). It stashes the original value in _reset_reason and
  // exposes it via readResetReason(). LOG_I is deferred until after IMU init
  // because USB CDC isn't enumerated this early.
  bootResetReas = readResetReason();

  // ── Hardware watchdog (WDT) ───────────────────────────────────────────────
  // 8s timeout. Pat at the top of loop(). If loop() doesn't iterate within
  // 8s, MCU resets — RESETREAS bit 1 (DOG) will tell us next boot.
  // HALT_Pause: WDT counter pauses while CPU is halted by debugger.
  // SLEEP_Run:  WDT counter keeps running while CPU is asleep (WFE/WFI).
  //             Required — otherwise wedge-in-WFE never trips the dog.
  NRF_WDT->CONFIG = (WDT_CONFIG_HALT_Pause << WDT_CONFIG_HALT_Pos) |
                    (WDT_CONFIG_SLEEP_Run  << WDT_CONFIG_SLEEP_Pos);
  NRF_WDT->CRV    = 8UL * 32768UL;   // 8s in 32.768 kHz LFCLK ticks
  NRF_WDT->RREN   = 0x1;             // enable reload register RR[0] only
  NRF_WDT->TASKS_START = 1;

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

  // ── Deferred boot diagnostics ─────────────────────────────────────────────
  // bootResetReas was captured in the very first lines of setup(); WDT was
  // started immediately too. We log them here because USB CDC is now ready
  // (BNO085 init delay is enough for macOS to enumerate the tty).
  LOG_I("[BOOT] resetreas=0x%08lx %s%s%s%s%s",
        (unsigned long)bootResetReas,
        (bootResetReas & 0x01) ? "PIN " : "",
        (bootResetReas & 0x02) ? "DOG " : "",
        (bootResetReas & 0x04) ? "SREQ " : "",
        (bootResetReas & 0x08) ? "LOCKUP " : "",
        (bootResetReas == 0)   ? "POWER_ON" : "");
  LOG_I("[WDT] started, timeout=8000ms (selftest=%d)", (int)WDT_SELFTEST);

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
  Bluefruit.setTxPower(BLE_TX_POWER_DBM);
  Bluefruit.setName("RUNE-I");
  Bluefruit.Periph.setConnInterval(BLE_CONN_INTERVAL_MIN_UNITS,
                                   BLE_CONN_INTERVAL_MAX_UNITS);
  Bluefruit.Periph.setConnSupervisionTimeout(
      BLE_CONN_SUPERVISION_TIMEOUT_UNITS);
  LOG_I("[BLE] tx=%ddBm conn=%u-%u(*1.25ms) supv=%u(*10ms)",
        (int)BLE_TX_POWER_DBM, BLE_CONN_INTERVAL_MIN_UNITS,
        BLE_CONN_INTERVAL_MAX_UNITS, BLE_CONN_SUPERVISION_TIMEOUT_UNITS);

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
  staged.addStage(&shakePol, 600UL * 1000UL);  // 10 min = 600 s
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
  uint8_t bits = imu.getTapDetector();
  char buf[40] = {};
  snprintf(buf, sizeof(buf), "tap");
  LOG_I("%s bits=0x%02x", buf, bits);
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

  // Cache magnitude in dps for PKT_POSE_EXT consumers (HoldDetector SettleGate).
  // Magnitude is rotation-frame-invariant so the mount transform doesn't matter
  // for it, but we use the post-transform components for consistency.
  {
    float mag2 = gx * gx + gy * gy + gz * gz;
    float magRads = (mag2 > 0.0f) ? sqrtf(mag2) : 0.0f;
    latestGyroMagDps = magRads * RAD_PER_S_TO_DPS;
  }

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

// Arm-pose classifier: dominant axis of forearm-frame gravity → FLAT/HANGING/RAISED.
// Reads gravity vector directly from SH2_GRAVITY so it keeps updating even when
// RV is throttled or the SH-2 hub suspends fusion on a stationary wrist.
// Mount transform {1,2,-3} matches the historical RV-derived classifier (Z negated).
// Threshold/debounce kept identical to the old implementation, so behaviour at
// emit-time is unchanged — only the input source changed.
static void handleGravity() {
  if (sleeping)
    return;

  float gfx = imu.getGravityX();
  float gfy = imu.getGravityY();
  float gfz = imu.getGravityZ();

  // Same mount transform used for r/p/y (handleRotationVector) and gyro vector
  // (handleGyroCalibrated). The selector logic in MountingAdapter is generic over
  // its three input slots — works for angles or vector components alike.
  mountAdapter.transform(gfx, gfy, gfz);

  // Sanity guard before normalising — degenerate magnitude shouldn't happen on
  // a real IMU but can during init or driver hiccups.
  float mag2 = gfx * gfx + gfy * gfy + gfz * gfz;
  if (mag2 < 0.01f) return;

  // Normalise via fast_math.h dispatcher. Default = naive (1 sqrt + 3 div).
  // Build with -DRUNE_NORMALISE_FAST to swap in the bit-hack approximation.
  float gfx_n, gfy_n, gfz_n;
  normalise3(gfx, gfy, gfz, &gfx_n, &gfy_n, &gfz_n);

  static constexpr float GRAV_THRESHOLD = 0.75f;   // ≈41° cone (validated logs.13-17)
  static constexpr uint8_t STABLE_SAMPLES = 5;     // 5 × 100ms = 500ms confirm

  StatePacketGravPose newPose;
  if (fabsf(gfz_n) > GRAV_THRESHOLD)
    newPose = GRAV_POSE_FLAT;
  else if (fabsf(gfx_n) > GRAV_THRESHOLD)
    newPose = GRAV_POSE_HANGING;
  else
    newPose = GRAV_POSE_RAISED;

  static StatePacketGravPose candidatePose = GRAV_POSE_RAISED;
  static uint8_t stableCount = 0;
  if (newPose == candidatePose) {
    if (stableCount < STABLE_SAMPLES) stableCount++;
  } else {
    candidatePose = newPose;
    stableCount = 1;
  }

  if (stableCount >= STABLE_SAMPLES &&
      (uint8_t)candidatePose != lastStableGravPose) {
    const uint8_t prev = lastStableGravPose;
    lastStableGravPose = (uint8_t)candidatePose;
    if (Bluefruit.Periph.connected()) {
      uint8_t gbuf[STATE_PACKET_MAX_LEN];
      uint8_t gn = pkt_grav(gbuf, lastStableGravPose);
      stateChar.notify(gbuf, gn);
      const char *pnames[] = {"flat", "hanging", "raised"};
      LOG_I("[GravPose] → %s  gfx_n=%.3f gfy_n=%.3f gfz_n=%.3f",
            pnames[lastStableGravPose], gfx_n, gfy_n, gfz_n);

      // ── Emit arm_up / arm_down gesture on HANGING-involving transitions ──
      //
      // Skip the first-ever transition (prev == UINT8_MAX) since boot pose
      // is not a user-initiated event.
      //
      // Wrist-roll transitions (FLAT ↔ RAISED) emit no gesture because they
      // are not arm-pose changes — only HANGING crossings count as
      // activate/deactivate intent.
      const bool prevValid    = (prev <= GRAV_POSE_RAISED);
      const bool leavingHang  = (prev == GRAV_POSE_HANGING)
                                && (lastStableGravPose != GRAV_POSE_HANGING);
      const bool enteringHang = (prev != GRAV_POSE_HANGING)
                                && (lastStableGravPose == GRAV_POSE_HANGING);

      const char *armToken = nullptr;
      if (prevValid && leavingHang) {
        armToken = "arm_up";
      } else if (prevValid && enteringHang) {
        armToken = "arm_down";
      }

      if (armToken) {
        char abuf[GESTURE_CHAR_LEN] = {};
        snprintf(abuf, sizeof(abuf),
                 "%s|0.00|0.00|0.00|0.00|0.00", armToken);
        gestureChar.notify(abuf, GESTURE_CHAR_LEN);
        LOG_I("[Gesture] %s (pose transition)", armToken);
      }
    }
  }

  // DIAG: log forearm gravity every ~5s at 10Hz
  static unsigned long gravDiagCount = 0;
  if (++gravDiagCount % 50 == 0 && Bluefruit.Periph.connected()) {
    const char *pnames[] = {"flat", "hanging", "raised"};
    LOG_I("[GravDiag] gfx_n=%.3f gfy_n=%.3f gfz_n=%.3f → %s (stable=%u)",
          gfx_n, gfy_n, gfz_n,
          (uint8_t)candidatePose <= 2 ? pnames[(uint8_t)candidatePose] : "?",
          stableCount);
  }
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

  // (Arm-pose classification moved to handleGravity() — driven by SH2_GRAVITY
  // so it survives RV throttling and SH-2 fusion suspension when stationary.)

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

          LOG_I("[CalStart] armed=%d calComplete=%d baseCaptured=%d", armed, calibrationComplete, baselineCaptured);

          calStartMs    = millis();
          stableStartMs = 0;
          calDeadlineMs = calStartMs + CAL_DEADLINE_MS;
          calInProgress = true;
        }
        if (millis() - calStartMs < CAL_COLLECT_MS) {
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
      // Emit pose for HUD (current vs baseline) at throttled rate — all modes.
      // Uses PKT_POSE_EXT to also carry per-sample gyro magnitude for the
      // app-side HoldDetector. App falls back gracefully if it sees only the
      // legacy PKT_POSE shape (older firmware), so the upgrade is one-way safe.
      {
        static unsigned long lastPoseMs = 0;
        if (now - lastPoseMs >= 100) {
          lastPoseMs = now;
          uint8_t pbuf[STATE_PACKET_MAX_LEN];
          uint8_t pn = pkt_pose_ext(pbuf, roll, pitch, yaw, latestGyroMagDps);
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

  // Calibration stable-window tracking — diagnostic only.
  // Stab=3 transitions DO NOT touch calStartMs (that's the master collect timer).
  // stableStartMs tracks when the current stab=3 window opened, for logging.
  if (calInProgress && !baselineCaptured) {
    if (stab == STABILITY_STABLE) {
      if (!inStableWindow) {
        inStableWindow = true;
        stableStartMs = now;
        LOG_I("[Cal] stab=3: stable window opened");
      }
    } else if (stab >= 4) {
      if (inStableWindow) {
        inStableWindow = false;
        LOG_I("[Cal] stab=4: stable window closed after %lums", now - stableStartMs);
      }
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
    {SENSOR_REPORTID_GRAVITY, handleGravity},
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

  // Pat the watchdog. Must be the first thing in loop() so any subsequent
  // wedge gets caught within the 8s WDT window. Magic value 0x6E524635 is
  // required by the nRF52840 WDT (per datasheet).
  NRF_WDT->RR[0] = 0x6E524635UL;

  // Self-test: when WDT_SELFTEST is true, spin forever after a few loop
  // iterations so we can confirm WDT resets the MCU and RESETREAS reports DOG
  // on next boot.
  //
  // Boot-loop safety: skip the hang if we just woke from a WDT reset. So the
  // sequence is exactly one cycle:
  //   power-on        → selftest runs → WDT trips → reboot
  //   reboot from WDT → selftest skipped → device operates normally
  // After observing the [BOOT] ... DOG line once, flip WDT_SELFTEST back to
  // false. If you forget, the device still works on the second boot onward.
  if (WDT_SELFTEST && !(bootResetReas & 0x02)) {
    static uint32_t selftestCount = 0;
    if (++selftestCount == 5) {
      LOG_E("[WDT_SELFTEST] deliberate hang — WDT should reset in 8s");
      while (true) { /* wait for the dog */ }
    }
  }

  // ── Heartbeat / state transition log ───────────────────────────────────
  // Logs only on state changes (arm/disarm, sleep enter/exit), with a 60s
  // backstop while actively armed. Quiet when idle or asleep — no per-second
  // noise. iter counter shows loop liveness; if WDT trips, the last [HB]
  // line in the log shows what state the device was in before the wedge.
  {
    static uint8_t  lastLoggedState = 0xFF;          // 0xFF = no log yet
    static unsigned long lastHbMs   = 0;
    static uint32_t loopIter        = 0;
    // Pre-emptive reset before uint32_t wraps. Natural wrap is well-defined
    // (just resets to 0), but emitting an explicit log makes it possible to
    // distinguish "fresh boot iter=0" from "wrapped iter=0" in traces. At
    // ~100 iter/s this fires once every ~1.4 years of uptime.
    if (loopIter >= 0xFFFFFFFEUL) {
      LOG_I("[HB] iter counter wrap — reset to 0");
      loopIter = 0;
    }
    loopIter++;

    uint8_t state = (armed ? 1 : 0) | (sleeping ? 2 : 0);
    unsigned long now = millis();
    if (state != lastLoggedState) {
      const char* label =
        state == 0 ? "DISARMED" :
        state == 1 ? "ARMED" :
        state == 2 ? "DISARMED+SLEEPING" :
                     "ARMED+SLEEPING";
      LOG_I("[HB] state=%s prev=0x%02x iter=%lu connected=%d",
            label, (unsigned)lastLoggedState, (unsigned long)loopIter,
            (int)Bluefruit.Periph.connected());
      lastLoggedState = state;
      lastHbMs = now;
    } else if (armed && !sleeping && (now - lastHbMs) >= 60000UL) {
      LOG_I("[HB] alive armed=1 iter=%lu connected=%d",
            (unsigned long)loopIter, (int)Bluefruit.Periph.connected());
      lastHbMs = now;
    }
  }

  // (Original verbose 5s heartbeat retained as commented reference)
  // {
  //   static unsigned long lastHbMs = 0;
  //   unsigned long nowMs = millis();
  //   if (nowMs - lastHbMs >= 5000) {
  //     lastHbMs = nowMs;
  //     LOG_I("[HB] armed=%d sleeping=%d calComplete=%d baseCaptured=%d calInProg=%d connected=%d",
  //           (int)armed, (int)sleeping, (int)calibrationComplete,
  //           (int)baselineCaptured, (int)calInProgress,
  //           (int)Bluefruit.Periph.connected());
  //   }
  // }

  if (pendingEnableReports) {
    pendingEnableReports = false;
    enableReports();
  }

  servicePhyUpgrade();

  // ── PowerManager tick while sleeping ──────────────────────────────────
  // ShakeSleepPolicy: wakes every 30s, calls modeOn() + drainFifo(), looks
  // for 0x19 (shake). If found → exitSleep(). If not → modeSleep() + reset timer.
  // After 4.5 min, StagedPolicy advances to SigMotionSleepPolicy (deep sleep).
  if (sleeping) {
    static uint8_t lastStage = 0xFF;
    uint8_t curStage = staged.currentStage;
    if (curStage != lastStage) {
      lastStage = curStage;
      if (curStage == 0)
        LOG_I("[Sleep] stage=0 light sleep (shake, 30s cycles)");
      else
        LOG_I("[Sleep] stage=1 deep sleep (SigMotion, INT-based)");
    }

    if (powerMgr.tick(hw)) {
      LOG_I("[Sleep] PowerManager: wake event confirmed — exiting sleep");
      exitSleep();
      lastStage = 0;
    }
    delay(10);
    return;  // skip dispatch, keepalive, DEADLOCK check, waitForEvent
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

  // Calibration finalization — fires regardless of IMU/BLE events.
  // Normal path: collectDone fires 3s after cal entry → use stableCalBuffer if
  // any stab=3 windows occurred, else fall back to calBuffer.
  // Backstop: deadlineHit fires 6s after cal entry — finalize whatever we have.
  if (calInProgress && !baselineCaptured) {
    unsigned long now = millis();
    bool collectDone = (now - calStartMs >= CAL_COLLECT_MS);
    bool deadlineHit = (now >= calDeadlineMs);
    if (collectDone || deadlineHit) {
      if (deadlineHit && !collectDone)
        LOG_E("[Cal] deadline hit (%lums) — finalizing partial", CAL_DEADLINE_MS);
      finalizeCalibration();
    }
  }

  waitForEvent();
}
