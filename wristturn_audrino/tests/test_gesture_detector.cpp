/**
 * Unit tests for GestureDetector — specifically the cross-axis refractory
 * behavior. Compile and run without Arduino toolchain:
 *   cd wristturn && make -f Makefile.test test_gesture
 *
 * Lives in wristturn_audrino/tests/ (not the sketch folder) so Arduino's
 * build system doesn't compile this file's int main() into the firmware.
 *
 * Bug this reproduces: roll, pitch, and yaw each run a fully independent
 * AxisDetector FSM. A real wrist "turn" (roll) commonly drags in incidental
 * pitch/yaw motion — biomechanically coupled, not intentional. Before the
 * cross-axis refractory fix, that incidental motion can independently
 * complete its own ONSET→PEAK→DECAY cycle a few hundred ms after the
 * intended roll gesture fires, and pass its OWN ratio test on its own,
 * producing a spurious second gesture (e.g. turn_right immediately followed
 * by pitch_up) for what was one physical motion.
 */

#include <cstdio>
#include <cmath>
#include <cstdint>
#include <string>
#include "../wristturn/gesture/GestureDetector.h"

// ── Test harness (matches test_stillness.cpp conventions) ──────────────────

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

// ── Helpers ──────────────────────────────────────────────────────────────

static constexpr float DT_50HZ = 1.0f / 50.0f;   // 20ms
static constexpr uint32_t MS_50HZ = 20;

// Drives one axis through a clean ONSET->PEAK->DECAY->fire cycle while the
// other two stay at zero. Returns the gesture name from the sample that
// fires (or nullptr if it never fires within maxSamples — a test bug, not
// expected in these scenarios).
const char* driveCleanFlick(GestureDetector& gd, int axis /* 0=roll,1=pitch,2=yaw */) {
    // Burst high enough to clear JERK_ONSET_THRESHOLD (3.0 rad/s^2) as jerk,
    // INTEGRAL_THRESHOLD (0.15 rad) to enter PEAK, AND the arbitrator's
    // minIntegralRollYaw/minIntegralPitch floor (default 0.30 rad) — two
    // samples at 10.0 rad/s * 0.02s = 0.4 rad, comfortably above all three.
    const float burst = 10.0f;
    for (int i = 0; i < 10; ++i) {
        float g0 = 0.0f, g1 = 0.0f, g2 = 0.0f;
        float val = (i < 2) ? burst : 0.0f;  // 2 samples of burst, then release
        if (axis == 0) g0 = val; else if (axis == 1) g1 = val; else g2 = val;
        const char* g = gd.updateWithDt(g0, g1, g2, DT_50HZ, MS_50HZ);
        if (g) return g;
    }
    return nullptr;
}

// Advances time with all-zero gyro (stillness) for the given duration, in
// case a test needs a gap longer than the refractory window.
void driveStillness(GestureDetector& gd, uint32_t durationMs) {
    uint32_t elapsed = 0;
    while (elapsed < durationMs) {
        gd.updateWithDt(0.0f, 0.0f, 0.0f, DT_50HZ, MS_50HZ);
        elapsed += MS_50HZ;
    }
}

// ── Tests ────────────────────────────────────────────────────────────────

void test_single_axis() {
    SECTION("Single clean axis motion");

    TEST_BEGIN(roll_flick_fires_turn_right)
        GestureDetector gd;
        const char* g = driveCleanFlick(gd, 0);
        ASSERT(g != nullptr, "expected a gesture to fire");
        ASSERT(g != nullptr && std::string(g) == "turn_right", "expected turn_right");
    TEST_END

    TEST_BEGIN(pitch_flick_fires_pitch_up)
        GestureDetector gd;
        const char* g = driveCleanFlick(gd, 1);
        ASSERT(g != nullptr, "expected a gesture to fire");
        ASSERT(g != nullptr && std::string(g) == "pitch_up", "expected pitch_up");
    TEST_END
}

void test_cross_axis_refractory() {
    SECTION("Cross-axis refractory — the bug this test file exists for");

    TEST_BEGIN(coupled_pitch_bleed_within_refractory_is_suppressed)
        GestureDetector gd;
        const char* first = driveCleanFlick(gd, 0);  // roll fires turn_right
        ASSERT(first != nullptr && std::string(first) == "turn_right",
               "setup: roll should fire turn_right first");

        // Simulate incidental coupled pitch motion arriving ~80ms after the
        // roll fire — well within a single continuous physical "turn". Before
        // the fix, pitch's independent FSM completes its own cycle here and
        // fires pitch_up on its own. After the fix, this must be suppressed.
        const char* second = driveCleanFlick(gd, 1);
        ASSERT(second == nullptr,
               "coupled pitch bleed immediately after a roll fire must NOT "
               "produce a second gesture — this is the cross-axis bleed bug");
    TEST_END

    TEST_BEGIN(genuinely_separate_motions_both_fire)
        GestureDetector gd;
        const char* first = driveCleanFlick(gd, 0);  // roll fires turn_right
        ASSERT(first != nullptr && std::string(first) == "turn_right",
               "setup: roll should fire turn_right first");

        // A real gap between two deliberate gestures (well past any sane
        // refractory window) — both must still fire. Proves the fix doesn't
        // over-suppress legitimate sequential gestures.
        driveStillness(gd, 500);
        const char* second = driveCleanFlick(gd, 1);
        ASSERT(second != nullptr && std::string(second) == "pitch_up",
               "a genuinely separate deliberate pitch gesture after a real "
               "gap must still fire");
    TEST_END
}

int main() {
    fprintf(stdout, "GestureDetector tests\n");
    test_single_axis();
    test_cross_axis_refractory();

    fprintf(stdout, "\n%d passed, %d failed\n", _passed, _failed);
    return _failed == 0 ? 0 : 1;
}
