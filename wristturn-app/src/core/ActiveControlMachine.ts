import { Subject, BehaviorSubject, Observable } from "rxjs";
import type {
  InputEvent,
  OutputEvent,
  ACSnapshot,
  Baseline,
  MotionState,
} from "./events";

/**
 * ActiveControlMachine — pure FSM for ActiveControlScreen.
 *
 * Handles:
 *   - Session calibration (knob mode only)
 *   - Arm-below-30s timeout with locked + appActive gates
 *   - Shake-to-exit (navigate_back)
 *   - Mode change during session
 *
 * Design principles:
 *   - NO setTimeout — elapsed-time checks via clock()
 *   - NO BaselineService — screen handles persistence
 *   - NO React/ble/hardware imports
 */

export interface ActiveControlMachineConfig {
  clock: () => number;
  homeBaseline: Baseline | null;
  initialMode: "gesture" | "knob" | "symbol";
}

const BASELINE_TOL = 20;              // degrees — pitch tolerance for arm-below check
const ARM_BELOW_TIMEOUT_MS = 30_000;  // 30s arm below baseline before auto-exit

export class ActiveControlMachine {
  readonly inputs$ = new Subject<InputEvent>();
  readonly outputs$ = new Observable<OutputEvent>((observer) => {
    this.outputObserver = observer;
    return () => { this.outputObserver = null; };
  });

  private clock: () => number;
  private outputObserver: { next: (v: OutputEvent) => void } | null = null;

  // ── Machine state (MUST be before state$ initialization) ───────────────
  private _acState: "active" | "session_calibrating" | "exiting" = "active";
  private _connected = false;
  private _hasSessionBaseline = false;
  private _sessionBaseline: Baseline | null = null;
  private _armBelowTimerActive = false;

  // ── Observable (initialized in constructor after all state is set up) ──
  readonly state$: BehaviorSubject<ACSnapshot>;
  private _locked = false;
  private _appActive = true;

  // ── Timer tracking (elapsed-time, NO setTimeout) ───────────────────────
  private _armBelowSince: number | null = null;

  // ── Runtime caches ─────────────────────────────────────────────────────
  private _latestPose: { roll: number; pitch: number; yaw: number } | null = null;
  private _lastMotionState: MotionState | null = null;
  private _currentMode: "gesture" | "knob" | "symbol";
  private _calibrationStarted = false; // prevent duplicate start

  constructor(cfg: ActiveControlMachineConfig) {
    this.clock = cfg.clock;
    this._currentMode = cfg.initialMode;

    // Initialize sessionBaseline based on initial mode
    if (cfg.initialMode === "gesture" || cfg.initialMode === "symbol") {
      this._sessionBaseline = cfg.homeBaseline;
      this._hasSessionBaseline = cfg.homeBaseline !== null;
    }
    // knob mode: no session baseline yet; will trigger calibration

    // Initialize state$ AFTER all fields are set up so the initial emission
    // reflects the correct state.
    this.state$ = new BehaviorSubject<ACSnapshot>(this.snapshot());

    this.inputs$.subscribe((ev: InputEvent) => this.handle(ev));

    // If knob mode on mount, trigger calibration immediately
    if (cfg.initialMode === "knob") {
      this.startSessionCalibration();
    }
  }

  snapshot(): ACSnapshot {
    return {
      acState: this._acState,
      connected: this._connected,
      hasSessionBaseline: this._hasSessionBaseline,
      armBelowTimerActive: this._armBelowTimerActive,
      locked: this._locked,
    };
  }

  // ── Session calibration trigger ────────────────────────────────────────
  private startSessionCalibration(): void {
    if (this._calibrationStarted || this._hasSessionBaseline) return;
    this._calibrationStarted = true;
    this._acState = "session_calibrating";
    this.outputObserver?.next({ t: "start_calibration", ts: this.clock() });
    this.publish();
  }

  // ── Side-effect emitters ───────────────────────────────────────────────
  private emitSaveAndSend(b: Baseline): void {
    this.outputObserver?.next({ t: "save_baseline", baseline: b, ts: this.clock() });
    this.outputObserver?.next({ t: "send_baseline", baseline: b, ts: this.clock() });
  }

  private emitNavigateBack(reason: string): void {
    this.outputObserver?.next({ t: "navigate_back", reason, ts: this.clock() });
    this._acState = "exiting";
    this.publish();
  }

  private publish(): void {
    this.state$.next(this.snapshot());
  }

  // ── Input dispatcher ───────────────────────────────────────────────────
  private handle(ev: InputEvent): void {
    // Check arm-below timer on every event
    this.checkArmBelowTimer(ev.ts);

    switch (ev.t) {
      case "connect":           this.onConnect(ev); break;
      case "disconnect":        this.onDisconnect(); break;
      case "pose":              this.onPose(ev); break;
      case "motion":            this.onMotion(ev); break;
      case "mode_change":       this.onModeChange(ev); break;
      case "gesture":           this.onGesture(ev); break;
      case "user_skip":         this.onUserSkip(); break;
      case "lock_toggle":       this.onLockToggle(ev); break;
      case "app_state":         this.onAppState(ev); break;
      // No-op: baseline_load (discovery handles it), internal_timer
    }
  }

