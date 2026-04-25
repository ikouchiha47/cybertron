#pragma once
#include <cstdint>
#include <cmath>

// ── Stability classifier levels (BNO085 SH-2 spec) ───────────────────────────
static constexpr uint8_t STABILITY_UNKNOWN    = 0;
static constexpr uint8_t STABILITY_ON_TABLE   = 1;
static constexpr uint8_t STABILITY_STATIONARY = 2;
static constexpr uint8_t STABILITY_STABLE     = 3;

// ── Holdoff after last gesture before stability-triggered rebase is allowed ──
static constexpr unsigned long STABILITY_REBASE_HOLDOFF_MS = 1500;

// ── Rolling-window calibration buffer ─────────────────────────────────────────
// Collects the last N stable readings and computes their average for baseline.
// Using a fixed-size window prevents outliers (shaky hand) from skewing the result.
// Tunable: change MAX_CAL_SAMPLES for different accumulation durations.
//   25 samples @ ~40ms/event ≈ 1.0 s  (default)
//   50 samples ≈ 2.0 s
//   10 samples ≈ 0.4 s
static constexpr uint8_t MAX_CAL_SAMPLES = 25;

struct CalibrationBuffer {
    float roll[MAX_CAL_SAMPLES];
    float pitch[MAX_CAL_SAMPLES];
    float yaw[MAX_CAL_SAMPLES];
    uint8_t count = 0;

    void reset() { count = 0; }
    bool isFull() const { return count >= MAX_CAL_SAMPLES; }

    // Push a new sample; drops oldest when full (sliding window)
    void push(float r, float p, float y) {
        if (count < MAX_CAL_SAMPLES) {
            count++;
        } else {
            // Shift left, drop oldest
            for (uint8_t i = 1; i < MAX_CAL_SAMPLES; i++) {
                roll[i-1]  = roll[i];
                pitch[i-1] = pitch[i];
                yaw[i-1]   = yaw[i];
            }
        }
        uint8_t idx = count < MAX_CAL_SAMPLES ? count - 1 : MAX_CAL_SAMPLES - 1;
        roll[idx]  = r;
        pitch[idx] = p;
        yaw[idx]   = y;
    }

    // Average all collected samples (handles < MAX_CAL_SAMPLES during fill)
    void getAverage(float& r, float& p, float& y) const {
        r = p = y = 0.0f;
        uint8_t n = count;
        for (uint8_t i = 0; i < n; i++) {
            r += roll[i]; p += pitch[i]; y += yaw[i];
        }
        r /= n; p /= n; y /= n;
    }
};

// ── Abstract interface ────────────────────────────────────────────────────────

class IStillnessDetector {
public:
    // Called every rotation vector event with current Euler angles and timestamp
    virtual void onRotationVector(float roll, float pitch, float yaw, unsigned long nowMs) = 0;
    // Called when BNO085 stability classifier event fires
    virtual void onStabilityClass(uint8_t stab, unsigned long nowMs) = 0;
    // Returns true once if a rebase should occur — consumed on read
    virtual bool shouldRebase() = 0;
    // Reset all state — call on mode change, disconnect, sleep
    virtual void reset() = 0;
    virtual ~IStillnessDetector() = default;
};

// ── ManualZUPTDetector ────────────────────────────────────────────────────────
// Detects stillness by monitoring rotation vector stream.
// Fires rebase when all axes stay within STILL_DEG for STILL_MS.
// NOTE: STILL_DEG/STILL_MS are not validated against real human motion data —
// may fail for users with essential tremor or slow movements. Disabled by default.
// Enable with -DENABLE_MANUAL_ZUPT once constants are calibrated.
#ifdef ENABLE_MANUAL_ZUPT

class ManualZUPTDetector : public IStillnessDetector {
    static constexpr float         STILL_DEG = 2.0f;
    static constexpr unsigned long STILL_MS  = 300;

    float         _lastRoll  = 0.0f;
    float         _lastPitch = 0.0f;
    float         _lastYaw   = 0.0f;
    unsigned long _stillSince = 0;
    bool          _pending    = false;
    bool          _initialized = false;

public:
    void onRotationVector(float roll, float pitch, float yaw, unsigned long nowMs) override {
        if (!_initialized) {
            _lastRoll = roll; _lastPitch = pitch; _lastYaw = yaw;
            _stillSince = nowMs;
            _initialized = true;
            return;
        }

        bool moving = fabsf(roll  - _lastRoll)  > STILL_DEG
                   || fabsf(pitch - _lastPitch) > STILL_DEG
                   || fabsf(yaw   - _lastYaw)   > STILL_DEG;

        _lastRoll = roll; _lastPitch = pitch; _lastYaw = yaw;

        if (moving) {
            _stillSince = nowMs;
        } else if ((nowMs - _stillSince) >= STILL_MS) {
            _pending = true;
        }
    }

    void onStabilityClass(uint8_t, unsigned long) override {}  // no-op

    bool shouldRebase() override {
        if (_pending) { _pending = false; return true; }
        return false;
    }

    void reset() override {
        _pending     = false;
        _initialized = false;
        _stillSince  = 0;
    }
};
#endif  // ENABLE_MANUAL_ZUPT

// ── StabilityClassifierDetector ───────────────────────────────────────────────
// Uses BNO085's built-in sensor fusion stability classification.
// More accurate than manual velocity computation — hardware-validated stillness.
// Requires firmware to emit stability classifier events.

class StabilityClassifierDetector : public IStillnessDetector {
    unsigned long _lastMotionMs = 0;
    bool          _pending      = false;

    static bool isStill(uint8_t stab) {
        return stab == STABILITY_ON_TABLE
            || stab == STABILITY_STATIONARY
            || stab == STABILITY_STABLE;
    }

public:
    void onRotationVector(float, float, float, unsigned long) override {}  // no-op

    void onStabilityClass(uint8_t stab, unsigned long nowMs) override {
        if (!isStill(stab)) {
            _lastMotionMs = nowMs;
            return;
        }
        if ((nowMs - _lastMotionMs) >= STABILITY_REBASE_HOLDOFF_MS) {
            _pending = true;
        }
    }

    bool shouldRebase() override {
        if (_pending) { _pending = false; return true; }
        return false;
    }

    void reset() override {
        _pending      = false;
        _lastMotionMs = 0;
    }

    // Call when a gesture fires to reset the holdoff clock
    void markMotion(unsigned long nowMs) {
        _lastMotionMs = nowMs;
        _pending      = false;  // cancel any pending rebase — motion invalidates it
    }
};
