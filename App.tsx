import React, { useCallback, useEffect, useRef, useState } from 'react';
import { AppState, DeviceEventEmitter, NativeModules } from 'react-native';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import * as Notifications from 'expo-notifications';
import {
  Camera,
  CameraSettings,
  CameraSettingsChange,
  Dashboard,
  DayNightMode,
  DEFAULT_CAMERA_SETTINGS,
  DEFAULT_DETECTION_SETTINGS,
  DetectionSettings,
  loadCameras,
  saveCameras,
  resolveProfile,
  activeProfileSlot,
  DEFAULT_DASHBOARD_ID,
  normalizeDetection,
} from './src/utils/storage';
import {
  pushSetting,
  syncCamera,
  hardwareValueForVar,
  managedVarsForSetting,
  adoptCameraStatus,
  isDefaultSettings,
  ManagedVar,
} from './src/utils/cameraSettings';
import { resolveCameraIps } from './src/utils/resolveCameras';
import { resolveNightWindow, NightWindow } from './src/utils/sunWindow';
import { requestInstallLocation } from './src/utils/deviceLocation';
import { useDayNightSwitch } from './src/hooks/useDayNightSwitch';
import { useEngineMetrics } from './src/hooks/useEngineMetrics';
import { useLuminanceNightOverride } from './src/hooks/useLuminanceNightOverride';
import { DEFAULT_STORE_SEED } from './src/config/defaultConfig';
import { registerBackgroundDetection } from './src/utils/backgroundDetection';
import SetupScreen from './src/screens/SetupScreen';
import MonitorScreen from './src/screens/MonitorScreen';
import GalleryScreen from './src/screens/GalleryScreen';
// Must import so TaskManager registers the task definition at startup
import './src/utils/backgroundDetection';

type Screen = 'monitor' | 'setup' | 'gallery';

const SETTINGS_KEYS: (keyof CameraSettings)[] = [
  'quality',
  'brightness',
  'contrast',
  'saturation',
  'hmirror',
  'vflip',
  'wbMode',
  'awb',
  'ledOn',
  'ledIntensity',
  'framesize',
  'exposureLock',
  'aecValue',
  'agcGain',
];

/** Full, exact comparison of two camera profiles. */
function settingsEqual(a: CameraSettings, b: CameraSettings): boolean {
  return SETTINGS_KEYS.every(k => a[k] === b[k]);
}

