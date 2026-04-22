/**
 * test_axis_detector.cpp — Phase 1 + Phase 3 unit tests for AxisDetector.
 *
 * Compile and run:
 *   g++ -std=c++17 -Wall -Wextra -I../wristturn_audrino/wristturn \
 *       test_axis_detector.cpp -o test_axis_detector && ./test_axis_detector
 */

#include <cassert>
#include <cstdio>
#include <cstdlib>
#include <cmath>
#include <cstring>
#include <cerrno>
#include <cstdint>

#include "../wristturn_audrino/wristturn/gesture/AxisDetector.h"

// ── Helpers ───────────────────────────────────────────────────────────────────

static int g_passed = 0;
static int g_failed = 0;

#define EXPECT_TRUE(expr) do { \
    if (!(expr)) { printf("  FAIL  %s:%d  expected true: %s\n", __FILE__, __LINE__, #expr); ++g_failed; } \
    else { ++g_passed; } \
} while (0)

#define EXPECT_FALSE(expr)  EXPECT_TRUE(!(expr))
#define EXPECT_GT(a, b) do { \
    if (!((a) > (b))) { \
        printf("  FAIL  %s:%d  expected %s > %s  (%.6f vs %.6f)\n", \
               __FILE__, __LINE__, #a, #b, (double)(a), (double)(b)); ++g_failed; \
    } else { ++g_passed; } \
} while (0)
#define EXPECT_EQ_STATE(det, s) EXPECT_TRUE((det).state() == AxisDetector::AxisState::s)

#define TEST(name) \
    static void name(); \
    struct _Reg_##name { _Reg_##name() { printf("\n[TEST] %s\n", #name); name(); } }; \
    static const _Reg_##name _reg_##name {}; \
    static void name()

static constexpr float    DT   = 1.0f / 50.0f;   // 20ms at 50Hz
static constexpr uint32_t MS20 = 20;              // elapsedMs for 50Hz

// Convenience wrapper: update with standard 50Hz timing
static AxisCandidate upd(AxisDetector& d, float g) {
    return d.update(g, DT, MS20);
}


// ── Test A: Clean fast roll (IDLE→ONSET→PEAK→DECAY→IDLE) ─────────────────────
TEST(test_A_clean_fast_roll) {
    AxisDetector det;
    AxisCandidate result = {false, 0.0f, 0.0f};

    // jerk on spike = (3.0 - 0.0) / 0.02 = 150 rad/s² >> 8.0
    const float seq[] = { 0.0f, 0.0f, 3.0f, 3.0f, 2.5f, 2.0f,
                          1.5f, 1.0f, 0.5f, 0.1f, 0.0f };
    for (float g : seq) {
        auto c = upd(det, g);
        if (c.valid) result = c;
    }

    EXPECT_TRUE(result.valid);
    EXPECT_GT(result.integral, 0.0f);
    EXPECT_GT(result.peakRate, 0.0f);
    EXPECT_GT(fabsf(result.integral), INTEGRAL_THRESHOLD - 1e-6f);
    printf("  integral=%.4f rad  peakRate=%.3f rad/s\n",
           (double)result.integral, (double)result.peakRate);
}

// ── Test B: Slow drift — jerk below onset threshold, no candidate ─────────────
TEST(test_B_slow_drift_no_candidate) {
    AxisDetector det;
    bool any = false;
    // jerk per step = (1.5/30) / 0.02 = 2.5 rad/s² < 8.0
    for (int i = 0; i <= 30; ++i) {
        auto c = upd(det, 1.5f * (float)i / 30.0f);
        if (c.valid) any = true;
    }
    EXPECT_FALSE(any);
    printf("  no candidate for slow ramp (jerk=2.50 rad/s² < %.2f)\n",
           (double)JERK_ONSET_THRESHOLD);
}

// ── Test C: ZUPT triggers after ZUPT_MIN_SAMPLES consecutive quiet samples ────
TEST(test_C_zupt_triggers) {
    AxisDetector det;
    const float NZ = ZUPT_GYRO_THRESHOLD * 0.5f;
    upd(det, NZ);
    EXPECT_FALSE(det.isQuiet());
    for (int i = 1; i < ZUPT_MIN_SAMPLES; ++i) upd(det, NZ);
    EXPECT_TRUE(det.isQuiet());
    printf("  isQuiet() == true after %d samples\n", ZUPT_MIN_SAMPLES);
    upd(det, 1.0f);
    EXPECT_FALSE(det.isQuiet());
    printf("  isQuiet() == false after above-threshold sample\n");
}

// ── Test D: Noise below onset threshold ───────────────────────────────────────
TEST(test_D_noise_no_candidate) {
    AxisDetector det;
    bool any = false;
    // A=0.05 → max jerk = 2*0.05/0.02 = 5.0 rad/s² < 8.0
    const float A = 0.05f;
    for (int i = 0; i < 40; ++i) {
        auto c = upd(det, (i % 2 == 0) ? A : -A);
        if (c.valid) any = true;
    }
    EXPECT_FALSE(any);
    printf("  no candidate for alternating noise  A=%.3f rad/s  max_jerk=%.2f rad/s²\n",
           (double)A, (double)(2.0f * A / DT));
}

// ── Test E: Negative fast roll (turn_left) ────────────────────────────────────
TEST(test_E_negative_fast_roll) {
    AxisDetector det;
    AxisCandidate result = {false, 0.0f, 0.0f};
    const float seq[] = { 0.0f, 0.0f, -3.0f, -3.0f, -2.5f, -2.0f,
                          -1.5f, -1.0f, -0.5f, -0.1f, 0.0f };
    for (float g : seq) {
        auto c = upd(det, g);
        if (c.valid) result = c;
    }
    EXPECT_TRUE(result.valid);
    EXPECT_TRUE(result.integral < 0.0f);
    printf("  integral=%.4f rad  (negative = turn_left)\n", (double)result.integral);
}

// Helper: bring detector from IDLE to PEAK using a fast roll
// Feeds 2 zero samples (setup), then enough 3.0 rad/s samples to cross threshold.
// At 3.0 rad/s × 0.02s = 0.06 rad/sample, 5 samples → 0.30 rad > 0.25 threshold.
// First sample at 3.0 triggers ONSET (jerk from 0→3 = 150 rad/s²).
// Next 4 samples in ONSET accumulate until |windowSum| > 0.25 → PEAK.
static void bring_to_peak(AxisDetector& det) {
    upd(det, 0.0f); upd(det, 0.0f);   // quiet setup
    upd(det, 3.0f);                    // IDLE → ONSET (jerk onset)
    upd(det, 3.0f); upd(det, 3.0f);   // accumulate
    upd(det, 3.0f); upd(det, 3.0f);   // 5th sample: integral=0.30 → ONSET → PEAK
}

// ── Test F: Held position — PEAK timeout, no candidate ───────────────────────
TEST(test_F_held_position_no_candidate) {
    AxisDetector det;
    AxisCandidate result = {false, 0.0f, 0.0f};

    bring_to_peak(det);
    EXPECT_EQ_STATE(det, PEAK);

    // Hold above DECAY_THRESHOLD (0.15) for PEAK_TIMEOUT_MS (200ms) + margin.
    // At 20ms/sample: 200/20 + 5 = 15 samples.
    int held = (int)(PEAK_TIMEOUT_MS / MS20) + 5;
    for (int i = 0; i < held; ++i) {
        auto c = upd(det, 0.5f);  // 0.5 > 0.15 = no DECAY transition
        if (c.valid) result = c;
    }

    EXPECT_FALSE(result.valid);
    EXPECT_EQ_STATE(det, IDLE);
    printf("  held for %d samples → PEAK timeout → no fire, back to IDLE\n", held);
}

// ── Test G: Onset timeout — weak burst, no candidate ─────────────────────────
// Jerk spike triggers ONSET, but integral stays below threshold until
// ONSET_TIMEOUT_MS (300ms) elapses → reset to IDLE, no fire.
TEST(test_G_onset_timeout_no_candidate) {
    AxisDetector det;
    AxisCandidate result = {false, 0.0f, 0.0f};

    upd(det, 0.0f); upd(det, 0.0f);
    // jerk = (0.4 - 0.0) / 0.02 = 20 rad/s² > 8 → ONSET
    // but 0.4 rad/s × 0.02s = 0.008 rad/sample; even 32 samples = 0.256 rad,
    // which would cross threshold. Use 0.2 rad/s instead:
    // max integral = 0.2 × 32 × 0.02 = 0.128 rad < 0.25 → never crosses.
    upd(det, 0.2f);  // jerk = (0.2-0)/0.02 = 10 > 8 → ONSET
    EXPECT_EQ_STATE(det, ONSET);

    // Feed sub-threshold gyro for ONSET_TIMEOUT_MS + margin
    int n = (int)(ONSET_TIMEOUT_MS / MS20) + 5;
    for (int i = 0; i < n; ++i) {
        auto c = upd(det, 0.2f);  // integral never reaches 0.25
        if (c.valid) result = c;
    }

    EXPECT_FALSE(result.valid);
    EXPECT_EQ_STATE(det, IDLE);
    printf("  weak burst (%d samples) → ONSET timeout → no fire\n", n);
}

// ── Test H: Full FSM cycle with explicit state checks at each step ────────────
TEST(test_H_full_fsm_cycle) {
    AxisDetector det;
    EXPECT_EQ_STATE(det, IDLE);

    upd(det, 0.0f); upd(det, 0.0f);
    upd(det, 3.0f);                   // jerk onset → ONSET
    EXPECT_EQ_STATE(det, ONSET);

    // Feed 4 more samples to cross threshold (5 total at 3.0 → 0.30 rad)
    upd(det, 3.0f); upd(det, 3.0f); upd(det, 3.0f);
    upd(det, 3.0f);                   // → PEAK
    EXPECT_EQ_STATE(det, PEAK);

    upd(det, 0.10f);                  // 0.10 < DECAY_THRESHOLD(0.15) → DECAY
    EXPECT_EQ_STATE(det, DECAY);

    auto c = upd(det, 0.01f);        // 0.01 < ZUPT_GYRO_THRESHOLD(0.03) → IDLE + fires
    EXPECT_TRUE(c.valid);
    EXPECT_GT(c.integral, 0.0f);
    EXPECT_EQ_STATE(det, IDLE);
    printf("  IDLE→ONSET→PEAK→DECAY→IDLE confirmed, integral=%.4f\n",
           (double)c.integral);
}

// ── Test I: Combo — two back-to-back fast rolls ───────────────────────────────
// After the first gesture fires (DECAY→IDLE), the axis is immediately ready.
// The second gesture should also complete and fire.
TEST(test_I_combo_two_gestures) {
    AxisDetector det;

    // First gesture: full cycle
    bring_to_peak(det);
    EXPECT_EQ_STATE(det, PEAK);
    upd(det, 0.10f);                  // → DECAY
    EXPECT_EQ_STATE(det, DECAY);
    auto c1 = upd(det, 0.01f);       // → IDLE + fires
    EXPECT_TRUE(c1.valid);
    EXPECT_EQ_STATE(det, IDLE);

    // Brief gap: 5 quiet samples (~100ms)
    for (int i = 0; i < 5; ++i) upd(det, 0.005f);

    // Second gesture: ring buffer still has old 3.0 values → integral crosses
    // threshold sooner, but the gesture still fires correctly.
    upd(det, 3.0f);   // jerk from ~0.005 → 3.0 = huge → ONSET
    EXPECT_EQ_STATE(det, ONSET);
    // One more sample: windowSum already elevated from old data → fast PEAK
    upd(det, 3.0f); upd(det, 3.0f); upd(det, 3.0f); upd(det, 3.0f);
    // Now definitely in PEAK (old + new data well above threshold)
    EXPECT_EQ_STATE(det, PEAK);
    upd(det, 0.10f);                  // → DECAY
    auto c2 = upd(det, 0.01f);       // → IDLE + fires

    EXPECT_TRUE(c2.valid);
    EXPECT_EQ_STATE(det, IDLE);
    printf("  combo: c1.valid=%d c2.valid=%d — both gestures fired\n",
           (int)c1.valid, (int)c2.valid);
}

// ── JSONL smoke test ──────────────────────────────────────────────────────────

static const char* SESSION_FILE =
    "/Users/darksied/Downloads/session-2026-04-22T08-43-38-103Z.jsonl";

static bool extract_float(const char* line, const char* key, float* out) {
    char search[64];
    snprintf(search, sizeof(search), "\"%s\":", key);
    const char* p = strstr(line, search);
    if (!p) return false;
    p += strlen(search);
    while (*p == ' ') ++p;
    char* end = nullptr;
    errno = 0;
    float val = strtof(p, &end);
    if (end == p || errno != 0) return false;
    *out = val;
    return true;
}

static bool extract_string(const char* line, const char* key, char* out, int maxlen) {
    char search[64];
    snprintf(search, sizeof(search), "\"%s\":\"", key);
    const char* p = strstr(line, search);
    if (!p) return false;
    p += strlen(search);
    int i = 0;
    while (*p && *p != '"' && i < maxlen - 1) out[i++] = *p++;
    out[i] = '\0';
    return i > 0;
}

static void run_jsonl_smoke_test() {
    printf("\n[SMOKE TEST] JSONL replay: %s\n", SESSION_FILE);
    FILE* f = fopen(SESSION_FILE, "r");
    if (!f) { printf("  SKIP — file not found\n"); return; }

    AxisDetector rollDet, pitchDet, yawDet;
    int lines = 0, gesture_events = 0;
    int cr_count = 0, cp_count = 0, cy_count = 0;
    float prev_t = -1.0f;
    char line[512];

    while (fgets(line, (int)sizeof(line), f)) {
        ++lines;
        float t = 0.0f;
        if (!extract_float(line, "t", &t)) continue;

        float roll = 0.0f, pitch = 0.0f, yaw = 0.0f;
        extract_float(line, "roll",  &roll);
        extract_float(line, "pitch", &pitch);
        extract_float(line, "yaw",   &yaw);

        char gesture[32] = {};
        if (extract_string(line, "gesture", gesture, sizeof(gesture))) ++gesture_events;

        float dt = DT;
        if (prev_t >= 0.0f && t > prev_t) {
            float d = (t - prev_t) * 0.001f;
            if (d > 0.001f && d < 1.0f) dt = d;
        }
        prev_t = t;
        uint32_t ms = (uint32_t)(dt * 1000.0f);

        auto cr = rollDet.update(roll  * 0.1f, dt, ms);
        auto cp = pitchDet.update(pitch * 0.1f, dt, ms);
        auto cy = yawDet.update(yaw   * 0.1f, dt, ms);

        if (cr.valid) { ++cr_count; printf("  roll  candidate integral=%.4f peak=%.3f\n", (double)cr.integral, (double)cr.peakRate); }
        if (cp.valid) { ++cp_count; printf("  pitch candidate integral=%.4f peak=%.3f\n", (double)cp.integral, (double)cp.peakRate); }
        if (cy.valid) { ++cy_count; printf("  yaw   candidate integral=%.4f peak=%.3f\n", (double)cy.integral, (double)cy.peakRate); }
    }
    fclose(f);

    int total = cr_count + cp_count + cy_count;
    printf("  lines=%d  gesture_events=%d  candidates: roll=%d pitch=%d yaw=%d  total=%d\n",
           lines, gesture_events, cr_count, cp_count, cy_count, total);
    if (gesture_events > 0) {
        EXPECT_TRUE(total > 0);
        EXPECT_TRUE(total <= gesture_events * 15 + 20);
    } else {
        printf("  NOTE: no gesture events in file\n");
    }
}

// ── main ──────────────────────────────────────────────────────────────────────

int main() {
    printf("=== AxisDetector unit tests ===\n");
    run_jsonl_smoke_test();
    printf("\n=== Results: %d passed  %d failed ===\n", g_passed, g_failed);
    return g_failed == 0 ? 0 : 1;
}
