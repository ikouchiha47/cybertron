import { useEffect, useRef, useState } from "react";
import { InteractionEngine } from "../gestures/InteractionEngine";
import type { InteractionRule } from "../gestures/InteractionEngine";
import { validateComboMap }  from "../gestures/ComboValidator";
import { MotionClassifier }  from "../gestures/MotionClassifier";
import type { MotionState }  from "../gestures/MotionClassifier";
import { SymbolCapture }     from "../gestures/SymbolCapture";
import { HoldDetector }      from "../gestures/HoldDetector";
import type { PoseSample }   from "../gestures/PoseSample";
import { DebugLog }          from "../debug/DebugLog";
import { SessionRecorder }   from "../debug/SessionRecorder";
import { parseGesturePayload, ArmPose, Gesture } from "../types";
import type { ComboMap }  from "../types";
import { BLEServiceNative }  from "./BLEServiceNative";
import { PrefsStore }        from "../mapping/PrefsStore";

type SharedState = {
  connected:    boolean;
  wristName:    string;
  wristAddress: string;
  lastGesture:  string;
  lastCombo:    string;
  comboSeq:     number;
  batteryPct:   number | null;
  symbolModeEnabled: boolean;
  symbolCapturing: boolean;
  motionState:  MotionState;
  sleeping:     boolean;
  baselineReady:boolean;
  // `seq` is a monotonic counter bumped on every PKT_BASELINE. Consumers track
  // the last `seq` they processed and ignore anything ≤ that — fencing tokens.
  // Without this, a candidate captured during one calibration round (e.g. on
  // DiscoveryScreen) would be re-consumed by a later calibration request (e.g.
  // ActiveControlScreen knob mode) without firmware ever sending a fresh one.
  baselineCandidate: { roll: number; pitch: number; yaw: number; seq: number } | null;
  // Live pose from firmware (current vs baseline) — for calibration HUD
  pose: { roll: number; pitch: number; yaw: number; baseRoll: number; basePitch: number; baseYaw: number } | null;
  // Gravity-based arm pose — null until first PKT_GRAV arrives after connect
  armPose: "flat" | "hanging" | "raised" | null;
  // True when BNO Stab classifier reports stab=1 (on a flat surface). Note:
  // also fires for arm-resting-on-flat (desk, armrest, lap), not only "unworn
  // on table" — see wristturn-app/CLAUDE.md "Stab classifier semantics".
  onTable: boolean;
};

const state: SharedState = {
  connected:       false,
  wristName:       "",
  wristAddress:    "",
  lastGesture:     "",
  lastCombo:       "",
  comboSeq:        0,
  batteryPct:      null,
  symbolModeEnabled: false,
  symbolCapturing: false,
   motionState:     "uncalibrated",
   sleeping:        false,
   baselineReady:   false,
   baselineCandidate: null,
   pose:            null,
   armPose:         null,
   onTable:         false,
};

const listeners = new Set<(s: SharedState) => void>();

function notify() {
  const snapshot = { ...state };
  listeners.forEach((l) => l(snapshot));
}

// ── Timing constants ─────────────────────────────────────────────────────────

/** Engine + HoldDetector tick cadence (ms). 50ms worst-case latency on a 200ms
 *  HoldDetector repeat interval is acceptable per UNIFIED_GESTURE_DESIGN.md. */
const RUNTIME_TICK_MS         = 100;
/** Window within which 3 pitch_down events are treated as a hold-commit. */
const PITCH_DOWN_TRIPLE_MS    = 600;
/** Sample rate at which a pose log line is emitted (1 in N). */
const POSE_LOG_SAMPLE_RATE    = 0.05;

// ── Snap classification (pre-filter, before engine) ──────────────────────────

const SNAP_PEAK_THRESHOLD = 4.5; // rad/s — above this = snap, not a command

// ── ComboMap → InteractionRule conversion ────────────────────────────────────

const _OPPOSITE: Record<string, string> = {
  turn_right: "turn_left",  turn_left:  "turn_right",
  pitch_up:   "pitch_down", pitch_down: "pitch_up",
  yaw_right:  "yaw_left",   yaw_left:   "yaw_right",
};

