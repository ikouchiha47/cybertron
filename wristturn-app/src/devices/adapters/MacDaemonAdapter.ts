import type { IDeviceAdapter } from "./IDeviceAdapter";
import type { Command, DeviceMetadata } from "../../types";

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
  private ws: WebSocket | null = null;
  private _connected = false;

  constructor(meta: DeviceMetadata) {
    this.meta = meta;
  }

  async connect(): Promise<void> {
    return new Promise((resolve, reject) => {
      this.ws = new WebSocket(`ws://${this.meta.host}:${this.meta.port}`);
      this.ws.onopen = () => { this._connected = true; resolve(); };
      this.ws.onerror = reject;
      this.ws.onclose = () => { this._connected = false; };
    });
  }

  async disconnect(): Promise<void> {
    this.ws?.close();
    this.ws = null;
    this._connected = false;
  }

  async sendCommand(command: Command): Promise<void> {
    if (!this.ws || !this._connected) return;
    this.ws.send(JSON.stringify({ command: command.payload }));
  }

  isConnected(): boolean {
    return this._connected;
  }
}
