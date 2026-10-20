/**
 * Behavioural tests for the pure camera/dashboard config model.
 *
 * These are written as product promises: which profile is live at a given
 * instant and what `resolveProfile` returns for that slot, both with the legacy
 * clock fallback (null window) and with a real solar `NightWindow`. No React
 * Native or I/O is involved, so they run in the default node environment.
 */
import { describe, it, expect } from 'vitest';

import {
  DEFAULT_CAMERA_SETTINGS,
  DEFAULT_NIGHT_SETTINGS,
  activeProfileSlot,
  resolveProfile,
} from './cameraConfig';
import type { Camera, CameraSettings, DayNightMode } from './cameraConfig';
import type { NightWindow } from './sunWindow';

function makeCamera(
  dayNight: DayNightMode = 'auto',
  overrides: Partial<Camera> = {},
): Camera {
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
    dayNight,
    ...overrides,
  };
}

/** A fixed local instant at the given hour on 2026-01-15. */
function at(hour: number, minute = 0): Date {
  return new Date(2026, 0, 15, hour, minute, 0, 0);
}

describe('Profile resolution defaults', () => {
  it('keeps the base default at VGA but ships Night at HVGA', () => {
    // The firmware-matching base stays VGA 640x480; Night ships HVGA 480x320,
    // the visibly better compromise for night detail.
    expect(DEFAULT_CAMERA_SETTINGS.framesize).toBe(10);
    expect(DEFAULT_NIGHT_SETTINGS.framesize).toBe(9);
  });
});

describe('Day/Night profile selection (no solar window fallback)', () => {
  it('uses the Day profile during waking hours (07:00–18:59)', () => {
    const camera = makeCamera();
    for (const hour of [7, 12, 18]) {
      expect(activeProfileSlot(camera, at(hour), null)).toBe('day');
      expect(resolveProfile(camera, at(hour), null)).toBe(camera.day);
    }
  });

  it('uses the Night profile outside waking hours (19:00–06:59)', () => {
    const camera = makeCamera();
    for (const hour of [19, 0, 6]) {
      expect(activeProfileSlot(camera, at(hour), null)).toBe('night');
      expect(resolveProfile(camera, at(hour), null)).toBe(camera.night);
    }
  });

  it('honours a manual night selection even at midday', () => {
    const camera = makeCamera('night');
    expect(activeProfileSlot(camera, at(12), null)).toBe('night');
    expect(resolveProfile(camera, at(12), null)).toBe(camera.night);
  });

  it('honours a manual day selection even at midnight', () => {
    const camera = makeCamera('day');
    expect(activeProfileSlot(camera, at(0), null)).toBe('day');
    expect(resolveProfile(camera, at(0), null)).toBe(camera.day);
  });
});

describe('Day/Night profile selection (solar window)', () => {
  // Winter dusk 16:30, dawn 08:00 — deliberately inside the 07:00/19:00 clock
  // window so the two policies disagree and the test pins the solar one.
  const window: NightWindow = {
    dawn: at(8),
    dusk: at(16, 30),
    alwaysUp: false,
    alwaysDown: false,
  };

  it('is Day between dawn and dusk', () => {
    const camera = makeCamera();
    expect(activeProfileSlot(camera, at(12), window)).toBe('day');
    expect(resolveProfile(camera, at(12), window)).toBe(camera.day);
  });

  it('is Night before dawn and after dusk, overriding the clock fallback', () => {
    const camera = makeCamera();
    // 07:00 — the clock fallback says day, the sun says night.
    expect(activeProfileSlot(camera, at(7), window)).toBe('night');
    expect(resolveProfile(camera, at(7), window)).toBe(camera.night);
    // 18:00 — the clock fallback says day, the sun says night.
    expect(activeProfileSlot(camera, at(18), window)).toBe('night');
    expect(resolveProfile(camera, at(18), window)).toBe(camera.night);
  });

  it('still honours manual overrides with a window present', () => {
    expect(activeProfileSlot(makeCamera('day'), at(23), window)).toBe('day');
    expect(activeProfileSlot(makeCamera('night'), at(12), window)).toBe('night');
  });
});
