import React, { useEffect, useRef, useState } from "react";
import {
  View, Text, FlatList, TouchableOpacity, StyleSheet, Alert,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useKeepAwake } from "expo-keep-awake";
import { DebugLog } from "../debug/DebugLog";

export function LogsScreen() {
  // Hold the screen awake while watching live logs — user is gesturing at
  // the wrist device, not touching the phone.
  useKeepAwake();
  const [lines, setLines] = useState<string[]>([]);
  const listRef = useRef<FlatList>(null);
  const insets  = useSafeAreaInsets();

  useEffect(() => { return DebugLog.subscribe(setLines); }, []);

  useEffect(() => {
    if (lines.length > 0)
      listRef.current?.scrollToEnd({ animated: false });
  }, [lines]);

  const onExport = () => {
    DebugLog.share().catch((e) =>
      Alert.alert("Export failed", e?.message ?? String(e))
    );
  };

  return (
    <View style={[s.container, { paddingTop: insets.top + 12 }]}>
      <View style={s.header}>
        <Text style={s.title}>Logs</Text>
        <View style={s.headerActions}>
          <TouchableOpacity style={s.exportBtn} onPress={onExport} disabled={lines.length === 0}>
            <Text style={[s.exportBtnText, lines.length === 0 && s.btnDisabled]}>Export</Text>
          </TouchableOpacity>
          <TouchableOpacity style={s.clearBtn} onPress={DebugLog.clear}>
            <Text style={s.clearBtnText}>Clear</Text>
          </TouchableOpacity>
        </View>
      </View>
      {lines.length === 0 ? (
        <Text style={s.empty}>No logs yet</Text>
      ) : (
        <FlatList
          ref={listRef}
          data={lines}
          keyExtractor={(_, i) => String(i)}
          renderItem={({ item }) => <Text style={s.line}>{item}</Text>}
          style={s.list}
          contentContainerStyle={{ paddingBottom: 16 }}
        />
      )}
    </View>
  );
}

const s = StyleSheet.create({
  container:     { flex: 1, backgroundColor: "#0f0f0f", padding: 16 },
  header:        { flexDirection: "row", justifyContent: "space-between", alignItems: "center", marginBottom: 12 },
  title:         { fontSize: 18, color: "#fff", fontWeight: "600" },
  headerActions: { flexDirection: "row", gap: 8 },
  exportBtn:     { backgroundColor: "#1c1c1c", paddingHorizontal: 12, paddingVertical: 6, borderRadius: 8 },
  exportBtnText: { color: "#4a9eff", fontSize: 13 },
  clearBtn:      { backgroundColor: "#1c1c1c", paddingHorizontal: 12, paddingVertical: 6, borderRadius: 8 },
  clearBtnText:  { color: "#ff6b6b", fontSize: 13 },
  btnDisabled:   { opacity: 0.35 },
  list:          { flex: 1 },
  line:          { fontSize: 11, color: "#4a9eff", fontFamily: "monospace", lineHeight: 18 },
  empty:         { color: "#444", fontSize: 13, marginTop: 20, textAlign: "center" },
});
