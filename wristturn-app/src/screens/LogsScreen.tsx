import React, { useEffect, useRef, useState } from "react";
import {
  View, Text, FlatList, TouchableOpacity, StyleSheet, Alert, ScrollView,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useKeepAwake } from "expo-keep-awake";
import { DebugLog, type SessionState, type SessionInfo, type OrphanInfo } from "../debug/DebugLog";

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

function formatDate(epochMs: number): string {
  if (!epochMs) return "";
  const d = new Date(epochMs);
  return d.toLocaleString();
}

export function LogsScreen() {
  // Hold the screen awake while watching live logs — user is gesturing at
  // the wrist device, not touching the phone.
  useKeepAwake();
  const [lines, setLines] = useState<string[]>([]);
  const [session, setSession] = useState<SessionState>({
    recording: false, sessionId: null, partsFlushed: 0, pendingFlushes: 0, bufferedLines: 0,
  });
  const [sessions, setSessions] = useState<SessionInfo[]>([]);
  const [orphans,  setOrphans]  = useState<OrphanInfo[]>([]);
  const listRef = useRef<FlatList>(null);
  const insets  = useSafeAreaInsets();

  useEffect(() => DebugLog.subscribe(setLines), []);
  useEffect(() => DebugLog.subscribeSession(setSession), []);

  // Refresh sessions/orphans on mount and whenever recording state flips
  // (started → list is dirty; stopped → new merged file exists).
  useEffect(() => {
    refreshLists();
  }, [session.recording]);

  function refreshLists() {
    DebugLog.listSessions().then(setSessions).catch((e) => console.error(e));
    DebugLog.listOrphans().then(setOrphans).catch((e) => console.error(e));
  }

  useEffect(() => {
    if (lines.length > 0)
      listRef.current?.scrollToEnd({ animated: false });
  }, [lines]);

  const onShareBuffer = () => {
    DebugLog.share().catch((e) =>
      Alert.alert("Export failed", e?.message ?? String(e))
    );
  };

  const onToggleRecording = () => {
    if (session.recording) {
      DebugLog.stopSession()
        .then(() => refreshLists())
        .catch((e) => Alert.alert("Stop failed", e?.message ?? String(e)));
    } else {
      DebugLog.startSession()
        .catch((e) => Alert.alert("Start failed", e?.message ?? String(e)));
    }
  };

  const onShareSession = (id: string) => {
    DebugLog.shareSession(id).catch((e) =>
      Alert.alert("Share failed", e?.message ?? String(e))
    );
  };

  const onDeleteSession = (id: string) => {
    Alert.alert("Delete session?", id, [
      { text: "Cancel", style: "cancel" },
      {
        text: "Delete", style: "destructive",
        onPress: () =>
          DebugLog.deleteSession(id)
            .then(() => refreshLists())
            .catch((e) => Alert.alert("Delete failed", e?.message ?? String(e))),
      },
    ]);
  };

  const onRecoverOrphan = (id: string) => {
    DebugLog.recoverOrphan(id)
      .then(() => refreshLists())
      .catch((e) => Alert.alert("Recover failed", e?.message ?? String(e)));
  };

  const onDeleteOrphan = (id: string) => {
    Alert.alert("Delete orphan?", `${id} (parts will be lost)`, [
      { text: "Cancel", style: "cancel" },
      {
        text: "Delete", style: "destructive",
        onPress: () =>
          DebugLog.deleteOrphan(id)
            .then(() => refreshLists())
            .catch((e) => Alert.alert("Delete failed", e?.message ?? String(e))),
      },
    ]);
  };

  return (
    <View style={[s.container, { paddingTop: insets.top + 12 }]}>
      <View style={s.header}>
        <Text style={s.title}>Logs</Text>
        <View style={s.headerActions}>
          <TouchableOpacity
            style={[s.recBtn, session.recording && s.recBtnActive]}
            onPress={onToggleRecording}
          >
            <Text style={[s.recBtnText, session.recording && s.recBtnTextActive]}>
              {session.recording ? "Stop" : "Start"}
            </Text>
          </TouchableOpacity>
          <TouchableOpacity style={s.exportBtn} onPress={onShareBuffer} disabled={lines.length === 0}>
            <Text style={[s.exportBtnText, lines.length === 0 && s.btnDisabled]}>Share buffer</Text>
          </TouchableOpacity>
          <TouchableOpacity style={s.clearBtn} onPress={DebugLog.clear}>
            <Text style={s.clearBtnText}>Clear</Text>
          </TouchableOpacity>
        </View>
      </View>

      {session.recording && (
        <Text style={s.recStatus}>
          ● Recording {session.sessionId}  ·  parts: {session.partsFlushed}
          {session.pendingFlushes > 0 ? ` (+${session.pendingFlushes} flushing)` : ""}
          {session.bufferedLines > 0 ? `  ·  buffered: ${session.bufferedLines}` : ""}
        </Text>
      )}

      {/* Live tail */}
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

      {/* Sessions + orphans below the live tail. ScrollView so both lists
          can grow without competing with the FlatList for vertical space. */}
      <ScrollView style={s.archive} contentContainerStyle={{ paddingBottom: 32 }}>
        {sessions.length > 0 && (
          <>
            <Text style={s.archiveTitle}>Sessions ({sessions.length})</Text>
            {sessions.map((info) => (
              <View key={info.id} style={s.row}>
                <View style={{ flex: 1 }}>
                  <Text style={s.rowTitle} numberOfLines={1}>{info.id}</Text>
                  <Text style={s.rowSub}>
                    {formatBytes(info.sizeBytes)} · {formatDate(info.modifiedAt)}
                  </Text>
                </View>
                <TouchableOpacity style={s.rowAction} onPress={() => onShareSession(info.id)}>
                  <Text style={s.rowActionText}>Share</Text>
                </TouchableOpacity>
                <TouchableOpacity style={s.rowAction} onPress={() => onDeleteSession(info.id)}>
                  <Text style={s.rowActionDestructive}>Delete</Text>
                </TouchableOpacity>
              </View>
            ))}
          </>
        )}

        {orphans.length > 0 && (
          <>
            <Text style={[s.archiveTitle, { marginTop: 18 }]}>
              Orphans ({orphans.length}) — recover or delete
            </Text>
            {orphans.map((info) => (
              <View key={info.id} style={s.row}>
                <View style={{ flex: 1 }}>
                  <Text style={s.rowTitle} numberOfLines={1}>{info.id}</Text>
                  <Text style={s.rowSub}>
                    {info.partCount} part{info.partCount === 1 ? "" : "s"}
                  </Text>
                </View>
                <TouchableOpacity style={s.rowAction} onPress={() => onRecoverOrphan(info.id)}>
                  <Text style={s.rowActionText}>Recover</Text>
                </TouchableOpacity>
                <TouchableOpacity style={s.rowAction} onPress={() => onDeleteOrphan(info.id)}>
                  <Text style={s.rowActionDestructive}>Delete</Text>
                </TouchableOpacity>
              </View>
            ))}
          </>
        )}
      </ScrollView>
    </View>
  );
}

