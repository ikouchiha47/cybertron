/**
 * Store migration, normalization, and sanitization.
 *
 * This module owns every transformation between persisted/raw payloads and the
 * in-memory `CameraStore` shape. It depends only on the pure model in
 * `cameraConfig.ts`; it performs no I/O.
 *
 * Versioning is go-migrate style: a single ordered `MIGRATIONS` list, each entry
 * taking a store at `version - 1` to `version`, applied in a loop until the
 * store reaches `CURRENT_VERSION`. `CameraStore.version` is the one persisted
 * version; there is no separate rollout marker.
 */
import {
  Camera,
  CameraSettings,
  CameraStore,
  Dashboard,
  DEFAULT_CAMERA_SETTINGS,
  DEFAULT_DASHBOARD_ID,
  DEFAULT_DASHBOARD_NAME,
  DEFAULT_DETECTION_SETTINGS,
  DayNightMode,
  DetectionSettings,
  DEFAULT_NIGHT_SETTINGS,
  LEGACY_TINY_FRAMESIZE,
  slugifyTag,
} from './cameraConfig';

/**
 * Legacy night-preset rollout marker. Retained so back-compat callers and the
 * old `applyNightPresetRollout` shim keep compiling; the persisted store no
 * longer carries it. The rollout itself now runs as migration v4.
 */
export const NIGHT_PRESET_VERSION = 1;

/**
 * The migration that shipped the generic night-preset rollout. A legacy v3
 * store carrying `nightPresetVersion` already had this applied, so it resumes
 * at the next migration rather than being skipped to `CURRENT_VERSION`.
 */
const NIGHT_PRESET_ROLLOUT_VERSION = 4;

function clampInt(value: any, min: number, max: number, fallback: number): number {
  const n = typeof value === 'number' && Number.isFinite(value) ? Math.round(value) : fallback;
  return Math.min(max, Math.max(min, n));
}

function clampFloat(value: any, min: number, max: number, fallback: number): number {
  const n = typeof value === 'number' && Number.isFinite(value) ? value : fallback;
  return Math.min(max, Math.max(min, n));
}

function coerceBool(value: any, fallback: boolean): boolean {
  return typeof value === 'boolean' ? value : fallback;
}

/** Sanitize persisted settings, filling missing/invalid fields with firmware defaults. */
export function normalizeSettings(raw: any): CameraSettings {
  const d = DEFAULT_CAMERA_SETTINGS;
  if (!raw || typeof raw !== 'object') return { ...d };
  return {
    quality: clampInt(raw.quality, 10, 63, d.quality),
    brightness: clampInt(raw.brightness, -2, 2, d.brightness),
    contrast: clampInt(raw.contrast, -2, 2, d.contrast),
    saturation: clampInt(raw.saturation, -2, 2, d.saturation),
    hmirror: coerceBool(raw.hmirror, d.hmirror),
    vflip: coerceBool(raw.vflip, d.vflip),
    wbMode: clampInt(raw.wbMode, 0, 4, d.wbMode),
    awb: coerceBool(raw.awb, d.awb),
    ledOn: coerceBool(raw.ledOn, d.ledOn),
    ledIntensity: clampInt(raw.ledIntensity, 0, 255, d.ledIntensity),
    framesize: clampInt(raw.framesize, 0, 13, d.framesize),
    exposureLock: coerceBool(raw.exposureLock, d.exposureLock),
    aecValue: clampInt(raw.aecValue, 0, 1200, d.aecValue),
    agcGain: clampInt(raw.agcGain, 0, 128, d.agcGain),
  };
}

/**
 * True when settings still exactly match the factory day defaults. Mirrors
 * `isDefaultSettings` in cameraSettings.ts but defined locally to avoid a
 * circular import (cameraSettings imports from this module).
 */
function isFactoryDefaultSettings(settings: CameraSettings): boolean {
  return (Object.keys(DEFAULT_CAMERA_SETTINGS) as (keyof CameraSettings)[]).every(
    key => settings[key] === DEFAULT_CAMERA_SETTINGS[key],
  );
}

