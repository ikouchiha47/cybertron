/**
 * Behavioural tests for the luminance override decision (ADR 0001, Phase 2).
 *
 * Product promises, in the order the ADR states them: night may be pulled in by
 * luminance (after a dwell), but it is NEVER returned to day by luminance; a
 * missing/zero reading is ignored; a switch is rate-limited by a lockout; and
 * the latch is released only by the solar boundary.
 *
 * No React, RN, or I/O: only the pure `lumaOverrideDecision` is exercised.
 */
import { describe, it, expect } from 'vitest';

import {
  INITIAL_LUMA_STATE,
  LUMA_DWELL_MS,
  LUMA_LOCKOUT_MS,
  LUMA_NIGHT_THRESHOLD,
  lumaOverrideDecision,
} from './useLuminanceNightOverride';
import type { LumaOverrideState } from './useLuminanceNightOverride';

const T0 = 1_700_000_000_000;
/** A dark sample below the night threshold. */
const DARK = 40;
/** A bright sample well above the night threshold. */
const BRIGHT = 200;

function state(overrides: Partial<LumaOverrideState> = {}): LumaOverrideState {
  return { ...INITIAL_LUMA_STATE, ...overrides };
}

describe('lumaOverrideDecision — threshold edge', () => {
  it('treats exactly the threshold as clear (not night)', () => {
    const d = lumaOverrideDecision(INITIAL_LUMA_STATE, LUMA_NIGHT_THRESHOLD, T0, false);
    expect(d.state.ema).toBe(LUMA_NIGHT_THRESHOLD);
    expect(d.forceNight).toBe(false);
    expect(d.state.belowSince).toBeNull();
  });

  it('arms the dwell timer for a sample just below the threshold', () => {
    const d = lumaOverrideDecision(INITIAL_LUMA_STATE, LUMA_NIGHT_THRESHOLD - 0.1, T0, false);
    expect(d.forceNight).toBe(false);
    expect(d.becameNight).toBe(false);
    expect(d.state.belowSince).toBe(T0);
  });
});

describe('lumaOverrideDecision — dwell timing', () => {
  it('does not switch until the EMA has stayed below threshold for dwellMs', () => {
    let s = INITIAL_LUMA_STATE;

    const first = lumaOverrideDecision(s, DARK, T0, false);
    expect(first.forceNight).toBe(false);
    expect(first.state.belowSince).toBe(T0);
    s = first.state;

    const justBefore = lumaOverrideDecision(s, DARK, T0 + LUMA_DWELL_MS - 1, false);
    expect(justBefore.becameNight).toBe(false);
    expect(justBefore.forceNight).toBe(false);
    s = justBefore.state;

    const atDwell = lumaOverrideDecision(s, DARK, T0 + LUMA_DWELL_MS, false);
    expect(atDwell.becameNight).toBe(true);
    expect(atDwell.forceNight).toBe(true);
  });

  it('becomes night only once (becameNight is a single-shot edge)', () => {
    let s = INITIAL_LUMA_STATE;
    s = lumaOverrideDecision(s, DARK, T0, false).state;
    const trigger = lumaOverrideDecision(s, DARK, T0 + LUMA_DWELL_MS, false);
    s = trigger.state;
    const again = lumaOverrideDecision(s, DARK, T0 + LUMA_DWELL_MS + 1000, false);
    expect(again.forceNight).toBe(true);
    expect(again.becameNight).toBe(false);
  });

  it('resets the dwell timer when the frame brightens again', () => {
    let s = INITIAL_LUMA_STATE;
    s = lumaOverrideDecision(s, DARK, T0, false).state;
    // A bright sample before dwell elapses re-arms the timer.
    const bright = lumaOverrideDecision(s, BRIGHT, T0 + 5000, false);
    expect(bright.state.belowSince).toBeNull();
    expect(bright.forceNight).toBe(false);
  });

  it('smooths with the EMA so a single bright sample does not instantly clear a dark trend', () => {
    const prev = state({ ema: 100 });
    const d = lumaOverrideDecision(prev, DARK, T0, false);
    // 0.3·40 + 0.7·100 = 82 → still above threshold.
    expect(d.state.ema).toBeCloseTo(82, 6);
    expect(d.forceNight).toBe(false);
    expect(d.state.belowSince).toBeNull();
  });
});

describe('lumaOverrideDecision — lockout', () => {
  it('blocks a new switch within lockoutMs of the previous one', () => {
    // Dwell long since elapsed, but the last trigger was 1s ago.
    const prev = state({
      ema: DARK,
      belowSince: T0 - LUMA_DWELL_MS,
      lastTriggerAt: T0,
      forcedNight: false,
    });
    const blocked = lumaOverrideDecision(prev, DARK, T0 + 1000, false);
    expect(blocked.forceNight).toBe(false);
    expect(blocked.becameNight).toBe(false);
  });

  it('allows a switch once the lockout has elapsed', () => {
    const prev = state({
      ema: DARK,
      belowSince: T0 - LUMA_DWELL_MS,
      lastTriggerAt: T0,
      forcedNight: false,
    });
    const allowed = lumaOverrideDecision(prev, DARK, T0 + LUMA_LOCKOUT_MS, false);
    expect(allowed.becameNight).toBe(true);
    expect(allowed.forceNight).toBe(true);
  });
});

describe('lumaOverrideDecision — never forces day', () => {
  it('keeps a latched night even when the frame turns bright', () => {
    const latched = state({
      ema: DARK,
      belowSince: T0,
      lastTriggerAt: T0,
      forcedNight: true,
    });
    const d = lumaOverrideDecision(latched, BRIGHT, T0 + 5000, false);
    expect(d.forceNight).toBe(true);
    expect(d.becameNight).toBe(false);
    expect(d.state.forcedNight).toBe(true);
  });
});

describe('lumaOverrideDecision — unknown luminance', () => {
  it('ignores a zero reading (no frame yet) and never switches', () => {
    const d = lumaOverrideDecision(INITIAL_LUMA_STATE, 0, T0, false);
    expect(d.forceNight).toBe(false);
    expect(d.becameNight).toBe(false);
    expect(d.state).toBe(INITIAL_LUMA_STATE); // untouched
  });

  it('does not release an active latch on a negative/zero reading', () => {
    const latched = state({ ema: DARK, belowSince: T0, lastTriggerAt: T0, forcedNight: true });
    const d = lumaOverrideDecision(latched, -1, T0 + 5000, false);
    expect(d.forceNight).toBe(true);
    expect(d.state).toBe(latched);
  });
});

describe('lumaOverrideDecision — solar boundary owns the return to day', () => {
  it('releases the latch and re-arms when it is already solar night', () => {
    const latched = state({ ema: DARK, belowSince: T0, lastTriggerAt: T0, forcedNight: true });
    const d = lumaOverrideDecision(latched, DARK, T0 + 5000, true);
    expect(d.forceNight).toBe(false);
    expect(d.becameNight).toBe(false);
    expect(d.state.forcedNight).toBe(false);
    expect(d.state.belowSince).toBeNull();
  });
});
