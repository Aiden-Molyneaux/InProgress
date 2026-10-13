import { askTag } from '../core/types';

/** What the raise route answers: the ask, and the two facts a raiser needs about its answer. */
export interface RaiseReply {
  id: number;
  nodeId: number;
  /** The session the ask belongs to (its first raiser, when it joined an open ask); null when it has none. */
  sessionId: string | null;
  joined: boolean;
  untracked: boolean;
}

/**
 * The notes a raise owes its caller: the session was not tracked (so no answer will come back to it), and the ask joined
 * one already open (whose answer goes only to the session that raised it first). Empty when neither holds.
 */
export function raiseNotes(r: RaiseReply, sessionId?: string): string[] {
  const notes: string[] = [];
  if (r.untracked) {
    notes.push(`Note: session ${sessionId} is not tracked in InProgress, so no answer will come back to it.`);
  }
  if (r.joined) {
    const tag = askTag(r.id);
    if (sessionId && r.sessionId === sessionId) notes.push(`Note: ${tag} was already open from this session; nothing new was raised.`);
    else if (r.sessionId) notes.push(`Note: ${tag} was already open, raised by another session; its answer goes to that session, not to this one.`);
    else notes.push(`Note: ${tag} was already open with no session to answer to; no answer will come back through it.`);
  }
  return notes;
}
