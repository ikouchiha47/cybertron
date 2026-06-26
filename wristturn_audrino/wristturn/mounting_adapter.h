#pragma once

#include <stdint.h>

// Remaps the chip's three-slot output to the wrist's intended frame so the rest
// of the firmware can stay agnostic to how the chip is physically oriented in
// the case.
//
// Each field names the *source* slot to pull from, signed:
//   +1/-1 → slot1/-slot1, +2/-2 → slot2/-slot2, +3/-3 → slot3/-slot3
//
// The selector logic is purely structural and works the same way regardless of
// what the three slots represent — Euler angles (r/p/y), gyro rate vector
// (gx/gy/gz), or gravity vector. All three originate in the same chip body
// frame and therefore share one AxisMap. Field names below stay roll/pitch/yaw
// for historical reasons; treat them as slot1/slot2/slot3.
//
// Identity (chip mounted "correctly"): { +1, +2, +3 }.

struct AxisMap {
  int8_t roll;
  int8_t pitch;
  int8_t yaw;
};

class MountingAdapter {
  AxisMap map_;
 public:
  MountingAdapter() : map_({+1, +2, +3}) {}
  explicit MountingAdapter(AxisMap m) : map_(m) {}

  void setMap(AxisMap m) { map_ = m; }
  AxisMap getMap() const { return map_; }

  // Generic three-slot remap. Slots can be Euler angles, a gyro rate vector,
  // or a gravity vector — the math is identical because the mount is the same.
  void transform(float& s1, float& s2, float& s3) const {
    const float a = s1, b = s2, c = s3;
    s1 = pick(map_.roll,  a, b, c);
    s2 = pick(map_.pitch, a, b, c);
    s3 = pick(map_.yaw,   a, b, c);
  }

 private:
  static float pick(int8_t src, float a, float b, float c) {
    switch (src) {
      case  1: return  a;
      case -1: return -a;
      case  2: return  b;
      case -2: return -b;
      case  3: return  c;
      case -3: return -c;
      default: return 0.0f;
    }
  }
};
