import React from "react";
import { NavigationContainer } from "@react-navigation/native";
import { createStackNavigator } from "@react-navigation/stack";
import { createBottomTabNavigator } from "@react-navigation/bottom-tabs";
import MCI from "react-native-vector-icons/MaterialCommunityIcons";
import { DiscoveryScreen } from "../screens/DiscoveryScreen";
import { GestureMappingScreen } from "../screens/GestureMappingScreen";
import { ActiveControlScreen } from "../screens/ActiveControlScreen";
import { PairingScreen } from "../screens/PairingScreen";
import { SettingsScreen } from "../screens/SettingsScreen";
import { WizProvisionScreen } from "../screens/WizProvisionScreen";
import { LogsScreen } from "../screens/LogsScreen";
import { SessionScreen } from "../screens/SessionScreen";
import type { Baseline } from "../types";

export type TabParams = {
  Home:     undefined;
  Settings: undefined;
  Logs:     undefined;
  Sessions: undefined;
};

export type RootStackParams = {
  Tabs:          undefined;
  GestureMapping: { deviceId: string };
  ActiveControl:  { deviceId: string; homeBaseline?: Baseline | null };
  Pairing:        { deviceId: string };
  WizProvision:   undefined;
};

const Tab   = createBottomTabNavigator<TabParams>();
const Stack = createStackNavigator<RootStackParams>();

const stackOptions = {
  headerStyle:     { backgroundColor: "#0f0f0f" },
  headerTintColor: "#fff",
  cardStyle:       { backgroundColor: "#0f0f0f" },
};

function TabNavigator() {
  return (
    <Tab.Navigator
      screenOptions={{
        headerShown:     false,
        tabBarStyle:     { backgroundColor: "#0f0f0f", borderTopColor: "#1c1c1c" },
        tabBarActiveTintColor:   "#4a9eff",
        tabBarInactiveTintColor: "#555",
      }}
    >
      <Tab.Screen
        name="Home"
        component={DiscoveryScreen}
        options={{ tabBarIcon: ({ color, size }) => <MCI name="view-dashboard" color={color} size={size} /> }}
      />
      <Tab.Screen
        name="Settings"
        component={SettingsScreen}
        options={{ tabBarIcon: ({ color, size }) => <MCI name="cog" color={color} size={size} /> }}
      />
      <Tab.Screen
        name="Logs"
        component={LogsScreen}
        options={{ tabBarIcon: ({ color, size }) => <MCI name="text-box-outline" color={color} size={size} /> }}
      />
      <Tab.Screen
        name="Sessions"
        component={SessionScreen}
        options={{ tabBarIcon: ({ color, size }) => <MCI name="record-circle-outline" color={color} size={size} /> }}
      />
    </Tab.Navigator>
  );
}

export function AppNavigator() {
  return (
    <NavigationContainer>
      <Stack.Navigator screenOptions={stackOptions}>
        <Stack.Screen name="Tabs"           component={TabNavigator}         options={{ headerShown: false }} />
        <Stack.Screen name="GestureMapping" component={GestureMappingScreen} options={{ title: "Map Gestures" }} />
        <Stack.Screen name="ActiveControl"  component={ActiveControlScreen}  options={{ title: "" }} />
        <Stack.Screen name="Pairing"        component={PairingScreen}        options={{ title: "Pair Device" }} />
        <Stack.Screen name="WizProvision"   component={WizProvisionScreen}   options={{ title: "Add Smart Bulb" }} />
      </Stack.Navigator>
    </NavigationContainer>
  );
}
