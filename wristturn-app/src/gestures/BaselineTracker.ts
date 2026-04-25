import type { RawSample } from "../types";

function normalizeDeg(d: number): number {
  while (d > 180)  d -= 360;
  while (d < -180) d += 360;
  return d;
}

export class BaselineTracker {
  private baseline: RawSample | null = null;

  capture(current: RawSample): void {
    this.baseline = { ...current };
  }

  clear(): void {
    this.baseline = null;
  }

  isArmed(): boolean {
    return this.baseline !== null;
  }

  /** Signed delta from baseline, normalized to [-180, +180] per axis. */
  delta(current: RawSample): RawSample | null {
    if (!this.baseline) return null;
    return {
      roll:  normalizeDeg(current.roll  - this.baseline.roll),
      pitch: normalizeDeg(current.pitch - this.baseline.pitch),
      yaw:   normalizeDeg(current.yaw   - this.baseline.yaw),
    };
  }

  getBaseline(): RawSample | null {
    return this.baseline ? { ...this.baseline } : null;
  }
}
