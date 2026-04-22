#pragma once
/**
 * GestureDetector.h — Phase 5 facade.
 *
 * Owns three AxisDetectors + one GestureArbitrator.
 * Call update() on every GYROSCOPE_CALIBRATED event.
 * Returns a gesture name string on DECAY→IDLE fire, nullptr otherwise.
 *
 * Arduino-compatible: uses micros() for dt. On desktop tests, use
 * updateWithDt() to supply dt directly.
 */

#include "AxisDetector.h"
#include "GestureArbitrator.h"

class GestureDetector {
public:
    GestureDetector() { reset(); }

    void reset() {
        _roll.reset();
        _pitch.reset();
        _yaw.reset();
        _lastMicros   = 0;
        _firstSample  = true;
        _integralThreshold = INTEGRAL_THRESHOLD;
    }

    /** Call when all three axes report isQuiet() — replaces stability rebase. */
    void onQuiet() {
        _roll.reset();
        _pitch.reset();
        _yaw.reset();
    }

    /**
     * Primary entry point for Arduino firmware.
     * Computes dt from micros(), feeds all three detectors, runs arbitration.
     * Returns gesture name ("turn_right" etc.) or nullptr.
     */
    const char* update(float gx, float gy, float gz) {
#ifdef ARDUINO
        uint32_t now = micros();
        float dt = _firstSample ? (1.0f / 50.0f)
                                : (float)(now - _lastMicros) * 1e-6f;
        if (dt <= 0.0f || dt > 0.5f) dt = 1.0f / 50.0f;  // clamp on timer wrap/stall
        _lastMicros  = now;
        _firstSample = false;
        uint32_t ms = (uint32_t)(dt * 1000.0f);
        return updateWithDt(gx, gy, gz, dt, ms);
#else
        // Desktop: fall back to 50Hz nominal
        return updateWithDt(gx, gy, gz, 1.0f / 50.0f, 20);
#endif
    }

    /**
     * Desktop / test entry point — supply dt and elapsedMs explicitly.
     */
    const char* updateWithDt(float gx, float gy, float gz, float dt, uint32_t elapsedMs) {
        AxisCandidate cr = _roll.update(gx,  dt, elapsedMs);
        AxisCandidate cp = _pitch.update(gy, dt, elapsedMs);
        AxisCandidate cy = _yaw.update(gz,   dt, elapsedMs);

        // ZUPT: if all three axes quiet, reset baselines
        if (_roll.isQuiet() && _pitch.isQuiet() && _yaw.isQuiet()) {
            onQuiet();
        }

        GestureEvent evt = _arb.arbitrate(cr, cp, cy);
        if (!evt.valid) return nullptr;

        switch (evt.axis) {
            case GestureAxis::ROLL:
                return evt.direction > 0 ? "turn_right" : "turn_left";
            case GestureAxis::PITCH:
                return evt.direction > 0 ? "pitch_up"   : "pitch_down";
            case GestureAxis::YAW:
                return evt.direction > 0 ? "yaw_right"  : "yaw_left";
        }
        return nullptr;
    }

    /** Runtime tuning — lets BLE settings char update the integral threshold. */
    void setIntegralThreshold(float t) {
        _integralThreshold = t;
        // NOTE: AxisDetector uses the compile-time INTEGRAL_THRESHOLD constant.
        // To make this truly runtime-tunable, AxisDetector would need a setter.
        // For now this stores the value for logging; Phase 4+ can add the setter.
    }
    float integralThreshold() const { return _integralThreshold; }

    // Expose axis states for serial logging
    AxisDetector::AxisState rollState()  const { return _roll.state();  }
    AxisDetector::AxisState pitchState() const { return _pitch.state(); }
    AxisDetector::AxisState yawState()   const { return _yaw.state();   }

private:
    AxisDetector    _roll;
    AxisDetector    _pitch;
    AxisDetector    _yaw;
    GestureArbitrator _arb;

    uint32_t _lastMicros;
    bool     _firstSample;
    float    _integralThreshold;
};
