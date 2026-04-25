export type InteractionMode = "gesture" | "knob" | "symbol";

const MODE_CYCLE: InteractionMode[] = ["gesture", "knob", "symbol"];

export interface ModeManagerCallbacks {
  onModeChange: (mode: InteractionMode) => void;
}

export class ModeManager {
  private mode: InteractionMode = "gesture";
  private readonly callbacks: ModeManagerCallbacks;

  constructor(callbacks: ModeManagerCallbacks) {
    this.callbacks = callbacks;
  }

  getMode(): InteractionMode { return this.mode; }

  /** Called when tap,tap,tap combo fires. Cycles to next mode. */
  cycleMode(): InteractionMode {
    const idx = MODE_CYCLE.indexOf(this.mode);
    this.mode = MODE_CYCLE[(idx + 1) % MODE_CYCLE.length];
    this.callbacks.onModeChange(this.mode);
    return this.mode;
  }

  /** Explicit set — used when device disconnects (reset to gesture). */
  setMode(mode: InteractionMode): void {
    if (this.mode === mode) return;
    this.mode = mode;
    this.callbacks.onModeChange(mode);
  }

  isGesture(): boolean { return this.mode === "gesture"; }
  isKnob():    boolean { return this.mode === "knob"; }
  isSymbol():  boolean { return this.mode === "symbol"; }
}
