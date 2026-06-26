import React, { useEffect, useRef, useState } from "react";
import { Animated, Dimensions, StyleSheet, Text, TouchableOpacity, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { DebugLog } from "../debug/DebugLog";

const SCREEN_W    = Dimensions.get("window").width;
const AUTO_CLOSE  = 4000;
const ANIM_MS     = 280;

interface ToastEntry {
  id:  number;
  msg: string;
}

let nextId = 0;

export function GlobalErrorOverlay() {
  const [toasts, setToasts] = useState<ToastEntry[]>([]);
  const insets = useSafeAreaInsets();

  useEffect(() => {
    return DebugLog.subscribeError((msg) => {
      const entry: ToastEntry = { id: nextId++, msg };
      setToasts((prev) => [...prev.slice(-2), entry]); // max 3 at once
    });
  }, []);

  function dismiss(id: number) {
    setToasts((prev) => prev.filter((t) => t.id !== id));
  }

  return (
    <View style={[s.container, { top: insets.top + 8 }]} pointerEvents="box-none">
      {toasts.map((t) => (
        <Toast key={t.id} msg={t.msg} onDismiss={() => dismiss(t.id)} />
      ))}
    </View>
  );
}

function Toast({ msg, onDismiss }: { msg: string; onDismiss: () => void }) {
  const tx = useRef(new Animated.Value(SCREEN_W)).current;

  useEffect(() => {
    Animated.timing(tx, {
      toValue: 0,
      duration: ANIM_MS,
      useNativeDriver: true,
    }).start();

    const t = setTimeout(slideOut, AUTO_CLOSE);
    return () => clearTimeout(t);
  }, []);

  function slideOut() {
    Animated.timing(tx, {
      toValue: SCREEN_W,
      duration: ANIM_MS,
      useNativeDriver: true,
    }).start(onDismiss);
  }

  const displayMsg = msg.length > 120 ? msg.slice(0, 117) + "…" : msg;

  return (
    <Animated.View style={[s.toast, { transform: [{ translateX: tx }] }]}>
      <View style={s.bar} />
      <View style={s.body}>
        <Text style={s.label} numberOfLines={3}>{displayMsg}</Text>
      </View>
      <TouchableOpacity style={s.close} onPress={slideOut} hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}>
        <Text style={s.closeText}>✕</Text>
      </TouchableOpacity>
    </Animated.View>
  );
}

const s = StyleSheet.create({
  container: {
    position:   "absolute",
    right:      12,
    zIndex:     9999,
    gap:        8,
    alignItems: "flex-end",
  },
  toast: {
    flexDirection:   "row",
    alignItems:      "stretch",
    backgroundColor: "#1a0a0a",
    borderRadius:    10,
    borderWidth:     1,
    borderColor:     "#7f1d1d",
    width:           SCREEN_W * 0.82,
    shadowColor:     "#000",
    shadowOffset:    { width: 0, height: 2 },
    shadowOpacity:   0.5,
    shadowRadius:    6,
    elevation:       8,
  },
  bar: {
    width:               4,
    backgroundColor:     "#ef4444",
    borderTopLeftRadius: 10,
    borderBottomLeftRadius: 10,
  },
  body: {
    flex:            1,
    paddingVertical: 10,
    paddingLeft:     10,
    paddingRight:    4,
  },
  label: {
    color:      "#fca5a5",
    fontSize:   12,
    lineHeight: 17,
    fontFamily: "monospace",
  },
  close: {
    paddingHorizontal: 10,
    justifyContent:    "center",
  },
  closeText: {
    color:    "#7f1d1d",
    fontSize: 14,
  },
});
