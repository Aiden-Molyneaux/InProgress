import type { DB } from '../db/connection';

/** What a decision was about (migration 21). */
export type DecisionKind = 'product' | 'technical' | 'order' | 'permission' | 'restart' | 'old_ask';

/** Where Aiden said his answer. */
export type SaidWhere = 'desk' | 'voice' | 'thread';

/** A decision of the lead, beside its lead_events row. */
export interface LeadDecision {
  id: number;
  eventId: number;
  projectId: number;
  itemId: number | null;
  turnId: number | null;
  kind: DecisionKind;
  /** product_ruling, stored 0 or 1. */
  productRuling: boolean;
  /** The one line the list shows. */
  line: string;
  wouldHave: string | null;
  aidenAnswer: string | null;
  aidenWords: string | null;
  saidWhere: SaidWhere | null;
  saidAt: string | null;
  shownAt: string | null;
}

interface LeadDecisionRow {
  id: number;
  event_id: number;
  project_id: number;
  item_id: number | null;
  turn_id: number | null;
  kind: string;
  product_ruling: number;
  line: string;
  would_have: string | null;
  aiden_answer: string | null;
  aiden_words: string | null;
  said_where: string | null;
  said_at: string | null;
  shown_at: string | null;
}

const toLeadDecision = (r: LeadDecisionRow): LeadDecision => ({
  id: r.id,
  eventId: r.event_id,
  projectId: r.project_id,
  itemId: r.item_id,
  turnId: r.turn_id,
  kind: r.kind as DecisionKind,
  productRuling: r.product_ruling !== 0,
  line: r.line,
  wouldHave: r.would_have,
  aidenAnswer: r.aiden_answer,
  aidenWords: r.aiden_words,
  saidWhere: r.said_where as SaidWhere | null,
  saidAt: r.said_at,
  shownAt: r.shown_at,
});

export interface AddDecisionInput {
  eventId: number;
  projectId: number;
  itemId?: number | null;
  turnId?: number | null;
  kind: DecisionKind;
  productRuling?: boolean;
  line: string;
  wouldHave?: string | null;
  aidenAnswer?: string | null;
  aidenWords?: string | null;
  saidWhere?: SaidWhere | null;
  saidAt?: string | null;
  shownAt?: string | null;
}

/** Writes the decision for its lead_events row; a second one for the same event throws (event_id is unique). */
export function addDecision(db: DB, row: AddDecisionInput): LeadDecision {
  const info = db
    .prepare(
      'INSERT INTO lead_decisions (event_id, project_id, item_id, turn_id, kind, product_ruling, line, would_have, aiden_answer, aiden_words, said_where, said_at, shown_at)' +
        ' VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
    )
    .run(
      row.eventId,
      row.projectId,
      row.itemId ?? null,
      row.turnId ?? null,
      row.kind,
      row.productRuling ? 1 : 0,
      row.line,
      row.wouldHave ?? null,
      row.aidenAnswer ?? null,
      row.aidenWords ?? null,
      row.saidWhere ?? null,
      row.saidAt ?? null,
      row.shownAt ?? null,
    );
  return toLeadDecision(db.prepare('SELECT * FROM lead_decisions WHERE id = ?').get(Number(info.lastInsertRowid)) as LeadDecisionRow);
}

export function decisionByEvent(db: DB, eventId: number): LeadDecision | undefined {
  const row = db.prepare('SELECT * FROM lead_decisions WHERE event_id = ?').get(eventId) as LeadDecisionRow | undefined;
  return row ? toLeadDecision(row) : undefined;
}

/** The project's decisions said at or after `since` (ISO), oldest first. */
export function decisionsSince(db: DB, projectId: number, since: string): LeadDecision[] {
  return (db
    .prepare('SELECT * FROM lead_decisions WHERE project_id = ? AND said_at >= ? ORDER BY said_at, id')
    .all(projectId, since) as LeadDecisionRow[]).map(toLeadDecision);
}
