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
#include <string.h>  // for memcpy
#include "log.h"
#include "shake_detector.h"
#include "mounting_adapter.h"
#include "gesture/GestureDetector.h"
#include "StillnessDetector.h"
#include "state_packet.h"

// Wrist-mounted chip orientation. See mounting_adapter.h for encoding.
// Current mounting: roll=+roll, pitch=+pitch, yaw=-yaw.
MountingAdapter mountAdapter({ 1, 2, -3 });

// ── Battery monitoring ────────────────────────────────────────────────────────
// PIN_VBAT (32 / P0.31) already defined in variant.h — battery voltage divider
#define PIN_CHARGE_STATUS  17   // P0.17 — BQ25101 CHRG, active LOW = charging

const unsigned long BATTERY_POLL_MS = 30000;  // read every 30s
unsigned long lastBatteryMs = 0;
uint8_t       lastBatteryPct = 0;

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
  if (v >= battVMax) return 100;
  if (v <= battVMin) return 0;
  // piecewise: 3.0→3.7V = bottom 50%, 3.7→4.2V = top 50%
  float mid = battVMin + (battVMax - battVMin) * 0.583f;  // ~3.7V
  if (v >= mid)
    return (uint8_t)(50.0f + (v - mid) / (battVMax - mid) * 50.0f);
  return (uint8_t)((v - battVMin) / (mid - battVMin) * 50.0f);
}

bool isCharging() {
  return digitalRead(PIN_CHARGE_STATUS) == LOW;
}

// ── BLE setup (Bluefruit / Adafruit nRF52 stack) ─────────────────────────────
// Fixed payload sizes for BLE characteristics.
// Bluefruit requires notify() length to exactly match setFixedLen() / constructor len —
// shorter payloads are silently dropped. Pad with spaces before every notify() call.
#define GESTURE_CHAR_LEN  40
#define STATE_CHAR_LEN    80  // largest JSON event fits in 80 bytes; within 247-byte ATT MTU

BLEService        wristService("19B10000-E8F2-537E-4F6C-D104768A1214");
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
void emitState(const char* evt, const char* axis, const char* state, float d) {
  (void)evt;  // reserved for future multi-event dispatch; today only ARM_EVT uses this
  if (!axis || !state) return;

  uint8_t axisId;
  if      (strcmp(axis, "roll")  == 0) axisId = AXIS_ROLL;
  else if (strcmp(axis, "pitch") == 0) axisId = AXIS_PITCH;
  else if (strcmp(axis, "yaw")   == 0) axisId = AXIS_YAW;
  else return;

  uint8_t stateId = (strcmp(state, "armed") == 0) ? ARM_STATE_ARMED : ARM_STATE_DISARMED;

  uint8_t buf[STATE_PACKET_MAX_LEN];
  uint8_t n = pkt_arm_evt(buf, axisId, stateId, d);
  stateChar.notify(buf, n);
}

