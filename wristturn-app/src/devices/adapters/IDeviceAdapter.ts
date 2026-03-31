import type { Command, DeviceMetadata } from "../../types";

export interface IDeviceAdapter {
  readonly meta: DeviceMetadata;
  connect(): Promise<void>;
  disconnect(): Promise<void>;
  sendCommand(command: Command): Promise<void>;
  isConnected(): boolean;
}
