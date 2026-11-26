import { readFileSync } from 'node:fs';
import { stamp } from '../../core/span';
import type { Ctx } from '../db/tx';
import type { DeskItem } from '../repo/desk';
import { liveProjectsWithRound } from '../repo/switches';
import { addReading, latestReading, type UsageReading } from '../repo/usageReadings';
import { readingOf, TurnRunError, type TurnWay } from './runner';

/*
 * The week's usage (lead stage 1, #743, task 13): the readings every turn writes (runner.ts), a probe on the smallest model
 * when nothing has been read for an hour, stage 0's hourly readings imported once, and the text `lead week` prints.
 */

/** The smallest model: what the probe runs on. */
export const PROBE_MODEL = 'claude-haiku-5-5';
/** A reading younger than this is enough: no probe. */
export const PROBE_AFTER_MS = 60 * 60 * 1000;
/** The longest a probe may run before it is stopped. */
export const PROBE_TIMEOUT_MS = 2 * 60 * 1000;
/** The folder (under <home>/lead) the probe runs in, so it never reads a project's. */
export const PROBE_SLUG = '_probe';
const WEEK_MS = 7 * 24 * 3600 * 1000;

/** The account's gauges as the newest readings give them: each the newest value held, the time of the newest reading overall. */
export interface Gauges {
  /** The newest reading's time. */
  at: string;
  week: number | null;
  weekResets: string | null;
  window: number | null;
  windowResets: string | null;
  /** The further gauges of the newest reading that has any, by name. */
  other: Record<string, number | null>;
}

interface RecentRow {
  window_used: number | null;
  window_resets: string | null;
  week_used: number | null;
  week_resets: string | null;
  other: string | null;
}

/** The gauges now, or undefined when nothing has been read. */
export function gauges(db: Ctx['db']): Gauges | undefined {
  const newest = latestReading(db);
  if (newest === undefined) return undefined;
  const recent = db.prepare('SELECT * FROM usage_readings ORDER BY at DESC, id DESC LIMIT 50').all() as RecentRow[];
  const week = recent.find((r) => r.week_used !== null);
  const window = recent.find((r) => r.window_used !== null);
  const other = recent.find((r) => r.other !== null);
  let parsed: Record<string, number | null> = {};
  try {
    parsed = other?.other == null ? {} : (JSON.parse(other.other) as Record<string, number | null>);
  } catch {
    // An other column that is not JSON (written by hand) shows no further gauge.
  }
  return {
    at: newest.at,
    week: week?.week_used ?? null,
    weekResets: week?.week_resets ?? null,
    window: window?.window_used ?? null,
    windowResets: window?.window_resets ?? null,
    other: parsed,
  };
}

/** The share of the week gone at `now` (0 to 1), from the week's reset time; null with none. */
export function weekLine(weekResets: string | null, now: string): number | null {
  if (weekResets === null) return null;
  const f = (Date.parse(now) - (Date.parse(weekResets) - WEEK_MS)) / WEEK_MS;
  return Math.min(1, Math.max(0, f));
}

const pct = (f: number): number => Math.round(f * 100);
const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const hhmm = (iso: string): string => stamp(iso).slice(11);
const dayTime = (iso: string): string => `${WEEKDAYS[new Date(iso).getDay()]} ${hhmm(iso)}`;

/** The morning list's last line: `<week> percent used, the line says <line>. Window <window> percent.`; null with no reading. */
export function weekSentence(db: Ctx['db'], now: string): string | null {
  const g = gauges(db);
  if (g === undefined || g.week === null) return null;
  const line = weekLine(g.weekResets, now);
  return `${pct(g.week)} percent used${line === null ? '' : `, the line says ${pct(line)}`}. ${g.window === null ? 'Window unknown.' : `Window ${pct(g.window)} percent.`}`;
}

/** What `lead week` prints. `reserve` is the reserve's answer, so this file never imports reserve.ts (which imports this one). */
export function weekText(db: Ctx['db'], now: string, reserve: { ok: true } | { ok: false; why: string }): string {
  const g = gauges(db);
  if (g === undefined) return 'No usage reading yet.';
  const line = weekLine(g.weekResets, now);
  const parts = [
    g.week === null
      ? 'Week unknown.'
      : `Week ${pct(g.week)} percent used${line === null ? '' : `, the line says ${pct(line)}`}${g.weekResets === null ? '' : ` (resets ${dayTime(g.weekResets)})`}.`,
    g.window === null ? 'Window unknown.' : `Window ${pct(g.window)} percent${g.windowResets === null ? '' : ` (resets ${hhmm(g.windowResets)})`}.`,
  ];
  for (const [name, v] of Object.entries(g.other)) if (v !== null) parts.push(`${name} ${pct(v)} percent.`);
  parts.push(`Reserve: ${reserve.ok ? 'untouched' : `touched: ${reserve.why}`}.`);
  parts.push(`Newest reading ${Math.max(0, Math.round((Date.parse(now) - Date.parse(g.at)) / 60_000))} min ago.`);
  return parts.join(' ');
}

/** What the probe reads outside the database: the way a turn runs, the server's home, and where a failure is logged. */
export interface ProbeDeps {
  way: TurnWay;
  home: string;
  log?: { error: (message: string) => void };
}

/** The probe has no desk item: the run never reads it, the type asks for one. */
const NO_ITEM: DeskItem = { id: 0, projectId: 0, kind: 'question', ref: '', nodeId: null, createdAt: '', dueAt: null, state: 'open', doneAt: null, outcome: null };

let probing = false;
let failureLogged = false;
/** When the last probe was tried, per database: a probe that failed is not tried again for an hour either. */
const tried = new WeakMap<object, string>();

