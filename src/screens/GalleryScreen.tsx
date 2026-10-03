import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  View, Text, SectionList, Image, TouchableOpacity, StyleSheet,
  Alert, StatusBar, ActivityIndicator,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { VLCPlayer } from 'react-native-vlc-media-player';
import * as FileSystem from 'expo-file-system/legacy';
import {
  CamEvent, DayGroup, MonthGroup,
  deleteEvents, getDaysForMonth, getEventsForDay, getMonths,
} from '../utils/db';

type ViewMode = 'months' | 'days' | 'events' | 'player';

interface Props {
  initialEventId?: string;   // jump straight to a specific event from notification tap
  onClose: () => void;
}

const NEARNESS_COLOR: Record<string, string> = {
  far: '#4a9', close: '#fa0', very_close: '#e63',
};

function toFileUri(path: string): string {
  return path.startsWith('file://') ? path : `file://${path}`;
}

function formatTime(ts: number): string {
  return new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

export default function GalleryScreen({ initialEventId, onClose }: Props) {
  const [viewMode, setViewMode] = useState<ViewMode>('days');
  const [months, setMonths]     = useState<MonthGroup[]>([]);
  const [days, setDays]         = useState<DayGroup[]>([]);
  const [sections, setSections] = useState<{ title: string; data: CamEvent[] }[]>([]);
  const [selectedMonth, setSelectedMonth] = useState<string | null>(null);
  const [loading, setLoading]   = useState(true);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const selecting = selected.size > 0;

  // Player state
  const [playerFrames, setPlayerFrames] = useState<string[]>([]);
  const [playerIndex, setPlayerIndex]   = useState(0);
  const [playerPlaying, setPlayerPlaying] = useState(true);
  const [playerEvent, setPlayerEvent]   = useState<CamEvent | null>(null);
  const playerTimer = useRef<ReturnType<typeof setInterval> | null>(null);

  // Load today's events by default (or jump to month if initialEventId needs it)
  useEffect(() => { loadDays(); }, []);

  async function loadMonths() {
    setLoading(true);
    const data = await getMonths();
    setMonths(data);
    setViewMode('months');
    setLoading(false);
  }

  async function loadDays(month?: string) {
    setLoading(true);
    const m = month ?? new Date().toISOString().slice(0, 7);
    setSelectedMonth(m);
    const data = await getDaysForMonth(m);
    setDays(data);
    setViewMode('days');
    setLoading(false);
  }

  async function openPlayer(event: CamEvent) {
    const dir = `${FileSystem.documentDirectory}doorcam_events/${event.id}`;
    let files: string[] = [];
    try {
      const names = await FileSystem.readDirectoryAsync(dir);
      files = names
        .filter(n => n.endsWith('.jpg'))
        .sort()
        .map(n => `file://${dir.replace('file://', '')}/${n}`);
    } catch {
      // fallback to thumbnail only
      files = event.thumbnail_path ? [toFileUri(event.thumbnail_path)] : [];
    }
    if (files.length === 0) return;
    setPlayerFrames(files);
    setPlayerIndex(0);
    setPlayerEvent(event);
    setPlayerPlaying(true);
    setViewMode('player');
  }

  useEffect(() => {
    if (viewMode !== 'player' || !playerPlaying) {
      if (playerTimer.current) { clearInterval(playerTimer.current); playerTimer.current = null; }
      return;
    }
    playerTimer.current = setInterval(() => {
      setPlayerIndex(i => (i + 1) % playerFrames.length);
    }, 200); // ~5fps playback
    return () => { if (playerTimer.current) clearInterval(playerTimer.current); };
  }, [viewMode, playerPlaying, playerFrames]);

  async function loadEventsForDay(day: string) {
    setLoading(true);
    const events = await getEventsForDay(day);
    setSections([{ title: day, data: events }]);
    setViewMode('events');
    setLoading(false);
  }

  function toggleSelect(id: string) {
    setSelected(prev => {
      const next = new Set(prev);
      next.has(id) ? next.delete(id) : next.add(id);
      return next;
    });
  }

  async function handleDelete() {
    const ids = [...selected];
    Alert.alert('Delete', `Delete ${ids.length} event${ids.length > 1 ? 's' : ''}?`, [
      { text: 'Cancel', style: 'cancel' },
      {
        text: 'Delete', style: 'destructive',
        onPress: async () => {
          // Delete files from disk
          for (const id of ids) {
            const dir = `${FileSystem.documentDirectory}doorcam_events/${id}`;
            await FileSystem.deleteAsync(dir, { idempotent: true });
          }
          await deleteEvents(ids);
          setSelected(new Set());
          // Reload current view
          if (viewMode === 'events' && sections[0]) {
            await loadEventsForDay(sections[0].title);
          }
        },
      },
    ]);
  }

  // ── Months view ──────────────────────────────────────────────────────────
  if (viewMode === 'months') {
    return (
      <SafeAreaView style={styles.container}>
        <StatusBar barStyle="light-content" backgroundColor="#111" />
        <Header title="Gallery" onBack={() => loadDays()} onClose={onClose} />
        {loading ? <ActivityIndicator color="#4a9" style={{ marginTop: 40 }} /> : (
          months.map(m => (
            <TouchableOpacity key={m.month} style={styles.monthRow} onPress={() => loadDays(m.month)}>
              <Text style={styles.monthLabel}>{m.month}</Text>
              <Text style={styles.monthCount}>{m.count} events</Text>
            </TouchableOpacity>
          ))
        )}
      </SafeAreaView>
    );
  }

  // ── Days view ─────────────────────────────────────────────────────────────
  if (viewMode === 'days') {
    return (
      <SafeAreaView style={styles.container}>
        <StatusBar barStyle="light-content" backgroundColor="#111" />
        <Header
          title={selectedMonth ?? 'Gallery'}
          onBack={loadMonths}
          onClose={onClose}
        />
        {loading ? <ActivityIndicator color="#4a9" style={{ marginTop: 40 }} /> : (
          days.length === 0
            ? <Text style={styles.empty}>No events recorded yet</Text>
            : days.map(d => (
                <TouchableOpacity key={d.day} style={styles.dayRow} onPress={() => loadEventsForDay(d.day)}>
                  {d.thumbnail_path ? (
                    <Image source={{ uri: toFileUri(d.thumbnail_path) }} style={styles.dayThumb} />
                  ) : <View style={[styles.dayThumb, { backgroundColor: '#222' }]} />}
                  <View style={{ flex: 1 }}>
                    <Text style={styles.dayLabel}>{d.day}</Text>
                    <Text style={styles.dayCount}>{d.count} event{d.count > 1 ? 's' : ''}</Text>
                  </View>
                </TouchableOpacity>
              ))
        )}
      </SafeAreaView>
    );
  }

  // ── Player view ──────────────────────────────────────────────────────────
  if (viewMode === 'player' && playerEvent) {
    const videoUri = playerEvent.video_path ? `file://${playerEvent.video_path.replace(/^file:\/\//, '')}` : null;
    const frame = playerFrames[playerIndex];
    return (
      <SafeAreaView style={styles.container}>
        <StatusBar barStyle="light-content" backgroundColor="#111" />
        <Header
          title={`${formatTime(playerEvent.timestamp)} · ${playerEvent.nearness.replace('_', ' ')}`}
          onBack={() => { setViewMode('events'); setPlayerPlaying(false); }}
          onClose={onClose}
        />
        <View style={styles.playerFrame}>
          {videoUri ? (
            <VLCPlayer
              source={{ uri: videoUri }}
              style={styles.playerImage}
              repeat={true}
              paused={false}
            />
          ) : (
            frame && <Image source={{ uri: frame }} style={styles.playerImage} resizeMode="contain" />
          )}
        </View>
        {!videoUri && (
          <>
            <View style={styles.playerControls}>
              <TouchableOpacity onPress={() => setPlayerIndex(i => (i - 1 + playerFrames.length) % playerFrames.length)} style={styles.playerBtn}>
                <Text style={styles.playerBtnText}>‹</Text>
              </TouchableOpacity>
              <TouchableOpacity onPress={() => setPlayerPlaying(p => !p)} style={styles.playerBtn}>
                <Text style={styles.playerBtnText}>{playerPlaying ? '⏸' : '▶'}</Text>
              </TouchableOpacity>
              <TouchableOpacity onPress={() => setPlayerIndex(i => (i + 1) % playerFrames.length)} style={styles.playerBtn}>
                <Text style={styles.playerBtnText}>›</Text>
              </TouchableOpacity>
            </View>
            <Text style={styles.playerCounter}>{playerIndex + 1} / {playerFrames.length}</Text>
          </>
        )}
      </SafeAreaView>
    );
  }

  // ── Events view (SectionList) ─────────────────────────────────────────────
  return (
    <SafeAreaView style={styles.container}>
      <StatusBar barStyle="light-content" backgroundColor="#111" />
      <Header
        title={sections[0]?.title ?? ''}
        onBack={() => loadDays(selectedMonth ?? undefined)}
        onClose={onClose}
        rightElement={selecting ? (
          <TouchableOpacity onPress={handleDelete} style={styles.deleteBtn}>
            <Text style={styles.deleteBtnText}>Delete ({selected.size})</Text>
          </TouchableOpacity>
        ) : undefined}
      />
      {loading ? <ActivityIndicator color="#4a9" style={{ marginTop: 40 }} /> : (
        <SectionList
          sections={sections}
          keyExtractor={item => item.id}
          renderSectionHeader={() => null}
          renderItem={({ item }) => {
            const sel = selected.has(item.id);
            return (
              <TouchableOpacity
                style={[styles.eventRow, sel && styles.eventRowSelected]}
                onPress={() => selecting ? toggleSelect(item.id) : openPlayer(item)}
                onLongPress={() => toggleSelect(item.id)}
              >
                {item.thumbnail_path ? (
                  <Image source={{ uri: toFileUri(item.thumbnail_path) }} style={styles.thumb} />
                ) : <View style={[styles.thumb, { backgroundColor: '#222' }]} />}
                <View style={{ flex: 1 }}>
                  <Text style={styles.eventTime}>{formatTime(item.timestamp)}</Text>
                  <Text style={[styles.nearness, { color: NEARNESS_COLOR[item.nearness] ?? '#aaa' }]}>
                    {item.nearness.replace('_', ' ')}
                  </Text>
                  <Text style={styles.frameCount}>{item.frame_count} frames</Text>
                </View>
                {sel && <Text style={styles.checkmark}>✓</Text>}
              </TouchableOpacity>
            );
          }}
          ListEmptyComponent={<Text style={styles.empty}>No events for this day</Text>}
        />
      )}
    </SafeAreaView>
  );
}

function Header({
  title, onBack, onClose, rightElement,
}: {
  title: string; onBack?: () => void; onClose: () => void; rightElement?: React.ReactNode;
}) {
  return (
    <View style={styles.header}>
      <TouchableOpacity onPress={onBack ?? onClose} style={styles.headerBtn}>
        <Text style={styles.headerBtnText}>{onBack ? '‹ Back' : '✕'}</Text>
      </TouchableOpacity>
      <Text style={styles.headerTitle}>{title}</Text>
      <View style={styles.headerRight}>
        {rightElement}
        {onBack && (
          <TouchableOpacity onPress={onClose} style={styles.headerBtn}>
            <Text style={styles.headerBtnText}>✕</Text>
          </TouchableOpacity>
        )}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  container:        { flex: 1, backgroundColor: '#111' },
  header:           { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: 16, paddingVertical: 12, borderBottomWidth: 1, borderBottomColor: '#222' },
  headerBtn:        { minWidth: 60 },
  headerBtnText:    { color: '#e63', fontSize: 15 },
  headerTitle:      { color: '#fff', fontSize: 17, fontWeight: '700' },
  headerRight:      { flexDirection: 'row', alignItems: 'center', gap: 8, minWidth: 60, justifyContent: 'flex-end' },
  empty:            { color: '#555', textAlign: 'center', marginTop: 60, fontSize: 15 },
  monthRow:         { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', paddingHorizontal: 16, paddingVertical: 14, borderBottomWidth: 1, borderBottomColor: '#1e1e1e' },
  monthLabel:       { color: '#fff', fontSize: 16 },
  monthCount:       { color: '#555', fontSize: 13 },
  dayRow:           { flexDirection: 'row', alignItems: 'center', gap: 12, paddingHorizontal: 16, paddingVertical: 10, borderBottomWidth: 1, borderBottomColor: '#1e1e1e' },
  dayThumb:         { width: 60, height: 45, borderRadius: 4, backgroundColor: '#1a1a1a' },
  dayLabel:         { color: '#fff', fontSize: 15 },
  dayCount:         { color: '#555', fontSize: 12, marginTop: 2 },
  eventRow:         { flexDirection: 'row', alignItems: 'center', gap: 12, paddingHorizontal: 16, paddingVertical: 10, borderBottomWidth: 1, borderBottomColor: '#1e1e1e' },
  eventRowSelected: { backgroundColor: '#1a2a1a' },
  thumb:            { width: 80, height: 60, borderRadius: 4, backgroundColor: '#1a1a1a' },
  eventTime:        { color: '#fff', fontSize: 15, fontWeight: '600' },
  nearness:         { fontSize: 12, marginTop: 2, textTransform: 'capitalize' },
  frameCount:       { color: '#444', fontSize: 11, marginTop: 2 },
  checkmark:        { color: '#4a9', fontSize: 20, marginLeft: 8 },
  deleteBtn:        { backgroundColor: '#e6322222', borderWidth: 1, borderColor: '#e63', borderRadius: 4, paddingHorizontal: 10, paddingVertical: 4 },
  deleteBtnText:    { color: '#e63', fontSize: 13, fontWeight: '600' },
  playerFrame:      { flex: 1, backgroundColor: '#000', justifyContent: 'center', alignItems: 'center' },
  playerImage:      { width: '100%', height: '100%' },
  playerControls:   { flexDirection: 'row', justifyContent: 'center', alignItems: 'center', gap: 32, paddingVertical: 16 },
  playerBtn:        { paddingHorizontal: 16, paddingVertical: 8 },
  playerBtnText:    { color: '#fff', fontSize: 32 },
  playerCounter:    { color: '#555', fontSize: 12, textAlign: 'center', paddingBottom: 12 },
});
