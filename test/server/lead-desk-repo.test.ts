import { beforeEach, describe, expect, it, vi } from 'vitest';
import { DESK_ONLY_DATA, write } from '../../src/server/db/tx';
import { lastProjectEvent } from '../../src/server/repo/events';
import { createProject, listProjectSummaries } from '../../src/server/repo/projects';
import { makeCtx } from '../helpers';
import { openDb, type DB } from '../../src/server/db/connection';
import { addDeskItem, getDeskItem, moveDeskItem, openDeskItems } from '../../src/server/repo/desk';
import { addDecision, decisionByEvent, decisionsSince } from '../../src/server/repo/leadDecisions';
import { getSend, intendSend, moveSend, sendByRetryKey, sendsInState, stampSeen } from '../../src/server/repo/leadSends';
import { getTurn, insertTurn, leaseItem, liveTurn, moveTurn } from '../../src/server/repo/leadTurns';
import { addReading, latestReading } from '../../src/server/repo/usageReadings';

const T0 = '2026-11-25T10:00:00.000Z';
const T1 = '2026-11-25T10:01:00.000Z';
const T2 = '2026-11-25T10:02:00.000Z';

let db: DB;
beforeEach(() => {
  db = openDb(':memory:');
  db.prepare("INSERT INTO projects (id, slug, name, root_node_id, created_at, updated_at) VALUES (1, 'p', 'P', 0, ?, ?)").run(T0, T0);
});

const item = (ref = 'a1') => addDeskItem(db, { projectId: 1, kind: 'question', ref }, T0).item;

describe('desk items', () => {
  it('queues one (kind, ref) once while it is not done', () => {
    const first = addDeskItem(db, { projectId: 1, kind: 'question', ref: 'a1', nodeId: 2, dueAt: T2 }, T0);
    expect(first.created).toBe(true);
    expect(first.item).toMatchObject({ projectId: 1, kind: 'question', ref: 'a1', nodeId: 2, createdAt: T0, dueAt: T2, state: 'open', doneAt: null, outcome: null });
    const again = addDeskItem(db, { projectId: 1, kind: 'question', ref: 'a1' }, T1);
    expect(again.created).toBe(false);
    expect(again.item).toEqual(first.item);
    expect(db.prepare('SELECT COUNT(*) FROM desk_items').pluck().get()).toBe(1);
    // Another kind on the same ref is another thing.
    expect(addDeskItem(db, { projectId: 1, kind: 'permission', ref: 'a1' }, T1).created).toBe(true);
  });

  it('queues the same (kind, ref) anew once the first is done', () => {
    const first = item();
    expect(moveDeskItem(db, first.id, ['open'], 'done', { outcome: 'answered', now: T1 })).toBe(true);
    expect(getDeskItem(db, first.id)).toMatchObject({ state: 'done', doneAt: T1, outcome: 'answered' });
    const second = addDeskItem(db, { projectId: 1, kind: 'question', ref: 'a1' }, T2);
    expect(second.created).toBe(true);
    expect(second.item.id).not.toBe(first.id);
    expect(openDeskItems(db, 1).map((i) => i.id)).toEqual([second.item.id]);
  });

  it('refuses a move from a state not in from, and leaves the row', () => {
    const it1 = item();
    expect(moveDeskItem(db, it1.id, ['leased'], 'done', { now: T1 })).toBe(false);
    expect(getDeskItem(db, it1.id)).toMatchObject({ state: 'open', doneAt: null });
    expect(moveDeskItem(db, it1.id, ['open'], 'leased', { now: T1 })).toBe(true);
    expect(getDeskItem(db, it1.id)).toMatchObject({ state: 'leased', doneAt: null });
  });

  it('clears done_at and the outcome when a done item is moved back, and keeps an outcome given with the move (Y4)', () => {
    const it1 = item();
    expect(moveDeskItem(db, it1.id, ['open'], 'done', { outcome: 'answered', now: T1 })).toBe(true);
    expect(moveDeskItem(db, it1.id, ['done'], 'open', { now: T2 })).toBe(true);
    expect(getDeskItem(db, it1.id)).toMatchObject({ state: 'open', doneAt: null, outcome: null });
    expect(moveDeskItem(db, it1.id, ['open'], 'done', { outcome: 'answered', now: T1 })).toBe(true);
    expect(moveDeskItem(db, it1.id, ['done'], 'open', { outcome: 'waits: why', now: T2 })).toBe(true);
    expect(getDeskItem(db, it1.id)).toMatchObject({ state: 'open', doneAt: null, outcome: 'waits: why' });
  });

  it('lists the open items oldest first', () => {
    const late = addDeskItem(db, { projectId: 1, kind: 'stuck', ref: 's1' }, T2).item;
    const early = addDeskItem(db, { projectId: 1, kind: 'stopped', ref: 's2' }, T0).item;
    expect(openDeskItems(db, 1).map((i) => i.id)).toEqual([early.id, late.id]);
  });
});

