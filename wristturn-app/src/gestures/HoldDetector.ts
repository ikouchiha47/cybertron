/**
 * HoldDetector — position-domain gesture FSM.
 *
 * Detects sustained deflections past a fire threshold, distinguishes intent
 * from transit via a velocity-settled gate, and supports cruise-lock via
 * double-deflection. Tokens emitted match the velocity detector's vocabulary
 * (`turn_right`, `turn_left`, `pitch_up`, `pitch_down`, `yaw_right`,
 * `yaw_left`).
 *
 * Per axis-direction the FSM is:
 *
 *   NEUTRAL → ENGAGED   (cross threshold + recent transit + settled gyro)
 *   ENGAGED → REPEATING (held past REPEAT_START_DELAY_MS)
 *   ENGAGED → COOLDOWN  (released before repeat starts)
 *   REPEATING → COOLDOWN (released)
 *   REPEATING → LOCKED_SETTLING (second deflection within LOCK_WINDOW_MS)
 *   LOCKED_SETTLING → LOCKED_ARMED (gyro settled for SETTLE_DURATION_MS)
 *   LOCKED_ARMED → exit (opposite-direction deflection past lock_baseline−12°)
 *
 * Universal exits (apply from ANY state, no fire from FSM):
 *   shake, armPose=hanging, grav-pose change, BLE disconnect, LOCKED_MAX_MS.
 *
 * See docs/UNIFIED_GESTURE_DESIGN.md for full spec.
 */

import { SettleGate } from "./SettleGate";
import type { PoseSample, PoseDelta } from "./PoseSample";

// ── Tunables (UNIFIED_GESTURE_DESIGN.md §"All thresholds and timing constants")

export interface HoldDetectorConfig {
  fireThresholdDeg:    number;
  rearmThresholdDeg:   number;
  gyroSettledDps:      number;
  settleDwellMs:       number;
  repeatStartDelayMs:  number;
  repeatIntervalMs:    number;
  cooldownMs:          number;
  lockWindowMs:        number;
  settleDurationMs:    number;
  lockedMaxMs:         number;
  /** How recent a gyro spike must be to count as a transit toward threshold. */
  transitWindowMs:     number;
  /** Gyro magnitude above which a sample counts as a transit event. */
  transitGyroDps:      number;
  debug?: boolean;
}

export const DEFAULT_HOLD_CONFIG: HoldDetectorConfig = {
  fireThresholdDeg:    12,
  rearmThresholdDeg:    2,
  gyroSettledDps:       5,
  settleDwellMs:      150,
  repeatStartDelayMs: 400,
  repeatIntervalMs:   200,
  cooldownMs:        1000,
  lockWindowMs:      1500,
  settleDurationMs: 1000,
  lockedMaxMs:    300000,
  transitWindowMs:    500,
  transitGyroDps:      30,
  debug: false,
};

// ── Slot state ────────────────────────────────────────────────────────────────

export type Axis = "roll" | "pitch" | "yaw";
export type Dir  = "+" | "-";

export type HoldState =
  | "neutral"
  | "engaged"
  | "repeating"
  | "cooldown"
  | "locked_settling"
  | "locked_armed";

const TOKEN: Record<Axis, Record<Dir, string>> = {
  roll:  { "+": "turn_right",  "-": "turn_left"  },
  pitch: { "+": "pitch_up",    "-": "pitch_down" },
  yaw:   { "+": "yaw_right",   "-": "yaw_left"   },
};

interface Slot {
  axis:            Axis;
  dir:             Dir;
  state:           HoldState;
  enteredStateAt:  number;
  lastFireAt:      number;
  cooldownEndsAt:  number;
  lockWindowEndsAt: number;
  lockBaseline:    number;
  lockedAt:        number;
  settleGate:      SettleGate;   // for ENGAGED entry (settleDwellMs)
  lockSettleGate:  SettleGate;   // for LOCKED_SETTLING → LOCKED_ARMED (settleDurationMs)
  /** Last time gyro magnitude exceeded transitGyroDps (recent transit memory). */
  lastTransitAt:   number;
}

// ── Detector ──────────────────────────────────────────────────────────────────

export interface HoldDetectorCallbacks {
  onFire:         (token: string) => void;
  onStateChange?: (axis: Axis, dir: Dir, state: HoldState) => void;
}

export class HoldDetector {
  private readonly cfg:  HoldDetectorConfig;
  private readonly cbs:  HoldDetectorCallbacks;
  private readonly slots: Slot[];
  /** Last sample fed; used by tick() to drive auto-repeat without new samples. */
  private lastSample: PoseSample | null = null;

