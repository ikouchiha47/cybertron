import React, { useEffect, useState } from "react";
import {
  View, Text, FlatList, TouchableOpacity,
  StyleSheet, TextInput,
} from "react-native";
import type { StackScreenProps } from "@react-navigation/stack";
import type { RootStackParams } from "../navigation/AppNavigator";
import { useBLE } from "../ble/useBLE";
import { useMDNSDiscovery } from "../discovery/useMDNSDiscovery";
import { registry } from "../devices/registry/DeviceRegistry";
import type { DiscoveredDevice } from "../types";

type Props = StackScreenProps<RootStackParams, "Discovery">;

export function DiscoveryScreen({ navigation }: Props) {
  const { devices, scanning, rescan } = useMDNSDiscovery();
  const { connected, wristName, lastGesture } = useBLE();
  const [manualHost, setManualHost] = useState("");

  // Auto-register discovered devices into registry
  useEffect(() => {
    devices.forEach((d) => {
      if (!registry.get(d.id)) {
        registry.register({
          id:                d.id,
          name:              d.name,
          host:              d.host,
          port:              d.port,
          transport:         d.transport,
          availableCommands: [],
        });
      }
    });
  }, [devices]);

  function addManual() {
    if (!manualHost.trim()) return;
    const [host, portStr] = manualHost.split(":");
    const port = portStr ? parseInt(portStr, 10) : 80;
    const id   = `manual:${host}:${port}`;
    registry.register({
      id, name: host, host, port,
      transport: "http",
      availableCommands: [],
    });
    setManualHost("");
  }

  function openDevice(device: DiscoveredDevice) {
    if (device.transport === "androidtv") {
      navigation.navigate("Pairing", { deviceId: device.id });
    } else {
      navigation.navigate("ActiveControl", { deviceId: device.id });
    }
  }

  return (
    <View style={s.container}>
      {/* Wrist device status */}
      <View style={s.section}>
        <Text style={s.label}>Wrist Device</Text>
        <View style={[s.pill, connected ? s.pillOn : s.pillOff]}>
          <Text style={s.pillText}>{connected ? (wristName || "Connected") : "Scanning..."}</Text>
        </View>
        {lastGesture ? <Text style={s.gesture}>{lastGesture}</Text> : null}
      </View>

      {/* Network devices */}
      <View style={s.section}>
        <View style={s.labelRow}>
          <Text style={s.label}>Network Devices</Text>
          <TouchableOpacity
            style={[s.scanBtn, scanning && s.scanBtnActive]}
            onPress={scanning ? undefined : rescan}
            disabled={scanning}
          >
            <Text style={s.scanBtnText}>{scanning ? "Scanning…" : "Scan"}</Text>
          </TouchableOpacity>
        </View>
        <FlatList
          data={devices}
          keyExtractor={(d) => d.id}
          renderItem={({ item }) => (
            <TouchableOpacity style={s.row} onPress={() => openDevice(item)}>
              <View>
                <Text style={s.rowName}>{item.name}</Text>
                <Text style={s.rowSub}>{item.host}  {item.transport}</Text>
              </View>
              <TouchableOpacity
                style={s.mapBtn}
                onPress={() => navigation.navigate("GestureMapping", { deviceId: item.id })}
              >
                <Text style={s.mapBtnText}>Map</Text>
              </TouchableOpacity>
            </TouchableOpacity>
          )}
          ListEmptyComponent={<Text style={s.empty}>No devices found yet</Text>}
        />
      </View>

      {/* Manual add */}
      <View style={s.manualRow}>
        <TextInput
          style={s.input}
          placeholder="host:port"
          placeholderTextColor="#555"
          value={manualHost}
          onChangeText={setManualHost}
          autoCapitalize="none"
        />
        <TouchableOpacity style={s.addBtn} onPress={addManual}>
          <Text style={s.addBtnText}>Add</Text>
        </TouchableOpacity>
      </View>
    </View>
  );
}

const s = StyleSheet.create({
  container: { flex: 1, backgroundColor: "#0f0f0f", padding: 16 },
  section:   { marginBottom: 24 },
  label:     { fontSize: 12, color: "#666", textTransform: "uppercase", letterSpacing: 1 },
  pill:      { alignSelf: "flex-start", paddingHorizontal: 10, paddingVertical: 3, borderRadius: 10, marginBottom: 6 },
  pillOn:    { backgroundColor: "#1a7f4b" },
  pillOff:   { backgroundColor: "#333" },
  pillText:  { color: "#fff", fontSize: 12 },
  gesture:   { fontSize: 20, color: "#fff" },
  row:       { flexDirection: "row", justifyContent: "space-between", alignItems: "center", backgroundColor: "#1c1c1c", borderRadius: 10, padding: 14, marginBottom: 8 },
  rowName:   { fontSize: 16, color: "#fff" },
  rowSub:    { fontSize: 12, color: "#666", marginTop: 2 },
  mapBtn:    { backgroundColor: "#1e3a5f", paddingHorizontal: 12, paddingVertical: 6, borderRadius: 8 },
  mapBtnText:{ color: "#4a9eff", fontSize: 13 },
  empty:     { color: "#444", fontSize: 14 },
  labelRow:  { flexDirection: "row", justifyContent: "space-between", alignItems: "center", marginBottom: 8 },
  scanBtn:       { backgroundColor: "#1e3a5f", paddingHorizontal: 14, paddingVertical: 5, borderRadius: 8 },
  scanBtnActive: { backgroundColor: "#1a1a2e" },
  scanBtnText:   { color: "#4a9eff", fontSize: 13 },
  manualRow: { flexDirection: "row", gap: 8, marginTop: "auto" },
  input:     { flex: 1, backgroundColor: "#1c1c1c", color: "#fff", borderRadius: 8, paddingHorizontal: 12, fontSize: 14 },
  addBtn:    { backgroundColor: "#1c1c1c", paddingHorizontal: 16, paddingVertical: 10, borderRadius: 8 },
  addBtnText:{ color: "#fff", fontSize: 14 },
});
