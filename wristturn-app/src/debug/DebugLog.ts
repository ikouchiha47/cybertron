import * as FileSystem from "expo-file-system/legacy";
import * as Sharing    from "expo-sharing";

type Listener      = (lines: string[]) => void;
type ErrorListener = (msg: string) => void;
type SessionListener = (state: SessionState) => void;

// Display ring buffer — what the LogsScreen renders as the live tail. Kept
// small so render + listener notify cost stays trivial on every push.
const MAX_DISPLAY = 80;
// Write batch — accumulates while recording, flushed to a part file when full.
// Bigger = fewer disk writes (less I/O overhead) at the cost of more in-memory
// buffer and more loss if the app crashes mid-batch. 100k lines ≈ 8 minutes
// of full-firehose diag mode (~210 lines/s) per part file.
const MAX_WRITE_BATCH = 100_000;
const lines: string[] = [];
const listeners        = new Set<Listener>();
const errorListeners   = new Set<ErrorListener>();
const sessionListeners = new Set<SessionListener>();

// ── Session / WAL state ────────────────────────────────────────────────────
//
// File layout under documentDirectory/logs/:
//   sessions/                  category 1: merged + complete
//     session-<iso>.txt
//   active/                    category 2: in-progress session (parts growing)
//     session-<iso>/
//       part-00001.txt         (full, MAX lines flushed)
//       part-00002.txt         (full)
//       part-00003.txt.tmp     (mid-write — discarded on recovery)
//   orphans/                   category 3: session ended without Stop
//     session-<iso>/
//       part-00001.txt
//
// On boot, anything still under active/ is moved to orphans/ (the previous
// run did not call stopSession). User can Recover (merge to sessions/) or
// Delete from the Logs screen.

const LOGS_DIR     = FileSystem.documentDirectory + "logs/";
const SESSIONS_DIR = LOGS_DIR + "sessions/";
const ACTIVE_DIR   = LOGS_DIR + "active/";
const ORPHANS_DIR  = LOGS_DIR + "orphans/";

export type SessionState = {
  recording:        boolean;
  sessionId:        string | null;
  partsFlushed:     number;       // count of completed part files
  pendingFlushes:   number;       // queued or in-flight
  bufferedLines:    number;       // lines waiting in writeBatch
};

export type SessionInfo = {
  id:          string;
  path:        string;
  sizeBytes:   number;
  modifiedAt:  number;
};

export type OrphanInfo = {
  id:          string;
  dir:         string;
  partCount:   number;
};

let _recording        = false;
let _sessionId: string | null = null;
let _sessionDir: string | null = null;     // active/<id>/
let _nextPartNum      = 1;
let _partsFlushed     = 0;
const _writeBatch: string[] = [];          // accumulates while recording
let _flushQueue: Promise<void> = Promise.resolve();   // serialises file writes
let _pendingFlushes   = 0;
let _bootCheckRun     = false;

function timestamp() {
  const d = new Date();
  return `${d.getHours().toString().padStart(2,"0")}:${d.getMinutes().toString().padStart(2,"0")}:${d.getSeconds().toString().padStart(2,"0")}.${d.getMilliseconds().toString().padStart(3,"0")}`;
}

function isoForFs() {
  // ISO with safe-for-filenames chars (no colons, no dots).
  return new Date().toISOString().replace(/[:.]/g, "-");
}

function partFileName(num: number) {
  return `part-${num.toString().padStart(5, "0")}.txt`;
}

function notifySession() {
  const snap: SessionState = {
    recording:      _recording,
    sessionId:      _sessionId,
    partsFlushed:   _partsFlushed,
    pendingFlushes: _pendingFlushes,
    bufferedLines:  _writeBatch.length,
  };
  sessionListeners.forEach((l) => l(snap));
}

async function ensureDir(path: string) {
  const info = await FileSystem.getInfoAsync(path);
  if (!info.exists) {
    await FileSystem.makeDirectoryAsync(path, { intermediates: true });
  }
}

async function writePartAtomic(dir: string, num: number, content: string[]) {
  const final = dir + partFileName(num);
  const tmp   = final + ".tmp";
  await FileSystem.writeAsStringAsync(tmp, content.join("\n") + "\n");
  await FileSystem.moveAsync({ from: tmp, to: final });
}

// One-shot boot check: any leftover active/ subdirs from a prior run
// (the app did not call stopSession before exit) get moved to orphans/.
async function bootCheckOnce(): Promise<void> {
  if (_bootCheckRun) return;
  _bootCheckRun = true;
  try {
    await ensureDir(LOGS_DIR);
    await ensureDir(SESSIONS_DIR);
    await ensureDir(ACTIVE_DIR);
    await ensureDir(ORPHANS_DIR);
    const entries = await FileSystem.readDirectoryAsync(ACTIVE_DIR);
    for (const id of entries) {
      const from = ACTIVE_DIR  + id + "/";
      const to   = ORPHANS_DIR + id + "/";
      try {
        await FileSystem.moveAsync({ from, to });
        console.log(`[DebugLog] orphaned active session → ${id}`);
      } catch (e) {
        console.error(`[DebugLog] failed to move orphan ${id}:`, e);
      }
    }
  } catch (e) {
    console.error("[DebugLog] bootCheck failed:", e);
  }
}

