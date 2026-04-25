/**
 * Tests for MotionClassifier.
 * Run without device or React Native:
 *   bun src/gestures/__tests__/MotionClassifier.test.ts
 */

import assert from "node:assert/strict";
import { MotionClassifier } from "../MotionClassifier";
import type { MotionClassifierCallbacks, MotionType } from "../MotionClassifier";

// ── Test harness ──────────────────────────────────────────────────────────────

let passed = 0;
let failed = 0;

function test(name: string, fn: () => void): void {
  try {
    fn();
    console.log(`  PASS  ${name}`);
    passed++;
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    console.log(`  FAIL  ${name}`);
    console.log(`        ${msg}`);
    failed++;
  }
}

function section(label: string): void {
  console.log(`\n${label}`);
}

// ── Stability class constants (mirrors firmware StillnessDetector.h) ──────────
const STAB_UNKNOWN    = 0;
const STAB_ON_TABLE   = 1;
const STAB_STATIONARY = 2;
const STAB_STABLE     = 3;
const STAB_MOTION     = 4;

const DWELL_MS          = 1000;
const DWELL_NO_MOTION   = 2000;

// ── Helper: produce a MotionClassifier that has completed the full ceremony ───
// Simulates: connect → motion (arm raised) → settle → dwell elapsed.

function calibrated(cbs?: MotionClassifierCallbacks): MotionClassifier {
  const mc = new MotionClassifier(cbs);
  mc.startCalibration();
  mc.onStabilityClass(STAB_MOTION,     0);        // arm raised
  mc.onStabilityClass(STAB_STABLE,   100);        // arm settling
  mc.onStabilityClass(STAB_STABLE, 100 + DWELL_MS); // dwell elapsed → stable
  return mc;
}

// ── Tests ─────────────────────────────────────────────────────────────────────

section("Initial state");

test("starts UNCALIBRATED", () => {
  const mc = new MotionClassifier();
  assert.equal(mc.getState(), "uncalibrated");
});

test("getMotionType is null when uncalibrated", () => {
  const mc = new MotionClassifier();
  assert.equal(mc.getMotionType(), null);
});

section("Calibration ceremony — happy path (user raises arm)");

test("startCalibration → CALIBRATING", () => {
  const mc = new MotionClassifier();
  mc.startCalibration();
  assert.equal(mc.getState(), "calibrating");
});

test("motion → settle → dwell elapsed → STABLE", () => {
  const mc = new MotionClassifier();
  mc.startCalibration();
  mc.onStabilityClass(STAB_MOTION,        0);
  assert.equal(mc.getState(), "calibrating", "still calibrating during motion");
  mc.onStabilityClass(STAB_STABLE,      100);
  assert.equal(mc.getState(), "calibrating", "still calibrating — dwell not elapsed yet");
  mc.onStabilityClass(STAB_STABLE, 100 + DWELL_MS);
  assert.equal(mc.getState(), "stable");
});

test("STATIONARY (not just STABLE) also satisfies dwell", () => {
  const mc = new MotionClassifier();
  mc.startCalibration();
  mc.onStabilityClass(STAB_MOTION,        0);
  mc.onStabilityClass(STAB_STATIONARY,  100);
  mc.onStabilityClass(STAB_STATIONARY, 100 + DWELL_MS);
  assert.equal(mc.getState(), "stable");
});

test("dwell resets if arm moves again during collection", () => {
  const mc = new MotionClassifier();
  mc.startCalibration();
  mc.onStabilityClass(STAB_MOTION,   0);    // initial raise
  mc.onStabilityClass(STAB_STABLE, 100);    // start collecting at t=100
  mc.onStabilityClass(STAB_MOTION, 500);    // arm moved again — reset
  // now settle again and hold for a full dwell from t=600
  mc.onStabilityClass(STAB_STABLE,  600);
  mc.onStabilityClass(STAB_STABLE,  600 + DWELL_MS - 1);
  assert.equal(mc.getState(), "calibrating", "dwell not elapsed yet after reset");
  mc.onStabilityClass(STAB_STABLE,  600 + DWELL_MS);
  assert.equal(mc.getState(), "stable");
});

test("ON_TABLE (stab=1) is ignored — does NOT start collecting", () => {
  const mc = new MotionClassifier();
  mc.startCalibration();
  mc.onStabilityClass(STAB_ON_TABLE, 0);
  mc.onStabilityClass(STAB_ON_TABLE, DWELL_MS);
  mc.onStabilityClass(STAB_ON_TABLE, DWELL_MS * 5);
  assert.equal(mc.getState(), "calibrating", "on_table should never trigger stable");
});

test("UNKNOWN (stab=0) while CALIBRATING → stays CALIBRATING", () => {
  const mc = new MotionClassifier();
  mc.startCalibration();
  mc.onStabilityClass(STAB_UNKNOWN, 1000);
  assert.equal(mc.getState(), "calibrating");
});

section("Calibration ceremony — fallback (device already on wrist at connect)");

