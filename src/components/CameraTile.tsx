import React from 'react';
import {
  ActivityIndicator, GestureResponderEvent, LayoutChangeEvent, StyleSheet, Text,
  TouchableOpacity, View, ViewStyle,
} from 'react-native';
import { Camera } from '../utils/storage';
import { PERSON_DETECTION_THRESHOLD } from '../utils/constants';
import { CameraStatusState, useDoorCamClock } from '../hooks/useDoorCamDetection';
import MjpegStream from './MjpegStream';

export interface BBox {
  score: number;
  x1: number;
  y1: number;
  x2: number;
  y2: number;
}

// Stable empty array so the bounding-box overlay's memo comparison is not
// broken by a fresh `[]` on every render.
const EMPTY_BOXES: BBox[] = [];

interface Props {
  camera: Camera;
  /** Normalized boxes from the shared detection hook (optional). */
  boxes?: BBox[];
  /** Frame dimensions the boxes are normalized against. */
  frameSize?: { w: number; h: number };
  /** Live connection status for this camera, from the native CameraStatus event. */
  status?: CameraStatusState;
  /** Bumped by retryCamera; keying the native view on it forces a fresh remount. */
  retryNonce?: number;
  /** Requests a stream retry (does NOT focus the tile). */
  onRetry?: () => void;
  onPress: () => void;
  /** Optional debug source fps; when provided a small badge shows top-right. */
  debugFps?: number;
}

// How long after an offline event (or a manual retry) the tile still reads as
// "retrying…" before settling into the explicit offline + Retry state.
const RETRY_WINDOW_MS = 20_000;

interface BoundaryState {
  failed: boolean;
}

/**
 * Small error boundary so a broken native stream can never take down the grid.
 * Falls back to the offline placeholder instead of crashing the tree.
 */
class TileErrorBoundary extends React.Component<
  { fallback: React.ReactNode; children: React.ReactNode },
  BoundaryState
> {
  state: BoundaryState = { failed: false };

  static getDerivedStateFromError(): BoundaryState {
    return { failed: true };
  }

  componentDidCatch(error: unknown) {
    console.warn('[DoorCam] camera tile failed to render:', error);
  }

  render() {
    return this.state.failed ? this.props.fallback : this.props.children;
  }
}

/**
 * Draws normalized bounding boxes on top of a native TextureView.
 * Replicates the fit-center layout from MjpegStreamView.drawBitmapToSurface:
 *   scale = min(viewW/bitmapW, viewH/bitmapH)
 *   dx = (viewW - bitmapW*scale) / 2
 *   dy = (viewH - bitmapH*scale) / 2
 *
 * Exported so the fullscreen view in MonitorScreen reuses the exact same math.
 */
export const BoundingBoxOverlay = React.memo(function BoundingBoxOverlay({ candidates, containerW, containerH, frameW, frameH }: {
  candidates: BBox[];
  containerW: number;
  containerH: number;
  frameW: number;
  frameH: number;
}) {
  if (containerW === 0 || containerH === 0 || frameW === 0 || frameH === 0) return null;

  const scale = Math.min(containerW / frameW, containerH / frameH);
  const dx = (containerW - frameW * scale) / 2;
  const dy = (containerH - frameH * scale) / 2;
  const fitW = frameW * scale;
  const fitH = frameH * scale;

  return (
    <View style={StyleSheet.absoluteFill} pointerEvents="none">
      {candidates.map((c, i) => {
        const color = c.score >= PERSON_DETECTION_THRESHOLD ? '#4a9' : '#fa0';
        const left   = dx + c.x1 * fitW;
        const top    = dy + c.y1 * fitH;
        const width  = (c.x2 - c.x1) * fitW;
        const height = (c.y2 - c.y1) * fitH;
        const boxStyle: ViewStyle = {
          position: 'absolute',
          left, top, width, height,
          borderWidth: 2,
          borderColor: color,
          borderRadius: 3,
        };
        return (
          <View key={i} style={boxStyle}>
            <View style={[styles.bboxLabel, { backgroundColor: color }]}>
              <Text style={styles.bboxLabelText}>{(c.score * 100).toFixed(0)}%</Text>
            </View>
          </View>
        );
      })}
    </View>
  );
});

