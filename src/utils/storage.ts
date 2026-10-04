/**
 * AsyncStorage persistence for the doorcam store.
 *
 * This module is the only I/O layer: it loads/saves the persisted `CameraStore`
 * and seeds it from the shipped default config on first run. The config model
 * lives in `cameraConfig.ts` and all migration logic lives in `migrations.ts`;
 * both are re-exported below so existing `utils/storage` imports keep working.
 */
import AsyncStorage from '@react-native-async-storage/async-storage';

import {
  CamConfig,
  Camera,
  CameraStore,
  DEFAULT_CAMERA_SETTINGS,
  DefaultStoreSeed,
  slugifyTag,
} from './cameraConfig';
import {
  CURRENT_VERSION,
  detectRawVersion,
  migrateStore,
  normalizeSettings,
  sanitizeStore,
} from './migrations';

export * from './cameraConfig';
export * from './migrations';

const KEY = 'doorcam_config';

/** Materialize a camera store from the shipped config seed (first-run). */
export function storeFromSeed(seed: DefaultStoreSeed): CameraStore {
  const cameras: Camera[] = seed.cameras.map(s => {
    const tag = s.tag || slugifyTag(s.name || s.host || s.id || '');
    const day = normalizeSettings(s.day ?? DEFAULT_CAMERA_SETTINGS);
    const night = normalizeSettings(s.night ?? s.day ?? DEFAULT_CAMERA_SETTINGS);
    return {
      id: s.id || tag,
      name: typeof s.name === 'string' ? s.name : '',
      tag,
      host: typeof s.host === 'string' ? s.host : '',
      ip: typeof s.ip === 'string' ? s.ip : '',
      settings: { ...(s.dayNight === 'night' ? night : day) },
      day,
      night,
      dayNight: s.dayNight,
    };
  });
  return sanitizeStore(
    cameras,
    seed.dashboards ?? [],
    undefined,
    cameras.length === 1 ? cameras[0].id : undefined,
    seed.detection,
  );
}

/**
 * Load the persisted store.
 * - `seed` is optional; when provided and there is no store (first run) or the
 *   store has no cameras, the shipped default config is used and persisted.
 * - A non-empty existing store is never clobbered.
 * - `migrateStore` runs the ordered config migrations up to `CURRENT_VERSION`
 *   and the upgraded store is persisted so they only happen once.
 */
export async function loadCameras(seed?: DefaultStoreSeed): Promise<CameraStore> {
  const empty = sanitizeStore([], [], undefined, undefined, undefined);
  const raw = await AsyncStorage.getItem(KEY);
  let store: CameraStore | null = null;
  let rawVersion: number | null = null;
  if (raw) {
    try {
      const parsed = JSON.parse(raw);
      rawVersion = detectRawVersion(parsed);
      store = migrateStore(parsed);
    } catch {
      store = null;
    }
  }

  let working: CameraStore;
  let fromSeed = false;
  let shouldPersist = false;
  if (!store || store.cameras.length === 0) {
    if (seed && seed.cameras.length > 0) {
      working = storeFromSeed(seed);
      fromSeed = true;
      shouldPersist = true;
    } else {
      return store ?? empty;
    }
  } else {
    working = store;
    // The persisted payload was below the current version: migrations ran, so
    // write the upgraded (current-version) store back.
    shouldPersist = rawVersion !== null && rawVersion < CURRENT_VERSION;
  }

  if (shouldPersist) {
    try {
      await AsyncStorage.setItem(KEY, JSON.stringify(working));
    } catch (e) {
      console.warn(
        fromSeed
          ? '[DoorCam] failed to persist default config seed:'
          : '[DoorCam] failed to persist store migration:',
        e,
      );
    }
  }
  return working;
}

export async function saveCameras(store: CameraStore): Promise<void> {
  // `version` is the single persisted version: stamp it so callers still
  // passing `version: 3` can never downgrade an already-migrated store. Drop
  // the deprecated night-preset marker if a legacy runtime caller included it
  // (it is no longer part of the type, hence the cast).
  const normalized: CameraStore = { ...store, version: CURRENT_VERSION };
  delete (normalized as { nightPresetVersion?: number }).nightPresetVersion;
  await AsyncStorage.setItem(KEY, JSON.stringify(normalized));
}

/**
 * Back-compat loader for legacy callers (background detection).
 * Returns the focused camera, falling back to the first.
 */
export async function loadConfig(): Promise<CamConfig | null> {
  const store = await loadCameras();
  const cam =
    store.cameras.find(c => c.id === store.focusedId) ?? store.cameras[0];
  return cam ? { ip: cam.ip } : null;
}