void publishBaseline(float r, float p, float y) {
  float vals[3] = { r, p, y };
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
BLEService        settingsService("19B10010-E8F2-537E-4F6C-D104768A1214");
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
constexpr int BNO085_INT_PIN = 1;   // XIAO D1 / P0.03
constexpr int BNO085_RST_PIN = -1;  // not used

// ── Thresholds — tunable via BLE ─────────────────────────────────────────────
unsigned long debounceMs    =  200;   // min ms between gestures (kept for shake/tap)

// ── State ────────────────────────────────────────────────────────────────────
bool    rawMode        = false; // stream raw IMU on every rotation vector event
GestureDetector gestureDetector;

// Interaction modes (written by app via modeChar)
#define MODE_GESTURE 0
#define MODE_KNOB    1
#define MODE_SYMBOL  2
uint8_t currentMode = MODE_GESTURE;

// Arm state — when armed, baseline is captured via rolling-window calibration
bool    armed         = false;
float   baselineRoll  = 0.0f;
float   basePitch_arm = 0.0f;
float   baselineYaw   = 0.0f;

// Calibration state globals
bool calibrationComplete = false;  // set on first confirmed baseline after connect
bool baselineCaptured    = false;  // moved from static inside handleRotationVector

// Rolling-window calibration accumulator (populates during first stable window)
CalibrationBuffer calBuffer;
bool calInProgress = false;

// Deferred flag — set in BLE callback, consumed in loop() where I2C is safe.
static volatile bool pendingEnableReports = false;

// Last logged stability value — used to suppress duplicate logs and drive heartbeat.
// Initialised to 1 (on_table) so the very first post-connect heartbeat has a valid
// value to re-emit even if no stab event fired before the first connection.
static uint8_t lastLoggedStab = 1;

// Delta rate limiter — emit at most every 20ms (~50Hz)
unsigned long lastDeltaMs = 0;

// Last known Euler angles — updated every rotation vector event for stability rebase
float lastRoll  = 0.0f;
float lastPitch = 0.0f;
float lastYaw   = 0.0f;

// Stillness detector — swap implementation without touching event handlers
StabilityClassifierDetector _stabDetector;
IStillnessDetector* stillDetector = &_stabDetector;

unsigned long lastPingMs     = 0;
const unsigned long PING_INTERVAL_MS = 3000;
ShakeDetector shake;

// ── Sleep / wake ──────────────────────────────────────────────────────────────
// Define DEBUG_SLEEP to use 30s timeout for bench testing sleep/wake via serial.
// #define DEBUG_SLEEP
#ifdef DEBUG_SLEEP
const unsigned long SLEEP_TIMEOUT_MS = 30UL * 1000UL;         // 30 seconds (test)
#else
const unsigned long SLEEP_TIMEOUT_MS = 5UL * 60UL * 1000UL;  // 5 minutes (production)
#endif
bool                sleeping         = false;
unsigned long       lastMotionMs     = 0;

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
#define ENABLE_SHAKE      // uses linear accelerometer
// #define ENABLE_STEP
#define ENABLE_GRYO

void enableReports() {
  LOG_I("[Reports] enable start rawMode=%d armed=%d sleeping=%d", rawMode, armed, sleeping);
  LOG_I("[Reports] INT pin %d level before config=%d", BNO085_INT_PIN, digitalRead(BNO085_INT_PIN));
  // Rotation vector needed for rawMode streaming or when armed (knob/symbol modes)
  if (rawMode || armed) {
    if (imu.enableRotationVector())
      LOG_I("[Reports] rotation vector enabled");
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
  if(imu.enableGyro())
    LOG_I("[Reports] gyro enabled");
  else
    LOG_E("BN0085: could not enable gyro");
#endif
  if (imu.enableStabilityClassifier(500))
    LOG_I("[Reports] stability classifier enabled");
  else
    LOG_E("BNO085: could not enable Stability Classifier");
}

// ── BLE write callbacks ───────────────────────────────────────────────────────
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
    bool newMode = (data[0] != 0);
    if (newMode != rawMode) {
      rawMode = newMode;
      if (rawMode) {
        imu.enableRotationVector();
      } else {
        imu.enableReport(SENSOR_REPORTID_ROTATION_VECTOR, 0);
      }
    }
    LOG_I("[Settings] rawMode=%d", rawMode);
  }
}

void onBattVMaxWrite(uint16_t conn_hdl, BLECharacteristic* chr, uint8_t* data, uint16_t len) {
  if (len == 4) {
    float val;
    memcpy(&val, data, 4);
    if (val > battVMin && val <= 4.35f) {
      battVMax = val;
      LOG_I("[Settings] battVMax updated: %.2fV", battVMax);
    } else {
      LOG_E("[Settings] battVMax out of range: %.2f (must be battVMin..4.35)", val);
    }
  }
}

void onBattVMinWrite(uint16_t conn_hdl, BLECharacteristic* chr, uint8_t* data, uint16_t len) {
  if (len == 4) {
    float val;
    memcpy(&val, data, 4);
    if (val >= 2.5f && val < battVMax) {
      battVMin = val;
      LOG_I("[Settings] battVMin updated: %.2fV", battVMin);
    } else {
      LOG_E("[Settings] battVMin out of range: %.2f (must be 2.5..battVMax)", val);
    }
  }
}

void onModeWrite(uint16_t conn_hdl, BLECharacteristic* chr, uint8_t* data, uint16_t len) {
  if (len == 1 && data[0] <= MODE_SYMBOL) {
    currentMode = data[0];
    LOG_I("[Mode] switched to %d (0=gesture,1=knob,2=symbol)", currentMode);
  }
}

