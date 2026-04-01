import React, { useState, useEffect, useRef } from 'react';
import {
  View, Text, TextInput, TouchableOpacity, StyleSheet, Modal, FlatList, ActivityIndicator,
} from 'react-native';
import { WebView } from 'react-native-webview';
import { SafeAreaView } from 'react-native-safe-area-context';
import Zeroconf from 'react-native-zeroconf';
import { saveConfig } from '../utils/storage';

interface DiscoveredDevice {
  name: string;
  host: string;
  ip: string;
  txt: Record<string, string>;
}

interface Props {
  onSaved: (ip: string) => void;
  currentIp?: string;
}

export default function SetupScreen({ onSaved, currentIp }: Props) {
  const [ip, setIp] = useState(currentIp ?? '');
  const [showPortal, setShowPortal] = useState(false);
  const [scanning, setScanning] = useState(false);
  const [devices, setDevices] = useState<DiscoveredDevice[]>([]);
  const zeroconf = useRef(new Zeroconf()).current;

  useEffect(() => {
    zeroconf.on('resolved', (service: any) => {
      const ip = service.addresses?.[0];
      if (!ip) return;
      setDevices(prev => {
        const exists = prev.find(d => d.name === service.name);
        if (exists) return prev;
        return [...prev, {
          name: service.name,
          host: service.host,
          ip,
          txt: service.txt ?? {},
        }];
      });
    });

    zeroconf.on('error', (err: any) => {
      console.log('[Zeroconf] error:', err);
      setScanning(false);
    });

    return () => {
      try { zeroconf.stop(); } catch {}
      zeroconf.removeDeviceListeners();
    };
  }, []);

  function startScan() {
    setDevices([]);
    setScanning(true);
    console.log('[Zeroconf] starting scan...');
    try {
      zeroconf.scan('doorcam', 'tcp', 'local.');
      console.log('[Zeroconf] scan called OK');
    } catch (e) {
      console.log('[Zeroconf] scan error:', e);
    }
    setTimeout(() => setScanning(false), 5000);
  }

  async function selectDevice(device: DiscoveredDevice) {
    setIp(device.ip);
    await saveConfig({ ip: device.ip });
    onSaved(device.ip);
  }

  async function handleSave() {
    const trimmed = ip.trim();
    if (!trimmed) return;
    await saveConfig({ ip: trimmed });
    onSaved(trimmed);
  }

  return (
    <SafeAreaView style={styles.container}>
      <Text style={styles.title}>DoorCam Setup</Text>

      {/* Discovery */}
      <View style={styles.section}>
        <View style={styles.row}>
          <Text style={styles.sectionTitle}>Discover devices</Text>
          {scanning && <ActivityIndicator size="small" color="#e63" style={{ marginLeft: 8 }} />}
        </View>
        <TouchableOpacity style={styles.scanButton} onPress={startScan} disabled={scanning}>
          <Text style={styles.scanButtonText}>{scanning ? 'Scanning...' : 'Scan Network'}</Text>
        </TouchableOpacity>

        {devices.length > 0 && (
          <FlatList
            data={devices}
            keyExtractor={d => d.name}
            scrollEnabled={false}
            renderItem={({ item }) => (
              <TouchableOpacity style={styles.deviceRow} onPress={() => selectDevice(item)}>
                <View>
                  <Text style={styles.deviceName}>{item.host.replace('.local.', '')}</Text>
                  <Text style={styles.deviceIp}>{item.ip}</Text>
                </View>
                <Text style={styles.deviceConnect}>Connect →</Text>
              </TouchableOpacity>
            )}
          />
        )}

        {!scanning && devices.length === 0 && (
          <Text style={styles.hint}>No devices found. Make sure ESP32 is on the same WiFi.</Text>
        )}
      </View>

      <View style={styles.divider} />

      {/* Manual IP */}
      <Text style={styles.sectionTitle}>Manual IP</Text>
      <TextInput
        style={styles.input}
        value={ip}
        onChangeText={setIp}
        placeholder="192.168.0.x"
        placeholderTextColor="#666"
        keyboardType="decimal-pad"
        autoCapitalize="none"
      />
      <TouchableOpacity style={styles.button} onPress={handleSave}>
        <Text style={styles.buttonText}>Save & Connect</Text>
      </TouchableOpacity>

      <View style={styles.divider} />

      {/* WiFiManager portal */}
      <Text style={styles.sectionTitle}>New ESP32?</Text>
      <Text style={styles.hint}>
        Connect to <Text style={styles.highlight}>DoorCam-Setup</Text> hotspot first, then tap below.
      </Text>
      <TouchableOpacity style={styles.portalButton} onPress={() => setShowPortal(true)}>
        <Text style={styles.portalButtonText}>Configure ESP32 WiFi</Text>
      </TouchableOpacity>

      <Modal visible={showPortal} animationType="slide" onRequestClose={() => setShowPortal(false)}>
        <SafeAreaView style={styles.modalContainer}>
          <View style={styles.modalHeader}>
            <Text style={styles.modalTitle}>Configure WiFi</Text>
            <TouchableOpacity onPress={() => setShowPortal(false)}>
              <Text style={styles.modalClose}>Done</Text>
            </TouchableOpacity>
          </View>
          <WebView source={{ uri: 'http://192.168.4.1' }} style={styles.webview} />
        </SafeAreaView>
      </Modal>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container:        { flex: 1, backgroundColor: '#111', padding: 24 },
  title:            { color: '#fff', fontSize: 24, fontWeight: '700', marginBottom: 24, marginTop: 8 },
  section:          { marginBottom: 8 },
  row:              { flexDirection: 'row', alignItems: 'center', marginBottom: 8 },
  sectionTitle:     { color: '#fff', fontSize: 15, fontWeight: '600' },
  scanButton:       { borderWidth: 1, borderColor: '#e63', padding: 12, borderRadius: 8, alignItems: 'center', marginBottom: 12 },
  scanButtonText:   { color: '#e63', fontSize: 14, fontWeight: '600' },
  deviceRow:        { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', backgroundColor: '#1a1a1a', padding: 12, borderRadius: 8, marginBottom: 8 },
  deviceName:       { color: '#fff', fontSize: 14, fontWeight: '600' },
  deviceIp:         { color: '#666', fontSize: 12, marginTop: 2 },
  deviceConnect:    { color: '#e63', fontSize: 13 },
  hint:             { color: '#555', fontSize: 12, marginBottom: 12 },
  highlight:        { color: '#e63' },
  divider:          { height: 1, backgroundColor: '#222', marginVertical: 20 },
  input:            { backgroundColor: '#222', color: '#fff', fontSize: 16, padding: 12, borderRadius: 8, marginBottom: 8, marginTop: 8 },
  button:           { backgroundColor: '#e63', padding: 14, borderRadius: 8, alignItems: 'center' },
  buttonText:       { color: '#fff', fontSize: 16, fontWeight: '600' },
  portalButton:     { borderWidth: 1, borderColor: '#555', padding: 12, borderRadius: 8, alignItems: 'center' },
  portalButtonText: { color: '#aaa', fontSize: 14, fontWeight: '600' },
  modalContainer:   { flex: 1, backgroundColor: '#111' },
  modalHeader:      { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', paddingHorizontal: 16, paddingVertical: 12, borderBottomWidth: 1, borderBottomColor: '#222' },
  modalTitle:       { color: '#fff', fontSize: 16, fontWeight: '600' },
  modalClose:       { color: '#e63', fontSize: 15 },
  webview:          { flex: 1 },
});
