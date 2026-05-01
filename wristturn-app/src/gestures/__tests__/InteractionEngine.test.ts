/**
 * Tests for InteractionEngine.
 * Run without device or React Native:
 *   bun src/gestures/__tests__/InteractionEngine.test.ts
 */

import assert from "node:assert/strict";
import { InteractionEngine } from "../InteractionEngine";
import type { InteractionRule } from "../InteractionEngine";

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

// ── Helpers ───────────────────────────────────────────────────────────────────

let fakeNow = 1000;
function now() { return fakeNow; }
function tick(ms: number) { fakeNow += ms; }

function makeEngine(rules: InteractionRule[]): { engine: InteractionEngine; fired: string[] } {
  const fired: string[] = [];
  const engine = new InteractionEngine((action) => fired.push(action), now);
  engine.setRules(rules);
  return { engine, fired };
}

function push(engine: InteractionEngine, token: string) {
  engine.push(token, fakeNow);
}

// ── Terminal rules ────────────────────────────────────────────────────────────

section("Terminal rules");

test("fires immediately on matching token", () => {
  const { engine, fired } = makeEngine([
    { type: "terminal", token: "turn_right", action: "dpad_right" },
  ]);
  push(engine, "turn_right");
  assert.deepEqual(fired, ["dpad_right"]);
});

test("does not fire on non-matching token", () => {
  const { engine, fired } = makeEngine([
    { type: "terminal", token: "turn_right", action: "dpad_right" },
  ]);
  push(engine, "turn_left");
  assert.deepEqual(fired, []);
});

test("refractory suppresses duplicate within 200ms", () => {
  const { engine, fired } = makeEngine([
    { type: "terminal", token: "turn_right", action: "dpad_right", refractoryMs: 200 },
  ]);
  push(engine, "turn_right");
  tick(100);
  push(engine, "turn_right");
  assert.deepEqual(fired, ["dpad_right"]);
});

test("refractory expires — duplicate fires after window", () => {
  const { engine, fired } = makeEngine([
    { type: "terminal", token: "turn_right", action: "dpad_right", refractoryMs: 200 },
  ]);
  push(engine, "turn_right");
  tick(201);
  push(engine, "turn_right");
  assert.deepEqual(fired, ["dpad_right", "dpad_right"]);
});

test("refractory does not affect a different token", () => {
  const { engine, fired } = makeEngine([
    { type: "terminal", token: "turn_right", action: "dpad_right", refractoryMs: 200 },
    { type: "terminal", token: "pitch_down", action: "dpad_down",  refractoryMs: 200 },
  ]);
  push(engine, "turn_right");
  tick(50);
  push(engine, "pitch_down");
  assert.deepEqual(fired, ["dpad_right", "dpad_down"]);
});

test("snap-back suppresses opposite axis within snapBackMs", () => {
  const { engine, fired } = makeEngine([
    { type: "terminal", token: "turn_right", action: "dpad_right", snapBackMs: 500 },
    { type: "terminal", token: "turn_left",  action: "dpad_left",  snapBackMs: 500 },
  ]);
  push(engine, "turn_right");
  tick(100);
  push(engine, "turn_left");
  assert.deepEqual(fired, ["dpad_right"]);
});

test("snap-back expires — opposite fires after window", () => {
  const { engine, fired } = makeEngine([
    { type: "terminal", token: "turn_right", action: "dpad_right", snapBackMs: 500 },
    { type: "terminal", token: "turn_left",  action: "dpad_left",  snapBackMs: 500 },
  ]);
  push(engine, "turn_right");
  tick(501);
  push(engine, "turn_left");
  assert.deepEqual(fired, ["dpad_right", "dpad_left"]);
});

test("snap-back is axis-scoped — different axis not suppressed", () => {
  const { engine, fired } = makeEngine([
    { type: "terminal", token: "turn_right", action: "dpad_right", snapBackMs: 500 },
    { type: "terminal", token: "pitch_down", action: "dpad_down",  snapBackMs: 500 },
  ]);
  push(engine, "turn_right");
  tick(100);
  push(engine, "pitch_down");
  assert.deepEqual(fired, ["dpad_right", "dpad_down"]);
});

