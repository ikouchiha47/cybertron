import type { Command, ComboMap, DeviceMetadata } from "../../types";

export interface IDeviceAdapter {
  readonly meta: DeviceMetadata;
  connect(): Promise<void>;
  disconnect(): Promise<void>;
  sendCommand(command: Command): Promise<void>;
  isConnected(): boolean;
  /** Optional: verify reachability. Return true = alive. */
  ping?(): Promise<boolean>;

  /**
   * Default gesture→command mapping for this device type.
   * Used when no user-saved mapping exists.
   * Single gestures fire immediately; combos (comma-separated) buffer until timeout.
   */
  defaultMapping(): ComboMap;
}
