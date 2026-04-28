import { Subject, BehaviorSubject, Observable } from "rxjs";
import type {
  InputEvent,
  OutputEvent,
  DiscState,
  DiscSnapshot,
  Baseline,
  MotionState,
} from "./events";

/**
 * DiscStateMachine — pure FSM for DiscoveryScreen (E1–E8).
 *
 * Inputs:  connect, disconnect, sleep, pose, motion, gesture,
 *          baseline_load, user_skip, lock_toggle, app_state, mode_change
 * Outputs: arm_device, disarm_device, start_calibration, save_baseline,
 *          send_baseline, navigate_back, state_change
 *
 * Design principles:
 *   - NO setTimeout — all timing uses elapsed-time checks via clock()
 *   - NO BaselineService — screens load baseline and feed baseline_load events
 *   - NO React/ble/hardware imports
 */

export interface DiscStateMachineConfig {
  clock: () => number;
}

// Thresholds (mirroring DiscoveryScreen constants)
const BASELINE_TOL = 5;               // degrees — "above baseline" check
const BELOW_BASELINE_EXIT_MS = 3000;  // 3s arm below → exit browse to ready
const READY_TO_BROWSE_MS = 1000;      // 1s held in ready → auto browse

export class DiscStateMachine {
  readonly inputs$ = new Subject<InputEvent>();
  readonly outputs$ = new Observable<OutputEvent>((observer) => {
    this.outputObserver = observer;
    return () => { this.outputObserver = null; };
  });

  private clock: () => number;
  private outputObserver: { next: (v: OutputEvent) => void } | null = null;

  // ── Machine state (MUST be before state$ initialization) ───────────────
  private _discState: DiscState = "idle";
  private _connected = false;
  private _hasBaseline = false;
  private _baselineReady = false;
  private _armState: "armed" | "disarmed" = "disarmed";
  private _wristAddress?: string;
  private _storedBaseline: Baseline | null = null;

  // ── Timer tracking (elapsed-time, NO setTimeout) ───────────────────────
  private _readyTimerStart: number | null = null;
  private _armBelowTimerStart: number | null = null;

  // ── Runtime caches ─────────────────────────────────────────────────────
  private _latestPose: { roll: number; pitch: number; yaw: number } | null = null;
  private _lastMotionState: MotionState | null = null;

  readonly state$ = new BehaviorSubject<DiscSnapshot>(this.snapshot());

  constructor(cfg: DiscStateMachineConfig) {
    this.clock = cfg.clock;
    this.inputs$.subscribe((ev: InputEvent) => this.handle(ev));
  }

  // ── Public: current snapshot ───────────────────────────────────────────
  snapshot(): DiscSnapshot {
    return {
      discState: this._discState,
      connected: this._connected,
      hasBaseline: this._hasBaseline,
      baselineReady: this._baselineReady,
      armState: this._armState,
    };
  }

  // ── Timer checks — called on every event ───────────────────────────────
  private checkTimers(now: number): void {
    // ready → browse auto-timer
    if (this._readyTimerStart !== null && this._discState === "ready") {
      if (now - this._readyTimerStart >= READY_TO_BROWSE_MS) {
        this._readyTimerStart = null;
        this.emitStateChange("browsing");
      }
    }
    // browsing → ready (arm below) exit timer
    if (this._armBelowTimerStart !== null && this._discState === "browsing") {
      if (now - this._armBelowTimerStart >= BELOW_BASELINE_EXIT_MS) {
        this._armBelowTimerStart = null;
        this.emitStateChange("ready");
      }
    }
  }

  // ── Side-effect emitters ───────────────────────────────────────────────
  private emitArm(armed: boolean): void {
    this._armState = armed ? "armed" : "disarmed";
    this.outputObserver?.next({ t: armed ? "arm_device" : "disarm_device", ts: this.clock() });
    this.publish();
  }

  private emitStateChange(to: DiscState): void {
    const from = this._discState;
    this._discState = to;
    this.outputObserver?.next({ t: "state_change", from, to, ts: this.clock() });
    this.publish();
  }

  private emitStartCal(): void {
    this.outputObserver?.next({ t: "start_calibration", ts: this.clock() });
  }

  private emitSaveAndSend(b: Baseline): void {
    this.outputObserver?.next({ t: "save_baseline", baseline: b, ts: this.clock() });
    this.outputObserver?.next({ t: "send_baseline", baseline: b, ts: this.clock() });
  }

  private emitNavigateBack(reason: string): void {
    this.outputObserver?.next({ t: "navigate_back", reason, ts: this.clock() });
  }

  private publish(): void {
    this.state$.next(this.snapshot());
  }

  // ── Input dispatcher ───────────────────────────────────────────────────
  private handle(ev: InputEvent): void {
    // Check elapsed timers on every input event
    this.checkTimers(ev.ts);

    switch (ev.t) {
      case "connect":           this.onConnect(ev); break;
      case "disconnect":        this.onDisconnect(); break;
      case "sleep":             this.onSleep(); break;
      case "pose":              this.onPose(ev); break;
      case "motion":            this.onMotion(ev); break;
      case "gesture":           this.onGesture(ev); break;
      case "baseline_load":     this.onBaselineLoad(ev); break;
      case "user_skip":         this.onUserSkip(); break;
      // No-op in Discovery: lock_toggle, app_state, mode_change, internal_timer
    }
  }

