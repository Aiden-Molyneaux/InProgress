import { execSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, existsSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { countAfter, cutAt, pointFoldersAway, REOPENED_STATUS } from '../../scripts/lead-exam/cut.mjs';
import { refuseLiveHome } from '../../scripts/lead-exam/guard.mjs';
import { openDb } from '../../src/server/db/connection';

const BEFORE = '2026-11-10T12:00:00.000Z';
const EARLY = '2026-11-01T00:00:00.000Z';
const LATE = '2026-11-15T00:00:00.000Z';

/** A small database: one project, a step finished after BEFORE, a step parked after BEFORE, a later step, and sessions. */
function seeded() {
  const db = openDb(':memory:');
  db.prepare("INSERT INTO projects (id, slug, name, created_at, updated_at) VALUES (1, 'p', 'P', ?, ?)").run(EARLY, EARLY);
  const node = db.prepare(
    "INSERT INTO nodes (id, project_id, parent_id, position, kind, title, status, outcome, created_at, updated_at, completed_at, parked_at, parked_reason) VALUES (?, 1, NULL, ?, 'task', ?, ?, ?, ?, ?, ?, ?, ?)",
  );
  node.run(1, 1, 'finished later', 'done', 'it shipped', EARLY, LATE, LATE, null, '');
  node.run(2, 2, 'parked later', 'parked', '', EARLY, LATE, null, LATE, 'waiting');
  node.run(3, 3, 'made later', 'todo', '', LATE, LATE, null, null, '');
  node.run(4, 4, 'finished before', 'done', 'old', EARLY, EARLY, EARLY, null, '');
  // A drop sets neither completed_at nor parked_at: only status and updated_at say when.
  db.prepare("INSERT INTO nodes (id, project_id, parent_id, position, kind, title, status, outcome, created_at, updated_at) VALUES (5, 1, NULL, 5, 'task', 'dropped later', 'dropped', '', ?, ?)").run(EARLY, LATE);
  db.prepare("INSERT INTO sessions (id, project_id, state, started_at, last_seen_at) VALUES ('s1', 1, 'working', ?, ?)").run(EARLY, LATE);
  const ask = db.prepare("INSERT INTO asks (id, project_id, node_id, kind, text, raised_at, cleared_at, answer, session_id) VALUES (?, 1, ?, ?, ?, ?, ?, ?, 's1')");
  ask.run(10, 1, 'review', 'the case', BEFORE, LATE, 'looks fine');
  ask.run(11, 2, 'question', 'answered later', EARLY, LATE, 'yes');
  ask.run(12, 4, 'question', 'answered before', EARLY, EARLY, 'no');
  ask.run(13, 3, 'question', 'raised later', LATE, null, '');
  db.prepare("INSERT INTO log_entries (node_id, text, created_at) VALUES (1, 'early', ?), (1, 'late', ?)").run(EARLY, LATE);
  db.prepare("INSERT INTO resources (project_id, node_id, kind, title, content, created_at, updated_at) VALUES (1, 1, 'doc', 'late doc', 'x', ?, ?)").run(LATE, LATE);
  db.prepare("INSERT INTO lead_events (project_id, at, lead, instructions, kind) VALUES (1, ?, 'L', 1, 'note'), (1, ?, 'L', 1, 'note')").run(EARLY, LATE);
  return db;
}

const dbs: ReturnType<typeof openDb>[] = [];
afterEach(() => {
  for (const db of dbs.splice(0)) db.close();
});

describe('the exam cut', () => {
  it('counts what stands after BEFORE, and the cut removes it', () => {
    const db = seeded();
    dbs.push(db);
    const before = countAfter(db, BEFORE);
    expect(before).toMatchObject({ log_entries: 1, resources: 1, nodes: 1, lead_events: 1, asks_cleared_after: 2, steps_closed_after: 3, sessions: 1 });
    cutAt(db, BEFORE, 10);
    expect(countAfter(db, BEFORE)).toMatchObject({ log_entries: 0, resources: 0, asks: 0, nodes: 0, lead_events: 0, asks_cleared_after: 0, steps_closed_after: 0, sessions: 0 });
    // What was written before stays.
    expect(db.prepare('SELECT COUNT(*) FROM log_entries').pluck().get()).toBe(1);
    expect(db.prepare('SELECT COUNT(*) FROM nodes').pluck().get()).toBe(4);
    expect(db.prepare('SELECT COUNT(*) FROM asks').pluck().get()).toBe(3);
  });

  it('opens again an ask answered later, and leaves one answered before as it was', () => {
    const db = seeded();
    dbs.push(db);
    cutAt(db, BEFORE, 10);
    expect(db.prepare('SELECT cleared_at, answer FROM asks WHERE id = 11').get()).toEqual({ cleared_at: null, answer: '' });
    expect(db.prepare('SELECT cleared_at, answer FROM asks WHERE id = 12').get()).toEqual({ cleared_at: EARLY, answer: 'no' });
  });

  it('opens again a step finished or parked later, with its outcome and reason emptied', () => {
    const db = seeded();
    dbs.push(db);
    cutAt(db, BEFORE, 10);
    const step = (id: number) => db.prepare('SELECT status, outcome, completed_at, parked_at, parked_reason FROM nodes WHERE id = ?').get(id);
    expect(step(1)).toEqual({ status: REOPENED_STATUS, outcome: '', completed_at: null, parked_at: null, parked_reason: '' });
    expect(step(2)).toEqual({ status: REOPENED_STATUS, outcome: '', completed_at: null, parked_at: null, parked_reason: '' });
    expect(step(5)).toEqual({ status: REOPENED_STATUS, outcome: '', completed_at: null, parked_at: null, parked_reason: '' });
    expect(step(4)).toMatchObject({ status: 'done', outcome: 'old' });
  });

  it("leaves the case's own ask open, with no session", () => {
    const db = seeded();
    dbs.push(db);
    cutAt(db, BEFORE, 10);
    expect(db.prepare('SELECT cleared_at, answer, session_id FROM asks WHERE id = 10').get()).toEqual({ cleared_at: null, answer: '', session_id: null });
    expect(db.prepare('SELECT COUNT(*) FROM sessions').pluck().get()).toBe(0);
  });

  it('throws and rolls the whole cut back when the case ask cannot open', () => {
    const db = seeded();
    dbs.push(db);
    // An earlier open ask with the same node, kind, text and owner keeps the case's ask from opening: the unique index.
    db.prepare("INSERT INTO asks (id, project_id, node_id, kind, text, raised_at) VALUES (20, 1, 1, 'review', 'the case', ?)").run(EARLY);
    expect(() => cutAt(db, BEFORE, 10)).toThrow(/UNIQUE/);
    expect(db.prepare('SELECT COUNT(*) FROM nodes').pluck().get()).toBe(5);
    expect(db.prepare('SELECT cleared_at FROM asks WHERE id = 10').pluck().get()).toBe(LATE);
  });

  it('points a project binding at a folder that does not exist, each its own', () => {
    const db = seeded();
    dbs.push(db);
    db.prepare("INSERT INTO bindings (project_id, path, branch_pattern, created_at) VALUES (1, 'C:/repo', '', ?), (1, 'C:/repo', 'x*', ?)").run(EARLY, EARLY);
    const paths = pointFoldersAway(db, 1, 'C:/cases/r-1');
    expect(paths).toHaveLength(2);
    expect(new Set(paths).size).toBe(2);
    expect(db.prepare('SELECT path FROM bindings ORDER BY id').pluck().all()).toEqual(paths);
    expect(paths.every((p: string) => p.startsWith('C:/cases/r-1/no-repo/') && !existsSync(p))).toBe(true);
  });
});

describe('the exam guard on the live home', () => {
  const made: string[] = [];
  afterEach(() => {
    for (const d of made.splice(0)) rmSync(d, { recursive: true, force: true });
  });
  const stand = () => {
    const d = mkdtempSync(join(tmpdir(), 'exam-live-'));
    made.push(d);
    return d;
  };

  it('refuses an out dir under the live home, even one not made yet, and makes nothing', () => {
    const live = stand();
    expect(() => refuseLiveHome([join(live, 'new', 'deeper')], live)).toThrow(/live InProgress home/);
    expect(readdirSync(live)).toEqual([]);
    expect(() => refuseLiveHome([live], live)).toThrow(/live InProgress home/);
  });

  it('allows a folder beside the live home, and one whose name only starts the same', () => {
    const live = stand();
    const other = stand();
    expect(() => refuseLiveHome([other, join(other, 'x')], live)).not.toThrow();
    expect(() => refuseLiveHome([live + '-copy'], live)).not.toThrow();
  });

  it('refuses an out dir given as an 8.3 short path under the live home', () => {
    if (process.platform !== 'win32') return;
    const live = stand();
    const long = join(live, 'A Long Folder Name');
    mkdirSync(long);
    const short = execSync(`for %I in ("${long}") do @echo %~sI`, { encoding: 'utf8', shell: 'cmd.exe' }).trim();
    // Where the machine makes no short names the path comes back unchanged: the long form is still refused below.
    expect(() => refuseLiveHome([join(short, 'out')], live)).toThrow(/live InProgress home/);
    expect(() => refuseLiveHome([join(long, 'out')], live)).toThrow(/live InProgress home/);
  });
});

describe('run-case skipping', () => {
  const run = (out: string, program: string | undefined) =>
    spawnSync(process.execPath, ['scripts/lead-exam/run-case.mjs', join(out, 'build'), join(out, 'missing.db'), out, 'r', '5', '4410'], {
      encoding: 'utf8',
      env: { ...process.env, ...(program === undefined ? { INPROGRESS_LEAD_CLAUDE: '' } : { INPROGRESS_LEAD_CLAUDE: program }) },
    });
  const written = (out: string, o: object) => writeFileSync(join(out, 'lead-r-5.json'), JSON.stringify({ error: null, ...o }));

  it("skips a case its own program and build wrote, and runs again one a stand-in wrote", () => {
    const out = mkdtempSync(join(tmpdir(), 'exam-skip-'));
    try {
      written(out, { program: 'claude', build: join(out, 'build') });
      expect(run(out, undefined).stdout).toContain('skipped');
      written(out, { program: 'C:/stand-in.mjs', build: join(out, 'build') });
      const again = run(out, undefined);
      expect(again.stdout).not.toContain('skipped');
      expect(again.status).toBe(1);
      written(out, { program: 'claude', build: 'another build' });
      expect(run(out, undefined).stdout).not.toContain('skipped');
    } finally {
      rmSync(out, { recursive: true, force: true });
    }
  });
});
