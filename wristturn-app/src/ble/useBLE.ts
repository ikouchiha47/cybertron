import { useEffect, useRef, useState } from "react";
import { PermissionsAndroid, Platform } from "react-native";
import { BleManager, type Device } from "react-native-ble-plx";
import { ComboEngine } from "../gestures/ComboEngine";

// Singleton — one manager, one scan, one connection
const _manager = new BleManager();

const WRISTTURN_NAME       = "WristTurn";
const GESTURE_SERVICE_UUID = "19B10000-E8F2-537E-4F6C-D104768A1214";
const GESTURE_CHAR_UUID    = "19B10001-E8F2-537E-4F6C-D104768A1214";

async function requestBLEPermissions(): Promise<boolean> {
  if (Platform.OS !== "android") return true;
  const grants = await PermissionsAndroid.requestMultiple([
    PermissionsAndroid.PERMISSIONS.BLUETOOTH_SCAN,
    PermissionsAndroid.PERMISSIONS.BLUETOOTH_CONNECT,
    PermissionsAndroid.PERMISSIONS.ACCESS_FINE_LOCATION,
  ]);
  return Object.values(grants).every((r) => r === PermissionsAndroid.RESULTS.GRANTED);
}

interface UseBLEOptions {
  onGesture?: (gesture: string) => void;
  onCombo?:   (combo: string) => void;
}

export function useBLE({ onGesture, onCombo }: UseBLEOptions = {}) {
  const [connected, setConnected]     = useState(false);
  const [wristName, setWristName]     = useState("");
  const [lastGesture, setLastGesture] = useState("");
  const [lastCombo, setLastCombo]     = useState("");

  const engine = useRef(
    new ComboEngine((combo) => {
      setLastCombo(combo);
      onCombo?.(combo);
    })
  ).current;

  useEffect(() => {
    let device: Device | null = null;
    let cancelled = false;
    let scanRetryTimer: ReturnType<typeof setTimeout> | null = null;

    const clearRetry = () => {
      if (scanRetryTimer) {
        clearTimeout(scanRetryTimer);
        scanRetryTimer = null;
      }
    };

    const isWristDevice = (d: Device): boolean => {
      const name = (d.name ?? d.localName ?? "").toLowerCase();
      const byName = name.includes("wristturn") || name.includes("xiao");
      const serviceUuids = (d.serviceUUIDs ?? []).map((u) => u.toLowerCase());
      const byService = serviceUuids.includes(GESTURE_SERVICE_UUID.toLowerCase());
      return byName || byService;
    };

    const startScan = () => {
      if (cancelled || device) return;
      _manager.stopDeviceScan();
      _manager.startDeviceScan(null, { allowDuplicates: false }, (err, scanned) => {
        if (err) {
          console.warn("BLE scan error:", err);
          return;
        }
        if (!scanned || !isWristDevice(scanned)) return;
        _manager.stopDeviceScan();
        clearRetry();

        const name = scanned.name ?? scanned.localName ?? WRISTTURN_NAME;
        scanned.connect()
          .then((d) => d.discoverAllServicesAndCharacteristics())
          .then((d) => {
            device = d;
            setConnected(true);
            setWristName(name);
            d.monitorCharacteristicForService(GESTURE_SERVICE_UUID, GESTURE_CHAR_UUID, (_err, char) => {
              if (!char?.value) return;
              const raw = atob(char.value).replace(/\0/g, "").trim();
              if (!raw) return;
              const gesture = raw.split("|")[0].trim();
              if (!gesture) return;
              setLastGesture(gesture);
              onGesture?.(gesture);
              engine.push(gesture);
            });
          })
          .catch((e) => {
            console.warn("BLE connect error:", e);
            setConnected(false);
            setWristName("");
            device = null;
            scanRetryTimer = setTimeout(startScan, 1500);
          });
      });
    };

    const sub = _manager.onStateChange(async (state) => {
      if (state !== "PoweredOn") return;
      sub.remove();

      const granted = await requestBLEPermissions();
      if (!granted) { console.warn("BLE permissions denied"); return; }
      startScan();
    }, true);

    return () => {
      cancelled = true;
      clearRetry();
      sub.remove();
      _manager.stopDeviceScan();
      engine.destroy();
      device?.cancelConnection().catch(() => {});
    };
  }, []);

  return { connected, wristName, lastGesture, lastCombo };
}
