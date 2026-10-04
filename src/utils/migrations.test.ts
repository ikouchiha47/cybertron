/**
 * Behavioural tests for store migration, sanitisation, and the one-time
 * generic-night-preset rollout.
 *
 * Written as product promises, not as a mirror of the implementation: what the
 * user should end up with after an upgrade, and what the app must never push to
 * hardware. No React Native, AsyncStorage, or I/O is involved.
 */
import { describe, it, expect } from 'vitest';

import {
  DEFAULT_CAMERA_SETTINGS,
  DEFAULT_DASHBOARD_ID,
  DEFAULT_DASHBOARD_NAME,
  DEFAULT_DETECTION_SETTINGS,
  DEFAULT_NIGHT_SETTINGS,
} from './cameraConfig';
import type { Camera, CameraSettings, CameraStore } from './cameraConfig';
import { NIGHT_PRESET_VERSION, applyNightPresetRollout, migrateStore, normalizeSettings, sanitizeStore } from './migrations';
import { CURRENT_VERSION, MIGRATIONS, detectRawVersion } from './migrations';

function makeCamera(overrides: Partial<Camera> = {}): Camera {
  const day: CameraSettings = { ...DEFAULT_CAMERA_SETTINGS };
  const night: CameraSettings = { ...DEFAULT_NIGHT_SETTINGS };
  return {
    id: 'cam1',
    name: 'Front door',
    tag: 'cam1',
    host: 'cam1.local',
    ip: '192.168.1.20',
    settings: { ...day },
    day,
    night,
    dayNight: 'auto',
    ...overrides,
  };
}

function makeStore(camera: Camera, overrides: Partial<CameraStore> = {}): CameraStore {
  return {
    version: 3,
    cameras: [camera],
    dashboards: [
      { id: DEFAULT_DASHBOARD_ID, name: DEFAULT_DASHBOARD_NAME, cameraIds: [camera.id] },
    ],
    activeDashboardId: DEFAULT_DASHBOARD_ID,
    detection: { ...DEFAULT_DETECTION_SETTINGS },
    ...overrides,
  };
}

