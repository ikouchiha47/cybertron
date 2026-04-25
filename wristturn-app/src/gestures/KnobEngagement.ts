import { BaselineTracker } from "./BaselineTracker";
import { KnobQuantizer, KnobQuantizerConfig } from "./KnobQuantizer";
import type { RawSample } from "../types";

export type KnobState = "idle" | "engaged";

export interface KnobEngagementCallbacks {
  onTick: (direction: 1 | -1) => void;
  onStateChange: (state: KnobState) => void;
}

const INACTIVITY_TIMEOUT_MS = 5000;

export class KnobEngagement {
  private state: KnobState = "idle";
  private readonly baseline = new BaselineTracker();
  private readonly quantizer: KnobQuantizer;
  private readonly callbacks: KnobEngagementCallbacks;
  private inactivityTimer: ReturnType<typeof setTimeout> | null = null;
  // ticks accumulated during this engagement window (for cancel/revert)
  private pendingTicks: Array<1 | -1> = [];

  constructor(callbacks: KnobEngagementCallbacks, config: KnobQuantizerConfig = {}) {
    this.callbacks = callbacks;
    this.quantizer = new KnobQuantizer((tick) => {
      if (this.state !== "engaged") return;
      this.pendingTicks.push(tick.direction);
      this.resetInactivity();
      callbacks.onTick(tick.direction);
    }, config);
  }

  getState(): KnobState { return this.state; }

  /** tap gesture in knob mode → engage. */
  engage(currentSample: RawSample): void {
    if (this.state === "engaged") return;
    this.baseline.capture(currentSample);
    this.quantizer.reset();
    this.pendingTicks = [];
    this.state = "engaged";
    this.resetInactivity();
    this.callbacks.onStateChange("engaged");
  }

  /** pitch_down_hold → commit (keep ticks). */
  commit(): void {
    this.exitEngagement("idle");
  }

  /** pitch_down (quick) → cancel (revert ticks by emitting inverse). */
  cancel(): void {
    // Emit inverse ticks to revert
    for (let i = this.pendingTicks.length - 1; i >= 0; i--) {
      this.callbacks.onTick(-this.pendingTicks[i] as 1 | -1);
    }
    this.exitEngagement("idle");
  }

  /** Feed raw Euler delta sample (already computed from baseline externally or pass raw). */
  onDelta(delta: RawSample): void {
    if (this.state !== "engaged") return;
    this.quantizer.onDelta(delta);
  }

  /** Call on mode change or device disconnect to clean up. */
  forceExit(): void {
    this.exitEngagement("idle");
  }

  private exitEngagement(next: KnobState): void {
    this.clearInactivity();
    this.baseline.clear();
    this.quantizer.reset();
    this.pendingTicks = [];
    if (this.state !== next) {
      this.state = next;
      this.callbacks.onStateChange(next);
    }
  }

  private resetInactivity(): void {
    this.clearInactivity();
    this.inactivityTimer = setTimeout(() => {
      if (this.state === "engaged") this.commit();
    }, INACTIVITY_TIMEOUT_MS);
  }

  private clearInactivity(): void {
    if (this.inactivityTimer !== null) {
      clearTimeout(this.inactivityTimer);
      this.inactivityTimer = null;
    }
  }
}
