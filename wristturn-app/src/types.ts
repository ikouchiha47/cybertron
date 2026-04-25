export type TransportType = "androidtv" | "http" | "websocket" | "tcp" | "macdaemon" | "wiz";

export const DEFAULT_PORT: Record<TransportType, number> = {
  androidtv: 6466,
  macdaemon: 9876,
  http:      80,
  websocket: 8080,
  tcp:       9000,
  wiz:       38899,
};

export interface DiscoveredDevice {
  id: string;           // mDNS service name or "manual:host:port"
  name: string;
  host: string;
  port: number;
  transport: TransportType;
  mdnsTxt?: Record<string, string>;
}

export interface DeviceMetadata {
  id: string;
  name: string;
  transport: TransportType;
  host: string;
  port: number;
  availableCommands: Command[];
}

export interface Command {
  id: string;
  label: string;
  // transport-specific payload stored as opaque JSON
  payload: unknown;
}

export type GestureName =
  | "turn_right" | "turn_left"
  | "pitch_up"   | "pitch_down"
  | "yaw_right"  | "yaw_left"
  | "tap" | "shake" | "step" | "idle";

export interface GestureEvent {
  name: GestureName;
  roll?:  number;   // degrees, present for turn_*/pitch_*/yaw_*
  pitch?: number;
  yaw?:   number;
  delta?: number;   // firmware-reported axis delta that triggered the gesture
  value?: number;   // present for step (count)
}

export interface RawSample {
  roll: number;
  pitch: number;
  yaw: number;
}

const GESTURE_NAMES = new Set<string>([
  "turn_right","turn_left","pitch_up","pitch_down",
  "yaw_right","yaw_left","tap","shake","step","idle",
]);

/** Parse a raw BLE payload string into a GestureEvent, or null if invalid. */
export function parseGesturePayload(raw: string): GestureEvent | null {
  const parts = raw.split("|");
  const name = parts[0].trim();
  if (!GESTURE_NAMES.has(name)) return null;
  const g: GestureEvent = { name: name as GestureName };
  // 4 fields: gesture|r|p|y  — legacy
  // 5 fields: gesture|r|p|y|d — current
  if (parts.length >= 4) {
    g.roll  = parseFloat(parts[1]);
    g.pitch = parseFloat(parts[2]);
    g.yaw   = parseFloat(parts[3]);
  }
  if (parts.length >= 5) {
    g.delta = parseFloat(parts[4]);
  }
  if (parts.length === 2) {
    g.value = parseFloat(parts[1]);
  }
  return g;
}

/** Parse a raw IMU stream payload `raw|r|p|y`. Returns null if not a raw sample. */
export function parseRawPayload(raw: string): RawSample | null {
  const parts = raw.split("|");
  if (parts[0].trim() !== "raw" || parts.length < 4) return null;
  return {
    roll:  parseFloat(parts[1]),
    pitch: parseFloat(parts[2]),
    yaw:   parseFloat(parts[3]),
  };
}

// combo string e.g. "turn_right" or "turn_right,turn_right"
export type ComboString = string;
export type ComboMap = Record<ComboString, string>; // combo → command id

// Knob tick events synthesized by KnobQuantizer
export type KnobTickName = "knob_tick+" | "knob_tick-";

// Symbol recognition events synthesized by SymbolCapture: "symbol:M", "symbol:Z" etc.
export type SymbolEventName = `symbol:${string}`;

/** Interaction mode written to firmware modeChar */
export const INTERACTION_MODE = {
  GESTURE: 0,
  KNOB:    1,
  SYMBOL:  2,
} as const;
export type InteractionModeValue = typeof INTERACTION_MODE[keyof typeof INTERACTION_MODE];
