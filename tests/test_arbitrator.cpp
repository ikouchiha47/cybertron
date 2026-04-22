// Standalone unit tests for GestureArbitrator (Phase 2).
//
// Build:
//   g++ -std=c++17 -Wall -Wextra -I../wristturn_audrino/wristturn \
//       test_arbitrator.cpp -o test_arbitrator && ./test_arbitrator
//
// No external test framework — uses assert() and printf only.

#include <cassert>
#include <cmath>
#include <cstdio>

// Pull in the header under test.  The relative path matches the build command
// above; adjust if you run from a different directory.
#include "gesture/GestureArbitrator.h"

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

static AxisCandidate make(bool valid, float integral, float peakRate = 0.0f)
{
    AxisCandidate c;
    c.valid    = valid;
    c.integral = integral;
    c.peakRate = peakRate;
    return c;
}

// Friendly axis names for failure messages.
static const char* axis_name(GestureAxis a)
{
    switch (a) {
        case GestureAxis::ROLL:  return "ROLL";
        case GestureAxis::PITCH: return "PITCH";
        case GestureAxis::YAW:   return "YAW";
    }
    return "UNKNOWN";
}

// ---------------------------------------------------------------------------
// Test cases
// ---------------------------------------------------------------------------

// (a) roll=0.30, pitch=0.08, yaw=0.05 — all valid.
//     dominant = roll (0.30); others = 0.08 + 0.05 = 0.13
//     ratio = 0.30 / (0.13 + 0.001) = ~2.29  >=  1.5  →  roll +1
static void test_a_roll_wins_positive(GestureArbitrator& arb)
{
    AxisCandidate roll  = make(true,  0.30f);
    AxisCandidate pitch = make(true,  0.08f);
    AxisCandidate yaw   = make(true,  0.05f);

    GestureEvent evt = arb.arbitrate(roll, pitch, yaw);

    float ratio = 0.30f / (0.08f + 0.05f + 0.001f);
    printf("[a] ratio=%.3f  valid=%d  axis=%s  dir=%d\n",
           ratio, evt.valid, axis_name(evt.axis), (int)evt.direction);

    assert(evt.valid);
    assert(evt.axis      == GestureAxis::ROLL);
    assert(evt.direction == +1);
    assert(ratio > 2.2f && ratio < 2.4f);   // sanity-check the math

    printf("[a] PASS\n\n");
}

// (b) roll=-0.28, pitch=0.07, yaw=0.04 — all valid.
//     dominant = roll by |integral| = 0.28; direction = -1 (turn_left)
//     ratio = 0.28 / (0.07 + 0.04 + 0.001) = ~2.54  >=  1.5
static void test_b_roll_wins_negative(GestureArbitrator& arb)
{
    AxisCandidate roll  = make(true, -0.28f);
    AxisCandidate pitch = make(true,  0.07f);
    AxisCandidate yaw   = make(true,  0.04f);

    GestureEvent evt = arb.arbitrate(roll, pitch, yaw);

    float ratio = 0.28f / (0.07f + 0.04f + 0.001f);
    printf("[b] ratio=%.3f  valid=%d  axis=%s  dir=%d\n",
           ratio, evt.valid, axis_name(evt.axis), (int)evt.direction);

    assert(evt.valid);
    assert(evt.axis      == GestureAxis::ROLL);
    assert(evt.direction == -1);

    printf("[b] PASS\n\n");
}

// (c) roll=0.20, pitch=0.15, yaw=0.05 — all valid.
//     dominant = roll (0.20); others = 0.15 + 0.05 = 0.20
//     ratio = 0.20 / (0.20 + 0.001) = ~0.997  <  1.5  →  ambiguous, no event
static void test_c_ambiguous(GestureArbitrator& arb)
{
    AxisCandidate roll  = make(true, 0.20f);
    AxisCandidate pitch = make(true, 0.15f);
    AxisCandidate yaw   = make(true, 0.05f);

    GestureEvent evt = arb.arbitrate(roll, pitch, yaw);

    float ratio = 0.20f / (0.15f + 0.05f + 0.001f);
    printf("[c] ratio=%.3f  valid=%d\n", ratio, evt.valid);

    assert(!evt.valid);
    assert(ratio < 1.5f);

    printf("[c] PASS\n\n");
}

// (d) Only pitch valid — pitch wins regardless of ratio (no other valid axes
//     contribute to the denominator, so ratio = |pitch| / epsilon >> 1.5).
static void test_d_single_valid_pitch(GestureArbitrator& arb)
{
    AxisCandidate roll  = make(false, 0.00f);
    AxisCandidate pitch = make(true,  0.12f);
    AxisCandidate yaw   = make(false, 0.00f);

    GestureEvent evt = arb.arbitrate(roll, pitch, yaw);

    // ratio = 0.12 / (0 + 0 + 0.001) = 120  >> 1.5
    float ratio = 0.12f / (0.0f + 0.0f + 0.001f);
    printf("[d] ratio=%.1f  valid=%d  axis=%s  dir=%d\n",
           ratio, evt.valid, axis_name(evt.axis), (int)evt.direction);

    assert(evt.valid);
    assert(evt.axis      == GestureAxis::PITCH);
    assert(evt.direction == +1);

    printf("[d] PASS\n\n");
}

