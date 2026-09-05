import React from "react";
import { View, StyleSheet, type ViewStyle, type StyleProp } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

// Every tab screen (headerShown: false) is rendered flush under the status
// bar / notch / camera cutout unless it manually pads for insets.top. That
// got forgotten on SettingsScreen and has bitten us before — this component
// is the fix: wrap any tab screen's content in it and the top/bottom safe
// area is applied automatically, no per-screen boilerplate to forget.
interface ScreenProps {
  children: React.ReactNode;
  style?: StyleProp<ViewStyle>;
  edges?: Array<"top" | "bottom">;
}

export function Screen({ children, style, edges = ["top", "bottom"] }: ScreenProps) {
  const insets = useSafeAreaInsets();
  return (
    <View
      style={[
        s.container,
        edges.includes("top") && { paddingTop: insets.top + 12 },
        edges.includes("bottom") && { paddingBottom: insets.bottom },
        style,
      ]}
    >
      {children}
    </View>
  );
}

const s = StyleSheet.create({
  container: { flex: 1, backgroundColor: "#0f0f0f", padding: 16 },
});
