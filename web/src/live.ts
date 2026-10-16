import { commandDescriptionText, commandLabel, countsAsWork, sessionActivity, type Activity } from '../../src/core/activity';
import { sessionDisplayTitle, type CommandInfo, type CommandOutcome, type EndReason, type PastSession, type Session, type SubagentInfo, type TrailAgent, type WorkItem, type WorkStatus } from '../../src/core/types';
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
  const rest = text.replace(new RegExp(`^\\s*#${nodeId}\\b[\\s:·\u2014–-]*`), '');
  return rest === text || !rest.trim() ? text : rest;
}

/** A subagent's name: its description (without the #id of the node it is shown under), or its type until it is paired. */
export function agentName(a: Pick<SubagentInfo, 'description' | 'agentType'>, underNode: number | null = null): string {
  const description = a.description?.trim();
  return description ? withoutOwnId(description, underNode) : a.agentType;
}

/** Why a subagent ended without a clean stop, as the window says it: `a3 hit the usage limit`, `… 3 min ago`. */
export const END_WORDS: Record<EndReason, string> = {
  limit: 'hit the usage limit',
  error: 'hit an API error',
  killed: 'was stopped',
  silent: 'stopped responding',
  session: 'ended with its session',
};

/** A subagent's line in two parts: `who` (description · model) and `when`, which the window may draw apart. */
export interface LineParts {
  who: string;
  when: string;
}

/**
 * The time an ended subagent's "… ago" and "ran …" count to: its last sign of life when the transcript watcher ended it,
 * else when it ended.
 */
const lastAlive = (a: SubagentInfo): string => a.lastActiveAt ?? a.endedAt ?? '';

/**
 * agentLine in its two parts. `when`: the elapsed time while it runs; `done 2 min ago` after a clean stop; else why it
 * ended and how long ago it last showed life (`stopped responding 21 min ago`), and at the usage limit what to do
 * about it (`hit the usage limit 3 min ago · resume after the reset`).
 */
export function agentLineParts(a: SubagentInfo, now: number, underNode: number | null = null): LineParts {
  const who = [agentName(a, underNode), a.model].filter(Boolean).join(' · ');
  if (!a.endedAt) return { who, when: elapsed(a.runStartedAt, now) };
  if (!a.endReason) return { who, when: `done ${relativeTime(a.endedAt, now)}` };
  const when = `${END_WORDS[a.endReason]} ${relativeTime(lastAlive(a), now)}`;
  return { who, when: a.endReason === 'limit' ? `${when} · resume after the reset` : when };
}

/** `description · model · 12 min` while a subagent runs, `… · done 2 min ago` once it has ended (agentLineParts). */
export function agentLine(a: SubagentInfo, now: number, underNode: number | null = null): string {
  const { who, when } = agentLineParts(a, now, underNode);
  return `${who} · ${when}`;
}

const STATE_SUFFIX: Record<Activity, string> = { working: '', busy: ' · busy', idle: ' · idle', permission: ' · needs permission', ended: ' · ended' };

/** ` · 2 subagents` for the subagents of a session that still run (readers included), nothing while none do. The one count behind `chipLabel` and `leadTitle`. */
function subagentSuffix(s: Session): string {
  const running = s.subagents.filter((a) => a.endedAt === null).length;
  return running ? ` · ${running} subagent${running > 1 ? 's' : ''}` : '';
}

/** How many of a session's commands (its subagents' included) count as work at `now`: the count behind `commandsSuffix` and the chip's `▸n`. */
export function workingCommands(s: Pick<Session, 'commands'>, now: number): number {
  return s.commands.filter((c) => countsAsWork(c, now)).length;
}

/** ` · 5 commands` for the session's commands that count as work, nothing while none do. Serving commands are not named. */
export function commandsSuffix(s: Pick<Session, 'commands'>, now: number): string {
  const n = workingCommands(s, now);
  return n ? ` · ${n} command${n > 1 ? 's' : ''}` : '';
}

/** A session chip's label: its title, how many subagents still run and commands count as work, and its activity unless it is working. */
export function chipLabel(s: Session, now: number): string {
  return `${sessionDisplayTitle(s)}${subagentSuffix(s)}${commandsSuffix(s, now)}${STATE_SUFFIX[sessionActivity(s, now)]}`;
}

/**
 * trailAgentLine in its two parts: `who` (description · model) and `when`, how long it ran and when it stopped, or why
 * it ended (`ran 22 min · hit the usage limit 10 h ago`). Both count to its last sign of life when the transcript
 * watcher ended it. A resumed subagent keeps its first start, so "ran" spans its first start to its last stop.
 */
export function trailAgentParts(a: SubagentInfo, now: number, underNode: number | null = null): LineParts {
  const end = a.endedAt ? lastAlive(a) : new Date(now).toISOString();
  const how = a.endReason ? END_WORDS[a.endReason] : 'stopped';
  return { who: [agentName(a, underNode), a.model].filter(Boolean).join(' · '), when: `ran ${elapsed(a.startedAt, Date.parse(end))} · ${how} ${relativeTime(end, now)}` };
}

