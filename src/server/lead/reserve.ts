import type { Ctx } from '../db/tx';
import { gauges } from './usage';

/** Whether the usage reserve allows one of the lead's own starts now, and when not, why. */
export type ReserveAnswer = { ok: true } | { ok: false; why: string };

/** A reading older than this is no basis for a start. */
export const READING_STALE_MS = 60 * 60 * 1000;
/** The week at or past this share refuses a start. */
export const WEEK_LIMIT = 0.95;
/** The window at or past this share refuses a start. */
export const WINDOW_LIMIT = 0.85;
/** The window past this share refuses a start while Aiden is at work. */
export const WINDOW_LIMIT_AT_WORK = 0.7;
/** Aiden is at work when a prompt of his came this recently. */
export const AT_WORK_MS = 30 * 60 * 1000;

const percent = (f: number): number => Math.round(f * 100);

/**
 * Whether the usage reserve allows one of the lead's own starts (a restart) at `now` ("How it works", 12): refused on a
 * reading older than an hour (or none), the week at 95 percent or more, the window at 85 percent or more, or the window
 * past 70 percent while Aiden is at work (a prompt of his in the last 30 minutes; a relayed message is not his, it never
 * sets the prompt time). Desk turns never ask: they answer a session that waits, which is Aiden's own work.
 */
export function reserveAllowsStart(ctx: Ctx, now: string): ReserveAnswer {
  const g = gauges(ctx.db);
  const nowMs = Date.parse(now);
  if (g === undefined) return { ok: false, why: 'there is no usage reading yet' };
  const age = nowMs - Date.parse(g.at);
  if (age > READING_STALE_MS) return { ok: false, why: `the newest usage reading is ${Math.round(age / 60_000)} min old` };
  if (g.week !== null && g.week >= WEEK_LIMIT) return { ok: false, why: `the week is ${percent(g.week)} percent used` };
  if (g.window !== null && g.window >= WINDOW_LIMIT) return { ok: false, why: `the window is ${percent(g.window)} percent used` };
  if (g.window !== null && g.window > WINDOW_LIMIT_AT_WORK) {
    const since = new Date(nowMs - AT_WORK_MS).toISOString();
    const atWork = ctx.db.prepare('SELECT 1 FROM sessions WHERE last_prompt_at IS NOT NULL AND last_prompt_at >= ? LIMIT 1').get(since) !== undefined;
    if (atWork) return { ok: false, why: `the window is ${percent(g.window)} percent used and Aiden is at work` };
  }
  return { ok: true };
}
