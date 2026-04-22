import React, { useEffect, useRef, useState } from "react";
import {
  View, Text, TouchableOpacity, StyleSheet, Animated, Dimensions, ScrollView,
} from "react-native";
import MCI from "react-native-vector-icons/MaterialCommunityIcons";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import type { CompositeScreenProps } from "@react-navigation/native";
import type { StackScreenProps } from "@react-navigation/stack";
import type { BottomTabScreenProps } from "@react-navigation/bottom-tabs";
import type { TabParams, RootStackParams } from "../navigation/AppNavigator";
import { useBLE } from "../ble/useBLE";
import { WRISTTURN_NAME } from "../ble/constants";
import { registry } from "../devices/registry/DeviceRegistry";
import { AndroidTV } from "../../modules/androidtv";
import type { DeviceMetadata } from "../types";
import { BatteryWave } from "../ui/BatteryWave";

type Props = CompositeScreenProps<
  BottomTabScreenProps<TabParams, "Home">,
  StackScreenProps<RootStackParams>
>;

const { width: SCREEN_W } = Dimensions.get("window");

// Max devices per ring before adding a concentric ring
const RING_CAPACITY = 8;
// Radii for concentric rings (inner → outer)
const RING_RADII = [SCREEN_W * 0.28, SCREEN_W * 0.42, SCREEN_W * 0.50];
const CHAR_WIDTH_PX = 7; // approx px per character at fontSize 11

const TRANSPORT_ICON: Record<string, string> = {
  androidtv: "television-play",
  wiz:       "lightbulb-on",
  macdaemon: "monitor",
  http:      "web",
  tcp:       "lan-connect",
  websocket: "transit-connection-variant",
};

function transportIconName(t: string): string {
  return TRANSPORT_ICON[t] ?? "flash";
}

/** Split devices into concentric rings, inner ring first */
function buildRings(devices: DeviceMetadata[]): DeviceMetadata[][] {
  const rings: DeviceMetadata[][] = [];
  let remaining = [...devices];
  for (let ri = 0; remaining.length > 0; ri++) {
    const cap = RING_CAPACITY;
    rings.push(remaining.splice(0, cap));
  }
  return rings;
}

/** Max chars that fit in an arc segment of radius r with n items */
function maxChars(r: number, n: number): number {
  const arcLen = (2 * Math.PI * r) / n;
  return Math.max(3, Math.floor(arcLen / CHAR_WIDTH_PX) - 1);
}

function truncate(str: string, max: number): string {
  if (str.length <= max) return str;
  return str.slice(0, max - 1) + "…";
}

// Flat list row
function DeviceRow({
  dev, selected, onPress, onMap,
}: { dev: DeviceMetadata; selected: boolean; onPress: () => void; onMap: () => void }) {
  return (
    <TouchableOpacity
      style={[ls.row, selected && ls.rowSelected]}
      onPress={onPress}
      activeOpacity={0.75}
    >
      <MCI name={transportIconName(dev.transport)} size={26} color="#4a9eff" style={ls.rowIcon} />
      <View style={ls.rowBody}>
        <Text style={ls.rowName} numberOfLines={1}>{dev.name}</Text>
        <Text style={ls.rowSub} numberOfLines={1}>{dev.host}</Text>
      </View>
      <TouchableOpacity style={ls.mapBtn} onPress={onMap}>
        <Text style={ls.mapBtnText}>Map</Text>
      </TouchableOpacity>
    </TouchableOpacity>
  );
}

