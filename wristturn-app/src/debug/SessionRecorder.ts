import * as FileSystem from "expo-file-system/legacy";
import * as Sharing from "expo-sharing";
import type { GestureEvent, RawSample } from "../types";

// One event per JSONL line. `t` is the phone's wall-clock millis at receive
// time so events from different characteristics interleave correctly; `t_fw`
// is the firmware-reported millis (monotonic since boot) when available.
export type SessionEvent =
  | { t: number; type: "gesture"; name: string; roll?: number; pitch?: number; yaw?: number; delta?: number; value?: number }
  | { t: number; type: "raw"; roll: number; pitch: number; yaw: number }
  | { t: number; t_fw?: number; type: "state"; raw: string }
  | { t: number; type: "baseline"; roll: number; pitch: number; yaw: number }
  | { t: number; type: "combo"; combo: string }
  | { t: number; type: "command"; cmdId: string; device: string }
  | { t: number; type: "annotation"; label: string };

type Listener = (active: boolean, eventCount: number) => void;

class SessionRecorderImpl {
  private events: SessionEvent[] = [];
  private active = false;
  private startedAt = 0;
  private listeners = new Set<Listener>();

  isActive(): boolean { return this.active; }
  eventCount(): number { return this.events.length; }

  start(): void {
    if (this.active) return;
    this.events = [];
    this.startedAt = Date.now();
    this.active = true;
    this.notify();
  }

  async stop(): Promise<string | null> {
    if (!this.active) return null;
    this.active = false;
    const path = await this.flushToFile();
    this.notify();
    return path;
  }

  annotate(label: string): void {
    if (!this.active) return;
    this.push({ t: Date.now(), type: "annotation", label });
  }

  recordGesture(g: GestureEvent): void {
    if (!this.active) return;
    this.push({
      t: Date.now(),
      type: "gesture",
      name: g.name,
      roll: g.roll,
      pitch: g.pitch,
      yaw: g.yaw,
      delta: g.delta,
      value: g.value,
    });
  }

  recordRaw(s: RawSample): void {
    if (!this.active) return;
    this.push({ t: Date.now(), type: "raw", ...s });
  }

  recordState(rawJson: string): void {
    if (!this.active) return;
    // Try to extract t from embedded JSON for timing accuracy
    let t_fw: number | undefined;
    const match = rawJson.match(/"t":\s*(\d+)/);
    if (match) t_fw = parseInt(match[1], 10);
    this.push({ t: Date.now(), t_fw, type: "state", raw: rawJson });
  }

  recordCombo(combo: string): void {
    if (!this.active) return;
    this.push({ t: Date.now(), type: "combo", combo });
  }

  recordCommand(cmdId: string, device: string): void {
    if (!this.active) return;
    this.push({ t: Date.now(), type: "command", cmdId, device });
  }

  recordBaseline(roll: number, pitch: number, yaw: number): void {
    if (!this.active) return;
    this.push({ t: Date.now(), type: "baseline", roll, pitch, yaw });
  }

  subscribe(fn: Listener): () => void {
    this.listeners.add(fn);
    fn(this.active, this.events.length);
    return () => { this.listeners.delete(fn); };
  }

  async listSessions(): Promise<string[]> {
    const dir = this.sessionDir();
    const info = await FileSystem.getInfoAsync(dir);
    if (!info.exists) return [];
    const names = await FileSystem.readDirectoryAsync(dir);
    return names.filter((n) => n.endsWith(".jsonl")).sort().reverse();
  }

  async shareSession(name: string): Promise<void> {
    const path = this.sessionDir() + name;
    const ok = await Sharing.isAvailableAsync();
    if (!ok) throw new Error("sharing unavailable");
    await Sharing.shareAsync(path, { mimeType: "application/x-ndjson", dialogTitle: name });
  }

  async deleteSession(name: string): Promise<void> {
    await FileSystem.deleteAsync(this.sessionDir() + name, { idempotent: true });
  }

  private push(e: SessionEvent): void {
    this.events.push(e);
    // Notify every 10 events to keep UI counter roughly live without churn
    if (this.events.length % 10 === 0) this.notify();
  }

  private notify(): void {
    this.listeners.forEach((l) => l(this.active, this.events.length));
  }

  private sessionDir(): string {
    return FileSystem.documentDirectory + "sessions/";
  }

  private async flushToFile(): Promise<string> {
    const dir = this.sessionDir();
    const dirInfo = await FileSystem.getInfoAsync(dir);
    if (!dirInfo.exists) {
      await FileSystem.makeDirectoryAsync(dir, { intermediates: true });
    }
    const iso = new Date(this.startedAt).toISOString().replace(/[:.]/g, "-");
    const name = `session-${iso}.jsonl`;
    const path = dir + name;
    const header = { t: this.startedAt, type: "meta", startedAt: new Date(this.startedAt).toISOString(), eventCount: this.events.length };
    const body = [header, ...this.events].map((e) => JSON.stringify(e)).join("\n") + "\n";
    await FileSystem.writeAsStringAsync(path, body);
    return path;
  }
}

export const SessionRecorder = new SessionRecorderImpl();
