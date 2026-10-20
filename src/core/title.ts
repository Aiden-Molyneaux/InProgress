import { sessionActivity } from './activity';
import type { ProjectSnapshot, Session } from './types';

/** The status words a Claude Desktop session title may start with, in no order of precedence. */
export const TITLE_PREFIXES = ['RUNNING', 'REVIEW', 'BLOCKED', 'DONE'] as const;
export type TitlePrefix = (typeof TITLE_PREFIXES)[number];

/** A title's leading prefix word (case-sensitive, followed by whitespace or the end) and the rest, trimmed; a title without one is returned whole. */
export function splitPrefix(title: string): { prefix: TitlePrefix | null; rest: string } {
  for (const prefix of TITLE_PREFIXES) {
    if (title === prefix) return { prefix, rest: '' };
    if (title.startsWith(prefix) && /\s/.test(title.charAt(prefix.length))) return { prefix, rest: title.slice(prefix.length).trim() };
  }
  return { prefix: null, rest: title };
}

/** A title built from its text and a prefix (none for null), trimmed. */
export function withPrefix(rest: string, prefix: TitlePrefix | null): string {
  return (prefix ? `${prefix} ${rest}` : rest).trim();
}

/** The prefix InProgress expects on a session's title: DONE, BLOCKED, REVIEW, RUNNING in that order, else null. */
export function expectedPrefix(
  session: Pick<Session, 'id' | 'focusNodeId' | 'state' | 'subagents' | 'commands'>,
  snapshot: Pick<ProjectSnapshot, 'nodes' | 'asks'>,
  now: number,
): TitlePrefix | null {
  const focus = session.focusNodeId === null ? undefined : snapshot.nodes.find((n) => n.id === session.focusNodeId);
  if (focus) {
    if (focus.status === 'done') return 'DONE';
    const open = snapshot.asks.filter((a) => a.clearedAt === null && a.nodeId === focus.id && a.sessionId === session.id);
    if (open.some((a) => a.kind === 'question' || a.kind === 'permission')) return 'BLOCKED';
    if (open.some((a) => a.kind === 'review')) return 'REVIEW';
  }
  return sessionActivity(session, now) === 'busy' ? 'RUNNING' : null;
}

/** A hook reply's demand that the session set its title: the full title, and the words saying why. */
export interface TitleDemand {
  title: string;
  reason: string;
}

/** The words the nudge and the block give for a prefix on a step. */
export function prefixReason(prefix: TitlePrefix | null, nodeId: number | null): string {
  switch (prefix) {
    case 'DONE': return `#${nodeId} is done`;
    case 'BLOCKED': return `an ask on #${nodeId} waits on Aiden`;
    case 'REVIEW': return `a review on #${nodeId} waits on Aiden`;
    case 'RUNNING': return 'background work is still running';
    default: return 'nothing is running or waiting';
  }
}
