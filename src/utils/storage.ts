import AsyncStorage from '@react-native-async-storage/async-storage';

const KEY = 'doorcam_config';

export const DEFAULT_DASHBOARD_ID = 'default';
export const DEFAULT_DASHBOARD_NAME = 'All cameras';

/**
 * Per-camera settings managed by the app (app is the source of truth).
 * Values mirror the firmware's boot defaults so a fresh camera already matches.
 */
export interface CameraSettings {
  quality: number;
  brightness: number;
  contrast: number;
  saturation: number;
  hmirror: boolean;
  vflip: boolean;
  wbMode: number;
  awb: boolean;
  ledOn: boolean;
  ledIntensity: number;
  /** ESP32 sensor framesize enum (4=QVGA … 9=XGA). */
  framesize: number;
  /** When true the firmware runs with fixed exposure/gain (aec=0, agc=0). */
  exposureLock: boolean;
  aecValue: number;
  agcGain: number;
}

export const DEFAULT_CAMERA_SETTINGS: CameraSettings = {
  quality: 12,
  brightness: 1,
  contrast: 0,
  saturation: -2,
  hmirror: true,
  vflip: true,
  wbMode: 0,
  awb: true,
  ledOn: false,
  ledIntensity: 0,
  framesize: 6, // HVGA 480x320
  exposureLock: false,
  aecValue: 500,
  agcGain: 30,
};

/**
 * Global (not per-camera) native detection-engine tuning. Mirrors the fields
 * parsed by `InferencePipeline.setDetectionConfig` in DoorCamEngine.kt and is
 * pushed to the native engine on startup and on every change.
 */
export interface DetectionSettings {
  /** Inference cadence per camera (ms). Lower = faster, more CPU. */
  inferenceIntervalMs: number;
  /** K-of-M temporal voting: confirm once K positives in the window. */
  kConfirm: number;
  /** Sliding window size (M) for temporal voting. */
  mWindow: number;
  /** Consecutive empty frames before an active detection resets. */
  emptyFramesBeforeReset: number;
  /** Min detector score (0..1) for a person box to count as positive. */
  personScoreThreshold: number;
}

export const DEFAULT_DETECTION_SETTINGS: DetectionSettings = {
  inferenceIntervalMs: 200,
  kConfirm: 1,
  mWindow: 3,
  emptyFramesBeforeReset: 3,
  personScoreThreshold: 0.3,
};

export type DayNightMode = 'day' | 'night' | 'auto';
export type ProfileSlot = 'day' | 'night';

/** A profile-scoped edit coming from the settings sheet. */
export type CameraSettingsChange =
  | { kind: 'patch'; slot: ProfileSlot; patch: Partial<CameraSettings> }
  | { kind: 'copy'; from: ProfileSlot; to: ProfileSlot };

export interface Camera {
  /** Stable identity: the mDNS service name (never the resolved IP). */
  id: string;
  name: string;
  /**
   * Stable, human/mDNS-friendly tag (e.g. `cam1`). Used to re-match a camera
   * to a discovered device when neither `id` nor `host` match.
   */
  tag: string;
  /**
   * Stable mDNS hostname (e.g. `doorcam-cam1.local`), may be '' when the
   * camera was added by manual IP. Used by dynamic IP resolution.
   */
  host: string;
  /** Last resolved IP address. Dynamic: refreshed from mDNS (see resolveCameras). */
  ip: string;
  /** Currently-applied effective settings (resolved from day/night). */
  settings: CameraSettings;
  /** Day profile. */
  day: CameraSettings;
  /** Night profile. */
  night: CameraSettings;
  dayNight: DayNightMode;
}

export interface Dashboard {
  id: string;
  name: string;
  cameraIds: string[];
}

export interface CameraStore {
  version: 3;
  cameras: Camera[];
  dashboards: Dashboard[];
  activeDashboardId: string;
  focusedId?: string;
  /** Global native detection-engine tuning (app-wide, not per camera). */
  detection: DetectionSettings;
}

/** A camera entry in the shipped default config (no resolved IP required). */
export interface CameraSeed {
  /** Stable mDNS service name; defaults to `tag`. */
  id?: string;
  tag: string;
  name: string;
  /** mDNS hostname, may be ''. */
  host: string;
  /** Optional starting IP (normally omitted; resolved dynamically). */
  ip?: string;
  dayNight: DayNightMode;
  day: CameraSettings;
  night: CameraSettings;
}

/** Shape of `src/config/defaultConfig.ts`, used to seed a first-run store. */
export interface DefaultStoreSeed {
  version: 3;
  cameras: CameraSeed[];
  dashboards: Dashboard[];
  /** Global detection tuning seed; falls back to defaults when omitted. */
  detection?: DetectionSettings;
}

/** @deprecated Legacy single-camera shape, kept for back-compat callers. */
export interface CamConfig {
  ip: string;
}

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

