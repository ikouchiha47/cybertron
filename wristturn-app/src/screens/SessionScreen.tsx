import React, { useEffect, useState, useCallback } from "react";
import {
  View, Text, TouchableOpacity, FlatList, StyleSheet, Alert,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import MCI from "react-native-vector-icons/MaterialCommunityIcons";
import { SessionRecorder } from "../debug/SessionRecorder";

export function SessionScreen() {
  const insets = useSafeAreaInsets();
  const [recording, setRecording] = useState(SessionRecorder.isActive());
  const [recCount, setRecCount]   = useState(SessionRecorder.eventCount());
  const [files, setFiles]         = useState<string[]>([]);

  const refreshFiles = useCallback(async () => {
    const list = await SessionRecorder.listSessions();
    setFiles(list);
  }, []);

  useEffect(() => {
    const unsub = SessionRecorder.subscribe((active, n) => {
      setRecording(active);
      setRecCount(n);
      if (!active) refreshFiles();  // refresh list when a session finishes
    });
    refreshFiles();
    return unsub;
  }, [refreshFiles]);

  const onShare = (name: string) => {
    SessionRecorder.shareSession(name).catch((e) =>
      Alert.alert("Share failed", e?.message ?? String(e))
    );
  };

  const onDelete = (name: string) => {
    Alert.alert("Delete session?", name, [
      { text: "Cancel", style: "cancel" },
      {
        text: "Delete", style: "destructive",
        onPress: async () => {
          await SessionRecorder.deleteSession(name);
          refreshFiles();
        },
      },
    ]);
  };

  return (
    <View style={[s.container, { paddingTop: insets.top + 12 }]}>
      <View style={s.titleRow}>
        <Text style={s.title}>Sessions</Text>
        {recording && (
          <View style={s.recPill}>
            <View style={s.recDot} />
            <Text style={s.recText}>{recCount} events</Text>
          </View>
        )}
      </View>

      <Text style={s.hint}>
        Start recording from the{" "}
        <Text style={s.hintBold}>● REC</Text> button inside a device screen.
      </Text>

      <Text style={s.sectionLabel}>Saved sessions</Text>
      {files.length === 0 ? (
        <Text style={s.empty}>No sessions yet</Text>
      ) : (
        <FlatList
          data={files}
          keyExtractor={(n) => n}
          renderItem={({ item }) => (
            <View style={s.fileRow}>
              <Text style={s.fileName} numberOfLines={1}>{item}</Text>
              <TouchableOpacity style={s.fileBtn} onPress={() => onShare(item)}>
                <MCI name="share-variant" size={18} color="#4a9eff" />
              </TouchableOpacity>
              <TouchableOpacity style={s.fileBtn} onPress={() => onDelete(item)}>
                <MCI name="trash-can-outline" size={18} color="#ff6b6b" />
              </TouchableOpacity>
            </View>
          )}
        />
      )}
    </View>
  );
}

const s = StyleSheet.create({
  container:    { flex: 1, backgroundColor: "#0f0f0f", padding: 16 },
  titleRow:     { flexDirection: "row", alignItems: "center", justifyContent: "space-between", marginBottom: 8 },
  title:        { fontSize: 18, color: "#fff", fontWeight: "600" },
  recPill:      { flexDirection: "row", alignItems: "center", gap: 6, backgroundColor: "#2a0f0f", paddingHorizontal: 10, paddingVertical: 4, borderRadius: 20 },
  recDot:       { width: 7, height: 7, borderRadius: 4, backgroundColor: "#ff4444" },
  recText:      { color: "#ff8888", fontSize: 11, fontFamily: "monospace" },
  hint:         { color: "#444", fontSize: 12, marginBottom: 16, lineHeight: 18 },
  hintBold:     { color: "#666" },
  sectionLabel: { color: "#555", fontSize: 11, textTransform: "uppercase", letterSpacing: 1, marginBottom: 8 },
  fileRow:      { flexDirection: "row", alignItems: "center", backgroundColor: "#1c1c1c", padding: 12, borderRadius: 8, marginBottom: 6 },
  fileName:     { flex: 1, color: "#ddd", fontSize: 12, fontFamily: "monospace" },
  fileBtn:      { padding: 8, marginLeft: 4 },
  empty:        { color: "#444", fontSize: 13, textAlign: "center", marginTop: 20 },
});
