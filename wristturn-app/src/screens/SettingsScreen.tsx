import React, { useEffect, useRef, useState } from "react";
import {
  View, Text, FlatList, TouchableOpacity, Pressable, TextInput,
  StyleSheet, Alert, ActivityIndicator,
} from "react-native";
import type { CompositeScreenProps } from "@react-navigation/native";
import type { StackScreenProps } from "@react-navigation/stack";
import type { BottomTabScreenProps } from "@react-navigation/bottom-tabs";
import type { TabParams, RootStackParams } from "../navigation/AppNavigator";
import { registry } from "../devices/registry/DeviceRegistry";
import { useMDNSDiscovery } from "../discovery/useMDNSDiscovery";
import { AndroidTV } from "../../modules/androidtv";
import { ANDROIDTV_COMMANDS } from "../devices/adapters/AndroidTVAdapter";
import { WIZ_COMMANDS } from "../devices/adapters/WizAdapter";
import { discoverWizDevices, WIZ_PORT } from "../devices/adapters/wizUdp";
import { DEFAULT_PORT } from "../types";
import type { DeviceMetadata, TransportType } from "../types";

type Props = CompositeScreenProps<
  BottomTabScreenProps<TabParams, "Settings">,
  StackScreenProps<RootStackParams>
>;

export function SettingsScreen({ navigation }: Props) {
  const { devices: discovered, scanning, rescan } = useMDNSDiscovery();
  const [saved, setSaved] = useState<DeviceMetadata[]>([]);
  const [showAddForm, setShowAddForm] = useState(false);
  const [wizScanning, setWizScanning] = useState(false);
  const [manualHost, setManualHost] = useState("");
  const [manualPort, setManualPort] = useState(String(DEFAULT_PORT.androidtv));
  const [manualName, setManualName] = useState("");
  const [manualTransport, setManualTransport] = useState<TransportType>("androidtv");

  // inline edit state
  const [editingId, setEditingId]         = useState<string | null>(null);
  const [editName, setEditName]           = useState("");
  const [editHost, setEditHost]           = useState("");
  const [editPort, setEditPort]           = useState("");
  const [editTransport, setEditTransport] = useState<TransportType>("androidtv");

  function pickTransport(t: TransportType) {
    setManualTransport(t);
    setManualPort(String(DEFAULT_PORT[t]));
  }

  function startEdit(item: DeviceMetadata) {
    setEditingId(item.id);
    setEditName(item.name);
    setEditHost(item.host);
    setEditPort(String(item.port));
    setEditTransport(item.transport);
  }

  async function commitEdit(id: string) {
    const meta = registry.get(id);
    if (!meta) { setEditingId(null); return; }
    const port = parseInt(editPort, 10) || DEFAULT_PORT[editTransport];
    const newId = `manual:${editHost.trim()}:${port}`;
    await registry.remove(id);
    await registry.register({
      ...meta,
      id: newId,
      name: editName.trim() || editHost.trim(),
      host: editHost.trim(),
      port,
      transport: editTransport,
    });
    setSaved(registry.all());
    setEditingId(null);
  }
  const connectingRef = useRef(false);

  // Load persisted devices
  useEffect(() => {
    registry.load().then(() => setSaved(registry.all()));
  }, []);


  async function addDiscovered(d: import("../types").DiscoveredDevice) {
    const commands = d.transport === "androidtv" ? ANDROIDTV_COMMANDS
                   : d.transport === "macdaemon" ? (await import("../devices/adapters/MacDaemonAdapter")).MACDAEMON_COMMANDS
                   : [];
    await registry.register({ id: d.id, name: d.name, host: d.host, port: d.port, transport: d.transport, availableCommands: commands });
    setSaved(registry.all());
  }

  async function addManual() {
    if (!manualHost.trim()) return;
    const host = manualHost.trim();
    const port = parseInt(manualPort, 10) || DEFAULT_PORT[manualTransport];
    const id = `manual:${host}:${port}`;
    const name = manualName.trim() || host;
    const commands = manualTransport === "androidtv" ? ANDROIDTV_COMMANDS : [];
    await registry.register({ id, name, host, port, transport: manualTransport, availableCommands: commands });
    setManualHost("");
    setManualName("");
    setSaved(registry.all());
  }

  async function scanForWizBulbs() {
    setWizScanning(true);
    try {
      const found = await discoverWizDevices(5000);
      for (const { ip } of found) {
        const id = `wiz:${ip}`;
        if (!registry.get(id)) {
          await registry.register({
            id, name: `WiZ Bulb (${ip})`, host: ip, port: WIZ_PORT,
            transport: "wiz", availableCommands: WIZ_COMMANDS,
          });
        }
      }
      setSaved(registry.all());
    } finally {
      setWizScanning(false);
    }
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
        {/* collapsed row */}
        <View style={s.rowHeader}>
          {isEditing ? (
            <TextInput
              style={[s.input, { flex: 1, marginRight: 8 }]}
              value={editName}
              onChangeText={setEditName}
              autoFocus
              returnKeyType="done"
              onSubmitEditing={() => commitEdit(item.id)}
            />
          ) : (
            <TouchableOpacity style={{ flex: 1 }} onPress={() => openDevice(item)}>
              <Text style={s.rowName}>{item.name}</Text>
              <Text style={s.rowSub}>{item.host}:{item.port}  ·  {item.transport}</Text>
            </TouchableOpacity>
          )}
          {item.transport === "androidtv" && !isEditing && (
            <Pressable style={({ pressed }) => [s.iconBtn, pressed && s.iconBtnPressed]} onPress={() => navigation.navigate("Pairing", { deviceId: item.id })}>
              <Text style={s.iconBtnText}>⇆</Text>
            </Pressable>
          )}
          <Pressable style={({ pressed }) => [s.iconBtn, pressed && s.iconBtnPressed]} onPress={() => isEditing ? setEditingId(null) : startEdit(item)}>
            <Text style={s.iconBtnText}>{isEditing ? "✕" : "✎"}</Text>
          </Pressable>
          <Pressable style={({ pressed }) => [s.iconBtn, s.iconBtnDanger, pressed && s.iconBtnDangerPressed]} onPress={() => removeDevice(item.id)}>
            <Text style={[s.iconBtnText, { color: "#ff6b6b" }]}>🗑</Text>
          </Pressable>
        </View>

        {/* expanded edit panel — host/port/transport only */}
        {isEditing && (
          <View style={s.editPanel}>
            <View style={s.manualRow}>
              <TextInput style={[s.input, { flex: 1 }]} value={editHost} onChangeText={setEditHost} placeholder="host / IP" placeholderTextColor="#555" autoCapitalize="none" keyboardType="url" />
              <TextInput style={[s.input, { width: 70 }]} value={editPort} onChangeText={setEditPort} placeholder="port" placeholderTextColor="#555" keyboardType="number-pad" />
            </View>
            <View style={s.segmented}>
              {(["androidtv", "macdaemon", "http"] as const).map((t) => (
                <TouchableOpacity key={t} style={[s.seg, editTransport === t && s.segActive]} onPress={() => { setEditTransport(t); setEditPort(String(DEFAULT_PORT[t])); }}>
                  <Text style={[s.segText, editTransport === t && s.segTextActive]}>{t}</Text>
                </TouchableOpacity>
              ))}
            </View>
            <TouchableOpacity style={s.addBtn} onPress={() => commitEdit(item.id)}>
              <Text style={s.addBtnText}>Save</Text>
            </TouchableOpacity>
          </View>
        )}
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

      {/* Discovered devices */}
      {discovered.length > 0 && discovered.filter((d) => !saved.find((s) => s.host === d.host && s.port === d.port)).map((d) => (
        <View key={d.id} style={s.row}>
          <View style={s.rowHeader}>
            <View style={{ flex: 1 }}>
              <Text style={s.rowName}>{d.name}</Text>
              <Text style={s.rowSub}>{d.host}:{d.port}  ·  {d.transport}</Text>
            </View>
            <Pressable style={({ pressed }) => [s.iconBtn, pressed && s.iconBtnPressed]} onPress={() => addDiscovered(d)}>
              <Text style={s.iconBtnText}>+</Text>
            </Pressable>
          </View>
        </View>
      ))}

      {/* WiZ bulb discovery */}
      <View style={s.sectionRow}>
        <Text style={s.label}>Smart Bulbs (WiZ)</Text>
        <TouchableOpacity
          style={[s.scanBtn, wizScanning && s.scanBtnActive]}
          onPress={wizScanning ? undefined : scanForWizBulbs}
          disabled={wizScanning}
        >
          {wizScanning
            ? <ActivityIndicator color="#4a9eff" size="small" />
            : <Text style={s.scanBtnText}>Scan</Text>}
        </TouchableOpacity>
      </View>
      <TouchableOpacity style={s.addToggle} onPress={() => navigation.navigate("WizProvision")}>
        <Text style={s.addToggleText}>+  Add New Bulb (setup)</Text>
      </TouchableOpacity>

      {/* Manual add — collapsible */}
      <TouchableOpacity style={s.addToggle} onPress={() => setShowAddForm((v) => !v)}>
        <Text style={s.addToggleText}>+  Add Device (manual)</Text>
      </TouchableOpacity>
      {showAddForm && (
        <View style={s.manualBlock}>
          <TextInput style={s.input} placeholder="Name (optional)" placeholderTextColor="#555" value={manualName} onChangeText={setManualName} />
          <View style={s.segmented}>
            {(["androidtv", "macdaemon", "http"] as const).map((t) => (
              <TouchableOpacity key={t} style={[s.seg, manualTransport === t && s.segActive]} onPress={() => pickTransport(t)}>
                <Text style={[s.segText, manualTransport === t && s.segTextActive]}>{t}</Text>
              </TouchableOpacity>
            ))}
          </View>
          <View style={s.manualRow}>
            <TextInput style={[s.input, { flex: 1 }]} placeholder="host / IP" placeholderTextColor="#555" value={manualHost} onChangeText={setManualHost} autoCapitalize="none" keyboardType="url" />
            <TextInput style={[s.input, { width: 70 }]} placeholder="port" placeholderTextColor="#555" value={manualPort} onChangeText={setManualPort} keyboardType="number-pad" />
          </View>
          <TouchableOpacity style={s.addBtn} onPress={addManual}>
            <Text style={s.addBtnText}>Add</Text>
          </TouchableOpacity>
        </View>
      )}
    </View>
  );
}

