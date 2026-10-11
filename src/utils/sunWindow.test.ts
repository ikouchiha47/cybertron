/**
 * Behavioural tests for the solar Day/Night window.
 *
 * Pinned inputs (London lat/lng, a winter and a summer date); the expected
 * boundaries are computed from `suncalc` itself so the tests pin the *policy*
 * (ladder, instant comparison, bounds) rather than brittle hand-copied times.
 */
import { describe, it, expect, vi } from 'vitest';

// Keep the real SunCalc for the pinned-value tests, but wrap `getTimes` in a
// mock so the fallback ladder can be exercised deterministically.
vi.mock('suncalc', async importOriginal => {
  const actual = await importOriginal<typeof import('suncalc')>();
  return { ...actual, getTimes: vi.fn(actual.getTimes) };
});

import * as SunCalc from 'suncalc';
import {
  MAX_BOUNDARY_MS,
  isNight,
  msUntilNextBoundary,
  resolveNightWindow,
  valid,
} from './sunWindow';
import type { NightWindow } from './sunWindow';

const LAT = 51.5074;
const LNG = -0.1278;
const WINTER = new Date(Date.UTC(2026, 0, 15, 12, 0, 0));
const SUMMER = new Date(Date.UTC(2026, 5, 21, 12, 0, 0));
const HOUR = 60 * 60 * 1000;

describe('valid', () => {
  it('accepts only real dates', () => {
    expect(valid(new Date())).toBe(true);
    expect(valid(null)).toBe(false);
    expect(valid(undefined)).toBe(false);
    expect(valid(new Date(NaN))).toBe(false);
  });
});

describe('resolveNightWindow', () => {
  it('pins the winter London dusk/dawn from SunCalc (no polar flags)', () => {
    const real = SunCalc.getTimes(WINTER, LAT, LNG);
    const w = resolveNightWindow(WINTER, LAT, LNG);
    expect(real.dusk).toBeInstanceOf(Date);
    expect(real.dawn).toBeInstanceOf(Date);
    expect(w.dusk?.getTime()).toBe(real.dusk!.getTime());
    expect(w.dawn?.getTime()).toBe(real.dawn!.getTime());
    expect(w.alwaysUp).toBe(false);
    expect(w.alwaysDown).toBe(false);
  });

  it('pins the summer London dusk/dawn from SunCalc', () => {
    const real = SunCalc.getTimes(SUMMER, LAT, LNG);
    const w = resolveNightWindow(SUMMER, LAT, LNG);
    expect(w.dusk?.getTime()).toBe(real.dusk!.getTime());
    expect(w.dawn?.getTime()).toBe(real.dawn!.getTime());
  });

  it('falls back dusk → sunset → nauticalDusk and dawn → sunrise → nauticalDawn', () => {
    const getTimes = vi.mocked(SunCalc.getTimes);
    const sunset = new Date('2026-01-15T17:00:00Z');
    const nauticalDusk = new Date('2026-01-15T17:45:00Z');
    const sunrise = new Date('2026-01-15T07:30:00Z');
    const nauticalDawn = new Date('2026-01-15T06:30:00Z');

    // First rung: dusk/dawn missing → sunset/sunrise.
    getTimes.mockReturnValueOnce({
      dusk: null,
      sunset,
      nauticalDusk,
      dawn: null,
      sunrise,
      nauticalDawn,
      alwaysUp: false,
      alwaysDown: false,
    } as any);
    const w = resolveNightWindow(WINTER, LAT, LNG);
    expect(w.dusk?.getTime()).toBe(sunset.getTime());
    expect(w.dawn?.getTime()).toBe(sunrise.getTime());

    // Second rung: only nautical times → nauticalDusk/nauticalDawn.
    getTimes.mockReturnValueOnce({
      dusk: null,
      sunset: null,
      nauticalDusk,
      dawn: null,
      sunrise: null,
      nauticalDawn,
      alwaysUp: false,
      alwaysDown: false,
    } as any);
    const w2 = resolveNightWindow(WINTER, LAT, LNG);
    expect(w2.dusk?.getTime()).toBe(nauticalDusk.getTime());
    expect(w2.dawn?.getTime()).toBe(nauticalDawn.getTime());
  });

  it('reports polar day/night with null anchors', () => {
    const up = resolveNightWindow(SUMMER, 89, 0);
    expect(up.alwaysUp).toBe(true);
    expect(up.dusk).toBeNull();
    expect(up.dawn).toBeNull();

    const down = resolveNightWindow(WINTER, 89, 0);
    expect(down.alwaysDown).toBe(true);
    expect(down.dusk).toBeNull();
    expect(down.dawn).toBeNull();
  });
});