void onArmWrite(uint16_t conn_hdl, BLECharacteristic* chr, uint8_t* data, uint16_t len) {
  if (len != 1) return;
  bool newArmed = (data[0] != 0);
  if (newArmed == armed) return;
  armed = newArmed;
  if (armed) {
    pendingEnableReports = true;
    LOG_I("[Arm] queued report enable");
    // If we already have a captured baseline and calibration not yet marked complete, confirm it now
    if (baselineCaptured && !calibrationComplete) {
      calibrationComplete = true;
      LOG_I("[Cal] calibration confirmed via arm");
    }
    LOG_I("[Arm] armed");
  } else {
    // Disarm: only clear baseline and calibration state if calibration not complete
    if (!calibrationComplete) {
      if (!rawMode) {
        imu.enableReport(SENSOR_REPORTID_ROTATION_VECTOR, 0);
      }
      baselineRoll  = 0.0f;
      basePitch_arm = 0.0f;
      baselineYaw   = 0.0f;
      float zeros[3] = {0, 0, 0};
      deltaChar.write(zeros, 12);
      publishBaseline(0, 0, 0);
      LOG_I("[Arm] disarmed — rotation vector disabled");
      calBuffer.reset();
      calInProgress = false;
    } else {
      // Calibration already done: keep baseline, just disable rotation vector if not rawMode
      if (!rawMode) {
        imu.enableReport(SENSOR_REPORTID_ROTATION_VECTOR, 0);
      }
      LOG_I("[Arm] disarmed — baseline retained (calibration complete)");
    }
  }
}

