import type { RawSample } from "../types";

const HOLD_DURATION_MS  = 800;
const HOLD_PITCH_WINDOW = 10; // degrees — pitch must stay within this of fire angle

type HoldCallback = (event: "pitch_down_hold") => void;

export class HoldDetector {
  private timer: ReturnType<typeof setTimeout> | null = null;
  private firePitch: number | null = null;
  private onHold: HoldCallback;

  constructor(onHold: HoldCallback) {
    this.onHold = onHold;
  }

  /** Call when pitch_down gesture fires. Starts the hold window. */
  onPitchDown(currentSample: RawSample): void {
    this.cancel();
    this.firePitch = currentSample.pitch;
    this.timer = setTimeout(() => {
      this.firePitch = null;
      this.timer = null;
      this.onHold("pitch_down_hold");
    }, HOLD_DURATION_MS);
  }

  /** Call on every raw Euler sample while detector is armed. */
  onRaw(sample: RawSample): void {
    if (this.firePitch === null || this.timer === null) return;
    const drift = Math.abs(sample.pitch - this.firePitch);
    if (drift > HOLD_PITCH_WINDOW) {
      // Pitch moved away — user didn't hold, cancel
      this.cancel();
    }
  }

  /** Call when any non-pitch-down gesture fires — cancels hold window. */
  onOtherGesture(): void {
    this.cancel();
  }

  cancel(): void {
    if (this.timer !== null) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    this.firePitch = null;
  }

  isArmed(): boolean {
    return this.timer !== null;
  }
}
