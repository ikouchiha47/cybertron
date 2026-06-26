import React, { useEffect, useRef, useState } from "react";
import {
  View, Text, TouchableOpacity, StyleSheet, Animated, Easing,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import type { StackScreenProps } from "@react-navigation/stack";
import type { RootStackParams } from "../navigation/AppNavigator";
import { BLEServiceNative } from "../ble/BLEServiceNative";
import { armDevice, useBLE } from "../ble/useBLE";
import { parseStatePacket } from "../ble/StatePacket";
import { SessionRecorder } from "../debug/SessionRecorder";
import type { Point3D } from "../gestures/recognizer/PointCloudRecognizer";
import { GestureTemplateStore } from "../gestures/GestureTemplateStore";

// ── Config ────────────────────────────────────────────────────────────────────

const GESTURES: { id: string; label: string; hint: string }[] = [
  { id: "turn_left",   label: "↺ Turn Left",    hint: "Rotate wrist counterclockwise" },
  { id: "turn_right",  label: "↻ Turn Right",   hint: "Rotate wrist clockwise" },
  { id: "pitch_up",    label: "↑ Pitch Up",     hint: "Tilt hand up (knuckles toward you)" },
  { id: "pitch_down",  label: "↓ Pitch Down",   hint: "Tilt hand down (palm toward floor)" },
  { id: "flick_left",  label: "↺↩ Flick Left",  hint: "Snap wrist left and return to neutral" },
  { id: "flick_right", label: "↻↩ Flick Right", hint: "Snap wrist right and return to neutral" },
];

const SAMPLES_PER_GESTURE = 3;  // reps per gesture
const COUNTDOWN_SEC       = 3;  // prepare time before capture
const CAPTURE_SEC         = 4;  // capture window length

// ── State machine types ────────────────────────────────────────────────────────

type Phase =
  | { tag: "idle" }
  | { tag: "countdown"; gestureIdx: number; repIdx: number; remaining: number }
  | { tag: "capturing"; gestureIdx: number; repIdx: number; elapsed: number; pts: Point3D[] }
  | { tag: "done"; count: number };

// ── Screen ────────────────────────────────────────────────────────────────────

type Props = StackScreenProps<RootStackParams, "CalibrationCapture">;

export function CalibrationCaptureScreen({ navigation }: Props) {
  const insets = useSafeAreaInsets();
  const { connected } = useBLE();
  const [phase, setPhase] = useState<Phase>({ tag: "idle" });
  const [saving, setSaving] = useState(false);
  const captured = useRef<{ gesture: string; points: Point3D[] }[]>([]);

  // Progress ring animation
  const ring = useRef(new Animated.Value(0)).current;

  // Tick interval ref — cleared on unmount or phase transition
  const tickRef = useRef<ReturnType<typeof setInterval> | null>(null);

  // Latest pose from BLE_STATE — updated continuously, sampled during capture.
  // gyroMagDps comes from POSE_EXT and is used to discriminate flicks (high peak
  // angular velocity) from slow turn-and-return motions. seq is the firmware
  // emit counter — lets the app prove BLE-link drops post-hoc from JSONL.
  const latestPose = useRef<{ roll: number; pitch: number; yaw: number; gyroMagDps?: number; seq?: number } | null>(null);

  // Active capture sink: when set, every POSE_EXT received pushes directly into
  // it (no polling, no jitter, no dupes). beginCapture() installs this; the
  // capture-end timer clears it. Required for flicks where the entire gesture
  // is 3-4 native samples — polling would lose or duplicate samples.
  const captureSinkRef = useRef<((p: { roll: number; pitch: number; yaw: number; gyroMagDps?: number; seq?: number }) => void) | null>(null);

  useEffect(() => {
    // ARM the firmware so it enables the BNO rotation vector report and streams
    // POSE_EXT packets. Without this, no POSE_EXT → latestPose stays null → 0
    // samples. Gesture-routing on other screens is suppressed by the focus gate
    // in DiscoveryScreen, NOT by disarming here.
    console.log("[CalibCap] mount → armDevice()");
    armDevice()
      .then(() => console.log("[CalibCap] armDevice() OK"))
      .catch((e) => console.warn("[CalibCap] armDevice() FAILED", e));

    // Persistent pose subscription for the entire screen lifetime
    const sub = BLEServiceNative.onState?.((p) => {
      const pkt = parseStatePacket(p.raw);
      if (pkt && (pkt.type === "pose_ext" || pkt.type === "pose")) {
        const gyroMagDps = pkt.type === "pose_ext" ? pkt.gyroMagDps : undefined;
        const seq        = pkt.type === "pose_ext" ? pkt.seq        : undefined;
        const sample = { roll: pkt.roll, pitch: pkt.pitch, yaw: pkt.yaw, gyroMagDps, seq };
        latestPose.current = sample;
        // If a capture is in progress, push every native POSE_EXT directly — no
        // polling, no jitter, no dupes. Critical for fast gestures (flicks).
        if (captureSinkRef.current) captureSinkRef.current(sample);
      }
    }) ?? null;

    if (!sub) console.warn("[CalibCap] BLE_STATE subscription failed — emitter unavailable");

    return () => {
      tickRef.current && clearInterval(tickRef.current);
      sub?.remove();
    };
  }, []);

  // ── Phase driver ─────────────────────────────────────────────────────────────

  function startFlow() {
    captured.current = [];
    SessionRecorder.start();
    advanceTo(0, 0);
  }

  function advanceTo(gestureIdx: number, repIdx: number) {
    if (gestureIdx >= GESTURES.length) {
      finishCapture();
      return;
    }
    // Start countdown
    setPhase({ tag: "countdown", gestureIdx, repIdx, remaining: COUNTDOWN_SEC });
    ring.setValue(0);
    Animated.timing(ring, {
      toValue: 1,
      duration: COUNTDOWN_SEC * 1000,
      easing: Easing.linear,
      useNativeDriver: false,
    }).start();

    let remaining = COUNTDOWN_SEC;
    tickRef.current && clearInterval(tickRef.current);
    tickRef.current = setInterval(() => {
      remaining -= 1;
      if (remaining <= 0) {
        clearInterval(tickRef.current!);
        beginCapture(gestureIdx, repIdx);
      } else {
        setPhase({ tag: "countdown", gestureIdx, repIdx, remaining });
      }
    }, 1000);
  }

  function beginCapture(gestureIdx: number, repIdx: number) {
    const pts: Point3D[] = [];
    setPhase({ tag: "capturing", gestureIdx, repIdx, elapsed: 0, pts });

    ring.setValue(0);
    Animated.timing(ring, {
      toValue: 1,
      duration: CAPTURE_SEC * 1000,
      easing: Easing.linear,
      useNativeDriver: false,
    }).start();

    const gestureId = GESTURES[gestureIdx].id;
    SessionRecorder.annotate(`start:${gestureId}:rep:${repIdx + 1}`);
    const startMs = Date.now();

    // Stream-driven capture: every native POSE_EXT pushes a sample. No polling.
    captureSinkRef.current = (pose) => {
      pts.push({ x: pose.roll, y: pose.pitch, z: pose.yaw });
      SessionRecorder.recordRaw(pose);
    };

    // UI updater — purely cosmetic (sample count + ring). Not the data path.
    tickRef.current && clearInterval(tickRef.current);
    tickRef.current = setInterval(() => {
      const elapsed = Date.now() - startMs;
      setPhase({ tag: "capturing", gestureIdx, repIdx, elapsed, pts: [...pts] });
    }, 100);

    // Single end-of-window timer (replaces the polling end check).
    setTimeout(() => {
      captureSinkRef.current = null;
      tickRef.current && clearInterval(tickRef.current);
      SessionRecorder.annotate(`end:${gestureId}:rep:${repIdx + 1}`);
      console.log(`[CalibCap] captured ${pts.length} pts for ${gestureId}`);
      storeCapture(gestureIdx, repIdx, pts);
    }, CAPTURE_SEC * 1000);
  }

  function storeCapture(gestureIdx: number, repIdx: number, pts: Point3D[]) {
    const gesture = GESTURES[gestureIdx];
    if (pts.length >= 4) {
      captured.current.push({ gesture: gesture.id, points: pts });
    }
    const nextRep = repIdx + 1;
    if (nextRep < SAMPLES_PER_GESTURE) {
      advanceTo(gestureIdx, nextRep);
    } else {
      advanceTo(gestureIdx + 1, 0);
    }
  }

  async function finishCapture() {
    await SessionRecorder.stop();
    setSaving(true);
    await GestureTemplateStore.clear();
    for (const c of captured.current) {
      await GestureTemplateStore.append({
        gesture: c.gesture,
        points: c.points,
        capturedAt: Date.now(),
      });
    }
    setSaving(false);
    setPhase({ tag: "done", count: captured.current.length });
  }

  // ── Render helpers ────────────────────────────────────────────────────────────

  function renderIdle() {
    const total = GESTURES.length * SAMPLES_PER_GESTURE;
    return (
      <View style={s.center}>
        <Text style={s.bigLabel}>Gesture Calibration</Text>
        {!connected && <Text style={s.warnText}>No device connected.</Text>}
        <Text style={s.body}>
          You'll be guided through {GESTURES.length} gestures, {SAMPLES_PER_GESTURE} reps each ({total} total).
          {"\n\n"}
          When the countdown starts, prepare your wrist.{"\n"}
          When the bar turns green, perform the gesture.{"\n\n"}
          No touching the screen during capture.
        </Text>
        <TouchableOpacity style={s.startBtn} onPress={startFlow}>
          <Text style={s.startBtnText}>Start Calibration</Text>
        </TouchableOpacity>
      </View>
    );
  }

  function renderCountdown(p: Extract<Phase, { tag: "countdown" }>) {
    const g = GESTURES[p.gestureIdx];
    const ringFill = ring.interpolate({ inputRange: [0, 1], outputRange: ["0%", "100%"] });
    const total = GESTURES.length * SAMPLES_PER_GESTURE;
    const done  = p.gestureIdx * SAMPLES_PER_GESTURE + p.repIdx;
    return (
      <View style={s.center}>
        <Text style={s.progressText}>{done}/{total}</Text>
        <Text style={s.gestureLabel}>{g.label}</Text>
        <Text style={s.hint}>{g.hint}</Text>
        <Text style={s.repLabel}>Rep {p.repIdx + 1} of {SAMPLES_PER_GESTURE}</Text>

        <View style={s.countdownRing}>
          <Text style={s.countdownNum}>{p.remaining}</Text>
          <Animated.View style={[s.ringBar, { width: ringFill as any }]} />
        </View>
        <Text style={s.subHint}>Get ready…</Text>
      </View>
    );
  }

  function renderCapturing(p: Extract<Phase, { tag: "capturing" }>) {
    const g = GESTURES[p.gestureIdx];
    const ringFill = ring.interpolate({ inputRange: [0, 1], outputRange: ["0%", "100%"] });
    return (
      <View style={s.center}>
        <Text style={s.gestureLabel}>{g.label}</Text>
        <Text style={s.hint}>{g.hint}</Text>

        <View style={[s.countdownRing, s.captureRing]}>
          <Text style={s.captureNow}>GO</Text>
          <Animated.View style={[s.ringBar, s.ringBarGreen, { width: ringFill as any }]} />
        </View>

        <Text style={s.sampleCount}>{p.pts.length} samples</Text>
      </View>
    );
  }

  function renderDone(p: Extract<Phase, { tag: "done" }>) {
    return (
      <View style={s.center}>
        <Text style={s.bigLabel}>Done</Text>
        <Text style={s.body}>
          Saved {p.count} captures across {GESTURES.length} gestures.{"\n"}
          These will be used instead of synthetic templates.
        </Text>
        <TouchableOpacity style={s.startBtn} onPress={() => navigation.goBack()}>
          <Text style={s.startBtnText}>Back</Text>
        </TouchableOpacity>
        <TouchableOpacity style={[s.startBtn, s.secondaryBtn]} onPress={startFlow}>
          <Text style={[s.startBtnText, s.secondaryBtnText]}>Redo Calibration</Text>
        </TouchableOpacity>
      </View>
    );
  }

  function renderContent() {
    if (saving) {
      return (
        <View style={s.center}>
          <Text style={s.body}>Saving templates…</Text>
        </View>
      );
    }
    switch (phase.tag) {
      case "idle":       return renderIdle();
      case "countdown":  return renderCountdown(phase);
      case "capturing":  return renderCapturing(phase);
      case "done":       return renderDone(phase);
    }
  }

  return (
    <View style={[s.container, { paddingTop: insets.top + 12 }]}>
      {renderContent()}
    </View>
  );
}

const s = StyleSheet.create({
  container:       { flex: 1, backgroundColor: "#0f0f0f", padding: 20 },
  center:          { flex: 1, alignItems: "center", justifyContent: "center", gap: 12 },
  bigLabel:        { fontSize: 22, color: "#fff", fontWeight: "700", textAlign: "center" },
  gestureLabel:    { fontSize: 36, color: "#4a9eff", fontWeight: "700", textAlign: "center", letterSpacing: 1 },
  hint:            { fontSize: 14, color: "#888", textAlign: "center" },
  repLabel:        { fontSize: 13, color: "#555", textAlign: "center" },
  progressText:    { fontSize: 12, color: "#444", textAlign: "center" },
  body:            { fontSize: 14, color: "#aaa", textAlign: "center", lineHeight: 22, maxWidth: 300 },
  subHint:         { fontSize: 13, color: "#555" },
  sampleCount:     { fontSize: 12, color: "#444", fontFamily: "monospace" },
  countdownRing:   {
    width: 140, height: 140, borderRadius: 70,
    borderWidth: 4, borderColor: "#333",
    alignItems: "center", justifyContent: "center",
    overflow: "hidden", marginVertical: 16,
    backgroundColor: "#1a1a1a",
  },
  captureRing:     { borderColor: "#2a5a2a" },
  countdownNum:    { fontSize: 52, color: "#ccc", fontWeight: "700" },
  captureNow:      { fontSize: 44, color: "#4cff80", fontWeight: "900", letterSpacing: 4 },
  ringBar:         {
    position: "absolute", bottom: 0, left: 0, height: 4,
    backgroundColor: "#4a9eff",
  },
  ringBarGreen:    { backgroundColor: "#4cff80" },
  startBtn:        {
    marginTop: 16, backgroundColor: "#1a3a6a",
    paddingHorizontal: 32, paddingVertical: 14, borderRadius: 10,
  },
  startBtnText:    { color: "#4a9eff", fontSize: 16, fontWeight: "600" },
  secondaryBtn:    { backgroundColor: "#1a1a1a", borderWidth: 1, borderColor: "#333" },
  secondaryBtnText: { color: "#666" },
  warnText:         { color: "#ff9f44", fontSize: 13, textAlign: "center", maxWidth: 280 },
  startBtnDisabled: { opacity: 0.35 },
});
