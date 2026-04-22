import type { Command, ComboMap, DeviceMetadata } from "../../types";
import type { IDeviceAdapter } from "./IDeviceAdapter";
import { sendWizUDP, sendWizUDPWithReply } from "./wizUdp";

const HUE_STEP = 12; // degrees per gesture, 30 steps across full spectrum

function hsvToRgb(h: number, s: number, v: number): { r: number; g: number; b: number } {
  h = ((h % 360) + 360) % 360;
  const c = v * s;
  const x = c * (1 - Math.abs((h / 60) % 2 - 1));
  const m = v - c;
  let r = 0, g = 0, b = 0;
  if      (h < 60)  { r = c; g = x; b = 0; }
  else if (h < 120) { r = x; g = c; b = 0; }
  else if (h < 180) { r = 0; g = c; b = x; }
  else if (h < 240) { r = 0; g = x; b = c; }
  else if (h < 300) { r = x; g = 0; b = c; }
  else              { r = c; g = 0; b = x; }
  return {
    r: Math.round((r + m) * 255),
    g: Math.round((g + m) * 255),
    b: Math.round((b + m) * 255),
  };
}

export const WIZ_COMMANDS: Command[] = [
  { id: "toggle",          label: "Toggle On/Off", payload: null },
  { id: "hue_forward",     label: "Hue →",         payload: null },
  { id: "hue_backward",    label: "Hue ←",         payload: null },
  { id: "brightness_up",   label: "Brighter",      payload: null },
  { id: "brightness_down", label: "Dimmer",         payload: null },
];

export class WizAdapter implements IDeviceAdapter {
  readonly meta: DeviceMetadata;
  private _connected = false;
  private hue        = 0;   // 0–360, persists across arm resets
  private brightness = 80;  // 10–100
  private isOn       = true;

  constructor(meta: DeviceMetadata) {
    this.meta = meta;
  }

  async connect(): Promise<void> {
    await sendWizUDPWithReply(this.meta.host, { method: "getPilot", params: {} });
    this._connected = true;
  }

  async disconnect(): Promise<void> {
    this._connected = false;
  }

  isConnected(): boolean {
    return this._connected;
  }

  async ping(): Promise<boolean> {
    try {
      await sendWizUDPWithReply(this.meta.host, { method: "getPilot", params: {} }, 2000);
      return true;
    } catch {
      return false;
    }
  }

  async sendCommand(cmd: Command): Promise<void> {
    if (cmd.id === "toggle") {
      this.isOn = !this.isOn;
      await sendWizUDP(this.meta.host, { method: "setPilot", params: { state: this.isOn } });
      return;
    }
    if (cmd.id === "hue_forward") {
      this.hue = (this.hue + HUE_STEP) % 360;
      await this.sendHue();
      return;
    }
    if (cmd.id === "hue_backward") {
      this.hue = ((this.hue - HUE_STEP) + 360) % 360;
      await this.sendHue();
      return;
    }
    if (cmd.id === "brightness_up") {
      this.brightness = Math.min(100, this.brightness + 15);
      await sendWizUDP(this.meta.host, { method: "setPilot", params: { dimming: this.brightness } });
      return;
    }
    if (cmd.id === "brightness_down") {
      this.brightness = Math.max(10, this.brightness - 15);
      await sendWizUDP(this.meta.host, { method: "setPilot", params: { dimming: this.brightness } });
      return;
    }
  }

  private async sendHue(): Promise<void> {
    const { r, g, b } = hsvToRgb(this.hue, 1, 1);
    await sendWizUDP(this.meta.host, {
      method: "setPilot",
      params: { r, g, b, dimming: this.brightness },
    });
  }

  defaultMapping(): ComboMap {
    return {
      "tap":        "toggle",
      "turn_right": "hue_forward",
      "turn_left":  "hue_backward",
      "pitch_up":   "brightness_up",
      "pitch_down": "brightness_down",
    };
  }
}
