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
  DEFAULT_DAY_SETTINGS,
  DEFAULT_DASHBOARD_ID,
  DEFAULT_DASHBOARD_NAME,
  DEFAULT_DETECTION_SETTINGS,
  DEFAULT_NIGHT_SETTINGS,
  LEGACY_TINY_FRAMESIZE,
} from './cameraConfig';
import type { Camera, CameraSettings, CameraStore } from './cameraConfig';
import { NIGHT_PRESET_VERSION, applyNightPresetRollout, migrateStore, normalizeDetection, normalizeSettings, sanitizeStore } from './migrations';
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
    expect(night.wbMode).toBe(2); // Cloudy, with AWB on — as validated live
    expect(night.aecValue).toBe(719); // validated low-light exposure
    expect(night.agcGain).toBe(2);
    expect(night.framesize).toBe(9); // HVGA 480x320
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
    expect(night.wbMode).toBe(2);
    expect(night.aecValue).toBe(719);
    expect(night.agcGain).toBe(2);
    expect(night.framesize).toBe(9);
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
    expect(store!.cameras[0].day).toEqual(DEFAULT_DAY_SETTINGS);
    expect(store!.cameras[0].night).toEqual(DEFAULT_NIGHT_SETTINGS);
    expect(store!.dashboards.some(d => d.id === DEFAULT_DASHBOARD_ID)).toBe(true);
  });

  it('starts each payload at the version implied by its shape', () => {
    expect(detectRawVersion({ ip: '192.168.1.50' })).toBe(0);
    expect(detectRawVersion({ version: 2, cameras: [] })).toBe(2);
    expect(detectRawVersion({ version: 3, cameras: [] })).toBe(3);
    expect(detectRawVersion({ version: 4, cameras: [] })).toBe(4);
    // A settled store carrying the legacy marker has already had the v4 rollout;
    // it resumes at v4 so later migrations still run.
    expect(detectRawVersion({ version: 3, cameras: [], nightPresetVersion: 1 })).toBe(4);
  });

  it('does NOT re-run the night rollout for a v3 store carrying nightPresetVersion:1', () => {
    // A settled store: the user tuned brightness, but the night-critical fields
    // are still on the OLD (day) defaults. The old build already ran the rollout.
    const camera = makeCamera({ night: { ...DEFAULT_CAMERA_SETTINGS, brightness: 2 } });
    const raw: any = JSON.parse(
      JSON.stringify(makeStore(camera, { nightPresetVersion: 1 } as any)),
    );
    expect(raw.version).toBe(3);
    // Resumes after the already-applied v4 rollout rather than skipping ahead.
    expect(detectRawVersion(raw)).toBe(4);

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
    expect(migrated.cameras[0].night.wbMode).toBe(2);
    // ...while the user's edit survives.
    expect(migrated.cameras[0].night.brightness).toBe(2);
  });

  it('lowers a v4 store still on the blown night exposure to the corrected value', () => {
    // A camera that already ran the v4 night rollout still holds the blown 780.
    const camera = makeCamera({
      night: { ...DEFAULT_NIGHT_SETTINGS, aecValue: 780 },
      settings: { ...DEFAULT_NIGHT_SETTINGS, aecValue: 780 },
    });
    const raw: any = JSON.parse(JSON.stringify(makeStore(camera, { version: 4 } as any)));
    expect(detectRawVersion(raw)).toBe(4);

    const migrated = migrateStore(raw)!;
    expect(migrated.cameras[0].night.aecValue).toBe(719);
    expect(migrated.cameras[0].settings.aecValue).toBe(719);
  });

  it('preserves a night exposure the user tuned below the cliff', () => {
    const camera = makeCamera({ night: { ...DEFAULT_NIGHT_SETTINGS, aecValue: 400 } });
    const raw: any = JSON.parse(JSON.stringify(makeStore(camera, { version: 4 } as any)));

    const migrated = migrateStore(raw)!;
    expect(migrated.cameras[0].night.aecValue).toBe(400);
  });

  it('ships QVGA for Day and HVGA for Night by default', () => {
    // Day QVGA 320x240 keeps the day stream light; Night ships HVGA 480x320,
    // the visibly better compromise for night detail.
    expect(DEFAULT_DAY_SETTINGS.framesize).toBe(6);
    expect(DEFAULT_NIGHT_SETTINGS.framesize).toBe(9);
  });

  it('upgrades the legacy tiny default, ending at QVGA for Day and Night', () => {
    const tiny = { ...DEFAULT_CAMERA_SETTINGS, framesize: LEGACY_TINY_FRAMESIZE };
    const camera = makeCamera({
      day: { ...tiny },
      night: { ...DEFAULT_NIGHT_SETTINGS, framesize: LEGACY_TINY_FRAMESIZE },
      settings: { ...tiny },
    });
    const raw: any = JSON.parse(JSON.stringify(makeStore(camera, { version: 5 } as any)));
    expect(detectRawVersion(raw)).toBe(5);

    const migrated = migrateStore(raw)!;
    // v6 upgrades everything to VGA, v9 moves an untouched Day profile to the
    // QVGA day default, and v8 returns the Night profile to QVGA.
    expect(migrated.cameras[0].day.framesize).toBe(6);
    expect(migrated.cameras[0].night.framesize).toBe(LEGACY_TINY_FRAMESIZE);
    expect(migrated.cameras[0].settings.framesize).toBe(LEGACY_TINY_FRAMESIZE);
  });

  it('preserves a resolution the user explicitly chose', () => {
    // XGA 1024x768 (control value 12) is an opt-in the user made; the v6
    // upgrade must not flatten it.
    const chosen = { ...DEFAULT_CAMERA_SETTINGS, framesize: 12 };
    const camera = makeCamera({
      day: { ...chosen },
      night: { ...DEFAULT_NIGHT_SETTINGS, framesize: 12 },
      settings: { ...chosen },
    });
    const raw: any = JSON.parse(JSON.stringify(makeStore(camera, { version: 5 } as any)));

    const migrated = migrateStore(raw)!;
    expect(migrated.cameras[0].day.framesize).toBe(12);
    expect(migrated.cameras[0].night.framesize).toBe(12);
    expect(migrated.cameras[0].settings.framesize).toBe(12);
  });

  it('runs the resolution migrations on a legacy store carrying the night-preset marker', () => {
    // A settled v3 store skipped ahead by the legacy marker still traverses
    // v5-v8 while its old (unrolled) night fields stay as-is.
    const tiny = { ...DEFAULT_CAMERA_SETTINGS, framesize: LEGACY_TINY_FRAMESIZE };
    const camera = makeCamera({
      day: { ...tiny },
      night: { ...tiny, brightness: 2 },
      settings: { ...tiny },
    });
    const raw: any = JSON.parse(
      JSON.stringify(makeStore(camera, { nightPresetVersion: 1 } as any)),
    );

    const migrated = migrateStore(raw)!;
    expect(migrated.cameras[0].day.framesize).toBe(6);
    // Night ends at QVGA after v8; the effective settings follows it.
    expect(migrated.cameras[0].settings.framesize).toBe(LEGACY_TINY_FRAMESIZE);
    expect(migrated.cameras[0].night.framesize).toBe(LEGACY_TINY_FRAMESIZE);
    // The v4 rollout is still not re-run for this store.
    expect(migrated.cameras[0].night.exposureLock).toBe(false);
    expect(migrated.cameras[0].night.brightness).toBe(2);
  });

  it('keeps the v6 upgrade step (QVGA 6 -> VGA 10) intact', () => {
    const tiny = { ...DEFAULT_CAMERA_SETTINGS, framesize: LEGACY_TINY_FRAMESIZE };
    const camera = makeCamera({
      day: { ...tiny },
      night: { ...DEFAULT_NIGHT_SETTINGS, framesize: LEGACY_TINY_FRAMESIZE },
      settings: { ...tiny },
    });
    const v6 = MIGRATIONS.find(m => m.version === 6)!;
    const afterV6 = v6.apply(
      JSON.parse(JSON.stringify(makeStore(camera, { version: 5 } as any))),
    );

    expect(afterV6.cameras[0].day.framesize).toBe(10);
    expect(afterV6.cameras[0].night.framesize).toBe(10);
    expect(afterV6.cameras[0].settings.framesize).toBe(10);
  });

  it('reverts a VGA Night profile to QVGA (v8) while leaving Day at VGA', () => {
    const camera = makeCamera({
      day: { ...DEFAULT_CAMERA_SETTINGS, framesize: 10 },
      night: { ...DEFAULT_NIGHT_SETTINGS, framesize: 10 },
      settings: { ...DEFAULT_NIGHT_SETTINGS, framesize: 10 },
      dayNight: 'auto',
    });
    const v8 = MIGRATIONS.find(m => m.version === 8)!;
    const after = v8.apply(
      JSON.parse(JSON.stringify(makeStore(camera, { version: 7 } as any))),
    );

    expect(after.cameras[0].day.framesize).toBe(10); // Day untouched
    expect(after.cameras[0].night.framesize).toBe(LEGACY_TINY_FRAMESIZE);
    expect(after.cameras[0].settings.framesize).toBe(LEGACY_TINY_FRAMESIZE);
  });

  it('leaves a day-pinned camera\'s effective settings at VGA (v8)', () => {
    const vga = { ...DEFAULT_CAMERA_SETTINGS, framesize: 10 };
    const camera = makeCamera({
      day: { ...vga },
      night: { ...DEFAULT_NIGHT_SETTINGS, framesize: 10 },
      settings: { ...vga },
      dayNight: 'day',
    });
    const v8 = MIGRATIONS.find(m => m.version === 8)!;
    const after = v8.apply(
      JSON.parse(JSON.stringify(makeStore(camera, { version: 7 } as any))),
    );

    expect(after.cameras[0].night.framesize).toBe(LEGACY_TINY_FRAMESIZE);
    // Effective `settings` is not lowered because the active profile is Day.
    expect(after.cameras[0].settings.framesize).toBe(10);
    expect(after.cameras[0].day.framesize).toBe(10);
  });

  it('does not touch a resolution the user chose for Night (v8)', () => {
    const camera = makeCamera({
      night: { ...DEFAULT_NIGHT_SETTINGS, framesize: 12 },
      settings: { ...DEFAULT_CAMERA_SETTINGS, framesize: 12 },
    });
    const v8 = MIGRATIONS.find(m => m.version === 8)!;
    const after = v8.apply(
      JSON.parse(JSON.stringify(makeStore(camera, { version: 7 } as any))),
    );

    expect(after.cameras[0].night.framesize).toBe(12);
    expect(after.cameras[0].settings.framesize).toBe(12);
  });

  it('locks a factory-default Day exposure and seeds the governor (v9)', () => {
    const camera = makeCamera({
      day: { ...DEFAULT_CAMERA_SETTINGS },
      night: { ...DEFAULT_NIGHT_SETTINGS },
      settings: { ...DEFAULT_CAMERA_SETTINGS },
      dayNight: 'auto',
    });
    const v9 = MIGRATIONS.find(m => m.version === 9)!;
    const after = v9.apply(
      JSON.parse(JSON.stringify(makeStore(camera, { version: 8 } as any))),
    );

    expect(after.cameras[0].day).toEqual(DEFAULT_DAY_SETTINGS);
    expect(after.cameras[0].day.exposureLock).toBe(true);
    // The effective profile follows so the pushed settings match.
    expect(after.cameras[0].settings).toEqual(DEFAULT_DAY_SETTINGS);
    // Night already locks and is never touched.
    expect(after.cameras[0].night).toEqual(DEFAULT_NIGHT_SETTINGS);
  });

  it('preserves a Day profile the user tuned (v9)', () => {
    const tuned = { ...DEFAULT_CAMERA_SETTINGS, brightness: 2, exposureLock: false };
    const camera = makeCamera({
      day: { ...tuned },
      night: { ...DEFAULT_NIGHT_SETTINGS },
      settings: { ...tuned },
      dayNight: 'day',
    });
    const v9 = MIGRATIONS.find(m => m.version === 9)!;
    const after = v9.apply(
      JSON.parse(JSON.stringify(makeStore(camera, { version: 8 } as any))),
    );

    expect(after.cameras[0].day.brightness).toBe(2);
    expect(after.cameras[0].day.exposureLock).toBe(false);
  });

  it('does not lock the effective settings of a night-pinned camera (v9)', () => {
    const camera = makeCamera({
      day: { ...DEFAULT_CAMERA_SETTINGS },
      night: { ...DEFAULT_NIGHT_SETTINGS },
      settings: { ...DEFAULT_CAMERA_SETTINGS },
      dayNight: 'night',
    });
    const v9 = MIGRATIONS.find(m => m.version === 9)!;
    const after = v9.apply(
      JSON.parse(JSON.stringify(makeStore(camera, { version: 8 } as any))),
    );

    expect(after.cameras[0].day).toEqual(DEFAULT_DAY_SETTINGS);
    // Night-pinned camera keeps its (night) effective settings.
    expect(after.cameras[0].settings).toEqual(DEFAULT_CAMERA_SETTINGS);
  });

  it('adopts the night recipe for a previous-baseline Night profile (v10)', () => {
    const previous = {
      ...DEFAULT_CAMERA_SETTINGS,
      exposureLock: true,
      aecValue: 750,
      agcGain: 15,
      wbMode: 1,
      framesize: LEGACY_TINY_FRAMESIZE,
    };
    const camera = makeCamera({
      day: { ...DEFAULT_DAY_SETTINGS },
      night: { ...previous },
      settings: { ...previous },
      dayNight: 'auto',
    });
    const v10 = MIGRATIONS.find(m => m.version === 10)!;
    const after = v10.apply(
      JSON.parse(JSON.stringify(makeStore(camera, { version: 9 } as any))),
    );

    expect(after.cameras[0].night).toEqual(DEFAULT_NIGHT_SETTINGS);
    expect(after.cameras[0].night.brightness).toBe(1);
    expect(after.cameras[0].night.aecValue).toBe(719);
    expect(after.cameras[0].night.agcGain).toBe(2);
    expect(after.cameras[0].settings).toEqual(DEFAULT_NIGHT_SETTINGS);
    // Day profile and LED fields are never touched by the recipe.
    expect(after.cameras[0].day).toEqual(DEFAULT_DAY_SETTINGS);
    expect(after.cameras[0].night.ledOn).toBe(false);
    expect(after.cameras[0].night.ledIntensity).toBe(0);
  });

  it('preserves a Night profile the user tuned (v10)', () => {
    const tuned = { ...DEFAULT_NIGHT_SETTINGS, aecValue: 400 };
    const camera = makeCamera({
      night: { ...tuned },
      settings: { ...tuned },
    });
    const v10 = MIGRATIONS.find(m => m.version === 10)!;
    const after = v10.apply(
      JSON.parse(JSON.stringify(makeStore(camera, { version: 9 } as any))),
    );

    expect(after.cameras[0].night.aecValue).toBe(400);
    expect(after.cameras[0].settings.aecValue).toBe(400);
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

  it('defaults the idle baseline inference cadence and clamps it into 100..5000ms', () => {
    // Missing on an older payload → the healthy idle default.
    expect(normalizeDetection({}).baselineIntervalMs).toBe(
      DEFAULT_DETECTION_SETTINGS.baselineIntervalMs,
    );
    expect(DEFAULT_DETECTION_SETTINGS.baselineIntervalMs).toBe(300);
    // Out-of-range values are clamped, never pushed to the engine verbatim.
    expect(normalizeDetection({ baselineIntervalMs: 0 }).baselineIntervalMs).toBe(100);
    expect(normalizeDetection({ baselineIntervalMs: 99999 }).baselineIntervalMs).toBe(5000);
  });

  it('defaults CLAHE contrast enhancement on and coerces it to a boolean', () => {
    // A fresh install (and any older payload without the field) enhances.
    expect(DEFAULT_DETECTION_SETTINGS.contrastEnhance).toBe(true);
    expect(normalizeDetection({}).contrastEnhance).toBe(true);
    // An explicit off survives; a non-boolean falls back to the default.
    expect(normalizeDetection({ contrastEnhance: false }).contrastEnhance).toBe(false);
    expect(normalizeDetection({ contrastEnhance: 'yes' }).contrastEnhance).toBe(true);
  });

  it('defaults the box geometry filters to a relaxed aspect floor', () => {
    // The relaxed floor admits squat/wide/partial/close boxes.
    expect(DEFAULT_DETECTION_SETTINGS.minAspect).toBe(0.8);
    expect(DEFAULT_DETECTION_SETTINGS.maxAspect).toBe(6.0);
    expect(DEFAULT_DETECTION_SETTINGS.minBoxArea).toBe(0.002);
    // Missing on an older payload → the same defaults.
    expect(normalizeDetection({}).minAspect).toBe(0.8);
    expect(normalizeDetection({}).maxAspect).toBe(6.0);
    expect(normalizeDetection({}).minBoxArea).toBe(0.002);
  });

  it('clamps geometry filters into the engine ranges', () => {
    expect(normalizeDetection({ minAspect: 0 }).minAspect).toBe(0.3);
    expect(normalizeDetection({ minAspect: 99 }).minAspect).toBe(3);
    expect(normalizeDetection({ maxAspect: 0 }).maxAspect).toBe(1);
    expect(normalizeDetection({ maxAspect: 99 }).maxAspect).toBe(10);
    expect(normalizeDetection({ minBoxArea: 0 }).minBoxArea).toBe(0.0005);
    expect(normalizeDetection({ minBoxArea: 5 }).minBoxArea).toBe(0.1);
  });
});

describe('Store migration', () => {
  it('turns a legacy single-camera store into a usable camera with a Day profile and Night baseline', () => {
    const store = migrateStore({ ip: '192.168.1.50' });

    expect(store).not.toBeNull();
    expect(store!.cameras).toHaveLength(1);

    const camera = store!.cameras[0];
    expect(camera.ip).toBe('192.168.1.50');
    expect(camera.day).toEqual(DEFAULT_DAY_SETTINGS);
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
