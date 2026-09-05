import React, { useEffect, useState } from "react";
import {
  View, Text, TouchableOpacity, TextInput,
  StyleSheet, Alert, Switch, ScrollView,
} from "react-native";
import type { CompositeScreenProps } from "@react-navigation/native";
import type { StackScreenProps } from "@react-navigation/stack";
import type { BottomTabScreenProps } from "@react-navigation/bottom-tabs";
import type { TabParams, RootStackParams } from "../navigation/AppNavigator";
import { Screen } from "../ui/Screen";
import { useBLE, sendBaselineToFirmware, setSymbolMode, setMinIntegrals, setDiagMode } from "../ble/useBLE";
import { BaselineStore } from "../storage/BaselineStore";
import { PrefsStore, DEFAULT_MIN_INTEGRAL_PITCH, DEFAULT_MIN_INTEGRAL_ROLLYAW, MIN_INTEGRAL_RANGE } from "../mapping/PrefsStore";

type Props = CompositeScreenProps<
  BottomTabScreenProps<TabParams, "Settings">,
  StackScreenProps<RootStackParams>
>;

export function handleRecalibrateHome(wristAddress: string) {
  if (!wristAddress) return;
  Alert.alert(
    "Recalibrate Home Position?",
    "This clears the stored baseline and forces an immediate recalibration.",
    [
      { text: "Cancel", style: "cancel" },
      {
        text: "Clear",
        style: "destructive",
        onPress: async () => {
          try {
            await BaselineStore.clear(wristAddress);
            // -999 tells firmware to drop its baseline. The actual capture
            // ceremony (with overlay UI) runs when user returns to Home and
            // Discovery's focus listener arms the device + listens for the
            // resulting PKT_BASELINE. Settings does NOT arm — that would
            // start a ceremony invisibly while user is on this screen.
            await sendBaselineToFirmware({ roll: -999, pitch: -999, yaw: -999 });
            Alert.alert("Baseline Cleared", "Please return to the Home screen to recalibrate.");
          } catch (e: any) {
            console.error("[Settings] recalibrate error:", e);
            Alert.alert("Error", String(e?.message ?? e));
          }
        },
      },
    ]
  );
}

