import type { DB } from '../db/connection';

/** Where a reading came from (migration 21): a turn's own report, a probe, or an imported file. */
export type ReadingSource = 'turn' | 'probe' | 'import';

/** A reading of the account's usage gauges. */
export interface UsageReading {
  id: number;
  at: string;
  source: ReadingSource;
  turnId: number | null;
  model: string | null;
  windowUsed: number | null;
  windowResets: string | null;
  weekUsed: number | null;
  weekResets: string | null;
  /** JSON text: any further gauge. */
  other: string | null;
}

interface UsageReadingRow {
  id: number;
  at: string;
  source: string;
  turn_id: number | null;
  model: string | null;
  window_used: number | null;
  window_resets: string | null;
  week_used: number | null;
  week_resets: string | null;
  other: string | null;
}

const toUsageReading = (r: UsageReadingRow): UsageReading => ({
  id: r.id,
  at: r.at,
  source: r.source as ReadingSource,
  turnId: r.turn_id,
  model: r.model,
  windowUsed: r.window_used,
  windowResets: r.window_resets,
  weekUsed: r.week_used,
  weekResets: r.week_resets,
  other: r.other,
});

export interface AddReadingInput {
  at: string;
  source: ReadingSource;
  turnId?: number | null;
  model?: string | null;
  windowUsed?: number | null;
  windowResets?: string | null;
  weekUsed?: number | null;
  weekResets?: string | null;
  other?: string | null;
}

/** Writes the reading; undefined when it is an import already held (same at and source), which adds nothing. */
export function addReading(db: DB, row: AddReadingInput): UsageReading | undefined {
  const info = db
    .prepare(
      'INSERT INTO usage_readings (at, source, turn_id, model, window_used, window_resets, week_used, week_resets, other)' +
        ' VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT DO NOTHING',
    )
    .run(
      row.at,
      row.source,
      row.turnId ?? null,
      row.model ?? null,
      row.windowUsed ?? null,
      row.windowResets ?? null,
      row.weekUsed ?? null,
      row.weekResets ?? null,
      row.other ?? null,
    );
  if (info.changes === 0) return undefined;
  return toUsageReading(db.prepare('SELECT * FROM usage_readings WHERE id = ?').get(Number(info.lastInsertRowid)) as UsageReadingRow);
}

/** The newest reading (by at, then id), of this model when one is given. */
export function latestReading(db: DB, model?: string): UsageReading | undefined {
  const row = (model === undefined
    ? db.prepare('SELECT * FROM usage_readings ORDER BY at DESC, id DESC LIMIT 1').get()
    : db.prepare('SELECT * FROM usage_readings WHERE model = ? ORDER BY at DESC, id DESC LIMIT 1').get(model)) as UsageReadingRow | undefined;
  return row ? toUsageReading(row) : undefined;
}
