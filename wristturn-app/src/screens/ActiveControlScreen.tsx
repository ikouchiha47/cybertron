import React, { useEffect, useRef, useState } from "react";
import {
  View, Text, TouchableOpacity, StyleSheet, Animated,
} from "react-native";
import type { StackScreenProps } from "@react-navigation/stack";
import type { RootStackParams } from "../navigation/AppNavigator";
import { useBLE } from "../ble/useBLE";
import { registry } from "../devices/registry/DeviceRegistry";
import { MappingStore } from "../mapping/MappingStore";
import type { ComboMap } from "../types";

type Props = StackScreenProps<RootStackParams, "ActiveControl">;

export function ActiveControlScreen({ route, navigation }: Props) {
  const { deviceId }  = route.params;
  const meta          = registry.get(deviceId);
  const proxy         = registry.getProxy(deviceId);
  const [map, setMap] = useState<ComboMap>({});
  const [lastCmd, setLastCmd] = useState("");

  const opacity = useRef(new Animated.Value(0)).current;
  const scale   = useRef(new Animated.Value(0.8)).current;

  useEffect(() => {
    if (!meta) return;
    MappingStore.get(deviceId, meta.transport).then(setMap);
    proxy?.connect().catch(console.error);
    return () => { proxy?.disconnect(); };
  }, [deviceId]);

  function animateGesture() {
    Animated.sequence([
      Animated.parallel([
        Animated.spring(scale,   { toValue: 1,   useNativeDriver: true }),
        Animated.timing(opacity, { toValue: 1, duration: 100, useNativeDriver: true }),
      ]),
      Animated.delay(1200),
      Animated.timing(opacity, { toValue: 0, duration: 400, useNativeDriver: true }),
    ]).start();
  }

  const { connected, lastGesture, lastCombo } = useBLE({
    onCombo: async (combo) => {
      animateGesture();
      const commandId = map[combo];
      if (!commandId || !proxy || !meta) return;
      const cmd = meta.availableCommands.find((c) => c.id === commandId);
      if (!cmd) return;
      setLastCmd(cmd.label);
      await proxy.sendCommand(cmd);
    },
  });

  if (!meta) return <View style={s.container}><Text style={s.empty}>Device not found</Text></View>;

  return (
    <View style={s.container}>
      {/* Header */}
      <View style={s.header}>
        <Text style={s.deviceName}>{meta.name}</Text>
        <View style={[s.pill, proxy?.isConnected() ? s.pillOn : s.pillOff]}>
          <Text style={s.pillText}>{proxy?.isConnected() ? "Ready" : "Connecting..."}</Text>
        </View>
      </View>

      {/* Gesture display */}
      <View style={s.gestureArea}>
        <Animated.View style={{ opacity, transform: [{ scale }] }}>
          <Text style={s.gestureText}>{lastGesture}</Text>
          {lastCombo !== lastGesture && (
            <Text style={s.comboText}>{lastCombo.replace(/,/g, " → ")}</Text>
          )}
        </Animated.View>
        {lastCmd ? <Text style={s.cmdText}>{lastCmd}</Text> : null}
      </View>

      {/* Wrist BLE status */}
      <View style={[s.pill, connected ? s.pillOn : s.pillOff, s.wristPill]}>
        <Text style={s.pillText}>{connected ? "Wrist connected" : "Wrist scanning..."}</Text>
      </View>

      {/* Remap button */}
      <TouchableOpacity
        style={s.remapBtn}
        onPress={() => navigation.navigate("GestureMapping", { deviceId })}
      >
        <Text style={s.remapBtnText}>Remap Gestures</Text>
      </TouchableOpacity>
    </View>
  );
}

const s = StyleSheet.create({
  container:   { flex: 1, backgroundColor: "#0f0f0f", padding: 20 },
  header:      { flexDirection: "row", justifyContent: "space-between", alignItems: "center", marginBottom: 40 },
  deviceName:  { fontSize: 22, color: "#fff", fontWeight: "600" },
  pill:        { paddingHorizontal: 10, paddingVertical: 3, borderRadius: 10 },
  pillOn:      { backgroundColor: "#1a7f4b" },
  pillOff:     { backgroundColor: "#333" },
  pillText:    { color: "#fff", fontSize: 12 },
  gestureArea: { flex: 1, justifyContent: "center", alignItems: "center" },
  gestureText: { fontSize: 48, color: "#fff", fontWeight: "700", textAlign: "center" },
  comboText:   { fontSize: 18, color: "#888", textAlign: "center", marginTop: 8 },
  cmdText:     { fontSize: 14, color: "#4a9eff", marginTop: 24 },
  wristPill:   { alignSelf: "center", marginBottom: 16 },
  remapBtn:    { backgroundColor: "#1c1c1c", borderRadius: 10, padding: 14, alignItems: "center" },
  remapBtnText:{ color: "#888", fontSize: 15 },
  empty:       { color: "#555" },
});
