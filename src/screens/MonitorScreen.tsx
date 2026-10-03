import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  View, Text, TouchableOpacity, StyleSheet, Animated, StatusBar, LayoutChangeEvent,
  FlatList, ScrollView,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import * as Notifications from 'expo-notifications';
import { useDoorCamDetection } from '../hooks/useDoorCamDetection';
import { useEngineMetrics } from '../hooks/useEngineMetrics';
import MjpegStream from '../components/MjpegStream';
import CameraTile, { BoundingBoxOverlay } from '../components/CameraTile';
import DashboardModal from '../components/DashboardModal';
import CameraSettingsSheet from '../components/CameraSettingsSheet';
import { Camera, CameraSettingsChange, Dashboard, DayNightMode, DEFAULT_DASHBOARD_ID, activeProfileSlot } from '../utils/storage';
import { PERSON_DETECTION_THRESHOLD, PERSON_CANDIDATE_MIN_SCORE, MAX_CANDIDATE_BADGES } from '../utils/constants';

interface Props {
  cameras: Camera[];
  dashboards: Dashboard[];
  activeDashboardId: string;
  focusedId?: string;
  onSelectCamera: (id: string | null) => void;
  onSelectDashboard: (id: string) => void;
  onCreateDashboard: (name: string, cameraIds: string[]) => void;
  onDeleteDashboard: (id: string) => void;
  onOpenSettings: () => void;
  onOpenGallery: () => void;
  onUpdateSettings: (cameraId: string, change: CameraSettingsChange) => void;
  onSetDayNight: (cameraId: string, mode: DayNightMode) => void;
  /** Re-resolve camera IPs from mDNS (called on offline transition / manual). */
  onResolveCameras?: () => void;
}

/** Tiny resolved-profile label: "D", "N", or "A·D"/"A·N" in auto mode. */
function dayNightLabel(camera: Camera): string {
  const slot = activeProfileSlot(camera, new Date().getHours());
  const letter = slot === 'day' ? 'D' : 'N';
  return camera.dayNight === 'auto' ? `A·${letter}` : letter;
}

const NEARNESS_LABEL: Record<string, string> = {
  none:       'Nobody',
  far:        'Someone far',
  close:      'Someone nearby',
  very_close: 'Someone very close!',
};

const NEARNESS_COLOR: Record<string, string> = {
  none:       '#555',
  far:        '#4a9',
  close:      '#fa0',
  very_close: '#e63',
};

function InferenceIndicator({ active }: { active: boolean }) {
  const pulse = useRef(new Animated.Value(1)).current;

  useEffect(() => {
    if (active) {
      Animated.loop(
        Animated.sequence([
          Animated.timing(pulse, { toValue: 0.2, duration: 600, useNativeDriver: true }),
          Animated.timing(pulse, { toValue: 1,   duration: 600, useNativeDriver: true }),
        ])
      ).start();
    } else {
      pulse.stopAnimation();
      pulse.setValue(1);
    }
  }, [active]);

  return (
    <Animated.View style={[styles.dot, { opacity: pulse, backgroundColor: active ? '#4a9' : '#333' }]} />
  );
}

