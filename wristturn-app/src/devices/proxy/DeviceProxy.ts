import type { IDeviceAdapter } from "../adapters/IDeviceAdapter";
import type { Command, ComboMap, DeviceMetadata } from "../../types";

const RECONNECT_DELAY_MS = 2000;
const MAX_RECONNECT_ATTEMPTS = 5;
const HEARTBEAT_INTERVAL_MS = 5000;

export class DeviceProxy implements IDeviceAdapter {
  readonly meta: DeviceMetadata;
  private adapter: IDeviceAdapter;
  private reconnectAttempts = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private lastCommandAt = 0;
  private reconnecting = false;

  constructor(adapter: IDeviceAdapter) {
    this.adapter = adapter;
    this.meta = adapter.meta;
  }

  async connect(): Promise<void> {
    await this.adapter.connect();
    this.reconnectAttempts = 0;
    this.startHeartbeat();
  }

  async disconnect(): Promise<void> {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    this.stopHeartbeat();
    await this.adapter.disconnect();
  }

  private startHeartbeat(): void {
    if (!this.adapter.ping) return;
    this.stopHeartbeat();
    this.heartbeatTimer = setInterval(() => {
      // Fully detached — never blocks the command path
      this.adapter.ping!()
        .then((alive) => {
          if (!alive && !this.reconnecting && Date.now() - this.lastCommandAt > HEARTBEAT_INTERVAL_MS) {
            console.log("[DeviceProxy] heartbeat failed, reconnecting...");
            this.ensureConnected().catch(console.error);
          }
        })
        .catch(() => {}); // swallow — heartbeat is best-effort
    }, HEARTBEAT_INTERVAL_MS);
  }

  private stopHeartbeat(): void {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
  }

  async sendCommand(command: Command): Promise<void> {
    if (!this.adapter.isConnected()) {
      await this.ensureConnected();
    }
    await this.adapter.sendCommand(command);
    this.lastCommandAt = Date.now();
  }

  isConnected(): boolean {
    return this.adapter.isConnected();
  }

  defaultMapping(): ComboMap {
    return this.adapter.defaultMapping();
  }

  private async ensureConnected(): Promise<void> {
    if (this.reconnecting) return;
    if (this.reconnectAttempts >= MAX_RECONNECT_ATTEMPTS) return;
    this.reconnecting = true;
    this.reconnectAttempts++;
    try {
      await this.adapter.connect();
      this.reconnectAttempts = 0;
    } catch {
      await new Promise((r) => setTimeout(r, RECONNECT_DELAY_MS));
    } finally {
      this.reconnecting = false;
    }
  }
}
