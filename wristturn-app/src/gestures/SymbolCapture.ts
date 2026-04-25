import { PointCloudRecognizer } from "./recognizer/PointCloudRecognizer";
import { PRESET_SYMBOLS } from "./recognizer/presetTemplates";
import type { Point3D } from "./recognizer/PointCloudRecognizer";
import type { RawSample } from "../types";

export type CaptureState = "idle" | "capturing" | "classifying";

export interface SymbolResult {
  name: string;
  label: string;
  score: number;
  matched: boolean;
}

export interface SymbolCaptureCallbacks {
  onStateChange: (state: CaptureState) => void;
  onResult: (result: SymbolResult) => void;
  onCancelled: () => void;
}

const CAPTURE_TIMEOUT_MS = 3000;
const MIN_POINTS         = 8;

// Map symbol name → display label from presets
const LABEL_MAP: Record<string, string> = Object.fromEntries(
  PRESET_SYMBOLS.map(s => [s.name, s.label])
);

export class SymbolCapture {
  private state: CaptureState = "idle";
  private trajectory: Point3D[] = [];
  private readonly recognizer: PointCloudRecognizer;
  private readonly callbacks: SymbolCaptureCallbacks;
  private captureTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(callbacks: SymbolCaptureCallbacks) {
    this.callbacks = callbacks;
    this.recognizer = new PointCloudRecognizer();
    // Seed recognizer with all preset symbol variants
    for (const sym of PRESET_SYMBOLS) {
      for (const variant of sym.variants) {
        this.recognizer.addTemplate(sym.name, variant);
      }
    }
  }

  getState(): CaptureState { return this.state; }

  /** tap in symbol mode → start capture window. */
  startCapture(): void {
    if (this.state !== "idle") return;
    this.trajectory = [];
    this.state = "capturing";
    this.callbacks.onStateChange("capturing");
    this.captureTimer = setTimeout(() => this.finalize(), CAPTURE_TIMEOUT_MS);
  }

  /** Called on every raw Euler sample during capture. */
  onRaw(sample: RawSample): void {
    if (this.state !== "capturing") return;
    this.trajectory.push({ x: sample.roll, y: sample.pitch, z: sample.yaw });
  }

  /** pitch_down_hold → end capture and classify. */
  finalize(): void {
    if (this.state !== "capturing") return;
    this.clearTimer();
    this.state = "classifying";
    this.callbacks.onStateChange("classifying");

    if (this.trajectory.length < MIN_POINTS) {
      this.callbacks.onCancelled();
      this.reset();
      return;
    }

    const result = this.recognizer.recognize(this.trajectory);
    const label  = LABEL_MAP[result.name] ?? result.name;
    this.callbacks.onResult({ ...result, label });
    this.reset();
  }

  /** pitch_down (quick) → cancel without dispatch. */
  cancel(): void {
    if (this.state === "idle") return;
    this.clearTimer();
    this.callbacks.onCancelled();
    this.reset();
  }

  addTemplate(name: string, points: Point3D[]): void {
    this.recognizer.addTemplate(name, points);
  }

  private reset(): void {
    this.trajectory = [];
    this.state = "idle";
    this.callbacks.onStateChange("idle");
  }

  private clearTimer(): void {
    if (this.captureTimer !== null) {
      clearTimeout(this.captureTimer);
      this.captureTimer = null;
    }
  }
}
