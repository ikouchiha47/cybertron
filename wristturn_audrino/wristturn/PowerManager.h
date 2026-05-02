#pragma once
// PowerManager.h — composable two-tier sleep for WristTurn firmware.
//
// Tier 1  LIGHT SLEEP  (0 – DEEP_SLEEP_AFTER_MS of inactivity)
//   ShakeSleepPolicy: modeSleep() + software timer cycle.
//   Every cycleMs: modeOn(), drain FIFO, look for shake event (0x19).
//   If shake found → full wake. If not → modeSleep() and repeat.
//   No wakeupEnabled, no INT pin acrobatics.
//
// Tier 2  DEEP SLEEP   (DEEP_SLEEP_AFTER_MS+)
//   SigMotionSleepPolicy: modeSleep() + SH2_SIGNIFICANT_MOTION wakeupEnabled.
//   BNO085 always-on domain asserts INT on genuine motion (5-step pattern).
//   cycleMs() == 0 → wait indefinitely, only INT wake.
//
// Policies are composable via StagedPolicy (sequential) and
// FirstWakePolicy (parallel OR).
//
// No Arduino headers here — pure C++ so this file is testable with g++.
// Hardware calls go through a thin IHardware interface injected at init.

#include <stdint.h>

// ── Hardware abstraction (implemented in wristturn.ino) ──────────────────────

struct IHardware {
  virtual void     modeSleep()              = 0;
  virtual void     modeOn()                 = 0;
  virtual void     drainFifo(uint32_t msMax)= 0;  // drain events up to msMax ms
  // configureSensor: set report interval + wakeupEnabled on a SH-2 sensor.
  // intervalUs == 0 disables the sensor. wakeupEnabled=true → always-on domain.
  virtual bool     configureSensor(uint8_t sensorId, uint32_t intervalUs,
                                   bool wakeupEnabled)              = 0;
  virtual uint8_t  lastDrainedEventId()     = 0;  // event ID from most recent drain
  virtual bool     intPinLow()              = 0;   // digitalRead(INT) == LOW
  virtual uint32_t nowMs()                  = 0;
  virtual ~IHardware() = default;
};

// ── Base policy interface ────────────────────────────────────────────────────

struct ISleepPolicy {
  virtual void     arm(IHardware& hw)         = 0;
  virtual void     disarm(IHardware& hw)      = 0;
  // tick(): called every loop iteration while this policy is active.
  // Returns true when the device should fully wake.
  // hw is passed each call so policies stay stateless re: hardware ref.
  virtual bool     tick(IHardware& hw)        = 0;
  virtual uint32_t cycleMs()                  = 0;  // 0 = no periodic cycle
  virtual ~ISleepPolicy() = default;
};

// ── SH2 sensor IDs used by policies ─────────────────────────────────────────

static constexpr uint8_t  WAKE_SENSOR_SHAKE   = 0x19;
static constexpr uint8_t  WAKE_SENSOR_SIGMOTION = 0x12;
static constexpr uint32_t SHAKE_POLL_INTERVAL_US  = 10000UL;    // 10ms — must be << drainFifo window so event arrives before INT-HIGH early exit
static constexpr uint32_t SIGMOTION_INTERVAL_US   = 2000000UL;  // 2s

// ── Concrete policies ────────────────────────────────────────────────────────

// ShakeSleepPolicy — light sleep.
// Software timer: every cycleMs wake the BNO085, drain FIFO, look for 0x19.
// Configures shake with wakeupEnabled=false — no INT-pin dependency.
struct ShakeSleepPolicy : ISleepPolicy {
  uint32_t _cycleMs;
  uint32_t _cycleStartMs = 0;

  explicit ShakeSleepPolicy(uint32_t cycleMs = 30000)
    : _cycleMs(cycleMs) {}

  void arm(IHardware& hw) override {
    hw.configureSensor(WAKE_SENSOR_SHAKE, SHAKE_POLL_INTERVAL_US, false);
    hw.modeSleep();
    _cycleStartMs = hw.nowMs();
  }

  void disarm(IHardware& hw) override {
    hw.modeOn();
    hw.drainFifo(200);
  }

  bool tick(IHardware& hw) override {
    if (hw.nowMs() - _cycleStartMs < _cycleMs)
      return false;

    // Cycle expired: wake, drain, check for shake.
    hw.modeOn();
    hw.drainFifo(200);
    bool shook = (hw.lastDrainedEventId() == WAKE_SENSOR_SHAKE);
    if (shook)
      return true;

    // No shake — go back to sleep for the next cycle.
    hw.modeSleep();
    _cycleStartMs = hw.nowMs();
    return false;
  }

  uint32_t cycleMs() override { return _cycleMs; }
};