describe('Night preset rollout', () => {
  it('a camera still on the OLD night defaults gets the generic night baseline', () => {
    // Before this preset existed, night was seeded from the day defaults.
    const camera = makeCamera({ night: { ...DEFAULT_CAMERA_SETTINGS } });
    const rolled = applyNightPresetRollout(makeStore(camera));
    const night = rolled.cameras[0].night;

    // The semantic outcome promised to the user.
    expect(night.exposureLock).toBe(true);
    expect(night.wbMode).toBe(1); // Sunny — fixed WB
    expect(night.aecValue).toBe(780);
    expect(night.agcGain).toBe(15);
    expect(night.framesize).toBe(6); // HVGA
    // Whole profile lands on the generic night baseline.
    expect(night).toEqual(DEFAULT_NIGHT_SETTINGS);
  });

  it('a Night field the user customised is preserved', () => {
    // The user tuned brightness/saturation but left the night-critical fields
    // at the old (day) defaults.
    const camera = makeCamera({
      night: { ...DEFAULT_CAMERA_SETTINGS, brightness: 2, saturation: 1 },
    });
    const night = applyNightPresetRollout(makeStore(camera)).cameras[0].night;

    // User edits survive...
    expect(night.brightness).toBe(2);
    expect(night.saturation).toBe(1);
    // ...while untouched night-critical fields adopt the new baseline.
    expect(night.exposureLock).toBe(true);
    expect(night.wbMode).toBe(1);
    expect(night.aecValue).toBe(780);
    expect(night.agcGain).toBe(15);
    expect(night.framesize).toBe(6);
  });

  it('running the migration again does not undo the user\'s later edits (idempotent)', () => {
    const camera = makeCamera({ night: { ...DEFAULT_CAMERA_SETTINGS } });
    const first = applyNightPresetRollout(makeStore(camera));

    // The user edits a Night field after the rollout...
    const editedCamera: Camera = {
      ...first.cameras[0],
      night: { ...first.cameras[0].night, saturation: -1 },
    };
    const editedStore: CameraStore = { ...first, cameras: [editedCamera] };

    // ...and the migration runs again (e.g. next app launch).
    const second = applyNightPresetRollout(editedStore);

    expect(second.cameras[0].night.saturation).toBe(-1);
  });

  it('the Day profile is never modified by the night rollout', () => {
    const camera = makeCamera({
      day: { ...DEFAULT_CAMERA_SETTINGS, brightness: 2 },
      night: { ...DEFAULT_CAMERA_SETTINGS },
    });
    const originalDay = camera.day;
    const rolled = applyNightPresetRollout(makeStore(camera));

    expect(rolled.cameras[0].day).toEqual(originalDay);
    expect(rolled.cameras[0].day).toBe(originalDay); // untouched, same object
  });

  it('the effective settings profile is not modified by the rollout', () => {
    const camera = makeCamera({
      settings: { ...DEFAULT_CAMERA_SETTINGS, aecValue: 640 },
      night: { ...DEFAULT_CAMERA_SETTINGS },
    });
    const originalSettings = camera.settings;
    const rolled = applyNightPresetRollout(makeStore(camera));

    expect(rolled.cameras[0].settings).toEqual(originalSettings);
    expect(rolled.cameras[0].settings).toBe(originalSettings); // untouched
  });

  it('the rollout happens exactly once', () => {
    // A store already at the current marker is returned as-is, even though its
    // Night profile is still on the old defaults.
    const camera = makeCamera({ night: { ...DEFAULT_CAMERA_SETTINGS } });
    const store = makeStore(camera, { nightPresetVersion: NIGHT_PRESET_VERSION } as any);

    const result = applyNightPresetRollout(store);

    expect(result).toBe(store);
    expect(result.cameras[0].night).toEqual(DEFAULT_CAMERA_SETTINGS);
  });
});

describe('Ordered config migrations', () => {
  it('declares migrations in ascending, gap-free order up to CURRENT_VERSION', () => {
    const versions = MIGRATIONS.map(m => m.version);
    expect(versions).toEqual([...versions].sort((a, b) => a - b));
    expect(new Set(versions).size).toBe(versions.length);
    for (let i = 1; i < versions.length; i++) {
      expect(versions[i]).toBe(versions[i - 1] + 1);
    }
    expect(CURRENT_VERSION).toBe(Math.max(...versions));
  });

  it('walks a legacy store through every migration to CURRENT_VERSION', () => {
    const store = migrateStore({ ip: '192.168.1.50' });
    expect(store).not.toBeNull();
    expect(store!.version).toBe(CURRENT_VERSION);
    expect(store!.cameras).toHaveLength(1);
    expect(store!.cameras[0].day).toEqual(DEFAULT_CAMERA_SETTINGS);
    expect(store!.cameras[0].night).toEqual(DEFAULT_NIGHT_SETTINGS);
    expect(store!.dashboards.some(d => d.id === DEFAULT_DASHBOARD_ID)).toBe(true);
  });

  it('starts each payload at the version implied by its shape', () => {
    expect(detectRawVersion({ ip: '192.168.1.50' })).toBe(0);
    expect(detectRawVersion({ version: 2, cameras: [] })).toBe(2);
    expect(detectRawVersion({ version: 3, cameras: [] })).toBe(3);
    expect(detectRawVersion({ version: 3, cameras: [], nightPresetVersion: 1 })).toBe(
      CURRENT_VERSION,
    );
  });

  it('does NOT re-run the night rollout for a v3 store carrying nightPresetVersion:1', () => {
    // A settled store: the user tuned brightness, but the night-critical fields
    // are still on the OLD (day) defaults. The old build already ran the rollout.
    const camera = makeCamera({ night: { ...DEFAULT_CAMERA_SETTINGS, brightness: 2 } });
    const raw: any = JSON.parse(
      JSON.stringify(makeStore(camera, { nightPresetVersion: 1 } as any)),
    );
    expect(raw.version).toBe(3);
    expect(detectRawVersion(raw)).toBe(CURRENT_VERSION);

    const migrated = migrateStore(raw)!;
    expect(migrated.version).toBe(CURRENT_VERSION);
    // v4 was skipped: the untouched field stays on the OLD default...
    expect(migrated.cameras[0].night.exposureLock).toBe(false);
    // ...and the user's edit is preserved.
    expect(migrated.cameras[0].night.brightness).toBe(2);
  });

  it('DOES run the night rollout for a v3 store without the legacy marker', () => {
    const camera = makeCamera({ night: { ...DEFAULT_CAMERA_SETTINGS, brightness: 2 } });
    const raw: any = JSON.parse(
      JSON.stringify(makeStore(camera, { nightPresetVersion: 0 } as any)),
    );
    expect(detectRawVersion(raw)).toBe(3);

    const migrated = migrateStore(raw)!;
    // v4 ran: untouched night-critical fields adopt the new baseline...
    expect(migrated.cameras[0].night.exposureLock).toBe(true);
    expect(migrated.cameras[0].night.wbMode).toBe(1);
    // ...while the user's edit survives.
    expect(migrated.cameras[0].night.brightness).toBe(2);
  });
});