// Circular ring view
function CircleView({
  devices, selectedIdx, onSelect, onOpen, onMap, batteryPct, wristConnected,
}: {
  devices: DeviceMetadata[];
  selectedIdx: number;
  onSelect: (i: number) => void;
  onOpen: (dev: DeviceMetadata) => void;
  onMap: (dev: DeviceMetadata) => void;
  batteryPct: number | null;
  wristConnected: boolean;
}) {
  const rings = buildRings(devices);
  // flat index → ring + position
  const flatToRing: { ri: number; pi: number }[] = [];
  rings.forEach((ring, ri) => ring.forEach((_, pi) => flatToRing.push({ ri, pi })));

  const viewSize = SCREEN_W * 0.88;
  const cx = viewSize / 2;
  const cy = viewSize / 2;

  return (
    <View style={{ width: viewSize, height: viewSize }}>
      {/* Ring outlines */}
      {rings.map((_, ri) => (
        <View
          key={`ring-${ri}`}
          style={{
            position: "absolute",
            width: RING_RADII[ri] * 2,
            height: RING_RADII[ri] * 2,
            borderRadius: RING_RADII[ri],
            borderWidth: 1,
            borderColor: "#222",
            left: cx - RING_RADII[ri],
            top: cy - RING_RADII[ri],
          }}
        />
      ))}

      {/* Center: battery wave when connected, dot otherwise */}
      {wristConnected && batteryPct !== null ? (
        <View style={{ position: "absolute", left: cx - 22, top: cy - 22 }}>
          <BatteryWave pct={batteryPct} size={44} />
        </View>
      ) : (
        <View style={[cv.centerDot, { left: cx - 4, top: cy - 4 }]} />
      )}

      {/* Device nodes */}
      {flatToRing.map(({ ri, pi }, flatIdx) => {
        const dev = rings[ri][pi];
        const n = rings[ri].length;
        const r = RING_RADII[ri];
        const angle = (2 * Math.PI * pi) / n - Math.PI / 2; // start from top
        const nx = cx + r * Math.cos(angle);
        const ny = cy + r * Math.sin(angle);
        const isSelected = flatIdx === selectedIdx;
        const label = truncate(dev.name, maxChars(r, n));

        // Text sits just outside the node, pushed radially outward
        const labelR = r + 32;
        const lx = cx + labelR * Math.cos(angle);
        const ly = cy + labelR * Math.sin(angle);

        return (
          <React.Fragment key={dev.id}>
            <TouchableOpacity
              style={[cv.node, isSelected && cv.nodeSelected, { left: nx - 20, top: ny - 20 }]}
              onPress={() => { onSelect(flatIdx); onOpen(dev); }}
            >
              <MCI name={transportIconName(dev.transport)} size={22} color={isSelected ? "#4a9eff" : "#888"} />
            </TouchableOpacity>
            <TouchableOpacity
              onPress={() => { onSelect(flatIdx); onOpen(dev); }}
              onLongPress={() => onMap(dev)}
              style={{ position: "absolute", left: lx - 36, top: ly - 10, width: 72, alignItems: "center" }}
            >
              <Text
                style={[cv.nodeLabel, isSelected && cv.nodeLabelSelected]}
                numberOfLines={1}
              >
                {label}
              </Text>
            </TouchableOpacity>
          </React.Fragment>
        );
      })}
    </View>
  );
}

