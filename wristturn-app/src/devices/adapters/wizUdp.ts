import UdpSockets from "react-native-udp";
import { Buffer } from "buffer";

export const WIZ_PORT = 38899;

export function sendWizUDP(host: string, payload: object): Promise<void> {
  return new Promise((resolve, reject) => {
    const socket = UdpSockets.createSocket({ type: "udp4" });
    const msg = Buffer.from(JSON.stringify(payload));
    socket.on("error", (err) => { socket.close(); reject(err); });
    socket.bind(0, () => {
      socket.send(msg, 0, msg.length, WIZ_PORT, host, (err) => {
        socket.close();
        if (err) reject(err); else resolve();
      });
    });
  });
}

export function sendWizUDPWithReply(host: string, payload: object, timeoutMs = 3000): Promise<object> {
  return new Promise((resolve, reject) => {
    const socket = UdpSockets.createSocket({ type: "udp4" });
    const msg = Buffer.from(JSON.stringify(payload));
    const timer = setTimeout(() => { socket.close(); reject(new Error("timeout")); }, timeoutMs);
    socket.on("error", (err) => { clearTimeout(timer); socket.close(); reject(err); });
    socket.on("message", (data) => {
      clearTimeout(timer);
      socket.close();
      try { resolve(JSON.parse(data.toString())); }
      catch { reject(new Error("bad JSON")); }
    });
    socket.bind(0, () => {
      socket.send(msg, 0, msg.length, WIZ_PORT, host, (err) => {
        if (err) { clearTimeout(timer); socket.close(); reject(err); }
      });
    });
  });
}

/** Broadcast on LAN and collect all WiZ responses within timeoutMs */
export function discoverWizDevices(timeoutMs = 4000): Promise<Array<{ ip: string; mac: string }>> {
  return new Promise((resolve) => {
    const found = new Map<string, string>(); // ip → mac
    const socket = UdpSockets.createSocket({ type: "udp4", reusePort: true });
    const reg = Buffer.from(JSON.stringify({
      method: "registration",
      params: { phoneMac: "AAAAAAAAAAAA", register: false, phoneIp: "255.255.255.255", id: 1 },
    }));

    socket.on("error", () => socket.close());
    socket.on("message", (data, rinfo) => {
      try {
        const parsed = JSON.parse(data.toString()) as { result?: { mac?: string } };
        const mac = parsed?.result?.mac;
        if (mac) found.set(rinfo.address, mac);
      } catch { /* ignore */ }
    });

    socket.bind(WIZ_PORT, () => {
      socket.setBroadcast(true);
      socket.send(reg, 0, reg.length, WIZ_PORT, "255.255.255.255", () => {});
      setTimeout(() => {
        socket.close();
        resolve(Array.from(found.entries()).map(([ip, mac]) => ({ ip, mac })));
      }, timeoutMs);
    });
  });
}
