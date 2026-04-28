#pragma once
/**
 * AxisDetector.h — Phase 1 + Phase 3 of the gesture detection rewrite.
 *
 * Windowed gyro integration with jerk-onset gate, 4-state FSM, and ZUPT.
 * Header-only, pure C++17, zero Arduino dependencies, zero dynamic allocation.
 *
 * Interface consumed by Phase 2 (GestureArbitrator):
 *   struct AxisCandidate  — emitted when a gesture motion is detected
 *   class  AxisDetector   — one instance per axis (roll, pitch, yaw)
 *
 * See GESTURE_REWRITE.md Phase 1 + Phase 3 for algorithm description.
 */

#include <cmath>   // fabsf — available on both g++ and arm-gcc

// ── Tunable constants ─────────────────────────────────────────────────────────

/** Jerk magnitude (rad/s²) that opens the ONSET window.
 *  Lowered from 8.0 → 3.0 to allow slower wrist movements to register.
 *  At 3.0 rad/s², a gentle wrist turn (~30°/s²) will trigger detection. */
static constexpr float    JERK_ONSET_THRESHOLD  = 3.0f;

/** Minimum signed integral (rad) to advance ONSET→PEAK. ~8.6 degrees.
 *  Lowered from 0.25 → 0.15 so smaller rotations (not just sharp flicks) fire. */
static constexpr float    INTEGRAL_THRESHOLD    = 0.15f;

/** Gyro magnitude (rad/s) below which PEAK transitions to DECAY. */
static constexpr float    DECAY_THRESHOLD       = 0.15f;

/** Gyro magnitude (rad/s) below which DECAY transitions to IDLE (fires). */
static constexpr float    ZUPT_GYRO_THRESHOLD   = 0.03f;

/** Consecutive sub-ZUPT samples required before isQuiet() == true. ~400ms at 50Hz. */
static constexpr int      ZUPT_MIN_SAMPLES      = 20;

/** ONSET must reach PEAK within this window, else reset to IDLE (noise rejection).
 *  Increased from 300 → 600ms to allow slower movements to accumulate integral. */
static constexpr uint32_t ONSET_TIMEOUT_MS      = 600;

/** PEAK must see gyro drop below DECAY_THRESHOLD within this window, else reset to IDLE
 *  (held-position rejection — user held wrist still at peak angle). */
static constexpr uint32_t PEAK_TIMEOUT_MS       = 200;

/** Ring buffer depth. Must be a power-of-two. */
static constexpr int      RING_BUFFER_SIZE      = 32;
static constexpr int      RING_BUFFER_MASK      = RING_BUFFER_SIZE - 1;

// ── Data types ────────────────────────────────────────────────────────────────

/**
 * Emitted by AxisDetector::update() on DECAY→IDLE transition.
 * Consumed by GestureArbitrator (Phase 2).
 */
#ifndef AXIS_CANDIDATE_DEFINED
#define AXIS_CANDIDATE_DEFINED
struct AxisCandidate {
    bool  valid;
    float integral;   // signed — direction = sign(integral)
    float peakRate;   // peak |gyro| seen during ONSET+PEAK window (rad/s)
};
#endif

// ── AxisDetector ──────────────────────────────────────────────────────────────

class AxisDetector {
public:

    enum class AxisState : uint8_t { IDLE, ONSET, PEAK, DECAY };

    AxisDetector() { reset(); }

    void reset() {
        for (int i = 0; i < RING_BUFFER_SIZE; ++i) { _gyro[i] = 0.0f; _dt[i] = 0.0f; }
        _head       = 0;
        _count      = 0;
        _prevGyro   = 0.0f;
        _windowSum  = 0.0f;
        _peakRate   = 0.0f;
        _quietCount = 0;
        _state      = AxisState::IDLE;
        _stateMs    = 0;
        _fireIntegral = 0.0f;
        _firePeak     = 0.0f;
    }

