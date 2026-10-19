import { mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { afterEach, describe, expect, it } from 'vitest';
import { DUMP_SPLIT, dumpDb, loadDump, readDump, tableDigest, writeDump } from '../../src/server/dump';
import { addNodes } from '../../src/server/repo/nodes';
import { createProject } from '../../src/server/repo/projects';
import { makeCtx } from '../helpers';

const dirs: string[] = [];
function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'ip-dump-'));
  dirs.push(dir);
  return dir;
}
afterEach(() => {
  while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
});

const master = (db: Database.Database) =>
  db.prepare("SELECT type, name, tbl_name, sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY type, name").all();

/** Dump `db`, load it into a new file, and return the loaded database (open: the caller closes it). */
function roundTrip(db: Database.Database): Database.Database {
  const file = join(tempDir(), 'loaded.db');
  loadDump(file, dumpDb(db));
  return new Database(file);
}

describe('dump', () => {
  it('round-trips every kind of value, an AUTOINCREMENT counter, an index and a trigger that does not fire on load', () => {
    const db = new Database(':memory:');
    db.exec(`
      CREATE TABLE vals (id INTEGER PRIMARY KEY AUTOINCREMENT, a, b TEXT, c BLOB);
      CREATE INDEX vals_b ON vals (b);
      CREATE TABLE audit (n INTEGER);
      CREATE TRIGGER vals_ai AFTER INSERT ON vals BEGIN INSERT INTO audit (n) VALUES (new.id); END;
      CREATE VIEW vals_view AS SELECT id FROM vals;
      CREATE TABLE pairs (k TEXT, v INTEGER, PRIMARY KEY (k, v)) WITHOUT ROWID;
    `);
    const insert = db.prepare('INSERT INTO vals (a, b, c) VALUES (?, ?, ?)');
    insert.run(null, null, null);
    insert.run(7, "it's", Buffer.from([0, 1, 255]));
    insert.run(9007199254740993n, 'line\r\nbreak', Buffer.alloc(0));
    insert.run(1.0, 'emoji 😀', null);
    insert.run(0.1, 'nul\0inside', null);
    insert.run(1e300, 'x', null);
    insert.run(-1e300, '', null);
    db.prepare('INSERT INTO pairs VALUES (?, ?)').run('b', 2);
    db.prepare('INSERT INTO pairs VALUES (?, ?)').run('a', 9);
    // Deleting the newest rows leaves the counter ahead of max(id).
    db.exec('DELETE FROM vals WHERE id > 5');
    db.exec('DELETE FROM audit');
    const loaded = roundTrip(db);
    try {
      expect(master(loaded)).toEqual(master(db));
      expect(tableDigest(loaded)).toEqual(tableDigest(db));
      expect(loaded.prepare('SELECT * FROM sqlite_sequence').all()).toEqual(db.prepare('SELECT * FROM sqlite_sequence').all());
      // The trigger is in place but did not run for the loaded rows.
      expect(loaded.prepare('SELECT count(*) FROM audit').pluck().get()).toBe(0);
      expect(loaded.prepare("SELECT 1 FROM sqlite_master WHERE type = 'trigger' AND name = 'vals_ai'").get()).toBeDefined();
      expect(loaded.prepare('SELECT typeof(a) FROM vals WHERE id = 4').pluck().get()).toBe('real');
      expect(loaded.prepare('SELECT length(CAST(b AS BLOB)) FROM vals WHERE id = 5').pluck().get()).toBe(10);
      expect(loaded.pragma('integrity_check', { simple: true })).toBe('ok');
    } finally {
      loaded.close();
      db.close();
    }
  });

  it('puts the tables above the split line and indexes, triggers and views below it, and dumps the same text twice', () => {
    const db = new Database(':memory:');
    db.exec('CREATE TABLE b (x); CREATE INDEX b_x ON b (x); CREATE TABLE a (y); INSERT INTO a VALUES (1);');
    const dump = dumpDb(db);
    expect(dump.schema).toBe(`CREATE TABLE a (y);\nCREATE TABLE b (x);\n${DUMP_SPLIT}\nCREATE INDEX b_x ON b (x);\n`);
    expect(dump.tables.a).toBe('INSERT INTO "a" VALUES(1);\n');
    expect(dump.counts).toEqual({ a: 1, b: 0 });
    expect(dumpDb(db)).toEqual(dump);
    db.close();
  });

  it('round-trips the real schema with a project and its steps', () => {
    const ctx = makeCtx();
    const project = createProject(ctx, 'test', { name: 'P' });
    addNodes(ctx, 't', { parentId: project.rootNodeId, nodes: [{ title: 'A' }, { title: "B's" }] });
    const loaded = roundTrip(ctx.db);
    try {
      expect(master(loaded)).toEqual(master(ctx.db));
      expect(tableDigest(loaded)).toEqual(tableDigest(ctx.db));
      expect(loaded.pragma('integrity_check', { simple: true })).toBe('ok');
      expect(loaded.prepare('SELECT count(*) FROM nodes').pluck().get()).toBeGreaterThanOrEqual(3);
    } finally {
      loaded.close();
      ctx.db.close();
    }
  });

  it('tableDigest tells a changed value, or a changed type, from the original', () => {
    const db = new Database(':memory:');
    db.exec('CREATE TABLE t (v); INSERT INTO t VALUES (1);');
    const before = tableDigest(db);
    db.exec("UPDATE t SET v = 1.0");
    expect(tableDigest(db).t).not.toBe(before.t);
    db.exec("UPDATE t SET v = '1'");
    expect(tableDigest(db).t).not.toBe(before.t);
    db.close();
  });

  it('writes and reads the files back, and drops the data file of a table that is gone', () => {
    const db = new Database(':memory:');
    db.exec('CREATE TABLE a (x); CREATE TABLE b (x); INSERT INTO a VALUES (1);');
    const dir = tempDir();
    writeDump(dir, dumpDb(db));
    expect(readdirSync(join(dir, 'data'))).toEqual(['a.sql', 'b.sql']);
    expect(readDump(dir)).toEqual({ schema: dumpDb(db).schema, tables: dumpDb(db).tables });
    db.exec('DROP TABLE b');
    writeDump(dir, dumpDb(db));
    expect(readdirSync(join(dir, 'data'))).toEqual(['a.sql']);
    db.close();
  });

  it('refuses to load over an existing file', () => {
    const db = new Database(':memory:');
    db.exec('CREATE TABLE a (x)');
    const file = join(tempDir(), 'there.db');
    writeFileSync(file, 'x');
    expect(() => loadDump(file, dumpDb(db))).toThrow(/already exists/);
    db.close();
  });
});
