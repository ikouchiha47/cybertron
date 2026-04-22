import type { IBulbProvisioner, DiscoveredBulb } from "./IBulbProvisioner";

/**
 * Wipro smart bulb provisioner.
 * Wipro bulbs are typically Tuya-based. Local control requires the device's
 * local key (obtainable via Tuya cloud API). For now this driver handles
 * setup-mode entry and WiFi provisioning only; LAN discovery is a stub.
 *
 * TODO: implement Tuya local protocol once local keys are known.
 */
export class WiproProvisioner implements IBulbProvisioner {
  readonly brand = "wipro";
  readonly label = "Wipro Smart Bulb";
  readonly apSsidPrefix = "SmartLife_";
  readonly apGatewayIp = "192.168.4.1";

  readonly resetSteps = [
    "Turn the bulb ON and OFF quickly 3 times",
    "Wait for the bulb to start flashing rapidly — it is in setup mode",
    "Open your phone WiFi settings and connect to the network starting with 'SmartLife_'",
  ];

  async sendCredentials(_ssid: string, _password: string): Promise<void> {
    // Tuya provisioning uses a different UDP protocol over the AP.
    // Not yet implemented — requires Tuya local key.
    throw new Error("Wipro/Tuya provisioning is not yet implemented.");
  }

  async discoverOnLan(_timeoutMs: number): Promise<DiscoveredBulb[]> {
    throw new Error("Wipro/Tuya LAN discovery is not yet implemented.");
  }
}
