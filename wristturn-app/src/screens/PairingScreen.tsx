import React, { useEffect, useRef, useState } from "react";
import {
  View, Text, TextInput, TouchableOpacity, StyleSheet, ActivityIndicator,
} from "react-native";
import type { StackScreenProps } from "@react-navigation/stack";
import type { RootStackParams } from "../navigation/AppNavigator";
import { AndroidTV } from "../../modules/androidtv";
import { registry } from "../devices/registry/DeviceRegistry";
import { ANDROIDTV_COMMANDS } from "../devices/adapters/AndroidTVAdapter";

type Props = StackScreenProps<RootStackParams, "Pairing">;

type Stage = "connecting" | "waitingPin" | "verifying" | "error";
const CONNECT_TIMEOUT_MS = 12000;

export function PairingScreen({ route, navigation }: Props) {
  const { deviceId }   = route.params;
  const meta           = registry.get(deviceId);
  const [stage, setStage] = useState<Stage>("connecting");
  const [pin, setPin]     = useState("");
  const [errMsg, setErrMsg] = useState("");
  const subs = useRef<{ remove(): void }[]>([]);
  const connectTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    if (!meta) {
      console.log("[PairingScreen] missing meta for deviceId=", deviceId);
      return;
    }
    console.log("[PairingScreen] mount deviceId=", deviceId, "host=", meta.host, "name=", meta.name);

    // Register androidtv commands now if not already done
    if (meta.availableCommands.length === 0) {
      registry.register({ ...meta, availableCommands: ANDROIDTV_COMMANDS });
    }

    const onSecret = AndroidTV.onSecret(() => {
      console.log("[PairingScreen] onSecret event received");
      if (connectTimeoutRef.current) {
        clearTimeout(connectTimeoutRef.current);
        connectTimeoutRef.current = null;
      }
      setStage("waitingPin");
    });
    const onReady = AndroidTV.onReady(() => {
      console.log("[PairingScreen] onReady event received, navigating to ActiveControl");
      subs.current.forEach((s) => s.remove());
      navigation.replace("ActiveControl", { deviceId });
    });
    const onError = AndroidTV.onError((e) => {
      console.log("[PairingScreen] onError event message=", e?.message);
      if (connectTimeoutRef.current) {
        clearTimeout(connectTimeoutRef.current);
        connectTimeoutRef.current = null;
      }
      setStage("error");
      setErrMsg(e.message ?? "Unknown error");
    });

    subs.current = [onSecret, onReady, onError];
    console.log("[PairingScreen] calling AndroidTV.startPairing host=", meta.host);
    connectTimeoutRef.current = setTimeout(() => {
      console.log("[PairingScreen] startPairing timeout");
      setStage("error");
      setErrMsg("Timed out waiting for TV pairing response");
    }, CONNECT_TIMEOUT_MS);

    AndroidTV.startPairing(meta.host).catch((e: Error) => {
      console.log("[PairingScreen] startPairing rejected message=", e?.message);
      if (connectTimeoutRef.current) {
        clearTimeout(connectTimeoutRef.current);
        connectTimeoutRef.current = null;
      }
      setStage("error");
      setErrMsg(e.message ?? "Failed to start pairing");
    });

    return () => {
      console.log("[PairingScreen] unmount, removing subscriptions");
      if (connectTimeoutRef.current) {
        clearTimeout(connectTimeoutRef.current);
        connectTimeoutRef.current = null;
      }
      subs.current.forEach((s) => s.remove());
    };
  }, []);

  function submitPin() {
    console.log("[PairingScreen] submitPin pressed pinLength=", pin.length);
    if (pin.length !== 6) return;
    setStage("verifying");
    console.log("[PairingScreen] calling AndroidTV.sendCode");
    AndroidTV.sendCode(pin).catch((e: Error) => {
      console.log("[PairingScreen] sendCode rejected message=", e?.message);
      setStage("error");
      setErrMsg(e.message ?? "Wrong PIN");
    });
  }

  return (
    <View style={s.container}>
      <Text style={s.title}>{meta?.name ?? deviceId}</Text>

      {stage === "connecting" && (
        <View style={s.center}>
          <ActivityIndicator color="#4a9eff" size="large" />
          <Text style={s.hint}>Connecting to TV…</Text>
        </View>
      )}

      {stage === "waitingPin" && (
        <View style={s.center}>
          <Text style={s.hint}>Enter the PIN shown on the TV screen</Text>
          <TextInput
            style={s.pinInput}
            keyboardType="visible-password"
            maxLength={6}
            value={pin}
            onChangeText={(v) => setPin(v.toUpperCase().replace(/[^0-9A-F]/g, ""))}
            placeholder="PIN"
            placeholderTextColor="#555"
            autoCapitalize="characters"
            autoCorrect={false}
            autoFocus
          />
          <TouchableOpacity style={s.btn} onPress={submitPin}>
            <Text style={s.btnText}>Confirm</Text>
          </TouchableOpacity>
        </View>
      )}

      {stage === "verifying" && (
        <View style={s.center}>
          <ActivityIndicator color="#4a9eff" size="large" />
          <Text style={s.hint}>Verifying PIN…</Text>
        </View>
      )}

      {stage === "error" && (
        <View style={s.center}>
          <Text style={s.errorText}>{errMsg}</Text>
          <TouchableOpacity style={s.btn} onPress={() => navigation.goBack()}>
            <Text style={s.btnText}>Go Back</Text>
          </TouchableOpacity>
        </View>
      )}
    </View>
  );
}

const s = StyleSheet.create({
  container: { flex: 1, backgroundColor: "#0f0f0f", padding: 24 },
  title:     { fontSize: 22, color: "#fff", fontWeight: "600", marginBottom: 40 },
  center:    { flex: 1, justifyContent: "center", alignItems: "center", gap: 20 },
  hint:      { color: "#aaa", fontSize: 16, textAlign: "center" },
  pinInput:  {
    backgroundColor: "#1c1c1c", color: "#fff", fontSize: 32,
    letterSpacing: 8, textAlign: "center", borderRadius: 12,
    paddingVertical: 16, paddingHorizontal: 24, width: 200,
  },
  btn:       { backgroundColor: "#1e3a5f", paddingHorizontal: 32, paddingVertical: 14, borderRadius: 10 },
  btnText:   { color: "#4a9eff", fontSize: 16 },
  errorText: { color: "#e05252", fontSize: 15, textAlign: "center" },
});
