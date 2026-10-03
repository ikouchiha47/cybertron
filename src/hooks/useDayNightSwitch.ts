import { useCallback, useEffect, useRef } from 'react';
import {
  Camera,
  ProfileSlot,
  activeProfileSlot,
  resolveProfile,
} from '../utils/storage';

/** Invoked only on a real slot transition for an `auto` camera. */
export type DayNightSwitchHandler = (camera: Camera) => void;

export interface UseDayNightSwitchResult {
  /**
   * Record the slot a camera is currently running. Call after a manual
   * Day/Night mode change so the timer does not immediately override it.
   */
  noteApplied: (camera: Camera) => void;
}

/**
 * Milliseconds until the next Day/Night boundary (07:00 or 19:00 local),
 * matching `activeProfileSlot`'s rule: day 07:00–18:59, night otherwise.
 */
function msUntilNextBoundary(now: Date): number {
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
 * Keeps `auto` cameras in sync with the wall clock while the app is running.
 *
 * `resolveProfile` is otherwise only applied at startup or on an explicit mode
 * change, so a running app would keep a night profile (e.g. exposure lock) past
 * 07:00. This schedules a single self-rescheduling timeout pinned to each
 * 07:00/19:00 boundary: on fire it compares every `auto` camera's active slot
 * against the last-applied slot and, only on a real change, hands the re-resolved
 * camera to `onSwitch` (which persists + reconciles the hardware). Manual
 * `day`/`night` cameras are never touched.
 */
export function useDayNightSwitch(
  cameras: Camera[],
  onSwitch: DayNightSwitchHandler,
): UseDayNightSwitchResult {
  const camerasRef = useRef(cameras);
  const onSwitchRef = useRef(onSwitch);
  // Last-applied slot per camera id. Presence means "already in this slot" —
  // never re-push on every tick.
  const appliedRef = useRef<Map<string, ProfileSlot>>(new Map());

  useEffect(() => { camerasRef.current = cameras; }, [cameras]);
  useEffect(() => { onSwitchRef.current = onSwitch; }, [onSwitch]);

  // Seed newly-seen auto cameras with their current slot so startup and
  // freshly-added cameras don't look like transitions. Drop removed cameras.
  useEffect(() => {
    const hour = new Date().getHours();
    const ids = new Set<string>();
    for (const cam of cameras) {
      ids.add(cam.id);
      if (cam.dayNight !== 'auto') continue;
      if (!appliedRef.current.has(cam.id)) {
        appliedRef.current.set(cam.id, activeProfileSlot(cam, hour));
      }
    }
    for (const id of Array.from(appliedRef.current.keys())) {
      if (!ids.has(id)) appliedRef.current.delete(id);
    }
  }, [cameras]);

  const noteApplied = useCallback((camera: Camera) => {
    appliedRef.current.set(
      camera.id,
      activeProfileSlot(camera, new Date().getHours()),
    );
  }, []);

  // Mounted once: stable across re-renders, cleaned up on unmount.
  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;

    const runCheck = () => {
      const hour = new Date().getHours();
      for (const cam of camerasRef.current) {
        if (cam.dayNight !== 'auto') continue;
        const slot = activeProfileSlot(cam, hour);
        if (appliedRef.current.get(cam.id) === slot) continue;
        // Record before dispatching so a transition is acted on exactly once.
        appliedRef.current.set(cam.id, slot);
        const next: Camera = {
          ...cam,
          settings: { ...resolveProfile(cam, hour) },
        };
        try {
          onSwitchRef.current(next);
        } catch (e) {
          console.warn('[DoorCam] day/night switch failed', cam.id, e);
        }
      }
    };

    const schedule = () => {
      if (cancelled) return;
      timer = setTimeout(() => {
        if (cancelled) return;
        runCheck();
        schedule();
      }, msUntilNextBoundary(new Date()));
    };

    schedule();
    return () => {
      cancelled = true;
      if (timer != null) clearTimeout(timer);
    };
  }, []);

  return { noteApplied };
}
