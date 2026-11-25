import type { Ctx } from '../db/tx';

/** Whether the reserve allows one of the lead's own starts now, and when not, why. */
export type ReserveAnswer = { ok: true } | { ok: false; why: string };

/**
 * Whether the usage reserve allows one of the lead's own starts (a restart) at `now` ("How it works", 12). Task 9 asks it
 * before every restart; until task 13 fills it from the usage readings it always allows.
 */
export function reserveAllowsStart(_ctx: Ctx, _now: string): ReserveAnswer {
  return { ok: true };
}