/** `description · model · ran 40 min · stopped 2 h ago`: a subagent in the trail (trailAgentParts). */
export function trailAgentLine(a: SubagentInfo, now: number, underNode: number | null = null): string {
  const { who, when } = trailAgentParts(a, now, underNode);
  return `${who} · ${when}`;
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

/** What a working task waits for: the subjects of the open tasks that block it, in order. */
export function waitsFor(w: WorkItem, items: WorkItem[]): string[] {
  return items.filter((x) => x.status !== 'completed' && x.blocks.includes(w.id)).map((x) => withoutOwnId(x.subject, w.nodeId));
}

/** A session's activity as a word: on its agent line and in its lead's tooltip. */
export const WORDS: Record<Activity, string> = { working: 'working', busy: 'busy', idle: 'idle', permission: 'needs permission', ended: 'ended' };

/** A session lead's tooltip: title, activity word, then how many subagents still run (readers included) and commands count as work. */
export function leadTitle(s: Session, now: number): string {
  return `${sessionDisplayTitle(s)} · ${WORDS[sessionActivity(s, now)]}${subagentSuffix(s)}${commandsSuffix(s, now)}`;
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

export { commandLabel };

/** How a command ended, in words: `completed`, `failed`, `was stopped`, `ended with its session`, `ended`. */
export const COMMAND_OUTCOME_WORDS: Record<CommandOutcome, string> = {
  completed: 'completed',
  failed: 'failed',
  killed: 'was stopped',
  session: 'ended with its session',
  unknown: 'ended',
};

/** What an ended command's outcome says, without the time: `completed (exit 0)`, `failed (exit 2)`, `was stopped`. */
export function commandOutcomeWords(c: Pick<CommandInfo, 'outcome' | 'exitCode'>): string {
  const words = COMMAND_OUTCOME_WORDS[c.outcome ?? 'unknown'];
  const withCode = (c.outcome === 'completed' || c.outcome === 'failed') && c.exitCode !== null;
  return withCode ? `${words} (exit ${c.exitCode})` : words;
}

/** An ended command's line end: `completed (exit 0) 2 min ago`. */
export function commandEnded(c: Pick<CommandInfo, 'outcome' | 'exitCode' | 'endedAt'>, now: number): string {
  return `${commandOutcomeWords(c)} ${relativeTime(c.endedAt ?? new Date(now).toISOString(), now)}`;
}

/** A command's time: its run time while it counts, `serving 3h` while it serves, how it ended once it has. */
export function commandWhen(c: CommandInfo, now: number): string {
  if (c.endedAt !== null) return commandEnded(c, now);
  return countsAsWork(c, now) ? runTime(c.startedAt, now) : `serving ${runTime(c.startedAt, now)}`;
}

/** A command's mark: `▸` running and counting, `◦` serving, `✓` completed, `!` any other end. */
export function commandMark(c: CommandInfo, now: number): string {
  if (c.endedAt !== null) return c.outcome === 'completed' ? '✓' : '!';
  return countsAsWork(c, now) ? '▸' : '◦';
}

/** A command's description for a line: without a leading `#id`, and null when empty or only the label. */
export function commandDescription(c: Pick<CommandInfo, 'commandHead' | 'description'>): string | null {
  const description = commandDescriptionText(c);
  return description && description !== commandLabel(c) ? description : null;
}

/** One command as text: `label · description · when`, the description left out when it only repeats the label. */
export function commandText(c: CommandInfo, now: number): string {
  return [commandLabel(c), commandDescription(c), commandWhen(c, now)].filter(Boolean).join(' · ');
}

/** One card line for a session's commands on a step. */
export interface CommandLineParts {
  mark: string;
  /** The lead's label, then ` +n` for the other running commands (when all have ended, the other commands). */
  label: string;
  /** The lead's run time, `serving <time>`, or empty when every command has ended. */
  when: string;
  /** The lead is a serving command. */
  serving: boolean;
  /** Every command has ended. */
  ended: boolean;
  /** One line per command: `label · description · when`. */
  title: string;
}

/**
 * The card's commands line in parts. The lead is the first running command that counts as work, else the first running
 * one, else the first. `commands` come in the layout's taskIds order (running by start, then ended by start).
 */
export function commandLineParts(commands: CommandInfo[], now: number): CommandLineParts {
  const running = commands.filter((c) => c.endedAt === null);
  const lead = running.find((c) => countsAsWork(c, now)) ?? running[0] ?? commands[0];
  const allEnded = running.length === 0;
  const others = (allEnded ? commands.length : running.length) - 1;
  const mark = allEnded ? (commands.every((c) => c.outcome === 'completed') ? '✓' : '!') : commandMark(lead, now);
  return {
    mark,
    label: `${commandLabel(lead)}${others > 0 ? ` +${others}` : ''}`,
    when: allEnded ? '' : commandWhen(lead, now),
    serving: !allEnded && !countsAsWork(lead, now),
    ended: allEnded,
    title: commands.map((c) => commandText(c, now)).join('\n'),
  };
}
