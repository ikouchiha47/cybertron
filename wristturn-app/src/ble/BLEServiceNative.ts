import { NativeModules, NativeEventEmitter, Platform } from "react-native";

const { BLEService } = NativeModules;

// No-op stub on iOS / web so the rest of the app doesn't crash
const stub = {
  start: () => Promise.resolve(),
  stop:  () => Promise.resolve(),
  getState: () => Promise.resolve({ connected: false, sleeping: false, deviceName: "", batteryPct: -1 }),
  setRawMode: (_: boolean) => Promise.resolve(),
  setArmed:   (_: boolean) => Promise.resolve(),
  setBaseline: (_: { roll: number; pitch: number; yaw: number }) => Promise.resolve(),
  addListener: (_: string) => {},
  removeListeners: (_: number) => {},
};

const native = Platform.OS === "android" && BLEService ? BLEService : stub;
const emitter = Platform.OS === "android" && BLEService
  ? new NativeEventEmitter(BLEService)
  : null;

export type BLEGesturePayload = {
  name: string;
  roll?: number; pitch?: number; yaw?: number; delta?: number; value?: number;
};
export type BLERawPayload    = { roll: number; pitch: number; yaw: number };
export type BLEDeltaPayload  = { roll: number; pitch: number; yaw: number };
export type BLEStatePayload  = { raw: string };
export type BLEConnectedPayload    = { name: string; address: string };
export type BLEDisconnectedPayload = { reason: number };
export type BLEBatteryPayload = { pct: number };

export const BLEServiceNative = {
  start:      (): Promise<void> => native.start(),
  stop:       (): Promise<void> => native.stop(),
  getState:   (): Promise<{ connected: boolean; sleeping: boolean; deviceName: string; batteryPct: number }> =>
    native.getState(),
  setRawMode: (enabled: boolean): Promise<void>  => native.setRawMode(enabled),
  /** Write arm state: true=arm (enable rotation vector + baseline), false=disarm */
  setArmed:   (armed: boolean): Promise<void>     => native.setArmed(armed),
  /** Write baseline from app to firmware (3 floats, little-endian) */
  setBaseline: (baseline: { roll: number; pitch: number; yaw: number }): Promise<void> =>
    native.setBaseline(baseline.roll, baseline.pitch, baseline.yaw),

  onGesture:     (cb: (p: BLEGesturePayload)    => void) => emitter?.addListener("BLE_GESTURE",      cb),
  onConnected:   (cb: (p: BLEConnectedPayload)  => void) => emitter?.addListener("BLE_CONNECTED",    cb),
  onDisconnected:(cb: (p: BLEDisconnectedPayload)=>void) => emitter?.addListener("BLE_DISCONNECTED", cb),
  onBattery:     (cb: (p: BLEBatteryPayload)    => void) => emitter?.addListener("BLE_BATTERY",      cb),
  onRaw:         (cb: (p: BLERawPayload)         => void) => emitter?.addListener("BLE_RAW",          cb),
  onDelta:       (cb: (p: BLEDeltaPayload)       => void) => emitter?.addListener("BLE_DELTA",        cb),
  onState:       (cb: (p: BLEStatePayload)       => void) => emitter?.addListener("BLE_STATE",        cb),
  onSleeping:    (cb: () => void)                         => emitter?.addListener("BLE_SLEEPING",     cb),
  onError:       (cb: (p: { msg: string }) => void)       => emitter?.addListener("BLE_ERROR",        cb),
};
