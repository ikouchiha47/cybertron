/**
 * Tests for ComboValidator.
 * Run without device or React Native:
 *   bun src/gestures/__tests__/ComboValidator.test.ts
 */

import assert from "node:assert/strict";
import { validateCombo, validateComboMap } from "../ComboValidator";

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

// ── Opposite-direction adjacency (existing rule, must still hold) ─────────────

section("opposite-direction adjacency");

test("turn_right,turn_left rejected", () => {
  const err = validateCombo("turn_right,turn_left");
  assert.ok(err && err.includes("opposite-direction"), `expected opposite-direction error, got: ${err}`);
});

test("pitch_up,pitch_down rejected", () => {
  assert.ok(validateCombo("pitch_up,pitch_down"));
});

test("yaw_left,yaw_right rejected", () => {
  assert.ok(validateCombo("yaw_left,yaw_right"));
});

test("turn_right,pitch_up,turn_left accepted (non-adjacent opposites)", () => {
  // After Loop A, this is still valid: the opposites are not adjacent.
  assert.equal(validateCombo("turn_right,pitch_up,turn_left"), null);
});

// ── Same-axis adjacency (NEW rule) ────────────────────────────────────────────

section("same-axis adjacency (new in Loop A)");

test("turn_right,turn_right rejected as repeat", () => {
  const err = validateCombo("turn_right,turn_right");
  assert.ok(err, "expected error");
  assert.ok(err.includes("auto-repeat") || err.includes("Hold"), `expected hold-related msg, got: ${err}`);
});

test("turn_left,turn_left rejected as repeat", () => {
  assert.ok(validateCombo("turn_left,turn_left"));
});

test("pitch_up,pitch_up rejected as repeat", () => {
  assert.ok(validateCombo("pitch_up,pitch_up"));
});

test("pitch_down,pitch_down rejected as repeat", () => {
  assert.ok(validateCombo("pitch_down,pitch_down"));
});

test("yaw_right,yaw_right rejected as repeat", () => {
  assert.ok(validateCombo("yaw_right,yaw_right"));
});

test("yaw_left,yaw_left rejected as repeat", () => {
  assert.ok(validateCombo("yaw_left,yaw_left"));
});

test("turn_right,pitch_up,turn_right accepted (non-adjacent same axis)", () => {
  assert.equal(validateCombo("turn_right,pitch_up,turn_right"), null);
});

test("turn_right,turn_right,pitch_up rejected (first adjacency)", () => {
  assert.ok(validateCombo("turn_right,turn_right,pitch_up"));
});

test("pitch_up,turn_right,turn_right rejected (second adjacency)", () => {
  assert.ok(validateCombo("pitch_up,turn_right,turn_right"));
});

// ── Exempt tokens (tap, shake) — HoldDetector never owns these ────────────────

section("exempt tokens");

test("tap,tap accepted (non-axis token)", () => {
  assert.equal(validateCombo("tap,tap"), null);
});

test("shake,shake accepted (non-axis token)", () => {
  assert.equal(validateCombo("shake,shake"), null);
});

test("tap,turn_right accepted", () => {
  assert.equal(validateCombo("tap,turn_right"), null);
});

// ── Heterogeneous combos (must still pass) ────────────────────────────────────

section("heterogeneous combos");

test("turn_right,pitch_up accepted", () => {
  assert.equal(validateCombo("turn_right,pitch_up"), null);
});

test("turn_right,yaw_right,pitch_down accepted", () => {
  assert.equal(validateCombo("turn_right,yaw_right,pitch_down"), null);
});

test("single token accepted", () => {
  assert.equal(validateCombo("turn_right"), null);
});

// ── Synthetic keys (skip validation) ──────────────────────────────────────────

section("synthetic keys");

test("symbol:circle skipped", () => {
  assert.equal(validateCombo("symbol:circle"), null);
});

test("hold:turn_right skipped (Loop D.6 schema)", () => {
  assert.equal(validateCombo("hold:turn_right"), null);
});

// ── validateComboMap ──────────────────────────────────────────────────────────

section("validateComboMap");

test("returns errors for all violating entries", () => {
  const errs = validateComboMap({
    "turn_right,turn_right": "ff",
    "tap,tap":               "open_app",
    "turn_right,turn_left":  "swap",
    "pitch_up":              "menu",
  });
  assert.equal(errs.length, 2);
});

test("returns empty for all-valid map", () => {
  const errs = validateComboMap({
    "turn_right":            "vol_up",
    "turn_right,pitch_up":   "menu",
    "tap,tap":               "open",
    "hold:turn_right":       "ff",
  });
  assert.equal(errs.length, 0);
});

// ── Summary ───────────────────────────────────────────────────────────────────

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
