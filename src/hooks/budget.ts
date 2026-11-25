import type { HookName } from './handlers';
import { HOLD_POST_MS } from './hold';
import { STUCK_POST_MS } from './permission';

export interface HookBudget {
  /** How long the hook waits for a server it had to start (0: the hook never starts one). */
  serverWaitMs: number;
  /** The timeout of the hook's POST to the server. */
  postTimeoutMs: number;
  /** The hook's own ceiling, counted from its start: past it the hook logs a timeout and exits 0. */
  limitMs: number;
}

/**
 * How long session-start waits for a server it had to start. A cold start after a reboot took longer than the 2 s
 * this used to be, and that session went unbriefed: the server loads ~300 modules from disk before it listens.
 */
const SERVER_WAIT_MS = 5000;
/** session-start's POST, which returns the briefing. */
const START_POST_MS = 2000;
/** Every other hook: one POST, never a server start. */
const POST_MS = 500;
/** On top of the budget, for reading stdin and writing the briefing. */
const GRACE_MS = 250;

/**
 * On top of a lead hook's POST: its own timeout must fire first, so the hook prints its fail-closed refusal rather than
 * being cut off with nothing printed (which would let a held command run).
 */
const LEAD_GRACE_MS = 1000;

/**
 * session-start: up to 5 s for a server it starts, then 2 s for the POST, so 7.25 s at most. That stays inside the
 * 10 s timeout Claude gives the hook (HOOK_DEFS), with room for Node's own start. hold: one 10 s POST per held command
 * of the line, inside its 30 s; permission: the 175 s wait for the lead's verdict, inside its 180 s. Every other hook: 500 ms.
 */
export function hookBudget(name: HookName): HookBudget {
  if (name === 'session-start') return { serverWaitMs: SERVER_WAIT_MS, postTimeoutMs: START_POST_MS, limitMs: SERVER_WAIT_MS + START_POST_MS + GRACE_MS };
  if (name === 'hold') return { serverWaitMs: 0, postTimeoutMs: HOLD_POST_MS, limitMs: 2 * HOLD_POST_MS + LEAD_GRACE_MS };
  if (name === 'permission') return { serverWaitMs: 0, postTimeoutMs: STUCK_POST_MS, limitMs: STUCK_POST_MS + LEAD_GRACE_MS };
  return { serverWaitMs: 0, postTimeoutMs: POST_MS, limitMs: POST_MS + GRACE_MS };
}
