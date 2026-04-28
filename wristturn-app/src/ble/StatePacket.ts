//
// StatePacket.ts — binary schema mirror for stateChar notifications.
//
// MUST stay in lockstep with firmware header:
//   wristturn_audrino/wristturn/state_packet.h
//
// ────────────────────────────────────────────────────────────────────────────
// Wire format (see firmware header for authoritative spec)
// ────────────────────────────────────────────────────────────────────────────
//
// Every packet begins with a 1-byte type tag. The following layouts mirror
// the packed C++ structs exactly:
//
//   TagOnly    (PKT.SLEEP, PKT.WAKE)             1 byte
//     u8  tag
//
//   StabPacket (PKT.STAB)                        2 bytes
//     u8  tag
//     u8  stab
//
//   AnglesPacket (PKT.BASELINE, PKT.POSE)        7 bytes
//     u8  tag
//     i16 roll_dd   (little-endian, deci-degrees)
//     i16 pitch_dd
//     i16 yaw_dd
//
//   ArmEvtPacket (PKT.ARM_EVT)                   5 bytes
//     u8  tag
//     u8  axis
//     u8  state
//     i16 delta_dd
//
// All multi-byte integers are little-endian. Angles are divided by 10 on parse.
//
// ────────────────────────────────────────────────────────────────────────────

/** Packet type tags — first byte of every stateChar notification. */
export const PKT = {
  STAB:     0x01,
  BASELINE: 0x02,
  POSE:     0x03,
  SLEEP:    0x04,
  WAKE:     0x05,
  ARM_EVT:  0x06,
  GRAV:     0x07,
} as const;

/** Arm pose values carried in GravPacket. */
export const GRAV_POSE = {
  FLAT:    0,
  HANGING: 1,
  RAISED:  2,
} as const;
export type GravPoseValue = typeof GRAV_POSE[keyof typeof GRAV_POSE];

/** Axis identifiers used in PKT.ARM_EVT. */
export const AXIS = {
  ROLL:  0,
  PITCH: 1,
  YAW:   2,
} as const;

/** Arm-axis states used in PKT.ARM_EVT. */
export const ARM_STATE = {
  DISARMED: 0,
  ARMED:    1,
} as const;

/** Exact byte sizes of each packed wire struct. */
export const SIZE = {
  TAG_ONLY:   1,
  STAB:       2,
  ANGLES:     7,
  ARM_EVT:    5,
  GRAV:       2,
} as const;

// ── Parsed-packet types ─────────────────────────────────────────────────────

export type StabPacket     = { type: "stab";     stab:  number };
export type BaselinePacket = { type: "baseline"; roll:  number; pitch: number; yaw: number };
export type PosePacket     = { type: "pose";     roll:  number; pitch: number; yaw: number };
export type SleepPacket    = { type: "sleep" };
export type WakePacket     = { type: "wake" };
export type ArmEvtPacket   = { type: "arm_evt"; axis: number; state: number; delta: number };
export type GravPacket     = { type: "grav";    pose: GravPoseValue };

export type StatePacket =
  | StabPacket
  | BaselinePacket
  | PosePacket
  | SleepPacket
  | WakePacket
  | ArmEvtPacket
  | GravPacket;

// ── Parsing ─────────────────────────────────────────────────────────────────

/** Read a little-endian int16 and convert deci-degrees → degrees. */
function readI16LEAngle(bytes: Uint8Array, offset: number): number {
  const lo = bytes[offset];
  const hi = bytes[offset + 1];
  const raw = (((hi << 8) | lo) << 16) >> 16;   // sign-extend
  return raw / 10.0;
}

/** Decode an AnglesPacket payload starting at offset 1 (skip tag). */
function parseAngles(bytes: Uint8Array): { roll: number; pitch: number; yaw: number } {
  return {
    roll:  readI16LEAngle(bytes, 1),
    pitch: readI16LEAngle(bytes, 3),
    yaw:   readI16LEAngle(bytes, 5),
  };
}

/**
 * Parse a stateChar notification payload. Returns null on unknown tag,
 * truncated payload, or other decoding failure.
 *
 * Accepts either a raw Uint8Array (native-side) or a Latin-1 binary string
 * (the shape currently delivered by the RN bridge as `raw`).
 */
export function parseStatePacket(input: Uint8Array | string): StatePacket | null {
  const bytes = typeof input === "string" ? latin1ToBytes(input) : input;
  if (bytes.length < 1) return null;

  const tag = bytes[0];
  switch (tag) {
    case PKT.STAB:
      if (bytes.length < SIZE.STAB) return null;
      return { type: "stab", stab: bytes[1] };

    case PKT.BASELINE:
      if (bytes.length < SIZE.ANGLES) return null;
      return { type: "baseline", ...parseAngles(bytes) };

    case PKT.POSE:
      if (bytes.length < SIZE.ANGLES) return null;
      return { type: "pose", ...parseAngles(bytes) };

    case PKT.SLEEP: return { type: "sleep" };
    case PKT.WAKE:  return { type: "wake"  };

    case PKT.ARM_EVT:
      if (bytes.length < SIZE.ARM_EVT) return null;
      return {
        type:  "arm_evt",
        axis:  bytes[1],
        state: bytes[2],
        delta: readI16LEAngle(bytes, 3),
      };

    case PKT.GRAV:
      if (bytes.length < SIZE.GRAV) return null;
      return { type: "grav", pose: bytes[1] as GravPoseValue };

    default:
      return null;
  }
}

/** Convert a Latin-1 binary string (as passed over the RN bridge) to bytes. */
function latin1ToBytes(s: string): Uint8Array {
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i) & 0xFF;
  return out;
}
