import AsyncStorage from "@react-native-async-storage/async-storage";

const KEY_SYMBOL_MODE                  = "wristturn:prefs:symbolMode";
const KEY_EXPERIMENTAL_HOLD_DETECTOR   = "wristturn:prefs:experimentalHoldDetector";
const KEY_MAPPINGS_MIGRATED_V2         = "wristturn:prefs:mappingsMigratedV2";

// Cache so synchronous code paths (BLE callbacks) can read flags without await.
// Loaded on first hydrate(); writers must update both AsyncStorage and the cache.
let _cache = {
  symbolModeEnabled:        false,
  experimentalHoldDetector: false,
  mappingsMigratedV2:       false,
};
let _hydrated = false;

export const PrefsStore = {
  /**
   * Hydrate the synchronous cache from AsyncStorage. Call once at runtime start.
   * Subsequent reads via the *Sync getters return cached values.
   */
  async hydrate(): Promise<void> {
    if (_hydrated) return;
    const [sym, hd, mig] = await Promise.all([
      AsyncStorage.getItem(KEY_SYMBOL_MODE),
      AsyncStorage.getItem(KEY_EXPERIMENTAL_HOLD_DETECTOR),
      AsyncStorage.getItem(KEY_MAPPINGS_MIGRATED_V2),
    ]);
    _cache.symbolModeEnabled        = sym === "true";
    _cache.experimentalHoldDetector = hd  === "true";
    _cache.mappingsMigratedV2       = mig === "true";
    _hydrated = true;
  },

  // ── Symbol mode ───────────────────────────────────────────────────────────

  symbolModeEnabledSync(): boolean { return _cache.symbolModeEnabled; },

  async getSymbolModeEnabled(): Promise<boolean> {
    await PrefsStore.hydrate();
    return _cache.symbolModeEnabled;
  },

  async setSymbolModeEnabled(enabled: boolean): Promise<void> {
    _cache.symbolModeEnabled = enabled;
    _hydrated = true;
    await AsyncStorage.setItem(KEY_SYMBOL_MODE, String(enabled));
  },

  // ── Experimental Hold Detector ───────────────────────────────────────────

  experimentalHoldDetectorSync(): boolean { return _cache.experimentalHoldDetector; },

  async getExperimentalHoldDetector(): Promise<boolean> {
    await PrefsStore.hydrate();
    return _cache.experimentalHoldDetector;
  },

  async setExperimentalHoldDetector(enabled: boolean): Promise<void> {
    _cache.experimentalHoldDetector = enabled;
    _hydrated = true;
    await AsyncStorage.setItem(KEY_EXPERIMENTAL_HOLD_DETECTOR, String(enabled));
  },

  // ── ComboMap migration flag (one-shot v2 upgrade) ─────────────────────────

  mappingsMigratedV2Sync(): boolean { return _cache.mappingsMigratedV2; },

  async getMappingsMigratedV2(): Promise<boolean> {
    await PrefsStore.hydrate();
    return _cache.mappingsMigratedV2;
  },

  async setMappingsMigratedV2(done: boolean): Promise<void> {
    _cache.mappingsMigratedV2 = done;
    _hydrated = true;
    await AsyncStorage.setItem(KEY_MAPPINGS_MIGRATED_V2, String(done));
  },
};
