#pragma once
#include <stdint.h>

/**
 * Simple threshold detector for EMG envelope activation.
 *
 * The threshold adapts upward on activation and decays slowly at rest, so
 * it self-tunes over the first few contractions without manual calibration.
 *
 * State machine:
 *   IDLE  -> ACTIVE   when env >= threshold for ONSET_COUNT consecutive samples
 *   ACTIVE -> IDLE    when env <  (threshold * RELEASE_RATIO >> 8) for RELEASE_COUNT samples
 *
 * Threshold update:
 *   On each ACTIVE sample: thr = max(thr, env * HEADROOM >> 8)
 *   On each IDLE  sample:  thr decays by DECAY_SHIFT per sample
 *
 * All arithmetic is integer; no division, no floats.
 */
class EmgDetector {
public:
    // Activation requires envelope to exceed threshold for this many consecutive samples.
    // Dry electrodes produce brief spikes; 3 ms is enough to reject single-sample glitches.
    static constexpr uint8_t  ONSET_COUNT   = 3;   // 3 ms at 1 kHz
    // Release requires envelope to fall below (thr * RELEASE_RATIO>>8) for this many samples.
    static constexpr uint8_t  RELEASE_COUNT = 30;  // 30 ms hysteresis
    // Release threshold = thr * RELEASE_RATIO / 256  (≈ 0.5 × onset threshold)
    static constexpr uint16_t RELEASE_RATIO = 128; // 0.50
    // Threshold is set to max(thr, env * HEADROOM / 256) on activation. 1.1× headroom.
    static constexpr uint16_t HEADROOM      = 282; // 1.10 × 256
    // Threshold floor — must sit above the 50 Hz mains noise floor (~40 counts typical).
    static constexpr uint16_t THR_FLOOR     = 60;
    // Threshold ceiling — prevents runaway adaptation on strong contractions.
    static constexpr uint16_t THR_CEIL      = 1200;
    // Idle decay: thr -= thr >> DECAY_SHIFT each idle sample. Shift=10 → moderate decay.
    static constexpr uint8_t  DECAY_SHIFT   = 10;

    void reset() {
        threshold_ = THR_FLOOR;
        onsetCount_   = 0;
        releaseCount_ = 0;
        active_       = false;
    }

    // Feed the above-baseline envelope value. Returns true while activated.
    bool update(uint16_t env) {
        if (!active_) {
            if (env >= threshold_) {
                ++onsetCount_;
                if (onsetCount_ >= ONSET_COUNT) {
                    active_ = true;
                    onsetCount_ = 0;
                    releaseCount_ = 0;
                    adaptThreshold(env);
                }
            } else {
                onsetCount_ = 0;
                decayThreshold();
            }
        } else {
            adaptThreshold(env);
            uint16_t releaseThr = (uint16_t)((uint32_t)threshold_ * RELEASE_RATIO >> 8);
            if (env < releaseThr) {
                ++releaseCount_;
                if (releaseCount_ >= RELEASE_COUNT) {
                    active_ = false;
                    releaseCount_ = 0;
                }
            } else {
                releaseCount_ = 0;
            }
        }
        return active_;
    }

    uint16_t threshold() const { return threshold_; }
    bool     isActive()  const { return active_; }

private:
    void adaptThreshold(uint16_t env) {
        uint16_t candidate = (uint16_t)((uint32_t)env * HEADROOM >> 8);
        if (candidate > threshold_) threshold_ = candidate;
        if (threshold_ > THR_CEIL)  threshold_ = THR_CEIL;
        if (threshold_ < THR_FLOOR) threshold_ = THR_FLOOR;
    }

    void decayThreshold() {
        if (threshold_ > THR_FLOOR) {
            threshold_ -= (threshold_ >> DECAY_SHIFT);
            if (threshold_ < THR_FLOOR) threshold_ = THR_FLOOR;
        }
    }

    uint16_t threshold_    = THR_FLOOR;
    uint8_t  onsetCount_   = 0;
    uint8_t  releaseCount_ = 0;
    bool     active_       = false;
};
