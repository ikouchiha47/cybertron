/**
 * SettleGate — distinguishes *intent* (arrived and chosen) from *transit*
 * (passing through) by requiring sustained low-velocity at the destination.
 *
 * Pure, deterministic, caller-driven (no internal timers). Caller feeds
 * per-sample gyro magnitude with a timestamp; gate returns true once the
 * magnitude has stayed below threshold continuously for `durationMs`.
 *
 * Reused across the system — see UNIFIED_GESTURE_DESIGN.md §"Where settle
 * gates apply across the system" for the full table of use sites.
 */

export interface SettleGateConfig {
  durationMs:  number;
  gyroMaxDps:  number;
  /** When true, log every feed() at 10 Hz — only enable in tests / debug. */
  debug?:      boolean;
  /** Tag for log lines (default "SG"). */
  tag?:        string;
}

export class SettleGate {
  private firstSettledAt: number | null = null;
  private readonly durationMs: number;
  private readonly gyroMaxDps: number;
  private readonly debug:      boolean;
  private readonly tag:        string;

  constructor(cfg: SettleGateConfig) {
    this.durationMs = cfg.durationMs;
    this.gyroMaxDps = cfg.gyroMaxDps;
    this.debug      = cfg.debug ?? false;
    this.tag        = cfg.tag   ?? "SG";
  }

  /**
   * Feed a per-sample gyro magnitude (dps).
   * Returns true once the gate is satisfied and remains so until reset() or
   * a sample exceeds threshold.
   */
  feed(gyroMag: number, nowMs: number): boolean {
    if (gyroMag > this.gyroMaxDps) {
      if (this.debug && this.firstSettledAt !== null) {
        console.log(`[${this.tag}] reset gyro=${gyroMag.toFixed(1)} > ${this.gyroMaxDps}`);
      }
      this.firstSettledAt = null;
      return false;
    }

    if (this.firstSettledAt === null) {
      this.firstSettledAt = nowMs;
      if (this.debug) {
        console.log(`[${this.tag}] start gyro=${gyroMag.toFixed(1)} at t=${nowMs}`);
      }
    }

    const settledForMs = nowMs - this.firstSettledAt;
    const ok = settledForMs >= this.durationMs;
    if (this.debug) {
      console.log(`[${this.tag}] settledForMs=${settledForMs} ok=${ok}`);
    }
    return ok;
  }

  /** Reset the timer (motion happened, must re-accumulate stillness). */
  reset(): void {
    this.firstSettledAt = null;
  }

  /** True when the gate is currently accumulating (last feed was below threshold). */
  isAccumulating(): boolean {
    return this.firstSettledAt !== null;
  }
}
