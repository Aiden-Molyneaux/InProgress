import { afterEach, describe, expect, it } from 'vitest';
import { countAfter, cutAt, REOPENED_STATUS } from '../../scripts/lead-exam/cut.mjs';
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
    expect(before).toMatchObject({ log_entries: 1, resources: 1, nodes: 1, lead_events: 1, asks_cleared_after: 2, steps_closed_after: 2, sessions: 1 });
    cutAt(db, BEFORE, 10);
    expect(countAfter(db, BEFORE)).toMatchObject({ log_entries: 0, resources: 0, asks: 0, nodes: 0, lead_events: 0, asks_cleared_after: 0, steps_closed_after: 0, sessions: 0 });
    // What was written before stays.
    expect(db.prepare('SELECT COUNT(*) FROM log_entries').pluck().get()).toBe(1);
    expect(db.prepare('SELECT COUNT(*) FROM nodes').pluck().get()).toBe(3);
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
    expect(step(4)).toMatchObject({ status: 'done', outcome: 'old' });
  });

  it("leaves the case's own ask open, with no session", () => {
    const db = seeded();
    dbs.push(db);
    cutAt(db, BEFORE, 10);
    expect(db.prepare('SELECT cleared_at, answer, session_id FROM asks WHERE id = 10').get()).toEqual({ cleared_at: null, answer: '', session_id: null });
    expect(db.prepare('SELECT COUNT(*) FROM sessions').pluck().get()).toBe(0);
  });

  it('refuses to finish with the case ask still answered', () => {
    const db = seeded();
    dbs.push(db);
    // A second open ask with the same node, kind, text and owner keeps the case's ask from opening: the unique index.
    db.prepare("INSERT INTO asks (id, project_id, node_id, kind, text, raised_at) VALUES (20, 1, 1, 'review', 'the case', ?)").run(EARLY);
    expect(() => cutAt(db, BEFORE, 10)).toThrow(/still answered/);
  });
});