  private onConnect(ev: Extract<InputEvent, { t: "connect" }>): void {
    this._connected = true;
    this._wristAddress = ev.address;
    this._hasBaseline = false;
    this._baselineReady = false;
    this._storedBaseline = null;
    this._discState = "idle";
    this._armState = "disarmed";
    this._latestPose = null;
    this._lastMotionState = null;
    this._readyTimerStart = null;
    this._armBelowTimerStart = null;
    // NO async load — screen adapter emits baseline_load event
    this.publish();
  }

  private onDisconnect(): void {
    this._connected = false;
    this._wristAddress = undefined;
    this._hasBaseline = false;
    this._baselineReady = false;
    this._storedBaseline = null;
    this._discState = "idle";
    this._armState = "disarmed";
    this._latestPose = null;
    this._lastMotionState = null;
    this._readyTimerStart = null;
    this._armBelowTimerStart = null;
    this.publish();
  }

  private onSleep(): void {
    if (this._discState !== "idle") {
      this.emitArm(false);
      this.emitStateChange("idle");
    }
  }

  private onBaselineLoad(ev: Extract<InputEvent, { t: "baseline_load" }>): void {
    if (!this._connected) return;

    this._storedBaseline = ev.baseline;
    this._hasBaseline = ev.baseline !== null;

    if (ev.baseline) {
      this._baselineReady = true;
      this.emitStateChange("wait_awake");
      this.emitArm(true);
      this.outputObserver?.next({ t: "send_baseline", baseline: ev.baseline, ts: this.clock() });
    } else {
      this.emitStateChange("calibrating");
      this.emitStartCal();
      this.emitArm(true); // calibration needs pose streaming
    }
    this.publish();
  }

  private onPose(ev: Extract<InputEvent, { t: "pose" }>): void {
    this._latestPose = { roll: ev.roll, pitch: ev.pitch, yaw: ev.yaw };

    if (this._discState === "calibrating") {
      // Motion may arrive before or after pose. If motion is already stable,
      // complete calibration now. Otherwise wait for motion event.
      if (this._lastMotionState === "stable") {
        this.completeCalibration(ev.roll, ev.pitch, ev.yaw, ev.ts);
      }
    } else if (this._discState === "wait_awake") {
      if (!this._storedBaseline) return;
      const above = ev.pitch >= this._storedBaseline.pitch - BASELINE_TOL;
      if (above) {
        this.emitStateChange("ready");
        this._readyTimerStart = ev.ts;
      }
      // else: stay in wait_awake, user hasn't raised arm yet
    } else if (this._discState === "browsing") {
      if (!this._storedBaseline) return;
      const below = ev.pitch < this._storedBaseline.pitch - BASELINE_TOL;
      if (below) {
        if (this._armBelowTimerStart === null) {
          this._armBelowTimerStart = ev.ts;
        }
      } else {
        this._armBelowTimerStart = null;
      }
    }
  }

  private onMotion(ev: Extract<InputEvent, { t: "motion" }>): void {
    this._lastMotionState = ev.state;

    // If calibrating and motion becomes stable, we need the latest pose.
    if (this._discState === "calibrating" && ev.state === "stable" && this._latestPose) {
      this.completeCalibration(
        this._latestPose.roll,
        this._latestPose.pitch,
        this._latestPose.yaw,
        ev.ts,
      );
    }
  }

  private completeCalibration(roll: number, pitch: number, yaw: number, ts: number): void {
    const baseline: Baseline = {
      roll, pitch, yaw,
      timestamp: ts,
      wristName: "",
      wristAddress: this._wristAddress ?? "",
    };
    this._storedBaseline = baseline;
    this.emitSaveAndSend(baseline);
    this._baselineReady = true;
    this.emitStateChange("wait_awake");
    this.emitArm(true);
  }

  private onGesture(ev: Extract<InputEvent, { t: "gesture" }>): void {
    switch (this._discState) {
      case "calibrating":
        if (ev.name === "shake") {
          this.emitArm(false);
          this.emitStateChange("idle");
        }
        break;
      case "ready":
        if (ev.name === "tap") {
          this._readyTimerStart = null;
          this.emitStateChange("browsing");
        }
        break;
      case "browsing":
        if (ev.name === "turn_right" || ev.name === "turn_left") {
          // no state change; UI cycles device
        } else if (ev.name === "pitch_down") {
          this.emitStateChange("tracking");
        } else if (ev.name === "shake") {
          this._armBelowTimerStart = null;
          this.emitStateChange("ready");
        }
        break;
      case "tracking":
        if (ev.name === "shake") {
          this.emitNavigateBack("tracking shake");
        }
        break;
      // idle, wait_awake ignore gestures
    }
    this.publish();
  }

  private onUserSkip(): void {
    if (this._discState === "calibrating") {
      this.emitArm(false);
      this.emitStateChange("idle");
    }
  }

  // ── Cleanup ────────────────────────────────────────────────────────────
  destroy(): void {
    this.inputs$.complete();
    this.outputObserver = null;
  }
}
