import AsyncStorage from "@react-native-async-storage/async-storage";
import type { ComboMap } from "../types";

const key = (deviceId: string) => `wristturn:mapping:${deviceId}`;

export const MappingStore = {
  async get(deviceId: string, adapterDefaults: ComboMap): Promise<ComboMap> {
    const raw = await AsyncStorage.getItem(key(deviceId));
    if (raw) return JSON.parse(raw);
    return adapterDefaults;
  },

  async set(deviceId: string, map: ComboMap): Promise<void> {
    await AsyncStorage.setItem(key(deviceId), JSON.stringify(map));
  },

  async reset(deviceId: string): Promise<void> {
    await AsyncStorage.removeItem(key(deviceId));
  },
};