// (e) All invalid — no event.
static void test_e_all_invalid(GestureArbitrator& arb)
{
    AxisCandidate roll  = make(false, 0.30f);
    AxisCandidate pitch = make(false, 0.08f);
    AxisCandidate yaw   = make(false, 0.05f);

    GestureEvent evt = arb.arbitrate(roll, pitch, yaw);

    printf("[e] valid=%d\n", evt.valid);

    assert(!evt.valid);

    printf("[e] PASS\n\n");
}

// (f) roll=0.30 valid, pitch invalid, yaw invalid.
//     Only roll is in play; ratio = 0.30 / (0 + 0 + 0.001) = 300  >> 1.5  →  roll wins.
static void test_f_only_roll_valid(GestureArbitrator& arb)
{
    AxisCandidate roll  = make(true,  0.30f);
    AxisCandidate pitch = make(false, 0.20f);  // large value but flagged invalid
    AxisCandidate yaw   = make(false, 0.10f);

    GestureEvent evt = arb.arbitrate(roll, pitch, yaw);

    float ratio = 0.30f / (0.0f + 0.0f + 0.001f);
    printf("[f] ratio=%.1f  valid=%d  axis=%s  dir=%d\n",
           ratio, evt.valid, axis_name(evt.axis), (int)evt.direction);

    assert(evt.valid);
    assert(evt.axis      == GestureAxis::ROLL);
    assert(evt.direction == +1);

    printf("[f] PASS\n\n");
}

// ---------------------------------------------------------------------------
// Extra edge cases
// ---------------------------------------------------------------------------

// Threshold boundary: ratio exactly at 1.5 should still pass (>=).
static void test_g_ratio_exactly_at_threshold(GestureArbitrator& arb)
{
    // dominant = 1.5 * (other + epsilon)  →  solve for a convenient pair.
    // Let other_sum = 0.10, epsilon = 0.001
    // dominant = 1.5 * 0.101 = 0.1515
    float dominant = 1.5f * (0.10f + GestureArbitrator::DENOMINATOR_EPSILON);

    AxisCandidate roll  = make(true, dominant);
    AxisCandidate pitch = make(true, 0.10f);
    AxisCandidate yaw   = make(false, 0.0f);

    GestureEvent evt = arb.arbitrate(roll, pitch, yaw);

    float ratio = dominant / (0.10f + GestureArbitrator::DENOMINATOR_EPSILON);
    printf("[g] ratio=%.6f  valid=%d\n", ratio, evt.valid);

    // ratio == exactly 1.5 (floating-point permitting) → should be valid.
    assert(fabsf(ratio - 1.5f) < 1e-5f);
    assert(evt.valid);

    printf("[g] PASS\n\n");
}

// Just below threshold should fail.
static void test_h_ratio_just_below_threshold(GestureArbitrator& arb)
{
    // ratio = 1.499...  <  1.5
    float dominant = 1.499f * (0.10f + GestureArbitrator::DENOMINATOR_EPSILON);

    AxisCandidate roll  = make(true, dominant);
    AxisCandidate pitch = make(true, 0.10f);
    AxisCandidate yaw   = make(false, 0.0f);

    GestureEvent evt = arb.arbitrate(roll, pitch, yaw);

    float ratio = dominant / (0.10f + GestureArbitrator::DENOMINATOR_EPSILON);
    printf("[h] ratio=%.6f  valid=%d\n", ratio, evt.valid);

    assert(ratio < 1.5f);
    assert(!evt.valid);

    printf("[h] PASS\n\n");
}

// ---------------------------------------------------------------------------
// main
// ---------------------------------------------------------------------------

int main()
{
    printf("=== GestureArbitrator unit tests ===\n\n");
    printf("DOMINANT_RATIO_THRESHOLD = %.2f\n",
           GestureArbitrator::DOMINANT_RATIO_THRESHOLD);
    printf("DENOMINATOR_EPSILON      = %.4f\n\n",
           GestureArbitrator::DENOMINATOR_EPSILON);

    GestureArbitrator arb;

    test_a_roll_wins_positive(arb);
    test_b_roll_wins_negative(arb);
    test_c_ambiguous(arb);
    test_d_single_valid_pitch(arb);
    test_e_all_invalid(arb);
    test_f_only_roll_valid(arb);
    test_g_ratio_exactly_at_threshold(arb);
    test_h_ratio_just_below_threshold(arb);

    printf("=== All tests passed ===\n");
    return 0;
}
