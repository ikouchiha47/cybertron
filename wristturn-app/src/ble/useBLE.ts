import { useEffect, useRef, useState } from "react";
import { AppState, PermissionsAndroid, Platform } from "react-native";
import AsyncStorage from "@react-native-async-storage/async-storage";
import { BleManager, type Device } from "react-native-ble-plx";
import { ComboEngine } from "../gestures/ComboEngine";
import { DebugLog } from "../debug/DebugLog";
import { parseGesturePayload } from "../types";

const manager = new BleManager();

const WRISTTURN_NAME = "WristTurn";
const GESTURE_SERVICE_UUID = "19B10000-E8F2-537E-4F6C-D104768A1214";
const GESTURE_CHAR_UUID = "19B10001-E8F2-537E-4F6C-D104768A1214";

type SharedState = {
  connected: boolean;
  wristName: string;
  wristAddress: string;
  lastGesture: string;
  lastCombo: string;
  comboSeq: number;
};

const state: SharedState = {
  connected: false,
  wristName: "",
  wristAddress: "",
  lastGesture: "",
  lastCombo: "",
  comboSeq: 0,
};

const listeners = new Set<(s: SharedState) => void>();
const engine = new ComboEngine((combo) => {
  state.lastCombo = combo;
  state.comboSeq += 1;
  notify();
});

// Expose so ActiveControlScreen can tell the engine which combos are registered
export function setActiveComboMap(combos: string[]): void {
  engine.setRegisteredCombos(combos);
}

let started = false;
let scanning = false;
let retryTimer: ReturnType<typeof setTimeout> | null = null;
let device: Device | null = null;
let lastDeviceId: string | null = null;

function notify() {
  const snapshot = { ...state };
  listeners.forEach((l) => l(snapshot));
}

function clearRetry() {
  if (!retryTimer) return;
  clearTimeout(retryTimer);
  retryTimer = null;
}

async function requestBLEPermissions(): Promise<boolean> {
  if (Platform.OS !== "android") return true;
  const grants = await PermissionsAndroid.requestMultiple([
    PermissionsAndroid.PERMISSIONS.BLUETOOTH_SCAN,
    PermissionsAndroid.PERMISSIONS.BLUETOOTH_CONNECT,
    PermissionsAndroid.PERMISSIONS.ACCESS_FINE_LOCATION,
  ]);
  return Object.values(grants).every((r) => r === PermissionsAndroid.RESULTS.GRANTED);
}

function isWristDevice(d: Device): boolean {
  const name = (d.name ?? d.localName ?? "").toLowerCase();
  const byName = name.includes("wristturn") || name.includes("xiao");
  const uuids = (d.serviceUUIDs ?? []).map((u) => u.toLowerCase());
  const byService = uuids.includes(GESTURE_SERVICE_UUID.toLowerCase());
  return byName || byService;
}

function scheduleRetry() {
  clearRetry();
  retryTimer = setTimeout(() => ensureConnected(), 1500);
}

function setDisconnected() {
  state.connected = false;
  state.wristName = "";
  state.wristAddress = "";
  device = null;
  lastDeviceId = null;
  AsyncStorage.removeItem("wristturn:lastBleId").catch(() => {});
  notify();
}

function monitorDevice(connected: Device) {
  const wristName = connected.name ?? connected.localName ?? WRISTTURN_NAME;
  device = connected;
  lastDeviceId = connected.id;
  AsyncStorage.setItem("wristturn:lastBleId", connected.id).catch(() => {});
  state.connected = true;
  state.wristName = wristName;
  state.wristAddress = connected.id;
  DebugLog.push("BLE", `connected: ${wristName}`);
  notify();

  connected.monitorCharacteristicForService(GESTURE_SERVICE_UUID, GESTURE_CHAR_UUID, (monitorErr, char) => {
    if (monitorErr) {
      DebugLog.push("BLE", `monitor error: ${monitorErr.message ?? monitorErr}`);
      setDisconnected();
      scheduleRetry();
      return;
    }
    if (!char?.value) return;
    const raw = atob(char.value).replace(/\0/g, "").trim();
    if (!raw) return;
    const event = parseGesturePayload(raw);
    if (!event || event.name === "idle") return;
    DebugLog.push("GESTURE", event.name);
    state.lastGesture = event.name;
    notify();
    engine.push(event.name);
  });
}

