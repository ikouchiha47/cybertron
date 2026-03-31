import type { IDeviceAdapter } from "../adapters/IDeviceAdapter";
import type { Command, DeviceMetadata } from "../../types";

const RECONNECT_DELAY_MS = 2000;
const MAX_RECONNECT_ATTEMPTS = 5;

export class DeviceProxy implements IDeviceAdapter {
  readonly meta: DeviceMetadata;
  private adapter: IDeviceAdapter;
  private reconnectAttempts = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(adapter: IDeviceAdapter) {
    this.adapter = adapter;
    this.meta = adapter.meta;
  }

  async connect(): Promise<void> {
    await this.adapter.connect();
    this.reconnectAttempts = 0;
  }

  async disconnect(): Promise<void> {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    await this.adapter.disconnect();
  }

  async sendCommand(command: Command): Promise<void> {
    if (!this.adapter.isConnected()) {
      await this.ensureConnected();
    }
    await this.adapter.sendCommand(command);
  }

  isConnected(): boolean {
    return this.adapter.isConnected();
  }

  private async ensureConnected(): Promise<void> {
    if (this.reconnectAttempts >= MAX_RECONNECT_ATTEMPTS) return;
    this.reconnectAttempts++;
    try {
      await this.adapter.connect();
      this.reconnectAttempts = 0;
    } catch {
      await new Promise((r) => setTimeout(r, RECONNECT_DELAY_MS));
    }
  }
}
