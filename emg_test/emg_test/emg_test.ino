/**
 * EMG Test — BioAmp MuscleAmp Candy + XIAO nRF52840
 *
 * Wiring:
 *   MuscleAmp OUT  -> D0  (P0.02 / A0)
 *   MuscleAmp VCC  -> 3.3V
 *   MuscleAmp GND  -> GND
 *
 * Open Serial Plotter at 115200 to visualise raw, baseline, and envelope.
 * Open Serial Monitor to see activation events and threshold tuning hints.
 *
 * Board: Seeed XIAO nRF52840 (Sense or non-Sense, doesn't matter)
 * FQBN:  Seeeduino:nrf52:xiaonRF52840Sense
 */

// bluefruit.h is required on Seeeduino nRF52840 to link the USB CDC Serial object.
// We don't use BLE here — this include is purely to pull in the USB stack.
#include <bluefruit.h>
#include "emg_baseline.h"
#include "emg_detector.h"

// ── Pin ──────────────────────────────────────────────────────────────────────
static constexpr uint8_t EMG_PIN = A0; // D0 = P0.02

// ── Timing ───────────────────────────────────────────────────────────────────
// Sample at 1 kHz for accurate baseline/detection; print at 50 Hz so the
// serial monitor and web visualizer can keep up (1 kHz = ~115 KB/s, too fast).
static constexpr uint32_t SAMPLE_INTERVAL_US = 1000;   // 1 kHz
static constexpr uint32_t PRINT_INTERVAL_MS  = 20;     // 50 Hz

// ── Globals ──────────────────────────────────────────────────────────────────
static EmgBaseline  baseline;
static EmgDetector  detector;
static uint32_t     lastSampleUs = 0;
static uint32_t     lastPrintMs  = 0;

// Last computed values — written by sample tick, read by print tick.
static uint16_t gRaw = 0, gBase = 0, gEnv = 0, gThr = 0;
static bool     gActive = false;

void setup() {
    Serial.begin(115200);
    while (!Serial && millis() < 3000) {}

    analogReadResolution(12);
    baseline.reset();
    detector.reset();

    Serial.println("# EMG ready — relax muscle 2s for baseline to settle");
    Serial.println("# cols: raw baseline envelope threshold activated");
}

void loop() {
    // ── Sample tick (1 kHz) ──────────────────────────────────────────────────
    uint32_t nowUs = micros();
    if ((nowUs - lastSampleUs) >= SAMPLE_INTERVAL_US) {
        lastSampleUs = nowUs;

        uint16_t raw = (uint16_t)analogRead(EMG_PIN);
        baseline.update(raw);

        uint16_t base = baseline.get();
        // Absolute deviation — EMG oscillates both above and below baseline.
        uint16_t env  = (raw >= base) ? (uint16_t)(raw - base) : (uint16_t)(base - raw);
        bool active   = detector.update(env);

        gRaw    = raw;
        gBase   = base;
        gEnv    = env;
        gThr    = detector.threshold();
        gActive = active;
    }

    // ── Print tick (50 Hz) ───────────────────────────────────────────────────
    uint32_t nowMs = millis();
    if ((nowMs - lastPrintMs) >= PRINT_INTERVAL_MS) {
        lastPrintMs = nowMs;

        Serial.print(gRaw);    Serial.print(' ');
        Serial.print(gBase);   Serial.print(' ');
        Serial.print(gEnv);    Serial.print(' ');
        Serial.print(gThr);    Serial.print(' ');
        Serial.println(gActive ? 400 : 0);
    }

    // ── Activation events (immediate, on state change) ───────────────────────
    static bool prevActive = false;
    if (gActive && !prevActive) {
        Serial.print("# ACTIVATE  env="); Serial.print(gEnv);
        Serial.print("  thr=");           Serial.println(gThr);
    } else if (!gActive && prevActive) {
        Serial.println("# RELEASE");
    }
    prevActive = gActive;
}