export function SettingsScreen({ navigation }: Props) {
  const { connected, wristName, wristAddress, motionState } = useBLE();
  const [symbolMode, setSymbolModeState] = useState<boolean>(false);
  const [holdDetectorEnabled, setHoldDetectorEnabled] = useState<boolean>(false);
  const [diagModeOn, setDiagModeOn] = useState<boolean>(false);
  // Per-axis MIN_INTEGRAL thresholds (radians). Edited as strings so the user
  // can type/clear without the field jumping. Saved on Apply press only.
  const [minIntegPitchStr,   setMinIntegPitchStr]   = useState<string>(DEFAULT_MIN_INTEGRAL_PITCH.toFixed(2));
  const [minIntegRollYawStr, setMinIntegRollYawStr] = useState<string>(DEFAULT_MIN_INTEGRAL_ROLLYAW.toFixed(2));
  const [minIntegStatus,     setMinIntegStatus]     = useState<string>("");

  useEffect(() => {
    PrefsStore.getSymbolModeEnabled().then(setSymbolModeState).catch(() => {});
    PrefsStore.getExperimentalHoldDetector().then(setHoldDetectorEnabled).catch(() => {});
    PrefsStore.getMinIntegralPitch().then((v) => setMinIntegPitchStr(v.toFixed(2))).catch(() => {});
    PrefsStore.getMinIntegralRollYaw().then((v) => setMinIntegRollYawStr(v.toFixed(2))).catch(() => {});
  }, []);

  function toggleSymbolMode(next: boolean) {
    setSymbolModeState(next);
    setSymbolMode(next).catch(() => {});
  }

  function toggleHoldDetector(next: boolean) {
    setHoldDetectorEnabled(next);
    PrefsStore.setExperimentalHoldDetector(next).catch(() => {});
  }

  function toggleDiagMode(next: boolean) {
    // Diag mode is not persisted — purely runtime, only active while the user
    // explicitly has it on. Default off on every connect (firmware boot
    // initialises to 0). State here just mirrors the current toggle.
    setDiagModeOn(next);
    setDiagMode(next).catch((e) => {
      console.error("[Settings] setDiagMode failed:", e);
      setDiagModeOn(!next);  // revert on failure
    });
  }

  async function applyMinIntegrals() {
    const pitch = parseFloat(minIntegPitchStr);
    const rollYaw = parseFloat(minIntegRollYawStr);
    if (Number.isNaN(pitch) || Number.isNaN(rollYaw)) {
      setMinIntegStatus("Invalid number");
      return;
    }
    const inRange = (x: number) => x >= MIN_INTEGRAL_RANGE.min && x <= MIN_INTEGRAL_RANGE.max;
    if (!inRange(pitch) || !inRange(rollYaw)) {
      setMinIntegStatus(`Out of range (${MIN_INTEGRAL_RANGE.min}–${MIN_INTEGRAL_RANGE.max})`);
      return;
    }
    try {
      await PrefsStore.setMinIntegralPitch(pitch);
      await PrefsStore.setMinIntegralRollYaw(rollYaw);
      if (connected) {
        await setMinIntegrals(pitch, rollYaw);
        setMinIntegStatus(`Applied (pitch=${pitch.toFixed(2)}, roll/yaw=${rollYaw.toFixed(2)})`);
      } else {
        setMinIntegStatus("Saved — will push on next connect");
      }
    } catch (e) {
      setMinIntegStatus(`Failed: ${(e as Error)?.message ?? e}`);
    }
  }

  const calibLabel =
    !connected          ? "Not connected" :
    motionState === "calibrating"  ? "Calibrating…" :
    motionState === "stable"       ? "Calibrated" :
    motionState === "moving"       ? "Calibrated" :
                                     "Uncalibrated";

  const calibColor =
    motionState === "stable" || motionState === "moving" ? "#1a7f4b" :
    motionState === "calibrating"                        ? "#7f6a1a" :
                                                           "#555";

  return (
    <Screen edges={["top", "bottom"]}>
      <ScrollView showsVerticalScrollIndicator={false} contentContainerStyle={{ paddingBottom: 24 }}>
        {/* Wrist sensor */}
        <Text style={s.label}>Wrist Sensor</Text>
        <View style={[s.row, { marginBottom: 12 }]}>
          <View style={s.rowHeader}>
            <View style={{ flex: 1 }}>
              <Text style={s.rowName}>{connected ? (wristName || "Connected") : "Not connected"}</Text>
              <View style={{ flexDirection: "row", alignItems: "center", gap: 6, marginTop: 4 }}>
                <View style={[s.dot, { backgroundColor: calibColor }]} />
                <Text style={[s.rowSub, { color: calibColor }]}>{calibLabel}</Text>
              </View>
            </View>
            {connected && (
              <TouchableOpacity
                style={s.iconBtn}
                onPress={() => handleRecalibrateHome(wristAddress)}
              >
                <Text style={s.iconBtnText}>⟳</Text>
              </TouchableOpacity>
            )}
          </View>
          <View style={[s.editPanel, { paddingTop: 10 }]}>
            <View style={s.toggleRow}>
              <View style={{ flex: 1 }}>
                <Text style={s.toggleTitle}>Symbol mode</Text>
                <Text style={s.toggleSub}>
                  Tap to start a symbol capture; triple pitch-down to finalize.
                  While on, flick combos and holds are suppressed.
                </Text>
              </View>
              <Switch
                value={symbolMode}
                onValueChange={toggleSymbolMode}
                trackColor={{ false: "#2a2a2a", true: "#1e3a5f" }}
                thumbColor={symbolMode ? "#4a9eff" : "#666"}
              />
            </View>

            {/* Experimental: position-domain hold detector. Requires firmware
                that emits PKT_POSE_EXT (already flashed if you can read this). */}
            <View style={s.toggleRow}>
              <View style={{ flex: 1 }}>
                <Text style={s.toggleTitle}>Hold detector (experimental)</Text>
                <Text style={s.toggleSub}>
                  Position-domain auto-repeat & cruise-lock for sustained
                  deflections. Reads PKT_POSE_EXT (gyro magnitude on the wire).
                </Text>
              </View>
              <Switch
                value={holdDetectorEnabled}
                onValueChange={toggleHoldDetector}
                trackColor={{ false: "#2a2a2a", true: "#1e3a5f" }}
                thumbColor={holdDetectorEnabled ? "#4a9eff" : "#666"}
              />
            </View>

            {/* Diagnostic firehose. Streams every IMU sample (gyro, lacc, grav,
                YPR) over BLE for offline analysis. Heavy traffic — start a
                recording session in Logs, enable here, do motions, disable,
                stop session. Default off; firmware also defaults off on boot. */}
            <View style={s.toggleRow}>
              <View style={{ flex: 1 }}>
                <Text style={s.toggleTitle}>Diag firehose</Text>
                <Text style={s.toggleSub}>
                  Stream every IMU sample (~210 lines/s). Start a Logs session
                  to capture. Heavy BLE + battery cost. Off on next reconnect.
                </Text>
              </View>
              <Switch
                value={diagModeOn}
                onValueChange={toggleDiagMode}
                trackColor={{ false: "#2a2a2a", true: "#5f1e1e" }}
                thumbColor={diagModeOn ? "#ff6b6b" : "#666"}
              />
            </View>

            {/* Per-axis MIN_INTEGRAL floors. Pitch is split out from roll/yaw
                because pitch bleeds asymmetrically during arm-up/arm-down arcs.
                Range 0.10–1.00 rad. Pushed to firmware on Apply and on every
                reconnect. Persisted to AsyncStorage. */}
            <View style={[s.toggleRow, { flexDirection: "column", alignItems: "stretch" }]}>
              <Text style={s.toggleTitle}>Arbitrator floor (rad)</Text>
              <Text style={s.toggleSub}>
                Minimum integral for a gesture to fire. Lower = more sensitive,
                higher = more bleed rejection. Range {MIN_INTEGRAL_RANGE.min}–{MIN_INTEGRAL_RANGE.max}.
              </Text>
              <View style={{ flexDirection: "row", gap: 12, marginTop: 10 }}>
                <View style={{ flex: 1 }}>
                  <Text style={s.toggleSub}>Pitch</Text>
                  <TextInput
                    style={[s.input, { marginTop: 4 }]}
                    value={minIntegPitchStr}
                    onChangeText={setMinIntegPitchStr}
                    keyboardType="decimal-pad"
                    placeholder="0.30"
                    placeholderTextColor="#555"
                  />
                </View>
                <View style={{ flex: 1 }}>
                  <Text style={s.toggleSub}>Roll / Yaw</Text>
                  <TextInput
                    style={[s.input, { marginTop: 4 }]}
                    value={minIntegRollYawStr}
                    onChangeText={setMinIntegRollYawStr}
                    keyboardType="decimal-pad"
                    placeholder="0.30"
                    placeholderTextColor="#555"
                  />
                </View>
              </View>
              <View style={{ flexDirection: "row", alignItems: "center", marginTop: 8 }}>
                <TouchableOpacity
                  style={[s.scanBtn, { flexShrink: 0, paddingHorizontal: 16 }]}
                  onPress={applyMinIntegrals}
                >
                  <Text style={{ color: "#4a9eff", fontWeight: "600" }}>Apply</Text>
                </TouchableOpacity>
                {minIntegStatus !== "" && (
                  <Text style={[s.toggleSub, { marginLeft: 12, flex: 1 }]} numberOfLines={2}>
                    {minIntegStatus}
                  </Text>
                )}
              </View>
            </View>
          </View>
        </View>

        <TouchableOpacity style={s.linkRow} onPress={() => navigation.navigate("Devices")}>
          <Text style={s.linkRowText}>Devices</Text>
          <Text style={s.linkRowChevron}>›</Text>
        </TouchableOpacity>

        <TouchableOpacity style={s.addToggle} onPress={() => navigation.navigate("CalibrationCapture")}>
          <Text style={s.addToggleText}>⊙  Calibrate Gesture Templates</Text>
        </TouchableOpacity>
      </ScrollView>
    </Screen>
  );
}

