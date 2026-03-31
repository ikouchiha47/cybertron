import React from "react";
import { View } from "react-native";
import { GestureHandlerRootView } from "react-native-gesture-handler";
import { SafeAreaProvider } from "react-native-safe-area-context";
import { AppNavigator } from "./src/navigation/AppNavigator";
import { DebugOverlay } from "./src/debug/DebugOverlay";

export default function App() {
  return (
    <GestureHandlerRootView style={{ flex: 1 }}>
      <SafeAreaProvider>
        <View style={{ flex: 1 }}>
          <AppNavigator />
          <DebugOverlay />
        </View>
      </SafeAreaProvider>
    </GestureHandlerRootView>
  );
}
