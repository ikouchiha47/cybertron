import React, { useEffect, useState } from "react";
import {
  View, Text, TouchableOpacity, StyleSheet, ScrollView,
} from "react-native";
import type { StackScreenProps } from "@react-navigation/stack";
import type { RootStackParams } from "../navigation/AppNavigator";
import { registry } from "../devices/registry/DeviceRegistry";
import { MappingStore } from "../mapping/MappingStore";
import type { ComboMap } from "../types";

type Props = StackScreenProps<RootStackParams, "GestureMapping">;

const GESTURES = [
  "turn_right", "turn_left", "pitch_up", "pitch_down",
  "yaw_left", "yaw_right", "tap", "shake",
];

const COMBOS = [
  "turn_right,turn_right", "turn_left,turn_left",
  "turn_right,turn_left",  "turn_left,turn_right",
  "pitch_up,pitch_down",
];

export function GestureMappingScreen({ route, navigation }: Props) {
  const { deviceId } = route.params;
  const meta = registry.get(deviceId);
  const [map, setMap] = useState<ComboMap>({});

  useEffect(() => {
    if (!meta) return;
    MappingStore.get(deviceId, meta.transport).then(setMap);
  }, [deviceId]);

  if (!meta) return <View style={s.container}><Text style={s.empty}>Device not found</Text></View>;

  function assign(combo: string, commandId: string) {
    setMap((prev) => ({ ...prev, [combo]: commandId }));
  }

  async function save() {
    await MappingStore.set(deviceId, map);
    navigation.goBack();
  }

  const commands = [{ id: "", label: "(none)" }, ...meta.availableCommands];

  return (
    <ScrollView style={s.container}>
      <Text style={s.deviceName}>{meta.name}</Text>

      <Text style={s.sectionLabel}>Single Gestures</Text>
      {GESTURES.map((g) => (
        <Row
          key={g}
          label={g}
          commands={commands}
          selected={map[g] ?? ""}
          onSelect={(id) => assign(g, id)}
        />
      ))}

      <Text style={s.sectionLabel}>Combos</Text>
      {COMBOS.map((c) => (
        <Row
          key={c}
          label={c.replace(/,/g, " → ")}
          commands={commands}
          selected={map[c] ?? ""}
          onSelect={(id) => assign(c, id)}
        />
      ))}

      <TouchableOpacity style={s.saveBtn} onPress={save}>
        <Text style={s.saveBtnText}>Save</Text>
      </TouchableOpacity>
    </ScrollView>
  );
}

function Row({
  label, commands, selected, onSelect,
}: {
  label: string;
  commands: Array<{ id: string; label: string }>;
  selected: string;
  onSelect: (id: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const selectedLabel = commands.find((c) => c.id === selected)?.label ?? "(none)";

  return (
    <View style={s.row}>
      <Text style={s.rowLabel}>{label}</Text>
      <TouchableOpacity style={s.picker} onPress={() => setOpen((v) => !v)}>
        <Text style={s.pickerText}>{selectedLabel}</Text>
      </TouchableOpacity>
      {open && (
        <View style={s.dropdown}>
          {commands.map((c) => (
            <TouchableOpacity
              key={c.id}
              style={s.dropdownItem}
              onPress={() => { onSelect(c.id); setOpen(false); }}
            >
              <Text style={[s.dropdownText, c.id === selected && s.dropdownSelected]}>
                {c.label}
              </Text>
            </TouchableOpacity>
          ))}
        </View>
      )}
    </View>
  );
}

const s = StyleSheet.create({
  container:        { flex: 1, backgroundColor: "#0f0f0f", padding: 16 },
  deviceName:       { fontSize: 20, color: "#fff", fontWeight: "600", marginBottom: 20 },
  sectionLabel:     { fontSize: 11, color: "#555", textTransform: "uppercase", letterSpacing: 1, marginTop: 16, marginBottom: 8 },
  row:              { backgroundColor: "#1c1c1c", borderRadius: 8, padding: 12, marginBottom: 6 },
  rowLabel:         { fontSize: 14, color: "#aaa", marginBottom: 6 },
  picker:           { backgroundColor: "#2a2a2a", borderRadius: 6, padding: 8 },
  pickerText:       { color: "#fff", fontSize: 13 },
  dropdown:         { backgroundColor: "#2a2a2a", borderRadius: 6, marginTop: 4 },
  dropdownItem:     { padding: 10, borderBottomWidth: 1, borderBottomColor: "#333" },
  dropdownText:     { color: "#ccc", fontSize: 13 },
  dropdownSelected: { color: "#4a9eff" },
  saveBtn:          { backgroundColor: "#1a7f4b", borderRadius: 10, padding: 14, alignItems: "center", margin: 16 },
  saveBtnText:      { color: "#fff", fontSize: 16, fontWeight: "600" },
  empty:            { color: "#555", fontSize: 14 },
});