const s = StyleSheet.create({
  container:     { flex: 1, backgroundColor: "#0f0f0f", padding: 16 },
  header:        { flexDirection: "row", justifyContent: "space-between", alignItems: "center", marginBottom: 12 },
  title:         { fontSize: 18, color: "#fff", fontWeight: "600" },
  headerActions: { flexDirection: "row", gap: 8 },
  recBtn:        { backgroundColor: "#1c1c1c", paddingHorizontal: 12, paddingVertical: 6, borderRadius: 8 },
  recBtnActive:  { backgroundColor: "#3a1212" },
  recBtnText:    { color: "#4a9eff", fontSize: 13, fontWeight: "600" },
  recBtnTextActive: { color: "#ff6b6b" },
  recStatus:     { color: "#ff6b6b", fontSize: 12, marginBottom: 8 },
  exportBtn:     { backgroundColor: "#1c1c1c", paddingHorizontal: 12, paddingVertical: 6, borderRadius: 8 },
  exportBtnText: { color: "#4a9eff", fontSize: 13 },
  clearBtn:      { backgroundColor: "#1c1c1c", paddingHorizontal: 12, paddingVertical: 6, borderRadius: 8 },
  clearBtnText:  { color: "#ff6b6b", fontSize: 13 },
  btnDisabled:   { opacity: 0.35 },
  list:          { flex: 1 },
  line:          { fontSize: 11, color: "#4a9eff", fontFamily: "monospace", lineHeight: 18 },
  empty:         { color: "#444", fontSize: 13, marginTop: 20, textAlign: "center" },
  archive:       { maxHeight: 240, marginTop: 12, borderTopWidth: 1, borderTopColor: "#1c1c1c", paddingTop: 8 },
  archiveTitle:  { color: "#888", fontSize: 12, fontWeight: "600", marginBottom: 6 },
  row:           { flexDirection: "row", alignItems: "center", paddingVertical: 6, gap: 8 },
  rowTitle:      { color: "#ddd", fontSize: 12 },
  rowSub:        { color: "#666", fontSize: 11, marginTop: 2 },
  rowAction:     { paddingHorizontal: 10, paddingVertical: 4, backgroundColor: "#1c1c1c", borderRadius: 6 },
  rowActionText: { color: "#4a9eff", fontSize: 12 },
  rowActionDestructive: { color: "#ff6b6b", fontSize: 12 },
});