  // ── Timer check (elapsed-time, NO setTimeout) ──────────────────────────
  private checkArmBelowTimer(now: number): void {
    if (this._armBelowSince === null) return;
    if (this._acState !== "active") return;
    if (this._locked) return;
    if (!this._appActive) return;

    if (now - this._armBelowSince >= ARM_BELOW_TIMEOUT_MS) {
      this._armBelowSince = null;
      this._armBelowTimerActive = false;
      this.emitNavigateBack("arm-below timeout");
    }
  }

  // ── Event handlers ─────────────────────────────────────────────────────
  private onConnect(_ev: Extract<InputEvent, { t: "connect" }>): void {
    this._connected = true;
    this.publish();
  }

  private onDisconnect(): void {
    this._connected = false;
    this._latestPose = null;
    this._lastMotionState = null;
    this._armBelowSince = null;
    this._armBelowTimerActive = false;
    if (this._acState === "session_calibrating") {
      this._acState = "active";
      this._calibrationStarted = false;
    }
    this.publish();
  }

  private onPose(ev: Extract<InputEvent, { t: "pose" }>): void {
    this._latestPose = { roll: ev.roll, pitch: ev.pitch, yaw: ev.yaw };

    // Session calibration completion
    if (this._acState === "session_calibrating") {
      if (this._lastMotionState === "stable") {
        this.completeSessionCalibration(ev.roll, ev.pitch, ev.yaw, ev.ts);
      }
    }
    // Arm-below monitoring
    else if (this._acState === "active" && this._hasSessionBaseline && this._sessionBaseline) {
      const below = ev.pitch < this._sessionBaseline.pitch - BASELINE_TOL;
      if (below) {
        if (this._armBelowSince === null) {
          this._armBelowSince = ev.ts;
          this._armBelowTimerActive = true;
          this.publish();
        }
      } else {
        this._armBelowSince = null;
        if (this._armBelowTimerActive) {
          this._armBelowTimerActive = false;
          this.publish();
        }
      }
    }
  }

  private onMotion(ev: Extract<InputEvent, { t: "motion" }>): void {
    this._lastMotionState = ev.state;

    // If session calibrating and motion becomes stable, capture baseline
    if (this._acState === "session_calibrating" && ev.state === "stable" && this._latestPose) {
      this.completeSessionCalibration(
        this._latestPose.roll,
        this._latestPose.pitch,
        this._latestPose.yaw,
        ev.ts,
      );
    }
  }

  private completeSessionCalibration(roll: number, pitch: number, yaw: number, ts: number): void {
    const baseline: Baseline = {
      roll, pitch, yaw,
      timestamp: ts,
      wristName: "",
      wristAddress: "",
    };
    this._sessionBaseline = baseline;
    this._hasSessionBaseline = true;
    this.emitSaveAndSend(baseline);
    this._acState = "active";
    this.publish();
  }

  private onModeChange(ev: Extract<InputEvent, { t: "mode_change" }>): void {
    const newMode = ev.mode;
    this._currentMode = newMode;

    if (newMode === "knob" && !this._hasSessionBaseline) {
      this.startSessionCalibration();
    } else if (newMode === "gesture") {
      this._acState = "active";
      this._hasSessionBaseline = this._sessionBaseline !== null;
    } else if (newMode === "symbol") {
      this._acState = "active";
      this._hasSessionBaseline = true;
    }
    this.publish();
  }

  private onGesture(ev: Extract<InputEvent, { t: "gesture" }>): void {
    if (ev.name === "shake" && this._acState === "active") {
      this.emitNavigateBack("shake");
    }
  }

  private onUserSkip(): void {
    if (this._acState === "session_calibrating") {
      this._acState = "active";
      this._calibrationStarted = true; // mark as attempted; don't retrigger
      this.publish();
    }
  }

  private onLockToggle(ev: Extract<InputEvent, { t: "lock_toggle" }>): void {
    this._locked = ev.locked;
    if (this._locked && this._armBelowTimerActive) {
      this._armBelowSince = null;
      this._armBelowTimerActive = false;
      this.publish();
    }
  }

  private onAppState(ev: Extract<InputEvent, { t: "app_state" }>): void {
    this._appActive = ev.active;
    if (!ev.active && this._armBelowTimerActive) {
      this._armBelowSince = null;
      this._armBelowTimerActive = false;
      this.publish();
    }
  }

  // ── Cleanup ────────────────────────────────────────────────────────────
  destroy(): void {
    this.inputs$.complete();
    this.outputObserver = null;
  }
}
