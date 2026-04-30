export type MotionState = "uncalibrated" | "calibrating" | "stable" | "moving";
export type MotionType  = "wrist_rotating" | "arm_moving";

export interface MotionClassifierCallbacks {
  onStateChange?: (state: MotionState) => void;
  onMotion?:      (type: MotionType)  => void;
}

export interface Delta {
  roll:  number;
  pitch: number;
  yaw:   number;
}

// BNO085 stability classifier levels (mirrors firmware StillnessDetector.h)
const STAB_MOTION     = 4;
const STAB_STABLE     = 3;
const STAB_STATIONARY = 2;
// STAB_ON_TABLE = 1 — device flat on surface, ignored during calibration

// How long arm must stay still (stab >= STATIONARY) before calibration completes.
const DWELL_MS = 1000;
// Fallback: if device is already on wrist at connect (stab never reaches MOTION),
// accept stab >= STATIONARY held for this long instead.
const DWELL_NO_MOTION_MS = 2000;

// Pitch/yaw change below this during roll motion = gravitational coupling noise
const BLEED_THRESHOLD_DEG = 2.0;
// Total delta magnitude below this = sensor noise / static drift, ignore
const MIN_MOVE_DEG        = 1.5;

type CalSubState = "wait_motion" | "settling" | "collecting";

function isCalibrationStill(stab: number): boolean {
  // Require at least STATIONARY — on_table (1) is ignored so a flat-lying device
  // doesn't accidentally complete calibration before the user raises their arm.
  return stab === STAB_STATIONARY || stab === STAB_STABLE;
}

function isStill(stab: number): boolean {
  // Post-calibration: any non-motion class counts as still (includes on_table).
  return stab >= 1 && stab < STAB_MOTION;
}

export class MotionClassifier {
  private state:      MotionState    = "uncalibrated";
  private calSub:     CalSubState    = "wait_motion";
  private collectStartMs: number     = 0;
  private sawMotion:  boolean        = false;
  private motionType: MotionType | null = null;
  private dwellTimer: ReturnType<typeof setTimeout> | null = null;
  private readonly cbs: MotionClassifierCallbacks;

  constructor(callbacks: MotionClassifierCallbacks = {}) {
    this.cbs = callbacks;
  }

  getState():      MotionState       { return this.state;      }
  getMotionType(): MotionType | null { return this.motionType; }

  /** Begin the connect-time calibration ceremony (arm held straight forward). */
  startCalibration(): void {
    this._clearDwellTimer();
    this.calSub       = "wait_motion";
    this.collectStartMs = 0;
    this.sawMotion    = false;
    this.transition("calibrating");
  }

  /**
   * Feed a BNO085 stability class event.
   *
   * While calibrating:
   *   wait_motion  → stab=4 (motion) fires         → settling   (arm picked up)
   *   settling     → stab>=2 (stationary/stable)   → collecting (arm settling)
   *   collecting   → stab=4 fires again             → settling   (arm moved, restart)
   *   collecting   → dwell elapsed with stab>=2     → stable     (done)
   *   fallback     → stab>=2 held for 2s (no prior motion seen) → stable
   *
   * While stable/moving: any still class → stable; motion class stays moving.
   */
  onStabilityClass(stab: number, nowMs?: number): void {
    const now = nowMs ?? Date.now();
    console.log(
      `[MC] stab=${stab} state=${this.state} calSub=${this.calSub}` +
      ` sawMotion=${this.sawMotion} collecting=${this.collectStartMs > 0}`
    );

    if (this.state === "calibrating") {
      this._handleCalibrating(stab, now);
      return;
    }

    // Post-calibration: motion=4 → moving; any still → back to stable
    if (this.state === "stable" || this.state === "moving") {
      if (stab === STAB_MOTION) {
        // intentionally not transitioning here — delta-based motion detection
        // drives moving state; stab=4 just confirms it
      } else if (isStill(stab) && this.state === "moving") {
        this.motionType = null;
        this.transition("stable");
      }
    }
  }

