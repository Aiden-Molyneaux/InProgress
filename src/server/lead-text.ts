import { IN_FLIGHT_LIMIT, AIDEN_OPEN_LIMIT, LEAD_LIST_CAP, LEAD_LOOK_BACK_DAYS, type LeadBrief } from '../core/lead';
import { clipLine, stepRef } from '../core/step-ref';
import { PROJECT_NAME_MAX, askTag } from '../core/types';
import { spanAgo } from './briefing';
import { clip, stamp } from './digest';

/** How much of Aiden's words or an outcome a brief line keeps. */
const TEXT_CUT = 120;
/**
 * How much of an ask's text a line keeps. An ask often ends with the reply it wants ("Say ship the note"), and a reader
 * who retells a cut ask fills in the end: at 120, 35 of Aiden's 41 open asks were cut (2026-11-15), the longest 551.
 */
const ASK_CUT = 600;
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
  const { t3, t3At, lastSeenAt } = b.links;
  // A relay that did not get through is news once: until the lead marks a look after it.
  if (t3 === 'unavailable' && t3At !== null && (lastSeenAt === null || t3At > lastSeenAt)) {
    lines.push(`The last relay may not have reached its session (${spanAgo(t3At, now)} ago): read the thread before you send it again.`);
  }
  // True whether the heading is missing or has nothing under it: both read as an empty goal here.
  const noGoal = b.intent.updatedAt !== null ? 'The intent record has no goal under a Goal heading.' : 'No intent record yet.';
  lines.push(`Goal: ${line(b.intent.goal, HEADLINE_CUT) || noGoal}`, `Phase: ${line(b.intent.phase, HEADLINE_CUT) || 'none'}`);
  const over = b.aidenOpenAcrossProjects - AIDEN_OPEN_LIMIT;
  // Until a look is marked the brief counts LEAD_LOOK_BACK_DAYS back, and says so: there is no last look to count from.
  const span = b.links.lastSeenAt === null ? `in the last ${LEAD_LOOK_BACK_DAYS} days` : 'since your last look';
  lines.push(
    ...section(
      `In flight (${b.inFlight.length} of ${IN_FLIGHT_LIMIT}):`,
      b.inFlight.map((s) => `${s.stepId === null ? line(s.title, 50) : step(s.stepId, s.title)} · ${s.state} · ${s.app} · seen ${spanAgo(s.lastSeenAt, now)} ago`),
    ),
    // His own steps first: they are few, and after a long list of asks the cap would cut them.
    ...section(`Waiting on Aiden (${b.waitingOnAiden.length + b.aidensOwn.length}):`, [
      ...b.aidensOwn.map((s) => `${step(s.stepId, s.title)} · Aiden's own step, active, last changed ${spanAgo(s.updatedAt, now)} ago`),
      ...b.waitingOnAiden.map((a) => `${askTag(a.askId)} ${a.kind} on ${step(a.stepId, a.stepTitle)}: "${line(a.text, ASK_CUT)}" · ${spanAgo(a.raisedAt, now)}`),
    ]),
    // A line of its own, not part of a heading: a reader who retells the brief keeps a line and drops a heading's detail.
    `Aiden's open asks across all projects: ${b.aidenOpenAcrossProjects} of ${AIDEN_OPEN_LIMIT}${over > 0 ? `, ${over} over the limit` : ''}`,
    ...section(
      `For the lead (${b.forTheLead.length}):`,
      b.forTheLead.map((a) => `${askTag(a.askId)} on ${step(a.stepId, a.stepTitle)}: "${line(a.text, ASK_CUT)}" · ${a.dueAt === null ? 'no due time' : `due ${stamp(a.dueAt)}`}${a.overdue ? ' · OVERDUE' : ''}`),
    ),
    ...section(`Next up (${b.nextUp.length}):`, b.nextUp.map((n) => `${step(n.stepId, n.title)} · ${n.status}`)),
    `Backlog: ${b.backlog} ${b.backlog === 1 ? 'step' : 'steps'} not started and not in the queue`,
    ...section(`Stale (${b.stale.length}):`, b.stale.map((s) => `${step(s.stepId, s.title)} · ${s.reasons.map(clean).join('; ')}`)),
    ...section(
      `Landed ${span} (${b.landedSince.length}):`,
      b.landedSince.map((n) => `${step(n.stepId, n.title)}${line(n.outcome, TEXT_CUT) ? `: "${line(n.outcome, TEXT_CUT)}"` : ''}`),
    ),
    ...section(
      `Said in Aiden's name ${span} (${b.saidInAidensName.length}):`,
      b.saidInAidensName.map((e) => `${stamp(e.at)} ${e.kind} ${e.ref}: "${line(e.words, TEXT_CUT)}"`),
    ),
    `Links: T3 Code ${t3}${t3At === null ? '' : `, last relay ${spanAgo(t3At, now)} ago`} · your last look ${b.links.lastSeenAt === null ? 'never' : `${spanAgo(b.links.lastSeenAt, now)} ago`}`,
  );
  return lines.join('\n');
}
