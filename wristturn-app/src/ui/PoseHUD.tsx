import React from "react";
import { View, Text, StyleSheet } from "react-native";

type Pose = {
  roll: number; pitch: number; yaw: number;
  baseRoll: number; basePitch: number; baseYaw: number;
};

type Props = { pose: Pose };

function deltaColor(deg: number): string {
  const abs = Math.abs(deg);
  if (abs < 5)  return "#4caf50";
  if (abs < 15) return "#ff9800";
  return "#f44336";
}

function fmt(n: number, sign = false): string {
  const s = n.toFixed(1);
  return sign && n > 0 ? `+${s}` : s;
}

export function PoseHUD({ pose }: Props) {
  const axes = [
    { label: "R", color: "#ef5350", live: pose.roll,  base: pose.baseRoll  },
    { label: "P", color: "#66bb6a", live: pose.pitch, base: pose.basePitch },
    { label: "Y", color: "#42a5f5", live: pose.yaw,   base: pose.baseYaw   },
  ];

  return (
    <View style={s.container} pointerEvents="none">
      <Text style={s.header}>IMU</Text>
      {axes.map(({ label, color, live, base }) => {
        const delta = live - base;
        return (
          <View key={label} style={s.row}>
            <View style={[s.dot, { backgroundColor: color }]} />
            <Text style={[s.axisLabel, { color }]}>{label}</Text>
            <Text style={s.value}>{fmt(live)}°</Text>
            <Text style={[s.delta, { color: deltaColor(delta) }]}>
              {fmt(delta, true)}°
            </Text>
          </View>
        );
      })}
    </View>
  );
}

const s = StyleSheet.create({
  container: {
    position:        "absolute",
    top:             60,
    right:           12,
    zIndex:          50,
    backgroundColor: "rgba(14,14,14,0.82)",
    borderRadius:    10,
    paddingVertical:   8,
    paddingHorizontal: 10,
    borderWidth:     1,
    borderColor:     "rgba(255,255,255,0.07)",
    minWidth:        130,
  },
  header: {
    fontSize:      8,
    color:         "#444",
    letterSpacing: 1.5,
    textTransform: "uppercase",
    marginBottom:  5,
    textAlign:     "center",
  },
  row: {
    flexDirection:  "row",
    alignItems:     "center",
    paddingVertical: 2,
  },
  dot: {
    width:        5,
    height:       5,
    borderRadius: 3,
    marginRight:  5,
  },
  axisLabel: {
    fontSize:    11,
    fontWeight:  "700",
    width:       14,
  },
  value: {
    fontSize:       11,
    color:          "#ccc",
    fontVariant:    ["tabular-nums"],
    flex:           1,
    textAlign:      "right",
  },
  delta: {
    fontSize:    10,
    fontVariant: ["tabular-nums"],
    width:       48,
    textAlign:   "right",
  },
});
