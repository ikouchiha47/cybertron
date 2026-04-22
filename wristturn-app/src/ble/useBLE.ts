import { useEffect, useRef, useState } from "react";
import { ComboEngine } from "../gestures/ComboEngine";
import { DebugLog } from "../debug/DebugLog";
import { SessionRecorder } from "../debug/SessionRecorder";
import { parseGesturePayload } from "../types";
import { BLEServiceNative } from "./BLEServiceNative";

type SharedState = {
  connected:    boolean;
  wristName:    string;
  wristAddress: string;
  lastGesture:  string;
  lastCombo:    string;
  comboSeq:     number;
  batteryPct:   number | null;
};

const state: SharedState = {
  connected:    false,
  wristName:    "",
  wristAddress: "",
  lastGesture:  "",
  lastCombo:    "",
  comboSeq:     0,
  batteryPct:   null,
};

const listeners = new Set<(s: SharedState) => void>();

const engine = new ComboEngine((combo) => {
  state.lastCombo = combo;
  state.comboSeq += 1;
  SessionRecorder.recordCombo(combo);
  notify();
});

export function setActiveComboMap(combos: string[]): void {
  engine.setRegisteredCombos(combos);
}

function notify() {
  const snapshot = { ...state };
  listeners.forEach((l) => l(snapshot));
}

let runtimeStarted = false;

function startRuntime() {
  if (runtimeStarted) return;
  runtimeStarted = true;

  BLEServiceNative.onConnected((p) => {
    state.connected    = true;
    state.wristName    = p.name;
    state.wristAddress = p.address;
    state.batteryPct   = null;
    DebugLog.push("BLE", `connected: ${p.name}`);
    notify();
  });

  BLEServiceNative.onDisconnected(() => {
    state.connected    = false;
    state.wristName    = "";
    state.wristAddress = "";
    state.batteryPct   = null;
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
    if (!event || event.name === "idle") return;
    DebugLog.push("GESTURE", event.name);
    SessionRecorder.recordGesture(event);
    state.lastGesture = event.name;
    notify();
    engine.push(event.name);
  });

  BLEServiceNative.onRaw((p) => {
    SessionRecorder.recordRaw(p);
  });

  BLEServiceNative.onState((p) => {
    SessionRecorder.recordState(p.raw);
  });

  BLEServiceNative.onError?.((p) => {
    DebugLog.push("BLE_ERR", p.msg);
  });

  // Sync initial state in case service was already running
  BLEServiceNative.getState().then((s) => {
    if (s.connected) {
      state.connected  = true;
      state.wristName  = s.deviceName;
      state.batteryPct = s.batteryPct >= 0 ? s.batteryPct : null;
      notify();
    }
  }).catch(() => {});
}

interface UseBLEOptions {
  onGesture?: (gesture: string) => void;
  onCombo?:   (combo: string)   => void;
}

export function useBLE({ onGesture, onCombo }: UseBLEOptions = {}) {
  const [connected,    setConnected]    = useState(state.connected);
  const [wristName,    setWristName]    = useState(state.wristName);
  const [wristAddress, setWristAddress] = useState(state.wristAddress);
  const [lastGesture,  setLastGesture]  = useState(state.lastGesture);
  const [lastCombo,    setLastCombo]    = useState(state.lastCombo);
  const [batteryPct,   setBatteryPct]   = useState(state.batteryPct);

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

  return { connected, wristName, wristAddress, lastGesture, lastCombo, batteryPct };
}
