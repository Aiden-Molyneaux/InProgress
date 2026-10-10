import type { CommandInfo, Session } from './types';
import { ENDED_AGENT_MS, isReader } from './types';

/** What a session is doing, for the window: its stored state, with `idle` told apart from `busy` (work still running). */
export type Activity = 'working' | 'busy' | 'idle' | 'permission' | 'ended';

/** A command older than this no longer counts as work: it is probably a watcher nobody stopped. */
export const COMMAND_WORK_MS = 30 * 60 * 1000;
/** Head words of a command that serves or watches rather than works (`npm run dev`, `vite:preview`). */
export const SERVER_WORDS = ['dev', 'serve', 'preview', 'start', 'watch'];

/** A head word, or a `:`-separated part of one (`test:watch`), that names a server or watcher. */
export function looksLikeServer(head?: string | null): boolean {
  if (!head) return false;
  return head.split(/\s+/).some((word) => word.split(':').some((part) => SERVER_WORDS.includes(part.toLowerCase())));
}

/** Whether a command is work a session is still doing: running, not a persistent Monitor or a server, under 30 minutes old. */
export function countsAsWork(c: Pick<CommandInfo, 'endedAt' | 'startedAt' | 'persistent' | 'commandHead'>, now: number): boolean {
  if (c.endedAt !== null || c.persistent) return false;
  if (now - Date.parse(c.startedAt) >= COMMAND_WORK_MS) return false;
  return !looksLikeServer(c.commandHead);
}

/** Whether the window shows a command: running, or ended less than ENDED_AGENT_MS ago. */
export function commandShown(c: Pick<CommandInfo, 'endedAt'>, now: number): boolean {
  return c.endedAt === null || now - Date.parse(c.endedAt) < ENDED_AGENT_MS;
}

/** The stored state, except that `idle` is `busy` while a subagent that is not a reader runs or a command counts as work. */
export function sessionActivity(s: Pick<Session, 'state' | 'subagents' | 'commands'>, now: number): Activity {
  if (s.state !== 'idle') return s.state;
  const busy = s.subagents.some((a) => a.endedAt === null && !isReader(a.agentType)) || s.commands.some((c) => countsAsWork(c, now));
  return busy ? 'busy' : 'idle';
}

/** A command's name for the window: its head, else its description without a leading `#id`, else a generic one. */
export function commandLabel(c: Pick<CommandInfo, 'commandHead' | 'description'>): string {
  const description = c.description?.replace(/^\s*#\d+\b\s*/, '').trim();
  return c.commandHead || description || 'a background command';
}
