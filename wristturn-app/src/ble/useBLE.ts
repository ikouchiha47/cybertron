import { useEffect, useRef, useState } from "react";
import { PermissionsAndroid, Platform } from "react-native";
import { BleManager, type Device } from "react-native-ble-plx";
import { ComboEngine } from "../gestures/ComboEngine";

const manager = new BleManager();

const WRISTTURN_NAME = "WristTurn";
const GESTURE_SERVICE_UUID = "19B10000-E8F2-537E-4F6C-D104768A1214";
const GESTURE_CHAR_UUID = "19B10001-E8F2-537E-4F6C-D104768A1214";

type SharedState = {
  connected: boolean;
  wristName: string;
  lastGesture: string;
  lastCombo: string;
};

const state: SharedState = {
  connected: false,
  wristName: "",
  lastGesture: "",
  lastCombo: "",
};

const listeners = new Set<(s: SharedState) => void>();
const engine = new ComboEngine((combo) => {
  state.lastCombo = combo;
  notify();
});

let started = false;
let scanning = false;
let retryTimer: ReturnType<typeof setTimeout> | null = null;
let device: Device | null = null;

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
  retryTimer = setTimeout(() => startScan(), 1500);
}

function setDisconnected() {
  state.connected = false;
  state.wristName = "";
  device = null;
  notify();
}

function startScan() {
  if (device || scanning) return;
  scanning = true;
  manager.stopDeviceScan();

  manager.startDeviceScan(null, { allowDuplicates: false }, (err, scanned) => {
    if (err) {
      console.warn("BLE scan error:", err);
      scanning = false;
      scheduleRetry();
      return;
    }
    if (!scanned || !isWristDevice(scanned)) return;

    manager.stopDeviceScan();
    scanning = false;
    clearRetry();

    const wristName = scanned.name ?? scanned.localName ?? WRISTTURN_NAME;
    scanned
      .connect()
      .then((d) => d.discoverAllServicesAndCharacteristics())
      .then((d) => {
        device = d;
        state.connected = true;
        state.wristName = wristName;
        notify();

        d.monitorCharacteristicForService(GESTURE_SERVICE_UUID, GESTURE_CHAR_UUID, (monitorErr, char) => {
          if (monitorErr) {
            console.warn("BLE monitor error:", monitorErr);
            setDisconnected();
            scheduleRetry();
            return;
          }
          if (!char?.value) return;
          const raw = atob(char.value).replace(/\0/g, "").trim();
          if (!raw) return;
          const gesture = raw.split("|")[0].trim();
          if (!gesture) return;
          state.lastGesture = gesture;
          notify();
          engine.push(gesture);
        });
      })
      .catch((e) => {
        console.warn("BLE connect error:", e);
        setDisconnected();
        scheduleRetry();
      });
  });
}

function startRuntime() {
  if (started) return;
  started = true;

  const sub = manager.onStateChange(async (bleState) => {
    if (bleState !== "PoweredOn") return;
    sub.remove();

    const granted = await requestBLEPermissions();
    if (!granted) {
      console.warn("BLE permissions denied");
      return;
    }
    startScan();
  }, true);
}

interface UseBLEOptions {
  onGesture?: (gesture: string) => void;
  onCombo?: (combo: string) => void;
}

export function useBLE({ onGesture, onCombo }: UseBLEOptions = {}) {
  const [connected, setConnected] = useState(state.connected);
  const [wristName, setWristName] = useState(state.wristName);
  const [lastGesture, setLastGesture] = useState(state.lastGesture);
  const [lastCombo, setLastCombo] = useState(state.lastCombo);

  const lastGestureRef = useRef(state.lastGesture);
  const lastComboRef = useRef(state.lastCombo);

  useEffect(() => {
    const listener = (s: SharedState) => {
      setConnected(s.connected);
      setWristName(s.wristName);
      setLastGesture(s.lastGesture);
      setLastCombo(s.lastCombo);

      if (s.lastGesture && s.lastGesture !== lastGestureRef.current) {
        lastGestureRef.current = s.lastGesture;
        onGesture?.(s.lastGesture);
      }
      if (s.lastCombo && s.lastCombo !== lastComboRef.current) {
        lastComboRef.current = s.lastCombo;
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

  return { connected, wristName, lastGesture, lastCombo };
}
