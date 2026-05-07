/**
 * Tests for HoldDetector.
 *
 * Each test corresponds to one of the worked examples in
 * docs/UNIFIED_GESTURE_DESIGN.md §"Worked examples". The detector is fed
 * synthetic PoseSample streams and the fired-token sequence is asserted.
 *
 * Run without device or React Native:
 *   bun src/gestures/__tests__/HoldDetector.test.ts
 */

import assert from "node:assert/strict";
import { HoldDetector } from "../HoldDetector";
import type { PoseSample } from "../PoseSample";

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

// ── Helpers ───────────────────────────────────────────────────────────────────

function makeDetector(): { det: HoldDetector; fired: string[] } {
  const fired: string[] = [];
  const det = new HoldDetector({ onFire: (t) => fired.push(t) });
  return { det, fired };
}

function sample(roll: number, pitch: number, yaw: number, gyroMagDps: number, nowMs: number): PoseSample {
  return { delta: { roll, pitch, yaw }, gyroMagDps, nowMs };
}

/** Feed a series of samples at fixed step. */
function pump(det: HoldDetector, samples: PoseSample[]): void {
  for (const s of samples) det.onSample(s);
}

/** Generate samples holding a given pose for `durationMs` at 10 Hz, starting at `t0`. */
function hold(roll: number, pitch: number, yaw: number, gyroMagDps: number, t0: number, durationMs: number): PoseSample[] {
  const out: PoseSample[] = [];
  for (let t = t0; t <= t0 + durationMs; t += 100) {
    out.push(sample(roll, pitch, yaw, gyroMagDps, t));
  }
  return out;
}

// ── Worked examples from UNIFIED_GESTURE_DESIGN.md ────────────────────────────

section("Example 1 — fast flick to neutral (single command)");

test("flick that returns to neutral within ~400 ms — no hold fire", () => {
  // Velocity-domain detector handles this; HoldDetector should NOT fire because
  // SettleGate's gyro-settled requirement never satisfies during the brief peak.
  const { det, fired } = makeDetector();
  pump(det, [
    sample(0,   0, 0, 0,   0),
    sample(15,  0, 0, 200, 80),    // crossed +12° but gyro high (passing through)
    sample(30,  0, 0, 250, 160),   // peak
    sample(15,  0, 0, 200, 240),   // returning
    sample(0,   0, 0, 50,  320),   // near neutral
    sample(0,   0, 0, 5,   400),
  ]);
  assert.deepEqual(fired, []);
});

section("Example 2 — fast big motion, stop and hold");

test("snap to -40° and hold → one immediate fire then 5 Hz auto-repeat", () => {
  const { det, fired } = makeDetector();
  // Onset: gyro spikes, delta crosses threshold quickly.
  pump(det, [
    sample(0,   0, 0, 0,   0),
    sample(-15, 0, 0, 250, 80),    // crossed -12° during transit (high gyro)
    sample(-35, 0, 0, 200, 160),   // still moving
    sample(-40, 0, 0, 30,  240),   // arriving, gyro decaying
  ]);
  // Hold at -40° (gyro near zero). After SETTLE_DWELL_MS (150 ms) below
  // threshold + recent transit, ENGAGED fires turn_left once.
  pump(det, hold(-40, 0, 0, 2, 250, 200));   // 250..450 ms
  // Now in REPEATING after REPEAT_START_DELAY_MS (400 ms from first fire ≈ 800 ms).
  // Tick the detector forward via samples + tick(); detector uses tick to drive repeats.
  for (let t = 500; t <= 1500; t += 100) {
    det.onSample(sample(-40, 0, 0, 2, t));
    det.tick(t);
  }
  // We expect: one initial fire, then ≥3 repeat fires by t=1500ms.
  assert.equal(fired[0], "turn_left");
  assert.ok(fired.length >= 4, `expected ≥4 fires (1 initial + ≥3 repeats), got ${fired.length}: ${JSON.stringify(fired)}`);
  for (const f of fired) assert.equal(f, "turn_left");
});

section("Example 3 — slow deliberate left, stop and hold");

