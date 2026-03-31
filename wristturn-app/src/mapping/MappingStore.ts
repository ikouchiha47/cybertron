import AsyncStorage from "@react-native-async-storage/async-storage";
import type { ComboMap } from "../types";

const key = (deviceId: string) => `wristturn:mapping:${deviceId}`;

const DEFAULTS: Record<string, ComboMap> = {
  androidtv: {
    "turn_right":              "dpad_right",
    "turn_left":               "dpad_left",
    "pitch_up":                "dpad_up",
    "pitch_down":              "dpad_down",
    "tap":                     "dpad_center",
    "turn_right,turn_right":   "ff",
    "turn_left,turn_left":     "rewind",
    "turn_right,turn_left":    "back",
  },
  macdaemon: {
    "turn_right":  "ctrl_right",
    "turn_left":   "ctrl_left",
    "pitch_up":    "volume_up",
    "pitch_down":  "volume_down",
    "tap":         "media_play",
  },
};

export const MappingStore = {
  async get(deviceId: string, transport: string): Promise<ComboMap> {
    const raw = await AsyncStorage.getItem(key(deviceId));
    if (raw) return JSON.parse(raw);
    return DEFAULTS[transport] ?? {};
  },

  async set(deviceId: string, map: ComboMap): Promise<void> {
    await AsyncStorage.setItem(key(deviceId), JSON.stringify(map));
  },

  async reset(deviceId: string): Promise<void> {
    await AsyncStorage.removeItem(key(deviceId));
  },
};
