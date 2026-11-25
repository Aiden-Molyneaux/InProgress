import type { DB } from '../db/connection';
import { getDeskItem, moveDeskItem, type DeskItem } from './desk';

/** How a turn runs (migration 21): a headless run, or a message in the lead's thread. */
export type TurnWay = 'headless' | 'thread';

/**
 * A turn's state. `interrupted`: ended by the runner, not by the item (the runner could not run claude, the server
 * stopped, the item left the desk mid-run); unlike failed and abandoned it does not count toward an item's behind.
 */
export type TurnState = 'leased' | 'answered' | 'applied' | 'failed' | 'abandoned' | 'interrupted';

/** A turn of the lead on one desk item. */
export interface LeadTurn {
  id: number;
  itemId: number;
  projectId: number;
  way: TurnWay;
  model: string | null;
  leasedAt: string;
  leaseUntil: string;
  startedAt: string | null;
  finishedAt: string | null;
  state: TurnState;
  verdict: string | null;
  answer: string | null;
  why: string | null;
  kind: string | null;
  costUsd: number | null;
  durationMs: number | null;
  tokensIn: number | null;
  tokensOut: number | null;
  /** The tools the turn was refused, or null when none were recorded. */
  refusedTools: string[] | null;
}

interface LeadTurnRow {
  id: number;
  item_id: number;
  project_id: number;
  way: string;
  model: string | null;
  leased_at: string;
  lease_until: string;
  started_at: string | null;
  finished_at: string | null;
  state: string;
  verdict: string | null;
  answer: string | null;
  why: string | null;
  kind: string | null;
  cost_usd: number | null;
  duration_ms: number | null;
  tokens_in: number | null;
  tokens_out: number | null;
  refused_tools: string | null;
}

const toLeadTurn = (r: LeadTurnRow): LeadTurn => ({
  id: r.id,
  itemId: r.item_id,
  projectId: r.project_id,
  way: r.way as TurnWay,
  model: r.model,
  leasedAt: r.leased_at,
  leaseUntil: r.lease_until,
  startedAt: r.started_at,
  finishedAt: r.finished_at,
  state: r.state as TurnState,
  verdict: r.verdict,
  answer: r.answer,
  why: r.why,
  kind: r.kind,
  costUsd: r.cost_usd,
  durationMs: r.duration_ms,
  tokensIn: r.tokens_in,
  tokensOut: r.tokens_out,
  refusedTools: r.refused_tools === null ? null : (JSON.parse(r.refused_tools) as string[]),
});

/** A turn to lease. Its project is its desk item's. */
export interface InsertTurnInput {
  itemId: number;
  way: TurnWay;
  model?: string | null;
  /** How long the lease runs from `now`. */
  leaseMs: number;
}

/**
 * A new turn on the item's project, leased until now + leaseMs. Throws when the item does not exist. An item with a
 * live turn (leased or answered) refuses a second one: the unique index lead_turns_live_once throws, and the caller
 * decides what that means.
 */
export function insertTurn(db: DB, input: InsertTurnInput, now: string): LeadTurn {
  const leaseUntil = new Date(Date.parse(now) + input.leaseMs).toISOString();
  const info = db
    .prepare('INSERT INTO lead_turns (item_id, project_id, way, model, leased_at, lease_until) SELECT id, project_id, ?, ?, ?, ? FROM desk_items WHERE id = ?')
    .run(input.way, input.model ?? null, now, leaseUntil, input.itemId);
  if (info.changes === 0) throw new Error(`No desk item ${input.itemId}: a turn is leased on an item`);
  return getTurn(db, Number(info.lastInsertRowid))!;
}

export function getTurn(db: DB, id: number): LeadTurn | undefined {
  const row = db.prepare('SELECT * FROM lead_turns WHERE id = ?').get(id) as LeadTurnRow | undefined;
  return row ? toLeadTurn(row) : undefined;
}

/** The item's turn in leased or answered, or undefined. */
export function liveTurn(db: DB, itemId: number): LeadTurn | undefined {
  const row = db.prepare("SELECT * FROM lead_turns WHERE item_id = ? AND state IN ('leased', 'answered')").get(itemId) as LeadTurnRow | undefined;
  return row ? toLeadTurn(row) : undefined;
}

export type TurnFields = Partial<{
  startedAt: string;
  finishedAt: string;
  verdict: string;
  answer: string;
  why: string;
  kind: string;
  costUsd: number;
  durationMs: number;
  tokensIn: number;
  tokensOut: number;
  refusedTools: string[];
}>;

const COLUMNS: Record<keyof TurnFields, string> = {
  startedAt: 'started_at',
  finishedAt: 'finished_at',
  verdict: 'verdict',
  answer: 'answer',
  why: 'why',
  kind: 'kind',
  costUsd: 'cost_usd',
  durationMs: 'duration_ms',
  tokensIn: 'tokens_in',
  tokensOut: 'tokens_out',
  refusedTools: 'refused_tools',
};

