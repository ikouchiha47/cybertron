import React, { useEffect, useRef, useState } from "react";
import {
  View, Text, FlatList, TouchableOpacity, TextInput,
  StyleSheet, Alert, ActivityIndicator,
} from "react-native";
import type { StackScreenProps } from "@react-navigation/stack";
import type { RootStackParams } from "../navigation/AppNavigator";
import { registry } from "../devices/registry/DeviceRegistry";
import { useMDNSDiscovery } from "../discovery/useMDNSDiscovery";
import { AndroidTV } from "../../modules/androidtv";
import { ANDROIDTV_COMMANDS } from "../devices/adapters/AndroidTVAdapter";
import type { DeviceMetadata } from "../types";

type Props = StackScreenProps<RootStackParams, "Settings">;

export function SettingsScreen({ navigation }: Props) {
  const { devices: discovered, scanning, rescan } = useMDNSDiscovery();
  const [saved, setSaved] = useState<DeviceMetadata[]>([]);
  const [manualHost, setManualHost] = useState("");
  const [manualName, setManualName] = useState("");
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editName, setEditName] = useState("");
  const connectingRef = useRef(false);

  // Load persisted devices
  useEffect(() => {
    registry.load().then(() => setSaved(registry.all()));
  }, []);

  // Auto-register newly discovered devices (don't overwrite existing names)
  useEffect(() => {
    discovered.forEach((d) => {
      if (!registry.get(d.id)) {
        const commands = d.transport === "androidtv" ? ANDROIDTV_COMMANDS : [];
        registry.register({ ...d, availableCommands: commands });
      }
    });
    setSaved(registry.all());
  }, [discovered]);

  async function addManual() {
    if (!manualHost.trim()) return;
    const [host, portStr] = manualHost.trim().split(":");
    const port = portStr ? parseInt(portStr, 10) : 6466;
    const id = `manual:${host}:${port}`;
    const name = manualName.trim() || host;
    await registry.register({
      id, name, host, port,
      transport: "androidtv",
      availableCommands: ANDROIDTV_COMMANDS,
    });
    setManualHost("");
    setManualName("");
    setSaved(registry.all());
  }

  async function saveEditName(id: string) {
    const meta = registry.get(id);
    if (!meta || !editName.trim()) { setEditingId(null); return; }
    await registry.register({ ...meta, name: editName.trim() });
    setSaved(registry.all());
    setEditingId(null);
  }

  async function removeDevice(id: string) {
    const meta = registry.get(id);
    Alert.alert(
      "Remove Device",
      `Remove "${meta?.name}"?`,
      [
        { text: "Cancel", style: "cancel" },
        {
          text: "Remove", style: "destructive",
          onPress: async () => {
            await registry.remove(id);
            setSaved(registry.all());
          },
        },
      ]
    );
  }

  function openDevice(meta: DeviceMetadata) {
    if (meta.transport !== "androidtv") {
      navigation.navigate("ActiveControl", { deviceId: meta.id });
      return;
    }
    if (connectingRef.current) return;
    connectingRef.current = true;

    const subs: { remove(): void }[] = [];
    const onReady = AndroidTV.onReady(() => {
      subs.forEach((s) => s.remove());
      connectingRef.current = false;
      navigation.navigate("ActiveControl", { deviceId: meta.id });
    });
    const onError = AndroidTV.onError(() => {
      subs.forEach((s) => s.remove());
      connectingRef.current = false;
      navigation.navigate("Pairing", { deviceId: meta.id });
    });
    subs.push(onReady, onError);

    AndroidTV.connect(meta.host).catch(() => {
      subs.forEach((s) => s.remove());
      connectingRef.current = false;
      navigation.navigate("Pairing", { deviceId: meta.id });
    });
  }

  function renderDevice({ item }: { item: DeviceMetadata }) {
    const isEditing = editingId === item.id;
    return (
      <View style={s.row}>
        <View style={s.rowInfo}>
          {isEditing ? (
            <TextInput
              style={s.nameInput}
              value={editName}
              onChangeText={setEditName}
              onSubmitEditing={() => saveEditName(item.id)}
              onBlur={() => saveEditName(item.id)}
              autoFocus
              returnKeyType="done"
            />
          ) : (
            <TouchableOpacity onPress={() => openDevice(item)}>
              <Text style={s.rowName}>{item.name}</Text>
            </TouchableOpacity>
          )}
          <Text style={s.rowSub}>{item.host}  {item.transport}</Text>
        </View>
        <View style={s.rowActions}>
          <TouchableOpacity
            style={s.iconBtn}
            onPress={() => {
              setEditingId(item.id);
              setEditName(item.name);
            }}
          >
            <Text style={s.iconBtnText}>✎</Text>
          </TouchableOpacity>
          <TouchableOpacity style={[s.iconBtn, s.iconBtnDanger]} onPress={() => removeDevice(item.id)}>
            <Text style={s.iconBtnText}>✕</Text>
          </TouchableOpacity>
        </View>
      </View>
    );
  }

  return (
    <View style={s.container}>
      {/* Saved devices */}
      <Text style={s.label}>Devices</Text>
      <FlatList
        data={saved}
        keyExtractor={(d) => d.id}
        renderItem={renderDevice}
        ListEmptyComponent={<Text style={s.empty}>No devices saved yet</Text>}
        style={s.list}
      />

      {/* mDNS scan */}
      <View style={s.sectionRow}>
        <Text style={s.label}>Discover on Network</Text>
        <TouchableOpacity
          style={[s.scanBtn, scanning && s.scanBtnActive]}
          onPress={scanning ? undefined : rescan}
          disabled={scanning}
        >
          {scanning
            ? <ActivityIndicator color="#4a9eff" size="small" />
            : <Text style={s.scanBtnText}>Scan</Text>}
        </TouchableOpacity>
      </View>

      {/* Manual add */}
      <Text style={s.label}>Add Manually</Text>
      <View style={s.manualBlock}>
        <TextInput
          style={s.input}
          placeholder="Name (optional)"
          placeholderTextColor="#555"
          value={manualName}
          onChangeText={setManualName}
        />
        <View style={s.manualRow}>
          <TextInput
            style={[s.input, { flex: 1 }]}
            placeholder="host or host:port"
            placeholderTextColor="#555"
            value={manualHost}
            onChangeText={setManualHost}
            autoCapitalize="none"
            keyboardType="url"
          />
          <TouchableOpacity style={s.addBtn} onPress={addManual}>
            <Text style={s.addBtnText}>Add</Text>
          </TouchableOpacity>
        </View>
      </View>
    </View>
  );
}

