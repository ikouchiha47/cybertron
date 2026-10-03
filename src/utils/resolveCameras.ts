// @ts-ignore -- react-native-zeroconf ships no type declarations
import Zeroconf from 'react-native-zeroconf';
import { Camera } from './storage';

/**
 * Dynamic IP resolution.
 *
 * Cameras are keyed by stable identity (`id` = mDNS service name, `tag`), and
 * optionally a stable `host`. Their `ip` may change across reboots/DHCP, so we
 * re-discover the `_doorcam._tcp` service and refresh `ip` for any stored
 * camera we can match. Cameras that cannot be resolved are preserved untouched.
 */

const SCAN_TYPE = 'doorcam';
const SCAN_PROTOCOL = 'tcp';
const SCAN_DOMAIN = 'local.';
const SCAN_TIMEOUT_MS = 5000;

interface Resolution {
  /** IP keyed by every alias we might match on (name/host, raw + normalized). */
  byAlias: Map<string, string>;
}

function normalizeAlias(value: string): string {
  return (value || '').replace(/\.$/, '').toLowerCase();
}

function addAlias(map: Map<string, string>, alias: string | undefined, ip: string): void {
  if (!alias) return;
  map.set(alias, ip);
  const normalized = normalizeAlias(alias);
  if (normalized) map.set(normalized, ip);
}

/** Find the discovered IP for a camera by id, tag, then host. */
function matchIp(camera: Camera, byAlias: Map<string, string>): string | undefined {
  const candidates = [camera.id, camera.tag, camera.host].filter(
    (v): v is string => typeof v === 'string' && v.length > 0,
  );
  for (const candidate of candidates) {
    const direct = byAlias.get(candidate);
    if (direct) return direct;
    const normalized = byAlias.get(normalizeAlias(candidate));
    if (normalized) return normalized;
  }
  return undefined;
}

function scanOnce(cameras: Camera[]): Promise<Camera[]> {
  return new Promise(resolve => {
    const resolution: Resolution = { byAlias: new Map() };
    let zeroconf: any = null;
    let settled = false;

    const finish = () => {
      if (settled) return;
      settled = true;
      try {
        zeroconf?.stop?.();
      } catch {}
      try {
        zeroconf?.removeDeviceListeners?.();
      } catch {}
      resolve(
        cameras.map(camera => {
          const ip = matchIp(camera, resolution.byAlias);
          return ip && ip !== camera.ip ? { ...camera, ip } : camera;
        }),
      );
    };

    const timer = setTimeout(finish, SCAN_TIMEOUT_MS);

    try {
      zeroconf = new Zeroconf();
      zeroconf.on('resolved', (service: any) => {
        const ip = Array.isArray(service?.addresses) ? service.addresses[0] : undefined;
        if (!ip) return;
        addAlias(resolution.byAlias, service?.name, ip);
        addAlias(resolution.byAlias, service?.host, ip);
      });
      zeroconf.on('error', () => {
        clearTimeout(timer);
        finish();
      });
      zeroconf.scan(SCAN_TYPE, SCAN_PROTOCOL, SCAN_DOMAIN);
    } catch (e) {
      clearTimeout(timer);
      finish();
    }
  });
}

/**
 * Refresh each camera's `ip` from mDNS. Never throws; cameras that cannot be
 * matched (or when discovery fails) are returned unchanged.
 */
export async function resolveCameraIps(cameras: Camera[]): Promise<Camera[]> {
  if (cameras.length === 0) return cameras;
  try {
    const resolved = await scanOnce(cameras);
    return resolved;
  } catch (e) {
    console.log('[DoorCam] resolveCameraIps failed', e);
    return cameras;
  }
}