test("1 s slow drift to -40° then hold → delayed fire then auto-repeat", () => {
  const { det, fired } = makeDetector();
  // Slow motion: gyro stays low (~40°/s) — but importantly, that's still ABOVE
  // GYRO_SETTLED_DPS (5 dps), so SettleGate doesn't accumulate during transit.
  for (let t = 0; t <= 1000; t += 100) {
    const r = -40 * (t / 1000);
    det.onSample(sample(r, 0, 0, 40, t));
  }
  // Arrived at -40°, gyro decays.
  for (let t = 1100; t <= 2000; t += 100) {
    det.onSample(sample(-40, 0, 0, 2, t));
    det.tick(t);
  }
  // After settle (150 ms post arrival ≈ t=1250) → fire turn_left.
  // After REPEAT_START_DELAY_MS (≈ t=1650) → auto-repeat begins.
  assert.equal(fired[0], "turn_left", `expected first fire turn_left, got: ${JSON.stringify(fired)}`);
  assert.ok(fired.length >= 2, "expected at least one auto-repeat by t=2000ms");
});

section("Example 4 — drift (should fire nothing)");

test("slow posture creep toward +11° never fires", () => {
  const { det, fired } = makeDetector();
  // Drift from 0° → +11° over 60 s, gyro near zero throughout.
  // Never crosses +12°, and even if it did, no recent transit to trigger fresh ENGAGED.
  for (let t = 0; t <= 60000; t += 1000) {
    const r = 11 * (t / 60000);
    det.onSample(sample(r, 0, 0, 1, t));
  }
  assert.deepEqual(fired, []);
});

test("slow creep across +12° without a transit event still fires nothing", () => {
  const { det, fired } = makeDetector();
  // Cross threshold at gyro=0 (pure drift). Detector requires a recent transit
  // (gyro non-zero recently) before treating a threshold crossing as fresh.
  for (let t = 0; t <= 30000; t += 500) {
    const r = 14 * (t / 30000);
    det.onSample(sample(r, 0, 0, 0.5, t));
    det.tick(t);
  }
  assert.deepEqual(fired, []);
});

section("Example 5 — cruise lock entry and exit");

test("hold, release, re-deflect within window → cruise lock; reverse → exit fires turn_left ×1", () => {
  const { det, fired } = makeDetector();
  // 1) Initial hold
  pump(det, [
    sample(0,  0, 0, 0,   0),
    sample(20, 0, 0, 200, 80),     // transit
    sample(30, 0, 0, 50,  160),
  ]);
  pump(det, hold(30, 0, 0, 2, 200, 1800));       // hold 1.8s → REPEATING
  for (let t = 200; t <= 2000; t += 100) det.tick(t);

  // 2) Release: drop to neutral by t=2200
  det.onSample(sample(5, 0, 0, 80, 2100));
  det.onSample(sample(0, 0, 0, 30, 2200));

  // 3) Second deflection within LOCK_WINDOW_MS (≤ t=3500)
  det.onSample(sample(20, 0, 0, 200, 2800));     // transit
  det.onSample(sample(30, 0, 0, 50,  2900));
  // Settle (1000 ms) into chosen rest ~ +5°
  for (let t = 3000; t <= 4500; t += 100) {
    det.onSample(sample(5, 0, 0, 1, t));
    det.tick(t);
  }
  // Now LOCKED_ARMED. Continue cruise for a while.
  for (let t = 4500; t <= 6000; t += 100) {
    det.onSample(sample(5, 0, 0, 1, t));
    det.tick(t);
  }
  const beforeExit = fired.filter((f) => f === "turn_right").length;
  assert.ok(beforeExit >= 5, `expected ≥5 turn_right fires before exit, got ${beforeExit}`);

  // 4) Reverse to exit: lock_baseline ≈ +5°, exit at delta − baseline < −12° → ≈ −7°
  det.onSample(sample(-10, 0, 0, 80, 6100));
  for (let t = 6200; t <= 6500; t += 100) {
    det.onSample(sample(-10, 0, 0, 1, t));
    det.tick(t);
  }
  // Should fire exactly one turn_left as the unlock token.
  const turnLeftCount = fired.filter((f) => f === "turn_left").length;
  assert.equal(turnLeftCount, 1, `expected exactly 1 turn_left exit fire, got ${turnLeftCount}: ${JSON.stringify(fired)}`);
});

section("Example 6 — same-direction jiggle during cruise");