async function listPartsSorted(dir: string): Promise<string[]> {
  const entries = await FileSystem.readDirectoryAsync(dir);
  return entries
    .filter((n) => n.startsWith("part-") && n.endsWith(".txt"))
    .sort();   // zero-padded part-NNNNN.txt sorts lexicographically
}

async function mergePartsTo(srcDir: string, destFile: string): Promise<void> {
  const partNames = await listPartsSorted(srcDir);
  let merged = "";
  for (const name of partNames) {
    const content = await FileSystem.readAsStringAsync(srcDir + name);
    merged += content;
  }
  await FileSystem.writeAsStringAsync(destFile, merged);
}

async function deleteRecursive(path: string): Promise<void> {
  await FileSystem.deleteAsync(path, { idempotent: true });
}

// One-shot canary so adb can confirm the mirror is wired and reachable.
let _mirrorAlive = false;

export const DebugLog = {
  /** Call once on app start (e.g. from App.tsx) to recover orphans. Idempotent. */
  init(): Promise<void> {
    return bootCheckOnce();
  },

  push(tag: string, msg: string) {
    const line = `${timestamp()} [${tag}] ${msg}`;
    lines.push(line);
    if (lines.length > MAX_DISPLAY) lines.splice(0, lines.length - MAX_DISPLAY);
    listeners.forEach((l) => l([...lines]));

    if (!_mirrorAlive) {
      _mirrorAlive = true;
      console.log("[CANARY:DBG] mirror alive");
    }
    console.log(line);

    // WAL: while recording, every line is queued for persistence. Buffer
    // flushes happen on a separate counter from the display buffer so the
    // display ring keeps showing the live tail uninterrupted.
    if (_recording && _sessionDir) {
      _writeBatch.push(line);
      if (_writeBatch.length >= MAX_WRITE_BATCH) {
        const partLines = _writeBatch.splice(0, MAX_WRITE_BATCH);
        const partNum   = _nextPartNum++;
        const dir       = _sessionDir;
        _pendingFlushes++;
        notifySession();
        _flushQueue = _flushQueue
          .then(() => writePartAtomic(dir, partNum, partLines))
          .then(() => {
            _pendingFlushes--;
            _partsFlushed++;
            notifySession();
          })
          .catch((e) => {
            _pendingFlushes--;
            console.error(`[DebugLog] part ${partNum} write failed:`, e);
            notifySession();
          });
      }
    }
  },

  error(msg: string) {
    const errMsg = typeof msg === "string" ? msg : String(msg);
    DebugLog.push("ERR", errMsg);
    errorListeners.forEach((l) => l(errMsg));
  },

  subscribe(fn: Listener) {
    listeners.add(fn);
    fn([...lines]);
    return () => { listeners.delete(fn); };
  },

  subscribeError(fn: ErrorListener) {
    errorListeners.add(fn);
    return () => { errorListeners.delete(fn); };
  },

  subscribeSession(fn: SessionListener) {
    sessionListeners.add(fn);
    fn({
      recording:      _recording,
      sessionId:      _sessionId,
      partsFlushed:   _partsFlushed,
      pendingFlushes: _pendingFlushes,
      bufferedLines:  _writeBatch.length,
    });
    return () => { sessionListeners.delete(fn); };
  },

  clear() {
    lines.length = 0;
    listeners.forEach((l) => l([]));
  },

  // ── Session control ────────────────────────────────────────────────────

  isRecording(): boolean { return _recording; },
  currentSessionId(): string | null { return _sessionId; },

  /** Begin a new recording session. No-op if one is already active. */
  async startSession(): Promise<string> {
    await bootCheckOnce();
    if (_recording && _sessionId) return _sessionId;

    const id  = `session-${isoForFs()}`;
    const dir = ACTIVE_DIR + id + "/";
    await ensureDir(dir);

    _sessionId    = id;
    _sessionDir   = dir;
    _recording    = true;
    _nextPartNum  = 1;
    _partsFlushed = 0;
    _writeBatch.length = 0;
    notifySession();

    DebugLog.push("SESSION", `started ${id}`);
    return id;
  },

  /**
   * Stop recording. Flush any buffered lines, wait for in-flight writes,
   * merge all parts into sessions/<id>.txt, delete active dir.
   * Returns the path of the final merged session file.
   */
  async stopSession(): Promise<string | null> {
    if (!_recording || !_sessionId || !_sessionDir) return null;

    DebugLog.push("SESSION", `stopping ${_sessionId}`);
    const id  = _sessionId;
    const dir = _sessionDir;

    // Flush remaining buffered lines as a final part.
    if (_writeBatch.length > 0) {
      const tail    = _writeBatch.splice(0, _writeBatch.length);
      const partNum = _nextPartNum++;
      _pendingFlushes++;
      notifySession();
      _flushQueue = _flushQueue
        .then(() => writePartAtomic(dir, partNum, tail))
        .then(() => {
          _pendingFlushes--;
          _partsFlushed++;
          notifySession();
        })
        .catch((e) => {
          _pendingFlushes--;
          console.error(`[DebugLog] tail part ${partNum} write failed:`, e);
          notifySession();
        });
    }

    // Wait for all queued writes to settle.
    await _flushQueue;

    // Mark as not-recording before merge so any push() during merge does not
    // attempt to write to a dir we are about to delete.
    _recording  = false;
    _sessionId  = null;
    _sessionDir = null;
    notifySession();

    const finalPath = SESSIONS_DIR + `${id}.txt`;
    try {
      await mergePartsTo(dir, finalPath);
      await deleteRecursive(dir);
      console.log(`[DebugLog] session merged → ${finalPath}`);
    } catch (e) {
      console.error("[DebugLog] merge failed:", e);
      throw e;
    }

    return finalPath;
  },

  /** List finalised, merged session files (category 1). */
  async listSessions(): Promise<SessionInfo[]> {
    await bootCheckOnce();
    const entries = await FileSystem.readDirectoryAsync(SESSIONS_DIR);
    const out: SessionInfo[] = [];
    for (const name of entries) {
      if (!name.endsWith(".txt")) continue;
      const path = SESSIONS_DIR + name;
      const info = await FileSystem.getInfoAsync(path);
      out.push({
        id:         name.replace(/\.txt$/, ""),
        path,
        sizeBytes:  (info as { size?: number }).size ?? 0,
        modifiedAt: (info as { modificationTime?: number }).modificationTime ?? 0,
      });
    }
    out.sort((a, b) => b.modifiedAt - a.modifiedAt);
    return out;
  },

  /** List orphan session dirs (category 3): the previous run did not Stop. */
  async listOrphans(): Promise<OrphanInfo[]> {
    await bootCheckOnce();
    const entries = await FileSystem.readDirectoryAsync(ORPHANS_DIR);
    const out: OrphanInfo[] = [];
    for (const id of entries) {
      const dir = ORPHANS_DIR + id + "/";
      const info = await FileSystem.getInfoAsync(dir);
      if (!info.exists || !info.isDirectory) continue;
      const parts = await listPartsSorted(dir);
      out.push({ id, dir, partCount: parts.length });
    }
    out.sort((a, b) => a.id.localeCompare(b.id));
    return out;
  },

  /** Merge an orphan's parts into a finalised session file and delete the orphan. */
  async recoverOrphan(id: string): Promise<string> {
    const dir       = ORPHANS_DIR + id + "/";
    const finalPath = SESSIONS_DIR + `${id}.txt`;
    await mergePartsTo(dir, finalPath);
    await deleteRecursive(dir);
    return finalPath;
  },

  /** Delete an orphan dir without merging. */
  async deleteOrphan(id: string): Promise<void> {
    await deleteRecursive(ORPHANS_DIR + id + "/");
  },

  /** Delete a finalised session file. */
  async deleteSession(id: string): Promise<void> {
    await deleteRecursive(SESSIONS_DIR + `${id}.txt`);
  },

  /** Share the in-memory display buffer (legacy / quick-share). */
  async share(): Promise<void> {
    if (lines.length === 0) throw new Error("No log lines to export");
    const ok = await Sharing.isAvailableAsync();
    if (!ok) throw new Error("Sharing unavailable on this device");

    const dir  = LOGS_DIR;
    await ensureDir(dir);

    const name = `log-${isoForFs()}.txt`;
    const path = dir + name;
    await FileSystem.writeAsStringAsync(path, lines.join("\n") + "\n");
    await Sharing.shareAsync(path, { mimeType: "text/plain", dialogTitle: name });
  },

  /** Share a finalised merged session file by id. */
  async shareSession(id: string): Promise<void> {
    const ok = await Sharing.isAvailableAsync();
    if (!ok) throw new Error("Sharing unavailable on this device");
    const path = SESSIONS_DIR + `${id}.txt`;
    const info = await FileSystem.getInfoAsync(path);
    if (!info.exists) throw new Error(`Session ${id} not found`);
    await Sharing.shareAsync(path, { mimeType: "text/plain", dialogTitle: `${id}.txt` });
  },
};
