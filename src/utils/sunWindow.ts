/**
 * Season-aware Day/Night boundary, computed from the sun's civil twilight.
 *
 * Pure and dependency-light (only `suncalc`) so it is unit-testable in node.
 * Imports nothing internal, keeping it free of cycles with the config model.
 *
 * The app's day/night split is: day between civil `dawn` and civil `dusk`,
 * night otherwise. With no coordinates the caller passes a `null` window and
 * `activeProfileSlot` keeps the legacy 07:00/19:00 rule.
 */
import * as SunCalc from 'suncalc';

/** The solar boundaries that bracket a night, plus the polar-day/night flags. */
export interface NightWindow {
  /** Civil dusk (the night anchor) for `now`'s solar day, or null if unavailable. */
  dusk: Date | null;
  /** Civil dawn (the day anchor) for `now`'s solar day, or null if unavailable. */
  dawn: Date | null;
  /** Sun never drops below the horizon all day (polar day). */
  alwaysUp: boolean;
  /** Sun never rises above the horizon all day (polar night). */
  alwaysDown: boolean;
}

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;
/**
 * Scheduling cap. A boundary re-check is never scheduled more than this far out
 * so a long day/night (or a clock/DST jump) self-corrects within the cap.
 */
export const MAX_BOUNDARY_MS = 6 * HOUR_MS;

/** True only for a real `Date` — guards `null`, `undefined`, and Invalid Date. */
export function valid(d: Date | null | undefined): d is Date {
  return d instanceof Date && !Number.isNaN(d.getTime());
}

/** First usable date from left to right, or `null` when none is a real instant. */
function firstValid(...dates: (Date | null | undefined)[]): Date | null {
  for (const d of dates) if (valid(d)) return d;
  return null;
}

/**
 * Resolve the night window for `now` at `lat`/`lng` from `SunCalc.getTimes`.
 *
 * Fallback ladders cover the high-latitude cases where a named event is absent:
 * night anchor `dusk → sunset → nauticalDusk`, day anchor `dawn → sunrise →
 * nauticalDawn`. Results are absolute UTC instants (compare with `getTime()`),
 * so timezone and DST are non-issues.
 */
export function resolveNightWindow(now: Date, lat: number, lng: number): NightWindow {
  const t = SunCalc.getTimes(now, lat, lng);
  return {
    dusk: firstValid(t.dusk, t.sunset, t.nauticalDusk),
    dawn: firstValid(t.dawn, t.sunrise, t.nauticalDawn),
    alwaysUp: t.alwaysUp === true,
    alwaysDown: t.alwaysDown === true,
  };
}

/** The legacy 07:00–18:59 local rule, used when no real anchor is available. */
function hourIsDay(now: Date): boolean {
  const h = now.getHours();
  return h >= 7 && h < 19;
}

/**
 * True when `now` falls in the night window (compare **instants**, not hours).
 *
 * Degenerate cases:
 *  - polar day (`alwaysUp`) → day;
 *  - polar night (`alwaysDown`) → night;
 *  - a missing real anchor → the 07:00–18:59 fallback rule.
 */
export function isNight(now: Date, window: NightWindow): boolean {
  if (window.alwaysUp) return false;
  if (window.alwaysDown) return true;
  if (valid(window.dusk) && valid(window.dawn)) {
    const t = now.getTime();
    // Day is [dawn, dusk); night is everything else.
    return t < window.dawn.getTime() || t >= window.dusk.getTime();
  }
  return !hourIsDay(now);
}

/**
 * Milliseconds until the next real boundary (dusk or dawn instant).
 *
 * The window holds `now`'s solar day; a phase that already passed today recurs
 * about 24 h later, so both today's and tomorrow's occurrences are considered.
 * The result is capped at `MAX_BOUNDARY_MS` and is always > 0, so a long,
 * dark, or polar stretch still re-checks periodically.
 */
export function msUntilNextBoundary(now: Date, window: NightWindow): number {
  const t = now.getTime();
  let best = Infinity;
  for (const anchor of [window.dawn, window.dusk]) {
    if (!valid(anchor)) continue;
    for (const candidate of [anchor.getTime(), anchor.getTime() + DAY_MS]) {
      if (candidate > t) best = Math.min(best, candidate - t);
    }
  }
  if (!Number.isFinite(best) || best <= 0 || best > MAX_BOUNDARY_MS) {
    return MAX_BOUNDARY_MS;
  }
  return best;
}
