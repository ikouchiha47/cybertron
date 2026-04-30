import { useEffect, useRef, useState } from "react";
import { ComboEngine }       from "../gestures/ComboEngine";
import { filterGesture, isSnap } from "../gestures/GestureFilter";
import { validateComboMap }  from "../gestures/ComboValidator";
import { HoldDetector }      from "../gestures/HoldDetector";
import { KnobEngagement }    from "../gestures/KnobEngagement";
import { ModeManager }       from "../gestures/ModeManager";
import { MotionClassifier }  from "../gestures/MotionClassifier";
import type { MotionState }  from "../gestures/MotionClassifier";
import { SymbolCapture }     from "../gestures/SymbolCapture";
import { DebugLog }          from "../debug/DebugLog";
import { SessionRecorder }   from "../debug/SessionRecorder";
import { parseGesturePayload, INTERACTION_MODE, Mode, ArmPose, Gesture } from "../types";
import type { RawSample, InteractionModeValue }  from "../types";
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
  interactionMode: "gesture" | "knob" | "symbol";
  knobEngaged:  boolean;
  symbolCapturing: boolean;
  motionState:  MotionState;
  sleeping:     boolean;
  baselineReady:boolean;
  baselineCandidate: { roll: number; pitch: number; yaw: number } | null;
  // Live pose from firmware (current vs baseline) — for calibration HUD
  pose: { roll: number; pitch: number; yaw: number; baseRoll: number; basePitch: number; baseYaw: number } | null;
  // Gravity-based arm pose — null until first PKT_GRAV arrives after connect
  armPose: "flat" | "hanging" | "raised" | null;
};

const state: SharedState = {
  connected:       false,
  wristName:       "",
  wristAddress:    "",
  lastGesture:     "",
  lastCombo:       "",
  comboSeq:        0,
  batteryPct:      null,
  interactionMode: "gesture",
  knobEngaged:     false,
  symbolCapturing: false,
   motionState:     "uncalibrated",
   sleeping:        false,
   baselineReady:   false,
   baselineCandidate: null,
   pose:            null,
   armPose:         null,
};

const listeners = new Set<(s: SharedState) => void>();

function notify() {
  const snapshot = { ...state };
  listeners.forEach((l) => l(snapshot));
}

// ── Singleton gesture/combo engine ───────────────────────────────────────────

const engine = new ComboEngine((combo) => {
  // tap,tap,tap is reserved for mode cycling — handled by tap counter below
  state.lastCombo = combo;
  state.comboSeq += 1;
  SessionRecorder.recordCombo(combo);
  notify();
});

export function recalibrate(): void {
  motionClassifier?.reset();
  motionClassifier?.startCalibration();
}

export function applyMode(mode: InteractionModeValue): void {
  const modeStr = mode === INTERACTION_MODE.KNOB   ? Mode.KNOB
                : mode === INTERACTION_MODE.SYMBOL ? Mode.SYMBOL
                : Mode.GESTURE;
  modeManager?.setMode(modeStr);
}

export function setActiveComboMap(combos: string[]): void {
  if (__DEV__) {
    const map = Object.fromEntries(combos.map((c) => [c, true]));
    const errors = validateComboMap(map);
    if (errors.length > 0) {
      console.warn("[ComboValidator] invalid combos in active map:\n" + errors.join("\n"));
    }
  }
  engine.setRegisteredCombos(combos);
}

// ── Singleton mode + interaction modules (created once in startRuntime) ──────

let modeManager:       ModeManager       | null = null;
let knobEngagement:    KnobEngagement    | null = null;
let holdDetector:      HoldDetector      | null = null;
let symbolCapture:     SymbolCapture     | null = null;
let motionClassifier:  MotionClassifier  | null = null;
let lastRawSample:     RawSample = { roll: 0, pitch: 0, yaw: 0 };
let lastDeltaSample:   RawSample = { roll: 0, pitch: 0, yaw: 0 };

// Simple triple-tap detector (separate from combo engine so it's always active)
let tapCount = 0;
let tapTimer: ReturnType<typeof setTimeout> | null = null;

function handleTapForModeCycle() {
  tapCount++;
  if (tapTimer) clearTimeout(tapTimer);
  tapTimer = setTimeout(() => {
    if (tapCount === 3 && modeManager) {
      modeManager.cycleMode();
    }
    tapCount = 0;
    tapTimer = null;
  }, 350);
}

// Dispatch a synthesized event name directly as a combo (bypasses gesture filter)
function dispatchSyntheticCombo(name: string) {
  state.lastCombo = name;
  state.comboSeq += 1;
  notify();
}

// ── BLE runtime ──────────────────────────────────────────────────────────────

