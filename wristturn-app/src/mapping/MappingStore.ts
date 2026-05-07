import AsyncStorage from "@react-native-async-storage/async-storage";
import type { ComboMap } from "../types";

const key = (deviceId: string) => `wristturn:mapping:${deviceId}`;

/**
 * One-shot v2 migration applied at read time:
 *   - drop `knob_tick±` keys (vocabulary removed in Loop D)
 *   - convert `turn_*,turn_*` / `pitch_*,pitch_*` / `yaw_*,yaw_*` same-axis
 *     combos to `hold:<token>` syntax (auto-repeat now owns repetition)
 * Returns the migrated map plus a boolean indicating whether anything changed.
 */
export function migrateComboMapV2(map: ComboMap): { map: ComboMap; changed: boolean } {
  const out: ComboMap = {};
  let changed = false;
  for (const [combo, action] of Object.entries(map)) {
    if (combo.startsWith("knob_tick")) {
      changed = true;
      continue;
    }
    const parts = combo.split(",").map((p) => p.trim());
    if (parts.length === 2 && parts[0] === parts[1] &&
        /^(turn_(left|right)|pitch_(up|down)|yaw_(left|right))$/.test(parts[0])) {
      const holdKey = `hold:${parts[0]}`;
      // Don't clobber a user-defined hold mapping if it already exists.
      if (!(holdKey in out) && !(holdKey in map)) out[holdKey] = action;
      changed = true;
      continue;
    }
    out[combo] = action;
  }
  return { map: out, changed };
}

export const MappingStore = {
  async get(deviceId: string, adapterDefaults: ComboMap): Promise<ComboMap> {
    const raw = await AsyncStorage.getItem(key(deviceId));
    if (!raw) return adapterDefaults;
    const stored = JSON.parse(raw) as ComboMap;
    const { map, changed } = migrateComboMapV2(stored);
    if (changed) {
      console.log(`[MappingStore] migrated ${deviceId}: dropped knob_tick / converted same-axis combos to hold:`);
      await AsyncStorage.setItem(key(deviceId), JSON.stringify(map));
    }
    return map;
  },

  async set(deviceId: string, map: ComboMap): Promise<void> {
    await AsyncStorage.setItem(key(deviceId), JSON.stringify(map));
  },

  async reset(deviceId: string): Promise<void> {
    await AsyncStorage.removeItem(key(deviceId));
  },
};
