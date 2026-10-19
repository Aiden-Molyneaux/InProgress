import Database from 'better-sqlite3';
import { mkdirSync, readdirSync, renameSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { prunePreMigration, timestamp } from '../backup';
import { MIGRATIONS, REBUILDS } from './schema';

export type DB = Database.Database;

export function openDb(file: string): DB {
  const db = new Database(file);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.pragma('busy_timeout = 5000');
  // Before the first pending migration (a rebuild or an additive one) the database file is copied aside. The name falls
  // outside the snapshots' rotation pattern; prunePreMigration thins these separately. One copy per version: a migration
  // that keeps failing must not copy the database on every start.
  const beforeMigrate = file === ':memory:'
    ? undefined
    : (toVersion: number) => {
        const dir = join(dirname(file), 'backups');
        mkdirSync(dir, { recursive: true });
        const prefix = `inprogress-pre-v${toVersion}-`;
        const present = () => readdirSync(dir).some((f) => f.startsWith(prefix) && f.endsWith('.db'));
        if (present()) return;
        // Copied to a .tmp name of this process's own, then renamed, so the check above only ever sees a complete copy
        // and two racing starts never touch each other's file. A failed copy removes its .tmp.
        const target = join(dir, `${prefix}${timestamp()}.db`);
        const tmp = `${target}.${process.pid}.tmp`;
        try {
          db.exec(`VACUUM INTO '${tmp.replace(/'/g, "''")}'`);
          // Another start may have migrated between this start's read and the copy: a copy not at toVersion - 1 is no
          // longer the state before this migration, so it is not kept.
          const copy = new Database(tmp, { readonly: true });
          let copied: number;
          try {
            copied = schemaVersion(copy);
          } finally {
            copy.close();
          }
          if (copied !== toVersion - 1) {
            rmSync(tmp, { force: true });
            return;
          }
          renameSync(tmp, target);
          try {
            prunePreMigration(dir, new Date());
          } catch {
            // Pruning old copies never blocks a start; the next migration prunes again.
          }
        } catch (err) {
          rmSync(tmp, { force: true });
          // Another start landed its copy meanwhile, which is all this needs.
          if (present()) return;
          throw err;
        }
      };
  migrate(db, { beforeMigrate });
  return db;
}

export function schemaVersion(db: DB): number {
  const row = db.prepare("SELECT value FROM meta WHERE key = 'schema_version'").get() as { value: string } | undefined;
  return row ? Number(row.value) : 0;
}

export function migrate(db: DB, opts: { beforeMigrate?: (toVersion: number) => void } = {}): void {
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
  // A database this call starts from nothing holds nothing to copy aside. One that is newer than this build is not
  // migrated at all. Anything else is copied once, before its first pending migration.
  const start = schemaVersion(db);
  const fresh = start === 0;
  if (!fresh && start < MIGRATIONS.length) opts.beforeMigrate?.(start + 1);
  // Whether this pass turned foreign keys off for a rebuild, as the read outside the transaction decided.
  let offForRebuild = false;
  for (;;) {
    const version = schemaVersion(db);
    const rebuild = REBUILDS.has(version);
    if (rebuild) {
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
