import {
  Camera,
  CameraSettings,
  DEFAULT_CAMERA_SETTINGS,
  activeProfileSlot,
  normalizeSettings,
} from './storage';

/**
 * Firmware semantics (see audrino/CameraWebServer/app_httpd.cpp):
 *  - `/control?var=X&val=Y` sets a sensor/control value; `/status` returns all
 *    current values as JSON numbers.
 *  - LED: there is NO separate enable toggle. `led_duty` (exposed as
 *    `led_intensity`) is the single control: `enable_led(en)` drives
 *    `en ? led_duty : 0`, so `led_intensity = 0` means OFF. The LED is turned
 *    on automatically while streaming when `led_duty > 0`. During streaming the
 *    firmware caps duty at CONFIG_LED_MAX_INTENSITY (255), i.e. our full 0..255
 *    range is safe.
 * Therefore `ledOn` is an app-level convenience: desired hardware value is
 * `ledOn ? ledIntensity : 0`.
 */

const TIMEOUT_MS = 1500;

async function fetchWithTimeout(url: string): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    return await fetch(url, { signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

/** GET /status → numeric fields. Returns {} on any failure. */
export async function fetchStatus(ip: string): Promise<Record<string, number>> {
  try {
    const res = await fetchWithTimeout(`http://${ip}/status`);
    if (!res.ok) return {};
    const data: any = await res.json();
    if (!data || typeof data !== 'object') return {};
    const out: Record<string, number> = {};
    for (const [k, v] of Object.entries(data)) {
      if (typeof v === 'number' && Number.isFinite(v)) out[k] = v;
    }
    return out;
  } catch (e) {
    console.log('[DoorCam] fetchStatus failed', ip, e);
    return {};
  }
}

/** GET /control?var=v&val=val. Never throws. */
export async function pushSetting(ip: string, v: string, val: number): Promise<void> {
  try {
    await fetchWithTimeout(
      `http://${ip}/control?var=${encodeURIComponent(v)}&val=${encodeURIComponent(String(val))}`,
    );
  } catch (e) {
    console.log('[DoorCam] pushSetting failed', ip, v, val, e);
  }
}

/** The firmware variables this app owns. `ledOn`/`ledIntensity` share one. */
export const MANAGED_VARS = [
  'quality',
  'brightness',
  'contrast',
  'saturation',
  'hmirror',
  'vflip',
  'wb_mode',
  'awb',
  'led_intensity',
  'framesize',
  'aec',
  'agc',
  'aec_value',
  'agc_gain',
] as const;

export type ManagedVar = (typeof MANAGED_VARS)[number];

/** Setting key → primary firmware variable it writes. */
export const SETTING_VAR: Record<keyof CameraSettings, ManagedVar> = {
  quality: 'quality',
  brightness: 'brightness',
  contrast: 'contrast',
  saturation: 'saturation',
  hmirror: 'hmirror',
  vflip: 'vflip',
  wbMode: 'wb_mode',
  awb: 'awb',
  ledOn: 'led_intensity',
  ledIntensity: 'led_intensity',
  framesize: 'framesize',
  // Exposure lock drives BOTH aec and agc; see managedVarsForSetting.
  exposureLock: 'aec',
  aecValue: 'aec_value',
  agcGain: 'agc_gain',
};

/**
 * Every firmware variable affected when a setting key changes. Most map 1:1,
 * but `exposureLock` toggles both `aec` and `agc`, and the two LED settings
 * share `led_intensity`.
 */
export function managedVarsForSetting(key: keyof CameraSettings): ManagedVar[] {
  switch (key) {
    case 'exposureLock': return ['aec', 'agc'];
    case 'ledOn':
    case 'ledIntensity': return ['led_intensity'];
    default: return [SETTING_VAR[key]];
  }
}

/** Firmware value for a managed var given app settings, or undefined if unmapped. */
export function hardwareValueForVar(settings: CameraSettings, varName: ManagedVar): number {
  switch (varName) {
    case 'quality': return settings.quality;
    case 'brightness': return settings.brightness;
    case 'contrast': return settings.contrast;
    case 'saturation': return settings.saturation;
    case 'hmirror': return settings.hmirror ? 1 : 0;
    case 'vflip': return settings.vflip ? 1 : 0;
    case 'wb_mode': return settings.wbMode;
    case 'awb': return settings.awb ? 1 : 0;
    case 'led_intensity': return settings.ledOn ? settings.ledIntensity : 0;
    case 'framesize': return settings.framesize;
    case 'aec': return settings.exposureLock ? 0 : 1;
    case 'agc': return settings.exposureLock ? 0 : 1;
    case 'aec_value': return settings.aecValue;
    case 'agc_gain': return settings.agcGain;
  }
}

/**
 * Fetch the camera's status and push only the managed values that differ from
 * `camera.settings`. Sequential, short-timeout, never throws.
 */
export async function syncCamera(camera: Camera): Promise<void> {
  try {
    const status = await fetchStatus(camera.ip);
    if (!status || Object.keys(status).length === 0) return;
    for (const varName of MANAGED_VARS) {
      const current = status[varName];
      if (typeof current !== 'number') continue;
      // Camera without an LED reports -1; don't try to drive it.
      if (varName === 'led_intensity' && current < 0) continue;
      const desired = hardwareValueForVar(camera.settings, varName);
      if (current !== desired) {
        await pushSetting(camera.ip, varName, desired);
      }
    }
  } catch (e) {
    console.log('[DoorCam] syncCamera failed', camera.id, e);
  }
}

/**
 * Map a firmware `/status` payload onto app settings.
 *
 * Firmware field → CameraSettings:
 *   framesize            → framesize
 *   quality              → quality
 *   brightness           → brightness
 *   contrast             → contrast
 *   saturation           → saturation
 *   hmirror              → hmirror (number > 0)
 *   vflip                → vflip (number > 0)
 *   wb_mode              → wbMode
 *   awb                  → awb (number > 0)
 *   aec + agc            → exposureLock (true only when BOTH are 0)
 *   aec_value            → aecValue
 *   agc_gain             → agcGain
 *   led_intensity        → ledOn (> 0) + ledIntensity (>= 0 only)
 *
 * Unknown fields are ignored and every mapped value is clamped by the same
 * normalizer used for persisted settings. Fields absent from `/status` are
 * omitted so callers can fall back to `DEFAULT_CAMERA_SETTINGS`.
 */
export function settingsFromStatus(status: Record<string, number>): Partial<CameraSettings> {
  const raw: Partial<CameraSettings> = {};
  const num = (key: string): number | undefined => {
    const v = status[key];
    return typeof v === 'number' && Number.isFinite(v) ? v : undefined;
  };
  const assign = <K extends keyof CameraSettings>(key: K, value: CameraSettings[K] | undefined) => {
    if (value !== undefined) (raw as any)[key] = value;
  };

  assign('framesize', num('framesize'));
  assign('quality', num('quality'));
  assign('brightness', num('brightness'));
  assign('contrast', num('contrast'));
  assign('saturation', num('saturation'));

  const hmirror = num('hmirror');
  assign('hmirror', hmirror === undefined ? undefined : hmirror > 0);
  const vflip = num('vflip');
  assign('vflip', vflip === undefined ? undefined : vflip > 0);

  assign('wbMode', num('wb_mode'));
  const awb = num('awb');
  assign('awb', awb === undefined ? undefined : awb > 0);

  const aec = num('aec');
  const agc = num('agc');
  if (aec !== undefined && agc !== undefined) {
    raw.exposureLock = aec === 0 && agc === 0;
  }

  assign('aecValue', num('aec_value'));
  assign('agcGain', num('agc_gain'));

  const led = num('led_intensity');
  if (led !== undefined && led >= 0) {
    raw.ledOn = led > 0;
    raw.ledIntensity = led;
  }

  // Clamp via the persisted-settings normalizer, then return only mapped keys.
  const normalized = normalizeSettings({ ...DEFAULT_CAMERA_SETTINGS, ...raw });
  const out: Partial<CameraSettings> = {};
  for (const key of Object.keys(raw) as (keyof CameraSettings)[]) {
    (out as any)[key] = normalized[key];
  }
  return out;
}

/** True when settings still exactly match the shipped firmware defaults. */
export function isDefaultSettings(settings: CameraSettings): boolean {
  return (Object.keys(DEFAULT_CAMERA_SETTINGS) as (keyof CameraSettings)[]).every(
    key => settings[key] === DEFAULT_CAMERA_SETTINGS[key],
  );
}

/** Local hour (0–23) used to resolve the active Day/Night slot. */
export function currentLocalHour(): number {
  return new Date().getHours();
}

/**
 * Fetch a camera's live `/status` and derive its settings. Returns the camera
 * unchanged when unreachable or when `/status` exposes no mapped fields.
 *
 * Adoption is **slot-aware**: the fetched values are written only to the
 * profile that is active for the camera at `hour` (defaults to the current
 * local hour) and to the effective `settings`. The inactive profile is left
 * untouched, so a daytime launch can never clobber the night baseline.
 */
export async function adoptCameraStatus(
  camera: Camera,
  hour: number = currentLocalHour(),
): Promise<Camera> {
  if (!camera.ip) return camera;
  const status = await fetchStatus(camera.ip);
  if (!status || Object.keys(status).length === 0) return camera;
  const patch = settingsFromStatus(status);
  if (Object.keys(patch).length === 0) return camera;
  const slot = activeProfileSlot(camera, hour);
  if (slot === 'day') {
    const day = { ...camera.day, ...patch } as CameraSettings;
    return { ...camera, settings: { ...day }, day };
  }
  const night = { ...camera.night, ...patch } as CameraSettings;
  return { ...camera, settings: { ...night }, night };
}

// ---------------------------------------------------------------------------
// UI table
// ---------------------------------------------------------------------------

export type SettingKind = 'slider' | 'toggle' | 'wb' | 'framesize';

export interface SettingDef {
  key: keyof CameraSettings;
  label: string;
  kind: SettingKind;
  min?: number;
  max?: number;
  step?: number;
  varName: ManagedVar;
  note?: string;
}

export const WB_MODES = ['Auto', 'Sunny', 'Cloudy', 'Office', 'Home'];

/** ESP32 framesize enum values the UI exposes (see app_httpd.cpp /status). */
export const FRAMESIZE_MODES: { value: number; label: string }[] = [
  { value: 4, label: 'QVGA 320×240' },
  { value: 5, label: 'CIF 400×296' },
  { value: 6, label: 'HVGA 480×320' },
  { value: 7, label: 'VGA 640×480' },
  { value: 8, label: 'SVGA 800×600' },
  { value: 9, label: 'XGA 1024×768' },
];

export const SETTING_DEFS: SettingDef[] = [
  { key: 'quality', label: 'Quality', kind: 'slider', min: 10, max: 63, step: 1, varName: 'quality', note: 'Lower = better' },
  { key: 'framesize', label: 'Resolution', kind: 'framesize', varName: 'framesize', note: 'Higher = sharper but slower' },
  { key: 'brightness', label: 'Brightness', kind: 'slider', min: -2, max: 2, step: 1, varName: 'brightness' },
  { key: 'contrast', label: 'Contrast', kind: 'slider', min: -2, max: 2, step: 1, varName: 'contrast' },
  { key: 'saturation', label: 'Saturation', kind: 'slider', min: -2, max: 2, step: 1, varName: 'saturation' },
  { key: 'hmirror', label: 'Mirror', kind: 'toggle', varName: 'hmirror' },
  { key: 'vflip', label: 'Flip', kind: 'toggle', varName: 'vflip' },
  { key: 'wbMode', label: 'White balance', kind: 'wb', min: 0, max: 4, step: 1, varName: 'wb_mode' },
  { key: 'awb', label: 'Auto white balance', kind: 'toggle', varName: 'awb' },
  { key: 'exposureLock', label: 'Exposure lock (night)', kind: 'toggle', varName: 'aec', note: 'Freezes exposure/gain (aec=0, agc=0)' },
  { key: 'aecValue', label: 'Exposure value', kind: 'slider', min: 0, max: 1200, step: 1, varName: 'aec_value' },
  { key: 'agcGain', label: 'Gain', kind: 'slider', min: 0, max: 128, step: 1, varName: 'agc_gain' },
  { key: 'ledOn', label: 'LED', kind: 'toggle', varName: 'led_intensity' },
  { key: 'ledIntensity', label: 'LED intensity', kind: 'slider', min: 0, max: 255, step: 1, varName: 'led_intensity' },
];
