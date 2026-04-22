#pragma once

// GestureArbitrator — Phase 2 of gesture detection rewrite.
//
// Given AxisCandidates from three independent AxisDetectors (roll, pitch, yaw),
// select at most one dominant axis and emit a GestureEvent.
//
// Dominant-axis ratio test:
//   ratio = |dominant_integral| / (|other1_integral| + |other2_integral| + EPSILON)
//   ratio >= DOMINANT_RATIO_THRESHOLD  →  emit event
//   ratio <  DOMINANT_RATIO_THRESHOLD  →  ambiguous, emit nothing
//
// Header-only, pure C++17, zero Arduino dependencies, zero dynamic allocation.

#include <cstdint>
#include <cmath>

// AxisCandidate is produced by Phase 1 (AxisDetector).
// Defined here as well so this header is self-contained for testing;
// in firmware, include AxisDetector.h before this header and the
// include guard will prevent a duplicate definition.
#ifndef AXIS_CANDIDATE_DEFINED
#define AXIS_CANDIDATE_DEFINED
struct AxisCandidate {
    bool  valid;
    float integral;   // signed — direction = sign(integral)
    float peakRate;   // peak gyro rate seen during the detection window
};
#endif // AXIS_CANDIDATE_DEFINED

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

enum class GestureAxis : uint8_t {
    ROLL  = 0,
    PITCH = 1,
    YAW   = 2
};

struct GestureEvent {
    bool        valid;
    GestureAxis axis;
    int8_t      direction;  // +1 (positive integral) or -1 (negative integral)
};

// ---------------------------------------------------------------------------
// GestureArbitrator
// ---------------------------------------------------------------------------

class GestureArbitrator {
public:
    // Tuneable constants — all named, no magic numbers in the algorithm body.
    static constexpr float DOMINANT_RATIO_THRESHOLD = 1.5f;
    // Small epsilon added to the denominator to prevent divide-by-zero when
    // all non-dominant candidates have zero integrals.
    static constexpr float DENOMINATOR_EPSILON = 0.001f;

    // arbitrate() may be called on every gyro sample or only when at least
    // one candidate is valid — the caller decides the cadence.
    //
    // Returns a GestureEvent with valid=false when:
    //   - no candidates are valid, or
    //   - only one valid candidate exists but its ratio (vs zero others) still
    //     passes the threshold, or
    //   - the dominant axis fails the ratio test (ambiguous motion).
    GestureEvent arbitrate(AxisCandidate roll,
                           AxisCandidate pitch,
                           AxisCandidate yaw) const
    {
        constexpr GestureEvent NO_EVENT = {false, GestureAxis::ROLL, 0};

        // ----------------------------------------------------------------
        // 1. Collect the three candidates into an indexed array so the
        //    loop below can be axis-agnostic.
        // ----------------------------------------------------------------
        struct Slot {
            const AxisCandidate* cand;
            GestureAxis          axis;
        };
        const Slot slots[3] = {
            {&roll,  GestureAxis::ROLL},
            {&pitch, GestureAxis::PITCH},
            {&yaw,   GestureAxis::YAW},
        };

        // ----------------------------------------------------------------
        // 2. Find the valid candidate with the highest |integral|.
        // ----------------------------------------------------------------
        int   dominantIdx  = -1;
        float dominantAbs  = 0.0f;

        for (int i = 0; i < 3; ++i) {
            if (!slots[i].cand->valid) {
                continue;
            }
            float absVal = fabsf(slots[i].cand->integral);
            if (absVal > dominantAbs) {
                dominantAbs  = absVal;
                dominantIdx  = i;
            }
        }

        // No valid candidate at all.
        if (dominantIdx < 0) {
            return NO_EVENT;
        }

        // ----------------------------------------------------------------
        // 3. Sum |integral| of all OTHER valid candidates.
        // ----------------------------------------------------------------
        float otherSum = 0.0f;
        for (int i = 0; i < 3; ++i) {
            if (i == dominantIdx) {
                continue;
            }
            if (slots[i].cand->valid) {
                otherSum += fabsf(slots[i].cand->integral);
            }
        }

        // ----------------------------------------------------------------
        // 4. Ratio test.
        // ----------------------------------------------------------------
        float ratio = dominantAbs / (otherSum + DENOMINATOR_EPSILON);

        if (ratio < DOMINANT_RATIO_THRESHOLD) {
            // Ambiguous — competing axes are too active relative to the leader.
            return NO_EVENT;
        }

        // ----------------------------------------------------------------
        // 5. Emit event.
        // ----------------------------------------------------------------
        const AxisCandidate& winner = *slots[dominantIdx].cand;
        GestureEvent evt;
        evt.valid     = true;
        evt.axis      = slots[dominantIdx].axis;
        evt.direction = (winner.integral >= 0.0f) ? static_cast<int8_t>(1)
                                                   : static_cast<int8_t>(-1);
        return evt;
    }
};
