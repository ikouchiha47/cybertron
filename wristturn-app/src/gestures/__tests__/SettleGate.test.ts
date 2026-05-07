/**
 * Tests for SettleGate.
 * Run without device or React Native:
 *   bun src/gestures/__tests__/SettleGate.test.ts
 */

import assert from "node:assert/strict";
import { SettleGate } from "../SettleGate";

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

// ── Basic settling behaviour ──────────────────────────────────────────────────

section("settle from cold");

test("does not settle on first below-threshold sample", () => {
  const g = new SettleGate({ durationMs: 150, gyroMaxDps: 5 });
  assert.equal(g.feed(2, 1000), false);
});

test("settles after duration of continuous stillness", () => {
  const g = new SettleGate({ durationMs: 150, gyroMaxDps: 5 });
  assert.equal(g.feed(2, 1000), false);
  assert.equal(g.feed(2, 1100), false);  // 100ms < 150ms
  assert.equal(g.feed(2, 1150), true);   // 150ms >= 150ms
});

test("stays settled while gyro stays below threshold", () => {
  const g = new SettleGate({ durationMs: 150, gyroMaxDps: 5 });
  g.feed(0, 1000);
  assert.equal(g.feed(2, 1200), true);
  assert.equal(g.feed(3, 1300), true);
  assert.equal(g.feed(0, 1500), true);
});

// ── Motion resets timer ───────────────────────────────────────────────────────

section("motion resets the timer");

test("gyro spike above threshold un-settles immediately", () => {
  const g = new SettleGate({ durationMs: 150, gyroMaxDps: 5 });
  g.feed(0, 1000);
  assert.equal(g.feed(2, 1200), true);
  assert.equal(g.feed(20, 1300), false); // spike
  assert.equal(g.feed(0, 1350), false);  // restart, only 50ms in
});

test("must re-accumulate full duration after a spike", () => {
  const g = new SettleGate({ durationMs: 150, gyroMaxDps: 5 });
  g.feed(0, 1000);
  g.feed(2, 1200);  // settled
  g.feed(20, 1300); // spike → reset
  assert.equal(g.feed(0, 1400), false);  // restart at 1400 (0ms accumulated)
  assert.equal(g.feed(0, 1500), false);  // 100ms accumulated
  assert.equal(g.feed(0, 1550), true);   // 150ms accumulated since restart
});

// ── Threshold boundary behaviour ──────────────────────────────────────────────

section("threshold boundary");

test("at-threshold sample counts as below (inclusive)", () => {
  // Implementation uses gyroMag > gyroMaxDps as the cutoff, so equal is OK.
  const g = new SettleGate({ durationMs: 100, gyroMaxDps: 5 });
  g.feed(5, 1000);
  assert.equal(g.feed(5, 1100), true);
});

test("strictly above threshold un-settles", () => {
  const g = new SettleGate({ durationMs: 100, gyroMaxDps: 5 });
  g.feed(0, 1000);
  g.feed(0, 1100); // settled
  assert.equal(g.feed(5.01, 1200), false);
});

// ── reset() ───────────────────────────────────────────────────────────────────

section("reset()");

test("reset un-settles even while gyro is low", () => {
  const g = new SettleGate({ durationMs: 100, gyroMaxDps: 5 });
  g.feed(0, 1000);
  g.feed(0, 1100); // settled
  g.reset();
  assert.equal(g.feed(0, 1150), false);
  assert.equal(g.feed(0, 1250), true); // 100ms after reset
});

// ── isAccumulating() ──────────────────────────────────────────────────────────

section("isAccumulating()");

test("false before any feed", () => {
  const g = new SettleGate({ durationMs: 100, gyroMaxDps: 5 });
  assert.equal(g.isAccumulating(), false);
});

test("true while below threshold (pre-settle)", () => {
  const g = new SettleGate({ durationMs: 100, gyroMaxDps: 5 });
  g.feed(2, 1000);
  assert.equal(g.isAccumulating(), true);
});

test("false after a spike", () => {
  const g = new SettleGate({ durationMs: 100, gyroMaxDps: 5 });
  g.feed(2, 1000);
  g.feed(20, 1100);
  assert.equal(g.isAccumulating(), false);
});

// ── Large gap in nowMs (no special handling) ──────────────────────────────────

section("large time gap");

test("a 5-second gap with no spike in between still counts as continuous", () => {
  // Caller is responsible for sample density; the gate trusts what it's fed.
  const g = new SettleGate({ durationMs: 150, gyroMaxDps: 5 });
  g.feed(0, 1000);
  assert.equal(g.feed(0, 6000), true);
});

// ── Different durations / thresholds (parametric reuse) ───────────────────────

section("parametric reuse");

test("1000ms settle for lock-arming use case", () => {
  const g = new SettleGate({ durationMs: 1000, gyroMaxDps: 5 });
  g.feed(0, 0);
  assert.equal(g.feed(0, 500), false);
  assert.equal(g.feed(0, 1000), true);
});

test("permissive 30 dps threshold for arm-pose use case", () => {
  const g = new SettleGate({ durationMs: 200, gyroMaxDps: 30 });
  g.feed(25, 0);
  assert.equal(g.feed(28, 200), true);
  g.feed(50, 300); // exceeds 30
  assert.equal(g.isAccumulating(), false);
});

// ── Summary ───────────────────────────────────────────────────────────────────

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
