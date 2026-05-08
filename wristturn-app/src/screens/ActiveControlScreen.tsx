import React, { useEffect, useRef, useState } from "react";
import {
  View, Text, TouchableOpacity, StyleSheet, Animated, ScrollView, Pressable, AppState,
} from "react-native";
import MCI from "react-native-vector-icons/MaterialCommunityIcons";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useKeepAwake } from "expo-keep-awake";
import type { StackScreenProps } from "@react-navigation/stack";
import type { RootStackParams } from "../navigation/AppNavigator";
import { useBLE, setActiveComboMap, sendBaselineToFirmware, armDevice, requestRecalibration, lastFireMs, recalibrate, resetMotionClassifier } from "../ble/useBLE";
import { BatteryWave } from "../ui/BatteryWave";
import { PoseHUD } from "../ui/PoseHUD";
import { CalibrationOverlay } from "./CalibrationOverlay";
import { SessionRecorder } from "../debug/SessionRecorder";
import { DebugLog }        from "../debug/DebugLog";
import { registry } from "../devices/registry/DeviceRegistry";
import { MappingStore } from "../mapping/MappingStore";
import type { ComboMap, Baseline } from "../types";
import { Gesture, ArmPose } from "../types";

type Props = StackScreenProps<RootStackParams, "ActiveControl">;

