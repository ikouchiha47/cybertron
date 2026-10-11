/**
 * Behavioural tests for the resolution options the settings sheet shows.
 *
 * These pin the labels users read, not the firmware enum: the value→label
 * pairs below are the MEASURED mapping on the connected firmware. An incorrect
 * label sends the user to the wrong resolution (the old UI thought value 6 was
 * 480×320 and value 9 was 1024×768).
 */
import { describe, it, expect, vi } from 'vitest';

// cameraSettings touches the persistence layer only for its imports; stub
// AsyncStorage so this stays a pure, node-environment test.
vi.mock('@react-native-async-storage/async-storage', () => ({
  default: { getItem: vi.fn(), setItem: vi.fn() },
}));

import { FRAMESIZE_MODES } from './cameraSettings';
import { DEFAULT_CAMERA_SETTINGS } from './cameraConfig';

function labelFor(value: number): string | undefined {
  return FRAMESIZE_MODES.find(m => m.value === value)?.label;
}

describe('Resolution options', () => {
  it('ships VGA 640×480 as the default control value', () => {
    expect(DEFAULT_CAMERA_SETTINGS.framesize).toBe(10);
    expect(labelFor(10)).toBe('VGA 640×480');
  });

  it('keeps VGA and XGA available as per-camera opt-ins', () => {
    expect(labelFor(10)).toBe('VGA 640×480');
    expect(labelFor(12)).toBe('XGA 1024×768');
  });

  it('matches the measured firmware labels (not the old, incorrect pairing)', () => {
    expect(labelFor(6)).toBe('QVGA 320×240');
    expect(labelFor(8)).toBe('CIF 400×296');
    expect(labelFor(9)).toBe('HVGA 480×320');
    expect(labelFor(11)).toBe('SVGA 800×600');
  });
});
