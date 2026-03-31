export type TransportType = "androidtv" | "http" | "websocket" | "tcp" | "macdaemon";

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

// combo string e.g. "turn_right" or "turn_right,turn_right"
export type ComboString = string;
export type ComboMap = Record<ComboString, string>; // combo → command id