export function DiscoveryScreen({ navigation }: Props) {
  const [viewMode, setViewMode] = useState<"circle" | "list">("circle");
  const [devices, setDevices]   = useState<DeviceMetadata[]>([]);
  const [selectedIdx, setSelected] = useState(0);
  const connectingRef = useRef(false);
  const devicesRef    = useRef<DeviceMetadata[]>([]);
  const selectedRef   = useRef(0);
  const insets        = useSafeAreaInsets();
  const iconRot       = useRef(new Animated.Value(0)).current;

  const { connected, wristName, batteryPct } = useBLE({
    onGesture: (g) => {
      if (g === "turn_right") cycleDevice(1);
      if (g === "turn_left")  cycleDevice(-1);
      if (g === "tap" && devicesRef.current.length > 0)
        openDevice(devicesRef.current[selectedRef.current]);
    },
  });

  useEffect(() => {
    let current = 0;
    const id = setInterval(() => {
      current += 90;
      Animated.timing(iconRot, { toValue: current, duration: 400, useNativeDriver: true }).start();
    }, 5000);
    return () => clearInterval(id);
  }, []);

  useEffect(() => {
    registry.load().then(() => {
      const all = registry.all();
      setDevices(all);
      devicesRef.current = all;
    });
    const unsub = navigation.addListener("focus", () => {
      const all = registry.all();
      setDevices(all);
      devicesRef.current = all;
    });
    return unsub;
  }, [navigation]);

  function cycleDevice(dir: 1 | -1) {
    const total = devicesRef.current.length;
    if (total === 0) return;
    const next = ((selectedRef.current + dir) + total) % total;
    selectedRef.current = next;
    setSelected(next);
  }

  function openDevice(meta: DeviceMetadata) {
    if (meta.transport !== "androidtv") {
      navigation.navigate("ActiveControl", { deviceId: meta.id });
      return;
    }
    if (connectingRef.current) return;
    connectingRef.current = true;
    const subs: { remove(): void }[] = [];
    const onReady = AndroidTV.onReady(() => {
      subs.forEach((s) => s.remove());
      connectingRef.current = false;
      navigation.navigate("ActiveControl", { deviceId: meta.id });
    });
    const onError = AndroidTV.onError(() => {
      subs.forEach((s) => s.remove());
      connectingRef.current = false;
      navigation.navigate("Pairing", { deviceId: meta.id });
    });
    subs.push(onReady, onError);
    AndroidTV.connect(meta.host).catch(() => {
      subs.forEach((s) => s.remove());
      connectingRef.current = false;
      navigation.navigate("Pairing", { deviceId: meta.id });
    });
  }

  return (
    <View style={[s.container, { paddingTop: insets.top + 12 }]}>
      {/* Header */}
      <View style={s.headerRow}>
        <Animated.Image
          source={require("../../assets/icon.png")}
          style={[s.appIcon, {
            transform: [{ rotate: iconRot.interpolate({ inputRange: [0, 360], outputRange: ["0deg", "360deg"] }) }],
          }]}
        />
        <View style={s.headerRight}>
          <TouchableOpacity
            style={s.viewToggle}
            onPress={() => setViewMode((v) => v === "circle" ? "list" : "circle")}
          >
            <Text style={s.viewToggleText}>{viewMode === "circle" ? "☰" : "◎"}</Text>
          </TouchableOpacity>
          <TouchableOpacity style={s.settingsBtn} onPress={() => navigation.navigate("Settings")}>
            <Text style={s.settingsBtnText}>⚙</Text>
          </TouchableOpacity>
        </View>
      </View>

      {/* Wrist status */}
      <View style={s.wristRow}>
        <Text style={s.wristName}>{connected ? (wristName || WRISTTURN_NAME) : WRISTTURN_NAME}</Text>
        <View style={[s.pill, connected ? s.pillOn : s.pillOff]}>
          <Text style={s.pillText}>{connected ? "Connected" : "Scanning..."}</Text>
        </View>
      </View>

      {/* Content area */}
      <View style={s.contentArea}>
        {devices.length === 0 ? (
          <View style={s.emptyCard}>
            <Text style={s.emptyIcon}>+</Text>
            <Text style={s.emptyText}>No devices</Text>
            <Text style={s.emptySub}>Tap ⚙ to add one</Text>
          </View>
        ) : viewMode === "circle" ? (
          <View style={s.circleWrapper}>
            <CircleView
              devices={devices}
              selectedIdx={selectedIdx}
              onSelect={(i) => { selectedRef.current = i; setSelected(i); }}
              onOpen={openDevice}
              onMap={(dev) => navigation.navigate("GestureMapping", { deviceId: dev.id })}
              batteryPct={batteryPct}
              wristConnected={connected}
            />
            <Text style={s.hint}>roll ← → · tap to open · long-press to map</Text>
          </View>
        ) : (
          <ScrollView style={s.listArea} showsVerticalScrollIndicator={false}>
            {devices.map((dev, i) => (
              <DeviceRow
                key={dev.id}
                dev={dev}
                selected={i === selectedIdx}
                onPress={() => { selectedRef.current = i; setSelected(i); openDevice(dev); }}
                onMap={() => navigation.navigate("GestureMapping", { deviceId: dev.id })}
              />
            ))}
          </ScrollView>
        )}
      </View>
    </View>
  );
}

