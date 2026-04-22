import type { IBulbProvisioner, DiscoveredBulb } from "./IBulbProvisioner";
import { sendWizUDPWithReply, discoverWizDevices } from "../adapters/wizUdp";

export class WizProvisioner implements IBulbProvisioner {
  readonly brand = "wiz";
  readonly label = "Philips WiZ";
  readonly apSsidPrefix = "WizMote_";
  readonly apGatewayIp = "192.168.1.1";

  readonly resetSteps = [
    "Turn the bulb OFF and wait 5 seconds",
    "Turn the bulb ON — it will enter setup mode automatically",
    "Open your phone WiFi settings and connect to the network starting with 'WizMote_'",
  ];

  async sendCredentials(ssid: string, password: string): Promise<void> {
    await sendWizUDPWithReply(this.apGatewayIp, {
      method: "registration",
      params: { phoneMac: "AAAAAAAAAAAA", register: false, phoneIp: "192.168.1.100", id: 1 },
    }, 4000);
    await sendWizUDPWithReply(this.apGatewayIp, {
      method: "setConfig",
      params: { ssid, password, homeId: 0, roomId: 0 },
    }, 4000);
  }

  async discoverOnLan(timeoutMs: number): Promise<DiscoveredBulb[]> {
    return discoverWizDevices(timeoutMs);
  }
}