/** Sanitize persisted global detection settings, clamping to engine ranges. */
export function normalizeDetection(raw: any): DetectionSettings {
  const d = DEFAULT_DETECTION_SETTINGS;
  if (!raw || typeof raw !== 'object') return { ...d };
  return {
    inferenceIntervalMs: clampInt(raw.inferenceIntervalMs, 100, 2000, d.inferenceIntervalMs),
    baselineIntervalMs: clampInt(raw.baselineIntervalMs, 100, 5000, d.baselineIntervalMs),
    keyframeIntervalMs: clampInt(raw.keyframeIntervalMs, 250, 10000, d.keyframeIntervalMs),
    kConfirm: clampInt(raw.kConfirm, 1, 5, d.kConfirm),
    mWindow: clampInt(raw.mWindow, 1, 6, d.mWindow),
    emptyFramesBeforeReset: clampInt(raw.emptyFramesBeforeReset, 1, 10, d.emptyFramesBeforeReset),
    personScoreThreshold: clampFloat(raw.personScoreThreshold, 0.1, 0.9, d.personScoreThreshold),
    contrastEnhance: coerceBool(raw.contrastEnhance, d.contrastEnhance),
    minAspect: clampFloat(raw.minAspect, 0.3, 3, d.minAspect),
    maxAspect: clampFloat(raw.maxAspect, 1, 10, d.maxAspect),
    minBoxArea: clampFloat(raw.minBoxArea, 0.0005, 0.1, d.minBoxArea),
  };
}

/** Sanitize an optional install location; absent/invalid values stay undefined. */
function normalizeLocation(raw: any): { lat: number; lng: number } | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const lat = typeof raw.lat === 'number' && Number.isFinite(raw.lat) ? raw.lat : undefined;
  const lng = typeof raw.lng === 'number' && Number.isFinite(raw.lng) ? raw.lng : undefined;
  if (lat === undefined || lng === undefined) return undefined;
  if (lat < -90 || lat > 90 || lng < -180 || lng > 180) return undefined;
  return { lat, lng };
}

function normalizeCamera(raw: any): Camera | null {
  if (!raw || typeof raw !== 'object') return null;
  const ip = typeof raw.ip === 'string' ? raw.ip.trim() : '';
  const host = typeof raw.host === 'string' ? raw.host.trim() : '';
  const rawTag = typeof raw.tag === 'string' ? raw.tag.trim() : '';
  // A camera is valid with an IP, a stable host, or a tag (seeded placeholders).
  if (!ip && !host && !rawTag) return null;
  // Migration: pre-tag/host cameras derive a tag from name/ip.
  const tag = rawTag || slugifyTag(raw.name || ip || host || raw.id || '');
  const id = typeof raw.id === 'string' && raw.id ? raw.id : tag || host || ip;
  const name = typeof raw.name === 'string' ? raw.name : tag || ip;
  // v3 stores written by older builds have no `settings`; default them.
  const settings = normalizeSettings(raw.settings);
  // Migration: older cameras have no day/night profiles — seed both from the
  // effective settings so behaviour is unchanged until the user tunes them.
  const day = raw.day != null ? normalizeSettings(raw.day) : { ...settings };
  // The night profile is migrated to the generic night baseline when it is
  // missing or still exactly the factory day defaults (the old seed was a
  // no-op at night). A profile the user has customized is always preserved.
  const rawNight = raw.night != null ? normalizeSettings(raw.night) : null;
  const night =
    rawNight == null || isFactoryDefaultSettings(rawNight)
      ? { ...DEFAULT_NIGHT_SETTINGS }
      : rawNight;
  const dayNight: DayNightMode =
    raw.dayNight === 'day' || raw.dayNight === 'night' || raw.dayNight === 'auto'
      ? raw.dayNight
      : 'auto';
  return { id, name, tag, host, ip, settings, day, night, dayNight };
}

/** Normalize an arbitrary persisted camera list, dropping malformed entries. */
function normalizeCameras(raw: any): Camera[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .map((c): Camera | null => normalizeCamera(c))
    .filter((c): c is Camera => c !== null);
}

function normalizeDashboard(raw: any): Dashboard | null {
  if (!raw || typeof raw !== 'object') return null;
  const id = typeof raw.id === 'string' && raw.id ? raw.id : '';
  if (!id) return null;
  const name = typeof raw.name === 'string' && raw.name ? raw.name : id;
  const cameraIds = Array.isArray(raw.cameraIds)
    ? Array.from(
        new Set(
          (raw.cameraIds as any[]).filter(
            (x): x is string => typeof x === 'string' && x.length > 0,
          ),
        ),
      )
    : [];
  return { id, name, cameraIds };
}

