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
import { startCalibration, armDevice, disarmDevice, confirmBaselineReady, sendBaselineToFirmware } from "../ble/useBLE";
import { BaselineStore } from "../storage/BaselineStore";
import { CalibrationOverlay } from "./CalibrationOverlay";
import { WRISTTURN_NAME } from "../ble/constants";
import { registry } from "../devices/registry/DeviceRegistry";
import { AndroidTV } from "../../modules/androidtv";
import type { DeviceMetadata, Baseline, DiscStateValue } from "../types";
import { DiscState, Gesture, ArmPose } from "../types";
import { BatteryWave } from "../ui/BatteryWave";
import { PoseHUD } from "../ui/PoseHUD";

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

const PULSE_COUNT    = 3;
const PULSE_DURATION = 1800;
const PULSE_STAGGER  = 600;
const PULSE_RADIUS   = SCREEN_W * 0.40;

function PulseRings({ active }: { active: boolean }) {
  const anims = useRef(Array.from({ length: PULSE_COUNT }, () => new Animated.Value(0))).current;
  const loops = useRef<Animated.CompositeAnimation[]>([]);

  useEffect(() => {
    loops.current.forEach(l => l.stop());
    anims.forEach(a => a.setValue(0));
    if (!active) return;

    loops.current = anims.map((anim) =>
      Animated.loop(Animated.timing(anim, { toValue: 1, duration: PULSE_DURATION, useNativeDriver: true }))
    );
    const timeouts = loops.current.map((loop, i) => setTimeout(() => loop.start(), i * PULSE_STAGGER));
    return () => {
      timeouts.forEach(clearTimeout);
      loops.current.forEach(l => l.stop());
    };
  }, [active]);

  const size = PULSE_RADIUS * 2;
  return (
    <View style={{ position: "absolute", width: size, height: size,
                   left: -PULSE_RADIUS, top: -PULSE_RADIUS, pointerEvents: "none" }}>
      {anims.map((anim, i) => {
        const scale   = anim.interpolate({ inputRange: [0, 1], outputRange: [0.05, 1] });
        const opacity = anim.interpolate({ inputRange: [0, 0.12, 0.75, 1], outputRange: [0, 0.55, 0.18, 0] });
        return (
          <Animated.View key={i} style={{
            position: "absolute", width: size, height: size,
            borderRadius: PULSE_RADIUS, borderWidth: 1.2, borderColor: "#4a9eff",
            opacity, transform: [{ scale }],
          }} />
        );
      })}
    </View>
  );
}

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
  devices, selectedIdx, onSelect, onOpen, onMap, batteryPct, wristConnected, pulsing,
}: {
  devices: DeviceMetadata[];
  selectedIdx: number;
  onSelect: (i: number) => void;
  onOpen: (dev: DeviceMetadata) => void;
  onMap: (dev: DeviceMetadata) => void;
  batteryPct: number | null;
  wristConnected: boolean;
  pulsing: boolean;
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

      {/* Pulse rings — behind everything, centered */}
      <View style={{ position: "absolute", left: cx, top: cy }}>
        <PulseRings active={pulsing} />
      </View>

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

const RAISE_CONFIRM_MS = 1000;  // arm must stay not-hanging for 1s before entering browse
const HANG_EXIT_MS     = 1500;  // hanging held for 1.5s exits browse

export function DiscoveryScreen({ navigation }: Props) {
  const [viewMode, setViewMode] = useState<"circle" | "list">("circle");
  const [devices, setDevices]   = useState<DeviceMetadata[]>([]);
  const [selectedIdx, setSelected] = useState(0);
  const [discState, setDiscState] = useState<DiscStateValue>(DiscState.IDLE);
  const [storedBaseline, setStoredBaseline] = useState<Baseline | null>(null);
  const connectingRef  = useRef(false);
  const devicesRef     = useRef<DeviceMetadata[]>([]);
  const selectedRef    = useRef(0);
  const discStateRef   = useRef(discState);
  const dropTimerRef   = useRef<ReturnType<typeof setTimeout> | null>(null);
  const insets         = useSafeAreaInsets();
  const iconRot        = useRef(new Animated.Value(0)).current;

  // ── State logger ─────────────────────────────────────────────────────────
  const log = (...args: unknown[]) => console.log("[Discovery]", ...args);

  // Keep discStateRef in sync
  useEffect(() => { discStateRef.current = discState; }, [discState]);

  // Stable gesture handler — reads discState via ref, no dependency churn
  const handleGesture = React.useCallback((g: string) => {
    const ds = discStateRef.current;
    switch (ds) {
      case "calibrating":
        if (g === Gesture.SHAKE) {
          disarmDevice().catch(() => {});
          setDiscState(DiscState.IDLE);
        }
        break;
      case "wait_raised":
        if (g === Gesture.PITCH_DOWN && devicesRef.current.length > 0) {
          setDiscState(DiscState.BROWSING);
          openDevice(devicesRef.current[selectedRef.current]);
        }
        break;
      case "browsing":
        if (g === Gesture.TURN_RIGHT || g === Gesture.TURN_LEFT) {
          const dir = g === Gesture.TURN_RIGHT ? 1 : -1;
          cycleDevice(dir);
        } else if (g === Gesture.PITCH_DOWN && devicesRef.current.length > 0) {
          openDevice(devicesRef.current[selectedRef.current]);
        } else if (g === Gesture.SHAKE) {
          setDiscState(DiscState.WAIT_RAISED);
        }
        break;
      case "tracking":
        if (g === Gesture.SHAKE) {
          navigation.goBack();
        }
        break;
      default:
        break;
    }
  }, []); // stable — reads state via ref

  const ble = useBLE({ onGesture: handleGesture });
  const { connected, wristName, wristAddress, batteryPct, motionState, pose, sleeping, baselineCandidate, armPose } = ble;

  useEffect(() => {
    log(`discState → ${discState} | connected=${connected} | baseline=${!!storedBaseline} | motion=${motionState} | sleeping=${sleeping}`);
  }, [discState, connected, storedBaseline, motionState, sleeping]);

  // Icon rotation
  useEffect(() => {
    let current = 0;
    const id = setInterval(() => {
      current += 90;
      Animated.timing(iconRot, { toValue: current, duration: 400, useNativeDriver: true }).start();
    }, 5000);
    return () => clearInterval(id);
  }, []);

  // Device registry: load on mount, refresh on focus
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

  // E1: Connect/disconnect
  useEffect(() => {
    if (!connected) {
      log("E1: disconnected → idle");
      setStoredBaseline(null);
      setDiscState(DiscState.IDLE);
      return;
    }
    log(`E1: connected wristAddress=${wristAddress}, loading baseline...`);
    BaselineStore.load(wristAddress).then((b) => {
      log(`E1: baseline ${b ? "found" : "null"}`);
      setStoredBaseline(b);
      if (b) {
        // E8 only fires on focus transitions — by the time this async load completes
        // the screen is already focused and the event won't re-fire. Send here instead.
        sendBaselineToFirmware(b).catch((e) => log(`E1: sendBaseline error: ${e}`));
        setDiscState(DiscState.WAIT_RAISED);
      }
    }).catch((e) => {
      log(`E1: BaselineStore error: ${e}`);
      setStoredBaseline(null);
    });
  }, [connected, wristAddress]);

  // E2: No baseline → calibrate
  useEffect(() => {
    if (connected && !storedBaseline && discState !== DiscState.CALIBRATING) {
      log("E2: no baseline → calibrating");
      setDiscState(DiscState.CALIBRATING);
      startCalibration();
    }
  }, [connected, storedBaseline, discState]);

  // E3: Calibration complete
  useEffect(() => {
    if (discState !== DiscState.CALIBRATING || !baselineCandidate) return;
    log("E3: baseline candidate received, saving");
    const baseline: Baseline = {
      roll: baselineCandidate.roll,
      pitch: baselineCandidate.pitch,
      yaw: baselineCandidate.yaw,
      timestamp: Date.now(),
      wristName: wristName || "",
      wristAddress: wristAddress || "",
    };
    BaselineStore.save(wristAddress, baseline).then(() => {
      setStoredBaseline(baseline);
      return sendBaselineToFirmware(baseline);
    }).then(() => {
      confirmBaselineReady();
      return armDevice();
    }).then(() => {
      log("E3: done → wait_raised");
      setDiscState(DiscState.WAIT_RAISED);
    }).catch((e) => log(`E3: ERROR: ${e}`));
  }, [discState, baselineCandidate, wristName, wristAddress]);

  // E4: wait_raised → browsing when arm is not hanging (flat or raised = device in use).
  // "raised" (steep angle) and "flat" (horizontal use) both count — only hanging means done.
  // Requires pose to hold for RAISE_CONFIRM_MS to avoid transient triggers.
  useEffect(() => {
    if (discState !== DiscState.WAIT_RAISED || armPose === null) return;
    if (armPose === ArmPose.HANGING) return;
    log(`E4: armPose=${armPose} → confirm ${RAISE_CONFIRM_MS}ms`);
    const t = setTimeout(() => {
      log("E4: confirmed → browsing");
      setDiscState(DiscState.BROWSING);
    }, RAISE_CONFIRM_MS);
    return () => clearTimeout(t);
  }, [armPose, discState]);

  // E5: browsing → wait_raised when arm hangs by side (definitive done signal).
  // flat = device still in use (on desk, armrest, pointing at screen) — don't exit.
  // hanging = arm dropped fully to side — exit after HANG_EXIT_MS.
  useEffect(() => {
    if (discState !== DiscState.BROWSING) {
      if (dropTimerRef.current) { clearTimeout(dropTimerRef.current); dropTimerRef.current = null; }
      return;
    }
    if (armPose !== ArmPose.HANGING) {
      if (dropTimerRef.current) { clearTimeout(dropTimerRef.current); dropTimerRef.current = null; }
      return;
    }
    if (!dropTimerRef.current) {
      log(`E5: armPose=hanging, exit timer ${HANG_EXIT_MS}ms`);
      dropTimerRef.current = setTimeout(() => {
        log("E5: timer fired → wait_raised");
        dropTimerRef.current = null;
        setDiscState(DiscState.WAIT_RAISED);
      }, HANG_EXIT_MS);
    }
  }, [armPose, discState]);

  // E6: Sleeping → idle
  useEffect(() => {
    if (sleeping && discState !== DiscState.IDLE) {
      log("E6: sleeping → idle");
      setDiscState(DiscState.IDLE);
    }
  }, [sleeping, discState]);

  // E7: Arm control per discState
  useEffect(() => {
    if (discState === DiscState.IDLE) {
      log("E7: idle → disarm");
      disarmDevice().catch(() => {});
    } else {
      log(`E7: ${discState} → arm`);
      armDevice().catch((e) => log(`E7: armDevice error: ${e}`));
    }
  }, [discState]);

  // E8: Focus — re-send baseline to firmware, or trigger recalibration if cleared in settings
  useEffect(() => {
    const unsub = navigation.addListener("focus", () => {
      if (connected) {
        BaselineStore.load(wristAddress).then((b) => {
          setStoredBaseline(b);
          if (b) {
            sendBaselineToFirmware(b).catch(() => {});
          } else if (discStateRef.current !== DiscState.CALIBRATING) {
            log("E8: baseline missing on focus → triggering recalibration");
            setDiscState(DiscState.CALIBRATING);
            startCalibration();
          } else {
            // discState is already CALIBRATING — discState won't change so E7 won't
            // re-fire. Call startCalibration() directly: it now arms the device, which
            // is what may have been missing (e.g. user cleared baseline mid-session,
            // or reconnect after sleep landed in an already-CALIBRATING discState).
            log("E8: already calibrating on focus → re-arm device");
            startCalibration();
          }
        });
      }
      if (discStateRef.current === DiscState.TRACKING) setDiscState(DiscState.BROWSING);
    });
    return unsub;
  }, [navigation, connected, wristAddress]);

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      if (dropTimerRef.current) { clearTimeout(dropTimerRef.current); dropTimerRef.current = null; }
    };
  }, []);

  function cycleDevice(dir: 1 | -1) {
    const total = devicesRef.current.length;
    if (total === 0) return;
    const next = ((selectedRef.current + dir) + total) % total;
    selectedRef.current = next;
    setSelected(next);
  }

  function openDevice(meta: DeviceMetadata) {
    setDiscState(DiscState.TRACKING);
    if (meta.transport !== "androidtv") {
      navigation.navigate("ActiveControl", { deviceId: meta.id, homeBaseline: storedBaseline });
      return;
    }
    if (connectingRef.current) return;
    connectingRef.current = true;
    const subs: { remove(): void }[] = [];
    const onReady = AndroidTV.onReady(() => {
      subs.forEach((s) => s.remove());
      connectingRef.current = false;
      navigation.navigate("ActiveControl", { deviceId: meta.id, homeBaseline: storedBaseline });
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

  // Status text based on discState
  function getStateHint(): string {
    switch (discState) {
      case "calibrating":  return "Calibrating... hold still";
      case "wait_raised":  return connected ? "Raise arm to browse" : "Scanning...";
      case "browsing":     return "Browse active • pitch down to select";
      case "tracking":     return "Device selected";
      default:             return connected ? "Connected" : "Scanning...";
    }
  }

  return (
    <View style={[s.container, { paddingTop: insets.top + 12 }]}>
      {/* Calibration Overlay */}
      <CalibrationOverlay
        visible={discState === DiscState.CALIBRATING}
        onSkip={() => { disarmDevice().catch(() => {}); setDiscState(DiscState.WAIT_RAISED); }}
      />

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
          <React.Fragment>
          <View style={s.circleWrapper}>
            <CircleView
              devices={devices}
              selectedIdx={selectedIdx}
              onSelect={(i) => { selectedRef.current = i; setSelected(i); }}
              onOpen={openDevice}
              onMap={(dev) => navigation.navigate("GestureMapping", { deviceId: dev.id })}
              batteryPct={batteryPct}
              wristConnected={connected}
              pulsing={discState === DiscState.BROWSING}
            />
            {connected && (
              <View style={[s.browseBar, discState === DiscState.BROWSING && s.browseBarActive]}>
                <Text style={[s.hint, discState === DiscState.BROWSING && s.hintActive]}>
                  {getStateHint()}
                </Text>
              </View>
            )}
          </View>
          {/* Pose HUD */}
          {connected && pose && storedBaseline && <PoseHUD pose={pose} />}
          </React.Fragment>
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

  browseBar:      { marginTop: 16, paddingHorizontal: 14, paddingVertical: 6, borderRadius: 20, borderWidth: 1, borderColor: "transparent" },
  browseBarActive:{ borderColor: "#4a9eff33", backgroundColor: "#4a9eff11" },
  hint:           { fontSize: 11, color: "#333", letterSpacing: 0.5, textAlign: "center" },
  hintActive:     { color: "#4a9eff" },
});

