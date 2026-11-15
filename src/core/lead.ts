import type { SessionApp } from './session-app';
import type { AskKind } from './types';

/** The version of the lead's written instructions. A write command from a lower version is refused. */
export const LEAD_INSTRUCTIONS_VERSION = 1;
/** The most lines one section of the brief prints; the rest read as `and <k> more`. */
export const LEAD_LIST_CAP = 8;
/** The most open asks of Aiden's, across all projects, the lead lets stand (the brief's `<m> of 5`). */
export const AIDEN_OPEN_LIMIT = 5;
/** The most sessions in flight the lead lets a project have (the brief's `<n> of 3`). */
export const IN_FLIGHT_LIMIT = 3;
/** Who an ask is for: Aiden, or the lead (a promise it made). */
export type AskOwner = 'aiden' | 'lead';
export type LeadEventKind = 'answer' | 'park' | 'drop' | 'promise' | 'kept' | 'intent' | 'relay' | 'relay_unknown' | 'relay_failed';

/** Where a project stands, as plain code builds it from the record: one fixed shape, whatever the project holds. */
export interface LeadBrief {
  project: { slug: string; name: string; lead: string | null };
  at: string;
  instructions: { current: number; yours: number | null };
  intent: { goal: string; phase: string; updatedAt: string | null };
  inFlight: { stepId: number | null; title: string; sessionId: string; app: SessionApp; state: string; lastSeenAt: string }[];
  waitingOnAiden: { askId: number; kind: AskKind; stepId: number; stepTitle: string; text: string; raisedAt: string }[];
  aidenOpenAcrossProjects: number;
  forTheLead: { askId: number; stepId: number; stepTitle: string; text: string; dueAt: string | null; overdue: boolean }[];
  nextUp: { stepId: number; title: string; status: string }[];
  stale: { stepId: number; title: string; marks: string[] }[];
  landedSince: { stepId: number; title: string; outcome: string; completedAt: string }[];
  saidInAidensName: { at: string; kind: LeadEventKind; ref: string; words: string }[];
  links: { t3: 'ok' | 'unavailable' | 'not checked'; t3At: string | null; lastSeenAt: string | null };
}
