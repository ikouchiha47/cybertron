#pragma once

/**
 * Software shake detector for BNO08x via SparkFun library.
 *
 * The BNO085 has a native shake detector (FRS record 0x7D7D, report ID 0x19)
 * but the SparkFun library does not expose it. This file mirrors the chip's
 * onboard algorithm using linear acceleration, with the same default parameters
 * from the BNO08X datasheet v1.16 section 2.4.7:
 *
 *   - Acceleration threshold : 8 m/s²
 *   - Direction changes       : 3 (to qualify as a shake)
 *   - Min time between changes: 50ms
 *   - Max time between changes: 400ms
 *   - Axes                    : all (X, Y, Z combined magnitude)
 *
 * Usage:
 *   ShakeDetector shake;
 *
 *   void setup() {
 *     imu.enableLinearAccelerometer();   // enable in your setup
 *   }
 *
 *   void loop() {
 *     if (imu.getSensorEvent() &&
 *         imu.getSensorEventID() == SENSOR_REPORTID_LINEAR_ACCELERATION) {
 *       float ax = imu.getLinAccelX();
 *       float ay = imu.getLinAccelY();
 *       float az = imu.getLinAccelZ();
 *       if (shake.update(ax, ay, az)) {
 *         // shake detected
 *       }
 *     }
 *   }
 */

#include <Arduino.h>

class ShakeDetector {
public:
  // Datasheet defaults
  static constexpr float    ACCEL_THRESHOLD_MS2  = 8.0f;   // m/s²
  static constexpr uint8_t  DIRECTION_CHANGES     = 3;
  static constexpr uint32_t MIN_CHANGE_MS          = 50;
  static constexpr uint32_t MAX_CHANGE_MS          = 400;

  ShakeDetector()
    : _lastSign(0), _changes(0), _lastChangeMs(0) {}

  // Call every time a LINEAR_ACCELERATION event arrives.
  // Returns true on the frame a shake is confirmed.
  bool update(float ax, float ay, float az) {
    float magnitude = sqrtf(ax*ax + ay*ay + az*az);

    if (magnitude < ACCEL_THRESHOLD_MS2) {
      return false;  // below threshold, ignore
    }

    // Use the dominant axis sign as the direction indicator
    int8_t sign = (magnitude > 0) ? 1 : -1;
    // Determine dominant axis for sign tracking
    float absX = fabsf(ax), absY = fabsf(ay), absZ = fabsf(az);
    if (absX >= absY && absX >= absZ)      sign = (ax > 0) ? 1 : -1;
    else if (absY >= absX && absY >= absZ) sign = (ay > 0) ? 1 : -1;
    else                                   sign = (az > 0) ? 1 : -1;

    uint32_t now = millis();

    if (sign != _lastSign && _lastSign != 0) {
      uint32_t elapsed = now - _lastChangeMs;

      if (elapsed >= MIN_CHANGE_MS && elapsed <= MAX_CHANGE_MS) {
        _changes++;
        if (_changes >= DIRECTION_CHANGES) {
          _reset();
          return true;   // shake confirmed
        }
      } else {
        // Change was too fast or too slow — reset
        _reset();
      }
      _lastChangeMs = now;
    } else if (_lastSign == 0) {
      _lastChangeMs = now;
    }

    // Timeout — direction change window expired
    if (_changes > 0 && (now - _lastChangeMs) > MAX_CHANGE_MS) {
      _reset();
    }

    _lastSign = sign;
    return false;
  }

private:
  int8_t   _lastSign;
  uint8_t  _changes;
  uint32_t _lastChangeMs;

  void _reset() {
    _lastSign     = 0;
    _changes      = 0;
    _lastChangeMs = 0;
  }
};