const s = StyleSheet.create({
  label:        { fontSize: 11, color: "#666", textTransform: "uppercase", letterSpacing: 1, marginBottom: 8, marginTop: 16 },
  row:          { backgroundColor: "#1c1c1c", borderRadius: 10, marginBottom: 8, overflow: "hidden" },
  rowHeader:    { flexDirection: "row", alignItems: "center", padding: 14 },
  rowName:      { fontSize: 15, color: "#fff" },
  rowSub:       { fontSize: 11, color: "#555", marginTop: 2 },
  editPanel:    { padding: 12, paddingTop: 0, gap: 8, borderTopWidth: 1, borderTopColor: "#2a2a2a" },
  iconBtn:      { width: 32, height: 32, borderRadius: 8, borderWidth: 1, borderColor: "#1e3a5f", justifyContent: "center", alignItems: "center", marginLeft: 8 },
  iconBtnText:  { color: "#4a9eff", fontSize: 14 },
  scanBtn:      { backgroundColor: "#1e3a5f", paddingHorizontal: 14, paddingVertical: 6, borderRadius: 8 },
  input:        { backgroundColor: "#1c1c1c", color: "#fff", borderRadius: 8, paddingHorizontal: 12, paddingVertical: 10, fontSize: 14 },
  addToggle:     { paddingVertical: 10, marginTop: 8 },
  addToggleText: { color: "#4a9eff", fontSize: 14 },
  dot:          { width: 7, height: 7, borderRadius: 4 },
  toggleRow:    { flexDirection: "row", alignItems: "center", marginTop: 12, gap: 12 },
  toggleTitle:  { color: "#fff", fontSize: 14 },
  toggleSub:    { color: "#666", fontSize: 11, marginTop: 2 },
  linkRow:      { flexDirection: "row", justifyContent: "space-between", alignItems: "center", backgroundColor: "#1c1c1c", borderRadius: 10, padding: 14, marginTop: 20 },
  linkRowText:  { color: "#fff", fontSize: 15 },
  linkRowChevron:{ color: "#555", fontSize: 20 },
});
