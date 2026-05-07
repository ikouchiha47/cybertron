/**
 * Tests for migrateComboMapV2 — the one-shot upgrade applied at MappingStore.get().
 * Run without device or React Native:
 *   bun src/mapping/__tests__/MappingMigration.test.ts
 */

import assert from "node:assert/strict";
import { migrateComboMapV2 } from "../MappingStore";

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

section("knob_tick removal");

test("drops knob_tick+ entries", () => {
  const { map, changed } = migrateComboMapV2({ "knob_tick+": "vol_up", "tap": "play" });
  assert.equal(changed, true);
  assert.deepEqual(map, { "tap": "play" });
});

test("drops knob_tick- entries", () => {
  const { map, changed } = migrateComboMapV2({ "knob_tick-": "vol_down" });
  assert.equal(changed, true);
  assert.deepEqual(map, {});
});

section("same-axis combo → hold conversion");

test("turn_right,turn_right → hold:turn_right", () => {
  const { map, changed } = migrateComboMapV2({ "turn_right,turn_right": "ff" });
  assert.equal(changed, true);
  assert.deepEqual(map, { "hold:turn_right": "ff" });
});

test("turn_left,turn_left → hold:turn_left", () => {
  const { map, changed } = migrateComboMapV2({ "turn_left,turn_left": "rewind" });
  assert.deepEqual(map, { "hold:turn_left": "rewind" });
});

test("pitch_up,pitch_up → hold:pitch_up", () => {
  const { map, changed } = migrateComboMapV2({ "pitch_up,pitch_up": "scroll_up" });
  assert.deepEqual(map, { "hold:pitch_up": "scroll_up" });
});

test("yaw_left,yaw_left → hold:yaw_left", () => {
  const { map, changed } = migrateComboMapV2({ "yaw_left,yaw_left": "back" });
  assert.deepEqual(map, { "hold:yaw_left": "back" });
});

test("preserves existing hold mapping over auto-converted one", () => {
  const { map } = migrateComboMapV2({
    "turn_right,turn_right": "auto_ff",
    "hold:turn_right":       "manual_ff",
  });
  assert.equal(map["hold:turn_right"], "manual_ff");
  assert.equal(Object.keys(map).length, 1);
});

section("untouched cases");

test("tap,tap survives unchanged (non-axis token)", () => {
  const { map, changed } = migrateComboMapV2({ "tap,tap": "open_netflix" });
  assert.equal(changed, false);
  assert.deepEqual(map, { "tap,tap": "open_netflix" });
});

test("heterogeneous combos survive", () => {
  const { map, changed } = migrateComboMapV2({ "turn_right,pitch_up": "menu" });
  assert.equal(changed, false);
  assert.deepEqual(map, { "turn_right,pitch_up": "menu" });
});

test("singleton tokens survive", () => {
  const { map, changed } = migrateComboMapV2({ "turn_right": "next", "tap": "play" });
  assert.equal(changed, false);
  assert.deepEqual(map, { "turn_right": "next", "tap": "play" });
});

test("symbol entries survive", () => {
  const { map, changed } = migrateComboMapV2({ "symbol:M": "media_next" });
  assert.equal(changed, false);
  assert.deepEqual(map, { "symbol:M": "media_next" });
});

section("combined real-world map");

test("AndroidTV defaults migrate cleanly", () => {
  const before = {
    "turn_right":            "dpad_right",
    "turn_left":             "dpad_left",
    "tap":                   "dpad_center",
    "turn_right,turn_right": "ff",
    "turn_left,turn_left":   "rewind",
    "tap,tap":               "open_netflix",
    "knob_tick+":            "volume_up",
    "knob_tick-":            "volume_down",
    "symbol:V":              "volume_up",
  };
  const { map, changed } = migrateComboMapV2(before);
  assert.equal(changed, true);
  assert.equal(map["knob_tick+"], undefined);
  assert.equal(map["knob_tick-"], undefined);
  assert.equal(map["turn_right,turn_right"], undefined);
  assert.equal(map["hold:turn_right"], "ff");
  assert.equal(map["hold:turn_left"], "rewind");
  assert.equal(map["tap,tap"], "open_netflix");
  assert.equal(map["symbol:V"], "volume_up");
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
