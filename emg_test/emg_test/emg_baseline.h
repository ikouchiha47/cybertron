#pragma once
#include <stdint.h>

/**
 * Tracks the resting EMG baseline with an exponential moving average.
 *
 * The MuscleAmp Candy has a DC-biased output (~half-rail at rest).
 * We track that resting value so the detector works regardless of exact bias.
 *
 * Alpha is applied as a power-of-2 shift for cheap integer math:
 *   new_ema = ema + (sample - ema) >> SHIFT
 *
 * SHIFT=7  => alpha ≈ 0.0078  => ~128-sample time constant (~128 ms at 1 kHz)
 * SHIFT=8  => alpha ≈ 0.0039  => ~256-sample time constant (~256 ms)
 *
 * Use a slower alpha (larger shift) once baseline is settled to avoid the
 * resting estimate drifting upward during sustained muscle activation.
 */
class EmgBaseline {
public:
    static constexpr uint8_t FAST_SHIFT   = 6;   // settling phase (~64 ms)
    static constexpr uint8_t SLOW_SHIFT   = 9;   // tracking phase  (~512 ms)
    static constexpr uint16_t SETTLE_COUNT = 512; // samples before switching to slow

    void reset() {
        ema_    = 0;
        count_  = 0;
        settled_= false;
    }

    void update(uint16_t sample) {
        if (count_ == 0) {
            ema_ = (uint32_t)sample << 8; // fixed-point: Q8 format
        } else {
            uint8_t shift = settled_ ? SLOW_SHIFT : FAST_SHIFT;
            // Q8 fixed-point EMA: ema += (sample - (ema>>8)) >> shift
            int32_t diff = (int32_t)sample - (int32_t)(ema_ >> 8);
            ema_ = (uint32_t)((int32_t)ema_ + (diff >> shift));
        }

        if (!settled_ && count_ < SETTLE_COUNT) {
            ++count_;
        } else if (!settled_) {
            settled_ = true;
        }
    }

    // Returns the baseline as a 12-bit ADC value.
    uint16_t get() const { return (uint16_t)(ema_ >> 8); }

    bool isSettled() const { return settled_; }

private:
    uint32_t ema_     = 0;
    uint16_t count_   = 0;
    bool     settled_ = false;
};
