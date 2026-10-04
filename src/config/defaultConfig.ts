/**
 * Shipped default configuration.
 *
 * On a first run (no persisted store), or when the persisted store has no
 * cameras, the app seeds itself from this file. The camera entries are
 * placeholders: they carry stable `tag`s (matching the firmware's mDNS service
 * names) but no resolved IP. `resolveCameras.ts` fills in the IP at runtime by
 * scanning mDNS, so the defaults work across networks without hardcoded
 * addresses.
 */
import {
  CameraSeed,
  DEFAULT_CAMERA_SETTINGS,
  DEFAULT_DASHBOARD_ID,
  DEFAULT_DASHBOARD_NAME,
  DEFAULT_DETECTION_SETTINGS,
  DEFAULT_NIGHT_SETTINGS,
  Dashboard,
  DefaultStoreSeed,
} from '../utils/storage';

/** Fresh copy of the firmware-matching day defaults (never share references). */
function dayPreset() {
  return { ...DEFAULT_CAMERA_SETTINGS };
}

/** Fresh copy of the generic night baseline (never share references). */
function nightPreset() {
  return { ...DEFAULT_NIGHT_SETTINGS };
}

export const CAMERA_SEEDS: CameraSeed[] = [
  {
    tag: 'cam1',
    name: '',
    host: 'cam1.local',
    dayNight: 'auto',
    day: dayPreset(),
    night: nightPreset(),
  },
  {
    tag: 'cam2',
    name: '',
    host: 'cam2.local',
    dayNight: 'auto',
    day: dayPreset(),
    night: nightPreset(),
  },
];

export const DEFAULT_DASHBOARDS: Dashboard[] = [
  {
    id: DEFAULT_DASHBOARD_ID,
    name: DEFAULT_DASHBOARD_NAME,
    cameraIds: [],
  },
];

export const DEFAULT_STORE_SEED: DefaultStoreSeed = {
  version: 3,
  cameras: CAMERA_SEEDS,
  dashboards: DEFAULT_DASHBOARDS,
  detection: { ...DEFAULT_DETECTION_SETTINGS },
};

export default DEFAULT_STORE_SEED;