describe('lead turns', () => {
  it('leases a turn until now plus leaseMs, and refuses a second live turn for the item', () => {
    const it1 = item();
    const turn = insertTurn(db, { itemId: it1.id, way: 'headless', model: 'opus', leaseMs: 60_000 }, T0);
    expect(turn).toMatchObject({ itemId: it1.id, way: 'headless', model: 'opus', leasedAt: T0, leaseUntil: T1, state: 'leased', refusedTools: null });
    expect(liveTurn(db, it1.id)?.id).toBe(turn.id);
    expect(() => insertTurn(db, { itemId: it1.id, way: 'thread', leaseMs: 1000 }, T1)).toThrow(/UNIQUE/);
    // Once the first is no longer live, a new turn may be leased.
    expect(moveTurn(db, turn.id, ['leased'], 'failed')).toBe(true);
    expect(liveTurn(db, it1.id)).toBeUndefined();
    expect(insertTurn(db, { itemId: it1.id, way: 'thread', leaseMs: 1000 }, T1).state).toBe('leased');
  });

  it('takes the project from the desk item, and refuses an item that does not exist', () => {
    db.prepare("INSERT INTO projects (id, slug, name, root_node_id, created_at, updated_at) VALUES (2, 'q', 'Q', 0, ?, ?)").run(T0, T0);
    const other = addDeskItem(db, { projectId: 2, kind: 'stuck', ref: 's9' }, T0).item;
    expect(insertTurn(db, { itemId: other.id, way: 'headless', leaseMs: 1000 }, T0).projectId).toBe(2);
    expect(() => insertTurn(db, { itemId: 999, way: 'headless', leaseMs: 1000 }, T0)).toThrow('No desk item 999');
  });

  it('lets only one turn of an item reach applied', () => {
    const it1 = item();
    const a = insertTurn(db, { itemId: it1.id, way: 'headless', leaseMs: 1000 }, T0);
    expect(moveTurn(db, a.id, ['leased', 'answered'], 'applied')).toBe(true);
    const b = insertTurn(db, { itemId: it1.id, way: 'headless', leaseMs: 1000 }, T1);
    expect(() => moveTurn(db, b.id, ['leased', 'answered'], 'applied')).toThrow(/UNIQUE/);
    expect(getTurn(db, b.id)?.state).toBe('leased');
  });

  it('writes the fields given, stores refusedTools as JSON, and refuses a move from a state not in from', () => {
    const it1 = item();
    const turn = insertTurn(db, { itemId: it1.id, way: 'headless', leaseMs: 1000 }, T0);
    expect(moveTurn(db, turn.id, ['leased'], 'answered', {
      startedAt: T0, finishedAt: T1, verdict: 'answer', answer: 'Use 4317', why: 'It is the port', kind: 'technical',
      costUsd: 0.12, durationMs: 4200, tokensIn: 900, tokensOut: 80, refusedTools: ['Bash', 'Write'],
    })).toBe(true);
    expect(getTurn(db, turn.id)).toMatchObject({
      state: 'answered', startedAt: T0, finishedAt: T1, verdict: 'answer', answer: 'Use 4317', why: 'It is the port', kind: 'technical',
      costUsd: 0.12, durationMs: 4200, tokensIn: 900, tokensOut: 80, refusedTools: ['Bash', 'Write'],
    });
    expect(db.prepare('SELECT refused_tools FROM lead_turns WHERE id = ?').pluck().get(turn.id)).toBe('["Bash","Write"]');
    expect(moveTurn(db, turn.id, ['leased'], 'failed', { why: 'late' })).toBe(false);
    expect(getTurn(db, turn.id)).toMatchObject({ state: 'answered', why: 'It is the port' });
  });
});