/**
 * Canonicalize a store so invariants always hold:
 *  - the default dashboard exists, is named "All cameras", and contains ALL cameras
 *  - custom dashboards only reference existing cameras
 *  - activeDashboardId references an existing dashboard (else default)
 *  - focusedId references an existing camera (else undefined)
 *
 * The legacy `nightPresetVersion` field is deliberately ignored/never emitted;
 * the persisted `version` is the only marker.
 */
export function sanitizeStore(
  cameras: Camera[],
  dashboards: Dashboard[],
  activeDashboardId: string | undefined,
  focusedId: string | undefined,
  detection: any,
  location?: any,
): CameraStore {
  const cameraIds = cameras.map(c => c.id);
  const cameraIdSet = new Set(cameraIds);

  // De-dupe dashboards by id, dropping malformed entries.
  const byId = new Map<string, Dashboard>();
  for (const raw of dashboards) {
    const d = normalizeDashboard(raw);
    if (d && !byId.has(d.id)) byId.set(d.id, d);
  }

  // The default dashboard is special: it always mirrors the full camera list.
  byId.delete(DEFAULT_DASHBOARD_ID);
  const defaultDashboard: Dashboard = {
    id: DEFAULT_DASHBOARD_ID,
    name: DEFAULT_DASHBOARD_NAME,
    cameraIds: [...cameraIds],
  };

  const custom = Array.from(byId.values()).map(d => ({
    ...d,
    cameraIds: d.cameraIds.filter(id => cameraIdSet.has(id)),
  }));

  const list: Dashboard[] = [defaultDashboard, ...custom];
  const active = list.some(d => d.id === activeDashboardId)
    ? (activeDashboardId as string)
    : DEFAULT_DASHBOARD_ID;
  const focus = focusedId && cameraIdSet.has(focusedId) ? focusedId : undefined;

  return {
    version: CURRENT_VERSION,
    cameras,
    dashboards: list,
    activeDashboardId: active,
    focusedId: focus,
    detection: normalizeDetection(detection),
    location: normalizeLocation(location),
  };
}

/**
 * The conditional DML of the generic-night-preset rollout. For every night
 * field still equal to the pre-preset default (`DEFAULT_CAMERA_SETTINGS`, what
 * night was seeded from before this preset existed), adopt the new
 * `DEFAULT_NIGHT_SETTINGS` value; leave every other field untouched. Field
 * user edits are preserved, and `day`/effective `settings` are never touched.
 */
function rollNightPreset(store: CameraStore): CameraStore {
  const keys = Object.keys(DEFAULT_NIGHT_SETTINGS) as (keyof CameraSettings)[];
  return {
    ...store,
    cameras: store.cameras.map(camera => {
      const night = { ...camera.night };
      for (const key of keys) {
        // Adopt the new preset only where the field is still the OLD default.
        if (night[key] === DEFAULT_CAMERA_SETTINGS[key]) {
          (night as Record<string, unknown>)[key] = DEFAULT_NIGHT_SETTINGS[key];
        }
      }
      return { ...camera, night };
    }),
  };
}

/**
 * The superseded night exposure value. The v4 night preset shipped `780`, which
 * sits just past an OV2640 exposure cliff and blows the frame out to white; v5
 * lowers only the cameras still holding it. See `DEFAULT_NIGHT_SETTINGS`.
 */
const BLOWN_NIGHT_AEC_VALUE = 780;

/**
 * The conditional DML of the v5 night-exposure correction. Any Night or
 * effective profile field still at the blown-up preset value (`780`) is lowered
 * to the current baseline; a value the user has tuned is left alone, the Day
 * profile is never touched, and cameras already below the cliff are returned
 * unchanged (same object) so untouched cameras stay byte-identical.
 */
function fixNightExposure(store: CameraStore): CameraStore {
  const target = DEFAULT_NIGHT_SETTINGS.aecValue;
  return {
    ...store,
    cameras: store.cameras.map(camera => {
      const night =
        camera.night.aecValue === BLOWN_NIGHT_AEC_VALUE
          ? { ...camera.night, aecValue: target }
          : camera.night;
      const settings =
        camera.settings.aecValue === BLOWN_NIGHT_AEC_VALUE
          ? { ...camera.settings, aecValue: target }
          : camera.settings;
      if (night === camera.night && settings === camera.settings) return camera;
      return { ...camera, night, settings };
    }),
  };
}

