import type { Baseline as BaselineType } from "../types";
export type { BaselineType as Baseline };

// ── Inline MotionState — no external dependency ────────────────────────────
export type MotionState = "uncalibrated" | "calibrating" | "stable" | "moving";

// ── Input events — what the machines consume ─────────────────────────────────
export type InputEvent =
  | { t: "connect";       address: string; name: string;           ts: number }
  | { t: "disconnect";    ts: number }
  | { t: "sleep";         ts: number }
  | { t: "pose";          roll: number; pitch: number; yaw: number; ts: number }
  | { t: "motion";        state: MotionState;                      ts: number }
  | { t: "gesture";       name: string;                            ts: number }
  | { t: "baseline_load"; baseline: BaselineType | null;              ts: number }
  | { t: "user_skip";     ts: number }        // CalibrationOverlay skip
  | { t: "lock_toggle";   locked: boolean;   ts: number }        // PIN lock change
  | { t: "app_state";     active: boolean;    ts: number }        // App foreground/background
  | { t: "mode_change";   mode: "gesture" | "knob" | "symbol";   ts: number }
  | { t: "internal_timer"; label: string;    ts: number };        // Fired by machine on elapsed-time check

// ── Output events — what the machines emit ──────────────────────────────────
export type OutputEvent =
  | { t: "state_change";     from: string; to: string;           ts: number }
  | { t: "arm_device";       ts: number }
  | { t: "disarm_device";    ts: number }
  | { t: "start_calibration";ts: number }
  | { t: "save_baseline";    baseline: BaselineType;                ts: number }
  | { t: "send_baseline";    baseline: BaselineType;                ts: number }
  | { t: "navigate_back";    reason: string;                    ts: number };

// ── DiscStateMachine snapshot ───────────────────────────────────────────────
export type DiscState = "idle" | "calibrating" | "wait_awake" | "ready" | "browsing" | "tracking";

export interface DiscSnapshot {
  discState: DiscState;
  connected: boolean;
  hasBaseline: boolean;
  baselineReady: boolean;
  armState: "armed" | "disarmed";
}

// ── ActiveControlMachine snapshot ──────────────────────────────────────────
export type ACState = "active" | "session_calibrating" | "exiting";

export interface ACSnapshot {
  acState: ACState;
  connected: boolean;
  hasSessionBaseline: boolean;
  armBelowTimerActive: boolean;
  locked: boolean;
}
