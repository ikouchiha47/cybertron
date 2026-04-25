import React, { useEffect, useRef } from "react";
import { View, Text, Animated, StyleSheet, TouchableOpacity } from "react-native";
import { useBLE } from "../ble/useBLE";

/** Minimum time the overlay stays on-screen once it's shown, so a fast
 *  uncalibrated → calibrating → stable transition is still perceptible.
 */
const MIN_VISIBLE_MS = 1000;

export function CalibrationOverlay() {
  const { connected, motionState } = useBLE();
  const [userDismissed, setUserDismissed] = React.useState(false);
  const dismissTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const opacity   = useRef(new Animated.Value(0)).current;
  const pulse     = useRef(new Animated.Value(1)).current;
  const pulseLoop = useRef<Animated.CompositeAnimation | null>(null);

  const inCalibratingState = motionState === "calibrating" || motionState === "uncalibrated";
  const stable             = motionState === "stable";
  const visible            = !userDismissed && connected && inCalibratingState;

  // Arm a one-shot timer when we first enter the calibrating state.
  // When it fires (MIN_VISIBLE_MS later), it auto-dismisses IF we're already stable.
  useEffect(() => {
    if (connected && inCalibratingState && !userDismissed && dismissTimerRef.current === null) {
      setUserDismissed(false);
      dismissTimerRef.current = setTimeout(() => {
        dismissTimerRef.current = null;
        // Only auto-dismiss if the device has actually stabilized
        if (motionState === "stable") {
          setUserDismissed(true);
        }
      }, MIN_VISIBLE_MS);
    }
    // Clean up on unmount or when fully hidden
    return () => {
      if (dismissTimerRef.current) {
        clearTimeout(dismissTimerRef.current);
        dismissTimerRef.current = null;
      }
    };
  }, [connected, inCalibratingState, userDismissed, motionState]);

  // If stable arrives after the timer has already fired, dismiss immediately
  useEffect(() => {
    if (stable && !userDismissed && connected && dismissTimerRef.current === null) {
      setUserDismissed(true);
    }
  }, [stable, userDismissed, connected]);

  // Fade in/out
  useEffect(() => {
    Animated.timing(opacity, {
      toValue:         visible ? 1 : 0,
      duration:        300,
      useNativeDriver: true,
    }).start();
  }, [visible]);

  // Pulse while calibrating, stop on stable
  useEffect(() => {
    if (visible && !stable) {
      pulseLoop.current = Animated.loop(
        Animated.sequence([
          Animated.timing(pulse, { toValue: 1.15, duration: 800, useNativeDriver: true }),
          Animated.timing(pulse, { toValue: 1.0,  duration: 800, useNativeDriver: true }),
        ])
      );
      pulseLoop.current.start();
    } else {
      pulseLoop.current?.stop();
      pulse.setValue(1);
    }
    return () => { pulseLoop.current?.stop(); };
  }, [visible, stable]);

  if (!visible) return null;

  return (
    <Animated.View style={[s.overlay, { opacity }]} pointerEvents="box-none">
      <View style={s.card}>
        <Animated.Text style={[s.icon, { transform: [{ scale: pulse }] }]}>
          🤚
        </Animated.Text>
        <Text style={s.title}>Calibrating</Text>
        <Text style={s.body}>Extend arm straight forward, palm facing your body.{"\n"}Hold still for a moment.</Text>
        <View style={s.dots}>
          {[0, 1, 2].map((i) => <PulseDot key={i} delay={i * 200} />)}
        </View>
        <TouchableOpacity onPress={() => setUserDismissed(true)} style={s.skip}>
          <Text style={s.skipText}>Skip</Text>
        </TouchableOpacity>
      </View>
    </Animated.View>
  );
}

function PulseDot({ delay }: { delay: number }) {
  const op = useRef(new Animated.Value(0.2)).current;
  useEffect(() => {
    Animated.loop(
      Animated.sequence([
        Animated.delay(delay),
        Animated.timing(op, { toValue: 1,   duration: 400, useNativeDriver: true }),
        Animated.timing(op, { toValue: 0.2, duration: 400, useNativeDriver: true }),
      ])
    ).start();
  }, []);
  return <Animated.View style={[s.dot, { opacity: op }]} />;
}

const s = StyleSheet.create({
  overlay: {
    position:        "absolute",
    top: 0, left: 0, right: 0, bottom: 0,
    backgroundColor: "rgba(0,0,0,0.75)",
    justifyContent:  "center",
    alignItems:      "center",
    zIndex:          100,
  },
  card: {
    backgroundColor: "#1c1c1c",
    borderRadius:    20,
    padding:         32,
    alignItems:      "center",
    width:           280,
  },
  icon:     { fontSize: 52, marginBottom: 16 },
  title:    { fontSize: 20, color: "#fff", fontWeight: "700", marginBottom: 8 },
  body:     { fontSize: 14, color: "#888", textAlign: "center", lineHeight: 20 },
  dots:     { flexDirection: "row", gap: 8, marginTop: 24 },
  dot:      { width: 8, height: 8, borderRadius: 4, backgroundColor: "#4a9eff" },
  skip:     { marginTop: 20 },
  skipText: { fontSize: 13, color: "#555" },
});
