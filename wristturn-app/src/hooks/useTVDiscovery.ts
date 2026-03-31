import { useEffect, useRef, useState } from "react";
import Zeroconf from "react-native-zeroconf";
import type { TVDevice } from "../types";

export function useTVDiscovery() {
  const [tvs, setTVs] = useState<TVDevice[]>([]);
  const [scanning, setScanning] = useState(false);
  const zeroconf = useRef(new Zeroconf()).current;

  useEffect(() => {
    setScanning(true);

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    zeroconf.on("resolved", (service: any) => {
      const device: TVDevice = {
        id:   service.name,
        name: service.name,
        host: service.host,
        port: service.port,
        type: "androidtv",
      };

      setTVs((prev) => {
        if (prev.find((t) => t.id === device.id)) return prev;
        return [...prev, device];
      });
    });

    zeroconf.on("error", (err: unknown) => {
      console.warn("Zeroconf error:", err);
    });

    zeroconf.scan("androidtvremote2", "tcp", "local.");

    return () => {
      zeroconf.stop();
      zeroconf.removeDeviceListeners();
      setScanning(false);
    };
  }, []);

  return { tvs, scanning };
}
