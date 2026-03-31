import React, { useEffect, useRef, useState } from "react";
import {
  View, Text, ScrollView, TouchableOpacity,
  StyleSheet, Animated, Dimensions, Platform,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { DebugLog } from "./DebugLog";

const PANEL_HEIGHT = Dimensions.get("window").height * 0.42;

export function DebugOverlay() {
  const insets = useSafeAreaInsets();
  const PILL_BOTTOM = insets.bottom + 12;

  const [open, setOpen] = useState(false);
  const [lines, setLines] = useState<string[]>([]);
  const slideY = useRef(new Animated.Value(PANEL_HEIGHT)).current;
  const scrollRef = useRef<ScrollView>(null);

  useEffect(() => DebugLog.subscribe(setLines), []);

  useEffect(() => {
    Animated.spring(slideY, {
      toValue: open ? 0 : PANEL_HEIGHT,
      useNativeDriver: true,
      speed: 20,
      bounciness: 4,
    }).start();
  }, [open]);

  useEffect(() => {
    if (open) {
      setTimeout(() => scrollRef.current?.scrollToEnd({ animated: true }), 50);
    }
  }, [lines, open]);

  return (
    <>
      {/* Toggle pill — sits above system nav bar */}
      <TouchableOpacity
        style={[s.pill, { bottom: open ? PANEL_HEIGHT + 8 : PILL_BOTTOM }]}
        onPress={() => setOpen((v) => !v)}
        activeOpacity={0.8}
        hitSlop={{ top: 12, bottom: 12, left: 20, right: 20 }}
      >
        <Text style={s.pillText}>{open ? "▾ log" : "▴ log"}</Text>
        {!open && lines.length > 0 && (
          <View style={s.badge}>
            <Text style={s.badgeText}>{lines.length}</Text>
          </View>
        )}
      </TouchableOpacity>

      {/* Sliding panel */}
      <Animated.View
        style={[s.panel, { paddingBottom: insets.bottom, transform: [{ translateY: slideY }] }]}
      >
        <View style={s.panelHeader}>
          <Text style={s.panelTitle}>BLE / Debug Log</Text>
          <TouchableOpacity onPress={() => DebugLog.clear()} hitSlop={{ top: 8, bottom: 8, left: 16, right: 8 }}>
            <Text style={s.clearBtn}>Clear</Text>
          </TouchableOpacity>
        </View>
        <ScrollView
          ref={scrollRef}
          style={s.scroll}
          contentContainerStyle={s.scrollContent}
          showsVerticalScrollIndicator={false}
        >
          {lines.length === 0
            ? <Text style={s.empty}>No events yet</Text>
            : lines.map((l, i) => <Text key={i} style={s.line}>{l}</Text>)
          }
        </ScrollView>
      </Animated.View>
    </>
  );
}

const s = StyleSheet.create({
  pill: {
    position: "absolute",
    alignSelf: "center",
    left: "50%",
    transform: [{ translateX: -36 }],
    backgroundColor: "#1c1c1c",
    borderRadius: 20,
    paddingHorizontal: 14,
    paddingVertical: 8,
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    zIndex: 999,
    borderWidth: 1,
    borderColor: "#333",
  },
  pillText: { color: "#4a9eff", fontSize: 12, fontFamily: Platform.OS === "android" ? "monospace" : "Courier" },
  badge: {
    backgroundColor: "#4a9eff",
    borderRadius: 8,
    paddingHorizontal: 5,
    paddingVertical: 1,
  },
  badgeText: { color: "#000", fontSize: 10, fontWeight: "700" },
  panel: {
    position: "absolute",
    bottom: 0,
    left: 0,
    right: 0,
    height: PANEL_HEIGHT,
    backgroundColor: "#0d0d0d",
    borderTopWidth: 1,
    borderTopColor: "#1e3a5f",
    zIndex: 998,
  },
  panelHeader: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    paddingHorizontal: 14,
    paddingVertical: 10,
    borderBottomWidth: 1,
    borderBottomColor: "#1a1a1a",
  },
  panelTitle: { color: "#4a9eff", fontSize: 12, fontWeight: "600", textTransform: "uppercase", letterSpacing: 1 },
  clearBtn:   { color: "#555", fontSize: 13 },
  scroll:     { flex: 1 },
  scrollContent: { padding: 10, paddingBottom: 20 },
  line: {
    color: "#a0c8ff",
    fontSize: 11,
    fontFamily: Platform.OS === "android" ? "monospace" : "Courier",
    lineHeight: 17,
  },
  empty: { color: "#333", fontSize: 12, fontFamily: Platform.OS === "android" ? "monospace" : "Courier" },
});
