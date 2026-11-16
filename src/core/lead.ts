import type { SessionApp } from './session-app';
import { spanAgo } from './span';
import type { AskKind } from './types';

/** The version of the lead's written instructions. A write command from a lower version is refused. */
export const LEAD_INSTRUCTIONS_VERSION = 3;
/** The marks that make a step Stale in the lead's brief: it was left open, an ask went unanswered, or an answer is owed. */
export const LEAD_STALE_MARKS = ['ended_open', 'stale_ask', 'done_focus', 'stalled', 'answer_waiting', 'answered_in_chat'] as const;
/**
 * What else puts a step under Stale, beyond the Board's marks: open work in nobody's hands. `blocked` is a blocked step,
 * `no_session` an active one, each with no live session on it and no place in the queue.
 */
export const LEAD_IDLE_MARKS = ['blocked', 'no_session'] as const;
/** With no last look on record, how many days back the brief counts what landed and what was said. */
export const LEAD_LOOK_BACK_DAYS = 7;
/** The most lines one section of the brief prints; the rest read as `and <k> more`. */
export const LEAD_LIST_CAP = 8;
/** The most open asks of Aiden's, across all projects, the lead lets stand (the brief's `<m> of 5`). */
export const AIDEN_OPEN_LIMIT = 5;
/** The longest a lead's name may be, once trimmed. */
export const LEAD_NAME_MAX = 40;
/** A lead's name: one plain word, because the rules print it unquoted on every command line. */
export const LEAD_NAME = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,39}$/;
export const LEAD_NAME_RULE = "A lead's name is 1 to 40 letters, digits, dots, dashes or underscores, and starts with a letter or a digit.";
/** The most sessions in flight the lead lets a project have (the brief's `<n> of 3`). */
export const IN_FLIGHT_LIMIT = 3;
/** Who an ask is for: Aiden, or the lead (a promise it made). */
export type AskOwner = 'aiden' | 'lead';
/**
 * Whether an ask is Aiden's to answer: every ask but the lead's own promise. Every reader of open asks that means "needs
 * Aiden" uses this (and aidensAskSql in src/server/repo/asks.ts for SQL), so a lead-owned ask reaches no briefing, no
 * title, no count and no Board row.
 */
export const isAidens = (a: { owner: AskOwner }): boolean => a.owner !== 'lead';
export type LeadEventKind = 'answer' | 'park' | 'drop' | 'promise' | 'kept' | 'intent' | 'relay' | 'relay_unknown' | 'relay_failed';

/** One line of the lead's log, as the log's read answers it. */
export interface LeadEventOut {
  id: number;
  at: string;
  lead: string;
  instructions: number;
  kind: LeadEventKind;
  nodeId: number | null;
  askId: number | null;
  sessionId: string | null;
  text: string;
  aidenWords: string | null;
}

/** Where a project stands, as plain code builds it from the record: one fixed shape, whatever the project holds. */
export interface LeadBrief {
  project: { slug: string; name: string; lead: string | null };
  at: string;
  instructions: { current: number; yours: number | null };
  /**
   * `goal` and `phase` are the headline paragraphs, cut; `text` is the whole stored record ('' with none). `landedSince` is
   * how many steps (never the root) finished at or after `updatedAt`, 0 with no record. `phaseFinished`: the Phase
   * paragraph names at least one step of this project as `#<digits>`, and every one it names there is done or dropped.
   */
  intent: { goal: string; phase: string; updatedAt: string | null; text: string; landedSince: number; phaseFinished: boolean };
  inFlight: { stepId: number | null; title: string; sessionId: string; app: SessionApp; state: string; lastSeenAt: string }[];
  waitingOnAiden: { askId: number; kind: AskKind; stepId: number; stepTitle: string; text: string; raisedAt: string }[];
  /** Steps Aiden does himself that are active with no session on them: in his hands, so listed with what waits on him. */
  aidensOwn: { stepId: number; title: string; updatedAt: string }[];
  aidenOpenAcrossProjects: number;
  forTheLead: { askId: number; stepId: number; stepTitle: string; text: string; dueAt: string | null; overdue: boolean }[];
  nextUp: { stepId: number; title: string; status: string }[];
  /** Steps not started (todo), in no session's hands and not in the queue. One with a stale mark (LEAD_STALE_MARKS) is under Stale as well. */
  backlog: number;
  /** `marks` are LEAD_STALE_MARKS and LEAD_IDLE_MARKS; `reasons` says each in words, one per mark, in the same order. */
  stale: { stepId: number; title: string; marks: string[]; reasons: string[] }[];
  landedSince: { stepId: number; title: string; outcome: string; completedAt: string }[];
  saidInAidensName: { at: string; kind: LeadEventKind; ref: string; words: string }[];
  /**
   * `t3` and `t3At` are read from the lead's log, per project: the newest relay, relay_unknown or relay_failed event.
   * `ok` for a relay, `unavailable` for the other two, `not checked` (and null) with none.
   */
  links: { t3: 'ok' | 'unavailable' | 'not checked'; t3At: string | null; lastSeenAt: string | null };
}

/**
 * The line under the Phase that says how old the intent record is, in the lead's brief and in the window; null with no
 * record. `forLead` adds what the lead does when every step the Phase names is finished.
 */
export function intentLine(i: LeadBrief['intent'], now: number, forLead: boolean): string | null {
  if (i.updatedAt === null) return null;
  const n = i.landedSince;
  let text = `Intent record: written ${spanAgo(i.updatedAt, now)} ago · ${n} ${n === 1 ? 'step' : 'steps'} landed since`;
  if (i.phaseFinished) text += ` · every step the Phase names is finished${forLead ? ': ask Aiden what the Phase is now' : ''}`;
  return text;
}
