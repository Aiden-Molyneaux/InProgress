import type { LeadSwitch } from '../../core/lead';
import type { DB } from '../db/connection';

/** The newest allow or disallow line of a switch, as the lead's log holds it. */
export interface SwitchLine {
  kind: 'allow' | 'disallow';
  at: string;
  /** Aiden's words on the line (an allow always has them). */
  aidenWords: string | null;
}

/** The read switchLine runs: served by lead_events_switch (a test plans this very text). */
export const SWITCH_LINE_SQL = "SELECT kind, at, aiden_words FROM lead_events WHERE project_id = ? AND kind IN ('allow', 'disallow') AND text = ? ORDER BY at DESC, id DESC LIMIT 1";

/**
 * The newest `allow` or `disallow` line for switch `name` in the project's log, or undefined when it has none. Every
 * reader of a switch reads it through here: on when this line is an allow. Served by lead_events_switch.
 */
export function switchLine(db: DB, projectId: number, name: LeadSwitch): SwitchLine | undefined {
  const row = db
    .prepare(SWITCH_LINE_SQL)
    .get(projectId, name) as { kind: 'allow' | 'disallow'; at: string; aiden_words: string | null } | undefined;
  return row === undefined ? undefined : { kind: row.kind, at: row.at, aidenWords: row.aiden_words };
}

/** When the lead's round was switched on, while it is on: the newest line's time when that line is an allow; else null. */
export function roundSince(db: DB, projectId: number): string | null {
  const line = switchLine(db, projectId, 'round');
  return line?.kind === 'allow' ? line.at : null;
}

/** The read roundFirstOn runs: its kind IN term matches lead_events_switch's own WHERE, so the partial index serves it. */
export const ROUND_FIRST_ON_SQL = "SELECT at FROM lead_events WHERE project_id = ? AND kind IN ('allow', 'disallow') AND text = 'round' AND kind = 'allow' ORDER BY at, id LIMIT 1";

/**
 * The first time the round was ever switched on for the project: the earliest allow line for it, or null when it never
 * was. Asks raised and stops made before it are task 17's old asks, not desk items; those made while the round was off
 * later are taken once it is back on.
 */
export function roundFirstOn(db: DB, projectId: number): string | null {
  return (db
    .prepare(ROUND_FIRST_ON_SQL)
    .pluck()
    .get(projectId) as string | undefined) ?? null;
}

/**
 * The bound the round's producers apply: the first switch-on, when the round is on now; null when it is off. A raise or a
 * stop at or after it is the desk's.
 */
export function roundBound(db: DB, projectId: number): string | null {
  return roundSince(db, projectId) === null ? null : roundFirstOn(db, projectId);
}