function comboMapToRules(map: ComboMap): InteractionRule[] {
  const rules: InteractionRule[] = [];

  // shake is always highest priority, no refractory, arms gobble window
  if (map["shake"]) {
    rules.push({ type: "terminal", token: "shake", action: map["shake"], refractoryMs: 0, gobbleMs: 500 });
  }

  // Pose-transition gestures (firmware-emitted on HANGING-involving GravPose
  // changes). Always present, regardless of whether the user mapped an action,
  // because the gobbleMs is what absorbs arc-bleed from the underlying motion.
  // refractoryMs is set high so a flutter near the HANGING boundary can't
  // re-fire the same transition twice.
  rules.push({
    type: "terminal",
    token: "arm_up",
    action: map["arm_up"] ?? "noop",
    refractoryMs: 1500,
    gobbleMs: 800,
  });
  rules.push({
    type: "terminal",
    token: "arm_down",
    action: map["arm_down"] ?? "noop",
    refractoryMs: 1500,
    gobbleMs: 800,
  });

  const multi: Array<[string[], string]> = [];
  const single: Array<[string, string]>  = [];

  for (const [combo, action] of Object.entries(map)) {
    if (combo === "shake") continue;
    // Synthetic keys (symbols, holds) bypass the engine — handled via direct
    // dispatch in dispatchSyntheticCombo below.
    if (combo.startsWith("symbol:") || combo.startsWith("hold:")) continue;
    const parts = combo.split(",");
    if (parts.length > 1) multi.push([parts, action]);
    else single.push([combo, action]);
  }

  // Longer sequences first so a 3-token rule takes priority over a 2-token prefix.
  multi.sort((a, b) => b[0].length - a[0].length);

  for (const [parts, action] of multi) {
    const allSame = parts.every((p) => p === parts[0]);
    if (allSame && parts.length >= 3) {
      // Triple same gesture = repeat rule (hold intent)
      const opp = _OPPOSITE[parts[0]];
      rules.push({ type: "repeat", tokens: parts, windowMs: 600, action, intervalMs: 300, cancelOn: opp ? [opp] : [] });
    } else {
      rules.push({ type: "sequence", tokens: parts, windowMs: 300, action });
    }
  }

  for (const [token, action] of single) {
    rules.push({ type: "terminal", token, action, refractoryMs: 200, snapBackMs: 500 });
  }

  return rules;
}

// ── Pipeline timing ───────────────────────────────────────────────────────────
// Tracks T1→T2→T3 within useBLE. T4 (dispatch) and T5 (sent) are logged by
// ActiveControlScreen which calls markDispatch() / markSent().

let _tRecv = 0;  // T1: BLE packet arrived (set at onGesture entry)
let _tPush = 0;  // T2: token entered engine

export function lastFireMs(): number { return _tFire; }
let _tFire = 0;  // T3: engine fired — exported so ActiveControlScreen can compute T3→T4

function _logTiming(stage: string, label: string, since: number) {
  const now = Date.now();
  DebugLog.push("TIMING", `${stage} ${label} +${now - since}ms`);
  return now;
}

// ── Singleton gesture engine ──────────────────────────────────────────────────

let gestureRules: InteractionRule[] = [];
/**
 * Snapshot of the active ComboMap. Held alongside `gestureRules` so synthetic
 * keys (`symbol:*`, `hold:*`) — which the engine doesn't process — can still
 * resolve to actions via direct lookup in dispatchSyntheticCombo.
 */
let activeMap: ComboMap = {};

const engine = new InteractionEngine((action) => {
  // Pose-transition rules (arm_up/arm_down) fire with action="noop" when the
  // user hasn't mapped them to anything. The rule still ran — its gobbleMs
  // already armed the cross-axis suppression window — so we just skip dispatch.
  if (action === "noop") return;
  // Internal mode-commit actions are routed directly, not dispatched to device
  if (action === "symbol_finalize") { symbolCapture?.finalize(); return; }
  _tFire = _logTiming("fire", action, _tPush);
  state.lastCombo = action;
  state.comboSeq += 1;
  SessionRecorder.recordCombo(action);
  notify();
});

/**
 * Reset and re-run MotionClassifier's calibration ceremony.
 *
 * Called on every device-select session entry so the app-side classifier
 * starts fresh — environment, wear, baseline drift may all have shifted
 * since last session. Stab events from the firmware drive the ceremony
 * to completion (1-2s typical) without any user prompt.
 *
 * Canary tag lets adb confirm this path actually ran on a given session.
 */
export function recalibrate(): void {
  console.log("[CANARY:MC_RECAL] recalibrate() called — fresh MC ceremony");
  motionClassifier?.reset();
  motionClassifier?.startCalibration();
}

/**
 * Forget MotionClassifier state. Called on session exit so the next
 * device-select doesn't inherit stale classifier state from a prior
 * session — pairs with `recalibrate()` to bracket a session lifecycle.
 */
export function resetMotionClassifier(): void {
  console.log("[CANARY:MC_RESET] resetMotionClassifier() called — session exit");
  motionClassifier?.reset();
}

