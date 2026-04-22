export interface DiscoveredBulb {
  ip: string;
  mac?: string;
  name?: string;
}

/**
 * Per-brand provisioning driver. Encapsulates:
 *  - how to put the bulb in setup mode
 *  - which WiFi AP it creates
 *  - how to send credentials over that AP
 *  - how to discover it on the LAN afterwards
 */
export interface IBulbProvisioner {
  readonly brand: string;
  readonly label: string;

  /** Ordered user-visible steps to enter setup mode (shown as a list). */
  readonly resetSteps: string[];

  /** SSID prefix the bulb uses when in AP mode (e.g. "WizMote_"). */
  readonly apSsidPrefix: string;

  /** IP of the bulb when acting as AP gateway. */
  readonly apGatewayIp: string;

  /** Send home-network credentials to the bulb (called while phone is on bulb AP). */
  sendCredentials(ssid: string, password: string): Promise<void>;

  /** Scan home LAN for bulbs of this brand. */
  discoverOnLan(timeoutMs: number): Promise<DiscoveredBulb[]>;
}
