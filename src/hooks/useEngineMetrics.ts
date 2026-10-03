import { useEffect, useRef, useState } from 'react';
import { NativeModules } from 'react-native';

const { DoorCamModule } = NativeModules;

/** Per-camera metrics derived from two consecutive native polls. */
export interface CameraEngineStat {
  /** Source (ingested) frames per second: ΔframesIn / Δt. */
  srcFps: number;
  /** Surface draws per second: Δdrawn / Δt. */
  drawnFps: number;
  /** Inferences per second: ΔinferencesRun / Δt. */
  infPerSec: number;
  /** Engine's EWMA inference latency in ms (point-in-time, not a delta). */
  inferenceMsEwma: number;
  /** Cumulative confirmed detections (point-in-time, not a delta). */
  detectionsConfirmed: number;
  /** EWMA decode-stage duration in ms (point-in-time). */
  decodeMs: number;
  /** EWMA motion-gate duration in ms (point-in-time). */
  motionMs: number;
  /** EWMA post-process + temporal duration in ms (point-in-time). */
  postMs: number;
  /** EWMA end-to-end latency, frame ingest → PersonDetected emit, in ms. */
  detectionLatencyMs: number;
  /** Current per-camera queue depth sampled at inference time. */
  queueDepth: number;
  /** Cumulative frames evicted from the camera's latest-wins queue. */
  framesDropped: number;
}

export interface EngineMetrics {
  cameraStats: Map<string, CameraEngineStat>;
  detector: string;
  /** JS-clock time of the latest successful poll. */
  updatedAt: number;
}

interface NativeCameraMetrics {
  framesIn?: number;
  motionSkips?: number;
  inferencesRun?: number;
  inferenceMsEwma?: number;
  detectionsConfirmed?: number;
  decodeMs?: number;
  motionMs?: number;
  postMs?: number;
  detectionLatencyMs?: number;
  queueDepth?: number;
  framesDropped?: number;
  /** Successful surface draws, merged in by DoorCamModule.getMetrics. */
  drawn?: number;
}

interface NativeMetrics {
  detector?: string;
  cameras?: Record<string, NativeCameraMetrics>;
}

interface PreviousPoll {
  at: number;
  cameras: Record<string, NativeCameraMetrics>;
}

const EMPTY: EngineMetrics = { cameraStats: new Map(), detector: '', updatedAt: 0 };

function num(v: unknown): number {
  return typeof v === 'number' && isFinite(v) ? v : 0;
}

/**
 * Polls the native engine metrics once per second while `enabled`, and turns the
 * cumulative counters into per-camera rates (fps) via deltas against the prior
 * poll. Errors are swallowed so a metrics failure can never disturb the UI.
 *
 * Pass `enabled=false` when the debug HUD is hidden: the interval is torn down
 * and the previous baseline is dropped, so re-enabling starts fresh instead of
 * reporting a spike across the gap.
 */
export function useEngineMetrics(enabled: boolean): EngineMetrics {
  const [metrics, setMetrics] = useState<EngineMetrics>(EMPTY);
  const prevRef = useRef<PreviousPoll | null>(null);

  useEffect(() => {
    if (!enabled) return;

    let cancelled = false;
    prevRef.current = null;

    const poll = async () => {
      let raw: NativeMetrics | undefined;
      try {
        raw = await DoorCamModule?.getMetrics?.();
      } catch {
        return; // swallow: metrics are best-effort
      }
      if (cancelled || !raw || typeof raw !== 'object') return;

      const now = Date.now();
      const prev = prevRef.current;
      const cameras = raw.cameras ?? {};
      const cameraStats = new Map<string, CameraEngineStat>();

      for (const id of Object.keys(cameras)) {
        const c = cameras[id] ?? {};
        let srcFps = 0;
        let drawnFps = 0;
        let infPerSec = 0;

        const p = prev?.cameras[id];
        if (p) {
          const dt = (now - prev!.at) / 1000;
          if (dt > 0) {
            srcFps = Math.max(0, (num(c.framesIn) - num(p.framesIn)) / dt);
            drawnFps = Math.max(0, (num(c.drawn) - num(p.drawn)) / dt);
            infPerSec = Math.max(0, (num(c.inferencesRun) - num(p.inferencesRun)) / dt);
          }
        }

        cameraStats.set(id, {
          srcFps,
          drawnFps,
          infPerSec,
          inferenceMsEwma: num(c.inferenceMsEwma),
          detectionsConfirmed: num(c.detectionsConfirmed),
          decodeMs: num(c.decodeMs),
          motionMs: num(c.motionMs),
          postMs: num(c.postMs),
          detectionLatencyMs: num(c.detectionLatencyMs),
          queueDepth: num(c.queueDepth),
          framesDropped: num(c.framesDropped),
        });
      }

      prevRef.current = { at: now, cameras };
      setMetrics({
        cameraStats,
        detector: typeof raw.detector === 'string' ? raw.detector : '',
        updatedAt: now,
      });
    };

    poll();
    const timer = setInterval(poll, 1000);
    return () => {
      cancelled = true;
      clearInterval(timer);
      prevRef.current = null;
    };
  }, [enabled]);

  return metrics;
}
