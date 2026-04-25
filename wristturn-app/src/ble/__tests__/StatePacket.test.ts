/**
 * Tests for StatePacket binary parser.
 * Locks the wire format contract with the firmware header
 * (wristturn_audrino/wristturn/state_packet.h).
 *
 * Run without device or React Native:
 *   bun src/ble/__tests__/StatePacket.test.ts
 */

import assert from "node:assert/strict";
import { parseStatePacket, PKT, AXIS, ARM_STATE, SIZE } from "../StatePacket";

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

/** Build a little-endian int16 at the given offset in `bytes`. */
function writeI16LE(bytes: Uint8Array, offset: number, value: number): void {
  bytes[offset]     = value & 0xFF;
  bytes[offset + 1] = (value >> 8) & 0xFF;
}

/** Convert a byte array to the Latin-1 string the RN bridge delivers. */
function bytesToLatin1(bytes: Uint8Array): string {
  let s = "";
  for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
  return s;
}

// ── Sizes ──────────────────────────────────────────────────────────────────

section("Wire sizes match firmware packed structs");

test("SIZE.TAG_ONLY === 1",  () => assert.equal(SIZE.TAG_ONLY, 1));
test("SIZE.STAB === 2",      () => assert.equal(SIZE.STAB,     2));
test("SIZE.ANGLES === 7",    () => assert.equal(SIZE.ANGLES,   7));
test("SIZE.ARM_EVT === 5",   () => assert.equal(SIZE.ARM_EVT,  5));

// ── PKT_STAB ───────────────────────────────────────────────────────────────

section("PKT_STAB parsing");

test("parses stab=3", () => {
  const bytes = new Uint8Array([PKT.STAB, 3]);
  const pkt = parseStatePacket(bytes);
  assert.deepEqual(pkt, { type: "stab", stab: 3 });
});

test("parses stab=4 via latin-1 string", () => {
  const bytes = new Uint8Array([PKT.STAB, 4]);
  const pkt = parseStatePacket(bytesToLatin1(bytes));
  assert.deepEqual(pkt, { type: "stab", stab: 4 });
});

test("truncated STAB returns null", () => {
  assert.equal(parseStatePacket(new Uint8Array([PKT.STAB])), null);
});

// ── PKT_POSE / PKT_BASELINE ────────────────────────────────────────────────

section("AnglesPacket (pose + baseline) parsing");

function buildAngles(tag: number, rollDd: number, pitchDd: number, yawDd: number): Uint8Array {
  const b = new Uint8Array(SIZE.ANGLES);
  b[0] = tag;
  writeI16LE(b, 1, rollDd);
  writeI16LE(b, 3, pitchDd);
  writeI16LE(b, 5, yawDd);
  return b;
}

test("parses pose r=45.6 p=-12.3 y=180.0", () => {
  const bytes = buildAngles(PKT.POSE, 456, -123, 1800);
  const pkt = parseStatePacket(bytes);
  assert.deepEqual(pkt, { type: "pose", roll: 45.6, pitch: -12.3, yaw: 180.0 });
});

test("parses baseline r=0 p=0 y=0", () => {
  const bytes = buildAngles(PKT.BASELINE, 0, 0, 0);
  const pkt = parseStatePacket(bytes);
  assert.deepEqual(pkt, { type: "baseline", roll: 0, pitch: 0, yaw: 0 });
});

test("sign-extends negative i16 correctly", () => {
  const bytes = buildAngles(PKT.POSE, -1, -32768, 32767);
  const pkt = parseStatePacket(bytes);
  assert.deepEqual(pkt, { type: "pose", roll: -0.1, pitch: -3276.8, yaw: 3276.7 });
});

test("truncated ANGLES returns null", () => {
  const short = new Uint8Array([PKT.POSE, 0, 0, 0, 0, 0]);  // only 6 bytes
  assert.equal(parseStatePacket(short), null);
});

// ── PKT_SLEEP / PKT_WAKE ───────────────────────────────────────────────────

section("TagOnlyPacket (sleep + wake)");

test("parses sleep", () => {
  const pkt = parseStatePacket(new Uint8Array([PKT.SLEEP]));
  assert.deepEqual(pkt, { type: "sleep" });
});

test("parses wake", () => {
  const pkt = parseStatePacket(new Uint8Array([PKT.WAKE]));
  assert.deepEqual(pkt, { type: "wake" });
});

// ── PKT_ARM_EVT ────────────────────────────────────────────────────────────

section("ArmEvtPacket parsing");

test("parses arm_evt pitch/armed/1.5°", () => {
  const b = new Uint8Array(SIZE.ARM_EVT);
  b[0] = PKT.ARM_EVT;
  b[1] = AXIS.PITCH;
  b[2] = ARM_STATE.ARMED;
  writeI16LE(b, 3, 15);
  const pkt = parseStatePacket(b);
  assert.deepEqual(pkt, { type: "arm_evt", axis: AXIS.PITCH, state: ARM_STATE.ARMED, delta: 1.5 });
});

// ── Error cases ────────────────────────────────────────────────────────────

section("Error handling");

test("empty payload returns null", () => {
  assert.equal(parseStatePacket(new Uint8Array()), null);
});

test("unknown tag returns null", () => {
  assert.equal(parseStatePacket(new Uint8Array([0xFE, 0x00])), null);
});

// ── Summary ────────────────────────────────────────────────────────────────

console.log(
  `\n${"─".repeat(72)}\n  ${passed} passed  |  ${failed} failed  |  ${passed + failed} total\n${"─".repeat(72)}\n`
);

if (failed > 0) process.exit(1);