  /**
   * Feed a delta-from-baseline sample (degrees).
   * Ignored until STABLE; classifies each sample and emits onMotion.
   */
  onDelta(delta: Delta, _nowMs?: number): void {
    if (this.state !== "stable" && this.state !== "moving") return;

    const mag = Math.sqrt(delta.roll ** 2 + delta.pitch ** 2 + delta.yaw ** 2);
    if (mag < MIN_MOVE_DEG) return;

    const type = this.classify(delta);
    this.motionType = type;
    if (this.state === "stable") this.transition("moving");
    this.cbs.onMotion?.(type);
  }

  reset(): void {
    this._clearDwellTimer();
    this.state          = "uncalibrated";
    this.calSub         = "wait_motion";
    this.collectStartMs = 0;
    this.sawMotion      = false;
    this.motionType     = null;
  }

  private _handleCalibrating(stab: number, now: number): void {
    if (stab === STAB_MOTION) {
      // Arm moved again — cancel any in-progress dwell and restart
      this._clearDwellTimer();
      this.sawMotion      = true;
      this.calSub         = "settling";
      this.collectStartMs = 0;
      console.log("[MC] cal: saw motion → settling");
      return;
    }

    // After arm was moved (sawMotion), stab=1 (on_table) also counts as still
    // enough to collect a baseline — BNO085 reports on_table for flat wrist
    // orientation even when worn. Without motion seen, keep ignoring stab=1 so
    // a device resting on a desk doesn't accidentally self-calibrate.
    const stillEnough = isCalibrationStill(stab) || (this.sawMotion && stab === 1);
    if (!stillEnough) {
      return;
    }

    // stab is STATIONARY or STABLE
    if (this.calSub === "wait_motion" || this.calSub === "settling") {
      // Arm just settled — start the collection window and schedule auto-complete.
      // Firmware only sends stab events on class change, so we can't rely on a
      // future event to check elapsed time; the timer fires even if stab stays quiet.
      this.calSub         = "collecting";
      this.collectStartMs = now;
      const dwellNeeded = this.sawMotion ? DWELL_MS : DWELL_NO_MOTION_MS;
      console.log(`[MC] cal: settled → collecting (need ${dwellNeeded}ms, sawMotion=${this.sawMotion})`);
      this._scheduleDwell(dwellNeeded);
      return;
    }

    if (this.calSub === "collecting") {
      const dwellNeeded = this.sawMotion ? DWELL_MS : DWELL_NO_MOTION_MS;
      const elapsed     = now - this.collectStartMs;
      console.log(`[MC] cal: collecting ${elapsed}ms / ${dwellNeeded}ms`);
      if (elapsed >= dwellNeeded) {
        console.log("[MC] cal: dwell complete → stable");
        this._clearDwellTimer();
        this.motionType = null;
        this.transition("stable");
      }
    }
  }

  private _scheduleDwell(ms: number): void {
    this._clearDwellTimer();
    this.dwellTimer = setTimeout(() => {
      if (this.calSub === "collecting") {
        console.log("[MC] cal: dwell timer fired → stable");
        this.motionType = null;
        this.transition("stable");
      }
    }, ms);
  }

  private _clearDwellTimer(): void {
    if (this.dwellTimer !== null) {
      clearTimeout(this.dwellTimer);
      this.dwellTimer = null;
    }
  }

  private classify(delta: Delta): MotionType {
    // Pitch and yaw changes below BLEED_THRESHOLD are gravitational coupling during
    // wrist pronation/supination — treat as noise, classify as pure wrist rotation.
    if (Math.abs(delta.pitch) > BLEED_THRESHOLD_DEG ||
        Math.abs(delta.yaw)   > BLEED_THRESHOLD_DEG) {
      return "arm_moving";
    }
    return "wrist_rotating";
  }

  private transition(next: MotionState): void {
    if (this.state === next) return;
    this.state = next;
    this.cbs.onStateChange?.(next);
  }
}