/**
 * Toggle symbol-capture mode. Persisted via PrefsStore. While on, all gestures
 * except TAP (start capture) and PITCH_DOWN×3 (finalize) are suppressed.
 */
export async function setSymbolMode(enabled: boolean): Promise<void> {
  await PrefsStore.setSymbolModeEnabled(enabled);
  state.symbolModeEnabled = enabled;
  state.symbolCapturing   = false;
  pitchDownCount = 0;
  if (pitchDownTimer) { clearTimeout(pitchDownTimer); pitchDownTimer = null; }
  engine.setRules(enabled ? SYMBOL_RULES : gestureRules);
  symbolCapture?.cancel();
  notify();
  DebugLog.push("MODE", `symbolMode=${enabled}`);
}

// Pre-built rule set used while symbol mode is active. Matches the prior
// in-startRuntime constant; promoted to module scope so setSymbolMode can
// reuse it without re-running startRuntime.
const SYMBOL_RULES: InteractionRule[] = [
  { type: "sequence", tokens: ["pitch_down", "pitch_down", "pitch_down"], windowMs: 600, action: "symbol_finalize" },
];

export function setActiveComboMap(map: ComboMap): void {
  if (__DEV__) {
    const errors = validateComboMap(map);
    if (errors.length > 0) {
      console.warn("[ComboValidator] invalid combos in active map:\n" + errors.join("\n"));
    }
  }
  activeMap    = map;
  gestureRules = comboMapToRules(map);
  if (!PrefsStore.symbolModeEnabledSync()) engine.setRules(gestureRules);
}

// ── Singleton interaction modules (created once in startRuntime) ─────────────

let symbolCapture:     SymbolCapture     | null = null;
let motionClassifier:  MotionClassifier  | null = null;
let holdDetector:      HoldDetector      | null = null;
/**
 * Last per-sample gyro magnitude (dps). Updated from PKT.POSE_EXT in the
 * onState handler (~10 Hz). Reads 0 only if the firmware on this device
 * predates Loop C.0 and emits legacy PKT.POSE without the gyro field — in
 * which case HoldDetector's transit gate never trips and the detector
 * silently no-ops. Current firmware emits PKT.POSE_EXT.
 */
let lastGyroMagDps:    number = 0;

// Monotonic across the lifetime of the JS runtime, including BLE reconnects.
// Consumers snapshot this when initiating a calibration request and wait for
// `state.baselineCandidate.seq > snapshot` to confirm a fresh capture.
let _baselineSeq = 0;
export function currentBaselineSeq(): number { return _baselineSeq; }

// Triple pitch_down = commit intent for KNOB/SYMBOL modes
let pitchDownCount = 0;
let pitchDownTimer: ReturnType<typeof setTimeout> | null = null;

function handlePitchDownForHold(onTriple: () => void) {
  pitchDownCount++;
  if (pitchDownTimer) clearTimeout(pitchDownTimer);
  if (pitchDownCount >= 3) {
    pitchDownCount = 0;
    pitchDownTimer = null;
    onTriple();
    return;
  }
  pitchDownTimer = setTimeout(() => { pitchDownCount = 0; pitchDownTimer = null; }, PITCH_DOWN_TRIPLE_MS);
}

/**
 * Dispatch a synthesized combo by *key*: looks up the active map, sets
 * `state.lastCombo` to the resolved action (so onCombo subscribers receive an
 * action — same shape as engine matches), bumps the seq, notifies. Used for
 * symbol matches (`symbol:M`) and HoldDetector repeat fires (`hold:turn_right`).
 * If no mapping exists, logs and skips — no spurious notifies.
 */
function dispatchSyntheticCombo(comboKey: string) {
  const action = activeMap[comboKey];
  if (!action) {
    DebugLog.push("DISPATCH", `no map for ${comboKey}`);
    return;
  }
  state.lastCombo = action;
  state.comboSeq += 1;
  SessionRecorder.recordCombo(action);
  notify();
}

// ── BLE runtime ──────────────────────────────────────────────────────────────

import { parseStatePacket, type StatePacket } from "./StatePacket";

let runtimeStarted = false;

