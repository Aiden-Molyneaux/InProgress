import { IN_FLIGHT_LIMIT, AIDEN_OPEN_LIMIT, LEAD_LIST_CAP, type LeadBrief } from '../core/lead';
import { clipLine, stepRef } from '../core/step-ref';
import { askTag } from '../core/types';
import { spanAgo } from './briefing';
import { clip, stamp } from './digest';

/** How much of Aiden's words, an ask's text or an outcome a brief line keeps. */
const TEXT_CUT = 120;
/** How much of the intent record's Goal or Phase paragraph the brief keeps. */
const HEADLINE_CUT = 300;

/**
 * The first paragraph under `## Goal` and under `## Phase`, each cut to 300 characters; '' when absent. A paragraph runs
 * to the next blank line or the next heading, and its lines are joined with a space.
 */
export function intentHeadlines(intent: string): { goal: string; phase: string } {
  const lines = intent.split(/\r?\n/);
  const under = (heading: string): string => {
    const start = lines.findIndex((l) => l.trim().toLowerCase() === `## ${heading}`);
    if (start < 0) return '';
    const paragraph: string[] = [];
    for (const raw of lines.slice(start + 1)) {
      const line = raw.trim();
      if (/^#{1,6}\s/.test(line)) break;
      if (!line) {
        if (paragraph.length) break;
        continue;
      }
      paragraph.push(line);
    }
    return clipLine(paragraph.join(' '), HEADLINE_CUT);
  };
  return { goal: under('goal'), phase: under('phase') };
}

/** A section: its heading and its lines, `  none` when there are none, at most LEAD_LIST_CAP then `  and <k> more`. */
function section(heading: string, items: string[]): string[] {
  if (!items.length) return [heading, '  none'];
  const shown = items.slice(0, LEAD_LIST_CAP).map((i) => `  ${i}`);
  if (items.length > LEAD_LIST_CAP) shown.push(`  and ${items.length - LEAD_LIST_CAP} more`);
  return [heading, ...shown];
}

/**
 * The lead's brief as text, in one fixed shape: every section present, in order. Every age is taken against `b.at`, never
 * the clock, so the same brief always renders the same text.
 */
export function renderLeadBrief(b: LeadBrief): string {
  const now = Date.parse(b.at);
  const { current, yours } = b.instructions;
  const lines = [`Lead brief · ${b.project.name} · ${stamp(b.at)} · instructions v${current} (yours: ${yours === null ? 'none' : `v${yours}`})`];
  if (yours !== null && yours < current) lines.push('Your instructions are out of date: you can read, you cannot change anything.');
  lines.push(`Goal: ${b.intent.goal || 'No intent record yet.'}`, `Phase: ${b.intent.phase || 'none'}`);
  lines.push(
    ...section(
      `In flight (${b.inFlight.length} of ${IN_FLIGHT_LIMIT}):`,
      b.inFlight.map((s) => `${s.stepId === null ? s.title : stepRef(s.stepId, s.title)} · ${s.state} · ${s.app} · seen ${spanAgo(s.lastSeenAt, now)} ago`),
    ),
    ...section(
      `Waiting on Aiden (${b.waitingOnAiden.length} here, ${b.aidenOpenAcrossProjects} of ${AIDEN_OPEN_LIMIT} across all projects):`,
      b.waitingOnAiden.map((a) => `${askTag(a.askId)} ${a.kind} on ${stepRef(a.stepId, a.stepTitle)}: "${clip(a.text, TEXT_CUT)}" · ${spanAgo(a.raisedAt, now)}`),
    ),
    ...section(
      `For the lead (${b.forTheLead.length}):`,
      b.forTheLead.map((a) => `${askTag(a.askId)} on ${stepRef(a.stepId, a.stepTitle)}: "${clip(a.text, TEXT_CUT)}" · ${a.dueAt === null ? 'no due time' : `due ${stamp(a.dueAt)}`}${a.overdue ? ' · OVERDUE' : ''}`),
    ),
    ...section(`Next up (${b.nextUp.length}):`, b.nextUp.map((n) => `${stepRef(n.stepId, n.title)} · ${n.status}`)),
    ...section(`Stale (${b.stale.length}):`, b.stale.map((s) => `${stepRef(s.stepId, s.title)} · ${s.marks.join(', ')}`)),
    ...section(
      `Landed since your last look (${b.landedSince.length}):`,
      b.landedSince.map((n) => `${stepRef(n.stepId, n.title)}${n.outcome.trim() ? `: "${clip(n.outcome, TEXT_CUT)}"` : ''}`),
    ),
    ...section(
      `Said in Aiden's name since your last look (${b.saidInAidensName.length}):`,
      b.saidInAidensName.map((e) => `${stamp(e.at)} ${e.kind} ${e.ref}: "${clip(e.words, TEXT_CUT)}"`),
    ),
    `Links: T3 Code ${b.links.t3} · your last look ${b.links.lastSeenAt === null ? 'never' : `${spanAgo(b.links.lastSeenAt, now)} ago`}`,
  );
  return lines.join('\n');
}