test("same-direction deflection past threshold during LOCKED_ARMED does nothing extra", () => {
  const { det, fired } = makeDetector();
  // Set up a cruise lock (same opening as Example 5).
  pump(det, [sample(0,0,0,0,0), sample(20,0,0,200,80), sample(30,0,0,50,160)]);
  pump(det, hold(30,0,0,2,200,1800));
  for (let t = 200; t <= 2000; t += 100) det.tick(t);
  det.onSample(sample(0,0,0,30,2200));
  det.onSample(sample(20,0,0,200,2800));
  det.onSample(sample(30,0,0,50,2900));
  for (let t = 3000; t <= 4500; t += 100) { det.onSample(sample(5,0,0,1,t)); det.tick(t); }
  // LOCKED_ARMED reached. Snapshot fire count.
  const lockedCount = fired.length;

  // Same-direction jiggle to +25° (above threshold, same axis-direction).
  det.onSample(sample(25,0,0,80,4600));
  for (let t = 4700; t <= 5000; t += 100) { det.onSample(sample(25,0,0,1,t)); det.tick(t); }
  // Back to +5°.
  for (let t = 5100; t <= 5300; t += 100) { det.onSample(sample(5,0,0,1,t)); det.tick(t); }

  // No turn_left should have fired (no exit).
  assert.equal(fired.filter(f => f === "turn_left").length, 0);
  // Auto-repeat continues: more fires than at lock-entry.
  assert.ok(fired.length > lockedCount);
});

section("Example 7 — shake during cruise (universal exit)");

test("shake event resets the FSM mid-cruise; no extra hold fires after", () => {
  const { det, fired } = makeDetector();
  // Same opening as Example 5 → reach LOCKED_ARMED.
  pump(det, [sample(0,0,0,0,0), sample(20,0,0,200,80), sample(30,0,0,50,160)]);
  pump(det, hold(30,0,0,2,200,1800));
  for (let t = 200; t <= 2000; t += 100) det.tick(t);
  det.onSample(sample(0,0,0,30,2200));
  det.onSample(sample(20,0,0,200,2800));
  det.onSample(sample(30,0,0,50,2900));
  for (let t = 3000; t <= 4500; t += 100) { det.onSample(sample(5,0,0,1,t)); det.tick(t); }
  const lockedCount = fired.length;

  // Universal exit
  det.onShake();
  // After shake, even more samples at the locked pose should NOT continue auto-repeat.
  for (let t = 4600; t <= 5500; t += 100) { det.onSample(sample(5,0,0,1,t)); det.tick(t); }
  assert.equal(fired.length, lockedCount, "no fires expected after shake reset");
});

section("Example 8 — pose change during cruise (silent exit)");

test("armPose hanging during LOCKED_ARMED resets silently", () => {
  const { det, fired } = makeDetector();
  pump(det, [sample(0,0,0,0,0), sample(20,0,0,200,80), sample(30,0,0,50,160)]);
  pump(det, hold(30,0,0,2,200,1800));
  for (let t = 200; t <= 2000; t += 100) det.tick(t);
  det.onSample(sample(0,0,0,30,2200));
  det.onSample(sample(20,0,0,200,2800));
  det.onSample(sample(30,0,0,50,2900));
  for (let t = 3000; t <= 4500; t += 100) { det.onSample(sample(5,0,0,1,t)); det.tick(t); }
  const lockedCount = fired.length;

  det.onArmPoseChange("raised", "hanging");
  for (let t = 4600; t <= 5500; t += 100) { det.onSample(sample(5,0,0,1,t)); det.tick(t); }
  assert.equal(fired.length, lockedCount, "no fires expected after pose-change reset");
});

section("Example 9 — partial hold then release (single fire only)");

test("deflect, hold for 200 ms, release → exactly one fire", () => {
  const { det, fired } = makeDetector();
  pump(det, [
    sample(0,   0, 0, 0,   0),
    sample(20,  0, 0, 200, 80),    // transit
    sample(30,  0, 0, 50,  160),
  ]);
  // Hold long enough for ENGAGED fire (≈150 ms) but release before
  // REPEAT_START_DELAY_MS (400 ms).
  det.onSample(sample(30, 0, 0, 2, 200));
  det.onSample(sample(30, 0, 0, 2, 280));
  det.onSample(sample(30, 0, 0, 2, 350));
  det.tick(350);
  // Release before 400 ms post first-fire.
  det.onSample(sample(5,  0, 0, 80, 380));
  det.onSample(sample(0,  0, 0, 30, 450));
  for (let t = 500; t <= 1500; t += 100) det.tick(t);

  assert.equal(fired.length, 1, `expected exactly 1 fire, got ${fired.length}: ${JSON.stringify(fired)}`);
  assert.equal(fired[0], "turn_right");
});

// ── Summary ───────────────────────────────────────────────────────────────────

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