function connectAndMonitor(d: Device) {
  DebugLog.push("BLE", `connecting: ${d.name ?? d.id}`);
  d.connect()
    .then((connected) => connected.discoverAllServicesAndCharacteristics())
    .then((connected) => monitorDevice(connected))
    .catch((e) => {
      DebugLog.push("BLE", `connect error: ${e?.message ?? e}`);
      setDisconnected();
      scheduleRetry();
    });
}

async function ensureConnected() {
  if (device || scanning) return;

  // If we know the last device ID, cancel it directly — nRF may still think
  // it's connected (e.g. after JS reload) and won't advertise until cancelled.
  const storedId = lastDeviceId ?? await AsyncStorage.getItem("wristturn:lastBleId").catch(() => null);
  if (storedId) {
    console.log("[BLE] cancelling stale connection for", storedId);
    await manager.cancelDeviceConnection(storedId).catch(() => {});
    await new Promise((r) => setTimeout(r, 3000));
  }

  console.log("[BLE] starting scan");
  scanning = true;
  manager.stopDeviceScan();
  let cancelDone = false;

  manager.startDeviceScan(null, { allowDuplicates: false }, (err, scanned) => {
    if (err) {
      console.warn("BLE scan error:", err);
      scanning = false;
      scheduleRetry();
      return;
    }
    if (!scanned || !isWristDevice(scanned)) return;
    if (cancelDone) return;
    cancelDone = true;
    manager.stopDeviceScan();
    scanning = false;
    clearRetry();

    // Cancel any stale connection before connecting fresh
    scanned.cancelConnection()
      .catch(() => {})
      .finally(() => connectAndMonitor(scanned));
  });
}

function startRuntime() {
  if (started) return;
  started = true;

  // Drop connection when app goes to background so nRF stops advertising
  // and reconnects cleanly when app returns (covers JS reload case too)
  AppState.addEventListener("change", (next) => {
    console.log("[BLE] AppState →", next, "device=", !!device);
    if (next === "background" || next === "inactive") {
      if (device) {
        console.log("[BLE] backgrounding — cancelling connection");
        device.cancelConnection().catch(() => {});
        setDisconnected();
      }
    } else if (next === "active") {
      console.log("[BLE] foregrounded — ensureConnected");
      ensureConnected();
    }
  });

  const sub = manager.onStateChange(async (bleState) => {
    if (bleState !== "PoweredOn") return;
    sub.remove();
    const granted = await requestBLEPermissions();
    if (!granted) { console.warn("BLE permissions denied"); return; }
    ensureConnected();
  }, true);
}

interface UseBLEOptions {
  onGesture?: (gesture: string) => void;
  onCombo?: (combo: string) => void;
}

export function useBLE({ onGesture, onCombo }: UseBLEOptions = {}) {
  const [connected, setConnected] = useState(state.connected);
  const [wristName, setWristName] = useState(state.wristName);
  const [wristAddress, setWristAddress] = useState(state.wristAddress);
  const [lastGesture, setLastGesture] = useState(state.lastGesture);
  const [lastCombo, setLastCombo] = useState(state.lastCombo);

  const lastGestureRef = useRef(state.lastGesture);
  const lastComboSeqRef = useRef(state.comboSeq);

  useEffect(() => {
    const listener = (s: SharedState) => {
      setConnected(s.connected);
      setWristName(s.wristName);
      setWristAddress(s.wristAddress);
      setLastGesture(s.lastGesture);
      setLastCombo(s.lastCombo);

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

    return () => {
      listeners.delete(listener);
    };
  }, [onGesture, onCombo]);

  return { connected, wristName, wristAddress, lastGesture, lastCombo };
}
