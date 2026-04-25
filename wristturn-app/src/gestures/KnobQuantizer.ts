export interface KnobTick {
  axis: "roll" | "pitch" | "yaw";
  direction: 1 | -1;
}

export interface KnobQuantizerConfig {
  tickSizeDeg?:    number; // default 10
  hysteresisDeg?:  number; // default 2
  minVelocityDps?: number; // default 15 — filters drift
}

// Per-axis Schmitt trigger state
type SchmittState = "neutral" | "above" | "below";

export class KnobQuantizer {
  private readonly tickSize:    number;
  private readonly hysteresis:  number;
  private readonly minVelocity: number;

  // Accumulated delta per axis (in degrees, relative to last tick boundary)
  private acc: Record<"roll" | "pitch" | "yaw", number> = { roll: 0, pitch: 0, yaw: 0 };
  private schmitt: Record<"roll" | "pitch" | "yaw", SchmittState> = {
    roll: "neutral", pitch: "neutral", yaw: "neutral",
  };

  private lastDelta: Record<"roll" | "pitch" | "yaw", number> = { roll: 0, pitch: 0, yaw: 0 };
  private lastTs = 0;

  private onTick: (tick: KnobTick) => void;

  constructor(onTick: (tick: KnobTick) => void, config: KnobQuantizerConfig = {}) {
    this.tickSize    = config.tickSizeDeg    ?? 10;
    this.hysteresis  = config.hysteresisDeg  ?? 2;
    this.minVelocity = config.minVelocityDps ?? 15;
    this.onTick = onTick;
  }

  /** Feed a delta-from-baseline sample (degrees). Call on each BLE delta notification. */
  onDelta(delta: { roll: number; pitch: number; yaw: number }, nowMs = Date.now()): void {
    const dt = this.lastTs ? (nowMs - this.lastTs) / 1000 : 0.02;
    this.lastTs = nowMs;

    this.processAxis("roll",  delta.roll,  dt);
    // pitch and yaw intentionally skipped in knob mode — roll is the dial axis
    // Enable below if configuring multi-axis knob in future
    // this.processAxis("pitch", delta.pitch, dt);
    // this.processAxis("yaw",   delta.yaw,   dt);
  }

  reset(): void {
    this.acc     = { roll: 0, pitch: 0, yaw: 0 };
    this.schmitt = { roll: "neutral", pitch: "neutral", yaw: "neutral" };
    this.lastDelta = { roll: 0, pitch: 0, yaw: 0 };
    this.lastTs = 0;
  }

  private processAxis(axis: "roll" | "pitch" | "yaw", deltaFromBase: number, dt: number): void {
    // Velocity filter — ignore slow drift
    const velocity = Math.abs(deltaFromBase - this.lastDelta[axis]) / dt;
    this.lastDelta[axis] = deltaFromBase;
    if (velocity < this.minVelocity && Math.abs(deltaFromBase) < this.tickSize * 0.8) return;

    const upper = this.tickSize + this.hysteresis;
    const lower = -(this.tickSize + this.hysteresis);
    const rearmUpper = this.hysteresis;
    const rearmLower = -this.hysteresis;

    const state = this.schmitt[axis];

    if (state === "neutral") {
      if (deltaFromBase >= upper) {
        this.schmitt[axis] = "above";
        this.acc[axis] = deltaFromBase - this.tickSize;
        this.onTick({ axis, direction: 1 });
      } else if (deltaFromBase <= lower) {
        this.schmitt[axis] = "below";
        this.acc[axis] = deltaFromBase + this.tickSize;
        this.onTick({ axis, direction: -1 });
      }
    } else if (state === "above") {
      if (deltaFromBase <= rearmUpper) {
        // Re-armed downward
        this.schmitt[axis] = "neutral";
        this.acc[axis] = deltaFromBase;
      } else if (deltaFromBase >= upper + this.tickSize) {
        // Another tick up
        this.acc[axis] = deltaFromBase - this.tickSize;
        this.onTick({ axis, direction: 1 });
      }
    } else if (state === "below") {
      if (deltaFromBase >= rearmLower) {
        // Re-armed upward
        this.schmitt[axis] = "neutral";
        this.acc[axis] = deltaFromBase;
      } else if (deltaFromBase <= lower - this.tickSize) {
        // Another tick down
        this.acc[axis] = deltaFromBase + this.tickSize;
        this.onTick({ axis, direction: -1 });
      }
    }
  }
}
