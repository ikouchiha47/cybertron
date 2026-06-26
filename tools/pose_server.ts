/**
 * Tails `adb logcat` for [POSE_EXT] and [CalibCap] lines,
 * broadcasts pose data over WebSocket on port 7701.
 *
 * Usage:  bun run tools/pose_server.ts
 */

const PORT = 7701;
const clients = new Set<ServerWebSocket<unknown>>();

// Parse:  "[POSE_EXT] r=-15.9 p=-1.4 y=120.0 gyro=1.5 dps"
// or:     "[CalibCap] pose roll=-15.9 pitch=-1.4 yaw=120.0"
function parseLine(line: string): { roll: number; pitch: number; yaw: number } | null {
  let m = line.match(/\[POSE_EXT\] r=([-\d.]+)\s+p=([-\d.]+)\s+y=([-\d.]+)/);
  if (m) return { roll: +m[1], pitch: +m[2], yaw: +m[3] };

  m = line.match(/\[CalibCap\] pose roll=([-\d.]+) pitch=([-\d.]+) yaw=([-\d.]+)/);
  if (m) return { roll: +m[1], pitch: +m[2], yaw: +m[3] };

  return null;
}

// Spawn adb logcat
const proc = Bun.spawn(["adb", "logcat", "-s", "ReactNativeJS:I"], {
  stdout: "pipe",
  stderr: "ignore",
});

// Stream lines
(async () => {
  const reader = proc.stdout.getReader();
  const dec = new TextDecoder();
  let buf = "";
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    const lines = buf.split("\n");
    buf = lines.pop() ?? "";
    for (const line of lines) {
      const pose = parseLine(line);
      if (pose && clients.size > 0) {
        const msg = JSON.stringify(pose);
        for (const ws of clients) ws.send(msg);
      }
    }
  }
})();

// WebSocket server
const server = Bun.serve({
  port: PORT,
  fetch(req, server) {
    if (server.upgrade(req)) return;
    return new Response("WristTurn pose server — connect via WebSocket", { status: 200 });
  },
  websocket: {
    open(ws) { clients.add(ws); },
    close(ws) { clients.delete(ws); },
    message() {},
  },
});

console.log(`Pose server on ws://localhost:${PORT}  (${clients.size} clients)`);
console.log("Open docs/pose_visualizer.html in Chrome");
