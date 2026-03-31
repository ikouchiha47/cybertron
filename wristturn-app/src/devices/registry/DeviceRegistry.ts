/**
 * Flyweight registry — single source of truth for device metadata.
 * All screens read from here; no device objects passed through nav props.
 */

import AsyncStorage from "@react-native-async-storage/async-storage";
import type { DeviceMetadata, TransportType } from "../../types";
import { ANDROIDTV_COMMANDS } from "../adapters/AndroidTVAdapter";
import { MACDAEMON_COMMANDS } from "../adapters/MacDaemonAdapter";
import { DeviceProxy } from "../proxy/DeviceProxy";
import { AndroidTVAdapter } from "../adapters/AndroidTVAdapter";
import { MacDaemonAdapter } from "../adapters/MacDaemonAdapter";
import { HttpAdapter } from "../adapters/HttpAdapter";
import type { IDeviceAdapter } from "../adapters/IDeviceAdapter";

const STORAGE_KEY = "wristturn:devices";

class DeviceRegistry {
  private devices = new Map<string, DeviceMetadata>();
  private proxies = new Map<string, DeviceProxy>();
  private loaded = false;

  async load(): Promise<void> {
    if (this.loaded) return;
    const raw = await AsyncStorage.getItem(STORAGE_KEY);
    if (raw) {
      const entries: DeviceMetadata[] = JSON.parse(raw);
      entries.forEach((d) => this.devices.set(d.id, d));
    }
    this.loaded = true;
  }

  async save(): Promise<void> {
    await AsyncStorage.setItem(
      STORAGE_KEY,
      JSON.stringify(Array.from(this.devices.values()))
    );
  }

  async register(meta: DeviceMetadata): Promise<void> {
    this.devices.set(meta.id, meta);
    await this.save();
  }

  get(id: string): DeviceMetadata | undefined {
    return this.devices.get(id);
  }

  all(): DeviceMetadata[] {
    return Array.from(this.devices.values());
  }

  async remove(id: string): Promise<void> {
    this.proxies.get(id)?.disconnect();
    this.proxies.delete(id);
    this.devices.delete(id);
    await this.save();
  }

  // Returns (or creates) the proxy for a device — lazy, singleton per device
  getProxy(id: string): DeviceProxy | null {
    const meta = this.devices.get(id);
    if (!meta) return null;

    if (!this.proxies.has(id)) {
      const adapter = this.buildAdapter(meta);
      if (!adapter) return null;
      this.proxies.set(id, new DeviceProxy(adapter));
    }
    return this.proxies.get(id)!;
  }

  private buildAdapter(meta: DeviceMetadata): IDeviceAdapter | null {
    switch (meta.transport as TransportType) {
      case "androidtv":  return new AndroidTVAdapter(meta);
      case "macdaemon":  return new MacDaemonAdapter(meta);
      case "http":       return new HttpAdapter(meta);
      default:           return null;
    }
  }

  // Helpers for known device types
  static androidTVMeta(id: string, name: string, host: string, port = 6466): DeviceMetadata {
    return { id, name, host, port, transport: "androidtv", availableCommands: ANDROIDTV_COMMANDS };
  }

  static macDaemonMeta(host: string, port = 9876): DeviceMetadata {
    return { id: `macdaemon:${host}:${port}`, name: "Mac", host, port, transport: "macdaemon", availableCommands: MACDAEMON_COMMANDS };
  }
}

export const registry = new DeviceRegistry();
