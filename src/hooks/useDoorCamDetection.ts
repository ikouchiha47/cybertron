import { useCallback, useEffect, useReducer, useState } from 'react';
import { DeviceEventEmitter, NativeModules } from 'react-native';
import * as Notifications from 'expo-notifications';
import { Camera } from '../utils/storage';
import { insertEvent } from '../utils/db';
import { NOTIFY_MIN_SCORE } from '../utils/constants';

const { DoorCamModule } = NativeModules;

export type Nearness = 'none' | 'far' | 'close' | 'very_close';

export interface DetectionBox {
  score: number;
  x1: number;
  y1: number;
  x2: number;
  y2: number;
}

export interface DetectionState {
  boxes: DetectionBox[];
  nearness: Nearness;
  frameWidth: number;
  frameHeight: number;
  ts: number;
}

interface PersonDetectedEvent {
  streamId?: string;
  seq?: number;
  boxes?: number[][];
  scores?: number[];
  nearness?: string;
  frameWidth?: number;
  frameHeight?: number;
  ts?: number;
}

interface EventSavedEvent {
  eventId?: string;
  cameraId?: string;
  thumbnailPath?: string;
  frameCount?: number;
  timestamp?: number;
  videoPath?: string;
}

/** Native `CameraStatus` payload, emitted on each online<->offline transition. */
interface CameraStatusEvent {
  streamId?: string;
  online?: boolean;
  reconnects?: number;
  lastFrameAgoMs?: number;
}

export interface CameraStatusState {
  online: boolean;
  reconnects: number;
  /** ms since the last decoded frame; -1 if none has ever arrived. */
  lastFrameAgoMs: number;
  /** JS-clock time the status was last updated — used to derive retrying vs offline. */
  updatedAt: number;
}

// ---------------------------------------------------------------------------
// Single module-scope store + native listener (one listener for the process).
// ---------------------------------------------------------------------------

const states = new Map<string, DetectionState>();
const statusMap = new Map<string, CameraStatusState>();
const subscribers = new Set<() => void>();
const activeEvents = new Map<string, string>();
const nearnessByCamera: Record<string, Nearness> = {};
let camerasById: Record<string, string> = {};
let installed = false;

// Box freshness: native only emits on positive frames, so a box can freeze on
// the advancing live video. Stamp each camera when a PersonDetected arrives and
// drop boxes that go stale, so a lost track can never linger on screen.
const BOX_TTL_MS = 1200;
const BOX_TTL_CHECK_MS = 250;
const detectionReceivedAt = new Map<string, number>();
let ttlTimer: ReturnType<typeof setInterval> | null = null;

// A detection can arrive in the same tick as a status transition (and multiple
// cameras can update together). Re-rendering MonitorScreen + every tile once per
// event was the bulk of the churn, so coalesce native notifications into at most
// one render per window, flushing the newest state on the trailing edge.
const NOTIFY_COALESCE_MS = 200;
let notifyTimer: ReturnType<typeof setTimeout> | null = null;
let lastNotifyAt = 0;

function emitSubscribers() {
  for (const sub of subscribers) {
    try { sub(); } catch { /* ignore */ }
  }
}

function notifySubscribers() {
  const now = Date.now();
  const elapsed = now - lastNotifyAt;
  if (elapsed >= NOTIFY_COALESCE_MS) {
    lastNotifyAt = now;
    if (notifyTimer != null) {
      clearTimeout(notifyTimer);
      notifyTimer = null;
    }
    emitSubscribers();
  } else if (notifyTimer == null) {
    notifyTimer = setTimeout(() => {
      notifyTimer = null;
      lastNotifyAt = Date.now();
      emitSubscribers();
    }, NOTIFY_COALESCE_MS - elapsed);
  }
}

function sameBoxes(a?: DetectionBox[], b?: DetectionBox[]): boolean {
  if (a === b) return true;
  if (!a || !b || a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    const x = a[i];
    const y = b[i];
    if (x.score !== y.score || x.x1 !== y.x1 || x.y1 !== y.y1 || x.x2 !== y.x2 || x.y2 !== y.y2) {
      return false;
    }
  }
  return true;
}

/** Ignores `ts`: an identical box set should not force a re-render. */
function sameDetection(a?: DetectionState, b?: DetectionState): boolean {
  if (a === b) return true;
  if (!a || !b) return false;
  return (
    a.nearness === b.nearness &&
    a.frameWidth === b.frameWidth &&
    a.frameHeight === b.frameHeight &&
    sameBoxes(a.boxes, b.boxes)
  );
}

