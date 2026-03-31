import React, { useEffect, useRef, useState } from "react";
import {
  View, Text, FlatList, TouchableOpacity, StyleSheet,
} from "react-native";
import type { StackScreenProps } from "@react-navigation/stack";
import type { RootStackParams } from "../navigation/AppNavigator";
import { useBLE } from "../ble/useBLE";
import { registry } from "../devices/registry/DeviceRegistry";
import { AndroidTV } from "../../modules/androidtv";
import type { DeviceMetadata } from "../types";

type Props = StackScreenProps<RootStackParams, "Discovery">;

export function DiscoveryScreen({ navigation }: Props) {
  const { connected, wristName, lastGesture } = useBLE();
  const [devices, setDevices] = useState<DeviceMetadata[]>([]);
  const connectingRef = useRef(false);

  useEffect(() => {
    registry.load().then(() => setDevices(registry.all()));
    const unsub = navigation.addListener("focus", () => {
      setDevices(registry.all());
    });
    return unsub;
  }, [navigation]);

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

  return (
    <View style={s.container}>
      {/* Header row with settings button */}
      <View style={s.headerRow}>
        <Text style={s.heading}>WristTurn</Text>
        <TouchableOpacity style={s.settingsBtn} onPress={() => navigation.navigate("Settings")}>
          <Text style={s.settingsBtnText}>⚙</Text>
        </TouchableOpacity>
      </View>

      {/* Wrist device status */}
      <View style={s.section}>
        <Text style={s.label}>Wrist Device</Text>
        <View style={[s.pill, connected ? s.pillOn : s.pillOff]}>
          <Text style={s.pillText}>{connected ? (wristName || "Connected") : "Scanning..."}</Text>
        </View>
        {lastGesture ? <Text style={s.gesture}>{lastGesture}</Text> : null}
      </View>

      {/* Saved devices */}
      <View style={s.section}>
        <Text style={s.label}>Devices</Text>
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
          ListEmptyComponent={
            <Text style={s.empty}>No devices — tap ⚙ to add one</Text>
          }
        />
      </View>
    </View>
  );
}

const s = StyleSheet.create({
  container:      { flex: 1, backgroundColor: "#0f0f0f", padding: 16 },
  headerRow:      { flexDirection: "row", justifyContent: "space-between", alignItems: "center", marginBottom: 24 },
  heading:        { fontSize: 24, color: "#fff", fontWeight: "700" },
  settingsBtn:    { backgroundColor: "#1c1c1c", width: 38, height: 38, borderRadius: 10, justifyContent: "center", alignItems: "center" },
  settingsBtnText:{ color: "#aaa", fontSize: 20 },
  section:        { marginBottom: 24 },
  label:          { fontSize: 11, color: "#666", textTransform: "uppercase", letterSpacing: 1, marginBottom: 8 },
  pill:           { alignSelf: "flex-start", paddingHorizontal: 10, paddingVertical: 3, borderRadius: 10, marginBottom: 6 },
  pillOn:         { backgroundColor: "#1a7f4b" },
  pillOff:        { backgroundColor: "#333" },
  pillText:       { color: "#fff", fontSize: 12 },
  gesture:        { fontSize: 20, color: "#fff" },
  row:            { flexDirection: "row", justifyContent: "space-between", alignItems: "center", backgroundColor: "#1c1c1c", borderRadius: 10, padding: 14, marginBottom: 8 },
  rowName:        { fontSize: 16, color: "#fff" },
  rowSub:         { fontSize: 12, color: "#666", marginTop: 2 },
  mapBtn:         { backgroundColor: "#1e3a5f", paddingHorizontal: 12, paddingVertical: 6, borderRadius: 8 },
  mapBtnText:     { color: "#4a9eff", fontSize: 13 },
  empty:          { color: "#444", fontSize: 14 },
});
