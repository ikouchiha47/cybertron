import AsyncStorage from "@react-native-async-storage/async-storage";

const KEY_SYMBOL_MODE                  = "wristturn:prefs:symbolMode";
const KEY_EXPERIMENTAL_HOLD_DETECTOR   = "wristturn:prefs:experimentalHoldDetector";
const KEY_MAPPINGS_MIGRATED_V2         = "wristturn:prefs:mappingsMigratedV2";
const KEY_MIN_INTEGRAL_PITCH           = "wristturn:prefs:minIntegralPitch";
const KEY_MIN_INTEGRAL_ROLLYAW         = "wristturn:prefs:minIntegralRollYaw";

// Default thresholds match the firmware compile-time defaults so a fresh
// install has the same behavior whether or not the app has pushed values yet.
export const DEFAULT_MIN_INTEGRAL_PITCH    = 0.30;
export const DEFAULT_MIN_INTEGRAL_ROLLYAW  = 0.30;
export const MIN_INTEGRAL_RANGE = { min: 0.10, max: 1.00 } as const;

// Cache so synchronous code paths (BLE callbacks) can read flags without await.
// Loaded on first hydrate(); writers must update both AsyncStorage and the cache.
let _cache = {
  symbolModeEnabled:        false,
  experimentalHoldDetector: false,
  mappingsMigratedV2:       false,
  minIntegralPitch:         DEFAULT_MIN_INTEGRAL_PITCH,
  minIntegralRollYaw:       DEFAULT_MIN_INTEGRAL_ROLLYAW,
};
let _hydrated = false;

export const PrefsStore = {
  /**
   * Hydrate the synchronous cache from AsyncStorage. Call once at runtime start.
   * Subsequent reads via the *Sync getters return cached values.
   */
  async hydrate(): Promise<void> {
    if (_hydrated) return;
    const [sym, hd, mig, miPitch, miRollYaw] = await Promise.all([
      AsyncStorage.getItem(KEY_SYMBOL_MODE),
      AsyncStorage.getItem(KEY_EXPERIMENTAL_HOLD_DETECTOR),
      AsyncStorage.getItem(KEY_MAPPINGS_MIGRATED_V2),
      AsyncStorage.getItem(KEY_MIN_INTEGRAL_PITCH),
      AsyncStorage.getItem(KEY_MIN_INTEGRAL_ROLLYAW),
    ]);
    _cache.symbolModeEnabled        = sym === "true";
    _cache.experimentalHoldDetector = hd  === "true";
    _cache.mappingsMigratedV2       = mig === "true";
    if (miPitch !== null) {
      const v = parseFloat(miPitch);
      if (!Number.isNaN(v)) _cache.minIntegralPitch = v;
    }
    if (miRollYaw !== null) {
      const v = parseFloat(miRollYaw);
      if (!Number.isNaN(v)) _cache.minIntegralRollYaw = v;
    }
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

  // ── Per-axis MIN_INTEGRAL thresholds (radians) ───────────────────────────
  // Pitch is split out from roll/yaw because pitch tends to bleed asymmetrically
  // during arm-up/arm-down arc motions. Both default to the firmware constant
  // (0.30 rad). Range clamped to [0.10, 1.00] in the setter.

  minIntegralPitchSync():   number { return _cache.minIntegralPitch; },
  minIntegralRollYawSync(): number { return _cache.minIntegralRollYaw; },

  async getMinIntegralPitch(): Promise<number> {
    await PrefsStore.hydrate();
    return _cache.minIntegralPitch;
  },

  async getMinIntegralRollYaw(): Promise<number> {
    await PrefsStore.hydrate();
    return _cache.minIntegralRollYaw;
  },

  async setMinIntegralPitch(value: number): Promise<void> {
    const clamped = Math.max(MIN_INTEGRAL_RANGE.min, Math.min(MIN_INTEGRAL_RANGE.max, value));
    _cache.minIntegralPitch = clamped;
    _hydrated = true;
    await AsyncStorage.setItem(KEY_MIN_INTEGRAL_PITCH, String(clamped));
  },

  async setMinIntegralRollYaw(value: number): Promise<void> {
    const clamped = Math.max(MIN_INTEGRAL_RANGE.min, Math.min(MIN_INTEGRAL_RANGE.max, value));
    _cache.minIntegralRollYaw = clamped;
    _hydrated = true;
    await AsyncStorage.setItem(KEY_MIN_INTEGRAL_ROLLYAW, String(clamped));
  },
};