function sameBoxList(a?: BBox[], b?: BBox[]): boolean {
  if (a === b) return true;
  if (!a || !b || a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    const x = a[i];
    const y = b[i];
    if (x.score !== y.score || x.x1 !== y.x1 || x.y1 !== y.y1 || x.x2 !== y.x2 || y.y2 !== x.y2) {
      return false;
    }
  }
  return true;
}

function sameFrameSize(a?: { w: number; h: number }, b?: { w: number; h: number }): boolean {
  if (a === b) return true;
  if (!a || !b) return false;
  return a.w === b.w && a.h === b.h;
}

function sameStatus(a?: CameraStatusState, b?: CameraStatusState): boolean {
  if (a === b) return true;
  if (!a || !b) return false;
  return (
    a.online === b.online &&
    a.reconnects === b.reconnects &&
    a.lastFrameAgoMs === b.lastFrameAgoMs &&
    a.updatedAt === b.updatedAt
  );
}

/**
 * Skip re-render when nothing visible changed. MonitorScreen builds fresh
 * `frameSize` objects and `onPress`/`onRetry` closures on every render, so a
 * plain shallow compare would always fail; compare the data instead and ignore
 * callback identity (the captured camera id is stable).
 */
function areTilePropsEqual(prev: Props, next: Props): boolean {
  return (
    prev.camera.id === next.camera.id &&
    prev.camera.name === next.camera.name &&
    prev.camera.ip === next.camera.ip &&
    prev.retryNonce === next.retryNonce &&
    sameBoxList(prev.boxes, next.boxes) &&
    sameFrameSize(prev.frameSize, next.frameSize) &&
    sameStatus(prev.status, next.status) &&
    prev.debugFps === next.debugFps
  );
}

function CameraTileComponent({
  camera, boxes, frameSize, status, retryNonce = 0, onRetry, onPress, debugFps,
}: Props) {
  const [layout, setLayout] = React.useState({ w: 0, h: 0 });
  const onLayout = React.useCallback((e: LayoutChangeEvent) => {
    const { width, height } = e.nativeEvent.layout;
    setLayout({ w: width, h: height });
  }, []);

  const isLive = status?.online === true;

  // Shared clock so `retrying…` can age into `offline` without new native events.
  // Opt out while live: no timer, and no per-second re-render from the tick.
  const now = useDoorCamClock(!isLive);

  // A fresh nonce means a retry was just requested.
  const [retryAt, setRetryAt] = React.useState(0);
  React.useEffect(() => {
    if (retryNonce > 0) setRetryAt(Date.now());
  }, [retryNonce]);

  const hasStatus = status != null;
  const reconnects = status?.reconnects ?? 0;
  const sinceUpdate = now - (status?.updatedAt ?? 0);
  const sinceRetry = retryAt > 0 ? now - retryAt : Number.POSITIVE_INFINITY;

  const isConnecting = !isLive && (!hasStatus || reconnects === 0);
  const isRetrying =
    !isLive && !isConnecting &&
    (sinceRetry < RETRY_WINDOW_MS || sinceUpdate < RETRY_WINDOW_MS);
  const isOffline = !isLive && !isConnecting && !isRetrying;

  const handleRetry = React.useCallback((e: GestureResponderEvent) => {
    // Keep the tap off the tile's onPress (focus) handler.
    e.stopPropagation?.();
    onRetry?.();
  }, [onRetry]);

  const offlineFallback = (
    <View style={styles.offline}>
      <Text style={styles.offlineName} numberOfLines={1}>{camera.name}</Text>
      <Text style={styles.offlineText}>offline</Text>
    </View>
  );

  return (
    <TouchableOpacity style={styles.tile} activeOpacity={0.85} onPress={onPress}>
      <TileErrorBoundary fallback={offlineFallback}>
        <View style={styles.fill} onLayout={onLayout}>
          {offlineFallback}
          <MjpegStream
            key={`${camera.id}:${retryNonce}`}
            url={`http://${camera.ip}:81/stream`}
            streamId={camera.id}
            detectionEnabled={false}
            style={styles.stream}
          />
          <BoundingBoxOverlay
            candidates={boxes ?? EMPTY_BOXES}
            containerW={layout.w}
            containerH={layout.h}
            frameW={frameSize?.w ?? 0}
            frameH={frameSize?.h ?? 0}
          />

          {debugFps != null && (
            <View style={styles.fpsBadge} pointerEvents="none">
              <Text style={styles.fpsBadgeText}>{debugFps.toFixed(0)} fps</Text>
            </View>
          )}

          {!isLive && (
            <View
              style={styles.statusOverlay}
              pointerEvents={isOffline ? 'box-none' : 'none'}
            >
              {isOffline ? (
                <View style={styles.statusCenter}>
                  <Text style={styles.statusName} numberOfLines={1}>{camera.name}</Text>
                  <Text style={styles.statusText}>offline</Text>
                  <TouchableOpacity
                    style={styles.retryBtn}
                    activeOpacity={0.7}
                    onPress={handleRetry}
                  >
                    <Text style={styles.retryText}>Retry</Text>
                  </TouchableOpacity>
                </View>
              ) : (
                <View style={styles.statusCenter}>
                  <ActivityIndicator color="#888" />
                  {isRetrying && <Text style={styles.statusText}>retrying…</Text>}
                </View>
              )}
            </View>
          )}
        </View>
      </TileErrorBoundary>
      <View style={styles.labelWrap} pointerEvents="none">
        <Text style={styles.label} numberOfLines={1}>{camera.name}</Text>
      </View>
    </TouchableOpacity>
  );
}

