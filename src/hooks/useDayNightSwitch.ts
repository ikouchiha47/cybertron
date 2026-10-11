import { useCallback, useEffect, useRef } from 'react';
import {
  Camera,
  ProfileSlot,
  activeProfileSlot,
  resolveProfile,
} from '../utils/storage';
import { NightWindow, msUntilNextBoundary } from '../utils/sunWindow';

/** Stable empty override map, so omitting `lumaNight` never churns the effect. */
const NO_LUMA_OVERRIDE: Map<string, boolean> = new Map();

/** Invoked only on a real slot transition for an `auto` camera. */
export type DayNightSwitchHandler = (camera: Camera) => void;

export interface UseDayNightSwitchResult {
  /**
   * Record the slot a camera is currently running. Call after a manual
   * Day/Night mode change so the timer does not immediately override it.
   */
  noteApplied: (camera: Camera) => void;
  /**
   * Re-evaluate every `auto` camera's Day/Night slot right now and dispatch a
   * switch for any that changed. Call when the app returns to the foreground:
   * the boundary `setTimeout` does not fire while JS is suspended (screen off /
   * backgrounded), so a slot crossed during sleep would otherwise stay stale
   * until the *next* boundary.
   */
  recheck: () => void;
}

/**
 * Milliseconds until the next legacy wall-clock boundary (07:00 or 19:00
 * local), matching `activeProfileSlot`'s no-coordinates fallback rule.
 * Used only when no solar window is available.
 */
function msUntilNextClockBoundary(now: Date): number {
  const next = new Date(now.getTime());
  const hour = now.getHours();
  if (hour < 7) {
    next.setHours(7, 0, 0, 0);
  } else if (hour < 19) {
    next.setHours(19, 0, 0, 0);
  } else {
    next.setDate(next.getDate() + 1);
    next.setHours(7, 0, 0, 0);
  }
  return Math.max(0, next.getTime() - now.getTime());
}

/**
 * Keeps `auto` cameras in sync with the real Day/Night boundary — solar
 * dusk/dawn when the install has coordinates, otherwise the legacy 07:00/19:00
 * clock.
 *
 * `resolveProfile` is otherwise only applied at startup or on an explicit mode
 * change, so a running app would keep a night profile (e.g. exposure lock) past
 * dawn. This schedules a single self-rescheduling timeout pinned to the next
 * boundary: on fire it compares every `auto` camera's active slot against the
 * last-applied slot and, only on a real change, hands the re-resolved camera to
 * `onSwitch` (which persists + reconciles the hardware). Manual `day`/`night`
 * cameras are never touched.
 *
 * The window is obtained through `getWindow`, not passed as a snapshot: the
 * hook re-derives it from the latest store location on every check (mount,
 * each timer fire, and each foreground `recheck`). That keeps the boundary
 * fresh across midnight/DST/suspension without restarting the timer, and lets
 * `App` own the single place that turns `location` into solar times.
 *
 * `lumaNight` (Phase 2) is the luminance override's per-camera "force night"
 * map. It is OR-ed into the solar slot for `auto` cameras and re-evaluated on
 * every change, but the transition still flows through this hook's single
 * `appliedRef`/`onSwitch` path — no hardware-push logic is duplicated.
 */
export function useDayNightSwitch(
  cameras: Camera[],
  getWindow: () => NightWindow | null,
  onSwitch: DayNightSwitchHandler,
  lumaNight: Map<string, boolean> = NO_LUMA_OVERRIDE,
): UseDayNightSwitchResult {
  const camerasRef = useRef(cameras);
  const getWindowRef = useRef(getWindow);
  const onSwitchRef = useRef(onSwitch);
  const lumaNightRef = useRef(lumaNight);
  // Last-applied slot per camera id. Presence means "already in this slot" —
  // never re-push on every tick.
  const appliedRef = useRef<Map<string, ProfileSlot>>(new Map());
  // The live transition check, owned by the mount effect but callable on demand
  // (e.g. AppState 'active') via `recheck`.
  const runCheckRef = useRef<() => void>(() => {});

  useEffect(() => { camerasRef.current = cameras; }, [cameras]);
  useEffect(() => { getWindowRef.current = getWindow; }, [getWindow]);
  useEffect(() => { onSwitchRef.current = onSwitch; }, [onSwitch]);
  useEffect(() => { lumaNightRef.current = lumaNight; }, [lumaNight]);

  // Seed newly-seen auto cameras with their current slot so startup and
  // freshly-added cameras don't look like transitions. Drop removed cameras.
  useEffect(() => {
    const now = new Date();
    const window = getWindowRef.current();
    const ids = new Set<string>();
    for (const cam of cameras) {
      ids.add(cam.id);
      if (cam.dayNight !== 'auto') continue;
      if (!appliedRef.current.has(cam.id)) {
        const slot = lumaNightRef.current.get(cam.id)
          ? 'night'
          : activeProfileSlot(cam, now, window);
        appliedRef.current.set(cam.id, slot);
      }
    }
    for (const id of Array.from(appliedRef.current.keys())) {
      if (!ids.has(id)) appliedRef.current.delete(id);
    }
  }, [cameras]);

  const noteApplied = useCallback((camera: Camera) => {
    appliedRef.current.set(
      camera.id,
      activeProfileSlot(camera, new Date(), getWindowRef.current()),
    );
  }, []);

  // Mounted once: stable across re-renders, cleaned up on unmount.
  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;

    const runCheck = () => {
      const now = new Date();
      const window = getWindowRef.current();
      for (const cam of camerasRef.current) {
        if (cam.dayNight !== 'auto') continue;
        const forceNight = lumaNightRef.current.get(cam.id) === true;
        const slot = forceNight ? 'night' : activeProfileSlot(cam, now, window);
        if (appliedRef.current.get(cam.id) === slot) continue;
        // Record before dispatching so a transition is acted on exactly once.
        appliedRef.current.set(cam.id, slot);
        const next: Camera = {
          ...cam,
          settings: forceNight ? { ...cam.night } : { ...resolveProfile(cam, now, window) },
        };
        try {
          onSwitchRef.current(next);
        } catch (e) {
          console.warn('[DoorCam] day/night switch failed', cam.id, e);
        }
      }
    };
    runCheckRef.current = runCheck;

    const schedule = () => {
      if (cancelled) return;
      const now = new Date();
      const window = getWindowRef.current();
      const delay = window
        ? msUntilNextBoundary(now, window)
        : msUntilNextClockBoundary(now);
      timer = setTimeout(() => {
        if (cancelled) return;
        runCheck();
        schedule();
      }, delay);
    };

    schedule();
    return () => {
      cancelled = true;
      if (timer != null) clearTimeout(timer);
    };
  }, []);

  // Luminance samples arrive about once a second — far faster than the solar
  // timer — so re-run the transition check whenever the override map changes,
  // applying an early-darkness switch promptly through the same path above.
  useEffect(() => {
    runCheckRef.current();
  }, [lumaNight]);

  const recheck = useCallback(() => runCheckRef.current(), []);

  return { noteApplied, recheck };
}