  constructor(cbs: HoldDetectorCallbacks, cfg?: Partial<HoldDetectorConfig>) {
    this.cbs = cbs;
    this.cfg = { ...DEFAULT_HOLD_CONFIG, ...(cfg ?? {}) };
    this.slots = [];
    for (const axis of ["roll", "pitch", "yaw"] as const) {
      for (const dir of ["+", "-"] as const) {
        this.slots.push(this.makeSlot(axis, dir));
      }
    }
  }

  /** Feed a per-sample PoseSample. Drives the FSM forward across all six slots. */
  onSample(s: PoseSample): void {
    this.lastSample = s;
    for (const slot of this.slots) this.stepSlot(slot, s);
  }

  /**
   * Time-based tick. Drives auto-repeat fires and cooldown/lock-window expiry
   * even when no new samples arrive. Caller should invoke at ≥10 Hz.
   */
  tick(nowMs: number): void {
    if (!this.lastSample) return;
    // Replay the last sample at `nowMs` so timed transitions advance.
    const synthetic: PoseSample = { ...this.lastSample, nowMs };
    for (const slot of this.slots) this.stepSlot(slot, synthetic);
  }

  /** Universal exit: shake event. All slots → NEUTRAL, no fire. */
  onShake(): void {
    for (const slot of this.slots) this.resetSlot(slot);
  }

  /** Universal exit: arm-pose transition. */
  onArmPoseChange(_prev: string, next: string): void {
    if (next === "hanging") {
      for (const slot of this.slots) this.resetSlot(slot);
    }
  }

  /** Universal exit: grav-pose transition (raised↔flat etc.). */
  onGravPoseChange(): void {
    for (const slot of this.slots) this.resetSlot(slot);
  }

  /** Hard reset (BLE disconnect). */
  reset(): void {
    for (const slot of this.slots) this.resetSlot(slot);
  }

  // ── Internals ──────────────────────────────────────────────────────────────

  private makeSlot(axis: Axis, dir: Dir): Slot {
    return {
      axis,
      dir,
      state:           "neutral",
      enteredStateAt:  0,
      lastFireAt:      0,
      cooldownEndsAt:  0,
      lockWindowEndsAt: 0,
      lockBaseline:    0,
      lockedAt:        0,
      settleGate:      new SettleGate({ durationMs: this.cfg.settleDwellMs,    gyroMaxDps: this.cfg.gyroSettledDps }),
      lockSettleGate:  new SettleGate({ durationMs: this.cfg.settleDurationMs, gyroMaxDps: this.cfg.gyroSettledDps }),
      lastTransitAt:   -Infinity,
    };
  }

  private axisDelta(slot: Slot, delta: PoseDelta): number {
    const v = slot.axis === "roll" ? delta.roll : slot.axis === "pitch" ? delta.pitch : delta.yaw;
    return slot.dir === "+" ? v : -v;
  }

