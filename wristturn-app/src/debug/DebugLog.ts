import * as FileSystem from "expo-file-system/legacy";
import * as Sharing    from "expo-sharing";

type Listener = (lines: string[]) => void;

const MAX = 80;
const lines: string[] = [];
const listeners = new Set<Listener>();

function timestamp() {
  const d = new Date();
  return `${d.getHours().toString().padStart(2,"0")}:${d.getMinutes().toString().padStart(2,"0")}:${d.getSeconds().toString().padStart(2,"0")}.${d.getMilliseconds().toString().padStart(3,"0")}`;
}

export const DebugLog = {
  push(tag: string, msg: string) {
    const line = `${timestamp()} [${tag}] ${msg}`;
    lines.push(line);
    if (lines.length > MAX) lines.splice(0, lines.length - MAX);
    listeners.forEach((l) => l([...lines]));
  },

  subscribe(fn: Listener) {
    listeners.add(fn);
    fn([...lines]);
    return () => { listeners.delete(fn); };
  },

  clear() {
    lines.length = 0;
    listeners.forEach((l) => l([]));
  },

  async share(): Promise<void> {
    if (lines.length === 0) throw new Error("No log lines to export");
    const ok = await Sharing.isAvailableAsync();
    if (!ok) throw new Error("Sharing unavailable on this device");

    const dir  = FileSystem.documentDirectory + "logs/";
    const info = await FileSystem.getInfoAsync(dir);
    if (!info.exists) await FileSystem.makeDirectoryAsync(dir, { intermediates: true });

    const iso  = new Date().toISOString().replace(/[:.]/g, "-");
    const name = `log-${iso}.txt`;
    const path = dir + name;
    await FileSystem.writeAsStringAsync(path, lines.join("\n") + "\n");
    await Sharing.shareAsync(path, { mimeType: "text/plain", dialogTitle: name });
  },
};
