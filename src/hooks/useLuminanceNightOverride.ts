/**
 * Luminance override for `auto` Day/Night switching (ADR 0001, Phase 2).
 *
 * The solar boundary is the authority; the camera's own frame brightness may
 * only pull night **earlier** than dusk (overcast, storm, deep shade). It must
 * never drive the return to day: the night profile locks exposure / may light up
 * IR, so a single brightness metric would read "bright = day" the instant night
 * engaged and flap. The return to day is owned solely by the solar `dawn`
 * boundary, which is why the latch is released whenever it is already solar
 * night (so the next dawn returns to day even if the frame still reads dark).
 *
 * The decision is a pure function (`lumaOverrideDecision`) so it is unit-testable
 * without React; the hook is a thin per-camera adapter over it.
 */
import { useEffect, useRef, useState } from 'react';
import { isNight } from '../utils/sunWindow';
import type { NightWindow } from '../utils/sunWindow';
import type { Camera } from '../utils/storage';
import type { EngineMetrics } from './useEngineMetrics';

/** EMA smoothing factor: `ema = alpha·luma + (1 - alpha)·prev`. */
export const LUMA_EMA_ALPHA = 0.3;
/**
 * Night threshold on the native 0–255 Rec.601 scale, matching
 * `MotionGate.NIGHT_LUMA = 55`. Deliberately conservative (low): only a
 * genuinely dark frame advances night.
 */
export const LUMA_NIGHT_THRESHOLD = 55;
/** How long the smoothed luminance must stay below threshold before night. */
export const LUMA_DWELL_MS = 20_000;
/** Minimum gap between two luma-driven night switches (anti-flap). */
export const LUMA_LOCKOUT_MS = 30_000;

/** Per-camera luminance-override state. */
export interface LumaOverrideState {
  /** Smoothed luminance, or null before the first known sample. */
  ema: number | null;
  /** When the EMA first dropped below threshold (dwell timer), or null. */
  belowSince: number | null;
  /** When the last luma-driven night switch fired, or null. */
  lastTriggerAt: number | null;
  /** Latched: luminance currently holds this camera in night. */
  forcedNight: boolean;
}

/** Fresh state for a camera with no luminance history. */
export const INITIAL_LUMA_STATE: LumaOverrideState = {
  ema: null,
  belowSince: null,
  lastTriggerAt: null,
  forcedNight: false,
};

export interface LumaOverrideOptions {
  threshold?: number;
  dwellMs?: number;
  lockoutMs?: number;
  alpha?: number;
}

export interface LumaOverrideDecision {
  /** Next state to persist for this camera. */
  state: LumaOverrideState;
  /** True when the camera should currently be forced to night. */
  forceNight: boolean;
  /** True only on the false→true transition (a day→night switch fired). */
  becameNight: boolean;
}

/**
 * Advance one camera's luminance override by a single sample.
 *
 * Non-negotiable rules (ADR 0001):
 *  - day→night only; luminance never returns a camera to day;
 *  - `meanLuma <= 0` is "unknown" and is ignored (and never releases a latch);
 *  - the latch is released only when `solarNight` is true, so the next solar
 *    `dawn` owns the return to day;
 *  - `dwellMs` below threshold is required, and a new trigger is blocked for
 *    `lockoutMs` after the previous one.
 */
export function lumaOverrideDecision(
  prev: LumaOverrideState,
  meanLuma: number,
  now: number,
  solarNight: boolean,
  opts: LumaOverrideOptions = {},
): LumaOverrideDecision {
  const threshold = opts.threshold ?? LUMA_NIGHT_THRESHOLD;
  const dwellMs = opts.dwellMs ?? LUMA_DWELL_MS;
  const lockoutMs = opts.lockoutMs ?? LUMA_LOCKOUT_MS;
  const alpha = opts.alpha ?? LUMA_EMA_ALPHA;

  // Solar night already owns the slot: release the latch and re-arm so the next
  // dawn returns to day regardless of the (exposure-locked) frame brightness.
  if (solarNight) {
    return {
      state: { ...prev, belowSince: null, forcedNight: false },
      forceNight: false,
      becameNight: false,
    };
  }

  // Unknown luminance: no frame yet. Ignore it entirely (never releases).
  if (!(meanLuma > 0)) {
    return { state: prev, forceNight: prev.forcedNight, becameNight: false };
  }

  const ema = prev.ema == null ? meanLuma : alpha * meanLuma + (1 - alpha) * prev.ema;

  if (ema >= threshold) {
    // Bright enough: re-arm the dwell. An active latch is never released here —
    // night→day is owned by the solar dawn boundary, not luminance.
    return {
      state: { ...prev, ema, belowSince: null },
      forceNight: prev.forcedNight,
      becameNight: false,
    };
  }

  // Below threshold: run the dwell timer.
  const belowSince = prev.belowSince ?? now;
  if (prev.forcedNight) {
    return { state: { ...prev, ema, belowSince }, forceNight: true, becameNight: false };
  }

  const dwellElapsed = now - belowSince >= dwellMs;
  const lockoutElapsed = prev.lastTriggerAt == null || now - prev.lastTriggerAt >= lockoutMs;
  if (dwellElapsed && lockoutElapsed) {
    return {
      state: { ...prev, ema, belowSince, forcedNight: true, lastTriggerAt: now },
      forceNight: true,
      becameNight: true,
    };
  }
  return { state: { ...prev, ema, belowSince }, forceNight: false, becameNight: false };
}

/**
 * Per-`auto`-camera luminance override over the engine metrics stream.
 *
 * Returns a map of camera id → "luminance is forcing night" for the current
 * instant. Cameras that are not `auto` are never present. The map identity
 * changes on every metrics poll so callers can use it as an effect dependency;
 * actual transitions are still de-duplicated downstream by the applied-slot
 * bookkeeping in `useDayNightSwitch`.
 */
export function useLuminanceNightOverride(
  cameras: Camera[],
  metrics: EngineMetrics,
  getWindow: () => NightWindow | null,
): Map<string, boolean> {
  const [lumaNight, setLumaNight] = useState<Map<string, boolean>>(() => new Map());
  const statesRef = useRef<Map<string, LumaOverrideState>>(new Map());

  useEffect(() => {
    const now = Date.now();
    const window = getWindow();
    const solarNight = window != null && isNight(new Date(now), window);
    const next = new Map<string, boolean>();
    const seen = new Set<string>();

    for (const cam of cameras) {
      if (cam.dayNight !== 'auto') continue;
      seen.add(cam.id);
      const meanLuma = metrics.cameraStats.get(cam.id)?.meanLuma ?? 0;
      const prev = statesRef.current.get(cam.id) ?? INITIAL_LUMA_STATE;
      const decision = lumaOverrideDecision(prev, meanLuma, now, solarNight);
      statesRef.current.set(cam.id, decision.state);
      if (decision.forceNight) next.set(cam.id, true);
    }

    for (const id of Array.from(statesRef.current.keys())) {
      if (!seen.has(id)) statesRef.current.delete(id);
    }
    setLumaNight(next);
  }, [cameras, metrics, getWindow]);

  return lumaNight;
}
