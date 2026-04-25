/**
 * Unit tests for StillnessDetector implementations.
 * Compile and run without Arduino toolchain:
 *   cd wristturn && make -f Makefile.test
 *
 * Lives in wristturn_audrino/tests/ (not the sketch folder) so Arduino's build
 * system doesn't compile this file's int main() into the firmware.
 */

#include <cstdio>
#include <cmath>
#include <cstdint>
#include "../wristturn/StillnessDetector.h"

// ── Test harness ──────────────────────────────────────────────────────────────

static int _passed = 0;
static int _failed = 0;
static int _test_assertions_failed = 0;

#define TEST_BEGIN(name) { \
    const char* _tname = #name; \
    _test_assertions_failed = 0; \
    fprintf(stdout, "  %-60s", _tname);

#define TEST_END \
    if (_test_assertions_failed == 0) { \
        _passed++; fprintf(stdout, "PASS\n"); \
    } else { \
        _failed++; fprintf(stdout, "FAIL (%d)\n", _test_assertions_failed); \
    } \
}

#define ASSERT(cond, msg) do { \
    if (!(cond)) { \
        fprintf(stdout, "\n    ! [line %d] %s", __LINE__, msg); \
        _test_assertions_failed++; \
    } \
} while(0)

#define SECTION(label) fprintf(stdout, "\n%s\n", label);

// ── ManualZUPTDetector tests ──────────────────────────────────────────────────

#ifdef ENABLE_MANUAL_ZUPT
void test_manual() {
    SECTION("ManualZUPTDetector [constants not calibrated — enable with -DENABLE_MANUAL_ZUPT]");

    // Scenario: user consciously holds arm still after positioning
    TEST_BEGIN(fires_after_stillness_window)
        ManualZUPTDetector d;
        d.onRotationVector(0.0f, 0.0f, 0.0f, 0);
        d.onRotationVector(5.0f, 0.0f, 0.0f, 50);   // moving
        ASSERT(!d.shouldRebase(), "should not rebase while moving");
        d.onRotationVector(5.0f, 0.0f, 0.0f, 100);
        d.onRotationVector(5.1f, 0.0f, 0.0f, 200);  // <0.2deg — within threshold
        ASSERT(!d.shouldRebase(), "should not rebase before window elapses");
        d.onRotationVector(5.0f, 0.0f, 0.0f, 410);  // 310ms still
        ASSERT(d.shouldRebase(), "should rebase after stillness window");
    TEST_END

    // shouldRebase() is one-shot — consumed on first read
    TEST_BEGIN(shouldRebase_consumed_after_read)
        ManualZUPTDetector d;
        d.onRotationVector(0.0f, 0.0f, 0.0f, 0);
        d.onRotationVector(0.0f, 0.0f, 0.0f, 400);
        ASSERT(d.shouldRebase(),  "first call should return true");
        ASSERT(!d.shouldRebase(), "second call should be consumed");
    TEST_END

    // Fast arm snap-back: large deltas keep resetting timer, no premature rebase
    TEST_BEGIN(snap_reset_no_premature_rebase)
        ManualZUPTDetector d;
        d.onRotationVector(30.0f, 0.0f, 0.0f,   0);
        d.onRotationVector(30.0f, 0.0f, 0.0f,  50);
        // snap back
        d.onRotationVector(20.0f, 0.0f, 0.0f, 100);
        d.onRotationVector( 8.0f, 0.0f, 0.0f, 120);
        d.onRotationVector(-2.0f, 0.0f, 0.0f, 140);
        ASSERT(!d.shouldRebase(), "no rebase mid-snap");
        // arm settles
        d.onRotationVector(0.0f, 0.0f, 0.0f, 160);
        d.onRotationVector(0.3f, 0.0f, 0.0f, 250);
        ASSERT(!d.shouldRebase(), "stillness window not yet elapsed after settling");
        d.onRotationVector(0.1f, 0.0f, 0.0f, 470);  // 310ms since last big move
        ASSERT(d.shouldRebase(), "rebase after arm settles post-snap");
    TEST_END

    // Minor tremor (<STILL_DEG) counts as still — real wrists always have micro-movement
    TEST_BEGIN(tremor_below_threshold_counts_as_still)
        ManualZUPTDetector d;
        unsigned long t = 0;
        d.onRotationVector(10.0f, 0.0f, 0.0f, t);
        for (int i = 0; i < 20; i++) {
            float r = 10.0f + (i % 3) * 0.5f;  // ±1deg oscillation
            d.onRotationVector(r, 0.0f, 0.0f, t += 20);
        }
        ASSERT(d.shouldRebase(), "sub-threshold tremor should not block rebase");
    TEST_END

    // Any axis moving resets the timer — not just roll
    TEST_BEGIN(pitch_movement_resets_timer)
        ManualZUPTDetector d;
        d.onRotationVector(0.0f, 0.0f, 0.0f,   0);
        d.onRotationVector(0.0f, 0.0f, 0.0f, 200);  // 200ms still
        d.onRotationVector(0.0f, 8.0f, 0.0f, 250);  // pitch jump resets timer
        d.onRotationVector(0.0f, 8.0f, 0.0f, 400);  // only 150ms since pitch moved
        ASSERT(!d.shouldRebase(), "pitch movement should reset timer");
        d.onRotationVector(0.0f, 8.0f, 0.0f, 560);  // 310ms since pitch settled
        ASSERT(d.shouldRebase(), "rebase after all axes stable");
    TEST_END

    // reset() clears pending — e.g. mode change or disconnect
    TEST_BEGIN(reset_clears_pending)
        ManualZUPTDetector d;
        d.onRotationVector(0.0f, 0.0f, 0.0f,   0);
        d.onRotationVector(0.0f, 0.0f, 0.0f, 400);  // would rebase
        d.reset();
        ASSERT(!d.shouldRebase(), "reset should clear pending rebase");
    TEST_END

    // Continuous rotation: never rebases
    TEST_BEGIN(continuous_motion_never_rebases)
        ManualZUPTDetector d;
        for (int i = 0; i < 50; i++)
            d.onRotationVector((float)(i * 5), 0.0f, 0.0f, (unsigned long)(i * 20));
        ASSERT(!d.shouldRebase(), "continuous rotation should never rebase");
    TEST_END

    // Ignores stability class events entirely
    TEST_BEGIN(ignores_stability_events)
        ManualZUPTDetector d;
        d.onStabilityClass(STABILITY_STABLE, 2000);
        ASSERT(!d.shouldRebase(), "ManualZUPT ignores stability events");
    TEST_END
}
#endif  // ENABLE_MANUAL_ZUPT