const s = StyleSheet.create({
  container:    { flex: 1, backgroundColor: "#0f0f0f", padding: 16 },
  label:        { fontSize: 11, color: "#666", textTransform: "uppercase", letterSpacing: 1, marginBottom: 8, marginTop: 16 },
  list:         { maxHeight: 340 },
  sectionRow:   { flexDirection: "row", justifyContent: "space-between", alignItems: "center" },
  row:          { backgroundColor: "#1c1c1c", borderRadius: 10, marginBottom: 8, overflow: "hidden" },
  rowHeader:    { flexDirection: "row", alignItems: "center", padding: 14 },
  rowName:      { fontSize: 15, color: "#fff" },
  rowSub:       { fontSize: 11, color: "#555", marginTop: 2 },
  editPanel:    { padding: 12, paddingTop: 0, gap: 8, borderTopWidth: 1, borderTopColor: "#2a2a2a" },
  rowActions:   { flexDirection: "row", gap: 8 },
  iconBtn:            { width: 32, height: 32, borderRadius: 8, borderWidth: 1, borderColor: "#1e3a5f", justifyContent: "center", alignItems: "center", marginLeft: 8 },
  iconBtnPressed:     { backgroundColor: "#1e3a5f" },
  iconBtnDanger:      { borderColor: "#5f1e1e" },
  iconBtnDangerPressed:{ backgroundColor: "#5f1e1e" },
  iconBtnText:        { color: "#4a9eff", fontSize: 14 },
  scanBtn:      { backgroundColor: "#1e3a5f", paddingHorizontal: 14, paddingVertical: 6, borderRadius: 8 },
  scanBtnActive:{ backgroundColor: "#1a1a2e" },
  scanBtnText:  { color: "#4a9eff", fontSize: 13 },
  manualBlock:  { gap: 8 },
  manualRow:    { flexDirection: "row", gap: 8 },
  input:        { backgroundColor: "#1c1c1c", color: "#fff", borderRadius: 8, paddingHorizontal: 12, paddingVertical: 10, fontSize: 14 },
  addToggle:     { paddingVertical: 10, marginTop: 8 },
  addToggleText: { color: "#4a9eff", fontSize: 14 },
  addBtn:        { backgroundColor: "#1e3a5f", paddingHorizontal: 16, paddingVertical: 10, borderRadius: 8, alignItems: "center" },
  addBtnText:    { color: "#4a9eff", fontSize: 14 },
  segmented:    { flexDirection: "row", backgroundColor: "#1c1c1c", borderRadius: 8 },
  seg:          { flex: 1, paddingVertical: 8, alignItems: "center", borderRadius: 8 },
  segActive:    { backgroundColor: "#1e3a5f" },
  segText:      { color: "#555", fontSize: 12 },
  segTextActive:{ color: "#4a9eff", fontSize: 12 },
  empty:        { color: "#444", fontSize: 14 },
});