test("stab >= STATIONARY held for DWELL_NO_MOTION without ever seeing motion → STABLE", () => {
  const mc = new MotionClassifier();
  mc.startCalibration();
  // No STAB_MOTION ever fires — device already on wrist
  mc.onStabilityClass(STAB_STABLE, 0);
  mc.onStabilityClass(STAB_STABLE, DWELL_NO_MOTION - 1);
  assert.equal(mc.getState(), "calibrating", "not yet");
  mc.onStabilityClass(STAB_STABLE, DWELL_NO_MOTION);
  assert.equal(mc.getState(), "stable");
});

test("fallback requires longer dwell than normal path", () => {
  const mc = new MotionClassifier();
  mc.startCalibration();
  mc.onStabilityClass(STAB_STABLE, 0);
  mc.onStabilityClass(STAB_STABLE, DWELL_MS); // normal dwell — not enough without motion
  assert.equal(mc.getState(), "calibrating");
  mc.onStabilityClass(STAB_STABLE, DWELL_NO_MOTION);
  assert.equal(mc.getState(), "stable");
});

section("Stability events ignored before startCalibration");

test("STABLE while UNCALIBRATED → stays UNCALIBRATED", () => {
  const mc = new MotionClassifier();
  mc.onStabilityClass(STAB_STABLE, 1000);
  assert.equal(mc.getState(), "uncalibrated");
});

section("onStateChange callback");

test("fires CALIBRATING then STABLE through full ceremony", () => {
  const states: string[] = [];
  const mc = new MotionClassifier({ onStateChange: (s) => states.push(s) });
  mc.startCalibration();
  mc.onStabilityClass(STAB_MOTION,        0);
  mc.onStabilityClass(STAB_STABLE,      100);
  mc.onStabilityClass(STAB_STABLE, 100 + DWELL_MS);
  assert.deepEqual(states, ["calibrating", "stable"]);
});

section("Motion classification: WRIST_ROTATING");

test("large roll, pitch + yaw within bleed threshold → WRIST_ROTATING", () => {
  const mc = calibrated();
  mc.onDelta({ roll: 15, pitch: 1, yaw: 0.5 }, 100);
  assert.equal(mc.getMotionType(), "wrist_rotating");
  assert.equal(mc.getState(), "moving");
});

test("pitch just below bleed (1.9°) counts as coupling noise → WRIST_ROTATING", () => {
  const mc = calibrated();
  mc.onDelta({ roll: 15, pitch: 1.9, yaw: 0 }, 100);
  assert.equal(mc.getMotionType(), "wrist_rotating");
});

test("yaw just below bleed (1.9°) also counts as coupling noise → WRIST_ROTATING", () => {
  const mc = calibrated();
  mc.onDelta({ roll: 15, pitch: 0, yaw: 1.9 }, 100);
  assert.equal(mc.getMotionType(), "wrist_rotating");
});

test("negative roll (wrist pronating opposite direction) → still WRIST_ROTATING", () => {
  const mc = calibrated();
  mc.onDelta({ roll: -15, pitch: 0, yaw: 0 }, 100);
  assert.equal(mc.getMotionType(), "wrist_rotating");
});

section("Motion classification: ARM_MOVING");

test("large pitch (forearm elevation) → ARM_MOVING", () => {
  const mc = calibrated();
  mc.onDelta({ roll: 0, pitch: 20, yaw: 0 }, 100);
  assert.equal(mc.getMotionType(), "arm_moving");
  assert.equal(mc.getState(), "moving");
});

test("large yaw (shoulder / elbow lateral) → ARM_MOVING", () => {
  const mc = calibrated();
  mc.onDelta({ roll: 0, pitch: 0, yaw: 25 }, 100);
  assert.equal(mc.getMotionType(), "arm_moving");
});

test("large roll + pitch just over bleed (2.1°) → ARM_MOVING (arm also elevating)", () => {
  const mc = calibrated();
  mc.onDelta({ roll: 15, pitch: 2.1, yaw: 0 }, 100);
  assert.equal(mc.getMotionType(), "arm_moving");
});

test("yaw just over bleed (2.1°) with small roll → ARM_MOVING", () => {
  const mc = calibrated();
  mc.onDelta({ roll: 1, pitch: 0, yaw: 2.1 }, 100);
  assert.equal(mc.getMotionType(), "arm_moving");
});

test("large negative pitch (forearm dropping) → ARM_MOVING", () => {
  const mc = calibrated();
  mc.onDelta({ roll: 0, pitch: -20, yaw: 0 }, 100);
  assert.equal(mc.getMotionType(), "arm_moving");
});

section("Minimum movement threshold (noise floor)");

test("delta below noise floor → stays STABLE, no motion event", () => {
  const motions: MotionType[] = [];
  const mc = calibrated({ onMotion: (t) => motions.push(t) });
  mc.onDelta({ roll: 0.5, pitch: 0, yaw: 0.3 }, 100);
  assert.equal(mc.getState(), "stable");
  assert.equal(motions.length, 0);
});

test("delta above noise floor → MOVING, motion event fires", () => {
  const motions: MotionType[] = [];
  const mc = calibrated({ onMotion: (t) => motions.push(t) });
  mc.onDelta({ roll: 3, pitch: 0, yaw: 0 }, 100);
  assert.equal(mc.getState(), "moving");
  assert.equal(motions.length, 1);
});