describe('Settings sanitisation / clamping', () => {
  it('never pushes an out-of-range exposure or gain to hardware', () => {
    const settings = normalizeSettings({ ...DEFAULT_CAMERA_SETTINGS, aecValue: 9999, agcGain: 9999 });
    expect(settings.aecValue).toBe(1200); // aec_value max
    expect(settings.agcGain).toBe(128); // agc_gain max
  });

  it('clamps white balance into the firmware\'s 0..4 range', () => {
    expect(normalizeSettings({ ...DEFAULT_CAMERA_SETTINGS, wbMode: 99 }).wbMode).toBe(4);
    expect(normalizeSettings({ ...DEFAULT_CAMERA_SETTINGS, wbMode: -3 }).wbMode).toBe(0);
  });

  it('clamps other numeric controls into safe ranges', () => {
    const low = normalizeSettings({ ...DEFAULT_CAMERA_SETTINGS, quality: -100, brightness: -9 });
    expect(low.quality).toBe(10); // quality min
    expect(low.brightness).toBe(-2); // brightness min
  });
});

describe('Store migration', () => {
  it('turns a legacy single-camera store into a usable camera with a Day profile and Night baseline', () => {
    const store = migrateStore({ ip: '192.168.1.50' });

    expect(store).not.toBeNull();
    expect(store!.cameras).toHaveLength(1);

    const camera = store!.cameras[0];
    expect(camera.ip).toBe('192.168.1.50');
    expect(camera.day).toEqual(DEFAULT_CAMERA_SETTINGS);
    expect(camera.night).toEqual(DEFAULT_NIGHT_SETTINGS);
    expect(camera.dayNight).toBe('auto');

    const defaultDashboard = store!.dashboards.find(d => d.id === DEFAULT_DASHBOARD_ID);
    expect(defaultDashboard?.cameraIds).toContain(camera.id);
    expect(store!.activeDashboardId).toBe(DEFAULT_DASHBOARD_ID);
  });

  it('always exposes the "All cameras" dashboard containing every camera', () => {
    const a = makeCamera({ id: 'a', tag: 'a' });
    const b = makeCamera({ id: 'b', tag: 'b' });
    const store = sanitizeStore([a, b], [], undefined, undefined, undefined);

    const defaultDashboard = store.dashboards.find(d => d.id === DEFAULT_DASHBOARD_ID);
    expect(defaultDashboard?.name).toBe(DEFAULT_DASHBOARD_NAME);
    expect(defaultDashboard?.cameraIds).toEqual(['a', 'b']);
    // An unknown active dashboard falls back to the default.
    expect(store.activeDashboardId).toBe(DEFAULT_DASHBOARD_ID);
  });
});
