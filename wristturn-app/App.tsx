import React, { useEffect } from "react";
import { Platform, PermissionsAndroid, Linking } from "react-native";
import { GestureHandlerRootView } from "react-native-gesture-handler";
import { SafeAreaProvider } from "react-native-safe-area-context";
import { AppNavigator } from "./src/navigation/AppNavigator";
import { BLEServiceNative } from "./src/ble/BLEServiceNative";
import { DebugLog }         from "./src/debug/DebugLog";
import { registry } from "./src/devices/registry/DeviceRegistry";
import { DEFAULT_PORT } from "./src/types";
import type { TransportType } from "./src/types";

const VALID_TRANSPORTS: TransportType[] = ["androidtv", "http", "websocket", "tcp", "macdaemon", "wiz"];

// Handles rune://add-device?host=X&port=Y&name=Z&transport=http links.
// Sole purpose: scripts/install-release.sh uses these to seed the
// device-simulator's fleet into the saved-devices list after a fresh
// install, since a release build's AsyncStorage isn't writable via adb
// without root. Not used anywhere else — safe to ignore for normal use.
function handleDeepLink(url: string | null) {
  if (!url || !url.startsWith("rune://add-device")) return;
  try {
    const query = url.split("?")[1] ?? "";
    const params = new URLSearchParams(query);
    const host = params.get("host")?.trim();
    if (!host) return;
    const transportParam = params.get("transport") ?? "http";
    const transport: TransportType = VALID_TRANSPORTS.includes(transportParam as TransportType)
      ? (transportParam as TransportType)
      : "http";
    const port = parseInt(params.get("port") ?? "", 10) || DEFAULT_PORT[transport];
    const name = params.get("name")?.trim() || host;
    const id = `manual:${host}:${port}`;
    registry.register({ id, name, host, port, transport, availableCommands: [] })
      .catch((e) => console.error("[DeepLink] register failed:", e));
  } catch (e) {
    console.error("[DeepLink] parse failed:", url, e);
  }
}

async function requestBLEPermissions() {
  if (Platform.OS !== "android") return;
  if (Platform.Version >= 31) {
    // Android 12+ — need BLUETOOTH_SCAN + BLUETOOTH_CONNECT
    await PermissionsAndroid.requestMultiple([
      PermissionsAndroid.PERMISSIONS.BLUETOOTH_SCAN,
      PermissionsAndroid.PERMISSIONS.BLUETOOTH_CONNECT,
    ]);
  } else {
    // Android < 12 — BLE scan requires location
    await PermissionsAndroid.request(
      PermissionsAndroid.PERMISSIONS.ACCESS_FINE_LOCATION
    );
  }
}

export default function App() {
  useEffect(() => {
    // Recover any logs/active/<id>/ directories left behind by a previous
    // run that did not call DebugLog.stopSession (app crash, force-close).
    // Idempotent — safe to call every launch.
    DebugLog.init().catch(console.error);
    requestBLEPermissions()
      .then(() => BLEServiceNative.start())
      .catch(console.error);

    Linking.getInitialURL().then(handleDeepLink).catch(() => {});
    const sub = Linking.addEventListener("url", ({ url }) => handleDeepLink(url));
    return () => sub.remove();
  }, []);

  return (
    <GestureHandlerRootView style={{ flex: 1 }}>
      <SafeAreaProvider>
        <AppNavigator />
      </SafeAreaProvider>
    </GestureHandlerRootView>
  );
}