/**
 * One headless run on the smallest model, no tools, the prompt "ok", in <home>/lead/_probe, when the newest reading is older
 * than an hour and any project has the round on: each rate_limit_event it streams becomes a reading with source 'probe'.
 * At most one probe an hour (a failed one counts), one at a time. A failure is logged once, until a probe works again.
 * Returns whether a probe ran.
 */
export async function probeUsage(ctx: Ctx, deps: ProbeDeps): Promise<boolean> {
  if (probing) return false;
  const now = ctx.now();
  const newest = latestReading(ctx.db);
  if (newest !== undefined && Date.parse(now) - Date.parse(newest.at) <= PROBE_AFTER_MS) return false;
  const last = tried.get(ctx.db);
  if (last !== undefined && Date.parse(now) - Date.parse(last) < PROBE_AFTER_MS) return false;
  if (liveProjectsWithRound(ctx.db).length === 0) return false;
  probing = true;
  tried.set(ctx.db, now);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error('the probe took too long')), PROBE_TIMEOUT_MS);
  timer.unref();
  const keep = (limits: unknown[], model: string): void => {
    for (const info of limits) addReading(ctx.db, { ...readingOf(info, ctx.now(), 0, model), source: 'probe', turnId: null });
  };
  try {
    const out = await deps.way.run(
      {
        turnId: 0,
        slug: PROBE_SLUG,
        item: NO_ITEM,
        systemPrompt: 'Answer with the one word ok.',
        userMessage: 'ok',
        model: PROBE_MODEL,
        toolsEnv: { INPROGRESS_HOME: deps.home, INPROGRESS_PORT: '0', INPROGRESS_LEAD_AS: PROBE_SLUG },
        noTools: true,
      },
      controller.signal,
    );
    keep(out.rateLimits, out.model);
    failureLogged = false;
  } catch (err) {
    // What the run read before it failed still counts: a usage-limit error carries the gauge.
    if (err instanceof TurnRunError) keep(err.partial.rateLimits, err.partial.model ?? PROBE_MODEL);
    if (!failureLogged) deps.log?.error(`The usage probe failed: ${(err as Error).message}`);
    failureLogged = true;
  } finally {
    clearTimeout(timer);
    probing = false;
  }
  return true;
}

const asIso = (v: unknown): string | null => {
  if (typeof v === 'number' && Number.isFinite(v)) return new Date(v < 1e11 ? v * 1000 : v).toISOString();
  if (typeof v === 'string' && !Number.isNaN(Date.parse(v))) return new Date(v).toISOString();
  return null;
};
const asNum = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);

/**
 * Stage 0's readings, a jsonl file of `{ at, window, windowResets, week, weekResets, status, overage, costUsd }`, as readings
 * with source 'import'. A line with `error`, one that is not JSON, or one with no time is skipped; a second import adds
 * nothing (the unique index on time and source). Answers how many it added and how many it skipped.
 */
export function importUsage(ctx: Ctx, file: string): { added: number; skipped: number } {
  const text = readFileSync(file, 'utf8');
  let added = 0;
  let skipped = 0;
  for (const raw of text.split(/\r?\n/)) {
    if (raw.trim() === '') continue;
    let line: Record<string, unknown> | null;
    try {
      line = JSON.parse(raw) as Record<string, unknown> | null;
    } catch {
      skipped++;
      continue;
    }
    const at = line === null || typeof line !== 'object' ? null : asIso(line.at);
    if (line === null || line.error !== undefined || at === null) {
      skipped++;
      continue;
    }
    const r: UsageReading | undefined = addReading(ctx.db, {
      at,
      source: 'import',
      windowUsed: asNum(line.window),
      windowResets: asIso(line.windowResets),
      weekUsed: asNum(line.week),
      weekResets: asIso(line.weekResets),
    });
    if (r === undefined) skipped++;
    else added++;
  }
  return { added, skipped };
}

/** Stage 0's measure: asks that reached Aiden per step closed. */
export const STAGE_0_RATIO = 1.55;

/**
 * What reached Aiden since `since` (ISO) beside the steps closed: his asks (the ones brought to him, plus the ones raised to
 * him and answered by him, not by the lead; each counted once), the steps closed, and their ratio. Read from landing.
 */
export function leadCounts(ctx: Ctx, projectId: number, since: string): { reached: number; closed: number; ratio: number | null; text: string } {
  const db = ctx.db;
  const brought = db.prepare("SELECT DISTINCT ask_id FROM lead_events WHERE project_id = ? AND kind = 'bring' AND at >= ? AND ask_id IS NOT NULL").pluck().all(projectId, since) as number[];
  const answered = db
    .prepare("SELECT id FROM asks WHERE project_id = ? AND raised_at >= ? AND owner <> 'lead' AND cleared_at IS NOT NULL AND (answered_via IS NULL OR answered_via = 'lead')")
    .pluck()
    .all(projectId, since) as number[];
  const reached = new Set([...brought, ...answered]).size;
  const closed = db.prepare("SELECT COUNT(*) FROM nodes WHERE project_id = ? AND status = 'done' AND kind NOT IN ('goal', 'phase') AND completed_at >= ?").pluck().get(projectId, since) as number;
  const ratio = closed === 0 ? null : Math.round((reached / closed) * 100) / 100;
  const text = `Since ${stamp(since)}: ${reached} ask${reached === 1 ? '' : 's'} reached Aiden, ${closed} step${closed === 1 ? '' : 's'} closed${ratio === null ? '' : `, ${ratio} per step`}. Stage 0 was ${STAGE_0_RATIO}.`;
  return { reached, closed, ratio, text };
}
