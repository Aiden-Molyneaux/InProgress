import type { LeadEventKind } from '../../core/lead';
import type { DB } from '../db/connection';

/** One line for the lead's log. */
export interface LeadEventInput {
  projectId: number;
  lead: string;
  instructions: number;
  kind: LeadEventKind;
  nodeId?: number;
  askId?: number;
  sessionId?: string;
  text?: string;
  aidenWords?: string;
}

/** One line in the lead's log at `at`, answering its id. A plain insert: the caller holds the write it belongs to. */
export function insertLeadEvent(db: DB, e: LeadEventInput, at: string): number {
  const info = db
    .prepare('INSERT INTO lead_events (project_id, at, lead, instructions, kind, node_id, ask_id, session_id, text, aiden_words) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
    .run(e.projectId, at, e.lead, e.instructions, e.kind, e.nodeId ?? null, e.askId ?? null, e.sessionId ?? null, e.text ?? '', e.aidenWords ?? null);
  return Number(info.lastInsertRowid);
}
