#pragma once
//
// state_packet.h — binary schema for stateChar notifications on WristTurn.
//
// Replaces the previous JSON encoding. JSON payloads were 20–80 bytes and
// silently dropped by the BLE stack when the negotiated ATT MTU was small
// (e.g. 23 on some MediaTek Android devices, payload = 20 bytes).
//
// ────────────────────────────────────────────────────────────────────────────
// Wire format
// ────────────────────────────────────────────────────────────────────────────
//
// Every notification starts with a 1-byte type tag. The payload layout is
// determined by the tag and described by the structs below.
//
// All multi-byte integers are little-endian. Angles are stored as int16 with
// 0.1° precision (deci-degrees), range ±3276.7° — enough for any physical
// pose. Hosts divide by 10 after parsing.
//
// All wire structs are declared with `__attribute__((packed))` so the compiler
// emits them byte-for-byte with no alignment padding. The first field of every
// struct is `uint8_t tag`, and its offset is guaranteed to be 0 by the packed
// attribute + C layout rules, so the dispatcher can read it unconditionally.
//
// Schema is shared with the app in a mirror TypeScript file:
//   wristturn-app/src/ble/StatePacket.ts
//
// Changing any tag value, field order, or field width is a BREAKING change
// that requires a coordinated firmware + app release.
//
// ────────────────────────────────────────────────────────────────────────────

#include <stdint.h>
#include <string.h>

// Packet type tags — first byte of every stateChar notification.
// Values are assigned and MUST NOT be reused even if a packet type is retired.
enum StatePacketType : uint8_t {
    PKT_STAB         = 0x01,  // stability classifier update   (sizeof StabPacket)
    PKT_BASELINE     = 0x02,  // baseline captured/updated     (sizeof AnglesPacket)
    PKT_POSE         = 0x03,  // live pose sample              (sizeof AnglesPacket)
    PKT_SLEEP        = 0x04,  // entering sleep                (sizeof TagOnlyPacket)
    PKT_WAKE         = 0x05,  // waking from sleep             (sizeof TagOnlyPacket)
    PKT_ARM_EVT      = 0x06,  // per-axis arm/disarm           (sizeof ArmEvtPacket)
};

// Axis identifiers used in PKT_ARM_EVT.
enum StatePacketAxis : uint8_t {
    AXIS_ROLL  = 0,
    AXIS_PITCH = 1,
    AXIS_YAW   = 2,
};

// Arm-axis states used in PKT_ARM_EVT.
enum StatePacketArmState : uint8_t {
    ARM_STATE_DISARMED = 0,
    ARM_STATE_ARMED    = 1,
};

// ── Packed wire structs ─────────────────────────────────────────────────────
//
// `__attribute__((packed))` tells the compiler NOT to insert alignment padding
// between fields — the struct is laid out exactly as written, byte-for-byte.
// Required because we're serializing to/from the BLE wire and the app parses
// the same byte layout by offset.
//
// Note: packed structs cannot be accessed via misaligned pointers on strict
// architectures (ARMv6, some RISC-V) without going through memcpy. On Cortex-M4
// (nRF52840) misaligned access is supported in hardware, so direct field
// access is fine. For portability, callers should use the build_* helpers
// below which use memcpy internally.

struct __attribute__((packed)) TagOnlyPacket {
    uint8_t tag;
};
static_assert(sizeof(TagOnlyPacket) == 1, "TagOnlyPacket must be 1 byte");

struct __attribute__((packed)) StabPacket {
    uint8_t tag;
    uint8_t stab;
};
static_assert(sizeof(StabPacket) == 2, "StabPacket must be 2 bytes");

// Shared layout for PKT_BASELINE and PKT_POSE — same three fields.
struct __attribute__((packed)) AnglesPacket {
    uint8_t tag;
    int16_t roll_dd;   // deci-degrees (degrees × 10)
    int16_t pitch_dd;
    int16_t yaw_dd;
};
static_assert(sizeof(AnglesPacket) == 7, "AnglesPacket must be 7 bytes");

struct __attribute__((packed)) ArmEvtPacket {
    uint8_t tag;
    uint8_t axis;       // StatePacketAxis
    uint8_t state;      // StatePacketArmState
    int16_t delta_dd;   // deci-degrees
};
static_assert(sizeof(ArmEvtPacket) == 5, "ArmEvtPacket must be 5 bytes");

// ── Helpers ─────────────────────────────────────────────────────────────────

// Convert a float in degrees to int16 deci-degrees, saturating at ±3276.7°.
static inline int16_t angle_to_i16(float degrees) {
    float x = degrees * 10.0f;
    if (x >  32767.0f) return  32767;
    if (x < -32768.0f) return -32768;
    return (int16_t)x;
}

// ── Packet builders ─────────────────────────────────────────────────────────
//
// All builders use memcpy to write the packed struct into the caller's byte
// buffer. This avoids any misaligned-pointer undefined behavior on strict
// architectures and makes the wire format explicit at the call site.
// Each returns the number of bytes written.

static inline uint8_t pkt_stab(uint8_t* out, uint8_t stabClass) {
    StabPacket p { PKT_STAB, stabClass };
    memcpy(out, &p, sizeof(p));
    return sizeof(p);
}

static inline uint8_t pkt_angles(uint8_t* out, uint8_t tag, float r, float p, float y) {
    AnglesPacket pkt {
        tag,
        angle_to_i16(r),
        angle_to_i16(p),
        angle_to_i16(y),
    };
    memcpy(out, &pkt, sizeof(pkt));
    return sizeof(pkt);
}

static inline uint8_t pkt_baseline(uint8_t* out, float r, float p, float y) {
    return pkt_angles(out, PKT_BASELINE, r, p, y);
}

static inline uint8_t pkt_pose(uint8_t* out, float r, float p, float y) {
    return pkt_angles(out, PKT_POSE, r, p, y);
}

static inline uint8_t pkt_sleep(uint8_t* out) {
    TagOnlyPacket p { PKT_SLEEP };
    memcpy(out, &p, sizeof(p));
    return sizeof(p);
}

static inline uint8_t pkt_wake(uint8_t* out) {
    TagOnlyPacket p { PKT_WAKE };
    memcpy(out, &p, sizeof(p));
    return sizeof(p);
}

static inline uint8_t pkt_arm_evt(uint8_t* out, uint8_t axis, uint8_t state, float delta) {
    ArmEvtPacket p {
        PKT_ARM_EVT,
        axis,
        state,
        angle_to_i16(delta),
    };
    memcpy(out, &p, sizeof(p));
    return sizeof(p);
}

// Max packet size across all types — used to size transmission buffers.
// Must be kept in sync with the largest packed struct above.
static constexpr uint8_t STATE_PACKET_MAX_LEN = sizeof(AnglesPacket);  // 7