// Circle view styles
const cv = StyleSheet.create({
  centerDot:        { position: "absolute", width: 8, height: 8, borderRadius: 4, backgroundColor: "#333" },
  node:             { position: "absolute", width: 40, height: 40, borderRadius: 20, backgroundColor: "#1c1c1c", borderWidth: 1, borderColor: "#333", justifyContent: "center", alignItems: "center" },
  nodeSelected:     { backgroundColor: "#1e3a5f", borderColor: "#4a9eff", width: 48, height: 48, borderRadius: 24, left: -4, top: -4 },
  nodeIcon:         { fontSize: 10 },
  nodeLabel:        { fontSize: 11, color: "#777", textAlign: "center" },
  nodeLabelSelected:{ color: "#4a9eff", fontWeight: "600" },
});

// List view styles
const ls = StyleSheet.create({
  row:         { flexDirection: "row", alignItems: "center", backgroundColor: "#1c1c1c", borderRadius: 10, padding: 14, marginBottom: 8 },
  rowSelected: { borderColor: "#4a9eff", borderWidth: 1 },
  rowIcon:     { fontSize: 22, marginRight: 12 },
  rowBody:     { flex: 1 },
  rowName:     { fontSize: 15, color: "#fff", fontWeight: "600" },
  rowSub:      { fontSize: 11, color: "#555", marginTop: 2 },
  mapBtn:      { backgroundColor: "#111", borderRadius: 6, paddingHorizontal: 10, paddingVertical: 6 },
  mapBtnText:  { color: "#4a9eff", fontSize: 12 },
});

const s = StyleSheet.create({
  container:      { flex: 1, backgroundColor: "#0f0f0f", padding: 16 },
  headerRow:      { flexDirection: "row", justifyContent: "space-between", alignItems: "center", marginBottom: 16 },
  appIcon:        { width: 32, height: 32, borderRadius: 8 },
  headerRight:    { flexDirection: "row", gap: 8, alignItems: "center" },
  viewToggle:     { backgroundColor: "#1c1c1c", width: 38, height: 38, borderRadius: 10, justifyContent: "center", alignItems: "center" },
  viewToggleText: { color: "#aaa", fontSize: 18 },
  settingsBtn:    { backgroundColor: "#1c1c1c", width: 38, height: 38, borderRadius: 10, justifyContent: "center", alignItems: "center" },
  settingsBtnText:{ color: "#aaa", fontSize: 20 },

  wristRow:       { flexDirection: "row", justifyContent: "space-between", alignItems: "center", marginBottom: 20 },
  wristName:      { fontSize: 15, color: "#888" },
  pill:           { paddingHorizontal: 10, paddingVertical: 3, borderRadius: 10 },
  pillOn:         { backgroundColor: "#1a7f4b" },
  pillOff:        { backgroundColor: "#333" },
  pillText:       { color: "#fff", fontSize: 12 },

  contentArea:    { flex: 1, justifyContent: "center", alignItems: "center" },
  circleWrapper:  { alignItems: "center" },
  listArea:       { width: "100%" },

  emptyCard:      { width: SCREEN_W * 0.62, aspectRatio: 1 / 0.72, borderRadius: 20, backgroundColor: "#1c1c1c", justifyContent: "center", alignItems: "center", gap: 8, borderWidth: 1, borderColor: "#2a2a2a", borderStyle: "dashed" },
  emptyIcon:      { fontSize: 36, color: "#333" },
  emptyText:      { fontSize: 16, color: "#444" },
  emptySub:       { fontSize: 12, color: "#333" },

  hint:           { fontSize: 11, color: "#333", marginTop: 16, letterSpacing: 0.5 },
});
