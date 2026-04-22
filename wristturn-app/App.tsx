import React, { useEffect } from "react";
import { Platform, PermissionsAndroid } from "react-native";
import { GestureHandlerRootView } from "react-native-gesture-handler";
import { SafeAreaProvider } from "react-native-safe-area-context";
import { AppNavigator } from "./src/navigation/AppNavigator";
import { BLEServiceNative } from "./src/ble/BLEServiceNative";

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
    requestBLEPermissions()
      .then(() => BLEServiceNative.start())
      .catch(console.error);
  }, []);

  return (
    <GestureHandlerRootView style={{ flex: 1 }}>
      <SafeAreaProvider>
        <AppNavigator />
      </SafeAreaProvider>
    </GestureHandlerRootView>
  );
}