function startRuntime() {
  if (runtimeStarted) return;
  runtimeStarted = true;

  // Hydrate sync-readable prefs cache (experimentalHoldDetector flag) before
  // any BLE callbacks fire. Failures here just leave the flag default-off.
  PrefsStore.hydrate().catch(() => {});

  // ── Interaction modules ──

  // Sync engine rules with the persisted symbol-mode flag once hydrated.
  PrefsStore.hydrate().then(() => {
    state.symbolModeEnabled = PrefsStore.symbolModeEnabledSync();
    engine.setRules(state.symbolModeEnabled ? SYMBOL_RULES : gestureRules);
    notify();
  }).catch(() => {});

  // Position-domain hold detector. Gated by PrefsStore.experimentalHoldDetector
  // — when off, samples are still fed but the detector is bypassed at dispatch.
  // Consumes PKT.POSE_EXT (pose + gyro magnitude) emitted by current firmware.
  // On legacy pre-Loop-C.0 firmware that only emits PKT.POSE, lastGyroMagDps
  // stays 0 and the transit gate never trips — graceful no-op, not a crash.
  holdDetector = new HoldDetector({
    onFire(token) {
      DebugLog.push("HOLD", token);
      // Hold fires resolve via the `hold:<token>` synthetic key in the active
      // map. Same-axis flick combos are banned (Loop A) so there's no shadow.
      dispatchSyntheticCombo(`hold:${token}`);
    },
    onStateChange(axis, dir, state2) {
      console.log(`[HD] ${axis}${dir} → ${state2}`);
    },
  });

  // Tick the engine every 100ms so repeat rules fire even between gesture events.
  // HoldDetector piggybacks the same interval — see UNIFIED_GESTURE_DESIGN.md
  // §"Visual feedback" / plan Loop C.2 for cadence rationale (50ms worst-case
  // latency on a 200ms repeat is acceptable).
  setInterval(() => {
    const now = Date.now();
    engine.tick(now);
    if (PrefsStore.experimentalHoldDetectorSync()) {
      holdDetector?.tick(now);
    }
  }, RUNTIME_TICK_MS);

  motionClassifier = new MotionClassifier({
    onStateChange(mcState) {
      state.motionState = mcState;
      notify();
      DebugLog.push("MOTION", `state→${mcState}`);
    },
    onMotion(_type) {
      // Knob mode is gone — MotionClassifier still drives MOTION/STABLE state
      // transitions for the calibration overlay, but no longer routes deltas.
      // HoldDetector consumes deltas directly in BLEServiceNative.onDelta.
    },
  });

  symbolCapture = new SymbolCapture({
    onStateChange(capState) {
      state.symbolCapturing = capState === "capturing";
      notify();
    },
    onResult(result) {
      if (result.matched) {
        const symbolKey = `symbol:${result.name}`;
        DebugLog.push("SYMBOL", `${result.name} (score=${result.score.toFixed(2)})`);
        dispatchSyntheticCombo(symbolKey);
      } else {
        DebugLog.push("SYMBOL", `not recognized (best score=${result.score.toFixed(2)})`);
      }
    },
    onCancelled() {
      DebugLog.push("SYMBOL", "cancelled");
    },
  });

  // ── BLE event subscriptions ──

  BLEServiceNative.onConnected((p) => {
    console.log("[CAL] BLE_CONNECTED");
    state.connected    = true;
    state.wristName    = p.name;
    state.wristAddress = p.address;
    state.batteryPct   = null;
    state.sleeping     = false;
    state.baselineReady = false;
    state.baselineCandidate = null;
    state.armPose      = null;
    // Do NOT start calibration here — DiscoveryScreen controls that
    DebugLog.push("BLE", `connected: ${p.name}`);
    // Apply persisted symbol-mode flag after connect.
    PrefsStore.hydrate().then(() => {
      state.symbolModeEnabled = PrefsStore.symbolModeEnabledSync();
      engine.setRules(state.symbolModeEnabled ? SYMBOL_RULES : gestureRules);
      notify();
      // Push persisted MIN_INTEGRAL thresholds to firmware so a fresh boot
      // picks up the user's tuned values instead of the firmware compile-time
      // defaults. Failures are non-fatal (firmware still has its defaults).
      const pitch   = PrefsStore.minIntegralPitchSync();
      const rollYaw = PrefsStore.minIntegralRollYawSync();
      setMinIntegrals(pitch, rollYaw).catch((e) => {
        console.error("[BLE] setMinIntegrals on connect failed:", e);
      });
    }).catch(() => {});
    notify();
  });

  BLEServiceNative.onDisconnected(() => {
    console.log("[CAL] BLE_DISCONNECTED — resetting classifier");
    state.connected       = false;
    state.wristName       = "";
    state.wristAddress    = "";
    state.batteryPct      = null;
    state.sleeping        = false;
    state.baselineReady   = false;
    state.baselineCandidate = null;
    state.armPose         = null;
    motionClassifier?.reset();
    holdDetector?.reset();
    symbolCapture?.cancel();
    DebugLog.push("BLE", "disconnected");
    notify();
  });

  BLEServiceNative.onBattery((p) => {
    state.batteryPct = p.pct;
    DebugLog.push("BLE", `battery: ${p.pct}%`);
    notify();
  });

  BLEServiceNative.onGesture((p) => {
    _tRecv = Date.now(); // T1: BLE packet received by app
    const event = parseGesturePayload(
      [p.name, p.roll, p.pitch, p.yaw, p.delta]
        .filter((v) => v !== undefined && v !== null)
        .join("|")
    );
    if (!event || event.name === Gesture.IDLE) return;

    // ── Engagement gate ──────────────────────────────────────────────────────
    // Drop every gesture except shake / arm_up when the arm is hanging at the
    // user's side. Shake is reserved as the always-on system abort signal so
    // the user can still escape from any screen even while disengaged.
    // arm_up is the activate-transition itself — gating it on the pre-state
    // would suppress the very event that lifts the gate.
    // Knob ticks are synthesised from delta samples elsewhere and do not flow
    // through here — gating them is a separate change inside MotionClassifier.
    if (
      state.armPose === ArmPose.HANGING &&
      event.name !== Gesture.SHAKE &&
      event.name !== Gesture.ARM_UP
    ) {
      DebugLog.push("GESTURE_DROP", `${event.name} dropped (armPose=hanging)`);
      return;
    }

    const symbolMode = PrefsStore.symbolModeEnabledSync();
    const axesStr = event.roll !== undefined
      ? ` r=${event.roll?.toFixed(1)} p=${event.pitch?.toFixed(1)} y=${event.yaw?.toFixed(1)}${event.delta !== undefined ? ` d=${event.delta?.toFixed(2)}` : ""}${event.peakRate !== undefined ? ` pk=${event.peakRate?.toFixed(2)}` : ""}`
      : "";
    DebugLog.push("GESTURE_RAW", `${event.name}${axesStr}${symbolMode ? " [symbol]" : ""}`);

    // Universal exit: shake resets the position FSM regardless of state.
    // Engine-mapped shake action still fires through the normal terminal path
    // — the FSM reset and engine fire are independent (design doc Q4).
    if (event.name === Gesture.SHAKE) holdDetector?.onShake();

    // Snap: high-velocity reset gesture — log and discard, never reaches engine
    const snap = (event.peakRate ?? 0) >= SNAP_PEAK_THRESHOLD;
    if (snap) {
      const snapName = event.name === Gesture.TURN_RIGHT ? "snap_right"
                     : event.name === Gesture.TURN_LEFT  ? "snap_left"
                     : event.name;
      const axes = event.roll !== undefined
        ? ` r=${event.roll.toFixed(1)} p=${event.pitch?.toFixed(1)} y=${event.yaw?.toFixed(1)}`
        : "";
      DebugLog.push("GESTURE", `SNAP_DISCARD ${snapName} pk=${event.peakRate?.toFixed(2)}${axes}`);
      console.log(`[SNAP] Discarded ${snapName} with peakRate=${event.peakRate?.toFixed(2)} >= ${SNAP_PEAK_THRESHOLD}`);
      return;
    }

    if (symbolMode) {
      if (event.name === Gesture.TAP) {
        symbolCapture?.startCapture();
        return;
      }
      if (event.name === Gesture.PITCH_DOWN) {
        handlePitchDownForHold(() => symbolCapture?.finalize());
        return;
      }
      // Suppress other gestures while capturing
      return;
    }

    // Default routing — engine handles refractory, snap-back, gobble, sequences, repeats
    const axes = event.roll !== undefined
      ? ` r=${event.roll.toFixed(1)} p=${event.pitch?.toFixed(1)} y=${event.yaw?.toFixed(1)}${event.delta !== undefined ? ` d=${event.delta.toFixed(1)}` : ""}`
      : "";
    DebugLog.push("GESTURE", `${event.name}${axes}`);
    SessionRecorder.recordGesture(event);
    state.lastGesture = event.name;
    notify();
    _tPush = _logTiming("push", event.name, _tRecv); // T2: recv→push (parse + routing)
    engine.push(event.name, _tPush);
  });

  BLEServiceNative.onRaw?.((p) => {
    if (PrefsStore.symbolModeEnabledSync()) symbolCapture?.onRaw(p);
    SessionRecorder.recordRaw(p);
    // Diag: also capture rawMode RV stream into the WAL log when recording,
    // tagged so it sorts alongside the dedicated diagMode tags.
    DebugLog.push("DIAG_RAW", `r=${p.roll?.toFixed(2)} p=${p.pitch?.toFixed(2)} y=${p.yaw?.toFixed(2)}`);
  });

  BLEServiceNative.onDiag?.((p) => {
    // Diagnostic firehose — one line per IMU sample. Heavy at full rate
    // (~210 lines/s) so only useful while a recording session is active.
    DebugLog.push(
      `DIAG_${p.type}`,
      `${p.x?.toFixed(3)} ${p.y?.toFixed(3)} ${p.z?.toFixed(3)}`,
    );
  });

  BLEServiceNative.onDelta?.((p) => {
    motionClassifier?.onDelta(p);
    // Feed HoldDetector with the same delta + the most recent gyro magnitude.
    // gyroMagDps is updated from PKT.POSE_EXT in onState (~10 Hz cadence); the
    // last cached value is reused here at delta cadence. On legacy firmware
    // emitting PKT.POSE only, lastGyroMagDps stays 0 and the detector no-ops.
    if (PrefsStore.experimentalHoldDetectorSync()) {
      const sample: PoseSample = {
        delta: p,
        gyroMagDps: lastGyroMagDps,
        nowMs: Date.now(),
      };
      holdDetector?.onSample(sample);
    }
  });

  // ── DEBUG: Log gesture snap threshold ──
  console.log(`[BLE] Snap threshold: ${SNAP_PEAK_THRESHOLD} rad/s`);

  // Baseline is published on PKT_BASELINE and held until it changes or disarm.
  // Pose packets only carry current r/p/y; we merge them with the last-known
  // baseline so the HUD can render both without re-sending the baseline each tick.
  let lastBaseline: { r: number; p: number; y: number } | null = null;

  BLEServiceNative.onState?.((p) => {
    SessionRecorder.recordState(p.raw);
    DebugLog.push("STATE", `raw(${p.raw.length}B)`);

    const pkt: StatePacket | null = parseStatePacket(p.raw);
    if (!pkt) {
      DebugLog.push("STATE", "parse failed");
      return;
    }

    switch (pkt.type) {
      case "stab": {
        motionClassifier?.onStabilityClass(pkt.stab, Date.now());
        // BNO stab=1 = flat stationary surface. Used by DiscoveryScreen E5
        // to trigger BROWSING exit when watch is set on a table (parallel to
        // the armPose=HANGING exit). Note: also fires for arm-resting-on-flat
        // — consumers should layer in dwell + screen state to disambiguate.
        const wasOnTable = state.onTable;
        state.onTable = (pkt.stab === 1);
        if (state.onTable !== wasOnTable) {
          DebugLog.push("STAB", `onTable=${state.onTable} (stab=${pkt.stab})`);
          notify();
        }
        break;
      }
  case "baseline": {
    lastBaseline = { r: pkt.roll, p: pkt.pitch, y: pkt.yaw };
    _baselineSeq += 1;
    state.baselineCandidate = { roll: pkt.roll, pitch: pkt.pitch, yaw: pkt.yaw, seq: _baselineSeq };
    console.log(`[BASELINE] FIRMWARE SENT baseline: r=${pkt.roll.toFixed(1)} p=${pkt.pitch.toFixed(1)} y=${pkt.yaw.toFixed(1)} seq=${_baselineSeq}`);
    if (state.pose) {
      state.pose = {
        ...state.pose,
        baseRoll:  pkt.roll,
        basePitch: pkt.pitch,
        baseYaw:   pkt.yaw,
      };
      notify();
    }
    notify();
    console.log(`[BASELINE] notify() called, listeners updated`);
    break;
  }
      case "pose": {
        state.pose = {
          roll:  pkt.roll,
          pitch: pkt.pitch,
          yaw:   pkt.yaw,
          baseRoll:  lastBaseline?.r ?? 0,
          basePitch: lastBaseline?.p ?? 0,
          baseYaw:   lastBaseline?.y ?? 0,
        };
        // Sample log ~1/20 to avoid flooding (pose fires ~10Hz)
        if (Math.random() < POSE_LOG_SAMPLE_RATE) {
          const po = state.pose;
          console.log(
            `[POSE] r=${po.roll.toFixed(1)} p=${po.pitch.toFixed(1)} y=${po.yaw.toFixed(1)}` +
            `  base r=${po.baseRoll.toFixed(1)} p=${po.basePitch.toFixed(1)}`
          );
        }
        notify();
        break;
      }
      case "pose_ext": {
        // Loop C.0 firmware contract — pose + per-sample gyro magnitude.
        // Update HUD pose AND cache gyro magnitude for HoldDetector input.
        state.pose = {
          roll:  pkt.roll,
          pitch: pkt.pitch,
          yaw:   pkt.yaw,
          baseRoll:  lastBaseline?.r ?? 0,
          basePitch: lastBaseline?.p ?? 0,
          baseYaw:   lastBaseline?.y ?? 0,
        };
        lastGyroMagDps = pkt.gyroMagDps;
        if (Math.random() < POSE_LOG_SAMPLE_RATE) {
          console.log(
            `[POSE_EXT] r=${pkt.roll.toFixed(1)} p=${pkt.pitch.toFixed(1)} y=${pkt.yaw.toFixed(1)}` +
            ` gyro=${pkt.gyroMagDps.toFixed(1)} dps`
          );
        }
        notify();
        break;
      }
      case "grav": {
        const poses = [ArmPose.FLAT, ArmPose.HANGING, ArmPose.RAISED] as const;
        const label = poses[pkt.pose] ?? null;
        if (label && label !== state.armPose) {
          const prev = state.armPose;
          state.armPose = label;
          console.log(`[GravPose] armPose → ${label}`);
          DebugLog.push("GRAVPOSE", `${prev ?? "unknown"} → ${label}`);
          // HoldDetector universal exits on pose change
          holdDetector?.onArmPoseChange(prev ?? "unknown", label);
          holdDetector?.onGravPoseChange();
          notify();
        }
        break;
      }
      case "sleep":
      case "wake":
      case "arm_evt":
        // Sleep/wake side-effects handled by native emission of BLE_SLEEPING.
        // arm_evt is informational for now.
        break;
    }
  });

  BLEServiceNative.onError?.((p) => {
    DebugLog.push("BLE_ERR", p.msg);
    DebugLog.error(`BLE: ${p.msg}`);
  });

  // Sleep event: device is about to sleep; app should treat as disconnected
  BLEServiceNative.onSleeping?.(() => {
    state.sleeping = true;
    notify();
  });

  // NOTE: Do NOT auto-start calibration here. DiscoveryScreen controls calibration
   // based on presence of stored baseline. If no baseline, it will start calibration;
   // if baseline exists, it will skip directly to wait_awake. This avoids race
   // conditions and unnecessary recalibration on every connect.

   // ── React hook ───────────────────────────────────────────────────────────────
 }