// Baseline write from app — overwrites current baseline immediately
void onBaselineWrite(uint16_t conn_hdl, BLECharacteristic* chr, uint8_t* data, uint16_t len) {
  if (len != 12) {
    LOG_E("[Baseline] write invalid length: %u", len);
    return;
  }
  float r, p, y;
  memcpy(&r, data, 4);
  memcpy(&p, data + 4, 4);
  memcpy(&y, data + 8, 4);
  baselineRoll  = r;
  basePitch_arm = p;
  baselineYaw   = y;
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

// ── Sleep / wake helpers ──────────────────────────────────────────────────────
void enterSleep() {
  if (sleeping) return;
  sleeping = true;
  LOG_I("[Sleep] inactivity timeout — entering light sleep");
  if (Bluefruit.Periph.connected()) {
    uint8_t sbuf[STATE_PACKET_MAX_LEN];
    uint8_t sn = pkt_sleep(sbuf);
    stateChar.notify(sbuf, sn);
    delay(80);  // let the notification flush before disconnect
    Bluefruit.disconnect(0);
    delay(50);
  }
  // Keep advertising at a very slow interval — this does two things:
  // 1. SoftDevice advertising events periodically wake the CPU so the IMU can be polled
  //    (without this, waitForEvent() sleeps forever since no INT pin is wired)
  // 2. The phone can still reconnect and wake the device via BLE
  Bluefruit.Advertising.stop();
  Bluefruit.Advertising.setInterval(1600, 3200);  // ~2–3s interval, ~10x less power than active
  Bluefruit.Advertising.start(0);

  // Clear arm state on sleep — app re-arms when waking
  if (armed) {
    armed = false;
    float zeros[3] = {0, 0, 0};
    deltaChar.write(zeros, 12);
  }

  // Disable high-frequency reports — SH-2 protocol: reportInterval_us = 0 stops the report.
  // The library has no disable* methods; enableReport(..., 0) is the correct approach.
  // NOTE: do NOT call enableReport on TAP_DETECTOR with 0 — for event sensors, 0 ARMS them.
  imu.enableReport(SENSOR_REPORTID_ROTATION_VECTOR, 0);
  imu.enableReport(SENSOR_REPORTID_LINEAR_ACCELERATION, 0);
  imu.enableReport(SENSOR_REPORTID_STABILITY_CLASSIFIER, 0);
  imu.enableReport(SENSOR_REPORTID_GYROSCOPE_CALIBRATED, 0);
  // Arm one-shot significant motion detector — fires when wrist moves, wakes device.
  imu.enableReport((sh2_SensorId_t)SH2_SIGNIFICANT_MOTION, 0);

  blinkLED(LED_BLUE, 1, 80, 0);
  LOG_I("[Sleep] light sleep active — waiting for significant motion");
}

void exitSleep() {
  if (!sleeping) return;
  sleeping     = false;
  lastMotionMs = millis();
  LOG_I("[Sleep] waking — restoring reports");
  enableReports();               // restores all reports at their original rates
  // Restore fast advertising interval so phone connects quickly
  Bluefruit.Advertising.setInterval(32, 244);
  blinkLED(LED_BLUE, 2, 60, 60);
}

// ── BLE callbacks ─────────────────────────────────────────────────────────────
void onConnect(uint16_t conn_hdl) {
  lastMotionMs    = millis();
  lastPingMs      = 0;  // fire stab heartbeat within PING_INTERVAL_MS of connect
  // Do NOT reset lastLoggedStab here — BNO085 only fires stab on class change,
  // so if the class didn't change across reconnect, no new event arrives and the
  // heartbeat (which guards on lastLoggedStab <= 4) would never re-emit.
  if (sleeping) exitSleep();
  else pendingEnableReports = true;  // defer I2C ops to loop() — unsafe in BLE callback
  LOG_I("BLE connected. conn_hdl=%u peers=%u", conn_hdl, Bluefruit.Periph.connected());
  LOG_I("[Settings] current: debounce=%lu ms", debounceMs);
}

void onDisconnect(uint16_t conn_hdl, uint8_t reason) {
  LOG_I("BLE disconnected. conn_hdl=%u reason=0x%02X", conn_hdl, reason);
  // Reset calibration state for fresh start on next connect
  calibrationComplete = false;
  baselineCaptured = false;
  calInProgress = false;
  calBuffer.reset();
  // Note: armed flag remains as-is; the app will disarm if needed. But for power,
  // it's fine — device will eventually sleep and reset anyway.
  Bluefruit.Advertising.start(0);
  LOG_I("BLE advertising restarted.");
}

// ── Setup ─────────────────────────────────────────────────────────────────────
void blinkLED(int pin, int times, int onMs = 150, int offMs = 150) {
  pinMode(pin, OUTPUT);
  for (int i = 0; i < times; i++) {
    digitalWrite(pin, HIGH);  // LED_STATE_ON = HIGH on XIAO nRF52840
    delay(onMs);
    digitalWrite(pin, LOW);
    delay(offMs);
  }
}

void setup() {
  // Blink blue 3 times at boot — visible confirmation firmware is running
  // whether on USB or battery power (no serial monitor needed)
  blinkLED(LED_BLUE, 5);  // 5 blinks = new firmware confirmed

  Serial.begin(115200);

  // ── Power optimizations ───────────────────────────────────────────────────
  // Disable onboard PDM microphone (XIAO nRF52840 Sense: mic power on P1.10)
  // Saves ~1.5mA continuously. Must be done before Wire.begin().
  pinMode(PIN_PDM_PWR, OUTPUT);
  digitalWrite(PIN_PDM_PWR, LOW);

  // Battery monitoring pins
  pinMode(VBAT_ENABLE, OUTPUT);
  digitalWrite(VBAT_ENABLE, LOW);   // hold LOW permanently — divider draws only ~3µA
  pinMode(PIN_CHARGE_STATUS, INPUT_PULLUP);

  // Disable onboard LSM6DS3TR-C — not used (BNO085 is external IMU).
  // Hold it in power-down by never calling Wire.begin() for its address,
  // but we also pull its VDD line low via its CS pin to cut quiescent current.
  // The LSM6DS3 enters power-down automatically if not configured; ~6µA in that state.

  // Set BLE TX power to minimum — adequate for wrist-to-laptop distances (<2m).
  // sd_ble_gap_tx_power_set() equivalent via Bluefruit: done after Bluefruit.begin().

  // ── IMU init ──
  // I2C bus recovery: DFU/reset can interrupt a transaction, leaving SDA stuck low.
  // Full recovery: STOP condition → 9 SCL pulses → STOP condition → reinit Wire.
  Wire.end();
  pinMode(PIN_WIRE_SDA, OUTPUT);
  pinMode(PIN_WIRE_SCL, OUTPUT);
  // STOP: SDA low → SCL high → SDA high
  digitalWrite(PIN_WIRE_SDA, LOW);  delayMicroseconds(20);
  digitalWrite(PIN_WIRE_SCL, HIGH); delayMicroseconds(20);
  digitalWrite(PIN_WIRE_SDA, HIGH); delayMicroseconds(20);
  // 9 clock pulses to release stuck slave
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
  blinkLED(LED_BLUE, 2, 100, 100);  // ★ 2 blinks = I2C recovered

  bool imuOk = false;
  for (int attempt = 0; attempt < 5 && !imuOk; attempt++) {
    // Using 2-arg begin: INT pin is physically wired but the Cortex library's
    // hal_wait_for_int() has a race condition — it waits for INT *before* sending
    // enableReport(), so the BNO08x never receives the command and never asserts
    // INT. Skipping INT pin in begin() bypasses that check and works reliably.
    if (imu.begin(0x4B, Wire) || imu.begin(0x4A, Wire)) {
      imuOk = true;
      break;
    }
    LOG_E("BNO085 not found (attempt %d/5), retrying...", attempt + 1);
    delay(200);
  }
  if (!imuOk) {
    LOG_E("BNO085 not found - check wiring!");
    while (true) { blinkLED(LED_RED, 3, 100, 100); delay(500); }
  }
  LOG_I("BNO085 ready.");
  LOG_I("[IMU] INT pin %d level after begin=%d", BNO085_INT_PIN, digitalRead(BNO085_INT_PIN));

  // Attach interrupt on BNO085 INT pin so waitForEvent() wakes when IMU data
  // is ready. We do NOT pass INT to imu.begin() (see CLAUDE.md for why), but
  // we still need this for CPU wake from low-power sleep.
  pinMode(BNO085_INT_PIN, INPUT_PULLUP);
  attachInterrupt(digitalPinToInterrupt(BNO085_INT_PIN), [](){}, FALLING);

  enableReports();
  blinkLED(LED_BLUE, 3, 100, 100);  // ★ 3 blinks = IMU ready

  // ── BLE init ──
  LOG_I("BLE init...");
  Bluefruit.begin();
  Bluefruit.setTxPower(-20);  // dBm: -40,-20,-16,-12,-8,-4,0,4. -20 sufficient for <2m
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
   baselineChar.setProperties(CHR_PROPS_READ | CHR_PROPS_NOTIFY | CHR_PROPS_WRITE);
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
  LOG_I("BLE advertising as 'RUNE-I'.");
  blinkLED(LED_BLUE, 4, 100, 100);  // ★ 4 blinks = setup complete, entering loop
}

// ── IMU event handlers ────────────────────────────────────────────────────────
// One function per sensor report. Registered in IMU_HANDLERS dispatch table below.
// Adding a new sensor = add a handler function + one entry in the table.

#ifdef ENABLE_SHAKE
static void handleLinearAcceleration() {
  float ax = imu.getLinAccelX();
  float ay = imu.getLinAccelY();
  float az = imu.getLinAccelZ();
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

  const char* gesture = gestureDetector.update(gx, gy, gz);
  if (gesture) {
    float integ = gestureDetector.lastIntegral();
    char buf[40] = {};
    snprintf(buf, sizeof(buf), "%s|%.2f|%.2f|%.2f|%.2f", gesture, gx, gy, gz, integ);
    gestureChar.notify(buf, 40);
    lastMotionMs = millis();
    _stabDetector.markMotion(lastMotionMs);
    LOG_I("[Gesture] %s gx=%.2f gy=%.2f gz=%.2f integ=%.2f", gesture, gx, gy, gz, integ);
  }
}
#endif

static void handleSignificantMotion() {
  LOG_I("[Sleep] significant motion — waking");
  if (sleeping) exitSleep();
  // One-shot sensor; re-arming only happens in the next enterSleep() call.
}

static void handleRotationVector() {
  if (sleeping) return;

  float w = imu.getQuatReal();
  float x = imu.getQuatI();
  float y = imu.getQuatJ();
  float z = imu.getQuatK();
  float roll  = quaternionToRoll(w, x, y, z)  * 57.296f;
  float pitch = quaternionToPitch(w, x, y, z) * 57.296f;
  float yaw   = quaternionToYaw(w, x, y, z)   * 57.296f;
  mountAdapter.transform(roll, pitch, yaw);

  // Track current Euler for stability-triggered rebase
  lastRoll = roll; lastPitch = pitch; lastYaw = yaw;

   stillDetector->onRotationVector(roll, pitch, yaw, millis());
   // Only allow rebase after calibration is confirmed
   if (armed && calibrationComplete && stillDetector->shouldRebase()) {
     baselineRoll  = roll;
     basePitch_arm = pitch;
     baselineYaw   = yaw;
     if (Bluefruit.Periph.connected()) {
       publishBaseline(baselineRoll, basePitch_arm, baselineYaw);
     }
     LOG_I("[Rebase] stillness rebase: r=%.1f p=%.1f y=%.1f", roll, pitch, yaw);
   }

  if (!Bluefruit.Periph.connected()) return;

  if (rawMode) {
    char buf[40] = {};
    snprintf(buf, sizeof(buf), "raw|%.1f|%.1f|%.1f", roll, pitch, yaw);
    gestureChar.notify(buf, 40);
  }

   // ── Calibration: accumulate stable samples in rolling window, then average ──
   // baselineCaptured is a global (shared across functions)
   if (armed) {
     // Only accumulate new baseline if calibration not yet complete
     if (!calibrationComplete) {
       if (!baselineCaptured) {
         if (!calInProgress) { calBuffer.reset(); calInProgress = true; }
         calBuffer.push(roll, pitch, yaw);

         if (calBuffer.isFull()) {
           calInProgress = false;
           baselineCaptured = true;
           calBuffer.getAverage(baselineRoll, basePitch_arm, baselineYaw);
           publishBaseline(baselineRoll, basePitch_arm, baselineYaw);
           LOG_I("[Cal] baseline captured: r=%.1f p=%.1f y=%.1f (%d samples)",
                 baselineRoll, basePitch_arm, baselineYaw, MAX_CAL_SAMPLES);
           // If already armed when capture completes, that also confirms calibration
           if (armed && !calibrationComplete) {
             calibrationComplete = true;
             LOG_I("[Cal] calibration confirmed via capture");
           }
         }
       }
     }

     unsigned long now = millis();
     if (now - lastDeltaMs >= 20) {
       lastDeltaMs = now;
       if (currentMode == MODE_KNOB) {
        float dr = roll  - baselineRoll;
        float dp = pitch - basePitch_arm;
        float dy = yaw   - baselineYaw;
        while (dr >  180.0f) dr -= 360.0f; while (dr < -180.0f) dr += 360.0f;
        while (dp >  180.0f) dp -= 360.0f; while (dp < -180.0f) dp += 360.0f;
        while (dy >  180.0f) dy -= 360.0f; while (dy < -180.0f) dy += 360.0f;
        float deltas[3] = { dr, dp, dy };
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
     // Disarmed: only reset calibration state if we haven't completed initial calibration
     if (!calibrationComplete) {
       baselineCaptured = false;
       calInProgress = false;
     }
   }
 }

static void handleStabilityClassifier() {
  uint8_t stab = imu.getStabilityClassifier();
  unsigned long now = millis();
  LOG_I("[StabRaw] stab=%u connected=%d", stab, Bluefruit.Periph.connected() ? 1 : 0);

   stillDetector->onStabilityClass(stab, now);
   // Only allow rebase after initial calibration is confirmed
   if (armed && calibrationComplete && stillDetector->shouldRebase()) {
     baselineRoll  = lastRoll;
     basePitch_arm = lastPitch;
     baselineYaw   = lastYaw;
     publishBaseline(baselineRoll, basePitch_arm, baselineYaw);
     LOG_I("[Rebase] stability rebase: r=%.1f p=%.1f y=%.1f", lastRoll, lastPitch, lastYaw);
   }

  // Only log on state change to avoid spam (~40ms events flood everything)
  if (stab != lastLoggedStab) {
    lastLoggedStab = stab;
    LOG_I("[Stab] s=%u (1=table,2=stationary,3=stable,0=unknown)", stab);
  }
  // Only notify when BLE is connected — calling notify() before the
  // SoftDevice has a valid connection handle causes a hard fault on nRF52.
  if (Bluefruit.Periph.connected()) {
    uint8_t sbuf[STATE_PACKET_MAX_LEN];
    uint8_t sn = pkt_stab(sbuf, stab);
    stateChar.notify(sbuf, sn);
  }
}

// ── IMU dispatch table ────────────────────────────────────────────────────────
// Add new sensors here — no changes needed in loop().

static const struct { uint8_t id; void(*fn)(); } IMU_HANDLERS[] = {
#ifdef ENABLE_SHAKE
  { SENSOR_REPORTID_LINEAR_ACCELERATION,   handleLinearAcceleration  },
#endif
#ifdef ENABLE_TAP
  { SENSOR_REPORTID_TAP_DETECTOR,          handleTapDetector         },
#endif
#ifdef ENABLE_STEP
  { SENSOR_REPORTID_STEP_COUNTER,          handleStepCounter         },
#endif
#ifdef ENABLE_GRYO
  { SENSOR_REPORTID_GYROSCOPE_CALIBRATED,  handleGyroCalibrated      },
#endif
  { (uint8_t)SH2_SIGNIFICANT_MOTION,       handleSignificantMotion   },
  { SENSOR_REPORTID_ROTATION_VECTOR,       handleRotationVector      },
  { SENSOR_REPORTID_STABILITY_CLASSIFIER,  handleStabilityClassifier },
};

static void dispatchIMUEvent(uint8_t eventId) {
  for (const auto& h : IMU_HANDLERS) {
    if (h.id == eventId) { h.fn(); return; }
  }
  LOG_I("[IMU] unhandled eventId=0x%02X", eventId);
}

// ── Loop ──────────────────────────────────────────────────────────────────────
void loop() {
  static bool firstLoop = true;

  if (pendingEnableReports) {
    pendingEnableReports = false;
    enableReports();
  }

  bool imuReset = imu.wasReset();
  if (imuReset) {
    if (!firstLoop) {
      LOG_E("[IMU] BNO085 reset detected — re-enabling reports");
      if (sleeping) {
        imu.enableReport((sh2_SensorId_t)SH2_SIGNIFICANT_MOTION, 0);
      } else {
        enableReports();
      }
    } else {
      LOG_I("[IMU] boot-time reset flag cleared");
    }
  }
  firstLoop = false;
  if (!imuReset) {
    bool gotEvent = imu.getSensorEvent();
    if (gotEvent) {
      uint8_t eid = imu.getSensorEventID();
      static uint8_t lastEventId = 0xFF;
      if (eid != lastEventId) {
        lastEventId = eid;
        LOG_I("[IMU] eventId=0x%02X", eid);
      }
      dispatchIMUEvent(eid);
    }
  }

  // Keepalive ping
  if (Bluefruit.Periph.connected()) {
    unsigned long now = millis();
    if (now - lastPingMs > PING_INTERVAL_MS) {
      lastPingMs = now;
      gestureChar.notify("ping", 4);
      // Re-emit last known stability class every ping cycle.
      // BNO085 only fires stab events on class change — if the device was already
      // stable before the phone connected, the app never gets a stab event and
      // calibration hangs forever. This heartbeat guarantees one delivery within
      // PING_INTERVAL_MS of the CCCD being written.
      if (lastLoggedStab <= 4) {
        uint8_t hbuf[STATE_PACKET_MAX_LEN];
        uint8_t hn = pkt_stab(hbuf, lastLoggedStab);
        stateChar.notify(hbuf, hn);
      }
    }
  }

  // ── Sleep entry check ────────────────────────────────────────────────────
  // Trigger even when connected — a connected-but-idle device (no gestures for
  // SLEEP_TIMEOUT_MS) should still sleep. enterSleep() disconnects the phone;
  // onConnect() calls exitSleep() if the phone reconnects.
  if (!sleeping) {
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

  // Yield CPU every loop — lets SoftDevice put nRF52840 to sleep between BLE
  // connection events and IMU interrupts. Saves ~2-3mA during active use.
  // BNO085 INT pin (pin 1) wakes the CPU when IMU data is ready.
  waitForEvent();
}
