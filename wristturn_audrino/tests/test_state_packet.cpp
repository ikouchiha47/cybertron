// test_state_packet.cpp — host-side compile + size check for state_packet.h
//
// Builds with:
//   g++ -std=c++17 -Wall test_state_packet.cpp -o test_state_packet
//
// IMPORTANT: this test lives outside the sketch folder (wristturn_audrino/tests/,
// not wristturn_audrino/wristturn/). Arduino's build system compiles every
// .cpp file in the sketch folder and links it into the firmware. If this test
// were in the sketch folder, its int main() + printf() would link into the
// firmware alongside the Arduino main, hard-faulting the nRF52 SoftDevice on
// boot (USB never enumerates, normal-mode /dev/cu.usbmodem never appears).
//
// Verifies the packed structs have the exact byte layout the app parser expects.

#include <cstdio>
#include <cstring>
#include <cstdint>
#include "../wristturn/state_packet.h"

static int failed = 0;
static void check(const char* name, bool cond) {
    printf("%s %s\n", cond ? "PASS" : "FAIL", name);
    if (!cond) failed++;
}

int main() {
    // ── Struct sizes ────────────────────────────────────────────────────────
    check("sizeof TagOnlyPacket == 1",      sizeof(TagOnlyPacket)    == 1);
    check("sizeof StabPacket == 2",         sizeof(StabPacket)       == 2);
    check("sizeof AnglesPacket == 7",       sizeof(AnglesPacket)     == 7);
    check("sizeof ArmEvtPacket == 5",       sizeof(ArmEvtPacket)     == 5);
    check("sizeof AnglesExtPacket == 9",    sizeof(AnglesExtPacket)  == 9);
    check("STATE_PACKET_MAX_LEN == 9",      STATE_PACKET_MAX_LEN     == 9);

    // ── pkt_stab ────────────────────────────────────────────────────────────
    {
        uint8_t buf[STATE_PACKET_MAX_LEN] = {0};
        uint8_t n = pkt_stab(buf, 3);
        check("pkt_stab returns 2",       n == 2);
        check("pkt_stab tag",             buf[0] == PKT_STAB);
        check("pkt_stab stab value",      buf[1] == 3);
    }

    // ── pkt_pose roundtrip (45.6°, -12.3°, 180.0°) ──────────────────────────
    {
        uint8_t buf[STATE_PACKET_MAX_LEN] = {0};
        uint8_t n = pkt_pose(buf, 45.6f, -12.3f, 180.0f);
        check("pkt_pose returns 7",       n == 7);
        check("pkt_pose tag",             buf[0] == PKT_POSE);

        // Little-endian int16 at offsets 1, 3, 5
        auto read_i16 = [&](int off) -> int16_t {
            return (int16_t)((buf[off+1] << 8) | buf[off]);
        };
        check("pkt_pose roll_dd ≈ 456",   read_i16(1) == 456);
        check("pkt_pose pitch_dd ≈ -123", read_i16(3) == -123);
        check("pkt_pose yaw_dd ≈ 1800",   read_i16(5) == 1800);
    }

    // ── Saturation at ±3276.7° ──────────────────────────────────────────────
    check("angle_to_i16 saturates +",     angle_to_i16(4000.0f)  ==  32767);
    check("angle_to_i16 saturates -",     angle_to_i16(-4000.0f) == -32768);

    // ── pkt_arm_evt ─────────────────────────────────────────────────────────
    {
        uint8_t buf[STATE_PACKET_MAX_LEN] = {0};
        uint8_t n = pkt_arm_evt(buf, AXIS_PITCH, ARM_STATE_ARMED, 1.5f);
        check("pkt_arm_evt returns 5",    n == 5);
        check("pkt_arm_evt tag",          buf[0] == PKT_ARM_EVT);
        check("pkt_arm_evt axis",         buf[1] == AXIS_PITCH);
        check("pkt_arm_evt state",        buf[2] == ARM_STATE_ARMED);
        int16_t d = (int16_t)((buf[4] << 8) | buf[3]);
        check("pkt_arm_evt delta_dd=15",  d == 15);
    }

    // ── dps_to_u16 saturation / clamp ───────────────────────────────────────
    check("dps_to_u16 zero",              dps_to_u16(0.0f)        ==     0);
    check("dps_to_u16 mid (25.0 dps)",    dps_to_u16(25.0f)       ==   250);
    check("dps_to_u16 fast flick (600)",  dps_to_u16(600.0f)      ==  6000);
    check("dps_to_u16 saturates at u16",  dps_to_u16(10000.0f)    == 65535);
    check("dps_to_u16 clamps negatives",  dps_to_u16(-5.0f)       ==     0);

    // ── pkt_pose_ext roundtrip (12.0°, -3.5°, 0°, 25.0 dps) ─────────────────
    {
        uint8_t buf[STATE_PACKET_MAX_LEN] = {0};
        uint8_t n = pkt_pose_ext(buf, 12.0f, -3.5f, 0.0f, 25.0f);
        check("pkt_pose_ext returns 9",       n == 9);
        check("pkt_pose_ext tag",             buf[0] == PKT_POSE_EXT);
        auto read_i16 = [&](int off) -> int16_t {
            return (int16_t)((buf[off+1] << 8) | buf[off]);
        };
        auto read_u16 = [&](int off) -> uint16_t {
            return (uint16_t)((buf[off+1] << 8) | buf[off]);
        };
        check("pkt_pose_ext roll_dd == 120",  read_i16(1) == 120);
        check("pkt_pose_ext pitch_dd == -35", read_i16(3) == -35);
        check("pkt_pose_ext yaw_dd == 0",     read_i16(5) ==   0);
        check("pkt_pose_ext gyro_ddps == 250", read_u16(7) == 250);
    }

    // ── pkt_pose_ext with high gyro near saturation ─────────────────────────
    {
        uint8_t buf[STATE_PACKET_MAX_LEN] = {0};
        uint8_t n = pkt_pose_ext(buf, 0.0f, 0.0f, 0.0f, 9999.0f);
        check("pkt_pose_ext returns 9 (sat)", n == 9);
        uint16_t g = (uint16_t)((buf[8] << 8) | buf[7]);
        check("pkt_pose_ext gyro saturates",  g == 65535);
    }

    printf("\n%s: %d failure(s)\n", failed ? "FAIL" : "PASS", failed);
    return failed ? 1 : 0;
}
