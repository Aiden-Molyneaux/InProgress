import { agentTag, ownerTag, sessionDisplayTitle, sessionTag, type PastSession, type Session, type SessionState, type SubagentInfo, type TrailAgent, type WorkItem, type WorkStatus } from '../../src/core/types';
import { relativeTime } from './time';

/** A working task's checklist mark. */
export const TASK_MARK: Record<WorkStatus, string> = { pending: '○', in_progress: '◐', completed: '✓' };

/** A task's mark in a checklist: one an ended session left open (`stale`) is a hollow ○, a completed one keeps its ✓. */
export function workMark(status: WorkStatus, stale: boolean): string {
  return stale && status !== 'completed' ? TASK_MARK.pending : TASK_MARK[status];
}

/** A place in the Up next queue as one circled numeral, ① to ㊿, or in brackets past 50. */
export function circled(n: number): string {
  if (n >= 1 && n <= 20) return String.fromCodePoint(0x2460 + n - 1);
  if (n >= 21 && n <= 35) return String.fromCodePoint(0x3251 + n - 21);
  if (n >= 36 && n <= 50) return String.fromCodePoint(0x32b1 + n - 36);
  return `(${n})`;
}

/**
 * A queued step's marker on its card: its number in its owner's list, led by the owner's letter (`A①`, `?①` while the
 * session's slot is empty), or a bare numeral (`①`) when the step is unowned.
 */
export function queueMark(pos: number, owner: { slot: number | null } | null): string {
  return owner ? `${ownerTag(owner.slot)}${circled(pos)}` : circled(pos);
}

/** Whole minutes from an ISO time to `now`; a start in the future (clock skew) reads as 0. The one count behind `elapsed` and `runTime`. */
function minutesSince(fromIso: string, now: number): number {
  return Math.floor(Math.max(0, now - Date.parse(fromIso)) / 60_000);
}

/** How long something has been going: "<1 min", "12 min", "2 h 5 min". */
export function elapsed(fromIso: string, now: number): string {
  const minutes = minutesSince(fromIso, now);
  if (minutes < 1) return '<1 min';
  if (minutes < 60) return `${minutes} min`;
  const rest = minutes % 60;
  return `${Math.floor(minutes / 60)} h${rest ? ` ${rest} min` : ''}`;
}

/** The text without a leading `#<nodeId>`: shown under that node, the id only repeats it. A text that is only the id stays. */
export function withoutOwnId(text: string, nodeId: number | null): string {
  if (nodeId === null) return text;
  const rest = text.replace(new RegExp(`^\\s*#${nodeId}\\b[\\s:·—–-]*`), '');
  return rest === text || !rest.trim() ? text : rest;
}

/** A subagent's name: its description (without the #id of the node it is shown under), or its type until it is paired. */
export function agentName(a: Pick<SubagentInfo, 'description' | 'agentType'>, underNode: number | null = null): string {
  const description = a.description?.trim();
  return description ? withoutOwnId(description, underNode) : a.agentType;
}

/** `description · model · 12 min` while a subagent runs, `… · done 2 min ago` once it has ended. */
export function agentLine(a: SubagentInfo, now: number, underNode: number | null = null): string {
  const when = a.endedAt ? `done ${relativeTime(a.endedAt, now)}` : elapsed(a.startedAt, now);
  return [agentName(a, underNode), a.model, when].filter(Boolean).join(' · ');
}

const STATE_SUFFIX: Record<Session['state'], string> = { working: '', idle: ' · idle', permission: ' · needs permission', ended: ' · ended' };

/** ` · 2 subagents` for the subagents of a session that still run (readers included), nothing while none do. The one count behind `chipLabel` and `leadTitle`. */
function subagentSuffix(s: Session): string {
  const running = s.subagents.filter((a) => a.endedAt === null).length;
  return running ? ` · ${running} subagent${running > 1 ? 's' : ''}` : '';
}

/** A session chip's label: its title, how many subagents still run, and its state unless it is working. */
export function chipLabel(s: Session): string {
  return `${sessionDisplayTitle(s)}${subagentSuffix(s)}${STATE_SUFFIX[s.state]}`;
}

/**
 * `description · model · ran 40 min · stopped 2 h ago`: a subagent in the trail, how long it ran and when it stopped.
 * A resumed subagent keeps its first start, so "ran" spans its first start to its last stop.
 */
