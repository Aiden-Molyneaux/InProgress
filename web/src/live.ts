import { sessionDisplayTitle, type Session, type SubagentInfo, type WorkItem, type WorkStatus } from '../../src/core/types';
import { relativeTime } from './time';

/** A working task's checklist mark. */
export const TASK_MARK: Record<WorkStatus, string> = { pending: '○', in_progress: '◐', completed: '✓' };

/** A place in the Up next queue as one circled numeral, ① to ㊿, or in brackets past 50. */
export function circled(n: number): string {
  if (n >= 1 && n <= 20) return String.fromCodePoint(0x2460 + n - 1);
  if (n >= 21 && n <= 35) return String.fromCodePoint(0x3251 + n - 21);
  if (n >= 36 && n <= 50) return String.fromCodePoint(0x32b1 + n - 36);
  return `(${n})`;
}

/** How long something has been going: "<1 min", "12 min", "2 h 5 min". */
export function elapsed(fromIso: string, now: number): string {
  const minutes = Math.floor(Math.max(0, now - Date.parse(fromIso)) / 60_000);
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

/** A session chip's label: its title, how many subagents still run, and its state unless it is working. */
export function chipLabel(s: Session): string {
  const live = s.subagents.filter((a) => a.endedAt === null).length;
  return `${sessionDisplayTitle(s)}${live ? ` · ${live} subagent${live > 1 ? 's' : ''}` : ''}${STATE_SUFFIX[s.state]}`;
}

/** Who is on a working task: its session's title, or its subagent's description. */
export function taskOwner(w: WorkItem, sessions: Session[]): string {
  const s = sessions.find((x) => x.id === w.sessionId);
  if (!s) return 'a session';
  if (w.agentId === '') return sessionDisplayTitle(s);
  const a = s.subagents.find((x) => x.agentId === w.agentId);
  return a ? agentName(a, w.nodeId) : 'a subagent';
}

/** What a working task waits for: the subjects of the open tasks that block it, in order. */
export function waitsFor(w: WorkItem, items: WorkItem[]): string[] {
  return items.filter((x) => x.status !== 'completed' && x.blocks.includes(w.id)).map((x) => withoutOwnId(x.subject, w.nodeId));
}