test("gobbleMs suppresses lower-priority rules after fire", () => {
  const { engine, fired } = makeEngine([
    { type: "terminal", token: "shake",      action: "wake",       gobbleMs: 500 },
    { type: "terminal", token: "turn_right", action: "dpad_right" },
  ]);
  push(engine, "shake");
  tick(100);
  push(engine, "turn_right");
  assert.deepEqual(fired, ["wake"]);
});

test("gobbleMs expires — lower-priority rule fires after window", () => {
  const { engine, fired } = makeEngine([
    { type: "terminal", token: "shake",      action: "wake",       gobbleMs: 500 },
    { type: "terminal", token: "turn_right", action: "dpad_right" },
  ]);
  push(engine, "shake");
  tick(501);
  push(engine, "turn_right");
  assert.deepEqual(fired, ["wake", "dpad_right"]);
});

test("gobbleMs does not suppress higher-priority rules", () => {
  // shake has no refractory (refractoryMs: 0) — it always passes
  const { engine, fired } = makeEngine([
    { type: "terminal", token: "shake",      action: "wake",       gobbleMs: 500, refractoryMs: 0 },
    { type: "terminal", token: "turn_right", action: "dpad_right" },
  ]);
  push(engine, "shake");
  tick(100);
  push(engine, "shake");
  assert.deepEqual(fired, ["wake", "wake"]);
});

// ── Sequence rules ────────────────────────────────────────────────────────────

section("Sequence rules");

test("fires on completion within windowMs", () => {
  const { engine, fired } = makeEngine([
    { type: "sequence", tokens: ["turn_right","turn_right"], windowMs: 300, action: "ff" },
  ]);
  push(engine, "turn_right");
  tick(200);
  push(engine, "turn_right");
  assert.deepEqual(fired, ["ff"]);
});

test("does not fire if gap exceeds windowMs", () => {
  const { engine, fired } = makeEngine([
    { type: "sequence", tokens: ["turn_right","turn_right"], windowMs: 300, action: "ff" },
  ]);
  push(engine, "turn_right");
  tick(301);
  push(engine, "turn_right");
  assert.deepEqual(fired, []);
});

test("wrong token resets partial match", () => {
  const { engine, fired } = makeEngine([
    { type: "sequence", tokens: ["turn_right","turn_right"], windowMs: 300, action: "ff" },
  ]);
  push(engine, "turn_right");
  tick(100);
  push(engine, "turn_left");
  tick(100);
  push(engine, "turn_right");
  assert.deepEqual(fired, []);
});

test("sequence takes priority over terminal for same first token", () => {
  // turn_right terminal fires only when sequence has no pending partial match;
  // once sequence starts buffering, the terminal must not fire for the first token.
  const fired: string[] = [];
  const engine = new InteractionEngine((action) => fired.push(action), now);
  engine.setRules([
    { type: "sequence", tokens: ["turn_right","turn_right"], windowMs: 300, action: "ff" },
    { type: "terminal", token: "turn_right", action: "dpad_right" },
  ]);
  push(engine, "turn_right"); // begins sequence — must NOT fire terminal yet
  assert.deepEqual(fired, []);
  tick(200);
  push(engine, "turn_right"); // completes sequence
  assert.deepEqual(fired, ["ff"]);
});

test("sequence first token falls through to terminal on timeout", () => {
  const fired: string[] = [];
  const engine = new InteractionEngine((action) => fired.push(action), now);
  engine.setRules([
    { type: "sequence", tokens: ["turn_right","turn_right"], windowMs: 300, action: "ff" },
    { type: "terminal", token: "turn_right", action: "dpad_right" },
  ]);
  push(engine, "turn_right");
  tick(301); // window expired
  // next push should flush the pending token as terminal
  push(engine, "pitch_down");
  assert.deepEqual(fired, ["dpad_right"]);
});

test("three-token sequence fires only on third token", () => {
  const { engine, fired } = makeEngine([
    { type: "sequence", tokens: ["yaw_left","yaw_left","yaw_left"], windowMs: 600, action: "scroll_left" },
  ]);
  push(engine, "yaw_left"); tick(100);
  push(engine, "yaw_left"); tick(100);
  assert.deepEqual(fired, []);
  push(engine, "yaw_left");
  assert.deepEqual(fired, ["scroll_left"]);
});

// ── Repeat rules ──────────────────────────────────────────────────────────────