/**
 * Compare-and-set: moves the turn to `to`, writing the fields given, only while its state is one of `from`. Two turns
 * of one item never both reach applied: lead_turns_applied_once throws on the second. Returns whether the row changed.
 */
export function moveTurn(db: DB, id: number, from: TurnState[], to: TurnState, fields: TurnFields = {}): boolean {
  if (from.length === 0) return false;
  const sets = ['state = ?'];
  const values: unknown[] = [to];
  // Over the known columns, not the caller's keys, so only a named field ever reaches the SQL.
  for (const key of Object.keys(COLUMNS) as (keyof TurnFields)[]) {
    const value = fields[key];
    if (value === undefined) continue;
    sets.push(`${COLUMNS[key]} = ?`);
    values.push(key === 'refusedTools' ? JSON.stringify(value) : value);
  }
  const info = db
    .prepare(`UPDATE lead_turns SET ${sets.join(', ')} WHERE id = ? AND state IN (${from.map(() => '?').join(', ')})`)
    .run(...values, id, ...from);
  return info.changes > 0;
}

/** Whether `err` is lead_turns_live_once refusing a second live turn: the only unique index a leased insert can meet. */
function isLiveOnce(err: unknown): boolean {
  const e = err as { code?: unknown; message?: unknown };
  return e?.code === 'SQLITE_CONSTRAINT_UNIQUE' && typeof e.message === 'string' && e.message.includes('lead_turns.item_id');
}

export interface LeaseInput {
  way: TurnWay;
  model?: string | null;
  /** How long the lease runs from `now`. */
  leaseMs: number;
}

/**
 * The only way into a turn, in one immediate transaction: the item moves open or behind to leased (compare-and-set) and
 * its turn is inserted, leased until now + leaseMs. Undefined, with nothing written, when the item is in no such state
 * or already has a live turn. Any other error is thrown.
 */
export function leaseItem(db: DB, itemId: number, input: LeaseInput, now: string): LeadTurn | undefined {
  try {
    return db.transaction((): LeadTurn | undefined => {
      if (!moveDeskItem(db, itemId, ['open', 'behind'], 'leased', { now })) return undefined;
      // A throw here rolls back the item's move with it.
      return insertTurn(db, { itemId, ...input }, now);
    }).immediate();
  } catch (err) {
    if (isLiveOnce(err)) return undefined;
    throw err;
  }
}

/** What a turn's answer saves. finishedAt defaults to `now`. */
export type AnswerFields = Omit<TurnFields, 'verdict' | 'answer' | 'why' | 'kind'> & { verdict: string; answer: string; why: string; kind: string };

/** In one immediate transaction, the turn leased to answered with its answer and costs. False when it was no longer leased. */
export function saveAnswer(db: DB, turnId: number, fields: AnswerFields, now: string): boolean {
  return db.transaction(() => moveTurn(db, turnId, ['leased'], 'answered', { finishedAt: now, ...fields })).immediate();
}

/** What applying an answer does to its item, and the outcome written on it. */
export interface TurnEffect {
  itemState: 'done' | 'waiting_aiden';
  outcome: string;
}

/**
 * In one immediate transaction: the turn answered to applied and its item leased to the effect's state, both
 * compare-and-set, with `effect` run between them so its own writes commit or roll back with the two moves. False, with
 * the effect not run, when the turn is not answered (it is left as it is: a leased turn is the lease's to end, an applied
 * one is done) or its item is no longer leased (cleared while the turn ran): then an answered turn moves to abandoned. A
 * throw from the effect rolls everything back and is rethrown: the turn stays answered for the next recovery.
 */
export function applyTurn(db: DB, turnId: number, now: string, effect: (turn: LeadTurn, item: DeskItem) => TurnEffect): boolean {
  return db.transaction((): boolean => {
    const turn = getTurn(db, turnId);
    if (turn === undefined || turn.state !== 'answered') return false;
    const item = getDeskItem(db, turn.itemId);
    if (item === undefined || item.state !== 'leased') {
      moveTurn(db, turnId, ['answered'], 'abandoned', { finishedAt: turn.finishedAt ?? now });
      return false;
    }
    const result = effect(turn, item);
    if (!moveTurn(db, turnId, ['answered'], 'applied')) throw new Error(`Turn ${turnId} left answered inside its own apply`);
    // From done too: the effect's own clear of the item's ask closes the item (deskOnAskCleared) in this transaction, and
    // the effect's outcome is the one to keep. Nothing else can have moved it: the item was leased when the effect began.
    // An item its effect closed stays done: an effect that cleared the ask and still says waiting_aiden is a bug.
    if (getDeskItem(db, item.id)?.state === 'done' && result.itemState !== 'done') {
      throw new Error(`Desk item ${item.id} was closed by its own apply, which still says ${result.itemState}`);
    }
    if (!moveDeskItem(db, item.id, ['leased', 'done'], result.itemState, { outcome: result.outcome, now })) {
      throw new Error(`Desk item ${item.id} left leased inside its own apply`);
    }
    return true;
  }).immediate();
}

