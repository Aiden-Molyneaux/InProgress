import { ApiError } from '../errors';
import type { Ask, LeadBehindItem } from '../../core/types';
import type { Ctx } from '../db/tx';
import { requireAsk } from '../repo/asks';
import { findNode } from '../repo/nodes';
import { RUNNER_FAULT_WHY, TURN_FAULTS_BEHIND } from '../repo/leadTurns';
import { parseStoppedRef } from './stopped';

interface Row {
  id: number;
  kind: string;
  ref: string;
  node_id: number | null;
  created_at: string;
  due_at: string | null;
  state: string;
}

/** What Aiden is told a desk item is, by its kind, when it names no ask text. */
const WHAT: Record<string, string> = {
  stopped: 'a stopped session',
  stuck: 'a permission prompt',
  held: 'a held command',
  unknown_send: 'a send that may not have gone',
  aiden_said: 'something you said',
  old_ask: 'an old ask',
  promise_due: 'a promise that is due',
  question: 'a question',
  permission: 'a permission ask',
  review: 'a review',
};

/** Why the lead gave up on an item: its last turns were all runner faults, or it failed twice. */
function behindWhy(ctx: Ctx, itemId: number): 'faults' | 'failures' {
  const last = ctx.db.prepare('SELECT state, why FROM lead_turns WHERE item_id = ? ORDER BY id DESC LIMIT ?').all(itemId, TURN_FAULTS_BEHIND) as { state: string; why: string | null }[];
  return last.length === TURN_FAULTS_BEHIND && last.every((t) => t.state === 'interrupted' && (t.why ?? '').startsWith(RUNNER_FAULT_WHY)) ? 'faults' : 'failures';
}

/**
 * The project's desk items that could be "The lead is behind": every one not done and not waiting on Aiden that has a limit or
 * has been given up on (state behind). The window decides which are past their limit by its own clock, so the group appears
 * within a minute of the limit with no event to say so; the server only says what each one is and what Aiden can do with it.
 */
export function leadBehindWatch(ctx: Ctx, projectId: number): LeadBehindItem[] {
  const rows = ctx.db
    .prepare("SELECT id, kind, ref, node_id, created_at, due_at, state FROM desk_items WHERE project_id = ? AND state IN ('open', 'leased', 'behind') AND (due_at IS NOT NULL OR state = 'behind') ORDER BY created_at, id LIMIT 100")
    .all(projectId) as Row[];
  return rows.map((r) => {
    const node = r.node_id === null ? undefined : findNode(ctx, r.node_id);
    const askKind = r.kind === 'question' || r.kind === 'permission' || r.kind === 'old_ask';
    let ask: Ask | undefined;
    if (askKind && /^\d+$/.test(r.ref)) {
      try {
        ask = requireAsk(ctx, Number(r.ref));
      } catch (err) {
        // The ask is gone (its project was deleted or archived): the row then names the kind and offers no answer. Anything
        // else is a real fault and is not hidden.
        if (!(err instanceof ApiError) || err.status !== 404) throw err;
        ask = undefined;
      }
    }
    const open = ask !== undefined && ask.clearedAt === null;
    return {
      id: r.id,
      kind: r.kind,
      state: r.state === 'behind' ? 'behind' : 'open',
      createdAt: r.created_at,
      dueAt: r.due_at,
      stepId: node?.id ?? null,
      stepTitle: node?.title ?? null,
      what: ask !== undefined ? ask.text : (WHAT[r.kind] ?? r.kind),
      askId: ask !== undefined && open ? ask.id : null,
      sessionId: r.kind === 'stopped' ? parseStoppedRef(r.ref).sessionId : null,
      behindWhy: r.state === 'behind' ? behindWhy(ctx, r.id) : null,
    };
  });
}
