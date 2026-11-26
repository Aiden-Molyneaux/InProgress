// The cut of the exam: puts a copy of the database back to how it stood at BEFORE (the ask's raised_at), as stage 0's
// record tool (rec2.cjs) showed it, but by changing the copy itself. Only ever run on a case's own copy.
// `db` is an open better-sqlite3 handle with foreign keys on and migrations run.

/** Each table that holds rows written over time, with the SQL that picks those written after BEFORE (one ? for it). */
export const AFTER = {
  log_entries: 'created_at > ?',
  resources: 'created_at > ?',
  asks: 'raised_at > ?',
  nodes: 'created_at > ?',
  lead_decisions: 'said_at > ?',
  lead_events: 'at > ?',
  events: 'ts > ?',
};

/**
 * The status of a step reopened by the cut: 'active'. The schema's open statuses are todo, active and blocked; a step that
 * was done, parked or dropped had work on it, and 'active' is the status of a step with work on it ('todo' has none).
 */
export const REOPENED_STATUS = 'active';

/** Rows written after BEFORE, per table, plus the asks and steps the cut reopens and the sessions that exist. */
export function countAfter(db, before) {
  const out = {};
  for (const [table, where] of Object.entries(AFTER)) out[table] = db.prepare(`SELECT COUNT(*) FROM ${table} WHERE ${where}`).pluck().get(before);
  out.asks_cleared_after = db.prepare('SELECT COUNT(*) FROM asks WHERE cleared_at > ?').pluck().get(before);
  out.steps_closed_after = db.prepare('SELECT COUNT(*) FROM nodes WHERE completed_at > ? OR parked_at > ?').pluck().get(before, before);
  out.sessions = db.prepare('SELECT COUNT(*) FROM sessions').pluck().get();
  return out;
}

/**
 * Cuts the database at `before` for the case's own ask `askId`: rows written after it deleted, an ask cleared after it open
 * again, a step finished, parked or dropped after it open again, every session row gone. The case's ask stays, open.
 * Throws when the ask is not open at the end (an unrelated unique index would keep it cleared).
 */
export function cutAt(db, before, askId) {
  const run = db.transaction(() => {
    // Reopen first, so a step made after BEFORE that was also closed is simply deleted below.
    db.prepare(
      "UPDATE OR IGNORE asks SET cleared_at = NULL, cleared_by = NULL, answer = '', answer_delivered_at = NULL, answered_via = NULL WHERE cleared_at > ? OR id = ?",
    ).run(before, askId);
    db.prepare(
      `UPDATE nodes SET status = '${REOPENED_STATUS}', completed_at = NULL, outcome = '', parked_reason = '', parked_where = '', parked_at = NULL WHERE completed_at > ? OR parked_at > ?`,
    ).run(before, before);
    db.prepare('DELETE FROM lead_events WHERE at > ?').run(before);
    db.prepare('DELETE FROM lead_decisions WHERE said_at > ?').run(before);
    db.prepare('DELETE FROM log_entries WHERE created_at > ?').run(before);
    db.prepare('DELETE FROM resources WHERE created_at > ?').run(before);
    db.prepare('DELETE FROM asks WHERE raised_at > ? AND id <> ?').run(before, askId);
    db.prepare('DELETE FROM nodes WHERE created_at > ?').run(before);
    db.prepare('DELETE FROM events WHERE ts > ?').run(before);
    // Every session row: no stopped item, no live session. Rows that name one are cleared by their own foreign keys.
    db.prepare('UPDATE nodes SET driver_session_id = NULL').run();
    db.prepare('DELETE FROM sessions').run();
  });
  run();
  const ask = db.prepare('SELECT cleared_at, answer FROM asks WHERE id = ?').get(askId);
  if (ask === undefined) throw new Error(`the cut at ${before} removed ask ${askId} itself`);
  if (ask.cleared_at !== null || ask.answer !== '') throw new Error(`ask ${askId} is still answered after the cut at ${before}`);
}
