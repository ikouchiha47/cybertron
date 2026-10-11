/**
 * One-shot install-time location read for the season-aware day/night feature.
 *
 * GPS is a convenience, never a requirement: every failure path (denied
 * permission, provider error, timeout, malformed fix) resolves to `null` so the
 * caller keeps its existing/manual coordinates and continues.
 *
 * No UI and no storage side effects — the only externally visible action is the
 * foreground permission prompt, and only when permission is not already granted.
 *
 * Coarse, city-level accuracy is ample for a dusk/dawn estimate, so `Balanced`
 * is used and no precise fix is needed.
 */
import * as Location from 'expo-location';

/** Coarse city-level fix is more than enough for a solar-time estimate. */
const ACCURACY = Location.Accuracy.Balanced;
/** Upper bound on acquiring a live fix; falls back to `null` rather than hang. */
const TIMEOUT_MS = 12_000;

export interface Coords {
  lat: number;
  lng: number;
}

/** Accept only finite, in-range coordinates (rejects a malformed/null fix). */
function toCoords(value: Location.LocationObject | null | undefined): Coords | null {
  if (!value || !value.coords) return null;
  const { latitude, longitude } = value.coords;
  if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) return null;
  if (latitude < -90 || latitude > 90) return null;
  if (longitude < -180 || longitude > 180) return null;
  return { lat: latitude, lng: longitude };
}

/** Reject if `promise` has not settled within `ms`; the loser is ignored. */
function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('location-timeout')), ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

/**
 * Resolve the current device coordinates, or `null` on deny/timeout/error.
 *
 * Flow: check permission → request only if not already granted → prefer a
 * cached last-known fix (instant, no radio wake-up) → fall back to a live fix
 * bounded by `TIMEOUT_MS`.
 */
export async function requestInstallLocation(): Promise<Coords | null> {
  try {
    let permission = await Location.getForegroundPermissionsAsync();
    if (!permission.granted) {
      permission = await Location.requestForegroundPermissionsAsync();
    }
    if (!permission.granted) return null;

    const lastKnown = await Location.getLastKnownPositionAsync();
    const cached = toCoords(lastKnown);
    if (cached) return cached;

    const current = await withTimeout(
      Location.getCurrentPositionAsync({ accuracy: ACCURACY }),
      TIMEOUT_MS,
    );
    return toCoords(current);
  } catch {
    return null;
  }
}