function makeDashboardId(): string {
  return `dash_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
}

/**
 * Push global detection tuning to the native engine. Key names MUST match
 * `InferencePipeline.setDetectionConfig` in DoorCamEngine.kt
 * (personScoreThreshold, kConfirm, mWindow, emptyFramesBeforeReset,
 * inferenceIntervalMs, baselineIntervalMs, keyframeIntervalMs, contrastEnhance,
 * minAspect, maxAspect, minBoxArea).
 * Fire-and-forget: never blocks or fails the UI.
 */
function pushDetectionConfig(settings: DetectionSettings) {
  try {
    NativeModules?.DoorCamModule?.setDetectionConfig?.({
      personScoreThreshold: settings.personScoreThreshold,
      kConfirm: settings.kConfirm,
      mWindow: settings.mWindow,
      emptyFramesBeforeReset: settings.emptyFramesBeforeReset,
      inferenceIntervalMs: settings.inferenceIntervalMs,
      baselineIntervalMs: settings.baselineIntervalMs,
      keyframeIntervalMs: settings.keyframeIntervalMs,
      contrastEnhance: settings.contrastEnhance,
      minAspect: settings.minAspect,
      maxAspect: settings.maxAspect,
      minBoxArea: settings.minBoxArea,
    });
  } catch (e) {
    // Native module may be unavailable (JS-only environments); ignore.
  }
}

export default function App() {
  const [cameras, setCameras] = useState<Camera[]>([]);
  const [dashboards, setDashboards] = useState<Dashboard[]>([]);
  const [activeDashboardId, setActiveDashboardIdState] = useState<string>(DEFAULT_DASHBOARD_ID);
  const [focusedId, setFocusedId] = useState<string | undefined>();
  const [detection, setDetection] = useState<DetectionSettings>(DEFAULT_DETECTION_SETTINGS);
  const [location, setLocation] = useState<{ lat: number; lng: number } | undefined>();
  const [screen, setScreen] = useState<Screen>('monitor');
  const [loading, setLoading] = useState(true);
  const [galleryEventId, setGalleryEventId] = useState<string | undefined>();

  // Refs mirror state so async work (IP resolution, status adoption) can persist
  // against the latest values without stale closures.
  const camerasRef = useRef<Camera[]>([]);
  const dashboardsRef = useRef<Dashboard[]>([]);
  const activeDashboardRef = useRef<string>(DEFAULT_DASHBOARD_ID);
  const focusedRef = useRef<string | undefined>(undefined);
  const detectionRef = useRef<DetectionSettings>(DEFAULT_DETECTION_SETTINGS);
  const locationRef = useRef<{ lat: number; lng: number } | undefined>(undefined);
  useEffect(() => { camerasRef.current = cameras; }, [cameras]);
  useEffect(() => { dashboardsRef.current = dashboards; }, [dashboards]);
  useEffect(() => { activeDashboardRef.current = activeDashboardId; }, [activeDashboardId]);
  useEffect(() => { focusedRef.current = focusedId; }, [focusedId]);
  useEffect(() => { detectionRef.current = detection; }, [detection]);
  useEffect(() => { locationRef.current = location; }, [location]);

  /**
   * Resolve the solar night window for the current instant from the install
   * location, or null when no coordinates are set (legacy 07:00/19:00 fallback).
   * Lazily re-derived at each call site so it never goes stale across midnight;
   * the hook receives this resolver rather than a snapshot.
   */
  const getNightWindow = useCallback((): NightWindow | null => {
    const loc = locationRef.current;
    if (!loc) return null;
    return resolveNightWindow(new Date(), loc.lat, loc.lng);
  }, []);

  /** Persist the current camera list alongside the latest dashboard/focus state. */
  function persistRefs(nextCameras: Camera[]) {
    saveCameras({
      version: 3,
      cameras: nextCameras,
      dashboards: dashboardsRef.current,
      activeDashboardId: activeDashboardRef.current,
      focusedId: focusedRef.current,
      detection: detectionRef.current,
      location: locationRef.current,
    }).catch(e => console.warn('[DoorCam] failed to save cameras:', e));
  }

  /**
   * Set or clear the global install location. The ref is updated first so the
   * synchronous save below persists the new value through the existing path
   * (which already includes `location`).
   */
  function handleSetLocation(loc: { lat: number; lng: number } | undefined) {
    locationRef.current = loc;
    setLocation(loc);
    persistRefs(camerasRef.current);
  }

  /** Merge one camera (matched by id) into state and persist. */
  function mergeCamera(updated: Camera) {
    setCameras(prev => {
      const next = prev.map(c => (c.id === updated.id ? updated : c));
      camerasRef.current = next;
      persistRefs(next);
      return next;
    });
  }

  /**
   * Adopt refreshed IPs from mDNS into state, keyed by id. Only the `ip` field
   * is touched so concurrent settings edits are never clobbered.
   */
  function mergeResolvedIps(resolvedCameras: Camera[]) {
    setCameras(prev => {
      const byId = new Map(resolvedCameras.map(c => [c.id, c]));
      let changed = false;
      const next = prev.map(c => {
        const r = byId.get(c.id);
        if (r && r.ip && r.ip !== c.ip) {
          changed = true;
          return { ...c, ip: r.ip };
        }
        return c;
      });
      if (!changed) return prev;
      camerasRef.current = next;
      persistRefs(next);
      return next;
    });
  }

  // In-session auto Day/Night switch: when an `auto` camera's active slot
  // crosses the solar dusk/dawn (or the 07:00/19:00 fallback while the app is
  // running), re-resolve its effective settings, persist, then reconcile the
  // hardware (fire-and-forget).
  const handleAutoProfileSwitch = useCallback((nextCam: Camera) => {
    setCameras(prev => {
      const next = prev.map(c => (c.id === nextCam.id ? nextCam : c));
      camerasRef.current = next;
      persistRefs(next);
      return next;
    });
    void syncCamera(nextCam);
  }, []);

  // Phase 2 (ADR 0001): spend the engine's per-frame luminance to pull night in
  // earlier than dusk on `auto` cameras. Enabled while any auto camera exists;
  // native `meanLuma` is 0 (ignored) until a frame has been seen, so this is
  // inert and Phase 1 behaviour is unchanged when there is no luma data.
  const hasAutoCamera = cameras.some(c => c.dayNight === 'auto');
  const metrics = useEngineMetrics(hasAutoCamera);
  const lumaNight = useLuminanceNightOverride(cameras, metrics, getNightWindow);

  // Safety net that does not trust in-memory slot bookkeeping: recompute every
  // auto camera's slot from the current time + location, write it to the store,
  // and reconcile the hardware. Covers the cases the in-session timer misses:
  // a frozen/backgrounded timer at dawn/dusk, a silently-failed push, and an
  // ESP that rebooted back to its boot defaults.
  const reconcileAll = useCallback(() => {
    const now = new Date();
    const window = getNightWindow();
    const prev = camerasRef.current;
    let changed = false;
    const next = prev.map(cam => {
      if (cam.dayNight !== 'auto') return cam;
      const target =
        activeProfileSlot(cam, now, window) === 'night' ? cam.night : cam.day;
      if (settingsEqual(cam.settings, target)) return cam;
      changed = true;
      return { ...cam, settings: { ...target } };
    });
    if (changed) {
      camerasRef.current = next;
      setCameras(next);
      persistRefs(next);
    }
    for (const cam of next) {
      if (cam.ip) void syncCamera(cam);
    }
  }, [getNightWindow]);

  // Keep the process alive with a foreground service: the OS otherwise freezes
  // the app overnight and the day/night timer never fires at dawn.
  useEffect(() => {
    try {
      NativeModules?.DoorCamModule?.startForegroundService?.();
    } catch (e) {
      console.warn('[DoorCam] failed to start foreground service:', e);
    }
  }, []);

  // Reconcile on start, every 30 minutes, and whenever a camera reconnects
  // (throttled: a flapping camera must not trigger a push storm).
  useEffect(() => {
    reconcileAll();
    let lastOnlineAt = 0;
    const timer = setInterval(reconcileAll, 30 * 60 * 1000);
    const sub = DeviceEventEmitter.addListener(
      'CameraStatus',
      (e: { streamId?: string; online?: boolean }) => {
        if (e?.online !== true) return;
        const now = Date.now();
        if (now - lastOnlineAt < 60_000) return;
        lastOnlineAt = now;
        reconcileAll();
      },
    );
    return () => {
      clearInterval(timer);
      sub.remove();
    };
  }, [reconcileAll]);

  const { noteApplied, recheck } = useDayNightSwitch(
    cameras,
    getNightWindow,
    handleAutoProfileSwitch,
    lumaNight,
  );

  // Re-check the Day/Night slot whenever the app returns to the foreground. The
  // boundary timer is a JS setTimeout, which is suspended while backgrounded
  // (screen off), so a 07:00/19:00 boundary crossed during sleep would otherwise
  // leave `auto` cameras on a stale profile until the *next* boundary — e.g. a
  // night exposure lock still running at 11am, blowing the frame out to white.
  useEffect(() => {
    const sub = AppState.addEventListener('change', state => {
      if (state === 'active') recheck();
    });
    return () => sub.remove();
  }, [recheck]);

  useEffect(() => {
    // Seed from the shipped default config only when there is no store / no cameras.
    loadCameras(DEFAULT_STORE_SEED).then(store => {
      // Resolve each camera's effective settings from its Day/Night profile.
      const now = new Date();
      const window = store.location
        ? resolveNightWindow(now, store.location.lat, store.location.lng)
        : null;
      const resolved = store.cameras.map(cam => ({
        ...cam,
        settings: { ...resolveProfile(cam, now, window) },
      }));
      const initialFocus = resolved.length > 1 ? undefined : store.focusedId;
      setCameras(resolved);
      camerasRef.current = resolved;
      setDashboards(store.dashboards);
      dashboardsRef.current = store.dashboards;
      setActiveDashboardIdState(store.activeDashboardId);
      activeDashboardRef.current = store.activeDashboardId;
      setDetection(store.detection);
      detectionRef.current = store.detection;
      setLocation(store.location);
      locationRef.current = store.location;
      // Acquire the install location at launch when it is still unset and an
      // `auto` camera exists, so the solar day/night switch has real dusk/dawn
      // without a manual trip to the settings sheet. Prompts for the foreground
      // permission once; a denial (or timeout) leaves the store untouched and the
      // 07:00/19:00 clock fallback stays in effect.
      if (!store.location && resolved.some(c => c.dayNight === 'auto')) {
        void requestInstallLocation().then(coords => {
          if (coords) handleSetLocation(coords);
        });
      }
      // Grid is home for multi-camera: ignore any persisted focus when there's more than one camera.
      setFocusedId(initialFocus);
      focusedRef.current = initialFocus;
      if (resolved.length === 0) setScreen('setup');
      setLoading(false);

      // Push the (normalized) global detection tuning to the native engine.
      pushDetectionConfig(store.detection);

      // Persist the resolved effective settings for the current session.
      saveCameras({ ...store, cameras: resolved }).catch(e =>
        console.warn('[DoorCam] failed to save resolved cameras:', e),
      );

      // App is the source of truth: reconcile each camera's hardware with the
      // stored settings on startup. Sequential, fire-and-forget — never blocks
      // the UI and never fails startup.
      void (async () => {
        // 1. Refresh dynamic IPs from mDNS (stable id/tag/host → current ip).
        const withIps = await resolveCameraIps(resolved);
        const current = withIps;
        if (withIps.some((c, i) => c.ip !== resolved[i].ip)) {
          mergeResolvedIps(withIps);
        }

        // 2. Re-baseline cameras still at firmware defaults against their live
        //    `/status`, then reconcile the rest.
        for (let i = 0; i < current.length; i++) {
          const cam = current[i];
          if (cam.ip && isDefaultSettings(cam.settings)) {
            const adopted = await adoptCameraStatus(cam, now, window);
            if (adopted !== cam) mergeCamera(adopted);
          }
          await syncCamera(current[i]);
        }
      })();
    });
    registerBackgroundDetection();

    // Notification tap — open gallery at the relevant event
    const sub = Notifications.addNotificationResponseReceivedListener(response => {
      const eventId = response.notification.request.content.data?.eventId as string | undefined;
      setGalleryEventId(eventId);
      setScreen('gallery');
    });
    return () => sub.remove();
  }, []);

  /**
   * Re-resolve camera IPs from mDNS (called when a camera goes offline, and
   * available for manual recovery). Persists any refreshed addresses.
   */
  const handleResolveCameras = useCallback(() => {
    void (async () => {
      const prev = camerasRef.current;
      if (prev.length === 0) return;
      const withIps = await resolveCameraIps(prev);
      if (withIps.some((c, i) => c.ip !== prev[i].ip)) mergeResolvedIps(withIps);
    })();
  }, []);

  function persistAll(
    nextCameras: Camera[],
    nextDashboards: Dashboard[],
    nextActiveDashboardId: string,
    nextFocusedId?: string,
  ) {
    saveCameras({
      version: 3,
      cameras: nextCameras,
      dashboards: nextDashboards,
      activeDashboardId: nextActiveDashboardId,
      focusedId: nextFocusedId,
      detection: detectionRef.current,
      location: locationRef.current,
    }).catch(e => console.warn('[DoorCam] failed to save cameras:', e));
  }

  /**
   * Global detection tuning: sanitize/clamp, persist, then re-push the full
   * config to the native engine (fire-and-forget). Not per-camera.
   */
  function handleUpdateDetection(patch: Partial<DetectionSettings>) {
    setDetection(prev => {
      const next = normalizeDetection({ ...prev, ...patch });
      detectionRef.current = next;
      saveCameras({
        version: 3,
        cameras: camerasRef.current,
        dashboards: dashboardsRef.current,
        activeDashboardId: activeDashboardRef.current,
        focusedId: focusedRef.current,
        detection: next,
        location: locationRef.current,
      }).catch(e => console.warn('[DoorCam] failed to save detection settings:', e));
      pushDetectionConfig(next);
      return next;
    });
  }

  /** Seed a camera's settings/profiles from its live `/status` (no-op if offline). */
  function seedFromStatus(camera: Camera) {
    if (!camera.ip) return;
    void (async () => {
      const adopted = await adoptCameraStatus(camera, new Date(), getNightWindow());
      if (adopted !== camera) mergeCamera(adopted);
    })();
  }

  function handleAddCamera(camera: Camera) {
    // Claim an existing entry when it shares identity (id) or address (ip).
    // This lets a discovered device fill in a seeded placeholder's IP/host.
    const existing =
      cameras.find(c => c.id === camera.id) ??
      (camera.ip ? cameras.find(c => c.ip === camera.ip) : undefined);
    if (existing) {
      const needsUpdate =
        camera.ip && camera.ip !== existing.ip
        || (camera.host && !existing.host)
        || (camera.name && !existing.name);
      if (needsUpdate) {
        const updated: Camera = {
          ...existing,
          name: camera.name || existing.name,
          tag: camera.tag || existing.tag,
          host: camera.host || existing.host,
          ip: camera.ip || existing.ip,
        };
        mergeCamera(updated);
        if (isDefaultSettings(updated.settings)) seedFromStatus(updated);
      }
      return;
    }

    const settings = camera.settings ?? { ...DEFAULT_CAMERA_SETTINGS };
    const withSettings: Camera = {
      ...camera,
      settings,
      day: camera.day ?? { ...settings },
      night: camera.night ?? { ...settings },
      dayNight: camera.dayNight ?? 'auto',
    };
    const next = [...cameras, withSettings];
    // Land on the grid whenever there's more than one camera; fullscreen only for a single camera.
    const nextFocus = next.length > 1 ? undefined : withSettings.id;
    // Rule 1: the default dashboard always contains all cameras.
    const nextDashboards = dashboards.map(d =>
      d.id === DEFAULT_DASHBOARD_ID
        ? { ...d, cameraIds: [...d.cameraIds, withSettings.id] }
        : d,
    );
    setCameras(next);
    camerasRef.current = next;
    setFocusedId(nextFocus);
    focusedRef.current = nextFocus;
    setDashboards(nextDashboards);
    dashboardsRef.current = nextDashboards;
    persistAll(next, nextDashboards, activeDashboardId, nextFocus);

    // Seed this camera's settings/profiles from its live `/status` so a freshly
    // added camera mirrors its actual hardware state. Falls back to the defaults
    // already set above when the camera is unreachable.
    seedFromStatus(withSettings);
  }

  /**
   * Profile-aware settings update. Edits target the selected Day/Night profile;
   * the effective `settings` and the hardware are only touched when that profile
   * is the one currently active.
   */
  function handleUpdateCameraSettings(id: string, change: CameraSettingsChange) {
    const cam = cameras.find(c => c.id === id);
    if (!cam) return;
    const activeSlot = activeProfileSlot(cam, new Date(), getNightWindow());

    if (change.kind === 'copy') {
      const copied: CameraSettings = { ...(change.from === 'day' ? cam.day : cam.night) };
      let nextCam: Camera = change.to === 'day'
        ? { ...cam, day: copied }
        : { ...cam, night: copied };
      if (change.to === activeSlot) nextCam = { ...nextCam, settings: { ...copied } };
      const next = cameras.map(c => (c.id === id ? nextCam : c));
      setCameras(next);
      persistAll(next, dashboards, activeDashboardId, focusedId);
      if (change.to === activeSlot) void syncCamera(nextCam);
      return;
    }

    const nextProfile: CameraSettings = {
      ...(change.slot === 'day' ? cam.day : cam.night),
      ...change.patch,
    };
    let nextCam: Camera = change.slot === 'day'
      ? { ...cam, day: nextProfile }
      : { ...cam, night: nextProfile };

    if (change.slot !== activeSlot) {
      // Editing the inactive profile: persist only, no hardware write.
      const next = cameras.map(c => (c.id === id ? nextCam : c));
      setCameras(next);
      persistAll(next, dashboards, activeDashboardId, focusedId);
      return;
    }

    // Active profile: update effective settings and write changed vars through.
    nextCam = { ...nextCam, settings: { ...nextProfile } };
    const next = cameras.map(c => (c.id === id ? nextCam : c));
    setCameras(next);
    persistAll(next, dashboards, activeDashboardId, focusedId);

    // `ledOn`/`ledIntensity` share `led_intensity`; `exposureLock` drives aec+agc.
    const vars = new Set<ManagedVar>();
    (Object.keys(change.patch) as (keyof CameraSettings)[]).forEach(k =>
      managedVarsForSetting(k).forEach(v => vars.add(v)),
    );
    vars.forEach(v => {
      const val = hardwareValueForVar(nextProfile, v);
      pushSetting(cam.ip, v, val).catch(() => {});
    });
  }

  /** Change Auto/Day/Night mode, then apply the newly-active profile. */
  function handleSetDayNightMode(id: string, mode: DayNightMode) {
    const cam = cameras.find(c => c.id === id);
    if (!cam) return;
    const nextCam: Camera = {
      ...cam,
      dayNight: mode,
      settings: { ...resolveProfile({ ...cam, dayNight: mode }, new Date(), getNightWindow()) },
    };
    const next = cameras.map(c => (c.id === id ? nextCam : c));
    setCameras(next);
    persistAll(next, dashboards, activeDashboardId, focusedId);
    // Record the manually-applied slot so the auto timer doesn't override it.
    noteApplied(nextCam);
    void syncCamera(nextCam);
  }

  function handleRemoveCamera(id: string) {
    const next = cameras.filter(c => c.id !== id);
    const nextFocus = next.length === 1
      ? next[0].id
      : (next.some(c => c.id === focusedId) ? focusedId : undefined);
    // Rule 1: drop the removed camera everywhere (default auto-mirrors the list).
    const nextDashboards = dashboards.map(d => ({
      ...d,
      cameraIds: d.cameraIds.filter(cid => cid !== id),
    }));
    setCameras(next);
    setFocusedId(nextFocus);
    setDashboards(nextDashboards);
    persistAll(next, nextDashboards, activeDashboardId, nextFocus);
  }

  function handleAddDashboard(name: string, cameraIds: string[]) {
    const trimmed = name.trim();
    const dashboard: Dashboard = {
      id: makeDashboardId(),
      name: trimmed || 'Dashboard',
      cameraIds: [...cameraIds],
    };
    const nextDashboards = [...dashboards, dashboard];
    setDashboards(nextDashboards);
    setActiveDashboardIdState(dashboard.id);
    persistAll(cameras, nextDashboards, dashboard.id, focusedId);
  }

  function handleRemoveDashboard(id: string) {
    if (id === DEFAULT_DASHBOARD_ID) return;
    const nextDashboards = dashboards.filter(d => d.id !== id);
    const nextActive = activeDashboardId === id ? DEFAULT_DASHBOARD_ID : activeDashboardId;
    setDashboards(nextDashboards);
    setActiveDashboardIdState(nextActive);
    persistAll(cameras, nextDashboards, nextActive, focusedId);
  }

  function handleSelectDashboard(id: string) {
    if (!dashboards.some(d => d.id === id)) return;
    setActiveDashboardIdState(id);
    persistAll(cameras, dashboards, id, focusedId);
  }

  if (loading) return null;

  if (screen === 'setup' || cameras.length === 0) {
    return (
      <SafeAreaProvider>
        <SetupScreen
          cameras={cameras}
          focusedId={focusedId}
          detection={detection}
          onAddCamera={handleAddCamera}
          onRemoveCamera={handleRemoveCamera}
          onUpdateSettings={handleUpdateCameraSettings}
          onUpdateDetection={handleUpdateDetection}
          onSetDayNight={handleSetDayNightMode}
          location={location}
          onSetLocation={handleSetLocation}
          onDone={() => setScreen('monitor')}
        />
      </SafeAreaProvider>
    );
  }

  if (screen === 'gallery') {
    return (
      <SafeAreaProvider>
        <GalleryScreen
          initialEventId={galleryEventId}
          onClose={() => setScreen('monitor')}
        />
      </SafeAreaProvider>
    );
  }

  return (
    <SafeAreaProvider>
      <MonitorScreen
        cameras={cameras}
        dashboards={dashboards}
        activeDashboardId={activeDashboardId}
        focusedId={focusedId}
        onSelectCamera={id => setFocusedId(id ?? undefined)}
        onSelectDashboard={handleSelectDashboard}
        onCreateDashboard={handleAddDashboard}
        onDeleteDashboard={handleRemoveDashboard}
        onOpenSettings={() => setScreen('setup')}
        onOpenGallery={() => setScreen('gallery')}
        onUpdateSettings={handleUpdateCameraSettings}
        onSetDayNight={handleSetDayNightMode}
        onResolveCameras={handleResolveCameras}
        location={location}
        onSetLocation={handleSetLocation}
      />
    </SafeAreaProvider>
  );
}