  private stepSlot(slot: Slot, s: PoseSample): void {
    const signedDelta = this.axisDelta(slot, s.delta);
    const above = signedDelta >= this.cfg.fireThresholdDeg;
    const below = signedDelta <= this.cfg.rearmThresholdDeg;

    // Track recent transit (gyro spike). Required for fresh ENGAGED entry —
    // pure drift past threshold without a transit must NOT fire.
    if (s.gyroMagDps >= this.cfg.transitGyroDps) {
      slot.lastTransitAt = s.nowMs;
    }
    const hadRecentTransit = (s.nowMs - slot.lastTransitAt) <= this.cfg.transitWindowMs;

    // Settle gates feed every sample they care about.
    const settled    = slot.settleGate.feed(s.gyroMagDps, s.nowMs);
    const lockSettled = slot.lockSettleGate.feed(s.gyroMagDps, s.nowMs);

    switch (slot.state) {
      case "neutral":
        if (above && hadRecentTransit && settled) {
          this.fire(slot, s.nowMs, "neutral→engaged");
          this.transition(slot, "engaged", s.nowMs);
        }
        return;

      case "engaged":
        if (!above) {
          this.transition(slot, "cooldown", s.nowMs);
          slot.cooldownEndsAt = s.nowMs + this.cfg.cooldownMs;
          return;
        }
        if (s.nowMs - slot.lastFireAt >= this.cfg.repeatStartDelayMs) {
          this.transition(slot, "repeating", s.nowMs);
          // Don't double-fire here; tick handles next repeat at REPEAT_INTERVAL_MS.
          slot.lastFireAt = s.nowMs;  // anchor repeat cadence
        }
        return;

      case "repeating":
        if (!above) {
          this.transition(slot, "cooldown", s.nowMs);
          slot.cooldownEndsAt   = s.nowMs + this.cfg.cooldownMs;
          slot.lockWindowEndsAt = s.nowMs + this.cfg.lockWindowMs;
          return;
        }
        if (s.nowMs - slot.lastFireAt >= this.cfg.repeatIntervalMs) {
          this.fire(slot, s.nowMs, "repeating");
        }
        return;

      case "cooldown": {
        if (s.nowMs >= slot.cooldownEndsAt && below) {
          this.transition(slot, "neutral", s.nowMs);
          return;
        }
        // Within lock window: a fresh deflection past threshold fast-paths to LOCKED_SETTLING.
        if (
          above &&
          hadRecentTransit &&
          s.nowMs <= slot.lockWindowEndsAt
        ) {
          slot.lockedAt = s.nowMs;
          slot.lockSettleGate.reset();
          this.fire(slot, s.nowMs, "locked entry");
          this.transition(slot, "locked_settling", s.nowMs);
          return;
        }
        return;
      }

      case "locked_settling": {
        if (s.nowMs - slot.lastFireAt >= this.cfg.repeatIntervalMs) {
          this.fire(slot, s.nowMs, "locked_settling repeat");
        }
        if (lockSettled) {
          slot.lockBaseline = signedDelta * (slot.dir === "+" ? 1 : -1); // store signed roll delta in slot frame
          // Actually store the *signed-delta* (already in slot frame from axisDelta).
          slot.lockBaseline = signedDelta;
          this.transition(slot, "locked_armed", s.nowMs);
        }
        if (s.nowMs - slot.lockedAt >= this.cfg.lockedMaxMs) {
          this.resetSlot(slot);
        }
        return;
      }

      case "locked_armed": {
        if (s.nowMs - slot.lastFireAt >= this.cfg.repeatIntervalMs) {
          this.fire(slot, s.nowMs, "locked_armed repeat");
        }
        // Exit on opposite-direction motion: signedDelta − lock_baseline < −fireThreshold,
        // confirmed by 150ms gyro-settled (settleGate), per design doc:
        // "delta - lock_baseline < -12° + gyro settled 150 ms" → fires opposite token once.
        const relativeDelta = signedDelta - slot.lockBaseline;
        if (relativeDelta <= -this.cfg.fireThresholdDeg && settled) {
          // Fire opposite token once, then reset all slots' cooldown windows.
          const oppositeSlot = this.slots.find(
            (o) => o.axis === slot.axis && o.dir !== slot.dir,
          );
          if (oppositeSlot) {
            this.cbs.onFire(TOKEN[oppositeSlot.axis][oppositeSlot.dir]);
            oppositeSlot.lastFireAt = s.nowMs;
            oppositeSlot.cooldownEndsAt = s.nowMs + this.cfg.cooldownMs;
            this.transition(oppositeSlot, "cooldown", s.nowMs);
          }
          this.resetSlot(slot);
          return;
        }
        if (s.nowMs - slot.lockedAt >= this.cfg.lockedMaxMs) {
          this.resetSlot(slot);
        }
        return;
      }
    }
  }

  private fire(slot: Slot, nowMs: number, why: string): void {
    const tok = TOKEN[slot.axis][slot.dir];
    if (this.cfg.debug) {
      console.log(`[HD] fire ${tok} (${why}) at t=${nowMs}`);
    }
    this.cbs.onFire(tok);
    slot.lastFireAt = nowMs;
  }

  private transition(slot: Slot, next: HoldState, nowMs: number): void {
    if (slot.state === next) return;
    if (this.cfg.debug) {
      console.log(`[HD] ${slot.axis}${slot.dir} ${slot.state}→${next} at t=${nowMs}`);
    }
    slot.state = next;
    slot.enteredStateAt = nowMs;
    if (next === "neutral") {
      slot.settleGate.reset();
      slot.lockSettleGate.reset();
    }
    this.cbs.onStateChange?.(slot.axis, slot.dir, next);
  }

  private resetSlot(slot: Slot): void {
    slot.state = "neutral";
    slot.enteredStateAt = 0;
    slot.cooldownEndsAt = 0;
    slot.lockWindowEndsAt = 0;
    slot.lockBaseline = 0;
    slot.lockedAt = 0;
    slot.lastFireAt = 0;
    slot.lastTransitAt = -Infinity;
    slot.settleGate.reset();
    slot.lockSettleGate.reset();
  }
}