// ── React hook ───────────────────────────────────────────────────────────────

interface UseBLEOptions {
  onGesture?: (gesture: string) => void;
  onCombo?:   (combo: string)   => void;
}

export function useBLE({ onGesture, onCombo }: UseBLEOptions = {}) {
  const [connected,        setConnected]        = useState(state.connected);
  const [wristName,        setWristName]        = useState(state.wristName);
  const [wristAddress,     setWristAddress]     = useState(state.wristAddress);
  const [lastGesture,      setLastGesture]      = useState(state.lastGesture);
  const [lastCombo,        setLastCombo]        = useState(state.lastCombo);
  const [batteryPct,       setBatteryPct]       = useState(state.batteryPct);
  const [symbolModeEnabled, setSymbolModeEnabled] = useState(state.symbolModeEnabled);
  const [symbolCapturing,  setSymbolCapturing]  = useState(state.symbolCapturing);
  const [motionState,      setMotionState]      = useState(state.motionState);
  const [pose,             setPose]             = useState(state.pose);
  const [sleeping,         setSleeping]         = useState(state.sleeping);
  const [baselineReady,    setBaselineReady]    = useState(state.baselineReady);
  const [baselineCandidate,setBaselineCandidate]= useState(state.baselineCandidate);
  const [armPose,          setArmPose]          = useState(state.armPose);
  const [onTable,          setOnTable]          = useState(state.onTable);

  const lastGestureRef  = useRef(state.lastGesture);
  const lastComboSeqRef = useRef(state.comboSeq);

  useEffect(() => {
    const listener = (s: SharedState) => {
      setConnected(s.connected);
      setWristName(s.wristName);
      setWristAddress(s.wristAddress);
      setLastGesture(s.lastGesture);
      setLastCombo(s.lastCombo);
      setBatteryPct(s.batteryPct);
      setSymbolModeEnabled(s.symbolModeEnabled);
      setSymbolCapturing(s.symbolCapturing);
      setMotionState(s.motionState);
      setPose(s.pose);
      setSleeping(s.sleeping);
      setBaselineReady(s.baselineReady);
      setBaselineCandidate(s.baselineCandidate);
      setArmPose(s.armPose);
      setOnTable(s.onTable);

      if (s.lastGesture && s.lastGesture !== lastGestureRef.current) {
        lastGestureRef.current = s.lastGesture;
        onGesture?.(s.lastGesture);
      }
      if (s.lastCombo && s.comboSeq !== lastComboSeqRef.current) {
        lastComboSeqRef.current = s.comboSeq;
        onCombo?.(s.lastCombo);
      }
    };

    listeners.add(listener);
    listener({ ...state });
    startRuntime();

    return () => { listeners.delete(listener); };
  }, [onGesture, onCombo]);

   return {
     connected, wristName, wristAddress, lastGesture, lastCombo, batteryPct,
     symbolModeEnabled, symbolCapturing, motionState, pose,
     sleeping, baselineReady, baselineCandidate, armPose, onTable,
   };
 }

