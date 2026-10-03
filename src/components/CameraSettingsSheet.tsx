import React, { useEffect, useState } from 'react';
import {
  View,
  Text,
  TouchableOpacity,
  Switch,
  ScrollView,
  StyleSheet,
  Modal,
} from 'react-native';
import {
  Camera,
  CameraSettings,
  CameraSettingsChange,
  DayNightMode,
  ProfileSlot,
} from '../utils/storage';
import { FRAMESIZE_MODES, SETTING_DEFS, SettingDef, WB_MODES } from '../utils/cameraSettings';

interface Props {
  camera: Camera | null;
  onClose: () => void;
  onChange: (cameraId: string, change: CameraSettingsChange) => void;
  onSetMode: (cameraId: string, mode: DayNightMode) => void;
}

const MODES: { value: DayNightMode; label: string }[] = [
  { value: 'auto', label: 'Auto' },
  { value: 'day', label: 'Day' },
  { value: 'night', label: 'Night' },
];

function slotForNow(camera: Camera): ProfileSlot {
  if (camera.dayNight === 'day') return 'day';
  if (camera.dayNight === 'night') return 'night';
  const hour = new Date().getHours();
  return hour >= 7 && hour < 19 ? 'day' : 'night';
}

export default function CameraSettingsSheet({ camera, onClose, onChange, onSetMode }: Props) {
  const [slot, setSlot] = useState<ProfileSlot>('day');

  // When a different camera is opened, start on whichever profile is active now.
  useEffect(() => {
    if (camera) setSlot(slotForNow(camera));
  }, [camera?.id]);

  const profile: CameraSettings | null = camera
    ? slot === 'day' ? camera.day : camera.night
    : null;

  function patch(key: keyof CameraSettings, value: number | boolean) {
    if (!camera) return;
    onChange(camera.id, { kind: 'patch', slot, patch: { [key]: value } as Partial<CameraSettings> });
  }

  function step(def: SettingDef, dir: 1 | -1) {
    if (!camera || !profile) return;
    const min = def.min ?? 0;
    const max = def.max ?? 0;
    const stepSize = def.step ?? 1;
    const current = profile[def.key] as number;
    const next = Math.min(max, Math.max(min, current + dir * stepSize));
    if (next !== current) patch(def.key, next);
  }

  function copyToOther() {
    if (!camera) return;
    const to: ProfileSlot = slot === 'day' ? 'night' : 'day';
    onChange(camera.id, { kind: 'copy', from: slot, to });
    setSlot(to);
  }

  return (
    <Modal
      visible={camera !== null}
      animationType="slide"
      transparent
      onRequestClose={onClose}
    >
      <View style={styles.backdrop}>
        <View style={styles.sheet}>
          <View style={styles.header}>
            <View style={styles.headerText}>
              <Text style={styles.title}>Camera settings</Text>
              {camera && <Text style={styles.subtitle} numberOfLines={1}>{camera.name}</Text>}
            </View>
            <TouchableOpacity onPress={onClose} hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}>
              <Text style={styles.close}>Done</Text>
            </TouchableOpacity>
          </View>

          {camera && (
            <View style={styles.controls}>
              {/* Schedule mode: Auto · Day · Night */}
              <View style={styles.modeRow}>
                <Text style={styles.modeLabel}>Mode</Text>
                <View style={styles.segment}>
                  {MODES.map(m => {
                    const selected = camera.dayNight === m.value;
                    return (
                      <TouchableOpacity
                        key={m.value}
                        style={[styles.segmentItem, selected && styles.segmentItemActive]}
                        onPress={() => onSetMode(camera.id, m.value)}
                      >
                        <Text style={[styles.segmentText, selected && styles.segmentTextActive]}>
                          {m.label}
                        </Text>
                      </TouchableOpacity>
                    );
                  })}
                </View>
              </View>

              {/* Editable profile tabs */}
              <View style={styles.tabRow}>
                {(['day', 'night'] as ProfileSlot[]).map(s => {
                  const selected = slot === s;
                  return (
                    <TouchableOpacity
                      key={s}
                      style={[styles.tab, selected && styles.tabActive]}
                      onPress={() => setSlot(s)}
                    >
                      <Text style={[styles.tabText, selected && styles.tabTextActive]}>
                        {s === 'day' ? 'Day' : 'Night'}
                      </Text>
                    </TouchableOpacity>
                  );
                })}
                <TouchableOpacity style={styles.copyBtn} onPress={copyToOther}>
                  <Text style={styles.copyText}>
                    Copy {slot === 'day' ? 'Day → Night' : 'Night → Day'}
                  </Text>
                </TouchableOpacity>
              </View>
            </View>
          )}

          <ScrollView contentContainerStyle={styles.body}>
            {camera && profile && SETTING_DEFS.map(def => {
              const value = profile[def.key];

              if (def.kind === 'toggle') {
                return (
                  <View key={def.key} style={styles.row}>
                    <View style={styles.labelWrap}>
                      <Text style={styles.label}>{def.label}</Text>
                      {def.note ? <Text style={styles.note}>{def.note}</Text> : null}
                    </View>
                    <Switch
                      value={value as boolean}
                      onValueChange={v => patch(def.key, v)}
                      trackColor={{ false: '#333', true: '#e63' }}
                      thumbColor="#fff"
                    />
                  </View>
                );
              }

              if (def.kind === 'wb') {
                return (
                  <View key={def.key} style={styles.block}>
                    <Text style={styles.label}>{def.label}</Text>
                    <View style={styles.segment}>
                      {WB_MODES.map((mode, idx) => {
                        const selected = value === idx;
                        return (
                          <TouchableOpacity
                            key={mode}
                            style={[styles.segmentItem, selected && styles.segmentItemActive]}
                            onPress={() => patch(def.key, idx)}
                          >
                            <Text style={[styles.segmentText, selected && styles.segmentTextActive]}>
                              {mode}
                            </Text>
                          </TouchableOpacity>
                        );
                      })}
                    </View>
                  </View>
                );
              }

              if (def.kind === 'framesize') {
                return (
                  <View key={def.key} style={styles.block}>
                    <Text style={styles.label}>{def.label}</Text>
                    <View style={styles.fsWrap}>
                      {FRAMESIZE_MODES.map(fs => {
                        const selected = value === fs.value;
                        return (
                          <TouchableOpacity
                            key={fs.value}
                            style={[styles.fsItem, selected && styles.fsItemActive]}
                            onPress={() => patch(def.key, fs.value)}
                          >
                            <Text style={[styles.fsText, selected && styles.fsTextActive]}>
                              {fs.label}
                            </Text>
                          </TouchableOpacity>
                        );
                      })}
                    </View>
                    {def.note ? <Text style={styles.note}>{def.note}</Text> : null}
                  </View>
                );
              }

              // numeric stepper
              const atMin = (value as number) <= (def.min ?? 0);
              const atMax = (value as number) >= (def.max ?? 0);
              return (
                <View key={def.key} style={styles.row}>
                  <View style={styles.labelWrap}>
                    <Text style={styles.label}>{def.label}</Text>
                    {def.note ? <Text style={styles.note}>{def.note}</Text> : null}
                  </View>
                  <View style={styles.stepper}>
                    <TouchableOpacity
                      style={[styles.stepBtn, atMin && styles.stepBtnDisabled]}
                      disabled={atMin}
                      onPress={() => step(def, -1)}
                    >
                      <Text style={styles.stepBtnText}>−</Text>
                    </TouchableOpacity>
                    <Text style={styles.stepValue}>{String(value)}</Text>
                    <TouchableOpacity
                      style={[styles.stepBtn, atMax && styles.stepBtnDisabled]}
                      disabled={atMax}
                      onPress={() => step(def, 1)}
                    >
                      <Text style={styles.stepBtnText}>+</Text>
                    </TouchableOpacity>
                  </View>
                </View>
              );
            })}
          </ScrollView>
        </View>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  backdrop:           { flex: 1, backgroundColor: 'rgba(0,0,0,0.6)', justifyContent: 'flex-end' },
  sheet:              { backgroundColor: '#111', borderTopLeftRadius: 16, borderTopRightRadius: 16, maxHeight: '85%', paddingBottom: 24 },
  header:             { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', paddingHorizontal: 20, paddingVertical: 16, borderBottomWidth: 1, borderBottomColor: '#222' },
  headerText:         { flex: 1, marginRight: 12 },
  title:              { color: '#fff', fontSize: 17, fontWeight: '700' },
  subtitle:           { color: '#666', fontSize: 12, marginTop: 2 },
  close:              { color: '#e63', fontSize: 15, fontWeight: '600' },
  controls:           { paddingHorizontal: 20, paddingTop: 12 },
  modeRow:            { flexDirection: 'row', alignItems: 'center', marginBottom: 12 },
  modeLabel:          { color: '#888', fontSize: 12, fontWeight: '600', marginRight: 12 },
  tabRow:             { flexDirection: 'row', alignItems: 'center', marginBottom: 4, gap: 8 },
  tab:                { paddingHorizontal: 16, paddingVertical: 8, borderRadius: 8, backgroundColor: '#1a1a1a', borderWidth: 1, borderColor: '#2a2a2a' },
  tabActive:          { backgroundColor: '#e63', borderColor: '#e63' },
  tabText:            { color: '#888', fontSize: 13, fontWeight: '700' },
  tabTextActive:      { color: '#fff' },
  copyBtn:            { marginLeft: 'auto', paddingHorizontal: 10, paddingVertical: 8 },
  copyText:           { color: '#e63', fontSize: 12, fontWeight: '600' },
  body:               { paddingHorizontal: 20, paddingTop: 8 },
  row:                { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingVertical: 14, borderBottomWidth: 1, borderBottomColor: '#1c1c1c' },
  block:              { paddingVertical: 14, borderBottomWidth: 1, borderBottomColor: '#1c1c1c' },
  labelWrap:          { flex: 1, marginRight: 12 },
  label:              { color: '#fff', fontSize: 14, fontWeight: '600' },
  note:               { color: '#555', fontSize: 11, marginTop: 2 },
  stepper:            { flexDirection: 'row', alignItems: 'center' },
  stepBtn:            { width: 36, height: 36, borderRadius: 8, backgroundColor: '#222', alignItems: 'center', justifyContent: 'center' },
  stepBtnDisabled:    { opacity: 0.35 },
  stepBtnText:        { color: '#e63', fontSize: 20, fontWeight: '700', lineHeight: 22 },
  stepValue:          { color: '#fff', fontSize: 15, fontWeight: '600', minWidth: 44, textAlign: 'center' },
  segment:            { flex: 1, flexDirection: 'row', backgroundColor: '#1a1a1a', borderRadius: 8, overflow: 'hidden' },
  segmentItem:        { flex: 1, paddingVertical: 10, alignItems: 'center' },
  segmentItemActive:  { backgroundColor: '#e63' },
  segmentText:        { color: '#888', fontSize: 11, fontWeight: '600' },
  segmentTextActive:  { color: '#fff' },
  fsWrap:             { flexDirection: 'row', flexWrap: 'wrap', gap: 8, marginTop: 10 },
  fsItem:             { paddingHorizontal: 14, paddingVertical: 8, borderRadius: 8, backgroundColor: '#1a1a1a', borderWidth: 1, borderColor: '#2a2a2a' },
  fsItemActive:       { backgroundColor: '#e63', borderColor: '#e63' },
  fsText:             { color: '#888', fontSize: 12, fontWeight: '700' },
  fsTextActive:       { color: '#fff' },
});