describe('lead decisions', () => {
  it('writes one decision per lead_events row and reads them by event and since', () => {
    const insertEvent = db.prepare("INSERT INTO lead_events (project_id, at, lead, instructions, kind) VALUES (1, ?, 'Progresser', 6, 'decide')");
    const e1 = Number(insertEvent.run(T0).lastInsertRowid);
    const e2 = Number(insertEvent.run(T1).lastInsertRowid);
    const d1 = addDecision(db, { eventId: e1, kind: 'product', productRuling: true, line: 'Dark mode waits', saidWhere: 'voice', saidAt: T0 });
    expect(d1).toMatchObject({ eventId: e1, productRuling: true, line: 'Dark mode waits', saidWhere: 'voice', itemId: null, turnId: null });
    const d2 = addDecision(db, { eventId: e2, kind: 'technical', line: 'Port 4317', saidAt: T1 });
    expect(d2.productRuling).toBe(false);
    expect(() => addDecision(db, { eventId: e1, kind: 'order', line: 'again', saidAt: T2 })).toThrow(/UNIQUE/);
    expect(decisionByEvent(db, e2)?.id).toBe(d2.id);
    expect(decisionsSince(db, 1, T0).map((d) => d.id)).toEqual([d1.id, d2.id]);
    expect(decisionsSince(db, 1, T1).map((d) => d.id)).toEqual([d2.id]);
  });

  it('takes the project from the lead_events row, and refuses an event that does not exist', () => {
    db.prepare("INSERT INTO projects (id, slug, name, root_node_id, created_at, updated_at) VALUES (2, 'q', 'Q', 0, ?, ?)").run(T0, T0);
    const e = Number(db.prepare("INSERT INTO lead_events (project_id, at, lead, instructions, kind) VALUES (2, ?, 'Progresser', 6, 'decide')").run(T0).lastInsertRowid);
    expect(addDecision(db, { eventId: e, kind: 'order', line: 'B before A', saidAt: T0 }).projectId).toBe(2);
    expect(() => addDecision(db, { eventId: 999, kind: 'order', line: 'nowhere', saidAt: T0 })).toThrow('No lead_events row 999');
    expect(db.prepare('SELECT COUNT(*) FROM lead_decisions').pluck().get()).toBe(1);
  });
});

describe('lead sends', () => {
  it('writes a send as intended and refuses a retry key used before', () => {
    const send = intendSend(db, { projectId: 1, kind: 'relay', target: 'thread-1', retryKey: 'k1', body: 'Port 4317' }, T0);
    expect(send).toMatchObject({ state: 'intended', target: 'thread-1', retryKey: 'k1', body: 'Port 4317', createdAt: T0, doneAt: null, seenAt: null });
    expect(() => intendSend(db, { projectId: 1, kind: 'relay', target: 'thread-1', retryKey: 'k1' }, T1)).toThrow(/UNIQUE/);
    expect(sendByRetryKey(db, 'k1')?.id).toBe(send.id);
    expect(sendByRetryKey(db, 'k2')).toBeUndefined();
    // Sends with no key never collide.
    intendSend(db, { projectId: 1, kind: 'voice_line', target: 'webhook' }, T1);
    intendSend(db, { projectId: 1, kind: 'voice_line', target: 'webhook' }, T1);
    expect(sendsInState(db, 1, 'intended')).toHaveLength(3);
  });

  it('moves a send by compare-and-set, setting done_at on done', () => {
    const send = intendSend(db, { projectId: 1, kind: 'start', target: 'thread-1' }, T0);
    expect(moveSend(db, send.id, ['unknown'], 'done', { now: T1 })).toBe(false);
    expect(moveSend(db, send.id, ['intended'], 'done', { result: 'msg-9', now: T1 })).toBe(true);
    expect(getSend(db, send.id)).toMatchObject({ state: 'done', result: 'msg-9', doneAt: T1 });
    expect(sendsInState(db, 1, 'done').map((s) => s.id)).toEqual([send.id]);
  });

  it('stamps seen once', () => {
    const send = intendSend(db, { projectId: 1, kind: 'morning', target: 'webhook' }, T0);
    expect(stampSeen(db, send.id, T1)).toBe(true);
    expect(stampSeen(db, send.id, T2)).toBe(false);
    expect(getSend(db, send.id)?.seenAt).toBe(T1);
  });
});

