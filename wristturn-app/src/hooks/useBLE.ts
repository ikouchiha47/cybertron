import { useEffect, useRef, useState } from "react";
import { BleManager, Device, Characteristic } from "react-native-ble-plx";
import type { TVDevice } from "../types";
import { sendTVCommand } from "../tv/androidtv";

const WRISTTURN_NAME      = "WristTurn";
const GESTURE_SERVICE_UUID = "19B10000-E8F2-537E-4F6C-D104768A1214";
const GESTURE_CHAR_UUID    = "19B10001-E8F2-537E-4F6C-D104768A1214";

const COMBO_TIMEOUT_MS = 800;
const COMBO_MAX_LEN    = 3;

// Maps gesture combos to Android TV keycodes
// Key: comma-joined gesture tuple e.g. "turn_right" or "turn_right,turn_left"
const COMBO_KEYCODES: Record<string, string> = {
  "turn_right":              "KEYCODE_DPAD_RIGHT",
  "turn_left":               "KEYCODE_DPAD_LEFT",
  "pitch_up":                "KEYCODE_DPAD_UP",
  "pitch_down":              "KEYCODE_DPAD_DOWN",
  "tap":                     "KEYCODE_DPAD_CENTER",
  "turn_right,turn_right":   "KEYCODE_MEDIA_FAST_FORWARD",
  "turn_left,turn_left":     "KEYCODE_MEDIA_REWIND",
  "turn_right,turn_left":    "KEYCODE_BACK",
};

export function useBLE(selectedTV: TVDevice | null) {
  const manager  = useRef(new BleManager()).current;
  const [connected, setConnected] = useState(false);
  const [lastGesture, setLastGesture] = useState<string>("");
  const [lastCombo, setLastCombo]     = useState<string>("");

  const buffer  = useRef<string[]>([]);
  const timer   = useRef<ReturnType<typeof setTimeout> | null>(null);

  function flushCombo() {
    if (timer.current) { clearTimeout(timer.current); timer.current = null; }
    const combo = buffer.current.join(",");
    buffer.current = [];
    if (!combo) return;

    setLastCombo(combo);

    const keycode = COMBO_KEYCODES[combo];
    if (keycode && selectedTV) {
      sendTVCommand(selectedTV, keycode);
    }
  }

  function pushGesture(gesture: string) {
    if (buffer.current.length >= COMBO_MAX_LEN) flushCombo();
    buffer.current.push(gesture);
    setLastGesture(gesture);

    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(flushCombo, COMBO_TIMEOUT_MS);
  }

  function onCharacteristic(_err: unknown, char: Characteristic | null) {
    if (!char?.value) return;
    const raw = Buffer.from(char.value, "base64").toString("utf8").replace(/\0/g, "").trim();
    if (!raw) return;

    const parts   = raw.split("|");
    const gesture = parts[0].trim();
    if (!gesture) return;

    pushGesture(gesture);
  }

  useEffect(() => {
    let device: Device | null = null;

    const sub = manager.onStateChange((state) => {
      if (state !== "PoweredOn") return;
      sub.remove();

      manager.startDeviceScan(null, null, (error, scanned) => {
        if (error || !scanned) return;
        if (scanned.name !== WRISTTURN_NAME) return;

        manager.stopDeviceScan();
        scanned
          .connect()
          .then((d) => d.discoverAllServicesAndCharacteristics())
          .then((d) => {
            device = d;
            setConnected(true);
            d.monitorCharacteristicForService(
              GESTURE_SERVICE_UUID,
              GESTURE_CHAR_UUID,
              onCharacteristic
            );
          })
          .catch(console.error);
      });
    }, true);

    return () => {
      sub.remove();
      device?.cancelConnection();
      manager.destroy();
    };
  }, []);

  return { connected, lastGesture, lastCombo };
}
