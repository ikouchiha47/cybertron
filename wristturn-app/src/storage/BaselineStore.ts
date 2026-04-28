import AsyncStorage from "@react-native-async-storage/async-storage";
import type { Baseline } from "../types";

const KEY_PREFIX = "wristturn:baseline:";

function keyFor(address: string): string {
  return `${KEY_PREFIX}${address}`;
}

export const BaselineStore = {
  async load(wristAddress: string): Promise<Baseline | null> {
    try {
      const raw = await AsyncStorage.getItem(keyFor(wristAddress));
      if (!raw) return null;
      return JSON.parse(raw) as Baseline;
    } catch (e) {
      console.warn("[BaselineStore] load error:", e);
      return null;
    }
  },

  async save(wristAddress: string, baseline: Baseline): Promise<void> {
    try {
      await AsyncStorage.setItem(keyFor(wristAddress), JSON.stringify(baseline));
    } catch (e) {
      console.warn("[BaselineStore] save error:", e);
      throw e;
    }
  },

  async clear(wristAddress: string): Promise<void> {
    try {
      await AsyncStorage.removeItem(keyFor(wristAddress));
    } catch (e) {
      console.warn("[BaselineStore] clear error:", e);
      throw e;
    }
  },

  async list(): Promise<string[]> {
    try {
      const all = await AsyncStorage.getAllKeys();
      const prefix = KEY_PREFIX;
      return all.filter(k => k.startsWith(prefix)).map(k => k.slice(prefix.length));
    } catch (e) {
      console.warn("[BaselineStore] list error:", e);
      return [];
    }
  },
};