/** How many failed or abandoned turns move an item to behind: the runner gives up on it. */
export const TURN_FAILURES_BEHIND = 2;
/** How many runner faults in a row on one item move it to behind, so one bad item (a prompt too long) cannot hold its lane. */
export const TURN_FAULTS_BEHIND = 3;
/** How an interrupted turn's `why` opens when the fault was the runner's: the runner writes it, releaseItem counts it. */
export const RUNNER_FAULT_WHY = 'the runner could not run the turn';

/**
 * In one immediate transaction: the turn leased to `state` with `why` (and any further fields, such as a failed turn's
 * cost), and its item leased back to open, or to behind when it now has TURN_FAILURES_BEHIND turns failed or abandoned
 * (an interrupted turn is not counted), or when its last TURN_FAULTS_BEHIND turns were all runner faults (interrupted, the
 * why opening RUNNER_FAULT_WHY). An item no longer leased (cleared meanwhile) is left as it is. False when the turn was no
 * longer leased.
 */
export function failTurn(db: DB, turnId: number, state: 'failed' | 'abandoned' | 'interrupted', why: string, now: string, fields: TurnFields = {}): boolean {
  return db.transaction((): boolean => {
    if (!moveTurn(db, turnId, ['leased'], state, { finishedAt: now, ...fields, why })) return false;
    releaseItem(db, turnId, now);
    return true;
  }).immediate();
}

/**
 * In one immediate transaction: an answered turn whose apply keeps throwing moves to failed with `why` (its verdict and
 * answer stay on the row), and its item leased back to open or behind, as failTurn does. False when it was no longer answered.
 */
export function failAnsweredTurn(db: DB, turnId: number, why: string, now: string): boolean {
  return db.transaction((): boolean => {
    if (!moveTurn(db, turnId, ['answered'], 'failed', { why })) return false;
    releaseItem(db, turnId, now);
    return true;
  }).immediate();
}

/**
 * The failed turn's item, leased back to open, or to behind at TURN_FAILURES_BEHIND failed or abandoned turns, or at
 * TURN_FAULTS_BEHIND runner faults in a row.
 */
function releaseItem(db: DB, turnId: number, now: string): void {
  const itemId = getTurn(db, turnId)!.itemId;
  const failures = db.prepare("SELECT COUNT(*) FROM lead_turns WHERE item_id = ? AND state IN ('failed', 'abandoned')").pluck().get(itemId) as number;
  const last = db.prepare('SELECT state, why FROM lead_turns WHERE item_id = ? ORDER BY id DESC LIMIT ?').all(itemId, TURN_FAULTS_BEHIND) as { state: string; why: string | null }[];
  const faults = last.length === TURN_FAULTS_BEHIND && last.every((t) => t.state === 'interrupted' && (t.why ?? '').startsWith(RUNNER_FAULT_WHY));
  moveDeskItem(db, itemId, ['leased'], failures >= TURN_FAILURES_BEHIND || faults ? 'behind' : 'open', { now });
}

/**
 * In one immediate transaction: the project's behind items whose latest turn is a runner fault (interrupted, the why
 * opening RUNNER_FAULT_WHY) go back to open, answering their ids. The runner calls it when a turn of the project ends ok:
 * claude runs again, so a stretch it could not run (a usage limit, a sign-out) does not keep those items behind for good.
 * An item behind on its own failed or abandoned turns has a latest turn that is not a fault, and stays behind.
 */
export function reopenFaultedItems(db: DB, projectId: number, now: string): number[] {
  return db.transaction((): number[] => {
    const ids = db
      .prepare(
        `SELECT d.id FROM desk_items d
          WHERE d.project_id = ? AND d.state = 'behind'
            AND EXISTS (SELECT 1 FROM lead_turns t WHERE t.id = (SELECT MAX(id) FROM lead_turns WHERE item_id = d.id)
                          AND t.state = 'interrupted' AND substr(COALESCE(t.why, ''), 1, length(?)) = ?)
          ORDER BY d.id`,
      )
      .pluck()
      .all(projectId, RUNNER_FAULT_WHY, RUNNER_FAULT_WHY) as number[];
    return ids.filter((id) => moveDeskItem(db, id, ['behind'], 'open', { now }));
  }).immediate();
}

/** Turns with an answer saved and not applied, oldest first: recovery applies them without running again. */
export function answeredTurns(db: DB): { id: number; itemId: number }[] {
  return db.prepare("SELECT id, item_id AS itemId FROM lead_turns WHERE state = 'answered' ORDER BY id").all() as { id: number; itemId: number }[];
}

/** Leased turns whose lease ran out before `now`, oldest first. */
export function expiredLeases(db: DB, now: string): { id: number; itemId: number }[] {
  return db.prepare("SELECT id, item_id AS itemId FROM lead_turns WHERE state = 'leased' AND lease_until < ? ORDER BY id").all(now) as { id: number; itemId: number }[];
}