export default function MonitorScreen({
  cameras,
  dashboards,
  activeDashboardId,
  focusedId,
  onSelectCamera,
  onSelectDashboard,
  onCreateDashboard,
  onDeleteDashboard,
  onOpenSettings,
  onOpenGallery,
  onUpdateSettings,
  onSetDayNight,
  onResolveCameras,
}: Props) {
  const [gammaOn, setGammaOn] = useState(true); // firmware default: raw_gma=1
  const [dashboardModalOpen, setDashboardModalOpen] = useState(false);
  const [settingsId, setSettingsId] = useState<string | null>(null);
  const [videoLayout, setVideoLayout] = useState({ w: 0, h: 0 });
  const [showStats, setShowStats] = useState(false);

  // Resolve the active dashboard (fall back to default), then its cameras.
  const dashboard =
    dashboards.find(d => d.id === activeDashboardId) ??
    dashboards.find(d => d.id === DEFAULT_DASHBOARD_ID);
  const activeCameraIds = dashboard?.cameraIds ?? [];
  const activeCameras = activeCameraIds
    .map(id => cameras.find(c => c.id === id))
    .filter((c): c is Camera => !!c);

  // Every camera in the active dashboard streams AND detects.
  const { states, inferring, statusMap, retryNonces, retryCamera } =
    useDoorCamDetection({ cameras, activeCameraIds });

  // Debug HUD metrics — only polls while the Stats panel is visible.
  const { cameraStats, detector } = useEngineMetrics(showStats);

  // When a camera transitions online → offline, its stored IP may be stale.
  // Trigger a one-shot mDNS re-resolve (debounced) so it can come back.
  const prevOnlineRef = useRef<Map<string, boolean>>(new Map());
  const resolvingRef = useRef(false);
  const statusKey = activeCameraIds
    .map(id => {
      const online = statusMap.get(id)?.online;
      return `${id}:${online === undefined ? 'u' : online ? '1' : '0'}`;
    })
    .join('|');
  useEffect(() => {
    if (!onResolveCameras) return;
    let transitionedOffline = false;
    activeCameraIds.forEach(id => {
      const online = statusMap.get(id)?.online;
      if (online === undefined) return;
      const prev = prevOnlineRef.current.get(id);
      if (prev === true && online === false) transitionedOffline = true;
      prevOnlineRef.current.set(id, online);
    });
    if (transitionedOffline && !resolvingRef.current) {
      resolvingRef.current = true;
      onResolveCameras();
      setTimeout(() => { resolvingRef.current = false; }, 8000);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [statusKey, onResolveCameras]);

  // Fullscreen when a camera is explicitly focused, or when the dashboard has exactly one.
  const focusedCamera = activeCameras.find(c => c.id === focusedId);
  const activeCamera = focusedCamera ?? (activeCameras.length === 1 ? activeCameras[0] : undefined);
  const activeState = activeCamera ? states.get(activeCamera.id) : undefined;

  const nearness = activeState?.nearness ?? 'none';
  const candidates = activeState?.boxes ?? [];
  const color = NEARNESS_COLOR[nearness];
  const frameWidth = activeState?.frameWidth ?? 0;
  const frameHeight = activeState?.frameHeight ?? 0;

  const onVideoLayout = useCallback((e: LayoutChangeEvent) => {
    const { width, height } = e.nativeEvent.layout;
    setVideoLayout({ w: width, h: height });
  }, []);

  const fireTestNotification = async () => {
    await Notifications.scheduleNotificationAsync({
      content: {
        title: 'Someone at the door',
        body: '[DEBUG] 1 person detected (85%)',
        sound: 'default',
        data: {},
      },
      trigger: { seconds: 1, channelId: 'doorcam-v2' },
    });
  };

  const toggleGamma = async () => {
    const next = !gammaOn;
    setGammaOn(next);
    const targetIp = activeCamera?.ip ?? cameras[0]?.ip;
    if (!targetIp) return;
    try {
      await fetch(`http://${targetIp}/control?var=raw_gma&val=${next ? 1 : 0}`);
    } catch (e) {
      console.warn('[DoorCam] gamma toggle failed:', e);
    }
  };

  const exitFocus = () => onSelectCamera(null);

  function stateFor(cameraId: string) {
    return states.get(cameraId);
  }

  function renderGrid() {
    if (activeCameras.length === 0) {
      return (
        <View style={styles.emptyState}>
          <Text style={styles.emptyTitle}>No cameras in this dashboard</Text>
          <Text style={styles.emptyHint}>Tap + above to create a dashboard with cameras.</Text>
        </View>
      );
    }

    if (activeCameras.length >= 5) {
      // 5+ cameras: 2-column scrolling grid (never 3x3).
      return (
        <FlatList
          style={styles.gridList}
          contentContainerStyle={styles.listContent}
          data={activeCameras}
          keyExtractor={c => c.id}
          numColumns={2}
          renderItem={({ item }) => {
            const s = stateFor(item.id);
            return (
              <View style={styles.listCell}>
                <CameraTile
                  camera={item}
                  boxes={s?.boxes}
                  frameSize={s ? { w: s.frameWidth, h: s.frameHeight } : undefined}
                  status={statusMap.get(item.id)}
                  retryNonce={retryNonces[item.id] ?? 0}
                  onRetry={() => retryCamera(item.id)}
                  onPress={() => onSelectCamera(item.id)}
                  debugFps={showStats ? cameraStats.get(item.id)?.srcFps : undefined}
                />
              </View>
            );
          }}
        />
      );
    }

    if (activeCameras.length === 2) {
      // 2 cameras: two stacked rows.
      return (
        <View style={[styles.gridArea, styles.gridColumn]}>
          {activeCameras.map(c => {
            const s = stateFor(c.id);
            return (
              <View key={c.id} style={styles.stackCell}>
                <CameraTile
                  camera={c}
                  boxes={s?.boxes}
                  frameSize={s ? { w: s.frameWidth, h: s.frameHeight } : undefined}
                  status={statusMap.get(c.id)}
                  retryNonce={retryNonces[c.id] ?? 0}
                  onRetry={() => retryCamera(c.id)}
                  onPress={() => onSelectCamera(c.id)}
                  debugFps={showStats ? cameraStats.get(c.id)?.srcFps : undefined}
                />
              </View>
            );
          })}
        </View>
      );
    }

    // 3–4 cameras: 2x2 grid.
    return (
      <View style={[styles.gridArea, styles.gridWrap]}>
        {activeCameras.map(c => {
          const s = stateFor(c.id);
          return (
            <View key={c.id} style={styles.quadCell}>
              <CameraTile
                camera={c}
                boxes={s?.boxes}
                frameSize={s ? { w: s.frameWidth, h: s.frameHeight } : undefined}
                status={statusMap.get(c.id)}
                retryNonce={retryNonces[c.id] ?? 0}
                onRetry={() => retryCamera(c.id)}
                onPress={() => onSelectCamera(c.id)}
              />
            </View>
          );
        })}
      </View>
    );
  }

  return (
    <SafeAreaView style={styles.container}>
      <StatusBar barStyle="light-content" backgroundColor="#111" />

      {/* Header */}
      <View style={styles.header}>
        <View style={styles.headerLeft}>
          {activeCamera && activeCameras.length > 1 && (
            <TouchableOpacity onPress={exitFocus} style={styles.backBtn}>
              <Text style={styles.backBtnText}>‹ Grid</Text>
            </TouchableOpacity>
          )}
          <Text style={styles.title}>DoorCam</Text>
          {activeCamera && (
            <View style={styles.dnBadge}>
              <Text style={styles.dnBadgeText}>{dayNightLabel(activeCamera)}</Text>
            </View>
          )}
          <InferenceIndicator active={inferring} />
        </View>
        <View style={styles.headerRight}>
          <TouchableOpacity
            onPress={() => setShowStats(s => !s)}
            style={[styles.statsBtn, showStats && styles.statsBtnOn]}
          >
            <Text style={[styles.statsBtnText, showStats && styles.statsBtnTextOn]}>Stats</Text>
          </TouchableOpacity>
          <TouchableOpacity onPress={toggleGamma} style={[styles.gammaBtn, gammaOn && styles.gammaBtnOn]}>
            <Text style={[styles.gammaBtnText, gammaOn && styles.gammaBtnTextOn]}>G</Text>
          </TouchableOpacity>
          {activeCamera && (
            <TouchableOpacity onPress={() => setSettingsId(activeCamera.id)}>
              <Text style={styles.settings}>⚙</Text>
            </TouchableOpacity>
          )}
          <TouchableOpacity onPress={fireTestNotification}>
            <Text style={styles.settings}>Debug</Text>
          </TouchableOpacity>
          <TouchableOpacity onPress={onOpenGallery}>
            <Text style={styles.settings}>Gallery</Text>
          </TouchableOpacity>
          <TouchableOpacity onPress={onOpenSettings}>
            <Text style={styles.settings}>Settings</Text>
          </TouchableOpacity>
        </View>
      </View>

      <CameraSettingsSheet
        camera={cameras.find(c => c.id === settingsId) ?? null}
        onClose={() => setSettingsId(null)}
        onChange={onUpdateSettings}
        onSetMode={onSetDayNight}
      />

      {/* Dashboard switcher */}
      <ScrollView
        horizontal
        showsHorizontalScrollIndicator={false}
        style={styles.dashBar}
        contentContainerStyle={styles.dashBarContent}
      >
        {dashboards.map(d => {
          const active = d.id === activeDashboardId;
          const isDefault = d.id === DEFAULT_DASHBOARD_ID;
          return (
            <TouchableOpacity
              key={d.id}
              style={[styles.chip, active && styles.chipActive]}
              onPress={() => onSelectDashboard(d.id)}
              onLongPress={isDefault ? undefined : () => onDeleteDashboard(d.id)}
              delayLongPress={400}
            >
              <Text style={[styles.chipText, active && styles.chipTextActive]}>{d.name}</Text>
            </TouchableOpacity>
          );
        })}
        <TouchableOpacity style={[styles.chip, styles.addChip]} onPress={() => setDashboardModalOpen(true)}>
          <Text style={styles.addChipText}>+</Text>
        </TouchableOpacity>
      </ScrollView>

      {activeCamera ? (
        <>
          {/* Status — always in layout, blank when nobody */}
          <View style={[styles.statusBar, { backgroundColor: nearness !== 'none' ? color + '22' : 'transparent' }]}>
            {nearness !== 'none' && (
              <Text style={[styles.statusText, { color }]}>{NEARNESS_LABEL[nearness]}</Text>
            )}
            {candidates.length > 0 && (
              <Text style={styles.countText}> · {candidates.length} person{candidates.length > 1 ? 's' : ''}</Text>
            )}
          </View>

          {/* Badges — always in layout with fixed height */}
          <View style={styles.candidateRow}>
            {nearness !== 'none' && candidates.filter(c => c.score >= PERSON_CANDIDATE_MIN_SCORE).slice(0, MAX_CANDIDATE_BADGES).map((c, i) => (
              <View key={i} style={[styles.candidateBadge, { borderColor: c.score >= PERSON_DETECTION_THRESHOLD ? '#4a9' : '#fa0' }]}>
                <Text style={[styles.candidateText, { color: c.score >= PERSON_DETECTION_THRESHOLD ? '#4a9' : '#fa0' }]}>
                  {(c.score * 100).toFixed(0)}%
                </Text>
              </View>
            ))}
          </View>

          {/* Stream — native Kotlin bridge, smooth MJPEG */}
          <View style={styles.videoContainer} onLayout={onVideoLayout}>
            <MjpegStream
              url={`http://${activeCamera.ip}:81/stream`}
              streamId={activeCamera.id}
              detectionEnabled={false}
              style={styles.stream}
            />
            <BoundingBoxOverlay
              candidates={candidates.filter(c => c.score >= PERSON_DETECTION_THRESHOLD)}
              containerW={videoLayout.w}
              containerH={videoLayout.h}
              frameW={frameWidth}
              frameH={frameHeight}
            />
            {activeCameras.length > 1 && (
              <TouchableOpacity style={StyleSheet.absoluteFill} activeOpacity={1} onPress={exitFocus}>
                <View style={styles.tapHint}>
                  <Text style={styles.tapHintText}>Tap for grid</Text>
                </View>
              </TouchableOpacity>
            )}
          </View>
        </>
      ) : (
        renderGrid()
      )}

      {showStats && (
        <View style={styles.statsPanel} pointerEvents="none">
          <Text style={styles.statsHeader}>detector: {detector || '—'}</Text>
          {activeCameras.map(c => {
            const s = cameraStats.get(c.id);
            return (
              <Text key={c.id} style={styles.statsRow} numberOfLines={1}>
                {c.name} · src {(s?.srcFps ?? 0).toFixed(1)}fps · draw {(s?.drawnFps ?? 0).toFixed(1)}fps
                {' · inf '}{(s?.infPerSec ?? 0).toFixed(1)}/s {(s?.inferenceMsEwma ?? 0).toFixed(1)}ms
                {' · '}{s?.detectionsConfirmed ?? 0} det
                {' · lat '}{(s?.detectionLatencyMs ?? 0).toFixed(1)}ms
                {' · inf '}{(s?.inferenceMsEwma ?? 0).toFixed(1)}ms
                {' · dec '}{(s?.decodeMs ?? 0).toFixed(1)}ms
              </Text>
            );
          })}
        </View>
      )}

      <DashboardModal
        visible={dashboardModalOpen}
        cameras={cameras}
        onSave={(name, cameraIds) => {
          onCreateDashboard(name, cameraIds);
          setDashboardModalOpen(false);
        }}
        onCancel={() => setDashboardModalOpen(false)}
      />
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container:       { flex: 1, backgroundColor: '#111' },
  header:          { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', paddingHorizontal: 16, paddingVertical: 12 },
  headerLeft:      { flexDirection: 'row', alignItems: 'center', gap: 8 },
  headerRight:     { flexDirection: 'row', alignItems: 'center', gap: 12 },
  title:           { color: '#fff', fontSize: 20, fontWeight: '700' },
  backBtn:         { paddingRight: 6 },
  backBtnText:     { color: '#e63', fontSize: 13, fontWeight: '600' },
  dot:             { width: 8, height: 8, borderRadius: 4 },
  dnBadge:         { backgroundColor: '#1e1e1e', borderWidth: 1, borderColor: '#2c2c2c', borderRadius: 4, paddingHorizontal: 5, paddingVertical: 1 },
  dnBadgeText:     { color: '#4a9', fontSize: 10, fontWeight: '700', fontFamily: 'monospace' },
  gammaBtn:        { borderWidth: 1, borderColor: '#555', borderRadius: 4, paddingHorizontal: 7, paddingVertical: 2 },
  gammaBtnOn:      { borderColor: '#fa0', backgroundColor: '#fa022' },
  gammaBtnText:    { color: '#555', fontSize: 13, fontWeight: '700' },
  gammaBtnTextOn:  { color: '#fa0' },
  statsBtn:        { borderWidth: 1, borderColor: '#555', borderRadius: 4, paddingHorizontal: 7, paddingVertical: 2 },
  statsBtnOn:      { borderColor: '#4a9', backgroundColor: '#4a922' },
  statsBtnText:    { color: '#555', fontSize: 13, fontWeight: '700' },
  statsBtnTextOn:  { color: '#4a9' },
  settings:        { color: '#e63', fontSize: 14 },

  // Debug metrics HUD
  statsPanel:      { position: 'absolute', left: 8, right: 8, bottom: 8, backgroundColor: 'rgba(0,0,0,0.78)', borderRadius: 6, borderWidth: 1, borderColor: '#333', paddingHorizontal: 8, paddingVertical: 6 },
  statsHeader:     { color: '#4a9', fontSize: 11, fontWeight: '700', fontFamily: 'monospace', marginBottom: 3 },
  statsRow:        { color: '#ddd', fontSize: 10, fontFamily: 'monospace', lineHeight: 14 },

  // Dashboard switcher
  dashBar:         { maxHeight: 44 },
  dashBarContent:  { paddingHorizontal: 16, paddingBottom: 8, gap: 8, alignItems: 'center' },
  chip:            { paddingHorizontal: 12, paddingVertical: 6, borderRadius: 16, backgroundColor: '#1e1e1e', borderWidth: 1, borderColor: '#2c2c2c' },
  chipActive:      { backgroundColor: '#e63', borderColor: '#e63' },
  chipText:        { color: '#aaa', fontSize: 13, fontWeight: '600' },
  chipTextActive:  { color: '#fff' },
  addChip:         { paddingHorizontal: 12, backgroundColor: 'transparent', borderStyle: 'dashed', borderColor: '#555' },
  addChipText:     { color: '#aaa', fontSize: 16, fontWeight: '700', lineHeight: 18 },

  statusBar:       { flexDirection: 'row', alignItems: 'center', paddingHorizontal: 16, paddingVertical: 10, marginHorizontal: 16, borderRadius: 8, marginBottom: 4, minHeight: 44, borderWidth: 1, borderColor: '#222' },
  statusText:      { fontSize: 15, fontWeight: '600' },
  countText:       { color: '#aaa', fontSize: 13, marginLeft: 8 },
  loadingText:     { color: '#555', fontSize: 12, marginLeft: 8 },
  candidateRow:    { flexDirection: 'row', gap: 6, paddingHorizontal: 16, marginBottom: 8, minHeight: 28, alignItems: 'center' },
  candidateBadge:  { borderWidth: 1, borderRadius: 4, paddingHorizontal: 6, paddingVertical: 2, alignItems: 'center', justifyContent: 'center' },
  candidateText:   { fontSize: 11, fontWeight: '600', textAlign: 'center' },
  videoContainer:  { flex: 1, marginHorizontal: 16, marginBottom: 16, backgroundColor: '#000' },
  stream:          { flex: 1 },
  streamPlaceholder: { backgroundColor: '#111' },
  tapHint:         { position: 'absolute', top: 8, right: 8, backgroundColor: 'rgba(0,0,0,0.6)', paddingHorizontal: 8, paddingVertical: 4, borderRadius: 4 },
  tapHintText:     { color: '#aaa', fontSize: 11 },
  bboxLabel:         { position: 'absolute', top: 0, left: 0, paddingHorizontal: 4, paddingVertical: 1, borderBottomRightRadius: 3 },
  bboxLabelText:     { color: '#000', fontSize: 10, fontWeight: '700' },

  // Empty state
  emptyState:      { flex: 1, alignItems: 'center', justifyContent: 'center', padding: 24 },
  emptyTitle:      { color: '#aaa', fontSize: 16, fontWeight: '600', marginBottom: 6 },
  emptyHint:       { color: '#555', fontSize: 13, textAlign: 'center' },

  // Grid layouts
  gridList:        { flex: 1 },
  listContent:     { paddingHorizontal: 12, paddingBottom: 12 },
  listCell:        { width: '50%', padding: 4, aspectRatio: 4 / 3 },
  gridArea:        { flex: 1, paddingHorizontal: 12, paddingBottom: 12 },
  gridColumn:      { flexDirection: 'column' },
  stackCell:       { flex: 1, paddingVertical: 4 },
  gridWrap:        { flexDirection: 'row', flexWrap: 'wrap' },
  quadCell:        { width: '50%', height: '50%', padding: 4 },
});
