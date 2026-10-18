import Database from 'better-sqlite3';
import { mkdirSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { timestamp } from '../backup';
import { MIGRATIONS, REBUILDS } from './schema';

export type DB = Database.Database;

export function openDb(file: string): DB {
  const db = new Database(file);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.pragma('busy_timeout = 5000');
  // A table rebuild copies the database file aside first. The name falls outside backupDb's rotation pattern, so
  // the copy is kept. One copy per version: a rebuild that keeps failing must not copy the database on every start.
  const beforeRebuild = file === ':memory:'
    ? undefined
    : (toVersion: number) => {
        const dir = join(dirname(file), 'backups');
        mkdirSync(dir, { recursive: true });
        const prefix = `inprogress-pre-v${toVersion}-`;
        if (readdirSync(dir).some((f) => f.startsWith(prefix) && f.endsWith('.db'))) return;
        const target = join(dir, `${prefix}${timestamp()}.db`).replace(/'/g, "''");
        try {
          db.exec(`VACUUM INTO '${target}'`);
        } catch (err) {
          // Another start wrote the same copy this second: the copy exists, which is all this needs.
          if (!/already exists/i.test((err as Error).message)) throw err;
        }
      };
  migrate(db, { beforeRebuild });
  return db;
}

export function schemaVersion(db: DB): number {
  const row = db.prepare("SELECT value FROM meta WHERE key = 'schema_version'").get() as { value: string } | undefined;
  return row ? Number(row.value) : 0;
}

export function migrate(db: DB, opts: { beforeRebuild?: (toVersion: number) => void } = {}): void {
  db.exec('CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)');
  // One migration per BEGIN IMMEDIATE transaction, reading the version under the write lock: when two
  // first-ever starts race, the later one finds the earlier one's work done instead of applying it twice.
  const step = db.transaction((): boolean => {
    const version = schemaVersion(db);
    if (version > MIGRATIONS.length) {
      // A migration that only adds tables and columns records the oldest build that can still read its result
      // (meta min_reader_version), so rolling back a deploy across it leaves InProgress working.
      const minReader = Number(db.prepare("SELECT value FROM meta WHERE key = 'min_reader_version'").pluck().get() ?? NaN);
      if (Number.isInteger(minReader) && minReader <= MIGRATIONS.length) return false;
      throw new Error(`InProgress database schema v${version} is newer than this build (v${MIGRATIONS.length}); update InProgress`);
    }
    if (version === MIGRATIONS.length) return false;
    const rebuild = REBUILDS.has(version);
    // Either direction means another start migrated between the read outside and this one: a rebuild with foreign keys
    // still on would cascade-delete every row that points at the table, and a plain migration would run unchecked.
    if (rebuild !== offForRebuild) {
      throw new Error(`Migration ${version + 1} ${rebuild ? 'rebuilds a table and needs foreign keys off' : 'needs foreign keys on'}; another start changed the schema version meanwhile, so start InProgress again`);
    }
    if (rebuild && db.pragma('foreign_keys', { simple: true }) !== 0) {
      throw new Error(`Migration ${version + 1} rebuilds a table and needs foreign keys off, but they are on`);
    }
    db.exec(MIGRATIONS[version]);
    if (rebuild) {
      const broken = db.pragma('foreign_key_check') as unknown[];
      if (broken.length > 0) {
        throw new Error(`Migration ${version + 1} left ${broken.length} broken foreign key reference(s) (foreign_key_check: ${JSON.stringify(broken.slice(0, 5))}); the database is unchanged`);
      }
    }
    db.prepare(
      "INSERT INTO meta (key, value) VALUES ('schema_version', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
    ).run(String(version + 1));
    return true;
  });
  // A database this call starts from nothing holds nothing to copy aside, so its rebuilds skip beforeRebuild.
  const fresh = schemaVersion(db) === 0;
  // Whether this pass turned foreign keys off for a rebuild, as the read outside the transaction decided.
  let offForRebuild = false;
  for (;;) {
    const version = schemaVersion(db);
    const rebuild = REBUILDS.has(version);
    if (rebuild) {
      if (!fresh) opts.beforeRebuild?.(version + 1);
      // Outside the transaction: SQLite ignores the foreign_keys pragma inside one.
      db.pragma('foreign_keys = OFF');
    }
    offForRebuild = rebuild;
    try {
      if (!step.immediate()) break;
    } finally {
      if (rebuild) db.pragma('foreign_keys = ON');
    }
  }
}