describe('usage readings', () => {
  it('adds an import once', () => {
    expect(addReading(db, { at: T0, source: 'import', weekUsed: 40 })).toMatchObject({ at: T0, source: 'import', weekUsed: 40 });
    expect(addReading(db, { at: T0, source: 'import', weekUsed: 41 })).toBeUndefined();
    expect(db.prepare('SELECT COUNT(*) FROM usage_readings').pluck().get()).toBe(1);
    // The once-only rule is the import's: two probes at one time are two readings.
    expect(addReading(db, { at: T0, source: 'probe' })).toBeDefined();
    expect(addReading(db, { at: T0, source: 'probe' })).toBeDefined();
  });

  it('reads the newest, by model when one is given', () => {
    addReading(db, { at: T1, source: 'probe', model: 'opus', windowUsed: 10 });
    addReading(db, { at: T2, source: 'turn', model: 'sonnet', windowUsed: 20 });
    addReading(db, { at: T0, source: 'probe', model: 'opus', windowUsed: 5 });
    expect(latestReading(db)).toMatchObject({ at: T2, model: 'sonnet' });
    expect(latestReading(db, 'opus')).toMatchObject({ at: T1, windowUsed: 10 });
    expect(latestReading(db, 'haiku')).toBeUndefined();
  });
});

describe('desk-only events (Y10, Y12)', () => {
  it('a desk-only project.updated is not the last event, and does not move last_event_at', () => {
    const ctx = makeCtx();
    const project = createProject(ctx, 'test', { name: 'Desky' });
    const before = lastProjectEvent(ctx, project.id)!;
    const at = listProjectSummaries(ctx).find((p) => p.id === project.id)!.lastEventAt;
    write(ctx, 'system', () => addDeskItem(ctx.db, { projectId: project.id, kind: 'stuck', ref: 'x1' }, ctx.now()));
    expect(ctx.db.prepare("SELECT COUNT(*) FROM events WHERE type = 'project.updated' AND data = ?").pluck().get(JSON.stringify(DESK_ONLY_DATA))).toBe(1);
    expect(lastProjectEvent(ctx, project.id)!.id).toBe(before.id);
    expect(listProjectSummaries(ctx).find((p) => p.id === project.id)!.lastEventAt).toBe(at);
  });

  it('a lease whose window event cannot be written still answers its turn, and says why in the log', () => {
    let fail = false;
    const base = makeCtx();
    const ctx = { ...base };
    const project = createProject(base, 'test', { name: 'Desky' });
    const item = write(base, 'system', () => addDeskItem(base.db, { projectId: project.id, kind: 'stuck', ref: 'x2' }, base.now()).item);
    const logged = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const now = base.now();
    base.now = () => {
      if (fail) throw new Error('clock gone');
      return now;
    };
    fail = true;
    expect(leaseItem(ctx.db, item.id, { way: 'headless', leaseMs: 60_000 }, now)).toBeDefined();
    expect(logged.mock.calls.some((c) => String(c[0]).includes('could not tell the window of a desk change: clock gone'))).toBe(true);
    logged.mockRestore();
  });
});
