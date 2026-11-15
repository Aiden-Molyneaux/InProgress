import { IN_FLIGHT_LIMIT, AIDEN_OPEN_LIMIT, LEAD_LIST_CAP, type LeadBrief } from '../core/lead';
import { clipLine, stepRef } from '../core/step-ref';
import { PROJECT_NAME_MAX, askTag } from '../core/types';
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
    const start = lines.findIndex((l) => new RegExp('^#{1,6}\\s*' + heading + '\\s*:?\\s*#*$', 'i').test(l.trim()));
    if (start < 0) return '';
    const paragraph: string[] = [];
    for (const raw of lines.slice(start + 1)) {
      const line = raw.trim();
      // A heading ends the paragraph, with or without a space after its hashes. A line that opens with a step (`#725 to
      // #729`) is text: hashes straight before a digit are no heading.
      if (/^#{1,6}(?!\d)/.test(line)) break;
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

/**
 * Text with every C0 and C1 control character and the Unicode line and paragraph separators, newlines included, turned
 * into a space: one piece of free text stays on one line.
 */
const clean = (text: string): string => text.replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]/g, ' ');
/** Free text as one line cut to `max`: cleaned of control characters, flattened and clipped. */
const line = (text: string, max: number): string => clip(clean(text), max);
/** A step as a line names it, its title cleaned first. */
const step = (id: number, title: string): string => stepRef(id, clean(title));

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
  const lines = [`Lead brief · ${line(b.project.name, PROJECT_NAME_MAX)} · ${stamp(b.at)} · instructions v${current} (yours: ${yours === null ? 'none' : `v${yours}`})`];
  if (yours !== null && yours < current) lines.push('Your instructions are out of date: you can read, you cannot change anything.');
  // True whether the heading is missing or has nothing under it: both read as an empty goal here.
  const noGoal = b.intent.updatedAt !== null ? 'The intent record has no goal under a Goal heading.' : 'No intent record yet.';
  lines.push(`Goal: ${line(b.intent.goal, HEADLINE_CUT) || noGoal}`, `Phase: ${line(b.intent.phase, HEADLINE_CUT) || 'none'}`);
  lines.push(
    ...section(
      `In flight (${b.inFlight.length} of ${IN_FLIGHT_LIMIT}):`,
      b.inFlight.map((s) => `${s.stepId === null ? line(s.title, 50) : step(s.stepId, s.title)} · ${s.state} · ${s.app} · seen ${spanAgo(s.lastSeenAt, now)} ago`),
    ),
    ...section(
      `Waiting on Aiden (${b.waitingOnAiden.length} here, ${b.aidenOpenAcrossProjects} of ${AIDEN_OPEN_LIMIT} across all projects):`,
      b.waitingOnAiden.map((a) => `${askTag(a.askId)} ${a.kind} on ${step(a.stepId, a.stepTitle)}: "${line(a.text, TEXT_CUT)}" · ${spanAgo(a.raisedAt, now)}`),
    ),
    ...section(
      `For the lead (${b.forTheLead.length}):`,
      b.forTheLead.map((a) => `${askTag(a.askId)} on ${step(a.stepId, a.stepTitle)}: "${line(a.text, TEXT_CUT)}" · ${a.dueAt === null ? 'no due time' : `due ${stamp(a.dueAt)}`}${a.overdue ? ' · OVERDUE' : ''}`),
    ),
    ...section(`Next up (${b.nextUp.length}):`, b.nextUp.map((n) => `${step(n.stepId, n.title)} · ${n.status}`)),
    ...section(`Stale (${b.stale.length}):`, b.stale.map((s) => `${step(s.stepId, s.title)} · ${s.marks.join(', ')}`)),
    ...section(
      `Landed since your last look (${b.landedSince.length}):`,
      b.landedSince.map((n) => `${step(n.stepId, n.title)}${line(n.outcome, TEXT_CUT) ? `: "${line(n.outcome, TEXT_CUT)}"` : ''}`),
    ),
    ...section(
      `Said in Aiden's name since your last look (${b.saidInAidensName.length}):`,
      b.saidInAidensName.map((e) => `${stamp(e.at)} ${e.kind} ${e.ref}: "${line(e.words, TEXT_CUT)}"`),
    ),
    `Links: T3 Code ${b.links.t3} · your last look ${b.links.lastSeenAt === null ? 'never' : `${spanAgo(b.links.lastSeenAt, now)} ago`}`,
  );
  return lines.join('\n');
}
