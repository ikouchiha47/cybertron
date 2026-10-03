import React, { useState } from 'react';
import { View, Text, TouchableOpacity, StyleSheet } from 'react-native';
import { DetectionSettings } from '../utils/storage';

interface Props {
  value: DetectionSettings;
  onChange: (patch: Partial<DetectionSettings>) => void;
}

interface RowSpec {
  key: keyof DetectionSettings;
  label: string;
  unit: string;
  min: number;
  max: number;
  step: number;
  /** Optional clarifying note shown under the label. */
  note?: string;
  format: (v: number) => string;
}

/**
 * Global native detection-engine tuning. Values map 1:1 to the fields parsed by
 * `InferencePipeline.setDetectionConfig` (personScoreThreshold, kConfirm,
 * mWindow, emptyFramesBeforeReset, inferenceIntervalMs, keyframeIntervalMs).
 */
const ROWS: RowSpec[] = [
  {
    key: 'inferenceIntervalMs',
    label: 'Inference interval',
    unit: 'ms',
    min: 100,
    max: 2000,
    step: 100,
    format: v => `${v}`,
  },
  {
    key: 'keyframeIntervalMs',
    label: 'Keyframe (ms)',
    unit: '',
    min: 250,
    max: 10000,
    step: 250,
    note: 'Max wait before inference when no motion',
    format: v => `${v}`,
  },
  {
    key: 'kConfirm',
    label: 'Confirm frames (K)',
    unit: '',
    min: 1,
    max: 5,
    step: 1,
    format: v => `${v}`,
  },
  {
    key: 'mWindow',
    label: 'Window (M)',
    unit: '',
    min: 1,
    max: 6,
    step: 1,
    format: v => `${v}`,
  },
  {
    key: 'emptyFramesBeforeReset',
    label: 'Reset after',
    unit: 'misses',
    min: 1,
    max: 10,
    step: 1,
    format: v => `${v}`,
  },
  {
    key: 'personScoreThreshold',
    label: 'Person score threshold',
    unit: '',
    min: 0.1,
    max: 0.9,
    step: 0.05,
    format: v => `${(v * 100).toFixed(0)}%`,
  },
];

/** Snap to the step's precision so repeated +/− doesn't drift (0.1+0.1…). */
function roundToStep(value: number, step: number): number {
  const decimals = (String(step).split('.')[1] || '').length;
  return Number(value.toFixed(decimals));
}

export default function DetectionSettingsPanel({ value, onChange }: Props) {
  const [expanded, setExpanded] = useState(false);

  function step(row: RowSpec, dir: number) {
    const current = value[row.key];
    const next = Math.min(row.max, Math.max(row.min, roundToStep(current + dir * row.step, row.step)));
    if (next !== current) onChange({ [row.key]: next } as Partial<DetectionSettings>);
  }

  return (
    <View style={styles.section}>
      <TouchableOpacity
        style={styles.header}
        onPress={() => setExpanded(e => !e)}
        hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
      >
        <Text style={styles.sectionTitle}>Detection</Text>
        <Text style={styles.chevron}>{expanded ? '▾' : '▸'}</Text>
      </TouchableOpacity>

      {expanded && (
        <View>
          <Text style={styles.note}>Lower interval = faster, more CPU</Text>
          {ROWS.map(row => {
            const current = value[row.key];
            const atMin = current <= row.min;
            const atMax = current >= row.max;
            return (
              <View key={row.key} style={styles.row}>
                <View style={styles.labelWrap}>
                  <View style={styles.labelRow}>
                    <Text style={styles.label}>{row.label}</Text>
                    {!!row.unit && <Text style={styles.unit}>{row.unit}</Text>}
                  </View>
                  {!!row.note && <Text style={styles.rowNote}>{row.note}</Text>}
                </View>
                <View style={styles.stepper}>
                  <TouchableOpacity
                    style={[styles.stepBtn, atMin && styles.stepBtnDisabled]}
                    onPress={() => step(row, -1)}
                    disabled={atMin}
                  >
                    <Text style={styles.stepText}>−</Text>
                  </TouchableOpacity>
                  <Text style={styles.value}>{row.format(current)}</Text>
                  <TouchableOpacity
                    style={[styles.stepBtn, atMax && styles.stepBtnDisabled]}
                    onPress={() => step(row, 1)}
                    disabled={atMax}
                  >
                    <Text style={styles.stepText}>+</Text>
                  </TouchableOpacity>
                </View>
              </View>
            );
          })}
        </View>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  section:     { marginBottom: 8 },
  header:      { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingVertical: 4 },
  sectionTitle:{ color: '#fff', fontSize: 15, fontWeight: '600' },
  chevron:     { color: '#aaa', fontSize: 14 },
  note:        { color: '#555', fontSize: 12, marginTop: 4, marginBottom: 4 },
  row:         { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', backgroundColor: '#1a1a1a', paddingHorizontal: 12, paddingVertical: 8, borderRadius: 8, marginTop: 8 },
  labelWrap:   { flex: 1, marginRight: 12 },
  labelRow:    { flexDirection: 'row', alignItems: 'center' },
  label:       { color: '#fff', fontSize: 14 },
  rowNote:     { color: '#666', fontSize: 11, marginTop: 2 },
  unit:        { color: '#666', fontSize: 12, marginLeft: 6 },
  stepper:     { flexDirection: 'row', alignItems: 'center' },
  stepBtn:     { width: 32, height: 32, borderRadius: 16, backgroundColor: '#2a2a2a', alignItems: 'center', justifyContent: 'center' },
  stepBtnDisabled: { opacity: 0.35 },
  stepText:    { color: '#e63', fontSize: 18, fontWeight: '700', lineHeight: 20 },
  value:       { color: '#fff', fontSize: 14, fontWeight: '600', minWidth: 56, textAlign: 'center' },
});
