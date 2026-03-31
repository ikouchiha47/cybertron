/**
 * Android TV Remote Protocol v2
 *
 * Sends key events to an Android TV device over the local network.
 * Uses the _androidtvremote2._tcp mDNS service.
 *
 * Full pairing (certificate exchange) is required on first connect.
 * This module handles the simple keyevent-only path after pairing.
 *
 * TODO: implement TLS pairing handshake for first-time setup.
 * For now, commands are logged — wire up actual socket when pairing is done.
 */

import type { TVDevice } from "../types";

export async function sendTVCommand(tv: TVDevice, keycode: string): Promise<void> {
  // TODO: open TLS socket to tv.host:tv.port, send keyevent protobuf
  console.log(`[TV] ${tv.name} → ${keycode}`);
}