/** Lowercase, hyphenated tag derived from a name/IP/service name. */
export function slugifyTag(value: string): string {
  return (value || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
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

/** Sanitize persisted global detection settings, clamping to engine ranges. */
export function normalizeDetection(raw: any): DetectionSettings {
  const d = DEFAULT_DETECTION_SETTINGS;
  if (!raw || typeof raw !== 'object') return { ...d };
  return {
    inferenceIntervalMs: clampInt(raw.inferenceIntervalMs, 100, 2000, d.inferenceIntervalMs),
    kConfirm: clampInt(raw.kConfirm, 1, 5, d.kConfirm),
    mWindow: clampInt(raw.mWindow, 1, 6, d.mWindow),
    emptyFramesBeforeReset: clampInt(raw.emptyFramesBeforeReset, 1, 10, d.emptyFramesBeforeReset),
    personScoreThreshold: clampFloat(raw.personScoreThreshold, 0.1, 0.9, d.personScoreThreshold),
  };
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
  const night = raw.night != null ? normalizeSettings(raw.night) : { ...settings };
  const dayNight: DayNightMode =
    raw.dayNight === 'day' || raw.dayNight === 'night' || raw.dayNight === 'auto'
      ? raw.dayNight
      : 'auto';
  return { id, name, tag, host, ip, settings, day, night, dayNight };
}

/**
 * Which profile slot is currently active for a camera.
 * 'auto' → day during 07:00–18:59 local, night otherwise.
 */
export function activeProfileSlot(camera: Camera, hour: number): ProfileSlot {
  if (camera.dayNight === 'day') return 'day';
  if (camera.dayNight === 'night') return 'night';
  return hour >= 7 && hour < 19 ? 'day' : 'night';
}

/** The settings for the profile that is active at the given local hour. */
export function resolveProfile(camera: Camera, hour: number): CameraSettings {
  return activeProfileSlot(camera, hour) === 'day' ? camera.day : camera.night;
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
 */
function sanitizeStore(
  cameras: Camera[],
  dashboards: Dashboard[],
  activeDashboardId: string | undefined,
  focusedId: string | undefined,
  detection: any,
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
    version: 3,
    cameras,
    dashboards: list,
    activeDashboardId: active,
    focusedId: focus,
    detection: normalizeDetection(detection),
  };
}

/**
 * Normalize any persisted payload into the v3 shape.
 * - v3 `{ version: 3, cameras, dashboards, activeDashboardId }` → sanitized store
 * - v2 `{ version: 2, cameras, focusedId }` → default dashboard containing all cameras
 * - legacy `{ ip }` (no version / no cameras) → single-camera store with a default dashboard
 */
export function migrateStore(raw: any): CameraStore | null {
  if (!raw || typeof raw !== 'object') return null;

  if (raw.version === 3 && Array.isArray(raw.cameras)) {
    const cameras = (raw.cameras as any[])
      .map((c): Camera | null => normalizeCamera(c))
      .filter((c): c is Camera => c !== null);
    const dashboards = Array.isArray(raw.dashboards)
      ? (raw.dashboards as any[])
      : [];
    return sanitizeStore(cameras, dashboards, raw.activeDashboardId, raw.focusedId, raw.detection);
  }

  if (raw.version === 2 && Array.isArray(raw.cameras)) {
    const cameras = (raw.cameras as any[])
      .map((c): Camera | null => normalizeCamera(c))
      .filter((c): c is Camera => c !== null);
    const focusedId = cameras.some(c => c.id === raw.focusedId)
      ? raw.focusedId
      : cameras[0]?.id;
    return sanitizeStore(cameras, [], undefined, focusedId, undefined);
  }

  // Legacy `{ ip }` installs
  const legacy = normalizeCamera(raw);
  if (legacy) return sanitizeStore([legacy], [], undefined, legacy.id, undefined);

  return null;
}

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
 */
export async function loadCameras(seed?: DefaultStoreSeed): Promise<CameraStore> {
  const empty = sanitizeStore([], [], undefined, undefined, undefined);
  const raw = await AsyncStorage.getItem(KEY);
  let store: CameraStore | null = null;
  if (raw) {
    try {
      store = migrateStore(JSON.parse(raw));
    } catch {
      store = null;
    }
  }
  if (!store || store.cameras.length === 0) {
    if (seed && seed.cameras.length > 0) {
      const seeded = storeFromSeed(seed);
      try {
        await AsyncStorage.setItem(KEY, JSON.stringify(seeded));
      } catch (e) {
        console.warn('[DoorCam] failed to persist default config seed:', e);
      }
      return seeded;
    }
    return store ?? empty;
  }
  return store;
}

export async function saveCameras(store: CameraStore): Promise<void> {
  await AsyncStorage.setItem(KEY, JSON.stringify(store));
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
