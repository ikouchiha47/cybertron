/**
 * Behavioural tests for the pure camera/dashboard config model.
 *
 * These are written as product promises: which profile is live at a given
 * local hour, and what `resolveProfile` returns for that slot. No React Native
 * or I/O is involved, so they run in the default node environment.
 */
import { describe, it, expect } from 'vitest';

import {
  DEFAULT_CAMERA_SETTINGS,
  DEFAULT_NIGHT_SETTINGS,
  activeProfileSlot,
  resolveProfile,
} from './cameraConfig';
import type { Camera, CameraSettings, DayNightMode } from './cameraConfig';

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

describe('Day/Night profile selection', () => {
  it('uses the Day profile during waking hours (07:00–18:59)', () => {
    const camera = makeCamera();
    for (const hour of [7, 12, 18]) {
      expect(activeProfileSlot(camera, hour)).toBe('day');
      expect(resolveProfile(camera, hour)).toBe(camera.day);
    }
  });

  it('uses the Night profile outside waking hours (19:00–06:59)', () => {
    const camera = makeCamera();
    for (const hour of [19, 0, 6]) {
      expect(activeProfileSlot(camera, hour)).toBe('night');
      expect(resolveProfile(camera, hour)).toBe(camera.night);
    }
  });

  it('honours a manual night selection even at midday', () => {
    const camera = makeCamera('night');
    expect(activeProfileSlot(camera, 12)).toBe('night');
    expect(resolveProfile(camera, 12)).toBe(camera.night);
  });

  it('honours a manual day selection even at midnight', () => {
    const camera = makeCamera('day');
    expect(activeProfileSlot(camera, 0)).toBe('day');
    expect(resolveProfile(camera, 0)).toBe(camera.day);
  });
});