// SigMotionSleepPolicy — deep sleep.
// Arms SH2_SIGNIFICANT_MOTION with wakeupEnabled via always-on domain.
// INT pin asserts LOW on genuine significant motion. cycleMs == 0 (no poll).
struct SigMotionSleepPolicy : ISleepPolicy {
  void arm(IHardware& hw) override {
    hw.configureSensor(WAKE_SENSOR_SIGMOTION, SIGMOTION_INTERVAL_US, true);
    hw.modeSleep();
  }

  void disarm(IHardware& hw) override {
    hw.modeOn();
    hw.drainFifo(300);
    hw.configureSensor(WAKE_SENSOR_SIGMOTION, 0, false);  // disable sig-motion
  }

  bool tick(IHardware& hw) override {
    if (!hw.intPinLow()) return false;
    hw.modeOn();
    hw.drainFifo(300);
    return (hw.lastDrainedEventId() == WAKE_SENSOR_SIGMOTION);
  }

  uint32_t cycleMs() override { return 0; }
};

// ── Compositors ──────────────────────────────────────────────────────────────

// StagedPolicy — run stage[0] for durationMs, then advance to stage[1], etc.
// Last stage with durationMs==0 runs forever.
struct StagedPolicy : ISleepPolicy {
  struct Stage {
    ISleepPolicy* policy;
    uint32_t      durationMs;  // 0 = run forever (last stage)
  };

  static constexpr uint8_t MAX_STAGES = 4;
  Stage   stages[MAX_STAGES] = {};
  uint8_t stageCount   = 0;
  uint8_t currentStage = 0;
  uint32_t stageEnteredMs = 0;

  void addStage(ISleepPolicy* policy, uint32_t durationMs) {
    if (stageCount < MAX_STAGES)
      stages[stageCount++] = { policy, durationMs };
  }

  void arm(IHardware& hw) override {
    currentStage   = 0;
    stageEnteredMs = hw.nowMs();
    if (stageCount > 0) stages[0].policy->arm(hw);
  }

  void disarm(IHardware& hw) override {
    if (currentStage < stageCount)
      stages[currentStage].policy->disarm(hw);
  }

  bool tick(IHardware& hw) override {
    if (stageCount == 0) return false;

    Stage& s = stages[currentStage];

    // Check escalation: advance to next stage if duration elapsed.
    if (s.durationMs > 0 && (hw.nowMs() - stageEnteredMs) >= s.durationMs) {
      s.policy->disarm(hw);
      currentStage++;
      if (currentStage >= stageCount) currentStage = stageCount - 1;
      stageEnteredMs = hw.nowMs();
      stages[currentStage].policy->arm(hw);
      return false;
    }

    return stages[currentStage].policy->tick(hw);
  }

  uint32_t cycleMs() override {
    if (stageCount == 0) return 0;
    return stages[currentStage].policy->cycleMs();
  }
};

// FirstWakePolicy — arm all policies, wake if ANY fires (parallel OR).
// cycleMs() returns the shortest non-zero cycle among all members.
struct FirstWakePolicy : ISleepPolicy {
  static constexpr uint8_t MAX_POLICIES = 4;
  ISleepPolicy* policies[MAX_POLICIES] = {};
  uint8_t       count = 0;

  void add(ISleepPolicy* p) {
    if (count < MAX_POLICIES) policies[count++] = p;
  }

  void arm(IHardware& hw) override {
    for (uint8_t i = 0; i < count; i++) policies[i]->arm(hw);
  }

  void disarm(IHardware& hw) override {
    for (uint8_t i = 0; i < count; i++) policies[i]->disarm(hw);
  }

  bool tick(IHardware& hw) override {
    for (uint8_t i = 0; i < count; i++)
      if (policies[i]->tick(hw)) return true;
    return false;
  }

  uint32_t cycleMs() override {
    uint32_t fastest = 0;
    for (uint8_t i = 0; i < count; i++) {
      uint32_t c = policies[i]->cycleMs();
      if (c > 0 && (fastest == 0 || c < fastest)) fastest = c;
    }
    return fastest;
  }
};

// ── PowerManager ─────────────────────────────────────────────────────────────

struct PowerManager {
  ISleepPolicy* policy    = nullptr;
  bool          active    = false;

  void onInactivity(IHardware& hw) {
    if (active || !policy) return;
    active = true;
    policy->arm(hw);
  }

  // Returns true when the device should fully wake.
  bool tick(IHardware& hw) {
    if (!active || !policy) return false;
    bool wake = policy->tick(hw);
    if (wake) {
      policy->disarm(hw);
      active = false;
    }
    return wake;
  }

  void onWake(IHardware& hw) {
    if (!active) return;
    policy->disarm(hw);
    active = false;
  }
};
