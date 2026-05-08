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

// Rejection reason for debug logging.
enum class ArbReject : uint8_t {
    NONE       = 0,  // gesture fired — no rejection
    NO_CAND    = 1,  // no valid axis candidate at all
    MIN_INTEG  = 2,  // dominant integral below MIN_INTEGRAL
    RATIO      = 3,  // dominant axis failed ratio test
};

// Debug info from the last arbitrate() call — populated whether or not a
// gesture fires. Caller can log this when valid=true but rejected.
struct ArbDebug {
    bool        hadCandidate;   // at least one axis candidate was valid
    GestureAxis dominantAxis;
    float       dominantInteg;  // signed
    float       otherSum;       // sum of |integral| of non-dominant axes
    float       ratio;          // dominantAbs / (otherSum + EPSILON)
    ArbReject   reject;
};

// ---------------------------------------------------------------------------
// GestureArbitrator
// ---------------------------------------------------------------------------

class GestureArbitrator {
public:
    // Tuneable constants — all named, no magic numbers in the algorithm body.
    // 1.5: roll passes easily (10x ratio); pitch passes with natural cross-axis coupling
    // (~1.5-1.8x). 2.0 was too strict — blocked all pitch gestures in practice.
    static constexpr float DOMINANT_RATIO_THRESHOLD = 1.5f;
    // Small epsilon added to the denominator to prevent divide-by-zero when
    // all non-dominant candidates have zero integrals.
    static constexpr float DENOMINATOR_EPSILON = 0.001f;
    // Absolute minimum |integral| for any axis to be considered a real gesture.
    // Tuned against real-use logs:
    //   - Bleeds during arm-up/arm-down arcs cluster at 0.15–0.30 rad
    //   - Legitimate gentle pitches sit at 0.30–0.50 rad (with high peakRate)
    //   - Strong flicks are 0.7+ rad
    // 0.35 (~20°) is a noise floor that cuts the small bleed band but keeps
    // gentle deliberate pitches intact. Higher integ-range bleeds are caught
    // by the screen-level settle gate (Discovery's pitch_down → openDevice).
    // Symbol mode unaffected — that path consumes raw IMU samples directly.
    // History: originally 0.40; lowered to 0.20 for gentle gestures; tried
    // 0.50 (cut too many real pitches); landed at 0.35.
    // If pitch bleed remains, consider per-axis thresholds (pitch lower).
    static constexpr float MIN_INTEGRAL = 0.30f;

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
                           AxisCandidate yaw,
                           ArbDebug* dbg = nullptr) const
    {
        constexpr GestureEvent NO_EVENT = {false, GestureAxis::ROLL, 0};
        ArbDebug localDbg = {false, GestureAxis::ROLL, 0.0f, 0.0f, 0.0f, ArbReject::NO_CAND};

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
            if (dbg) { localDbg.reject = ArbReject::NO_CAND; *dbg = localDbg; }
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

        float ratio = dominantAbs / (otherSum + DENOMINATOR_EPSILON);

        localDbg.hadCandidate  = true;
        localDbg.dominantAxis  = slots[dominantIdx].axis;
        localDbg.dominantInteg = slots[dominantIdx].cand->integral;
        localDbg.otherSum      = otherSum;
        localDbg.ratio         = ratio;

        // ----------------------------------------------------------------
        // 4. Absolute minimum check — reject noise and cross-axis bleed.
        // ----------------------------------------------------------------
        if (dominantAbs < MIN_INTEGRAL) {
            localDbg.reject = ArbReject::MIN_INTEG;
            if (dbg) *dbg = localDbg;
            return NO_EVENT;
        }

        // ----------------------------------------------------------------
        // 5. Ratio test.
        // ----------------------------------------------------------------
        if (ratio < DOMINANT_RATIO_THRESHOLD) {
            localDbg.reject = ArbReject::RATIO;
            if (dbg) *dbg = localDbg;
            return NO_EVENT;
        }

        // ----------------------------------------------------------------
        // 6. Emit event.
        // ----------------------------------------------------------------
        localDbg.reject = ArbReject::NONE;
        if (dbg) *dbg = localDbg;
        const AxisCandidate& winner = *slots[dominantIdx].cand;
        GestureEvent evt;
        evt.valid     = true;
        evt.axis      = slots[dominantIdx].axis;
        evt.direction = (winner.integral >= 0.0f) ? static_cast<int8_t>(1)
                                                   : static_cast<int8_t>(-1);
        return evt;
    }
};