describe('isNight', () => {
  it('compares absolute instants for both a winter and a summer date', () => {
    for (const d of [WINTER, SUMMER]) {
      const w = resolveNightWindow(d, LAT, LNG);
      // Just before dawn and just after dusk are night; the converse is day.
      expect(isNight(new Date(w.dawn!.getTime() - HOUR), w)).toBe(true);
      expect(isNight(new Date(w.dawn!.getTime() + HOUR), w)).toBe(false);
      expect(isNight(new Date(w.dusk!.getTime() - HOUR), w)).toBe(false);
      expect(isNight(new Date(w.dusk!.getTime() + HOUR), w)).toBe(true);
    }
  });

  it('forces day for alwaysUp and night for alwaysDown', () => {
    const up: NightWindow = { dusk: null, dawn: null, alwaysUp: true, alwaysDown: false };
    const down: NightWindow = { dusk: null, dawn: null, alwaysUp: false, alwaysDown: true };
    expect(isNight(WINTER, up)).toBe(false);
    expect(isNight(WINTER, down)).toBe(true);
  });

  it('falls back to the 07:00–18:59 hour rule when anchors are missing', () => {
    const noAnchors: NightWindow = {
      dusk: null,
      dawn: null,
      alwaysUp: false,
      alwaysDown: false,
    };
    expect(isNight(new Date(2026, 0, 15, 12, 0, 0), noAnchors)).toBe(false);
    expect(isNight(new Date(2026, 0, 15, 18, 59, 0), noAnchors)).toBe(false);
    expect(isNight(new Date(2026, 0, 15, 19, 0, 0), noAnchors)).toBe(true);
    expect(isNight(new Date(2026, 0, 15, 6, 0, 0), noAnchors)).toBe(true);
  });
});

describe('msUntilNextBoundary', () => {
  it('returns the nearest future boundary within the cap', () => {
    const w = resolveNightWindow(WINTER, LAT, LNG);
    const ms = msUntilNextBoundary(WINTER, w);
    expect(ms).toBeGreaterThan(0);
    expect(ms).toBeLessThanOrEqual(MAX_BOUNDARY_MS);
    // At winter noon the next boundary is that day's dusk (~5h away).
    expect(ms).toBe(w.dusk!.getTime() - WINTER.getTime());
  });

  it('considers tomorrow\'s occurrence once today\'s has passed (capped at 6h)', () => {
    const w = resolveNightWindow(WINTER, LAT, LNG);
    const afterDusk = new Date(w.dusk!.getTime() + 60_000);
    // Next real boundary is tomorrow's dawn (> 6h) → the cap.
    expect(msUntilNextBoundary(afterDusk, w)).toBe(MAX_BOUNDARY_MS);
  });

  it('caps at 6h when the nearest future anchor is still beyond the cap', () => {
    const now = new Date(2026, 0, 15, 12, 0, 0, 0);
    const w: NightWindow = {
      dawn: new Date(now.getTime() + 8 * HOUR),
      dusk: new Date(now.getTime() + 7 * HOUR),
      alwaysUp: false,
      alwaysDown: false,
    };
    expect(msUntilNextBoundary(now, w)).toBe(MAX_BOUNDARY_MS);
  });

  it('returns exactly 6h when there is no usable anchor', () => {
    const polar: NightWindow = {
      dusk: null,
      dawn: null,
      alwaysUp: false,
      alwaysDown: true,
    };
    expect(msUntilNextBoundary(WINTER, polar)).toBe(MAX_BOUNDARY_MS);
  });

  it('picks the nearest future anchor', () => {
    const now = new Date(2026, 0, 15, 12, 0, 0, 0);
    const w: NightWindow = {
      dawn: new Date(now.getTime() + 8 * HOUR),
      dusk: new Date(now.getTime() + HOUR / 2),
      alwaysUp: false,
      alwaysDown: false,
    };
    expect(msUntilNextBoundary(now, w)).toBe(HOUR / 2);
  });
});