// ── StabilityClassifierDetector tests ────────────────────────────────────────

void test_stability() {
    SECTION("StabilityClassifierDetector");

    // Arm held still, holdoff passed → rebase
    TEST_BEGIN(fires_when_stable_and_holdoff_passed)
        StabilityClassifierDetector d;
        d.markMotion(0);
        d.onStabilityClass(STABILITY_STABLE, 2000);
        ASSERT(d.shouldRebase(), "should rebase when stable and holdoff passed");
    TEST_END

    // Gesture just fired → stable event arrives but holdoff not passed
    // Real life: user taps to engage knob, chip immediately reports stable
    TEST_BEGIN(no_rebase_if_gesture_just_fired)
        StabilityClassifierDetector d;
        d.markMotion(1800);
        d.onStabilityClass(STABILITY_STABLE, 2000);  // only 200ms after gesture
        ASSERT(!d.shouldRebase(), "holdoff not passed after recent gesture");
    TEST_END

    // UNKNOWN stability class should never trigger rebase
    TEST_BEGIN(unknown_class_does_not_rebase)
        StabilityClassifierDetector d;
        d.markMotion(0);
        d.onStabilityClass(STABILITY_UNKNOWN, 2000);
        ASSERT(!d.shouldRebase(), "UNKNOWN class should not rebase");
    TEST_END

    // ON_TABLE and STATIONARY also count as stable
    TEST_BEGIN(on_table_and_stationary_trigger_rebase)
        {
            StabilityClassifierDetector d;
            d.markMotion(0);
            d.onStabilityClass(STABILITY_ON_TABLE, 2000);
            ASSERT(d.shouldRebase(), "ON_TABLE should trigger rebase");
        }
        {
            StabilityClassifierDetector d;
            d.markMotion(0);
            d.onStabilityClass(STABILITY_STATIONARY, 2000);
            ASSERT(d.shouldRebase(), "STATIONARY should trigger rebase");
        }
    TEST_END

    // Motion after stable event cancels pending rebase
    // Real life: arm settles, chip reports stable, user moves again immediately
    TEST_BEGIN(motion_after_stable_cancels_pending)
        StabilityClassifierDetector d;
        d.markMotion(0);
        d.onStabilityClass(STABILITY_STABLE, 2000);  // pending set
        d.markMotion(2100);                           // user moves arm
        ASSERT(!d.shouldRebase(), "motion after stable should cancel pending rebase");
    TEST_END

    // shouldRebase() consumed on first call
    TEST_BEGIN(shouldRebase_consumed_after_read)
        StabilityClassifierDetector d;
        d.markMotion(0);
        d.onStabilityClass(STABILITY_STABLE, 2000);
        ASSERT(d.shouldRebase(),  "first call true");
        ASSERT(!d.shouldRebase(), "second call consumed");
    TEST_END

    // reset() clears state — on disconnect or mode change
    TEST_BEGIN(reset_clears_state)
        StabilityClassifierDetector d;
        d.markMotion(0);
        d.onStabilityClass(STABILITY_STABLE, 2000);
        d.reset();
        ASSERT(!d.shouldRebase(), "reset should clear pending rebase");
    TEST_END

    // Moving stability class resets holdoff
    TEST_BEGIN(moving_class_updates_lastMotionMs)
        StabilityClassifierDetector d;
        d.markMotion(0);
        d.onStabilityClass(STABILITY_UNKNOWN, 1000);  // not still → updates lastMotionMs
        d.onStabilityClass(STABILITY_STABLE,  1200);  // only 200ms after UNKNOWN
        ASSERT(!d.shouldRebase(), "holdoff should be measured from last non-still event");
    TEST_END

    // Ignores rotation vector calls entirely
    TEST_BEGIN(ignores_rotation_vector_calls)
        StabilityClassifierDetector d;
        d.markMotion(0);
        d.onRotationVector(0.0f, 0.0f, 0.0f,   0);
        d.onRotationVector(5.0f, 0.0f, 0.0f, 100);
        d.onStabilityClass(STABILITY_STABLE, 2000);
        ASSERT(d.shouldRebase(), "StabilityClassifier ignores rotation vectors");
    TEST_END
}

// ── Main ──────────────────────────────────────────────────────────────────────

int main() {
    fprintf(stdout, "\n=== StillnessDetector Unit Tests ===\n");
#ifdef ENABLE_MANUAL_ZUPT
    test_manual();
#endif
    test_stability();
    fprintf(stdout, "\n─────────────────────────────────────────────────────────────────────\n");
    fprintf(stdout, "  %d passed  |  %d failed  |  %d total\n",
            _passed, _failed, _passed + _failed);
    fprintf(stdout, "─────────────────────────────────────────────────────────────────────\n\n");
    return _failed > 0 ? 1 : 0;
}
