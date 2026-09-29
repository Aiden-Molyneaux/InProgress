import Database from 'better-sqlite3';
import { MIGRATIONS } from './schema';

export type DB = Database.Database;

export function openDb(file: string): DB {
  const db = new Database(file);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.pragma('busy_timeout = 5000');
  migrate(db);
  return db;
}

export function schemaVersion(db: DB): number {
  const row = db.prepare("SELECT value FROM meta WHERE key = 'schema_version'").get() as { value: string } | undefined;
  return row ? Number(row.value) : 0;
}

export function migrate(db: DB): void {
  db.exec('CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)');
  // One migration per BEGIN IMMEDIATE transaction, reading the version under the write lock: when two
  // first-ever starts race, the later one finds the earlier one's work done instead of applying it twice.
  const step = db.transaction((): boolean => {
    const version = schemaVersion(db);
    if (version > MIGRATIONS.length) {
      throw new Error(`InProgress database schema v${version} is newer than this build (v${MIGRATIONS.length}); update InProgress`);
    }
    if (version === MIGRATIONS.length) return false;
    db.exec(MIGRATIONS[version]);
    db.prepare(
      "INSERT INTO meta (key, value) VALUES ('schema_version', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
    ).run(String(version + 1));
    return true;
  });
  while (step.immediate()) {
    // each pass applies the next migration
  }
}