test("consecutive sub-threshold deltas never trigger motion event", () => {
  const motions: MotionType[] = [];
  const mc = calibrated({ onMotion: (t) => motions.push(t) });
  for (let i = 0; i < 20; i++) {
    mc.onDelta({ roll: 0.3, pitch: 0.1, yaw: 0.2 }, i * 20);
  }
  assert.equal(motions.length, 0);
});

section("No classification before calibration");

test("delta while UNCALIBRATED → no event, stays UNCALIBRATED", () => {
  const motions: MotionType[] = [];
  const mc = new MotionClassifier({ onMotion: (t) => motions.push(t) });
  mc.onDelta({ roll: 20, pitch: 0, yaw: 0 }, 100);
  assert.equal(mc.getState(), "uncalibrated");
  assert.equal(motions.length, 0);
});

test("delta while CALIBRATING → no event, stays CALIBRATING", () => {
  const motions: MotionType[] = [];
  const mc = new MotionClassifier({ onMotion: (t) => motions.push(t) });
  mc.startCalibration();
  mc.onDelta({ roll: 20, pitch: 0, yaw: 0 }, 100);
  assert.equal(mc.getState(), "calibrating");
  assert.equal(motions.length, 0);
});

section("Post-calibration stability");

test("STABLE while MOVING → back to STABLE", () => {
  const mc = calibrated();
  mc.onDelta({ roll: 15, pitch: 0, yaw: 0 }, 100);
  assert.equal(mc.getState(), "moving");
  mc.onStabilityClass(STAB_STABLE, 2000);
  assert.equal(mc.getState(), "stable");
  assert.equal(mc.getMotionType(), null);
});

test("ON_TABLE while MOVING → back to STABLE (post-calibration: any non-motion counts)", () => {
  const mc = calibrated();
  mc.onDelta({ roll: 15, pitch: 0, yaw: 0 }, 100);
  mc.onStabilityClass(STAB_ON_TABLE, 500);
  assert.equal(mc.getState(), "stable");
});

test("multiple STABLE events while already STABLE → no extra transitions", () => {
  const states: string[] = [];
  const mc = calibrated({ onStateChange: (s) => states.push(s) });
  const countAfterCalib = states.length; // ["calibrating", "stable"]
  mc.onStabilityClass(STAB_STABLE, 2000);
  mc.onStabilityClass(STAB_STABLE, 3000);
  assert.equal(states.length, countAfterCalib);
});

test("UNKNOWN while MOVING → stays MOVING (UNKNOWN does not re-baseline)", () => {
  const mc = calibrated();
  mc.onDelta({ roll: 15, pitch: 0, yaw: 0 }, 100);
  mc.onStabilityClass(STAB_UNKNOWN, 500);
  assert.equal(mc.getState(), "moving");
});

section("onMotion callback");

test("onMotion fires for each classified delta in MOVING", () => {
  const motions: MotionType[] = [];
  const mc = calibrated({ onMotion: (t) => motions.push(t) });
  mc.onDelta({ roll: 10, pitch: 0, yaw: 0 }, 100);
  mc.onDelta({ roll: 12, pitch: 0, yaw: 0 }, 120);
  mc.onDelta({ roll: 14, pitch: 0, yaw: 0 }, 140);
  assert.equal(motions.length, 3);
  assert.ok(motions.every((t) => t === "wrist_rotating"), "all should be wrist_rotating");
});

test("onMotion classification can change mid-motion (roll→arm)", () => {
  const motions: MotionType[] = [];
  const mc = calibrated({ onMotion: (t) => motions.push(t) });
  mc.onDelta({ roll: 10, pitch: 1, yaw: 0 },  100); // wrist_rotating
  mc.onDelta({ roll: 10, pitch: 15, yaw: 0 }, 200); // pitch jumps — arm_moving
  assert.equal(motions[0], "wrist_rotating");
  assert.equal(motions[1], "arm_moving");
});

section("reset()");

test("reset() from STABLE → UNCALIBRATED, motionType null", () => {
  const mc = calibrated();
  mc.reset();
  assert.equal(mc.getState(), "uncalibrated");
  assert.equal(mc.getMotionType(), null);
});

test("reset() from MOVING → UNCALIBRATED", () => {
  const mc = calibrated();
  mc.onDelta({ roll: 15, pitch: 0, yaw: 0 }, 100);
  mc.reset();
  assert.equal(mc.getState(), "uncalibrated");
});

test("after reset(), STABLE events are ignored until startCalibration called again", () => {
  const mc = calibrated();
  mc.reset();
  mc.onStabilityClass(STAB_STABLE, 5000);
  assert.equal(mc.getState(), "uncalibrated");
});

// ── Summary ───────────────────────────────────────────────────────────────────

console.log(`\n${"─".repeat(72)}`);
console.log(`  ${passed} passed  |  ${failed} failed  |  ${passed + failed} total`);
console.log(`${"─".repeat(72)}\n`);
process.exit(failed > 0 ? 1 : 0);
