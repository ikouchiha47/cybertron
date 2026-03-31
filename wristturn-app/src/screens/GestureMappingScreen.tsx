import React, { useEffect, useState } from "react";
import {
  View, Text, TouchableOpacity, StyleSheet, ScrollView,
  TextInput, Alert, Modal,
} from "react-native";
import type { StackScreenProps } from "@react-navigation/stack";
import type { RootStackParams } from "../navigation/AppNavigator";
import { registry } from "../devices/registry/DeviceRegistry";
import { MappingStore } from "../mapping/MappingStore";
import type { ComboMap } from "../types";

type Props = StackScreenProps<RootStackParams, "GestureMapping">;

// A command entry can be a known command id, or "deeplink:<url>"
function isDeeplink(commandId: string) {
  return commandId.startsWith("deeplink:");
}
function deeplinkUrl(commandId: string) {
  return commandId.slice("deeplink:".length);
}

export function GestureMappingScreen({ route, navigation }: Props) {
  const { deviceId } = route.params;
  const meta  = registry.get(deviceId);
  const proxy = registry.getProxy(deviceId);

  const [map, setMap]           = useState<ComboMap>({});
  const [editEntry, setEditEntry] = useState<string | null>(null); // combo being edited, or "__new__"
  const [editCombo, setEditCombo] = useState("");
  const [actionType, setActionType] = useState<"command" | "deeplink">("command");
  const [selectedCmd, setSelectedCmd] = useState("");
  const [deeplinkInput, setDeeplinkInput] = useState("");
  const [showCmdPicker, setShowCmdPicker] = useState(false);

  useEffect(() => {
    if (!meta || !proxy) return;
    MappingStore.get(deviceId, proxy.defaultMapping()).then(setMap);
  }, [deviceId]);

  if (!meta) {
    return <View style={s.container}><Text style={s.empty}>Device not found</Text></View>;
  }

  const commands = [{ id: "", label: "(none)" }, ...meta.availableCommands];

  function openEdit(combo: string) {
    const current = map[combo] ?? "";
    setEditEntry(combo);
    setEditCombo(combo);
    if (isDeeplink(current)) {
      setActionType("deeplink");
      setDeeplinkInput(deeplinkUrl(current));
      setSelectedCmd("");
    } else {
      setActionType("command");
      setSelectedCmd(current);
      setDeeplinkInput("");
    }
  }

  function openAdd() {
    setEditEntry("__new__");
    setEditCombo("");
    setActionType("command");
    setSelectedCmd("");
    setDeeplinkInput("");
  }

  function closeEdit() {
    setEditEntry(null);
    setShowCmdPicker(false);
  }

  function commitEdit() {
    const combo = editCombo.trim();
    if (!combo) {
      Alert.alert("Error", "Gesture/combo cannot be empty");
      return;
    }
    const commandId = actionType === "deeplink"
      ? `deeplink:${deeplinkInput.trim()}`
      : selectedCmd;
    if (!commandId) {
      Alert.alert("Error", "Choose an action");
      return;
    }
    setMap((prev) => {
      const next = { ...prev };
      // If editing an existing entry and the combo string changed, remove the old key
      if (editEntry && editEntry !== "__new__" && editEntry !== combo) {
        delete next[editEntry];
      }
      next[combo] = commandId;
      return next;
    });
    closeEdit();
  }

  function deleteEntry(combo: string) {
    Alert.alert("Delete", `Remove mapping for "${combo}"?`, [
      { text: "Cancel", style: "cancel" },
      {
        text: "Delete", style: "destructive",
        onPress: () => setMap((prev) => { const n = { ...prev }; delete n[combo]; return n; }),
      },
    ]);
  }

  async function save() {
    await MappingStore.set(deviceId, map);
    navigation.goBack();
  }

  function actionLabel(commandId: string) {
    if (!commandId) return "(none)";
    if (isDeeplink(commandId)) return `🔗 ${deeplinkUrl(commandId)}`;
    return commands.find((c) => c.id === commandId)?.label ?? commandId;
  }

  const entries = Object.entries(map);

  return (
    <View style={{ flex: 1 }}>
      <ScrollView style={s.container}>
        <Text style={s.deviceName}>{meta.name}</Text>

        {entries.length === 0 && (
          <Text style={s.empty}>No mappings yet. Tap + to add one.</Text>
        )}

        {entries.map(([combo, cmdId]) => (
          <View key={combo} style={s.row}>
            <TouchableOpacity style={s.rowMain} onPress={() => openEdit(combo)}>
              <Text style={s.rowCombo}>{combo.replace(/,/g, " → ")}</Text>
              <Text style={s.rowAction} numberOfLines={1}>{actionLabel(cmdId)}</Text>
            </TouchableOpacity>
            <TouchableOpacity style={s.deleteBtn} onPress={() => deleteEntry(combo)}>
              <Text style={s.deleteBtnText}>✕</Text>
            </TouchableOpacity>
          </View>
        ))}

        <TouchableOpacity style={s.addBtn} onPress={openAdd}>
          <Text style={s.addBtnText}>+ Add Mapping</Text>
        </TouchableOpacity>

        <TouchableOpacity style={s.saveBtn} onPress={save}>
          <Text style={s.saveBtnText}>Save</Text>
        </TouchableOpacity>
      </ScrollView>

      {/* Edit / Add modal */}
      <Modal visible={editEntry !== null} transparent animationType="slide">
        <View style={s.modalOverlay}>
          <View style={s.modalCard}>
            <Text style={s.modalTitle}>
              {editEntry === "__new__" ? "Add Mapping" : "Edit Mapping"}
            </Text>

            <Text style={s.fieldLabel}>Gesture / Combo</Text>
            <TextInput
              style={s.textInput}
              value={editCombo}
              onChangeText={setEditCombo}
              placeholder="e.g. tap,tap or turn_right"
              placeholderTextColor="#555"
              autoCapitalize="none"
              autoCorrect={false}
            />
            <Text style={s.hint}>
              Single gesture: tap, turn_right, pitch_up …{"\n"}
              Combo: tap,tap or turn_right,turn_left
            </Text>

            <Text style={[s.fieldLabel, { marginTop: 16 }]}>Action</Text>
            <View style={s.segmented}>
              <TouchableOpacity
                style={[s.seg, actionType === "command" && s.segActive]}
                onPress={() => setActionType("command")}
              >
                <Text style={[s.segText, actionType === "command" && s.segTextActive]}>
                  Key / Command
                </Text>
              </TouchableOpacity>
              <TouchableOpacity
                style={[s.seg, actionType === "deeplink" && s.segActive]}
                onPress={() => setActionType("deeplink")}
              >
                <Text style={[s.segText, actionType === "deeplink" && s.segTextActive]}>
                  Deep Link
                </Text>
              </TouchableOpacity>
            </View>

            {actionType === "command" ? (
              <>
                <TouchableOpacity style={s.picker} onPress={() => setShowCmdPicker((v) => !v)}>
                  <Text style={s.pickerText}>
                    {selectedCmd
                      ? commands.find((c) => c.id === selectedCmd)?.label ?? selectedCmd
                      : "(select command)"}
                  </Text>
                </TouchableOpacity>
                {showCmdPicker && (
                  <ScrollView style={s.dropdown} nestedScrollEnabled>
                    {commands.map((c) => (
                      <TouchableOpacity
                        key={c.id}
                        style={s.dropdownItem}
                        onPress={() => { setSelectedCmd(c.id); setShowCmdPicker(false); }}
                      >
                        <Text style={[s.dropdownText, c.id === selectedCmd && s.dropdownSelected]}>
                          {c.label}
                        </Text>
                      </TouchableOpacity>
                    ))}
                  </ScrollView>
                )}
              </>
            ) : (
              <>
                <TextInput
                  style={s.textInput}
                  value={deeplinkInput}
                  onChangeText={setDeeplinkInput}
                  placeholder="https://... or app://..."
                  placeholderTextColor="#555"
                  autoCapitalize="none"
                  autoCorrect={false}
                  keyboardType="url"
                />
                <Text style={s.hint}>
                  Examples:{"\n"}
                  {"  "}JioHotstar: https://www.hotstar.com{"\n"}
                  {"  "}Prime Video: amzn://apps/android?asin=...{"\n"}
                  {"  "}Any intent or HTTP deep link
                </Text>
              </>
            )}

            <View style={s.modalBtns}>
              <TouchableOpacity style={s.cancelBtn} onPress={closeEdit}>
                <Text style={s.cancelBtnText}>Cancel</Text>
              </TouchableOpacity>
              <TouchableOpacity style={s.confirmBtn} onPress={commitEdit}>
                <Text style={s.confirmBtnText}>Done</Text>
              </TouchableOpacity>
            </View>
          </View>
        </View>
      </Modal>
    </View>
  );
}