function generateEventId(): string {
  return `evt_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
}

function normalizeNearness(value: unknown): Nearness {
  return value === 'far' || value === 'close' || value === 'very_close' ? value : 'none';
}

function parseBoxes(event: PersonDetectedEvent): DetectionBox[] {
  const rawBoxes = Array.isArray(event.boxes) ? event.boxes : [];
  const rawScores = Array.isArray(event.scores) ? event.scores : [];
  const boxes: DetectionBox[] = [];
  for (let i = 0; i < rawBoxes.length; i++) {
    const b = rawBoxes[i];
    if (!Array.isArray(b) || b.length < 4) continue;
    boxes.push({
      score: typeof rawScores[i] === 'number' ? rawScores[i] : 0,
      x1: b[0], y1: b[1], x2: b[2], y2: b[3],
    });
  }
  return boxes;
}

/** Drops this camera's boxes/nearness without touching capture/notification state. */
function clearStaleDetection(cameraId: string, now: number): boolean {
  const prev = states.get(cameraId);
  if (!prev) return false;
  if (prev.nearness === 'none' && prev.boxes.length === 0) return false;
  states.set(cameraId, {
    boxes: [],
    nearness: 'none',
    frameWidth: prev.frameWidth,
    frameHeight: prev.frameHeight,
    ts: now,
  });
  return true;
}

/**
 * 250ms sweeper: while any camera has a live box, evict boxes whose last
 * PersonDetected is older than BOX_TTL_MS. Stops itself once nothing is live,
 * so idle/idle dashboards run no timer. A fresh detection simply re-stamps the
 * camera and (re)starts the sweeper, so recovery is immediate.
 */
function ensureTtlSweeper() {
  if (ttlTimer != null) return;
  ttlTimer = setInterval(() => {
    const now = Date.now();
    let changed = false;
    let anyLive = false;
    for (const cameraId of Array.from(states.keys())) {
      const prev = states.get(cameraId);
      if (!prev) continue;
      if (prev.nearness === 'none' && prev.boxes.length === 0) {
        detectionReceivedAt.delete(cameraId);
        continue;
      }
      const receivedAt = detectionReceivedAt.get(cameraId) ?? 0;
      if (now - receivedAt > BOX_TTL_MS) {
        if (clearStaleDetection(cameraId, now)) changed = true;
        detectionReceivedAt.delete(cameraId);
      } else {
        anyLive = true;
      }
    }
    if (changed) notifySubscribers();
    if (!anyLive && ttlTimer != null) {
      clearInterval(ttlTimer);
      ttlTimer = null;
    }
  }, BOX_TTL_CHECK_MS);
}

function onPersonDetected(event: PersonDetectedEvent) {
  const cameraId = event?.streamId;
  if (!cameraId) return;

  const nearness = normalizeNearness(event.nearness);
  const prevState = states.get(cameraId);
  const nextState: DetectionState = {
    boxes: nearness === 'none' ? [] : parseBoxes(event),
    nearness,
    frameWidth: event.frameWidth ?? 0,
    frameHeight: event.frameHeight ?? 0,
    ts: event.ts ?? Date.now(),
  };
  states.set(cameraId, nextState);
  // A frame just arrived for this camera: reset the freshness clock. When the
  // track ends (nearness none) there is nothing to age out, so clear the stamp.
  if (nearness !== 'none') {
    detectionReceivedAt.set(cameraId, Date.now());
    ensureTtlSweeper();
  } else {
    detectionReceivedAt.delete(cameraId);
  }
  const stateChanged = !sameDetection(prevState, nextState);

  // Only a high-confidence detection may drive capture / notification / event
  // creation. Lower-scoring "candidate" frames still updated the overlay state
  // above (boxes, nearness, frame dims) so yellow boxes keep rendering, but
  // they are otherwise side-effect free.
  const rawScores = Array.isArray(event.scores) ? event.scores : [];
  const maxScore = rawScores.length > 0 ? Math.max(0, ...rawScores) : 0;
  const confident = maxScore >= NOTIFY_MIN_SCORE;

  if (nearness !== 'none' && confident) {
    if (!activeEvents.has(cameraId)) {
      // Rising edge of a confirmed detection: start a capture + persist an event.
      const eventId = generateEventId();
      activeEvents.set(cameraId, eventId);
      nearnessByCamera[cameraId] = nearness;
      try { DoorCamModule?.saveEvent?.(cameraId, eventId); } catch { /* viewless camera: no capture */ }
      insertEvent({
        id: eventId,
        timestamp: Date.now(),
        nearness,
        frame_count: 0,
        thumbnail_path: '',
        video_path: '',
        camera_id: cameraId,
      }).catch(e => console.warn('[DoorCam] db insert failed:', e));
      considerNotification(cameraId, eventId);
    } else {
      // Keep the strongest nearness seen for the eventual DB record.
      const prev = nearnessByCamera[cameraId];
      const rank: Record<Nearness, number> = { none: 0, far: 1, close: 2, very_close: 3 };
      if (rank[nearness] > rank[prev ?? 'none']) nearnessByCamera[cameraId] = nearness;
    }
  } else if (nearness === 'none') {
    activeEvents.delete(cameraId);
  }

  // High-confidence side effects ran above independent of the render; only the
  // subscriber notify is skipped when the visible detection state is unchanged.
  if (stateChanged) notifySubscribers();
}

function onEventSaved(event: EventSavedEvent) {
  if (!event?.eventId) return;
  const cameraId = event.cameraId ?? 'default';
  insertEvent({
    id: event.eventId,
    timestamp: event.timestamp ?? Date.now(),
    nearness: nearnessByCamera[cameraId] ?? 'none',
    frame_count: event.frameCount ?? 0,
    thumbnail_path: event.thumbnailPath ?? '',
    video_path: event.videoPath ?? '',
    camera_id: cameraId,
  }).catch(e => console.warn('[DoorCam] db insert failed:', e));
}

function onCameraStatus(event: CameraStatusEvent) {
  const cameraId = event?.streamId;
  if (!cameraId) return;
  const prev = statusMap.get(cameraId);
  const next: CameraStatusState = {
    online: event.online === true,
    reconnects: typeof event.reconnects === 'number' ? event.reconnects : 0,
    lastFrameAgoMs: typeof event.lastFrameAgoMs === 'number' ? event.lastFrameAgoMs : -1,
    updatedAt: Date.now(),
  };
  statusMap.set(cameraId, next);
  const changed = !prev ||
    prev.online !== next.online ||
    prev.reconnects !== next.reconnects ||
    prev.lastFrameAgoMs !== next.lastFrameAgoMs;
  if (changed) notifySubscribers();
}

function ensureInfra() {
  if (installed) return;
  installed = true;

  // Idempotent: the channel already exists via registerBackgroundDetection.
  Notifications.requestPermissionsAsync().catch(() => {});
  Notifications.setNotificationHandler({
    handleNotification: async () => ({
      shouldShowBanner: true,
      shouldPlaySound: true,
      shouldSetBadge: false,
      shouldShowList: true,
    }),
  });
  Notifications.setNotificationChannelAsync('doorcam-v2', {
    name: 'DoorCam Alerts',
    importance: Notifications.AndroidImportance.HIGH,
    sound: 'default',
    vibrationPattern: [0, 250, 250, 250],
    enableVibrate: true,
    audioAttributes: {
      usage: Notifications.AndroidAudioUsage.NOTIFICATION,
      contentType: Notifications.AndroidAudioContentType.SONIFICATION,
      flags: { enforceAudibility: false, requestHardwareAudioVideoSynchronization: false },
    },
  }).catch(() => {});
  Notifications.deleteNotificationChannelAsync('doorcam').catch(() => {});

  DeviceEventEmitter.addListener('PersonDetected', onPersonDetected);
  DeviceEventEmitter.addListener('DoorCamEventSaved', onEventSaved);
  DeviceEventEmitter.addListener('CameraStatus', onCameraStatus);
}

// ---------------------------------------------------------------------------
// Global notification arbiter (JS): one grouped notification per burst.
//   10s global cooldown · 30s per-camera cooldown · 3s merge window · 6/min cap
// ---------------------------------------------------------------------------

const GLOBAL_COOLDOWN_MS = 10_000;
const PER_CAMERA_COOLDOWN_MS = 30_000;
const MERGE_WINDOW_MS = 3_000;
const MAX_PER_MINUTE = 6;

interface PendingHit { cameraId: string; eventId: string }

let pendingHits: PendingHit[] = [];
let mergeTimer: ReturnType<typeof setTimeout> | null = null;
let lastGlobalNotifyAt = 0;
let minuteStamps: number[] = [];
const perCameraNotifyAt = new Map<string, number>();

function nameFor(cameraId: string): string {
  return camerasById[cameraId] || cameraId;
}

function considerNotification(cameraId: string, eventId: string) {
  const now = Date.now();
  if (now - (perCameraNotifyAt.get(cameraId) ?? 0) < PER_CAMERA_COOLDOWN_MS) return;

  minuteStamps = minuteStamps.filter(t => now - t < 60_000);
  if (minuteStamps.length >= MAX_PER_MINUTE) return;
  if (now - lastGlobalNotifyAt < GLOBAL_COOLDOWN_MS) return;

  if (!pendingHits.some(h => h.cameraId === cameraId)) {
    pendingHits.push({ cameraId, eventId });
  }
  if (mergeTimer == null) {
    // Fixed merge window measured from the first hit of the burst.
    mergeTimer = setTimeout(() => { flushNotification().catch(() => {}); }, MERGE_WINDOW_MS);
  }
}

async function flushNotification() {
  mergeTimer = null;
  const hits = pendingHits;
  pendingHits = [];
  if (hits.length === 0) return;

  const now = Date.now();
  minuteStamps = minuteStamps.filter(t => now - t < 60_000);
  if (minuteStamps.length >= MAX_PER_MINUTE) return;

  lastGlobalNotifyAt = now;
  minuteStamps.push(now);
  for (const h of hits) perCameraNotifyAt.set(h.cameraId, now);

  const primary = hits[0];
  const names = hits.map(h => nameFor(h.cameraId));
  const others = hits.length - 1;
  const body = others > 0
    ? `Person seen: ${names[0]} +${others} other${others > 1 ? 's' : ''}`
    : `Person seen: ${names[0]}`;

  try {
    await Notifications.scheduleNotificationAsync({
      content: {
        title: 'DoorCam',
        body,
        sound: 'default',
        data: { cameraId: primary.cameraId, eventId: primary.eventId },
      },
      trigger: { seconds: 1, channelId: 'doorcam-v2' },
    });
  } catch (e) {
    console.warn('[DoorCam] notification failed:', e);
  }
}

// ---------------------------------------------------------------------------
// Hook
// ---------------------------------------------------------------------------

export interface UseDoorCamDetectionParams {
  cameras: Camera[];
  /** Camera ids in the active dashboard — the engine detects these. */
  activeCameraIds: string[];
}

export function useDoorCamDetection({ cameras, activeCameraIds }: UseDoorCamDetectionParams) {
  const [, force] = useReducer((n: number) => n + 1, 0);
  const [retryNonces, setRetryNonces] = useState<Record<string, number>>({});

  useEffect(() => {
    ensureInfra();
    const sub = () => force();
    subscribers.add(sub);
    return () => { subscribers.delete(sub); };
  }, []);

  // Retry = bump a per-camera nonce. Callers key the native view on
  // `${cameraId}:${nonce}` so a bump fully remounts it (fresh socket, no wedged state).
  const retryCamera = useCallback((cameraId: string) => {
    setRetryNonces(prev => ({ ...prev, [cameraId]: (prev[cameraId] ?? 0) + 1 }));
  }, []);

  const camerasKey = cameras.map(c => `${c.id}:${c.ip}`).join('|');
  useEffect(() => {
    DoorCamModule?.setCameras?.(
      cameras.map(c => ({ id: c.id, ip: c.ip, name: c.name })),
    );
  }, [camerasKey]);

  const namesKey = cameras.map(c => `${c.id}:${c.name}`).join('|');
  useEffect(() => {
    const map: Record<string, string> = {};
    for (const c of cameras) map[c.id] = c.name;
    camerasById = map;
  }, [namesKey]);

  const activeKey = activeCameraIds.join('|');
  useEffect(() => {
    DoorCamModule?.setActiveCameras?.(activeCameraIds);
  }, [activeKey]);

  const snapshot = new Map(states);
  const statusSnapshot = new Map(statusMap);
  const inferring = activeCameraIds.some(
    id => (states.get(id)?.nearness ?? 'none') !== 'none',
  );
  return {
    states: snapshot,
    inferring,
    statusMap: statusSnapshot,
    retryNonces,
    retryCamera,
  };
}

// ---------------------------------------------------------------------------
// Shared render clock
// ---------------------------------------------------------------------------
// Tiles derive their retry/offline state from `Date.now()` and previously each
// ran its own 1s setInterval while offline. Centralise that on one module-level
// interval: a tile subscribes only while it needs to age (offline), so live
// tiles run no timer and never re-render on the tick.
const clockSubscribers = new Set<() => void>();
let clockTimer: ReturnType<typeof setInterval> | null = null;
let clockNow = Date.now();

function ensureClock() {
  if (clockTimer != null) return;
  clockNow = Date.now();
  clockTimer = setInterval(() => {
    clockNow = Date.now();
    for (const sub of clockSubscribers) {
      try { sub(); } catch { /* ignore */ }
    }
  }, 1000);
}

/** Current shared 1s clock. Pass `enabled=false` (e.g. a live tile) to opt out. */
export function useDoorCamClock(enabled: boolean): number {
  const [, force] = useReducer((n: number) => n + 1, 0);
  useEffect(() => {
    if (!enabled) return;
    ensureClock();
    clockSubscribers.add(force);
    return () => {
      clockSubscribers.delete(force);
      if (clockSubscribers.size === 0 && clockTimer != null) {
        clearInterval(clockTimer);
        clockTimer = null;
      }
    };
  }, [enabled]);
  return clockNow;
}
