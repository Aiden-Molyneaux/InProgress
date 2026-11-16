import { isLive } from '../core/board';
import type { LeadEventKind } from '../core/lead';
import { relayText } from '../core/relay';
import { clipLine } from '../core/step-ref';
import { sessionDisplayTitle } from '../core/types';
import { write, type Ctx } from './db/tx';
import { badGateway, conflict } from './errors';
import { logLeadEvent, requireLead } from './lead';
import { requireNode } from './repo/nodes';
import { readProjectSessions } from './repo/sessions';
import { T3Unavailable, t3Send } from './t3';

/** Sends a message to a T3 Code thread. Injected, so no test runs the t3 CLI. */
export type RelaySend = (threadId: string, message: string) => Promise<void>;

/** The answer to a send that timed out: the message may be in the thread, so it is not sent again. */
export const RELAY_UNKNOWN = 'It may have been delivered. Not retried.';

/** How much of a failure's reason the lead is told. */
const REASON_CUT = 300;

/** A failure's message as the reply quotes it: one line, at most 300 characters, no closing full stops or spaces. */
export function reasonOf(err: unknown): string {
  const text = err instanceof Error ? err.message : String(err);
  return text.replace(/\s+/g, ' ').trim().slice(0, REASON_CUT).replace(/[.\s]+$/, '');
}

/**
 * The lead passes one message to the session working on a step: sent to its T3 Code thread under the relay header, and
 * logged. The checks are plain reads and every refusal is thrown before anything is sent or written. The send runs
 * outside any write (write() cannot hold an await) and is never repeated; one write after it logs what it did, whatever
 * that was. A send that timed out answers RELAY_UNKNOWN, any other failure `Not delivered: <reason>.`, both as a 502.
 */
export async function leadRelay(
  ctx: Ctx,
  ref: string,
  as: string,
  instructions: number,
  input: { stepId: number; message: string },
  send: RelaySend = t3Send,
): Promise<{ text: string; sessionId: string }> {
  const project = requireLead(ctx, ref, as, instructions, true);
  // requireLead has matched `as` against the stored name, so it is set.
  const name = project.lead as string;
  const actor = `lead:${name}`;
  const node = requireNode(ctx, input.stepId);
  if (node.projectId !== project.id) throw conflict(`#${node.id} is not in this project.`);
  const now = Date.parse(ctx.now());
  const on = readProjectSessions(ctx, project.id).filter((s) => s.focusNodeId === node.id && isLive(s, now));
  if (!on.length) throw conflict(`No live session is working on #${node.id}.`);
  if (on.length > 1) throw conflict(`#${node.id} has ${on.length} live sessions. A relay to a step with more than one is not supported yet.`);
  const session = on[0];
  if (session.app !== 't3' || session.t3ThreadId === null) throw conflict(`The session on #${node.id} is not running in T3 Code.`);

  let kind: LeadEventKind;
  let reason = '';
  try {
    await send(session.t3ThreadId, relayText(name, project.name, input.message));
    kind = 'relay';
  } catch (err) {
    if (err instanceof T3Unavailable && err.outcomeUnknown) kind = 'relay_unknown';
    else {
      kind = 'relay_failed';
      reason = reasonOf(err);
      console.error(`InProgress: a relay to session ${session.id} was not delivered: ${reason}`);
    }
  }
  try {
    write(ctx, actor, () => logLeadEvent(ctx, { projectId: project.id, lead: name, instructions, kind, nodeId: node.id, sessionId: session.id, text: input.message }));
  } catch (err) {
    // The send has happened (or not) whatever the log says: the lead is still told which.
    console.error(`InProgress: a relay to session ${session.id} (${kind}) could not be logged: ${reasonOf(err)}`);
  }
  if (kind === 'relay_unknown') throw badGateway(RELAY_UNKNOWN);
  if (kind === 'relay_failed') throw badGateway(`Not delivered: ${reason}.`);
  return { text: `Delivered to "${clipLine(sessionDisplayTitle(session), 60)}".`, sessionId: session.id };
}
