import React, { useEffect, useRef } from "react";
import { View, Text, Animated, StyleSheet, TouchableOpacity } from "react-native";

type Props = {
  visible: boolean;
  onSkip?: () => void;
};

/** Minimum time the overlay stays on-screen once it's shown, so a fast
 *  uncalibrated → calibrating → stable transition is still perceptible.
 */
const MIN_VISIBLE_MS = 1000;

export function CalibrationOverlay({ visible, onSkip }: Props) {
  const prevVisibleRef = useRef(false);
  const opacity   = useRef(new Animated.Value(0)).current;
  const pulse     = useRef(new Animated.Value(1)).current;
  const pulseLoop = useRef<Animated.CompositeAnimation | null>(null);
  const wasVisibleRef = useRef(false);
  const dismissTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Track transitions into visible so we can enforce MIN_VISIBLE_MS
  useEffect(() => {
    if (visible && !prevVisibleRef.current) {
      // Just became visible — arm a minimum-visibility timer
      wasVisibleRef.current = true;
      if (dismissTimerRef.current) clearTimeout(dismissTimerRef.current);
      dismissTimerRef.current = setTimeout(() => {
        dismissTimerRef.current = null;
        wasVisibleRef.current = false;
      }, MIN_VISIBLE_MS);
    }
    prevVisibleRef.current = visible;
  }, [visible]);

  // Fade in/out
  useEffect(() => {
    Animated.timing(opacity, {
      toValue:         visible ? 1 : 0,
      duration:        300,
      useNativeDriver: true,
    }).start();
  }, [visible]);

  // Pulse while visible
  useEffect(() => {
    if (visible) {
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
  }, [visible]);

  // Cleanup timers on unmount
  useEffect(() => {
    return () => {
      if (dismissTimerRef.current) {
        clearTimeout(dismissTimerRef.current);
        dismissTimerRef.current = null;
      }
    };
  }, []);

  // Don't render while in minimum-visibility grace period even if parent hid us
  const actuallyVisible = visible && (!wasVisibleRef.current || wasVisibleRef.current);
  // Actually, enforce MIN_VISIBLE_MS: if we just became visible, stay visible for at least MIN_VISIBLE_MS
  // The parent will hide us when stable, but we keep showing for MIN_VISIBLE_MS
  const effectiveVisible = visible || wasVisibleRef.current;

  if (!effectiveVisible) return null;

  const handleSkip = () => {
    if (dismissTimerRef.current) {
      clearTimeout(dismissTimerRef.current);
      dismissTimerRef.current = null;
    }
    wasVisibleRef.current = false;
    onSkip?.();
  };

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
        <TouchableOpacity onPress={handleSkip} style={s.skip}>
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
