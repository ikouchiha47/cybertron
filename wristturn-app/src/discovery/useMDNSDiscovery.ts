import { useEffect, useRef, useState } from "react";
import Zeroconf, { ImplType } from "react-native-zeroconf";
import type { DiscoveredDevice, TransportType } from "../types";

const SERVICE_TYPES: Array<{ service: string; transport: TransportType }> = [
  { service: "googlecast",       transport: "androidtv" },
  { service: "androidtvremote2", transport: "androidtv" },
  { service: "wt-daemon",        transport: "macdaemon" },
  { service: "http",             transport: "http"       },
];

const SCAN_PLAN: Array<{ service: string; transport: TransportType }> = [
  SERVICE_TYPES[0],
  SERVICE_TYPES[1],
  SERVICE_TYPES[0],
  SERVICE_TYPES[1],
  SERVICE_TYPES[2],
  SERVICE_TYPES[3],
];
const SCAN_DURATION_MS = 3000;
const SCAN_INTERVAL_MS = 300;
const SCAN_IMPL = ImplType.DNSSD;

const PRIORITY: Record<TransportType, number> = {
  androidtv: 3, macdaemon: 2, websocket: 1, tcp: 1, http: 0,
};

export function useMDNSDiscovery() {
  const [devices, setDevices]   = useState<DiscoveredDevice[]>([]);
  const [scanning, setScanning] = useState(false);
  const zeroconf        = useRef(new Zeroconf()).current;
  const timers          = useRef<ReturnType<typeof setTimeout>[]>([]);
  const scanningRef     = useRef(false);
  const activeTransport = useRef<TransportType>("androidtv");
  const activeService   = useRef<string>("");

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  function inferTransport(service: any): TransportType {
    const full = String(service?.fullName ?? "").toLowerCase();
    if (full.includes("._googlecast._tcp.") || full.includes("._androidtvremote2._tcp.")) return "androidtv";
    if (full.includes("._wt-daemon._tcp.")) return "macdaemon";
    if (full.includes("._http._tcp.")) return "http";
    // Fallback: currently scanned service type
    return activeTransport.current;
  }

  function preferredName(service: Record<string, unknown>, fallbackHost: string): string {
    const txt = (service.txt ?? {}) as Record<string, unknown>;
    const txtFriendly = String(txt.fn ?? txt.name ?? "").trim();
    const rawName = String(service.name ?? "").trim();
    return txtFriendly || rawName || fallbackHost;
  }

  function looksGeneratedName(name: string): boolean {
    const n = name.toLowerCase();
    return /-[a-f0-9]{16,}$/i.test(n) || /[a-f0-9]{24,}/i.test(n);
  }

  function shouldPreferIncomingName(currentName: string, incomingName: string): boolean {
    const cur = currentName.trim();
    const inc = incomingName.trim();
    if (!inc) return false;
    if (!cur) return true;
    const curGenerated = looksGeneratedName(cur);
    const incGenerated = looksGeneratedName(inc);
    if (curGenerated && !incGenerated) return true;
    if (curGenerated === incGenerated) return inc.length > cur.length;
    return false;
  }

  function runScan() {
    // Clear any in-progress scan
    timers.current.forEach(clearTimeout);
    timers.current = [];
    zeroconf.stop(SCAN_IMPL);

    scanningRef.current = true;
    setScanning(true);
    console.log("[mDNS] scan cycle start");

    SCAN_PLAN.forEach(({ service, transport }, i) => {
      const startAt = i * (SCAN_DURATION_MS + SCAN_INTERVAL_MS);
      const stopAt  = startAt + SCAN_DURATION_MS;
      timers.current.push(
        setTimeout(() => {
          activeTransport.current = transport;
          activeService.current = service;
          console.log(`[mDNS] scan start _${service}._tcp (${transport}) via ${SCAN_IMPL}`);
          zeroconf.scan(service, "tcp", "local.", SCAN_IMPL);
        }, startAt),
        setTimeout(() => {
          console.log(`[mDNS] scan stop _${service}._tcp (${transport})`);
          zeroconf.stop(SCAN_IMPL);
        }, stopAt),
      );
    });

    const total = SCAN_PLAN.length * (SCAN_DURATION_MS + SCAN_INTERVAL_MS);
    timers.current.push(setTimeout(() => {
      zeroconf.stop(SCAN_IMPL);
      scanningRef.current = false;
      setScanning(false);
      console.log("[mDNS] scan cycle complete");
    }, total));
  }

  function rescan() {
    // Keep previous results visible while rescanning to avoid empty-list flicker.
    runScan();
  }

  useEffect(() => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const onFound = (name: any) => console.log("[mDNS] found:", String(name));
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const onRemove = (name: any) => console.log("[mDNS] removed:", String(name));
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const onResolved = (service: any) => {
      const transport = inferTransport(service);
      const ip = Array.isArray(service.addresses)
        ? service.addresses.map(String).find((a) => !a.startsWith("127.") && a !== "::1")
        : undefined;
      const rawHost = service.host ? String(service.host) : undefined;
      const host = ip ?? rawHost;
      const port = service.port;
      if (!host || !port) {
        console.warn("[mDNS] resolved service missing host/port:", service);
        return;
      }

      const displayName = preferredName(service, String(host));
      const device: DiscoveredDevice = {
        id:      String(displayName),
        name:    String(displayName),
        host:    String(host),
        port:    Number(port),
        transport,
        mdnsTxt: service.txt ?? {},
      };
      console.log(`[mDNS] resolved ${device.name} ${device.host}:${device.port} (${device.transport})`);

      setDevices((prev) => {
        const normalizedHost = device.host.toLowerCase().replace(/\.local\.?$/, "");
        const nameKey = device.name.toLowerCase();
        const txtId = String(service?.txt?.id ?? "");

        const existing = prev.find((d) => {
          const dHost = d.host.toLowerCase().replace(/\.local\.?$/, "");
          const sameHost = dHost === normalizedHost;
          const sameName = d.name.toLowerCase() === nameKey;
          const sameTxtId = txtId.length > 0 && String((d.mdnsTxt as Record<string, unknown>)?.id ?? "") === txtId;
          return sameHost || sameName || sameTxtId;
        });
        if (existing) {
          const incomingHigherPriority = PRIORITY[transport] > PRIORITY[existing.transport];
          const incomingBetterName = shouldPreferIncomingName(existing.name, device.name);
          if (!incomingHigherPriority && !incomingBetterName) return prev;
          return prev.map((d) =>
            d.id === existing.id
              ? { ...d, transport: incomingHigherPriority ? transport : d.transport, id: device.id, name: device.name, host: device.host, port: device.port }
              : d
          );
        }
        return [...prev, device];
      });
    };
    const onStart = () => console.log("[mDNS] native scan started");
    const onStop = () => console.log("[mDNS] native scan stopped");
    const onError = (err: unknown) => console.warn("[mDNS] error:", err);

    zeroconf.on("start", onStart);
    zeroconf.on("stop", onStop);
    zeroconf.on("found", onFound);
    zeroconf.on("remove", onRemove);
    zeroconf.on("resolved", onResolved);
    zeroconf.on("error", onError);

    runScan();
    return () => {
      timers.current.forEach(clearTimeout);
      timers.current = [];
      zeroconf.stop(SCAN_IMPL);
      zeroconf.removeListener("start", onStart);
      zeroconf.removeListener("stop", onStop);
      zeroconf.removeListener("found", onFound);
      zeroconf.removeListener("remove", onRemove);
      zeroconf.removeListener("resolved", onResolved);
      zeroconf.removeListener("error", onError);
      zeroconf.removeDeviceListeners();
      scanningRef.current = false;
      setScanning(false);
    };
  }, []);

  return { devices, scanning, rescan };
}
