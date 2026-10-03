import React, { useEffect, useState } from 'react';
import {
  Modal, ScrollView, StyleSheet, Text, TextInput, TouchableOpacity, View,
} from 'react-native';
import { Camera, Dashboard } from '../utils/storage';

interface Props {
  visible: boolean;
  cameras: Camera[];
  /** When provided the modal edits an existing dashboard instead of creating one. */
  initialDashboard?: Dashboard;
  onSave: (name: string, cameraIds: string[]) => void;
  onCancel: () => void;
}

export default function DashboardModal({ visible, cameras, initialDashboard, onSave, onCancel }: Props) {
  const [name, setName] = useState('');
  const [selected, setSelected] = useState<Set<string>>(new Set());

  useEffect(() => {
    if (!visible) return;
    setName(initialDashboard?.name ?? '');
    setSelected(new Set(initialDashboard?.cameraIds ?? cameras.map(c => c.id)));
  }, [visible, initialDashboard]);

  function toggle(id: string) {
    setSelected(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  function handleSave() {
    const trimmed = name.trim();
    onSave(trimmed || 'Dashboard', cameras.filter(c => selected.has(c.id)).map(c => c.id));
  }

  return (
    <Modal visible={visible} animationType="slide" transparent onRequestClose={onCancel}>
      <View style={styles.backdrop}>
        <View style={styles.sheet}>
          <Text style={styles.title}>
            {initialDashboard ? 'Edit dashboard' : 'New dashboard'}
          </Text>

          <TextInput
            style={styles.input}
            value={name}
            onChangeText={setName}
            placeholder="Dashboard name"
            placeholderTextColor="#666"
            autoCapitalize="words"
          />

          <Text style={styles.sectionLabel}>Cameras ({selected.size})</Text>
          <ScrollView style={styles.list}>
            {cameras.length === 0 && (
              <Text style={styles.empty}>No cameras available.</Text>
            )}
            {cameras.map(c => {
              const on = selected.has(c.id);
              return (
                <TouchableOpacity key={c.id} style={styles.row} onPress={() => toggle(c.id)}>
                  <View style={[styles.checkbox, on && styles.checkboxOn]}>
                    {on && <Text style={styles.checkmark}>✓</Text>}
                  </View>
                  <View style={styles.rowInfo}>
                    <Text style={styles.rowName} numberOfLines={1}>{c.name}</Text>
                    <Text style={styles.rowIp}>{c.ip}</Text>
                  </View>
                </TouchableOpacity>
              );
            })}
          </ScrollView>

          <View style={styles.actions}>
            <TouchableOpacity style={styles.cancelBtn} onPress={onCancel}>
              <Text style={styles.cancelText}>Cancel</Text>
            </TouchableOpacity>
            <TouchableOpacity style={styles.saveBtn} onPress={handleSave}>
              <Text style={styles.saveText}>Save</Text>
            </TouchableOpacity>
          </View>
        </View>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  backdrop:     { flex: 1, backgroundColor: 'rgba(0,0,0,0.6)', justifyContent: 'flex-end' },
  sheet:        { backgroundColor: '#181818', borderTopLeftRadius: 16, borderTopRightRadius: 16, padding: 20, maxHeight: '80%' },
  title:        { color: '#fff', fontSize: 18, fontWeight: '700', marginBottom: 12 },
  input:        { backgroundColor: '#222', color: '#fff', fontSize: 16, padding: 12, borderRadius: 8, marginBottom: 16 },
  sectionLabel: { color: '#aaa', fontSize: 13, fontWeight: '600', marginBottom: 8 },
  list:         { maxHeight: 320 },
  empty:        { color: '#555', fontSize: 13, paddingVertical: 8 },
  row:          { flexDirection: 'row', alignItems: 'center', paddingVertical: 10 },
  checkbox:     { width: 22, height: 22, borderRadius: 4, borderWidth: 1, borderColor: '#555', alignItems: 'center', justifyContent: 'center', marginRight: 12 },
  checkboxOn:   { backgroundColor: '#e63', borderColor: '#e63' },
  checkmark:    { color: '#fff', fontSize: 14, fontWeight: '700', lineHeight: 16 },
  rowInfo:      { flex: 1 },
  rowName:      { color: '#fff', fontSize: 15, fontWeight: '600' },
  rowIp:        { color: '#666', fontSize: 12, marginTop: 2 },
  actions:      { flexDirection: 'row', gap: 12, marginTop: 16 },
  cancelBtn:    { flex: 1, padding: 14, borderRadius: 8, borderWidth: 1, borderColor: '#444', alignItems: 'center' },
  cancelText:   { color: '#aaa', fontSize: 15, fontWeight: '600' },
  saveBtn:      { flex: 1, padding: 14, borderRadius: 8, backgroundColor: '#e63', alignItems: 'center' },
  saveText:     { color: '#fff', fontSize: 15, fontWeight: '600' },
});
