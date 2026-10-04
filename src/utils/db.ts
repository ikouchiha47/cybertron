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

/** Current schema version = highest migration. */
const DB_VERSION = 3;

interface DbMigration {
  /** Version this migration moves the DB *to*. */
  to: number;
  /** Statements applied in order to reach `to`. */
  statements: string[];
}

/**
 * Ordered SQLite schema migrations. Fresh DBs start at `user_version = 0`; the
 * runner applies only the entries above the DB's current version.
 */
const DB_MIGRATIONS: DbMigration[] = [
  {
    to: 1,
    statements: [
      `CREATE TABLE IF NOT EXISTS events (
        id             TEXT    PRIMARY KEY,
        timestamp      INTEGER NOT NULL,
        nearness       TEXT    NOT NULL,
        frame_count    INTEGER NOT NULL,
        thumbnail_path TEXT    NOT NULL
      )`,
      `CREATE INDEX IF NOT EXISTS idx_events_timestamp ON events(timestamp DESC)`,
    ],
  },
  {
    to: 2,
    statements: [`ALTER TABLE events ADD COLUMN video_path TEXT NOT NULL DEFAULT ''`],
  },
  {
    to: 3,
    statements: [`ALTER TABLE events ADD COLUMN camera_id TEXT NOT NULL DEFAULT ''`],
  },
];

/** Existing columns of `events`, or an empty set if the table does not exist. */
async function existingColumns(d: SQLite.SQLiteDatabase): Promise<Set<string>> {
  try {
    const rows = await d.getAllAsync<{ name: string }>('PRAGMA table_info(events)');
    return new Set(rows.map(r => r.name));
  } catch {
    return new Set<string>();
  }
}

/**
 * Infer the highest migration already satisfied by a legacy DB that predates
 * `user_version` (i.e. `user_version === 0`), by inspecting the live schema.
 * This lets an already-upgraded DB adopt the right version instead of blindly
 * re-running `ALTER TABLE … ADD COLUMN`.
 */
async function detectSatisfiedVersion(d: SQLite.SQLiteDatabase): Promise<number> {
  const columns = await existingColumns(d);
  if (columns.size === 0) return 0; // no events table → fresh DB
  let version = 1; // base table (+ index) present
  if (columns.has('video_path')) version = 2;
  if (columns.has('camera_id')) version = 3;
  return version;
}

/** Bring the DB schema up to `DB_VERSION` using `PRAGMA user_version`. */
async function migrate(d: SQLite.SQLiteDatabase): Promise<void> {
  const row = await d.getFirstAsync<{ user_version: number }>('PRAGMA user_version');
  let version = row?.user_version ?? 0;

  // Legacy DBs have the schema but no user_version; work out where they are.
  if (version === 0) version = await detectSatisfiedVersion(d);

  for (const migration of DB_MIGRATIONS) {
    if (migration.to <= version) continue;
    for (const statement of migration.statements) {
      // Guarded by version detection; the catch keeps an already-applied
      // column (or a raced open) from ever throwing on startup.
      await d.execAsync(statement).catch(() => {});
    }
    version = migration.to;
  }

  await d.execAsync(`PRAGMA user_version = ${Math.max(version, DB_VERSION)}`);
}

async function db(): Promise<SQLite.SQLiteDatabase> {
  if (!_db) {
    _db = await SQLite.openDatabaseAsync('doorcam.db');
    await _db.execAsync('PRAGMA journal_mode=WAL;');
    await migrate(_db);
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
