import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import type { DB } from './db/connection';

/** The line in schema.sql between the tables above it and the indexes, triggers and views below it. */
export const DUMP_SPLIT = '-- inprogress-dump: after data';

export interface Dump {
  /** The CREATE statements: tables, then DUMP_SPLIT on a line of its own, then indexes, triggers and views. */
  schema: string;
  /** One INSERT per line, per table (sqlite_sequence included when it exists). */
  tables: Record<string, string>;
}

const quoteId = (name: string): string => `"${name.replace(/"/g, '""')}"`;

/** A row's value as an SQL literal that reads back as the same type and bytes. */
function literal(v: unknown): string {
  if (v === null) return 'NULL';
  if (typeof v === 'bigint') return v.toString();
  if (typeof v === 'number') {
    if (v === Infinity) return '9e999';
    if (v === -Infinity) return '-9e999';
    const s = String(v);
    // A REAL that prints as a whole number must still read back as a REAL.
    return /[.en]/.test(s) ? s : `${s}.0`;
  }
  if (typeof v === 'string') {
    // The SQL parser stops a string literal at a NUL byte; a hex blob cast to text does not.
    if (v.includes('\0')) return `CAST(X'${Buffer.from(v, 'utf8').toString('hex')}' AS TEXT)`;
    return `'${v.replace(/'/g, "''")}'`;
  }
  if (Buffer.isBuffer(v)) return `X'${v.toString('hex')}'`;
  throw new Error(`Cannot dump a ${typeof v} value`);
}

/** The tables to dump, in dump order: by name, with sqlite_sequence (which SQLite makes itself) last. */
function dumpTables(db: DB): string[] {
  const names = (db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND sql IS NOT NULL AND name NOT LIKE 'sqlite_%' ORDER BY name").pluck().all() as string[]);
  const seq = db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'sqlite_sequence'").pluck().get();
  return seq ? [...names, 'sqlite_sequence'] : names;
}

/** The rows of one table in dump order: by rowid, or by primary key for a WITHOUT ROWID table. */
function tableRows(db: DB, table: string): unknown[][] {
  const sql = (db.prepare('SELECT sql FROM sqlite_master WHERE name = ?').pluck().get(table) as string | undefined) ?? '';
  let order = 'rowid';
  if (/WITHOUT\s+ROWID/i.test(sql)) {
    const pk = db.prepare('SELECT name FROM pragma_table_info(?) WHERE pk > 0 ORDER BY pk').pluck().all(table) as string[];
    order = pk.map(quoteId).join(', ');
  }
  return db.prepare(`SELECT * FROM ${quoteId(table)} ORDER BY ${order}`).safeIntegers(true).raw().all() as unknown[][];
}

/** The database as canonical text: dumping the same data twice gives the same bytes. */
export function dumpDb(db: DB): Dump & { counts: Record<string, number> } {
  const master = db.prepare("SELECT type, name, sql FROM sqlite_master WHERE sql IS NOT NULL AND name NOT LIKE 'sqlite_%' ORDER BY name").all() as { type: string; name: string; sql: string }[];
  const part = (types: string[]) => master.filter((m) => types.includes(m.type)).map((m) => `${m.sql};\n`).join('');
  const schema = `${part(['table'])}${DUMP_SPLIT}\n${part(['index'])}${part(['view'])}${part(['trigger'])}`;
  const tables: Record<string, string> = {};
  const counts: Record<string, number> = {};
  for (const table of dumpTables(db)) {
    const rows = tableRows(db, table);
    tables[table] = rows.map((row) => `INSERT INTO ${quoteId(table)} VALUES(${row.map(literal).join(',')});\n`).join('');
    counts[table] = rows.length;
  }
  return { schema, tables, counts };
}

/** Builds a new database file from a dump. No trigger fires: the data goes in between the tables and the triggers. */
export function loadDump(file: string, dump: Dump): void {
  if (existsSync(file)) throw new Error(`Refused to load a dump over ${file}: it already exists`);
  const at = dump.schema.indexOf(DUMP_SPLIT);
  if (at < 0) throw new Error(`The dump's schema.sql has no "${DUMP_SPLIT}" line`);
  const db = new Database(file);
  try {
    db.pragma('foreign_keys = OFF');
    db.transaction(() => {
      db.exec(dump.schema.slice(0, at));
      for (const [table, text] of Object.entries(dump.tables)) {
        if (table !== 'sqlite_sequence') db.exec(text);
      }
      // The inserts above moved the counters of AUTOINCREMENT tables; the dump holds the real ones.
      if ('sqlite_sequence' in dump.tables) {
        db.exec('DELETE FROM sqlite_sequence');
        db.exec(dump.tables.sqlite_sequence);
      }
      db.exec(dump.schema.slice(at + DUMP_SPLIT.length));
    })();
  } finally {
    db.close();
  }
}

/** Writes schema.sql and data/<table>.sql into `dir`, removing any data file for a table the dump no longer has. */
export function writeDump(dir: string, dump: Dump): void {
  const data = join(dir, 'data');
  mkdirSync(data, { recursive: true });
  writeFileSync(join(dir, 'schema.sql'), dump.schema, 'utf8');
  for (const [table, text] of Object.entries(dump.tables)) writeFileSync(join(data, `${table}.sql`), text, 'utf8');
  for (const f of readdirSync(data)) {
    if (f.endsWith('.sql') && !(f.slice(0, -4) in dump.tables)) rmSync(join(data, f), { force: true });
  }
}

export function readDump(dir: string): Dump {
  const tables: Record<string, string> = {};
  const data = join(dir, 'data');
  for (const f of readdirSync(data).sort()) {
    if (f.endsWith('.sql')) tables[f.slice(0, -4)] = readFileSync(join(data, f), 'utf8');
  }
  return { schema: readFileSync(join(dir, 'schema.sql'), 'utf8'), tables };
}

/** SHA-256 per table of its rows in dump order, each value tagged with its type: equal digests mean equal contents. */
export function tableDigest(db: DB): Record<string, string> {
  const out: Record<string, string> = {};
  for (const table of dumpTables(db)) {
    const hash = createHash('sha256');
    for (const row of tableRows(db, table)) {
      for (const v of row) {
        const text = v === null ? '' : Buffer.isBuffer(v) ? v.toString('hex') : String(v);
        const tag = v === null ? 'null' : Buffer.isBuffer(v) ? 'blob' : typeof v;
        hash.update(`${tag}:${Buffer.byteLength(text)}:${text}\x1f`);
      }
      hash.update('\n');
    }
    out[table] = hash.digest('hex');
  }
  return out;
}