export function ActiveControlScreen({ route, navigation }: Props) {
  // Hold the screen awake — gestures come from the wrist, not the touch
  // surface, so Android's display timeout would otherwise dim the screen
  // mid-session.
  useKeepAwake();
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

  // Per-session calibration. Every AC entry captures a fresh PKT_BASELINE
  // from firmware. homeBaseline is taken as a hint (Discovery passes it) but
  // we still re-arm + recalibrate so the baseline reflects the user's *current*
  // wrist pose, not the one captured at home-screen time.
  const [sessionBaseline,    setSessionBaseline]    = useState<Baseline | null>(null);
  const [sessionCalibrating, setSessionCalibrating] = useState(false);

  // Fence: snapshot of baselineCandidate.seq taken when we issue the recalib
  // request. The completion effect ignores any candidate with seq ≤ this.
  const calibSnapshotSeqRef = useRef<number | null>(null);
  // Fires *once* per mount. Without this, the safety timeout flipping
  // sessionCalibrating back to false would re-trigger the calibration effect
  // and keep clearing firmware state — baseline would never finish capturing.
  const calibAttemptedRef = useRef(false);

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
    // Start the idle countdown on screen mount so "open and walk away"
    // auto-exits without requiring a first gesture to arm the timer.
    // resetIdleTimer respects locked / backgrounded state internally.
    resetIdleTimer();
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
      setActiveComboMap(m);
    });

    // Connect to the device with a timeout fallback. If the device proxy
    // doesn't respond (e.g. the TV is powered off / unreachable), bail back
    // to Discovery instead of leaving the user stuck on a non-functional
    // "Connecting..." screen forever. `cancelled` guards against firing
    // navigation.goBack() if the screen has already been unmounted by the
    // time the timeout / catch resolves.
    const CONNECT_TIMEOUT_MS = 5000;
    let cancelled = false;
    let timeoutId: ReturnType<typeof setTimeout> | null = null;

    const timeoutPromise = new Promise<never>((_, reject) => {
      timeoutId = setTimeout(
        () => reject(new Error("connect timeout")),
        CONNECT_TIMEOUT_MS,
      );
    });

    Promise.race([proxy.connect(), timeoutPromise])
      .then(() => {
        if (cancelled) return;
        if (timeoutId) clearTimeout(timeoutId);
        setDeviceConnected(true);
      })
      .catch((e) => {
        if (timeoutId) clearTimeout(timeoutId);
        if (cancelled) return;
        const reason = e?.message ?? String(e);
        console.error("[ActiveControl] connect failed:", reason);
        DebugLog.push("AC", `connect failed: ${reason} — exiting`);
        navigation.goBack();
      });

    return () => {
      cancelled = true;
      if (timeoutId) clearTimeout(timeoutId);
      proxy.disconnect();
      setDeviceConnected(false);
    };
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

  const { connected, lastGesture, lastCombo, batteryPct, pose, baselineCandidate, armPose } = useBLE({
    onGesture: (gesture) => {
      resetIdleTimer();
      if (gesture === Gesture.SHAKE && !lockedRef.current) navigation.goBack();
    },
    onCombo: async (action) => {
      const tDispatch = Date.now();
      DebugLog.push("TIMING", `dispatch ${action} +${tDispatch - lastFireMs()}ms`); // T4: fire→dispatch (React notify cycle)
      setActiveCombo(action);
      animateGesture();
      if (!proxy || !meta) return;
      SessionRecorder.recordCommand(action, meta.id);
      if (action.startsWith("deeplink:")) {
        const url = action.slice("deeplink:".length);
        setLastCmd(url);
        await proxy.sendCommand({ id: action, label: url, payload: { link: url } });
        DebugLog.push("TIMING", `sent ${action} +${Date.now() - tDispatch}ms`); // T5: dispatch→sent
        return;
      }
      const cmd = meta.availableCommands.find((c) => c.id === action);
      if (!cmd) return;
      setLastCmd(cmd.label);
      try {
        await proxy.sendCommand(cmd);
        DebugLog.push("TIMING", `sent ${action} +${Date.now() - tDispatch}ms`); // T5: dispatch→sent
      } catch (e) {
        console.error("[ActiveControl] sendCommand error:", e);
      }
    },
  });

  // ── Per-device-selection-session MotionClassifier lifecycle ───────────────
  // The persistent home baseline (Discovery) restores firmware orientation
  // across reboots, but the app-side MotionClassifier is ephemeral: a fresh
  // ceremony runs on every session entry, and its state is forgotten on exit.
  // Without this, MC would stay `uncalibrated` after the first ever connect,
  // silently breaking the delta path (knob ticks, motionState transitions).
  useEffect(() => {
    console.log("[CANARY:AC_MC_ENTER] session start — recalibrate()");
    recalibrate();
    return () => {
      console.log("[CANARY:AC_MC_EXIT] session end — resetMotionClassifier()");
      resetMotionClassifier();
    };
  }, []);

  // Session baseline acquisition. Two paths:
  //  1. homeBaseline passed via route params (Discovery flow): adopt directly.
  //  2. No homeBaseline (Settings → openDevice flow, or post-wipe): arm the
  //     device and request a fresh PKT_BASELINE; adopt when it arrives.
  // The firmware-only path is also what knob mode used to do, generalised
  // here because every active session now needs a baseline.
  useEffect(() => {
    if (sessionBaseline) return;
    if (homeBaseline) { setSessionBaseline(homeBaseline); return; }
    if (calibAttemptedRef.current) return;       // already tried this mount
    calibAttemptedRef.current = true;

    console.log("[AC] no homeBaseline — requesting firmware recalibration");
    setSessionCalibrating(true);
    armDevice()
      .then(() => requestRecalibration())
      .then((snapshot) => {
        calibSnapshotSeqRef.current = snapshot;
        console.log(`[AC] recalibration snapshot seq=${snapshot}`);
      })
      .catch((e) => console.error("[AC] requestRecalibration failed:", e));
  }, [homeBaseline, sessionBaseline]);

  // Adopt fresh PKT_BASELINE that arrives after our request (seq > snapshot).
  useEffect(() => {
    if (!sessionCalibrating || !baselineCandidate) return;
    const snap = calibSnapshotSeqRef.current;
    if (snap === null || baselineCandidate.seq <= snap) return;
    console.log(`[AC] adopting fresh baseline seq=${baselineCandidate.seq}`);
    setSessionBaseline({
      roll:  baselineCandidate.roll,
      pitch: baselineCandidate.pitch,
      yaw:   baselineCandidate.yaw,
      timestamp: Date.now(),
      wristName: "",
      wristAddress: "",
    });
    setSessionCalibrating(false);
    calibSnapshotSeqRef.current = null;
  }, [sessionCalibrating, baselineCandidate]);

  // Safety timeout: if firmware never sends a fresh baseline, give up and
  // either fall through to homeBaseline (if any) or just hide the overlay so
  // the user isn't stuck. 8s mirrors Discovery's E3b (firmware finalizes via
  // 3s stable window or 12s hard deadline; the calibAttemptedRef guard above
  // prevents re-fire on the (false→true) flip when this expires).
  useEffect(() => {
    if (!sessionCalibrating) return;
    const t = setTimeout(() => {
      calibSnapshotSeqRef.current = null;
      setSessionCalibrating(false);
      if (homeBaseline) {
        console.log("[AC] calibration timeout — falling back to homeBaseline");
        setSessionBaseline({ ...homeBaseline, timestamp: Date.now() });
        sendBaselineToFirmware(homeBaseline).catch(() => {});
      } else {
        console.warn("[AC] calibration timeout — no homeBaseline; hiding overlay");
      }
    }, 8000);
    return () => clearTimeout(t);
  }, [sessionCalibrating, homeBaseline]);

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
      {/* Visible while we're waiting for a session baseline (either adopting
          homeBaseline or capturing a fresh one from firmware). */}
      <CalibrationOverlay
        visible={sessionCalibrating || !sessionBaseline}
        onSkip={() => {
          calibSnapshotSeqRef.current = null;
          setSessionCalibrating(false);
        }}
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
