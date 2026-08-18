import type { Subprocess } from "bun";
import { initialState, routesForCategory, applyRoute, type Category } from "./devices";
import { emit } from "./events";

export interface SimDevice {
  id: string;
  name: string;
  category: Category;
  port: number;
}

function log(device: SimDevice, line: string): void {
  const ts = new Date().toISOString();
  const msg = `[${device.category}] ${device.name} (${device.id}) :${device.port} ${line}`;
  console.log(`[${ts}] ${msg}`);
  emit("log", { ts, device: device.id, name: device.name, category: device.category, msg });
}

async function readBody(req: Request): Promise<Record<string, unknown>> {
  try {
    return (await req.json()) as Record<string, unknown>;
  } catch {
    return {};
  }
}

export function startDeviceServer(device: SimDevice, stateMap?: Map<string, Record<string, unknown>>) {
  let state = initialState(device.category);
  stateMap?.set(device.id, state);
  const routes = routesForCategory(device.category);

  Bun.serve({
    port: device.port,
    async fetch(req) {
      const url = new URL(req.url);
      const deviceID = url.searchParams.get("deviceID") ?? device.id;

      if (url.pathname === "/") {
        log(device, `GET / (reachability check) deviceID=${deviceID}`);
        return Response.json({ id: device.id, name: device.name, category: device.category, ok: true });
      }

      if (url.pathname === "/state") {
        return Response.json(state);
      }

      const route = routes.find((r) => r.method === req.method && r.path === url.pathname);
      const body = req.method === "GET" ? {} : await readBody(req);

      if (!route) {
        log(device, `UNHANDLED ${req.method} ${url.pathname} deviceID=${deviceID} body=${JSON.stringify(body)}`);
        return Response.json({ error: "unknown route", path: url.pathname }, { status: 404 });
      }

      state = applyRoute(route.descriptor, state, body);
      stateMap?.set(device.id, state);
      log(device, `${req.method} ${url.pathname} deviceID=${deviceID} body=${JSON.stringify(body)} -> state=${JSON.stringify(state)}`);
      emit("state", { id: device.id, state });
      return Response.json(state);
    },
  });
}

export function advertiseDevice(device: SimDevice): Subprocess {
  const txt = [`id=${device.id}`, `name=${device.name}`, `fn=${device.name}`, `category=${device.category}`];
  const proc = Bun.spawn(
    ["dns-sd", "-R", device.name, "_http._tcp", "local", String(device.port), ...txt],
    { stdout: "ignore", stderr: "ignore" }
  );
  return proc;
}

export function summarize(device: SimDevice): string {
  return `${device.category.padEnd(8)} ${device.name.padEnd(20)} id=${device.id.padEnd(24)} port=${device.port}`;
}
