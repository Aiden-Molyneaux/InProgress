import type { SessionApp } from './session-app';
import type { AskKind } from './types';

/** The version of the lead's written instructions. A write command from a lower version is refused. */
export const LEAD_INSTRUCTIONS_VERSION = 1;
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

/** Where a project stands, as plain code builds it from the record: one fixed shape, whatever the project holds. */
export interface LeadBrief {
  project: { slug: string; name: string; lead: string | null };
  at: string;
  instructions: { current: number; yours: number | null };
  intent: { goal: string; phase: string; updatedAt: string | null };
  inFlight: { stepId: number | null; title: string; sessionId: string; app: SessionApp; state: string; lastSeenAt: string }[];
  waitingOnAiden: { askId: number; kind: AskKind; stepId: number; stepTitle: string; text: string; raisedAt: string }[];
  /** Steps Aiden does himself that are active with no session on them: in his hands, so listed with what waits on him. */
  aidensOwn: { stepId: number; title: string; updatedAt: string }[];
  aidenOpenAcrossProjects: number;
  forTheLead: { askId: number; stepId: number; stepTitle: string; text: string; dueAt: string | null; overdue: boolean }[];
  nextUp: { stepId: number; title: string; status: string }[];
  /** Steps not started (todo), in no session's hands and not in the queue. One with a mark is under Stale as well. */
  backlog: number;
  /** `marks` are LEAD_STALE_MARKS and LEAD_IDLE_MARKS; `reasons` says each in words, one per mark, in the same order. */
  stale: { stepId: number; title: string; marks: string[]; reasons: string[] }[];
  landedSince: { stepId: number; title: string; outcome: string; completedAt: string }[];
  saidInAidensName: { at: string; kind: LeadEventKind; ref: string; words: string }[];
  links: { t3: 'ok' | 'unavailable' | 'not checked'; t3At: string | null; lastSeenAt: string | null };
}