/**
 * The conditional DML of the v6 resolution upgrade. The app previously shipped
 * `framesize: 6` for both profiles; measured on the connected firmware that
 * control value renders QVGA 320×240 — far smaller than the YOLO model's 640px
 * input. Any Day, Night, or effective profile still on that legacy default is
 * moved to `DEFAULT_CAMERA_SETTINGS.framesize` (VGA 640×480); any other value
 * is an explicit user choice and is left untouched.
 */
function upgradeTinyFramesize(store: CameraStore): CameraStore {
  const target = DEFAULT_CAMERA_SETTINGS.framesize;
  const upgrade = (settings: CameraSettings): CameraSettings =>
    settings.framesize === LEGACY_TINY_FRAMESIZE
      ? { ...settings, framesize: target }
      : settings;
  return {
    ...store,
    cameras: store.cameras.map(camera => {
      const day = upgrade(camera.day);
      const night = upgrade(camera.night);
      const settings = upgrade(camera.settings);
      // Untouched cameras stay byte-identical (same object).
      if (day === camera.day && night === camera.night && settings === camera.settings) {
        return camera;
      }
      return { ...camera, day, night, settings };
    }),
  };
}

/**
 * One ordered, forward-only migration: transforms a store at `version - 1`
 * into a store at `version`. `apply` must be pure and total.
 */
export type StoreMigration = {
  version: number;
  apply(store: CameraStore): CameraStore;
};

/**
 * The migration sequence, ascending by version. Each entry owns one shape
 * coercion or conditional change so no version branch is needed elsewhere.
 */
export const MIGRATIONS: StoreMigration[] = [
  {
    // v1: legacy `{ ip }` payload → a single-camera store.
    version: 1,
    apply(store) {
      const camera = normalizeCamera(store);
      return {
        ...(store as unknown as Record<string, unknown>),
        version: 1,
        cameras: camera ? [camera] : [],
      } as unknown as CameraStore;
    },
  },
  {
    // v2: normalize the camera list and add the focused-camera pointer.
    version: 2,
    apply(store) {
      const cameras = normalizeCameras(store.cameras);
      const rawFocus = (store as any).focusedId;
      const focusedId = cameras.some(c => c.id === rawFocus)
        ? rawFocus
        : cameras[0]?.id;
      return {
        ...(store as any),
        version: 2,
        cameras,
        focusedId,
      } as CameraStore;
    },
  },
  {
    // v3: introduce the default dashboard (mirrors the old v2→v3 behavior).
    version: 3,
    apply(store) {
      const cameras = normalizeCameras(store.cameras);
      const rawFocus = (store as any).focusedId;
      const focusedId = cameras.some(c => c.id === rawFocus)
        ? rawFocus
        : cameras[0]?.id;
      const dashboards = Array.isArray((store as any).dashboards)
        ? (store as any).dashboards
        : [];
      const sanitized = sanitizeStore(
        cameras,
        dashboards,
        (store as any).activeDashboardId,
        focusedId,
        (store as any).detection,
        (store as any).location,
      );
      return { ...sanitized, version: 3 };
    },
  },
  {
    // v4: the generic night-preset rollout (conditional DML).
    version: 4,
    apply(store) {
      const cameras = normalizeCameras(store.cameras);
      return { ...rollNightPreset({ ...store, cameras }), version: 4 };
    },
  },
  {
    // v5: lower the night baseline's locked exposure. The v4 preset used
    // `aecValue: 780`, which sits just past an OV2640 exposure cliff and blows
    // the night frame out to white; cameras still on that value adopt the
    // corrected baseline, user edits and the Day profile are preserved.
    version: 5,
    apply(store) {
      const cameras = normalizeCameras(store.cameras);
      return { ...fixNightExposure({ ...store, cameras }), version: 5 };
    },
  },
  {
    // v6: upgrade the legacy tiny (QVGA 320×240) default to true VGA. The YOLO
    // model input is 640px, so the old default produced frames smaller than the
    // model expects; Day, Night, and effective profiles still on it adopt the
    // new default while a resolution the user explicitly chose is preserved.
    version: 6,
    apply(store) {
      const cameras = normalizeCameras(store.cameras);
      return { ...upgradeTinyFramesize({ ...store, cameras }), version: 6 };
    },
  },
  {
    // v7: introduce the optional top-level `location` (lat/lng) used to compute
    // real solar dusk/dawn for `auto` cameras. The field is deliberately left
    // absent: a store without coordinates keeps the legacy 07:00/19:00 rule, so
    // this migration is a no-op for existing installs.
    version: 7,
    apply(store) {
      return { ...store, version: 7 };
    },
  },
];

