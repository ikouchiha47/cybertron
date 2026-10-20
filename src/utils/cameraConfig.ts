/**
 * Pure camera/dashboard configuration model.
 *
 * This module holds type definitions, default values, and small pure helpers
 * only. Its only internal dependency is the dependency-light `sunWindow`
 * helper; it is consumed by both the migration layer (`migrations.ts`) and the
 * persistence layer (`storage.ts`) without creating a cycle.
 */
import { NightWindow, isNight } from './sunWindow';

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
  /**
   * Firmware `framesize` control value. Measured on the connected firmware:
   * 6=QVGA 320×240, 8=CIF 400×296, 9=HVGA 480×320, 10=VGA 640×480,
   * 11=SVGA 800×600, 12=XGA 1024×768. The measured mapping is authoritative —
   * the UI labels in `cameraSettings.ts` follow it, not the datasheet enum.
   *
   * The Day profile ships VGA 640×480, matching the 640px YOLO model input; the
   * Night profile ships QVGA 320×240 (its pinned exposure over-exposes at VGA).
   * Larger modes (XGA 12, …) remain per-camera opt-ins in the settings sheet.
   */
  framesize: number;
  /** When true the firmware runs with fixed exposure/gain (aec=0, agc=0). */
  exposureLock: boolean;
  aecValue: number;
  agcGain: number;
}

/**
 * The pre-VGA framesize default. The app shipped `6` for both profiles; on the
 * connected firmware that control value renders QVGA 320×240 — far smaller than
 * the 640px YOLO input — so migration v6 upgrades any profile still holding it.
 */
export const LEGACY_TINY_FRAMESIZE = 6;

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
  framesize: 10, // VGA 640x480 (matches the YOLO 640px input)
  exposureLock: false,
  aecValue: 500,
  agcGain: 30,
};

/**
 * Generic night baseline (not a firmware boot default). At night we lock the
 * exposure (→ aec=0, agc=0) so AEC/AGC stop hunting in low light, then push
 * fixed exposure and gain values. Locking (rather than auto) is deliberate: it
 * keeps the image steady — no brightness pumping/flicker.
 *
 * These are the manually validated low-light values pulled from the connected
 * camera: `aecValue: 719` with `agcGain: 2`, `brightness: 1`, `contrast: 1`,
 * `saturation: -1`, AWB left on with the Cloudy preset. `framesize` is HVGA.
 * Intended as a starting point to be tuned per camera; `night` is only
 * (re)seeded from this when it is missing or still untouched day defaults,
 * never once customized. LED and quality are deliberately left at the app
 * defaults (off / high quality), and mirror/flip are untouched.
 */
export const DEFAULT_NIGHT_SETTINGS: CameraSettings = {
  ...DEFAULT_CAMERA_SETTINGS,
  brightness: 1,
  contrast: 1,
  saturation: -1,
  exposureLock: true, // → aec=0, agc=0
  aecValue: 719,
  agcGain: 2,
  wbMode: 2, // Cloudy, with AWB on — as validated live
  awb: true,
  framesize: 9, // HVGA 480x320
};

/**
 * Day profile. The camera's own free-running AEC hunts and blows the frame out
 * near the sensor's exposure cliff, and cannot be capped while auto — so the
 * day exposure is **locked** (`exposureLock: true` → aec=0, agc=0) with a fixed
 * `aecValue` seed. No background loop adjusts it; any future auto-adjustment
 * has to prove itself before it ships.
 */
export const DEFAULT_DAY_SETTINGS: CameraSettings = {
  ...DEFAULT_CAMERA_SETTINGS,
  exposureLock: true, // manual fixed exposure
  aecValue: 500, // fixed day exposure seed
  agcGain: 15,
  framesize: 6, // QVGA 320x240
};

/**
 * Global (not per-camera) native detection-engine tuning. Mirrors the fields
 * parsed by `InferencePipeline.setDetectionConfig` in DoorCamEngine.kt and is
 * pushed to the native engine on startup and on every change.
 */
export interface DetectionSettings {
  /** Inference cadence per camera (ms). Lower = faster, more CPU. */
  inferenceIntervalMs: number;
  /**
   * Idle baseline inference cadence (ms) when there is no motion and no active
   * track. Motion boosts the rate to `inferenceIntervalMs`; a still scene still
   * infers at this baseline.
   */
  baselineIntervalMs: number;
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
  /**
   * Run CLAHE contrast enhancement on the detection bitmap before inference.
   * Helps dark/low-contrast subjects (black clothing, backlit silhouettes);
   * the displayed stream is never affected.
   */
  contrastEnhance: boolean;
  /**
   * Minimum box height/width ratio accepted as a person. Lower = accept wider,
   * squat, partial, or close-up people (a box cut off by the frame edge).
   */
  minAspect: number;
  /** Maximum box height/width ratio accepted as a person. */
  maxAspect: number;
  /** Minimum normalized box area (fraction of the frame) accepted as a person. */
  minBoxArea: number;
}

export const DEFAULT_DETECTION_SETTINGS: DetectionSettings = {
  inferenceIntervalMs: 200,
  baselineIntervalMs: 300,
  keyframeIntervalMs: 1000,
  kConfirm: 1,
  mWindow: 3,
  emptyFramesBeforeReset: 3,
  personScoreThreshold: 0.3,
  contrastEnhance: true,
  minAspect: 0.8,
  maxAspect: 6.0,
  minBoxArea: 0.002,
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
  /**
   * Optional install location, global to the store. When set, `auto` cameras
   * are scheduled from real solar dusk/dawn; when absent the legacy
   * 07:00/19:00 wall-clock rule is used (see `activeProfileSlot`).
   */
  location?: { lat: number; lng: number };
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
 * Explicit `day`/`night` are honoured; `auto` uses the solar `window` when one
 * is supplied (real dusk/dawn), otherwise the legacy 07:00–18:59 local rule.
 */
export function activeProfileSlot(
  camera: Camera,
  now: Date,
  window: NightWindow | null,
): ProfileSlot {
  if (camera.dayNight === 'day') return 'day';
  if (camera.dayNight === 'night') return 'night';
  if (window) return isNight(now, window) ? 'night' : 'day';
  return now.getHours() >= 7 && now.getHours() < 19 ? 'day' : 'night';
}

/** The settings for the profile that is active at `now` (with an optional solar window). */
export function resolveProfile(
  camera: Camera,
  now: Date,
  window: NightWindow | null,
): CameraSettings {
  return activeProfileSlot(camera, now, window) === 'day' ? camera.day : camera.night;
}
