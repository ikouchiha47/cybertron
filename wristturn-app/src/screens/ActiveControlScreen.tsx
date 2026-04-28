import React, { useEffect, useRef, useState } from "react";
import {
  View, Text, TouchableOpacity, StyleSheet, Animated, ScrollView, Pressable, AppState,
} from "react-native";
import MCI from "react-native-vector-icons/MaterialCommunityIcons";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import type { StackScreenProps } from "@react-navigation/stack";
import type { RootStackParams } from "../navigation/AppNavigator";
import { useBLE, setActiveComboMap, startCalibration, sendBaselineToFirmware } from "../ble/useBLE";
import { BatteryWave } from "../ui/BatteryWave";
import { PoseHUD } from "../ui/PoseHUD";
import { CalibrationOverlay } from "./CalibrationOverlay";
import { SessionRecorder } from "../debug/SessionRecorder";
import { registry } from "../devices/registry/DeviceRegistry";
import { MappingStore } from "../mapping/MappingStore";
import type { ComboMap, Baseline } from "../types";
import { Gesture, Mode, ArmPose } from "../types";

type Props = StackScreenProps<RootStackParams, "ActiveControl">;

export function ActiveControlScreen({ route, navigation }: Props) {
  const { deviceId, homeBaseline }  = route.params;
  const meta          = registry.get(deviceId);
  const proxy         = registry.getProxy(deviceId);
  const [map, setMap] = useState<ComboMap>({});
  const mapRef = useRef<ComboMap>({});
  const [deviceConnected, setDeviceConnected] = useState(false);
  const [lastCmd, setLastCmd] = useState("");
  const [activeCombo, setActiveCombo] = useState("");
  const [recording, setRecording]   = useState(SessionRecorder.isActive());
  const [recCount, setRecCount]     = useState(SessionRecorder.eventCount());
  const [locked, setLocked] = useState(false);  // when true, idle timeout is disabled
  const insets = useSafeAreaInsets();

  // Knob mode: always null on mount — triggers fresh calibration each session.
  // Gesture mode: set from homeBaseline once interactionMode is known.
  const [sessionBaseline, setSessionBaseline] = useState<Baseline | null>(null);
  const [sessionCalibrating, setSessionCalibrating] = useState(false);

  const armHangTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const opacity     = useRef(new Animated.Value(0)).current;
  const scale       = useRef(new Animated.Value(0.8)).current;
  const idleTimer   = useRef<ReturnType<typeof setTimeout> | null>(null);
  const lockedRef   = useRef(false);

  const IDLE_TIMEOUT_MS   = 8000;
  const ARM_HANG_EXIT_MS  = 2000; // arm hanging for 2s → back to discovery

  function resetIdleTimer() {
    if (idleTimer.current) clearTimeout(idleTimer.current);
    if (lockedRef.current) return;
    // Don't auto-dismiss while app is backgrounded — user is using gestures from another app
    if (AppState.currentState !== "active") return;
    idleTimer.current = setTimeout(() => navigation.goBack(), IDLE_TIMEOUT_MS);
  }

  useEffect(() => {
    lockedRef.current = locked;
    if (locked && idleTimer.current) {
      clearTimeout(idleTimer.current);
      idleTimer.current = null;
    }
  }, [locked]);

  useEffect(() => {
    return () => { if (idleTimer.current) clearTimeout(idleTimer.current); };
  }, []);

  useEffect(() => {
    return SessionRecorder.subscribe((active, n) => { setRecording(active); setRecCount(n); });
  }, []);

  useEffect(() => {
    if (!meta || !proxy) return;
    MappingStore.get(deviceId, proxy.defaultMapping()).then((m) => {
      setMap(m);
      mapRef.current = m;
      setActiveComboMap(Object.keys(m));
    });
    proxy.connect().then(() => setDeviceConnected(true)).catch(console.error);
    return () => { proxy.disconnect(); setDeviceConnected(false); };
  }, [deviceId]);

  // ── Animation helper (must be before useBLE so onCombo closure can reference it without hoisting) ──
  function animateGesture() {
    scale.setValue(0.8);
    opacity.setValue(0);
    Animated.sequence([
      Animated.parallel([
        Animated.spring(scale,   { toValue: 1, useNativeDriver: true }),
        Animated.timing(opacity, { toValue: 1, duration: 100, useNativeDriver: true }),
      ]),
      Animated.delay(1200),
      Animated.timing(opacity, { toValue: 0, duration: 400, useNativeDriver: true }),
    ]).start();
  }

  const { connected, lastGesture, lastCombo, batteryPct, interactionMode, pose, baselineCandidate, armPose } = useBLE({
    onGesture: (gesture) => {
      resetIdleTimer();
      if (gesture === Gesture.SHAKE && !lockedRef.current) navigation.goBack();
    },
    onCombo: async (combo) => {
      setActiveCombo(combo);
      animateGesture();
      const commandId = mapRef.current[combo];
      if (!commandId || !proxy || !meta) return;
      SessionRecorder.recordCommand(commandId, meta.id);
      if (commandId.startsWith("deeplink:")) {
        const url = commandId.slice("deeplink:".length);
        setLastCmd(url);
        await proxy.sendCommand({ id: commandId, label: url, payload: { link: url } });
        return;
      }
      const cmd = meta.availableCommands.find((c) => c.id === commandId);
      if (!cmd) return;
      setLastCmd(cmd.label);
      try {
        await proxy.sendCommand(cmd);
      } catch (e) {
        console.error("[ActiveControl] sendCommand error:", e);
      }
    },
  });

  // ── Session calibration for knob mode ──────────────────────────────────────
  // Triggered when interactionMode becomes "knob" AND no session baseline yet.
  // Handles async mode-settle race (ModeManager may set knob after mount).
  useEffect(() => {
    if (!interactionMode) return;
    if (interactionMode === Mode.GESTURE && homeBaseline && !sessionBaseline) {
      setSessionBaseline(homeBaseline);
      return;
    }
    if (interactionMode !== Mode.KNOB || sessionBaseline) return;
    setSessionCalibrating(true);
    startCalibration();
  }, [interactionMode, sessionBaseline]);

  // Complete session calibration from the firmware baseline candidate.
  useEffect(() => {
    if (!sessionCalibrating || !baselineCandidate) return;
    const baseline: Baseline = {
      roll: baselineCandidate.roll,
      pitch: baselineCandidate.pitch,
      yaw: baselineCandidate.yaw,
      timestamp: Date.now(),
      wristName: "",
      wristAddress: "",
    };
    setSessionBaseline(baseline);
    sendBaselineToFirmware(baseline).catch(() => {});
    setSessionCalibrating(false);
  }, [sessionCalibrating, baselineCandidate]);

  // While calibrating, keep resetting the idle timer so it never fires mid-calibration.
  useEffect(() => {
    if (!sessionCalibrating) return;
    const iv = setInterval(() => resetIdleTimer(), (IDLE_TIMEOUT_MS / 2));
    return () => clearInterval(iv);
  }, [sessionCalibrating]);

  // ── Arm-hang 2s auto-exit ─────────────────────────────────────────────────
  // When the gravity vector says arm is hanging (user dropped arm to side),
  // wait 2s then go back — same physical signal as DiscoveryScreen E5.
  useEffect(() => {
    if (!connected || armPose !== ArmPose.HANGING) {
      if (armHangTimerRef.current) {
        clearTimeout(armHangTimerRef.current);
        armHangTimerRef.current = null;
      }
      return;
    }
    if (!armHangTimerRef.current) {
      armHangTimerRef.current = setTimeout(() => {
        armHangTimerRef.current = null;
        if (!lockedRef.current && AppState.currentState === "active") {
          navigation.goBack();
        }
      }, ARM_HANG_EXIT_MS);
    }
  }, [armPose, connected]);

  // Clear hang timer when locked
  useEffect(() => {
    if (locked && armHangTimerRef.current) {
      clearTimeout(armHangTimerRef.current);
      armHangTimerRef.current = null;
    }
  }, [locked]);

  // ── On unmount: restore home baseline to firmware ────────────────────────
  useEffect(() => {
    return () => {
      if (armHangTimerRef.current) {
        clearTimeout(armHangTimerRef.current);
        armHangTimerRef.current = null;
      }
      if (homeBaseline) {
        sendBaselineToFirmware(homeBaseline).catch(() => {});
      }
    };
  }, [homeBaseline]);

  if (!meta) return <View style={s.container}><Text style={s.empty}>Device not found</Text></View>;

  const entries = Object.entries(map);

  function actionLabel(commandId: string) {
    if (!commandId) return "(none)";
    if (commandId.startsWith("deeplink:")) return commandId.slice("deeplink:".length);
    return meta?.availableCommands.find((c) => c.id === commandId)?.label ?? commandId;
  }

  return (
    <View style={[s.container, { paddingBottom: insets.bottom + 16 }]}>
      {/* Session calibration overlay (knob mode) */}
      <CalibrationOverlay
        visible={sessionCalibrating}
        onSkip={() => setSessionCalibrating(false)}
      />

      {/* Header */}
      <View style={s.header}>
        <Text style={s.deviceName} numberOfLines={1}>{meta.name}</Text>
        <View style={s.headerActions}>
          {/* Lock toggle — keeps screen alive when on */}
          <Pressable
            style={[s.iconBtn, locked && s.iconBtnActive]}
            onPress={() => setLocked((v) => !v)}
          >
            <MCI name={locked ? "pin" : "pin-outline"} size={20} color={locked ? "#4a9eff" : "#555"} />
          </Pressable>
          {/* REC toggle */}
          <Pressable
            style={[s.iconBtn, recording && s.iconBtnRec]}
            onPress={() => recording ? SessionRecorder.stop().then(() => {}) : SessionRecorder.start()}
          >
            <MCI name={recording ? "stop-circle" : "record-circle-outline"} size={20} color={recording ? "#ff4444" : "#555"} />
            {recording && <Text style={s.recCount}>{recCount}</Text>}
          </Pressable>
          <View style={[s.pill, deviceConnected ? s.pillOn : s.pillOff]}>
            <Text style={s.pillText}>{deviceConnected ? "Ready" : "Connecting..."}</Text>
          </View>
        </View>
      </View>

      {/* Gesture flash overlay */}
      <Animated.View style={[s.gestureFlash, { opacity }]} pointerEvents="none">
        <Animated.Text style={[s.gestureText, { transform: [{ scale }] }]}>
          {lastGesture}
        </Animated.Text>
        {lastCombo !== lastGesture && (
          <Text style={s.comboText}>{lastCombo.replace(/,/g, " → ")}</Text>
        )}
        {lastCmd ? <Text style={s.cmdText}>{lastCmd}</Text> : null}
      </Animated.View>

      {/* Pose HUD — only when session baseline is established */}
      {connected && pose && sessionBaseline && <PoseHUD pose={pose} />}

      {/* Mapping list */}
      <ScrollView style={s.mapList} showsVerticalScrollIndicator={false}>
        <Text style={s.sectionLabel}>Active Mappings</Text>
        {entries.length === 0 && (
          <Text style={s.empty}>No mappings — tap Remap to add some</Text>
        )}
        {entries.map(([combo, cmdId]) => (
          <View key={combo} style={[s.mapRow, activeCombo === combo && s.mapRowActive]}>
            <Text style={s.mapCombo}>{combo.replace(/,/g, " → ")}</Text>
            <Text style={s.mapAction} numberOfLines={1}>{actionLabel(cmdId)}</Text>
          </View>
        ))}
      </ScrollView>

      {/* Footer */}
      <View style={s.footer}>
        <View style={[s.pill, connected ? s.pillOn : s.pillOff, { flexDirection: "row", alignItems: "center", gap: 8 }]}>
          <Text style={s.pillText}>
            {connected ? "Wrist connected" : "Wrist scanning..."}
          </Text>
          {connected && batteryPct !== null && (
            <BatteryWave pct={batteryPct} size={28} />
          )}
        </View>
        <TouchableOpacity
          style={s.remapBtn}
          onPress={() => navigation.navigate("GestureMapping", { deviceId })}
        >
          <Text style={s.remapBtnText}>Remap</Text>
        </TouchableOpacity>
      </View>
    </View>
  );
}

