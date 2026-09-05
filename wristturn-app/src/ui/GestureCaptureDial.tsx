import React, { useMemo } from "react";
import { View, Text, StyleSheet } from "react-native";

// Combined progress-ring + pose-compass dial, matching the single-circle
// mockup: outer ring color = phase (idle/countdown/capturing), tick ring
// rotates for roll, center marker's x/y = yaw/pitch, and the phase label
// draws ON TOP of the marker (z-index), never offset away from it.
//
// Note: the ring is a solid phase-colored border, not a literal sweeping
// percentage arc — react-native-svg (the reliable way to do a true
// stroke-dasharray sweep) isn't an installed dependency here, and a
// hand-rolled View-based arc-sweep is genuinely easy to get subtly wrong
// without live visual iteration. The countdown number already conveys
// progress precisely; the ring communicates phase via color instead.

type Props = {
  roll: number; pitch: number; yaw: number;
  rollRange?: number; pitchRange?: number; yawRange?: number;
  ringColor: string;
  centerLabel?: string;   // e.g. countdown number; omit once capturing
  size?: number;
};

const RING_TICKS = 12;

export function GestureCaptureDial({
  roll, pitch, yaw,
  rollRange = 80, pitchRange = 40, yawRange = 70,
  ringColor,
  centerLabel,
  size = 210,
}: Props) {
  const travel = size * 0.2;

  const ticks = useMemo(
    () => Array.from({ length: RING_TICKS }, (_, i) => (i * 360) / RING_TICKS),
    []
  );

  const clampedRoll = clamp(roll, -rollRange, rollRange);
  const mx = clamp(yaw / yawRange, -1, 1) * travel;
  const my = -clamp(pitch / pitchRange, -1, 1) * travel;

  return (
    <View style={{ width: size, height: size }}>
      {/* Outer ring — color = phase */}
      <View style={[s.outerRing, { width: size, height: size, borderRadius: size / 2, borderColor: ringColor }]} />

      {/* Dial face */}
      <View style={[s.face, { left: 16, top: 16, width: size - 32, height: size - 32, borderRadius: (size - 32) / 2 }]} />

      {/* Fixed crosshair */}
      <View style={[s.crossV, { left: size / 2 - 0.5, top: 16, bottom: 16 }]} />
      <View style={[s.crossH, { top: size / 2 - 0.5, left: 16, right: 16 }]} />

      {/* Tick ring — rotates with roll */}
      <View style={{ position: "absolute", left: 16, top: 16, width: size - 32, height: size - 32 }}>
        <View style={{ flex: 1, transform: [{ rotate: `${clampedRoll}deg` }] }}>
          {ticks.map((deg, i) => (
            <View
              key={i}
              style={[
                s.tick,
                i % 3 === 0 && s.tickMajor,
                {
                  left: (size - 32) / 2 - 0.75,
                  transform: [{ rotate: `${deg}deg` }, { translateY: -(size - 32) / 2 + 6 }],
                },
              ]}
            />
          ))}
        </View>
      </View>

      {/* Marker — position encodes yaw (x) / pitch (y) */}
      <View
        style={[
          s.marker,
          {
            left: size / 2 - 11, top: size / 2 - 11,
            backgroundColor: ringColor,
            transform: [{ translateX: mx }, { translateY: my }],
          },
        ]}
      />

      {/* Center label — draws OVER the marker via z-index */}
      {centerLabel != null && (
        <View style={[s.centerLabelWrap, { width: size, height: size }]} pointerEvents="none">
          <Text style={s.centerLabelText}>{centerLabel}</Text>
        </View>
      )}
    </View>
  );
}

function clamp(v: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, v));
}

const s = StyleSheet.create({
  outerRing: { position: "absolute", borderWidth: 5 },
  face: { position: "absolute", backgroundColor: "#1c1c1c", borderWidth: 1.5, borderColor: "#5a5a5a" },
  crossV: { position: "absolute", width: 1, backgroundColor: "#4a4a4a" },
  crossH: { position: "absolute", height: 1, backgroundColor: "#4a4a4a" },
  tick: { position: "absolute", top: 0, width: 1.5, height: 7, backgroundColor: "#777" },
  tickMajor: { backgroundColor: "#4a9eff" },
  marker: {
    position: "absolute", width: 22, height: 22, borderRadius: 11,
    zIndex: 3,
  },
  centerLabelWrap: {
    position: "absolute", top: 0, left: 0,
    alignItems: "center", justifyContent: "center",
    zIndex: 4,
  },
  centerLabelText: { fontSize: 46, fontWeight: "700", color: "#fff" },
});
