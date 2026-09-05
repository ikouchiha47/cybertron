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

    // Cross-axis refractory window. Roll, pitch, and yaw each run a fully
    // independent AxisDetector FSM (see AxisDetector.h) with no coordination
    // between them. A real wrist "turn" (roll) commonly drags in incidental
    // pitch/yaw motion — biomechanically coupled, not intentional — which can
    // independently complete its own ONSET->PEAK->DECAY cycle a few hundred ms
    // after the intended gesture fires, and pass the arbitrator's ratio test
    // on its own. That produces a spurious second gesture (e.g. turn_right
    // immediately followed by pitch_up) for one physical motion.
    //
    // Fix: once any axis fires, reset all three axis detectors and suppress
    // further fires for this window. Unvalidated — needs tuning against real
    // motion data per CLAUDE.md, same as every other timing constant here.
    static constexpr uint32_t CROSS_AXIS_REFRACTORY_MS = 250;

    void reset() {
        _roll.reset();
        _pitch.reset();
        _yaw.reset();
        _lastMicros   = 0;
        _firstSample  = true;
        _integralThreshold = INTEGRAL_THRESHOLD;
        _refractoryMs = 0;
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

        // Count down the cross-axis refractory window regardless of whether
        // a candidate fires this sample.
        _refractoryMs = (_refractoryMs > elapsedMs) ? (_refractoryMs - elapsedMs) : 0;

        GestureEvent evt = _arb.arbitrate(cr, cp, cy, &_lastArbDebug);
        if (!evt.valid) return nullptr;

        // A candidate fired. Reset every axis so a stale/dropped window
        // integral can't linger into the next real gesture — this applies
        // whether we go on to emit it or suppress it below.
        _roll.reset();
        _pitch.reset();
        _yaw.reset();

        if (_refractoryMs > 0) {
            // Inside the lockout from a previous fire — treat as cross-axis
            // bleed from the same physical motion, not a new gesture.
            return nullptr;
        }
        _refractoryMs = CROSS_AXIS_REFRACTORY_MS;

        switch (evt.axis) {
            case GestureAxis::ROLL:  _lastIntegral = cr.integral; _lastPeakRate = cr.peakRate; break;
            case GestureAxis::PITCH: _lastIntegral = cp.integral; _lastPeakRate = cp.peakRate; break;
            case GestureAxis::YAW:   _lastIntegral = cy.integral; _lastPeakRate = cy.peakRate; break;
        }
        // Snapshot ALL three axis candidates at the instant this gesture
        // fired — not just the winner. Lets a caller (BLE PKT_ARB_DEBUG)
        // tell apart "arbitrator picked the wrong axis" (a losing axis'
        // integral was suspiciously close to the winner's) from ordinary
        // single-axis motion (losing axes near zero).
        _lastRollInteg  = cr.integral;  _lastRollPeak  = cr.peakRate;
        _lastPitchInteg = cp.integral;  _lastPitchPeak = cp.peakRate;
        _lastYawInteg   = cy.integral;  _lastYawPeak   = cy.peakRate;
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

    float lastIntegral()        const { return _lastIntegral; }
    float lastPeakRate()        const { return _lastPeakRate; }
    const ArbDebug& lastArbDebug() const { return _lastArbDebug; }

    // All-three-axis candidate snapshot from the instant the last gesture
    // fired — for PKT_ARB_DEBUG. See the comment at the assignment site.
    float lastRollInteg()  const { return _lastRollInteg;  }
    float lastPitchInteg() const { return _lastPitchInteg; }
    float lastYawInteg()   const { return _lastYawInteg;   }
    float lastRollPeak()   const { return _lastRollPeak;   }
    float lastPitchPeak()  const { return _lastPitchPeak;  }
    float lastYawPeak()    const { return _lastYawPeak;    }

    /** Runtime tuning — lets BLE settings char update the integral threshold. */
    void setIntegralThreshold(float t) {
        _integralThreshold = t;
        // NOTE: AxisDetector uses the compile-time INTEGRAL_THRESHOLD constant.
        // To make this truly runtime-tunable, AxisDetector would need a setter.
        // For now this stores the value for logging; Phase 4+ can add the setter.
    }
    float integralThreshold() const { return _integralThreshold; }

    /** Per-axis arbitrator floor — runtime-tunable via BLE minIntegralsChar. */
    void  setMinIntegralPitch(float v)   { _arb.setMinIntegralPitch(v); }
    void  setMinIntegralRollYaw(float v) { _arb.setMinIntegralRollYaw(v); }
    float minIntegralPitch()   const { return _arb.getMinIntegralPitch(); }
    float minIntegralRollYaw() const { return _arb.getMinIntegralRollYaw(); }

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
    float    _lastIntegral = 0.0f;
    float    _lastPeakRate = 0.0f;
    float    _lastRollInteg  = 0.0f;
    float    _lastPitchInteg = 0.0f;
    float    _lastYawInteg   = 0.0f;
    float    _lastRollPeak   = 0.0f;
    float    _lastPitchPeak  = 0.0f;
    float    _lastYawPeak    = 0.0f;
    uint32_t _refractoryMs = 0;
    ArbDebug _lastArbDebug = {false, GestureAxis::ROLL, 0.0f, 0.0f, 0.0f, ArbReject::NO_CAND};
};
