import React, { useEffect, useRef } from 'react';
import {
  View, Text, TouchableOpacity, StyleSheet, Animated, StatusBar,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { WebView } from 'react-native-webview';
import { usePersonDetection } from '../hooks/usePersonDetection';
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
  const { result, modelReady, inferring } = usePersonDetection(ip);
  const color = NEARNESS_COLOR[result.nearness];

  return (
    <SafeAreaView style={styles.container}>
      <StatusBar barStyle="light-content" backgroundColor="#111" />

      {/* Header */}
      <View style={styles.header}>
        <View style={styles.headerLeft}>
          <Text style={styles.title}>DoorCam</Text>
          <InferenceIndicator active={inferring} />
        </View>
        <TouchableOpacity onPress={onOpenSettings}>
          <Text style={styles.settings}>Settings</Text>
        </TouchableOpacity>
      </View>

      {/* Status */}
      <View style={[styles.statusBar, { backgroundColor: color + '22' }]}>
        <Text style={[styles.statusText, { color }]}>
          {NEARNESS_LABEL[result.nearness]}
        </Text>
        {result.personCount > 0 && (
          <Text style={styles.countText}> · {result.personCount} person{result.personCount > 1 ? 's' : ''}</Text>
        )}
        {!modelReady && <Text style={styles.loadingText}>  loading model...</Text>}
      </View>

      {/* Candidate scores — only show ≥25%, max 3 */}
      {result.candidates.filter(c => c.score >= PERSON_CANDIDATE_MIN_SCORE).length > 0 && (
        <View style={styles.candidateRow}>
          {result.candidates.filter(c => c.score >= PERSON_CANDIDATE_MIN_SCORE).slice(0, MAX_CANDIDATE_BADGES).map((c, i) => (
            <View key={i} style={[styles.candidateBadge, { borderColor: c.score >= PERSON_DETECTION_THRESHOLD ? '#4a9' : '#fa0' }]}>
              <Text style={[styles.candidateText, { color: c.score >= PERSON_DETECTION_THRESHOLD ? '#4a9' : '#fa0' }]}>
                {(c.score * 100).toFixed(0)}%
              </Text>
            </View>
          ))}
        </View>
      )}

      {/* Stream — always on */}
      <View style={styles.videoContainer}>
        <WebView
          source={{ uri: `http://${ip}:81/stream` }}
          style={styles.stream}
          scrollEnabled={false}
          bounces={false}
        />
      </View>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container:    { flex: 1, backgroundColor: '#111' },
  header:       { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', paddingHorizontal: 16, paddingVertical: 12 },
  headerLeft:   { flexDirection: 'row', alignItems: 'center', gap: 8 },
  title:        { color: '#fff', fontSize: 20, fontWeight: '700' },
  dot:          { width: 8, height: 8, borderRadius: 4 },
  settings:     { color: '#e63', fontSize: 14 },
  statusBar:    { flexDirection: 'row', alignItems: 'center', paddingHorizontal: 16, paddingVertical: 10, marginHorizontal: 16, borderRadius: 8, marginBottom: 12 },
  statusText:   { fontSize: 15, fontWeight: '600' },
  countText:    { color: '#aaa', fontSize: 13, marginLeft: 8 },
  loadingText:   { color: '#555', fontSize: 12, marginLeft: 8 },
  candidateRow:  { flexDirection: 'row', gap: 6, paddingHorizontal: 16, marginBottom: 8 },
  candidateBadge:{ borderWidth: 1, borderRadius: 4, paddingHorizontal: 6, paddingVertical: 2 },
  candidateText: { fontSize: 11, fontWeight: '600' },
  videoContainer: { flex: 1, marginHorizontal: 16, marginBottom: 16, borderRadius: 12, overflow: 'hidden', backgroundColor: '#000' },
  stream:       { flex: 1 },
});
