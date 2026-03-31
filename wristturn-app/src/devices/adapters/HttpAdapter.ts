import type { IDeviceAdapter } from "./IDeviceAdapter";
import type { Command, DeviceMetadata } from "../../types";

interface HttpPayload {
  method: "GET" | "POST" | "PUT";
  path: string;
  body?: object;
}

export class HttpAdapter implements IDeviceAdapter {
  readonly meta: DeviceMetadata;
  private _connected = false;

  constructor(meta: DeviceMetadata) {
    this.meta = meta;
  }

  async connect(): Promise<void> {
    // verify reachability
    const res = await fetch(`http://${this.meta.host}:${this.meta.port}/`);
    this._connected = res.ok || res.status < 500;
  }

  async disconnect(): Promise<void> {
    this._connected = false;
  }

  async sendCommand(command: Command): Promise<void> {
    const p = command.payload as HttpPayload;
    await fetch(`http://${this.meta.host}:${this.meta.port}${p.path}`, {
      method: p.method,
      headers: p.body ? { "Content-Type": "application/json" } : undefined,
      body:    p.body ? JSON.stringify(p.body) : undefined,
    });
  }

  isConnected(): boolean {
    return this._connected;
  }
}