import { parseStatePacket, type StatePacket } from "./StatePacket";

let runtimeStarted = false;

function startRuntime() {
  if (runtimeStarted) return;
  runtimeStarted = true;

  // ── Interaction mode modules ──

  modeManager = new ModeManager({
    onModeChange(mode) {
      state.interactionMode = mode;
      state.knobEngaged     = false;
      state.symbolCapturing = false;
      notify();
      DebugLog.push("MODE", `switched to ${mode}`);

       const modeVal = mode === Mode.GESTURE ? INTERACTION_MODE.GESTURE
                     : mode === Mode.KNOB    ? INTERACTION_MODE.KNOB
                     :                        INTERACTION_MODE.SYMBOL;
       BLEServiceNative.setMode(modeVal).catch(() => {});

       // Clean up engagement state on mode switch
       knobEngagement?.forceExit();
       symbolCapture?.cancel();
    },
  });

  knobEngagement = new KnobEngagement({
    onTick(direction) {
      const tickName = direction > 0 ? "knob_tick+" : "knob_tick-";
      DebugLog.push("KNOB", tickName);
      dispatchSyntheticCombo(tickName);
    },
    onStateChange(knobState) {
      state.knobEngaged = knobState === "engaged";
      notify();
    },
  });

  holdDetector = new HoldDetector((evt) => {
    DebugLog.push("GESTURE", evt);
    const mode = modeManager?.getMode() ?? Mode.GESTURE;
    if (mode === Mode.KNOB)   { knobEngagement?.commit(); return; }
    if (mode === Mode.SYMBOL) { symbolCapture?.finalize(); return; }
    // In gesture mode, pitch_down_hold dispatches as a combo key
    dispatchSyntheticCombo(evt);
  });

  motionClassifier = new MotionClassifier({
    onStateChange(mcState) {
      state.motionState = mcState;
      notify();
      DebugLog.push("MOTION", `state→${mcState}`);
    },
    onMotion(type) {
      // Only wrist rotation feeds the knob quantizer — arm resets are swallowed here
      if (type !== "wrist_rotating") return;
      const mode = modeManager?.getMode() ?? Mode.GESTURE;
      if (mode === Mode.KNOB) knobEngagement?.onDelta(lastDeltaSample);
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
    notify();
    // Apply persisted default mode after connect
    PrefsStore.getDefaultMode().then((mode) => {
      if (mode !== INTERACTION_MODE.GESTURE) modeManager?.setMode(
        mode === INTERACTION_MODE.KNOB ? Mode.KNOB : Mode.SYMBOL
      );
    }).catch(() => {});
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
    // Reset to gesture mode on disconnect
    modeManager?.setMode(Mode.GESTURE);
    knobEngagement?.forceExit();
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
    const event = parseGesturePayload(
      [p.name, p.roll, p.pitch, p.yaw, p.delta]
        .filter((v) => v !== undefined && v !== null)
        .join("|")
    );
    if (!event || event.name === Gesture.IDLE) return;

    const mode = modeManager?.getMode() ?? Mode.GESTURE;
    const axesStr = event.roll !== undefined
      ? ` r=${event.roll?.toFixed(1)} p=${event.pitch?.toFixed(1)} y=${event.yaw?.toFixed(1)}${event.delta !== undefined ? ` d=${event.delta?.toFixed(2)}` : ""}${event.peakRate !== undefined ? ` pk=${event.peakRate?.toFixed(2)}` : ""}`
      : "";
    DebugLog.push("GESTURE_RAW", `${event.name}${axesStr} [${mode}]`);

    // Always track taps for mode-cycling (triple-tap)
    if (event.name === Gesture.TAP) handleTapForModeCycle();

    // Always update hold detector
    if (event.name === Gesture.PITCH_DOWN) {
      holdDetector?.onPitchDown(lastRawSample);
    } else {
      holdDetector?.onOtherGesture();
    }

    // Mode-specific gesture routing
    if (mode === Mode.KNOB) {
      if (event.name === Gesture.TAP) {
        knobEngagement?.engage(lastRawSample);
        return;
      }
      if (event.name === Gesture.PITCH_DOWN) {
        knobEngagement?.cancel();
        state.lastGesture = event.name;
        notify();
        return;
      }
      // Other gestures in knob mode fall through to gesture-mode dispatch
    }

    if (mode === Mode.SYMBOL) {
      if (event.name === Gesture.TAP) {
        symbolCapture?.startCapture();
        return;
      }
      if (event.name === Gesture.PITCH_DOWN) {
        symbolCapture?.cancel();
        return;
      }
      // Suppress other gestures while capturing
      return;
    }

    // GESTURE mode: refractory + snap classification + combo dispatch
    const axes = event.roll  !== undefined
      ? ` r=${event.roll?.toFixed(1)} p=${event.pitch?.toFixed(1)} y=${event.yaw?.toFixed(1)}${event.delta !== undefined ? ` d=${event.delta?.toFixed(1)}` : ""}`
      : "";
    const snap = isSnap(event.peakRate ?? 0);
    if (!filterGesture(event.name, event.peakRate)) {
      DebugLog.push("GESTURE", `suppressed:${axes} ${event.name}`);
      return;
    }
    if (snap) {
      // Snap: high-velocity reset gesture — log but don't dispatch as a command.
      // Does not arm snap-back cooldown or refractory (filterGesture skipped those).
      const snapName = event.name === Gesture.TURN_RIGHT ? "snap_right"
                     : event.name === Gesture.TURN_LEFT  ? "snap_left"
                     : event.name;
      DebugLog.push("GESTURE", `snap ${snapName} pk=${event.peakRate?.toFixed(2)}${axes}`);
      return;
    }
    DebugLog.push("GESTURE", `${event.name}${axes}`);
    SessionRecorder.recordGesture(event);
    state.lastGesture = event.name;
    notify();
    engine.push(event.name);
  });

  BLEServiceNative.onRaw?.((p) => {
    lastRawSample = p;
    holdDetector?.onRaw(p);
    const mode = modeManager?.getMode() ?? Mode.GESTURE;
    if (mode === Mode.SYMBOL) symbolCapture?.onRaw(p);
    SessionRecorder.recordRaw(p);
  });

  BLEServiceNative.onDelta?.((p) => {
    lastDeltaSample = p;
    // MotionClassifier classifies and routes to KnobEngagement via onMotion callback
    motionClassifier?.onDelta(p);
  });

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
        break;
      }
      case "baseline": {
        lastBaseline = { r: pkt.roll, p: pkt.pitch, y: pkt.yaw };
        state.baselineCandidate = { roll: pkt.roll, pitch: pkt.pitch, yaw: pkt.yaw };
        console.log(`[BASELINE] r=${pkt.roll} p=${pkt.pitch} y=${pkt.yaw}`);
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
        if (Math.random() < 0.05) {
          const po = state.pose;
          console.log(
            `[POSE] r=${po.roll.toFixed(1)} p=${po.pitch.toFixed(1)} y=${po.yaw.toFixed(1)}` +
            `  base r=${po.baseRoll.toFixed(1)} p=${po.basePitch.toFixed(1)}`
          );
        }
        notify();
        break;
      }
      case "grav": {
        const poses = [ArmPose.FLAT, ArmPose.HANGING, ArmPose.RAISED] as const;
        const label = poses[pkt.pose] ?? null;
        if (label && label !== state.armPose) {
          state.armPose = label;
          console.log(`[GravPose] armPose → ${label}`);
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
  const [interactionMode,  setInteractionMode]  = useState(state.interactionMode);
  const [knobEngaged,      setKnobEngaged]      = useState(state.knobEngaged);
  const [symbolCapturing,  setSymbolCapturing]  = useState(state.symbolCapturing);
  const [motionState,      setMotionState]      = useState(state.motionState);
  const [pose,             setPose]             = useState(state.pose);
  const [sleeping,         setSleeping]         = useState(state.sleeping);
  const [baselineReady,    setBaselineReady]    = useState(state.baselineReady);
  const [baselineCandidate,setBaselineCandidate]= useState(state.baselineCandidate);
  const [armPose,          setArmPose]          = useState(state.armPose);

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
      setInteractionMode(s.interactionMode);
      setKnobEngaged(s.knobEngaged);
      setSymbolCapturing(s.symbolCapturing);
      setMotionState(s.motionState);
      setPose(s.pose);
      setSleeping(s.sleeping);
      setBaselineReady(s.baselineReady);
      setBaselineCandidate(s.baselineCandidate);
      setArmPose(s.armPose);

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
     interactionMode, knobEngaged, symbolCapturing, motionState, pose,
     sleeping, baselineReady, baselineCandidate, armPose,
   };
 }

// ── Control functions for Discovery/ActiveControl ─────────────────────────────

export function startCalibration(): void {
  console.log("[BLE] startCalibration()");
  motionClassifier?.reset();
  motionClassifier?.startCalibration();
  // Always arm explicitly: E7 only fires on discState *changes*, so if discState is
  // already CALIBRATING (reconnect after sleep, return from Settings), E7 never
  // re-fires and the firmware never enables rotation vector without this call.
  BLEServiceNative.setArmed(true).catch((e) =>
    console.warn("[BLE] startCalibration: arm failed", e)
  );
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
