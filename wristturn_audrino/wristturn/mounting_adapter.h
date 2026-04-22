#pragma once

#include <stdint.h>

// Remaps raw IMU roll/pitch/yaw to the wrist's intended frame so the rest of
// the firmware can stay agnostic to how the chip is physically oriented in
// the case.
//
// Each field names the *source* axis to pull from, signed:
//   +1/-1 → roll/-roll, +2/-2 → pitch/-pitch, +3/-3 → yaw/-yaw
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

  void transform(float& roll, float& pitch, float& yaw) const {
    const float r = roll, p = pitch, y = yaw;
    roll  = pick(map_.roll,  r, p, y);
    pitch = pick(map_.pitch, r, p, y);
    yaw   = pick(map_.yaw,   r, p, y);
  }

 private:
  static float pick(int8_t src, float r, float p, float y) {
    switch (src) {
      case  1: return  r;
      case -1: return -r;
      case  2: return  p;
      case -2: return -p;
      case  3: return  y;
      case -3: return -y;
      default: return 0.0f;
    }
  }
};
