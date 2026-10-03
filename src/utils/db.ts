import * as SQLite from 'expo-sqlite';

export interface CamEvent {
  id: string;
  timestamp: number;
  nearness: string;
  frame_count: number;
  thumbnail_path: string;
  video_path?: string;
  camera_id?: string;
}

export interface DayGroup {
  day: string;       // 'YYYY-MM-DD'
  count: number;
  thumbnail_path: string;
}

export interface MonthGroup {
  month: string;     // 'YYYY-MM'
  count: number;
}

let _db: SQLite.SQLiteDatabase | null = null;

async function db(): Promise<SQLite.SQLiteDatabase> {
  if (!_db) {
    _db = await SQLite.openDatabaseAsync('doorcam.db');
    await _db.execAsync('PRAGMA journal_mode=WAL;');
    await _db.execAsync(`
      CREATE TABLE IF NOT EXISTS events (
        id            TEXT    PRIMARY KEY,
        timestamp     INTEGER NOT NULL,
        nearness      TEXT    NOT NULL,
        frame_count   INTEGER NOT NULL,
        thumbnail_path TEXT   NOT NULL,
        video_path    TEXT    NOT NULL DEFAULT ''
      );
      CREATE INDEX IF NOT EXISTS idx_events_timestamp ON events(timestamp DESC);
    `);
    // Migrate existing DBs that lack video_path
    await _db.execAsync(`ALTER TABLE events ADD COLUMN video_path TEXT NOT NULL DEFAULT ''`).catch(() => {});
    // Migrate existing DBs that lack camera_id
    await _db.execAsync(`ALTER TABLE events ADD COLUMN camera_id TEXT NOT NULL DEFAULT ''`).catch(() => {});
  }
  return _db;
}

export async function insertEvent(event: CamEvent): Promise<void> {
  const d = await db();
  await d.runAsync(
    'INSERT OR REPLACE INTO events (id, timestamp, nearness, frame_count, thumbnail_path, video_path, camera_id) VALUES (?, ?, ?, ?, ?, ?, ?)',
    [event.id, event.timestamp, event.nearness, event.frame_count, event.thumbnail_path, event.video_path ?? '', event.camera_id ?? ''],
  );
}

export async function getMonths(): Promise<MonthGroup[]> {
  const d = await db();
  return d.getAllAsync<MonthGroup>(
    `SELECT strftime('%Y-%m', timestamp/1000, 'unixepoch', 'localtime') AS month,
            count(*) AS count
     FROM events GROUP BY month ORDER BY month DESC`,
  );
}

export async function getDaysForMonth(month: string): Promise<DayGroup[]> {
  const d = await db();
  return d.getAllAsync<DayGroup>(
    `SELECT date(timestamp/1000, 'unixepoch', 'localtime') AS day,
            count(*) AS count,
            thumbnail_path
     FROM events
     WHERE strftime('%Y-%m', timestamp/1000, 'unixepoch', 'localtime') = ?
     GROUP BY day ORDER BY day DESC`,
    [month],
  );
}

export async function getEventsForDay(day: string): Promise<CamEvent[]> {
  const d = await db();
  return d.getAllAsync<CamEvent>(
    `SELECT * FROM events
     WHERE date(timestamp/1000, 'unixepoch', 'localtime') = ?
     ORDER BY timestamp DESC`,
    [day],
  );
}

export async function deleteEvents(ids: string[]): Promise<void> {
  if (ids.length === 0) return;
  const d = await db();
  const placeholders = ids.map(() => '?').join(',');
  await d.runAsync(`DELETE FROM events WHERE id IN (${placeholders})`, ids);
}