const s = StyleSheet.create({
  container:      { flex: 1, backgroundColor: "#0f0f0f", padding: 20 },
  header:         { flexDirection: "row", justifyContent: "space-between", alignItems: "center", marginBottom: 16 },
  deviceName:     { fontSize: 18, color: "#fff", fontWeight: "600", flex: 1, marginRight: 8 },
  headerActions:  { flexDirection: "row", alignItems: "center", gap: 6 },
  iconBtn:        { padding: 6, borderRadius: 8, backgroundColor: "#1c1c1c" },
  iconBtnActive:  { backgroundColor: "#1e3a5f" },
  iconBtnRec:     { backgroundColor: "#2a0f0f", flexDirection: "row", alignItems: "center", gap: 4, paddingHorizontal: 8 },
  recCount:       { color: "#ff4444", fontSize: 11, fontFamily: "monospace" },
  pill:           { paddingHorizontal: 10, paddingVertical: 4, borderRadius: 10 },
  pillOn:         { backgroundColor: "#1a7f4b" },
  pillOff:        { backgroundColor: "#333" },
  pillText:       { color: "#fff", fontSize: 12 },

  gestureFlash:   { position: "absolute", top: 0, left: 0, right: 0, bottom: 0, justifyContent: "center", alignItems: "center", zIndex: 10 },
  gestureText:    { fontSize: 52, color: "#fff", fontWeight: "700", textAlign: "center" },
  comboText:      { fontSize: 18, color: "#888", textAlign: "center", marginTop: 8 },
  cmdText:        { fontSize: 16, color: "#4a9eff", marginTop: 16, textAlign: "center" },

  sectionLabel:   { fontSize: 11, color: "#444", textTransform: "uppercase", letterSpacing: 1, marginBottom: 10 },
  mapList:        { flex: 1 },
  mapRow:         { flexDirection: "row", justifyContent: "space-between", alignItems: "center", backgroundColor: "#1c1c1c", borderRadius: 8, paddingHorizontal: 14, paddingVertical: 10, marginBottom: 6 },
  mapRowActive:   { backgroundColor: "#1a3a2a", borderColor: "#1a7f4b", borderWidth: 1 },
  mapCombo:       { fontSize: 13, color: "#aaa" },
  mapAction:      { fontSize: 13, color: "#4a9eff", maxWidth: "55%" },

  footer:         { flexDirection: "row", justifyContent: "space-between", alignItems: "center", paddingTop: 12 },
  remapBtn:       { backgroundColor: "#1c1c1c", borderRadius: 10, paddingHorizontal: 20, paddingVertical: 10 },
  remapBtnText:   { color: "#888", fontSize: 14 },
  empty:          { color: "#444", fontSize: 13 },
});
