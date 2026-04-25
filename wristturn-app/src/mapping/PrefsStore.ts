import AsyncStorage from "@react-native-async-storage/async-storage";
import type { InteractionModeValue } from "../types";
import { INTERACTION_MODE } from "../types";

const KEY_DEFAULT_MODE = "wristturn:prefs:defaultMode";

export const PrefsStore = {
  async getDefaultMode(): Promise<InteractionModeValue> {
    const raw = await AsyncStorage.getItem(KEY_DEFAULT_MODE);
    const v = raw !== null ? parseInt(raw, 10) : NaN;
    return (v === INTERACTION_MODE.GESTURE || v === INTERACTION_MODE.KNOB || v === INTERACTION_MODE.SYMBOL)
      ? v
      : INTERACTION_MODE.GESTURE;
  },

  async setDefaultMode(mode: InteractionModeValue): Promise<void> {
    await AsyncStorage.setItem(KEY_DEFAULT_MODE, String(mode));
  },
};