const s = StyleSheet.create({
  container:    { flex: 1, backgroundColor: "#0f0f0f", padding: 16 },
  label:        { fontSize: 11, color: "#666", textTransform: "uppercase", letterSpacing: 1, marginBottom: 8, marginTop: 16 },
  list:         { maxHeight: 340 },
  sectionRow:   { flexDirection: "row", justifyContent: "space-between", alignItems: "center" },
  row:          { flexDirection: "row", justifyContent: "space-between", alignItems: "center", backgroundColor: "#1c1c1c", borderRadius: 10, padding: 14, marginBottom: 8 },
  rowInfo:      { flex: 1 },
  rowName:      { fontSize: 15, color: "#fff" },
  rowSub:       { fontSize: 11, color: "#555", marginTop: 2 },
  nameInput:    { fontSize: 15, color: "#fff", borderBottomWidth: 1, borderBottomColor: "#4a9eff", paddingVertical: 2 },
  rowActions:   { flexDirection: "row", gap: 8 },
  iconBtn:      { backgroundColor: "#1e3a5f", width: 30, height: 30, borderRadius: 8, justifyContent: "center", alignItems: "center" },
  iconBtnDanger:{ backgroundColor: "#3a1e1e" },
  iconBtnText:  { color: "#fff", fontSize: 14 },
  scanBtn:      { backgroundColor: "#1e3a5f", paddingHorizontal: 14, paddingVertical: 6, borderRadius: 8 },
  scanBtnActive:{ backgroundColor: "#1a1a2e" },
  scanBtnText:  { color: "#4a9eff", fontSize: 13 },
  manualBlock:  { gap: 8 },
  manualRow:    { flexDirection: "row", gap: 8 },
  input:        { backgroundColor: "#1c1c1c", color: "#fff", borderRadius: 8, paddingHorizontal: 12, paddingVertical: 10, fontSize: 14 },
  addBtn:       { backgroundColor: "#1e3a5f", paddingHorizontal: 16, paddingVertical: 10, borderRadius: 8 },
  addBtnText:   { color: "#4a9eff", fontSize: 14 },
  empty:        { color: "#444", fontSize: 14 },
});