// ── Control functions for Discovery/ActiveControl ─────────────────────────────

export function startCalibration(): void {
  console.log("[BLE] startCalibration() called");
  motionClassifier?.reset();
  motionClassifier?.startCalibration();
  console.log("[BLE] startCalibration: setArmed(true)");
  // Always arm explicitly: E7 only fires on discState *changes*, so if discState is
  // already CALIBRATING (reconnect after sleep, return from Settings), E7 never
  // re-fires and the firmware never enables rotation vector without this call.
  BLEServiceNative.setArmed(true).then(() => {
    console.log("[BLE] startCalibration: armDevice() succeeded");
  }).catch((e) => {
    console.warn("[BLE] startCalibration: arm failed", e);
  });
}

export function confirmBaselineReady(): void {
  console.log("[BLE] confirmBaselineReady()");
  state.baselineReady = true;
  notify();
}

export function armDevice(): Promise<void> {
  console.log("[BLE] armDevice() → setArmed(true)");
  return BLEServiceNative.setArmed(true);
}

export function disarmDevice(): Promise<void> {
  console.log("[BLE] disarmDevice() → setArmed(false)");
  return BLEServiceNative.setArmed(false);
}

export function sendBaselineToFirmware(baseline: { roll: number; pitch: number; yaw: number }): Promise<void> {
  console.log(`[BLE] sendBaselineToFirmware → r=${baseline.roll.toFixed(1)} p=${baseline.pitch.toFixed(1)} y=${baseline.yaw.toFixed(1)}`);
  return BLEServiceNative.setBaseline(baseline);
}