const s = StyleSheet.create({
  container:       { flex: 1, backgroundColor: "#0f0f0f", padding: 16 },
  deviceName:      { fontSize: 20, color: "#fff", fontWeight: "600", marginBottom: 20 },
  empty:           { color: "#555", fontSize: 14, marginBottom: 16 },
  row:             { backgroundColor: "#1c1c1c", borderRadius: 8, marginBottom: 6, flexDirection: "row", alignItems: "center" },
  rowMain:         { flex: 1, padding: 12 },
  rowCombo:        { fontSize: 14, color: "#aaa" },
  rowAction:       { fontSize: 13, color: "#4a9eff", marginTop: 3 },
  deleteBtn:       { padding: 12 },
  deleteBtnText:   { color: "#555", fontSize: 16 },
  addBtn:          { backgroundColor: "#1c1c1c", borderRadius: 8, padding: 12, alignItems: "center", marginBottom: 8, marginTop: 8 },
  addBtnText:      { color: "#4a9eff", fontSize: 15 },
  saveBtn:         { backgroundColor: "#1a7f4b", borderRadius: 10, padding: 14, alignItems: "center", margin: 16 },
  saveBtnText:     { color: "#fff", fontSize: 16, fontWeight: "600" },

  // Modal
  modalOverlay:    { flex: 1, backgroundColor: "rgba(0,0,0,0.7)", justifyContent: "flex-end" },
  modalCard:       { backgroundColor: "#1c1c1c", borderTopLeftRadius: 20, borderTopRightRadius: 20, padding: 24, maxHeight: "85%" },
  modalTitle:      { fontSize: 18, color: "#fff", fontWeight: "600", marginBottom: 20 },
  fieldLabel:      { fontSize: 11, color: "#555", textTransform: "uppercase", letterSpacing: 1, marginBottom: 6 },
  textInput:       { backgroundColor: "#2a2a2a", borderRadius: 8, padding: 10, color: "#fff", fontSize: 14, marginBottom: 6 },
  hint:            { fontSize: 11, color: "#444", lineHeight: 16 },

  segmented:       { flexDirection: "row", backgroundColor: "#2a2a2a", borderRadius: 8, marginBottom: 12 },
  seg:             { flex: 1, padding: 8, alignItems: "center", borderRadius: 8 },
  segActive:       { backgroundColor: "#333" },
  segText:         { color: "#555", fontSize: 13 },
  segTextActive:   { color: "#fff" },

  picker:          { backgroundColor: "#2a2a2a", borderRadius: 6, padding: 10, marginBottom: 4 },
  pickerText:      { color: "#fff", fontSize: 13 },
  dropdown:        { backgroundColor: "#2a2a2a", borderRadius: 6, maxHeight: 200 },
  dropdownItem:    { padding: 10, borderBottomWidth: 1, borderBottomColor: "#333" },
  dropdownText:    { color: "#ccc", fontSize: 13 },
  dropdownSelected:{ color: "#4a9eff" },

  modalBtns:       { flexDirection: "row", gap: 12, marginTop: 24 },
  cancelBtn:       { flex: 1, backgroundColor: "#2a2a2a", borderRadius: 10, padding: 12, alignItems: "center" },
  cancelBtnText:   { color: "#888", fontSize: 15 },
  confirmBtn:      { flex: 1, backgroundColor: "#1a7f4b", borderRadius: 10, padding: 12, alignItems: "center" },
  confirmBtnText:  { color: "#fff", fontSize: 15, fontWeight: "600" },
});