    /**
     * Call once per gyro sample.
     *
     * @param gyroVal    Calibrated angular rate for this axis (rad/s).
     * @param dt         Time since previous sample (seconds). Typical: ~0.020 s at 50 Hz.
     * @param elapsedMs  Milliseconds since last call (same value as dt*1000, kept separate
     *                   to avoid float precision loss in timeout comparisons).
     *                   On Arduino: pass (uint32_t)(dt * 1000.0f) or track millis() delta.
     *                   On desktop tests: pass 20 for a synthetic 50 Hz stream.
     * @return           AxisCandidate{valid=true} only on the DECAY→IDLE transition.
     */
    AxisCandidate update(float gyroVal, float dt, uint32_t elapsedMs) {
        AxisCandidate result = { false, 0.0f, 0.0f };

        // ── 1. Ring buffer ────────────────────────────────────────────────────
        _gyro[_head] = gyroVal;
        _dt[_head]   = dt;
        _head        = (_head + 1) & RING_BUFFER_MASK;
        if (_count < RING_BUFFER_SIZE) ++_count;

        // ── 2. Recompute window integral (always, cheap at 32 iters) ─────────
        {
            float sum  = 0.0f;
            float peak = 0.0f;
            int n = (_count < RING_BUFFER_SIZE) ? _count : RING_BUFFER_SIZE;
            for (int i = 0; i < n; ++i) {
                int idx = (_head - 1 - i + RING_BUFFER_SIZE) & RING_BUFFER_MASK;
                sum += _gyro[idx] * _dt[idx];
                float mag = fabsf(_gyro[idx]);
                if (mag > peak) peak = mag;
            }
            _windowSum = sum;
            _peakRate  = peak;
        }

        // ── 3. FSM ────────────────────────────────────────────────────────────
        float absGyro = fabsf(gyroVal);
        _stateMs += elapsedMs;

        switch (_state) {

            case AxisState::IDLE: {
                // Jerk onset gate
                if (dt > 0.0f) {
                    float jerk = (gyroVal - _prevGyro) / dt;
                    if (fabsf(jerk) > JERK_ONSET_THRESHOLD) {
                        _state   = AxisState::ONSET;
                        _stateMs = 0;
                    }
                }
                break;
            }

            case AxisState::ONSET: {
                if (fabsf(_windowSum) > INTEGRAL_THRESHOLD) {
                    // Integral crossed threshold — lock in the fired values
                    _fireIntegral = _windowSum;
                    _firePeak     = _peakRate;
                    _state        = AxisState::PEAK;
                    _stateMs      = 0;
                } else if (_stateMs > ONSET_TIMEOUT_MS) {
                    // Too slow — noise or drift, not a deliberate gesture
                    _state   = AxisState::IDLE;
                    _stateMs = 0;
                }
                break;
            }

            case AxisState::PEAK: {
                if (absGyro < DECAY_THRESHOLD) {
                    _state   = AxisState::DECAY;
                    _stateMs = 0;
                } else if (_stateMs > PEAK_TIMEOUT_MS) {
                    // Held position — user stopped at the peak angle, not a flick
                    _state   = AxisState::IDLE;
                    _stateMs = 0;
                }
                break;
            }

            case AxisState::DECAY: {
                if (absGyro < ZUPT_GYRO_THRESHOLD) {
                    // Motion complete — fire the candidate
                    result.valid    = true;
                    result.integral = _fireIntegral;
                    result.peakRate = _firePeak;
                    _state   = AxisState::IDLE;
                    _stateMs = 0;
                    _fireIntegral = 0.0f;
                    _firePeak     = 0.0f;
                }
                // No timeout on DECAY — the motion always completes eventually.
                // If gyro never drops below ZUPT_GYRO_THRESHOLD the device is in
                // continuous motion; we wait indefinitely.
                break;
            }
        }

        _prevGyro = gyroVal;

        // ── 4. ZUPT tracking (independent of FSM) ─────────────────────────────
        if (absGyro < ZUPT_GYRO_THRESHOLD) {
            if (_quietCount < ZUPT_MIN_SAMPLES + 1) ++_quietCount;
        } else {
            _quietCount = 0;
        }

        return result;
    }

    // ── Accessors ──────────────────────────────────────────────────────────────

    /** True when axis has been still for ZUPT_MIN_SAMPLES consecutive samples. */
    bool isQuiet() const { return _quietCount >= ZUPT_MIN_SAMPLES; }

    /** Current FSM state — useful for serial logging in firmware. */
    AxisState state() const { return _state; }

    /** Raw window integral — useful for diagnostics and threshold tuning. */
    float windowSum() const { return _windowSum; }

private:
    // Ring buffer — 256 bytes per axis (32 × float × 2 arrays)
    float _gyro[RING_BUFFER_SIZE];
    float _dt[RING_BUFFER_SIZE];
    int   _head;
    int   _count;

    // Gyro history for jerk calculation
    float _prevGyro;

    // Window integral and peak (recomputed each sample)
    float _windowSum;
    float _peakRate;

    // Values captured at ONSET→PEAK transition, emitted on DECAY→IDLE
    float _fireIntegral;
    float _firePeak;

    // FSM
    AxisState _state;
    uint32_t  _stateMs;   // milliseconds spent in current state

    // ZUPT
    int _quietCount;
};