section("Repeat rules");

test("entry sequence fires action and enters repeat mode", () => {
  const fired: string[] = [];
  const engine = new InteractionEngine((action) => fired.push(action), now);
  engine.setRules([
    { type: "repeat", tokens: ["yaw_left","yaw_left","yaw_left"], windowMs: 600, action: "scroll_left", intervalMs: 200, cancelOn: ["yaw_right"] },
  ]);
  push(engine, "yaw_left"); tick(100);
  push(engine, "yaw_left"); tick(100);
  push(engine, "yaw_left"); // triggers
  assert.deepEqual(fired, ["scroll_left"]);
  tick(200);
  engine.tick(fakeNow); // simulate interval tick
  assert.deepEqual(fired, ["scroll_left", "scroll_left"]);
});

test("cancelOn token exits repeat mode and is not forwarded", () => {
  const fired: string[] = [];
  const engine = new InteractionEngine((action) => fired.push(action), now);
  engine.setRules([
    { type: "repeat", tokens: ["yaw_left","yaw_left","yaw_left"], windowMs: 600, action: "scroll_left", intervalMs: 200, cancelOn: ["yaw_right"] },
    { type: "terminal", token: "yaw_right", action: "dpad_right" },
  ]);
  push(engine, "yaw_left"); tick(100);
  push(engine, "yaw_left"); tick(100);
  push(engine, "yaw_left"); // enter repeat
  tick(200); engine.tick(fakeNow);
  push(engine, "yaw_right"); // cancel — must not forward to terminal
  tick(200); engine.tick(fakeNow); // no more repeats
  assert.deepEqual(fired, ["scroll_left", "scroll_left"]);
});

test("no repeat fires after cancel", () => {
  const fired: string[] = [];
  const engine = new InteractionEngine((action) => fired.push(action), now);
  engine.setRules([
    { type: "repeat", tokens: ["yaw_left","yaw_left","yaw_left"], windowMs: 600, action: "scroll_left", intervalMs: 200, cancelOn: ["yaw_right"] },
  ]);
  push(engine, "yaw_left"); tick(100);
  push(engine, "yaw_left"); tick(100);
  push(engine, "yaw_left");
  push(engine, "yaw_right"); // immediate cancel
  tick(200); engine.tick(fakeNow);
  tick(200); engine.tick(fakeNow);
  assert.deepEqual(fired, ["scroll_left"]);
});

// ── reset ─────────────────────────────────────────────────────────────────────

section("reset");

test("reset clears refractory — same token fires again immediately", () => {
  const { engine, fired } = makeEngine([
    { type: "terminal", token: "turn_right", action: "dpad_right", refractoryMs: 200 },
  ]);
  push(engine, "turn_right");
  tick(50);
  engine.reset();
  push(engine, "turn_right");
  assert.deepEqual(fired, ["dpad_right", "dpad_right"]);
});

test("reset clears snap-back — opposite fires immediately", () => {
  const { engine, fired } = makeEngine([
    { type: "terminal", token: "turn_right", action: "dpad_right", snapBackMs: 500 },
    { type: "terminal", token: "turn_left",  action: "dpad_left",  snapBackMs: 500 },
  ]);
  push(engine, "turn_right");
  tick(50);
  engine.reset();
  push(engine, "turn_left");
  assert.deepEqual(fired, ["dpad_right", "dpad_left"]);
});

test("reset clears gobble window", () => {
  const { engine, fired } = makeEngine([
    { type: "terminal", token: "shake",      action: "wake",       gobbleMs: 500 },
    { type: "terminal", token: "turn_right", action: "dpad_right" },
  ]);
  push(engine, "shake");
  tick(100);
  engine.reset();
  push(engine, "turn_right");
  assert.deepEqual(fired, ["wake", "dpad_right"]);
});

test("reset clears partial sequence match", () => {
  const { engine, fired } = makeEngine([
    { type: "sequence", tokens: ["turn_right","turn_right"], windowMs: 300, action: "ff" },
  ]);
  push(engine, "turn_right");
  tick(100);
  engine.reset();
  tick(100);
  push(engine, "turn_right");
  assert.deepEqual(fired, []);
});

// ── Summary ───────────────────────────────────────────────────────────────────

console.log(`\n${passed + failed} tests: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