/** The current persisted version: the highest migration version. */
export const CURRENT_VERSION = MIGRATIONS.reduce(
  (max, migration) => Math.max(max, migration.version),
  0,
);

/**
 * Detect the version a raw persisted payload starts at, from its shape.
 *  - no cameras (legacy `{ ip }`): 0
 *  - a recognised `version` (1..CURRENT-1): that version, so it runs forward
 *    from exactly where it stopped (e.g. a v4 store still needs v5)
 *  - `version: 3` with the legacy night-preset marker already set: resumes at
 *    the v4 rollout version, so the v4 rollout is NOT re-run but later
 *    migrations (v5, v6) still apply
 *  - already-current/newer: `CURRENT_VERSION`
 */
export function detectRawVersion(raw: any): number {
  if (!raw || typeof raw !== 'object') return 0;
  if (!Array.isArray(raw.cameras)) return 0; // legacy `{ ip }`

  const version =
    typeof raw.version === 'number' && Number.isFinite(raw.version)
      ? Math.floor(raw.version)
      : undefined;

  if (version === undefined) return 1; // cameras present, no recognised version
  if (version >= CURRENT_VERSION) return CURRENT_VERSION;
  if (version === 3 && (raw.nightPresetVersion ?? 0) >= NIGHT_PRESET_VERSION) {
    // The rollout already ran in an older build; resume just after it so newer
    // migrations (e.g. the v6 resolution upgrade) are still applied.
    return Math.min(NIGHT_PRESET_ROLLOUT_VERSION, CURRENT_VERSION);
  }
  // Any other known intermediate version runs forward from where it is.
  return version >= 1 ? version : 1;
}

/**
 * Normalize any persisted payload into the current store shape by running the
 * ordered migrations from its detected version, then validating the result.
 *  - legacy `{ ip }` → single-camera store
 *  - v2 `{ version: 2, cameras, focusedId }` → adds dashboards
 *  - v3 `{ version: 3, cameras, dashboards, … }` → runs the night rollout
 *  - v3 + `nightPresetVersion >= 1` → rollout already applied; resumes at v4 so
 *    later migrations (v5, v6) still run
 *  - v5 → the blown night exposure value is corrected
 *  - v6 → the legacy tiny resolution default (QVGA 320×240) is upgraded to VGA
 */
export function migrateStore(raw: any): CameraStore | null {
  if (!raw || typeof raw !== 'object') return null;

  const startVersion = detectRawVersion(raw);
  let store = { ...raw, version: startVersion } as unknown as CameraStore;

  while (store.version < CURRENT_VERSION) {
    const migration = MIGRATIONS.find(m => m.version === store.version + 1);
    if (!migration) break;
    store = migration.apply(store);
    store.version = migration.version;
  }

  // A legacy payload with no recoverable camera is not a store at all.
  if (startVersion === 0 && store.cameras.length === 0) return null;

  return sanitizeStore(
    store.cameras,
    Array.isArray(store.dashboards) ? store.dashboards : [],
    store.activeDashboardId,
    store.focusedId,
    (store as any).detection,
    (store as any).location,
  );
}

/**
 * Back-compat shim for callers written against the pre-`CURRENT_VERSION` API.
 * Runs the same conditional DML as migration v4, gated on the legacy
 * `nightPresetVersion` marker. New code should rely on `migrateStore` / the
 * persisted `version`; this remains only so existing callers/tests compile.
 */
export function applyNightPresetRollout(store: CameraStore): CameraStore {
  // `nightPresetVersion` is no longer part of `CameraStore`; read/write it via a
  // legacy-compat cast so the marker round-trips at runtime for old callers.
  const legacy = store as CameraStore & { nightPresetVersion?: number };
  if ((legacy.nightPresetVersion ?? 0) >= NIGHT_PRESET_VERSION) return store;
  return {
    ...rollNightPreset(store),
    nightPresetVersion: NIGHT_PRESET_VERSION,
  } as CameraStore;
}