export default React.memo(CameraTileComponent, areTilePropsEqual);

const styles = StyleSheet.create({
  tile:          { flex: 1, backgroundColor: '#000', borderRadius: 8, overflow: 'hidden' },
  fill:          { flex: 1 },
  stream:        { ...StyleSheet.absoluteFillObject },
  offline:       { ...StyleSheet.absoluteFillObject, alignItems: 'center', justifyContent: 'center', backgroundColor: '#181818', padding: 8 },
  offlineName:   { color: '#888', fontSize: 13, fontWeight: '600' },
  offlineText:   { color: '#555', fontSize: 11, marginTop: 4 },
  statusOverlay: { ...StyleSheet.absoluteFillObject, alignItems: 'center', justifyContent: 'center', backgroundColor: 'rgba(0,0,0,0.6)', padding: 8 },
  statusCenter:  { alignItems: 'center', justifyContent: 'center', maxWidth: '100%' },
  statusName:    { color: '#ddd', fontSize: 13, fontWeight: '600' },
  statusText:    { color: '#999', fontSize: 11, marginTop: 6 },
  retryBtn:      { marginTop: 10, borderWidth: 1, borderColor: '#e63', borderRadius: 6, paddingHorizontal: 14, paddingVertical: 6 },
  retryText:     { color: '#e63', fontSize: 12, fontWeight: '700' },
  labelWrap:     { position: 'absolute', left: 0, right: 0, bottom: 0, backgroundColor: 'rgba(0,0,0,0.55)', paddingHorizontal: 8, paddingVertical: 4 },
  label:         { color: '#fff', fontSize: 12, fontWeight: '600' },
  fpsBadge:      { position: 'absolute', top: 4, right: 4, backgroundColor: 'rgba(0,0,0,0.65)', borderRadius: 3, paddingHorizontal: 5, paddingVertical: 2 },
  fpsBadgeText:  { color: '#4a9', fontSize: 10, fontWeight: '700', fontFamily: 'monospace' },
  bboxLabel:     { position: 'absolute', top: 0, left: 0, paddingHorizontal: 4, paddingVertical: 1, borderBottomRightRadius: 3 },
  bboxLabelText: { color: '#000', fontSize: 10, fontWeight: '700' },
});