/**
 * Push per-axis MIN_INTEGRAL thresholds to firmware. Pitch is split out from
 * roll/yaw because it bleeds asymmetrically during arm-up/arm-down arcs.
 *
 * Both inputs are radians, valid range 0.10..1.00. Values are clamped, then
 * encoded as ×100 bytes packed into a uint16 (high=pitch, low=rollYaw).
 */
/**
 * Toggle diagnostic firehose on the firmware. When on, every IMU sample is
 * mirrored over BLE and the app pushes one line per sample into DebugLog
 * (start a session in the Logs screen first to capture to disk). Heavy
 * BLE/CPU/storage cost — keep off in normal use.
 */
export function setDiagMode(enabled: boolean): Promise<void> {
  console.log(`[BLE] setDiagMode → ${enabled}`);
  return BLEServiceNative.setDiagMode(enabled);
}

export function setMinIntegrals(pitchRad: number, rollYawRad: number): Promise<void> {
  const clamp = (x: number) => Math.max(0.10, Math.min(1.00, x));
  const pitchX100   = Math.round(clamp(pitchRad)   * 100);
  const rollYawX100 = Math.round(clamp(rollYawRad) * 100);
  const packed = ((pitchX100 & 0xFF) << 8) | (rollYawX100 & 0xFF);
  console.log(`[BLE] setMinIntegrals → pitch=${(pitchX100/100).toFixed(2)} rollyaw=${(rollYawX100/100).toFixed(2)} (packed=0x${packed.toString(16)})`);
  return BLEServiceNative.setMinIntegrals(packed);
}

// Force a fresh baseline capture on firmware. Caller should snapshot
// `currentBaselineSeq()` *before* calling this and then wait for the next
// baselineCandidate with `seq > snapshot`. The magic (-999,-999,-999) write
// is recognised by firmware (wristturn.ino:530) — it clears calibration state
// and re-runs the rolling-window capture once stillness is detected.
export function requestRecalibration(): Promise<number> {
  const snapshot = _baselineSeq;
  console.log(`[BLE] requestRecalibration: snapshot seq=${snapshot}`);
  return BLEServiceNative.setBaseline({ roll: -999, pitch: -999, yaw: -999 }).then(() => snapshot);
}
