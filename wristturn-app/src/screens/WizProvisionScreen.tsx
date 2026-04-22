import React, { useEffect, useState } from "react";
import {
  View, Text, TextInput, TouchableOpacity, StyleSheet,
  ActivityIndicator, Linking, ScrollView,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import WifiManager from "react-native-wifi-reborn";
import { Picker } from "@react-native-picker/picker";
import type { StackScreenProps } from "@react-navigation/stack";
import type { RootStackParams } from "../navigation/AppNavigator";
import { BULB_PROVISIONERS } from "../devices/provisioning/registry";
import type { IBulbProvisioner } from "../devices/provisioning/IBulbProvisioner";
import { WIZ_COMMANDS } from "../devices/adapters/WizAdapter";
import { WIZ_PORT } from "../devices/adapters/wizUdp";
import { registry } from "../devices/registry/DeviceRegistry";

function generateBulbName(brand: string): string {
  const n = Math.floor(10 + Math.random() * 9990); // 10–9999
  return `${brand.toUpperCase()}-${n}`;
}

type Props = StackScreenProps<RootStackParams, "WizProvision">;
type Step = "pick_brand" | "reset" | "connect_ap" | "enter_wifi" | "provisioning" | "scanning" | "done" | "error";

function commandsFor(brand: string) {
  if (brand === "wiz") return WIZ_COMMANDS;
  return [];
}

function portFor(brand: string) {
  if (brand === "wiz") return WIZ_PORT;
  return 38899;
}

export function WizProvisionScreen({ navigation }: Props) {
  const insets = useSafeAreaInsets();
  const [step, setStep] = useState<Step>("pick_brand");
  const [driver, setDriver] = useState<IBulbProvisioner | null>(null);
  const [ssid, setSsid] = useState("");
  const [password, setPassword] = useState("");
  const [bulbName, setBulbName] = useState("");
  const [errorMsg, setErrorMsg] = useState("");
  const [foundIp, setFoundIp] = useState("");
  const [wifiNetworks, setWifiNetworks] = useState<string[]>([]);
  const [scanningWifi, setScanningWifi] = useState(false);

  async function scanWifi() {
    setScanningWifi(true);
    try {
      const current = await WifiManager.getCurrentWifiSSID().catch(() => "");
      const list = await WifiManager.reScanAndLoadWifiList().catch(() => []);
      const ssids = Array.from(new Set([
        ...(current ? [current] : []),
        ...list.map((n: { SSID: string }) => n.SSID).filter(Boolean),
      ]));
      setWifiNetworks(ssids);
      if (current) setSsid(current);
    } finally {
      setScanningWifi(false);
    }
  }

  useEffect(() => { scanWifi(); }, []);

  function pickDriver(d: IBulbProvisioner) {
    setDriver(d);
    setBulbName(generateBulbName(d.brand));
    setStep("reset");
  }

  async function sendProvisionPacket() {
    if (!driver || !ssid.trim()) return;
    setStep("provisioning");
    try {
      await driver.sendCredentials(ssid.trim(), password);
      setStep("scanning");
      await new Promise((r) => setTimeout(r, 8000));
      await scanForBulb();
    } catch (e) {
      setErrorMsg(String(e));
      setStep("error");
    }
  }

  async function scanForBulb() {
    if (!driver) return;
    setStep("scanning");
    try {
      const found = await driver.discoverOnLan(6000);
      if (found.length === 0) {
        setErrorMsg("No bulbs found. Make sure your phone rejoined home WiFi, then try scanning again.");
        setStep("error");
        return;
      }
      const bulb = found[0];
      setFoundIp(bulb.ip);
      const name = bulbName.trim() || bulb.name || `${driver.label} (${bulb.ip})`;
      await registry.register({
        id: `${driver.brand}:${bulb.ip}`,
        name,
        host: bulb.ip,
        port: portFor(driver.brand),
        transport: driver.brand === "wiz" ? "wiz" : "http",
        availableCommands: commandsFor(driver.brand),
      });
      setStep("done");
    } catch (e) {
      setErrorMsg(String(e));
      setStep("error");
    }
  }

  const STEPS: Step[] = ["pick_brand", "reset", "connect_ap", "enter_wifi", "scanning", "done"];

  const content = () => {
    switch (step) {
      case "pick_brand":
        return (
          <>
            <Text style={s.title}>Add Smart Bulb</Text>
            <Text style={s.subtitle}>Select your bulb brand</Text>
            {BULB_PROVISIONERS.map((d) => (
              <TouchableOpacity key={d.brand} style={s.brandRow} onPress={() => pickDriver(d)}>
                <Text style={s.brandLabel}>{d.label}</Text>
                <Text style={s.chevron}>›</Text>
              </TouchableOpacity>
            ))}
          </>
        );

      case "reset":
        return (
          <>
            <Text style={s.title}>{driver?.label}</Text>
            <Text style={s.subtitle}>Put the bulb in setup mode</Text>
            {driver?.resetSteps.map((line, i) => (
              <View key={i} style={s.stepRow}>
                <Text style={s.stepNum}>{i + 1}</Text>
                <Text style={s.stepText}>{line}</Text>
              </View>
            ))}
            <TouchableOpacity style={s.btnSecondary} onPress={() => Linking.openSettings()}>
              <Text style={s.btnSecondaryText}>Open WiFi Settings</Text>
            </TouchableOpacity>
            <TouchableOpacity style={s.btn} onPress={() => setStep("enter_wifi")}>
              <Text style={s.btnText}>Connected to {driver?.apSsidPrefix}...  →</Text>
            </TouchableOpacity>
          </>
        );

      case "enter_wifi":
        return (
          <>
            <Text style={s.title}>Home WiFi</Text>
            <Text style={s.subtitle}>The bulb will join your 2.4 GHz network</Text>

            <View style={s.ssidHeader}>
              <Text style={s.fieldLabel}>Network (SSID)</Text>
              <TouchableOpacity onPress={scanWifi} disabled={scanningWifi}>
                {scanningWifi
                  ? <ActivityIndicator size="small" color="#4a9eff" />
                  : <Text style={s.rescanText}>Rescan</Text>}
              </TouchableOpacity>
            </View>
            <View style={s.pickerWrap}>
              <Picker
                selectedValue={ssid}
                onValueChange={(v) => setSsid(v)}
                style={s.picker}
                dropdownIconColor="#4a9eff"
              >
                {wifiNetworks.length === 0
                  ? <Picker.Item label="Scanning..." value="" color="#555" />
                  : wifiNetworks.map((n) => (
                      <Picker.Item key={n} label={n} value={n} color="#fff" />
                    ))}
              </Picker>
            </View>

            <Text style={s.fieldLabel}>Password</Text>
            <TextInput
              style={s.input}
              placeholder="WiFi password"
              placeholderTextColor="#555"
              value={password}
              onChangeText={setPassword}
              secureTextEntry
            />

            <Text style={s.fieldLabel}>Bulb name</Text>
            <TextInput
              style={s.input}
              value={bulbName}
              onChangeText={setBulbName}
              placeholder="e.g. WIZ-4821"
              placeholderTextColor="#555"
            />

            <TouchableOpacity
              style={[s.btn, !ssid.trim() && s.btnDisabled]}
              onPress={sendProvisionPacket}
              disabled={!ssid.trim()}
            >
              <Text style={s.btnText}>Connect Bulb  →</Text>
            </TouchableOpacity>
          </>
        );

      case "provisioning":
        return (
          <>
            <ActivityIndicator color="#4a9eff" size="large" />
            <Text style={s.body}>Sending credentials to bulb...</Text>
          </>
        );

      case "scanning":
        return (
          <>
            <ActivityIndicator color="#4a9eff" size="large" />
            <Text style={s.body}>Reconnect your phone to home WiFi, then wait.</Text>
            <TouchableOpacity style={s.btnSecondary} onPress={() => Linking.openSettings()}>
              <Text style={s.btnSecondaryText}>Open WiFi Settings</Text>
            </TouchableOpacity>
            <TouchableOpacity style={[s.btn, { marginTop: 8 }]} onPress={() => scanForBulb()}>
              <Text style={s.btnText}>Scan now</Text>
            </TouchableOpacity>
          </>
        );

      case "done":
        return (
          <>
            <Text style={s.successIcon}>✓</Text>
            <Text style={s.title}>Bulb Added!</Text>
            <Text style={s.body}>Found at {foundIp}. Control it with gestures.</Text>
            <TouchableOpacity style={s.btn} onPress={() => navigation.navigate("Tabs")}>
              <Text style={s.btnText}>Back to Home</Text>
            </TouchableOpacity>
          </>
        );

      case "error":
        return (
          <>
            <Text style={s.errorIcon}>✕</Text>
            <Text style={s.title}>Something went wrong</Text>
            <Text style={s.body}>{errorMsg}</Text>
            <TouchableOpacity style={s.btn} onPress={() => scanForBulb()}>
              <Text style={s.btnText}>Try scanning again</Text>
            </TouchableOpacity>
            <TouchableOpacity style={[s.btnSecondary, { marginTop: 8 }]} onPress={() => setStep("pick_brand")}>
              <Text style={s.btnSecondaryText}>Start over</Text>
            </TouchableOpacity>
          </>
        );
    }
  };

  return (
    <ScrollView
      style={s.container}
      contentContainerStyle={[s.inner, { paddingBottom: insets.bottom + 24 }]}
      keyboardShouldPersistTaps="handled"
    >
      <View style={s.dots}>
        {STEPS.map((st) => (
          <View key={st} style={[s.dot, step === st && s.dotActive]} />
        ))}
      </View>
      {content()}
    </ScrollView>
  );
}

const s = StyleSheet.create({
  container:       { flex: 1, backgroundColor: "#0f0f0f" },
  inner:           { padding: 24, gap: 14 },
  dots:            { flexDirection: "row", gap: 6, justifyContent: "center", marginBottom: 8 },
  dot:             { width: 6, height: 6, borderRadius: 3, backgroundColor: "#333" },
  dotActive:       { backgroundColor: "#4a9eff" },
  title:           { fontSize: 22, color: "#fff", fontWeight: "700" },
  subtitle:        { fontSize: 14, color: "#666" },
  body:            { fontSize: 15, color: "#aaa", lineHeight: 24 },
  brandRow:        { flexDirection: "row", justifyContent: "space-between", alignItems: "center", backgroundColor: "#1c1c1c", borderRadius: 10, paddingHorizontal: 16, paddingVertical: 14 },
  brandLabel:      { fontSize: 16, color: "#fff" },
  chevron:         { fontSize: 20, color: "#555" },
  stepRow:         { flexDirection: "row", gap: 12, alignItems: "flex-start" },
  stepNum:         { fontSize: 13, color: "#4a9eff", fontWeight: "700", width: 18, marginTop: 2 },
  stepText:        { flex: 1, fontSize: 14, color: "#aaa", lineHeight: 22 },
  fieldLabel:      { fontSize: 11, color: "#666", textTransform: "uppercase", letterSpacing: 1 },
  ssidHeader:      { flexDirection: "row", justifyContent: "space-between", alignItems: "center" },
  rescanText:      { color: "#4a9eff", fontSize: 13 },
  pickerWrap:      { backgroundColor: "#1c1c1c", borderRadius: 10, overflow: "hidden" },
  picker:          { color: "#fff" },
  input:           { backgroundColor: "#1c1c1c", color: "#fff", borderRadius: 10, paddingHorizontal: 14, paddingVertical: 12, fontSize: 15 },
  btn:             { backgroundColor: "#1e3a5f", borderRadius: 10, paddingVertical: 14, alignItems: "center" },
  btnDisabled:     { opacity: 0.4 },
  btnText:         { color: "#4a9eff", fontSize: 15, fontWeight: "600" },
  btnSecondary:    { backgroundColor: "#1c1c1c", borderRadius: 10, paddingVertical: 12, alignItems: "center" },
  btnSecondaryText:{ color: "#888", fontSize: 14 },
  successIcon:     { fontSize: 48, color: "#1a7f4b", textAlign: "center" },
  errorIcon:       { fontSize: 48, color: "#ff6b6b", textAlign: "center" },
});
