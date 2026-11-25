import type { DB } from '../db/connection';

/** How a turn runs (migration 21): a headless run, or a message in the lead's thread. */
export type TurnWay = 'headless' | 'thread';

export type TurnState = 'leased' | 'answered' | 'applied' | 'failed' | 'abandoned';

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

export interface InsertTurnInput {
  itemId: number;
  projectId: number;
  way: TurnWay;
  model?: string | null;
  /** How long the lease runs from `now`. */
  leaseMs: number;
}

/**
 * A new turn, leased until now + leaseMs. An item with a live turn (leased or answered) refuses a second one: the
 * unique index lead_turns_live_once throws, and the caller decides what that means.
 */
export function insertTurn(db: DB, input: InsertTurnInput, now: string): LeadTurn {
  const leaseUntil = new Date(Date.parse(now) + input.leaseMs).toISOString();
  const info = db
    .prepare('INSERT INTO lead_turns (item_id, project_id, way, model, leased_at, lease_until) VALUES (?, ?, ?, ?, ?, ?)')
    .run(input.itemId, input.projectId, input.way, input.model ?? null, now, leaseUntil);
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
