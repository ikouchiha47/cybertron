/**
 * Pure camera/dashboard configuration model.
 *
 * This module holds type definitions, default values, and small pure helpers
 * only. It intentionally imports nothing internal so it can be consumed by
 * both the migration layer (`migrations.ts`) and the persistence layer
 * (`storage.ts`) without creating a cycle.
 */

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
 * Generic night baseline (not a firmware boot default). At night we lock the
 * exposure (→ aec=0, agc=0) and fix the white balance so AWB stops hunting in
 * low light, then push a higher exposure value and moderate gain. Everything
 * else matches the day defaults. Intended as a starting point to be tuned per
 * camera; `night` is only (re)seeded from this when it is missing or still
 * untouched day defaults, never once customized.
 */
export const DEFAULT_NIGHT_SETTINGS: CameraSettings = {
  ...DEFAULT_CAMERA_SETTINGS,
  exposureLock: true, // → aec=0, agc=0
  aecValue: 780,
  agcGain: 15,
  wbMode: 1, // Sunny — fixed WB
  framesize: 6, // HVGA 480x320
};

/**
 * Global (not per-camera) native detection-engine tuning. Mirrors the fields
 * parsed by `InferencePipeline.setDetectionConfig` in DoorCamEngine.kt and is
 * pushed to the native engine on startup and on every change.
 */
export interface DetectionSettings {
  /** Inference cadence per camera (ms). Lower = faster, more CPU. */
  inferenceIntervalMs: number;
  /** Forced-keyframe cadence (ms): max wait for inference when no motion. */
  keyframeIntervalMs: number;
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
  keyframeIntervalMs: 1000,
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
  /**
   * The single persisted schema version. Advanced one ordered migration at a
   * time (see `migrations.ts`); equals `CURRENT_VERSION` after loading.
   */
  version: number;
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

/** Lowercase, hyphenated tag derived from a name/IP/service name. */
export function slugifyTag(value: string): string {
  return (value || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
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
