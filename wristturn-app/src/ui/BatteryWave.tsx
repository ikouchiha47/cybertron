import React, { useEffect, useRef } from "react";
import { Animated, View, Text, StyleSheet } from "react-native";

interface Props {
  pct: number;
  size?: number;
}

export function BatteryWave({ pct, size = 40 }: Props) {
  const waveX = useRef(new Animated.Value(0)).current;

  useEffect(() => {
    Animated.loop(
      Animated.sequence([
        Animated.timing(waveX, { toValue: 1, duration: 1800, useNativeDriver: true }),
        Animated.timing(waveX, { toValue: 0, duration: 1800, useNativeDriver: true }),
      ])
    ).start();
    return () => waveX.stopAnimation();
  }, [waveX]);

  const clamped = Math.max(0, Math.min(100, pct));
  const fillH   = (clamped / 100) * size;
  const waveH   = Math.max(4, size * 0.14);
  const color   = clamped > 50 ? "#4a9eff" : clamped > 20 ? "#f0a500" : "#e05555";

  const tx = waveX.interpolate({
    inputRange: [0, 1],
    outputRange: [-(size * 0.35), size * 0.35],
  });

  const fontSize = Math.max(8, size * 0.22);

  return (
    <View style={[styles.outer, { width: size, height: size, borderRadius: size / 2, borderColor: color }]}>
      {/* Liquid fill */}
      <View style={{ position: "absolute", bottom: 0, left: 0, right: 0, height: fillH + waveH }}>
        {/* Animated wave blob on top of the fill */}
        <Animated.View style={{
          position: "absolute",
          top: 0,
          width: size * 2.2,
          height: waveH * 2.6,
          borderRadius: waveH * 1.3,
          backgroundColor: color,
          opacity: 0.55,
          left: -(size * 0.6),
          transform: [{ translateX: tx }],
        }} />
        {/* Solid body below the wave */}
        <View style={{
          position: "absolute",
          bottom: 0, left: 0, right: 0,
          height: fillH,
          backgroundColor: color,
          opacity: 0.72,
        }} />
      </View>
      <Text style={[styles.label, { fontSize, color }]}>{clamped}%</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  outer: {
    borderWidth: 1.5,
    backgroundColor: "#111",
    overflow: "hidden",
    justifyContent: "center",
    alignItems: "center",
  },
  label: {
    fontWeight: "700",
    fontFamily: "monospace",
  },
});