export function trailAgentLine(a: SubagentInfo, now: number, underNode: number | null = null): string {
  const end = a.endedAt ?? new Date(now).toISOString();
  return [agentName(a, underNode), a.model, `ran ${elapsed(a.startedAt, Date.parse(end))}`, `stopped ${relativeTime(end, now)}`].filter(Boolean).join(' · ');
}

/** A step's done row: `✓ 5 done · 2 unfinished · 2 agents`, each part left out while it is zero. */
export function trailLabel(p: { done: number; unfinished: number; agents: number }): string {
  const parts = [
    p.done ? `${p.done} done` : '',
    p.unfinished ? `${p.unfinished} unfinished` : '',
    p.agents ? `${p.agents} agent${p.agents === 1 ? '' : 's'}` : '',
  ].filter(Boolean);
  return `✓ ${parts.length ? parts.join(' · ') : '0 done'}`;
}

/**
 * Who is on a working task: its session's title, or its subagent's description. An ended session's task names that
 * past session, and a subagent's task names its trail entry once it has left the session's list.
 */
export function taskOwner(w: WorkItem, sessions: Session[], pastSessions: PastSession[] = [], trailAgents: TrailAgent[] = []): string {
  const live = sessions.find((x) => x.id === w.sessionId);
  const s = live ?? pastSessions.find((x) => x.id === w.sessionId);
  if (!s) return 'a session';
  if (w.agentId === '') return sessionDisplayTitle(s);
  const a = live?.subagents.find((x) => x.agentId === w.agentId) ?? trailAgents.find((x) => x.sessionId === w.sessionId && x.agentId === w.agentId);
  return a ? agentName(a, w.nodeId) : 'a subagent';
}

/** `a1 · text`: a label led by its letter or tag, or the bare text when there is none (a slot still empty, say). */
export function withTag(tag: string, text: string): string {
  return tag ? `${tag} · ${text}` : text;
}

/**
 * The family a working task wears: its live session's slot, and its subagent's tag (`a1`; '' on the session's own list,
 * or while the subagent's number is unknown). The number comes from the session's subagents, else from the trail: the
 * session's list drops a subagent 5 minutes after it stops, while its tasks stay. Null for an ended session's task, as
 * its slot may belong to a live session by now: trail rows stay neutral.
 */
export function taskFamily(w: WorkItem, sessions: Session[], trailAgents: TrailAgent[] = []): { slot: number | null; tag: string } | null {
  const s = sessions.find((x) => x.id === w.sessionId);
  if (!s || w.endedAt !== null) return null;
  if (w.agentId === '') return { slot: s.slot, tag: '' };
  const a = s.subagents.find((x) => x.agentId === w.agentId) ?? trailAgents.find((x) => x.sessionId === w.sessionId && x.agentId === w.agentId);
  return { slot: s.slot, tag: agentTag(s.slot, a?.ordinal ?? null) };
}

/** What a working task waits for: the subjects of the open tasks that block it, in order. */
export function waitsFor(w: WorkItem, items: WorkItem[]): string[] {
  return items.filter((x) => x.status !== 'completed' && x.blocks.includes(w.id)).map((x) => withoutOwnId(x.subject, w.nodeId));
}

/** A session's state as a word: on its agent line and in its lead's tooltip. */
export const WORDS: Record<SessionState, string> = { working: 'working', idle: 'idle', permission: 'needs permission', ended: 'ended' };

/** A session chip's accessible name: its letter, then chipLabel. */
export function chipName(s: Session): string {
  return withTag(sessionTag(s.slot), chipLabel(s));
}

/** The lead character's tooltip: letter, title, state word, and how many subagents still run (readers included). */
export function leadTitle(s: Session): string {
  return withTag(sessionTag(s.slot), `${sessionDisplayTitle(s)} · ${WORDS[s.state]}${subagentSuffix(s)}`);
}

/** A kin's tooltip and accessible name: `withTag(tag, agentLine(...))`, then a newline and the purpose when known. */
export function kinTitle(a: SubagentInfo, slot: number | null, now: number, underNode: number | null = null): string {
  const line = withTag(agentTag(slot, a.ordinal), agentLine(a, now, underNode));
  return a.purpose ? `${line}\n${a.purpose}` : line;
}

/** A running kin's elapsed time, compact: no spaces, at most five characters. The minutes are elapsed's. */
export function runTime(fromIso: string, now: number): string {
  const minutes = minutesSince(fromIso, now);
  if (minutes < 1) return '<1m';
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return hours < 10 && rest ? `${hours}h${rest}m` : `${hours}h`;
}
