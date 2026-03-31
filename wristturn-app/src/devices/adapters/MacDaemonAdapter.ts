import type { IDeviceAdapter } from "./IDeviceAdapter";
import type { Command, ComboMap, DeviceMetadata } from "../../types";

export const MACDAEMON_COMMANDS: Command[] = [
  { id: "ctrl_left",   label: "Previous Desktop", payload: "ctrl_left" },
  { id: "ctrl_right",  label: "Next Desktop",     payload: "ctrl_right" },
  { id: "volume_up",   label: "Volume Up",         payload: "volume_up" },
  { id: "volume_down", label: "Volume Down",       payload: "volume_down" },
  { id: "mute",        label: "Mute",              payload: "mute" },
  { id: "media_play",  label: "Play/Pause",        payload: "media_play" },
  { id: "media_next",  label: "Next Track",        payload: "media_next" },
  { id: "media_prev",  label: "Previous Track",    payload: "media_prev" },
];

export class MacDaemonAdapter implements IDeviceAdapter {
  readonly meta: DeviceMetadata;
  private _connected = false;
  private baseUrl: string;

  constructor(meta: DeviceMetadata) {
    this.meta = meta;
    this.baseUrl = `http://${meta.host}:${meta.port}`;
  }

  async connect(): Promise<void> {
    if (this._connected) return;
    const res = await fetch(`${this.baseUrl}/`);
    if (!res.ok) throw new Error(`daemon health check failed: ${res.status}`);
    this._connected = true;
    console.log("[MacDaemon] connected via HTTP to", this.baseUrl);
  }

  async disconnect(): Promise<void> {
    // HTTP is stateless — keep _connected so status doesn't flicker on remount
  }

  async sendCommand(command: Command): Promise<void> {
    console.log("[MacDaemon] sendCommand", command.payload);
    const res = await fetch(`${this.baseUrl}/command`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ command: command.payload }),
    });
    if (!res.ok) console.warn("[MacDaemon] command failed:", res.status);
  }

  isConnected(): boolean {
    return this._connected;
  }

  async ping(): Promise<boolean> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 3000);
    try {
      const res = await fetch(`${this.baseUrl}/`, { signal: controller.signal });
      this._connected = res.ok;
    } catch {
      this._connected = false;
    } finally {
      clearTimeout(timer);
    }
    return this._connected;
  }

  defaultMapping(): ComboMap {
    return {
      "turn_right":           "ctrl_right",
      "turn_left":            "ctrl_left",
      "pitch_up":             "volume_up",
      "pitch_down":           "volume_down",
      "tap":                  "media_play",
      "tap,tap":              "media_next",
      "turn_right,turn_left": "mute",
    };
  }
}
