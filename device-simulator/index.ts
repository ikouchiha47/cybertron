#!/usr/bin/env bun
// Simulates N fake smart devices per category so the RUNE app can discover and
// connect to them over mDNS/HTTP without owning real hardware.
//
// Usage:
//   bun index.ts --tv 3 --bulb 1 --fan 2 --monitor 1
//   bun index.ts --bulb 2          (defaults: 1 of each category not specified... no, see below)
//
// Only categories explicitly passed are spawned. Ports are assigned sequentially
// starting at BASE_PORT.

import { CATEGORIES, type Category } from "./src/devices";
import { generateId, generateName } from "./src/naming";
import { advertiseDevice, startDeviceServer, summarize, type SimDevice } from "./src/server";
import { startDashboard } from "./src/dashboard";

const BASE_PORT = 9200;

function parseArgs(argv: string[]): Partial<Record<Category, number>> {
  const counts: Partial<Record<Category, number>> = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (!arg.startsWith("--")) continue;
    const key = arg.slice(2) as Category;
    if (!CATEGORIES.includes(key)) {
      console.error(`Unknown category "${key}". Valid: ${CATEGORIES.join(", ")}`);
      process.exit(1);
    }
    const next = argv[i + 1];
    const count = Number(next);
    if (!next || Number.isNaN(count) || count <= 0) {
      console.error(`--${key} requires a positive integer count`);
      process.exit(1);
    }
    counts[key] = (counts[key] ?? 0) + count;
    i++;
  }
  return counts;
}

function main() {
  const counts = parseArgs(process.argv.slice(2));
  if (Object.keys(counts).length === 0) {
    console.log("Usage: bun index.ts --tv <n> --bulb <n> --fan <n> --monitor <n>");
    console.log("Example: bun index.ts --tv 3 --bulb 1");
    process.exit(1);
  }

  const takenNames = new Set<string>();
  const devices: SimDevice[] = [];
  let port = BASE_PORT;
  let index = 0;

  for (const category of CATEGORIES) {
    const n = counts[category] ?? 0;
    for (let i = 0; i < n; i++) {
      const device: SimDevice = {
        id: generateId(category, index),
        name: generateName(takenNames),
        category,
        port: port++,
      };
      devices.push(device);
      index++;
    }
  }

  const stateMap = new Map<string, Record<string, unknown>>();

  console.log(`Starting ${devices.length} simulated device(s):\n`);
  const procs = devices.map((device) => {
    startDeviceServer(device, stateMap);
    const dnssd = advertiseDevice(device);
    console.log("  " + summarize(device));
    return dnssd;
  });

  startDashboard(devices, stateMap);

  console.log("\nAdvertising via mDNS (_http._tcp.local) — discoverable from the RUNE app's Discover Devices screen.");
  console.log("Logs for every received signal appear below.\n");

  const shutdown = () => {
    console.log("\nShutting down simulated devices...");
    procs.forEach((p) => p.kill());
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

main();
