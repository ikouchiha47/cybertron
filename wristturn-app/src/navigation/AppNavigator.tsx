import React from "react";
import { NavigationContainer } from "@react-navigation/native";
import { createStackNavigator } from "@react-navigation/stack";
import { DiscoveryScreen } from "../screens/DiscoveryScreen";
import { GestureMappingScreen } from "../screens/GestureMappingScreen";
import { ActiveControlScreen } from "../screens/ActiveControlScreen";
import { PairingScreen } from "../screens/PairingScreen";
import { SettingsScreen } from "../screens/SettingsScreen";

export type RootStackParams = {
  Discovery:      undefined;
  Settings:       undefined;
  GestureMapping: { deviceId: string };
  ActiveControl:  { deviceId: string };
  Pairing:        { deviceId: string };
};

const Stack = createStackNavigator<RootStackParams>();

export function AppNavigator() {
  return (
    <NavigationContainer>
      <Stack.Navigator
        screenOptions={{
          headerStyle:      { backgroundColor: "#0f0f0f" },
          headerTintColor:  "#fff",
          cardStyle:        { backgroundColor: "#0f0f0f" },
        }}
      >
        <Stack.Screen name="Discovery"      component={DiscoveryScreen}      options={{ title: "WristTurn" }} />
        <Stack.Screen name="Settings"       component={SettingsScreen}       options={{ title: "Devices & Settings" }} />
        <Stack.Screen name="GestureMapping" component={GestureMappingScreen} options={{ title: "Map Gestures" }} />
        <Stack.Screen name="ActiveControl"  component={ActiveControlScreen}  options={{ title: "" }} />
        <Stack.Screen name="Pairing"        component={PairingScreen}        options={{ title: "Pair Device" }} />
      </Stack.Navigator>
    </NavigationContainer>
  );
}
