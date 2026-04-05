import React, { useEffect, useRef, useState } from 'react';
import {
  View, Text, TouchableOpacity, StyleSheet, Animated, StatusBar,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { usePersonDetection } from '../hooks/usePersonDetection';
import MjpegStream from '../components/MjpegStream';
import { PERSON_DETECTION_THRESHOLD, PERSON_CANDIDATE_MIN_SCORE, MAX_CANDIDATE_BADGES } from '../utils/constants';

interface Props {
  ip: string;
  onOpenSettings: () => void;
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

export default function MonitorScreen({ ip, onOpenSettings }: Props) {
  const [gammaOn, setGammaOn] = useState(true); // firmware default: raw_gma=1
  const { result, modelReady, inferring } = usePersonDetection(gammaOn);
  // const result = { personCount: 1, nearness: 'close' as const, candidates: [{ score: 0.72, boxH: 0.5 }, { score: 0.45, boxH: 0.3 }] }; // MOCK
  const color = NEARNESS_COLOR[result.nearness];

  const toggleGamma = async () => {
    const next = !gammaOn;
    setGammaOn(next);
    try {
      await fetch(`http://${ip}/control?var=raw_gma&val=${next ? 1 : 0}`);
    } catch (e) {
      console.warn('[DoorCam] gamma toggle failed:', e);
    }
  };

  return (
    <SafeAreaView style={styles.container}>
      <StatusBar barStyle="light-content" backgroundColor="#111" />

      {/* Header */}
      <View style={styles.header}>
        <View style={styles.headerLeft}>
          <Text style={styles.title}>DoorCam</Text>
          <InferenceIndicator active={inferring} />
        </View>
        <View style={styles.headerRight}>
          <TouchableOpacity onPress={toggleGamma} style={[styles.gammaBtn, gammaOn && styles.gammaBtnOn]}>
            <Text style={[styles.gammaBtnText, gammaOn && styles.gammaBtnTextOn]}>G</Text>
          </TouchableOpacity>
          <TouchableOpacity onPress={onOpenSettings}>
            <Text style={styles.settings}>Settings</Text>
          </TouchableOpacity>
        </View>
      </View>

      {/* Status — always in layout, blank when nobody */}
      <View style={[styles.statusBar, { backgroundColor: result.nearness !== 'none' ? color + '22' : 'transparent' }]}>
        {result.nearness !== 'none' && (
          <Text style={[styles.statusText, { color }]}>{NEARNESS_LABEL[result.nearness]}</Text>
        )}
        {result.personCount > 0 && (
          <Text style={styles.countText}> · {result.personCount} person{result.personCount > 1 ? 's' : ''}</Text>
        )}
        {!modelReady && <Text style={styles.loadingText}>loading model...</Text>}
      </View>

      {/* Badges — always in layout with fixed height */}
      <View style={styles.candidateRow}>
        {result.nearness !== 'none' && result.candidates.filter(c => c.score >= PERSON_CANDIDATE_MIN_SCORE).slice(0, MAX_CANDIDATE_BADGES).map((c, i) => (
          <View key={i} style={[styles.candidateBadge, { borderColor: c.score >= PERSON_DETECTION_THRESHOLD ? '#4a9' : '#fa0' }]}>
            <Text style={[styles.candidateText, { color: c.score >= PERSON_DETECTION_THRESHOLD ? '#4a9' : '#fa0' }]}>
              {(c.score * 100).toFixed(0)}%
            </Text>
          </View>
        ))}
      </View>

      {/* Stream — native Kotlin bridge, smooth MJPEG */}
      <View style={styles.videoContainer}>
        <MjpegStream url={`http://${ip}:81/stream`} inferenceIntervalMs={1000} style={styles.stream} />
      </View>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container:       { flex: 1, backgroundColor: '#111' },
  header:          { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', paddingHorizontal: 16, paddingVertical: 12 },
  headerLeft:      { flexDirection: 'row', alignItems: 'center', gap: 8 },
  headerRight:     { flexDirection: 'row', alignItems: 'center', gap: 12 },
  title:           { color: '#fff', fontSize: 20, fontWeight: '700' },
  dot:             { width: 8, height: 8, borderRadius: 4 },
  gammaBtn:        { borderWidth: 1, borderColor: '#555', borderRadius: 4, paddingHorizontal: 7, paddingVertical: 2 },
  gammaBtnOn:      { borderColor: '#fa0', backgroundColor: '#fa022' },
  gammaBtnText:    { color: '#555', fontSize: 13, fontWeight: '700' },
  gammaBtnTextOn:  { color: '#fa0' },
  settings:        { color: '#e63', fontSize: 14 },
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
});
