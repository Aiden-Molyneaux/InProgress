import { AIDEN_OPEN_LIMIT, IN_FLIGHT_LIMIT, LEAD_LOOK_BACK_DAYS, intentLine, type LeadBrief, type LeadEventOut } from '../../../src/core/lead';
import { spanAgo, stamp } from '../../../src/core/span';

/** What the view says for a project with no lead. */
export const NO_LEAD = 'No lead. Give this project one from its actions.';

export interface DeskRow {
  key: string;
  text: string;
  detail?: string;
  meta?: string;
  overdue?: boolean;
  nodeId?: number;
}
export interface DeskGroup {
  id: 'needs' | 'moving' | 'stuck' | 'next' | 'promises' | 'landed' | 'said';
  title: string;
  count: number;
  note?: string;
  rows: DeskRow[];
}
export interface DeskHead {
  lead: string | null;
  instructions: number;
  goal: string;
  phase: string;
  /** When the record was written and how many steps landed since, or null with no record. */
  intentLine: string | null;
  /** The whole stored record, '' with none. */
  intentText: string;
  warning: string | null;
  links: string;
}
export interface DeskDecided {
  key: string;
  line: string;
  why: string;
  undo: string | null;
  isNew: boolean;
  age: string;
}
export interface LogLine {
  key: number;
  at: string;
  kind: string;
  ref: string;
  text: string;
  words: string | null;
  by: string;
  nodeId?: number;
}

/** Free text as one line: every run of whitespace, newlines included, is one space. */
const flat = (text: string): string => text.replace(/\s+/g, ' ').trim();
/** A step as the desk names it. */
const step = (id: number, title: string): string => `#${id} ${flat(title)}`.trim();

export function deskHead(b: LeadBrief, now: number): DeskHead {
  const { t3, t3At, lastSeenAt } = b.links;
  const noGoal = b.intent.updatedAt !== null ? 'The intent record has no goal under a Goal heading.' : 'No intent record yet.';
  const warn = t3 === 'unavailable' && t3At !== null && (lastSeenAt === null || t3At > lastSeenAt);
  return {
    lead: b.project.lead,
    instructions: b.instructions.current,
    goal: flat(b.intent.goal) || noGoal,
    phase: flat(b.intent.phase) || 'none',
    intentLine: intentLine(b.intent, now, false),
    intentText: b.intent.text,
    warning: warn ? `The last relay may not have reached its session (${spanAgo(t3At, now)} ago).` : null,
    links: `T3 Code ${t3}${t3At === null ? '' : `, last relay ${spanAgo(t3At, now)} ago`} · the lead's last look ${lastSeenAt === null ? 'never' : `${spanAgo(lastSeenAt, now)} ago`}`,
  };
}

export function deskGroups(b: LeadBrief, now: number): DeskGroup[] {
  const span = b.links.lastSeenAt === null ? `in the last ${LEAD_LOOK_BACK_DAYS} days` : "since the lead's last look";
  const over = b.aidenOpenAcrossProjects - AIDEN_OPEN_LIMIT;
  const needsRows: DeskRow[] = [
    ...b.aidensOwn.map((s) => ({
      key: `own-${s.stepId}`,
      text: step(s.stepId, s.title),
      meta: `your own step, active · last changed ${spanAgo(s.updatedAt, now)} ago`,
      nodeId: s.stepId,
    })),
    ...b.waitingOnAiden.map((a) => ({
      key: `ask-${a.askId}`,
      text: `a${a.askId} ${a.kind} · ${step(a.stepId, a.stepTitle)}`,
      detail: a.text,
      meta: `raised ${spanAgo(a.raisedAt, now)} ago`,
      nodeId: a.stepId,
    })),
  ];
  return [
    {
      id: 'needs',
      title: 'Needs you',
      count: needsRows.length,
      note: `Open asks across all projects: ${b.aidenOpenAcrossProjects} of ${AIDEN_OPEN_LIMIT}${over > 0 ? `, ${over} over the limit` : ''}`,
      rows: needsRows,
    },
    {
      id: 'moving',
      title: 'Moving',
      count: b.inFlight.length,
      note: `${b.inFlight.length} of ${IN_FLIGHT_LIMIT} in flight`,
      rows: b.inFlight.map((s) => ({
        key: s.sessionId,
        text: s.stepId === null ? flat(s.title) : step(s.stepId, s.title),
        meta: `${s.state} · ${s.app} · seen ${spanAgo(s.lastSeenAt, now)} ago`,
        ...(s.stepId === null ? {} : { nodeId: s.stepId }),
      })),
    },
    {
      id: 'stuck',
      title: 'Stuck',
      count: b.stale.length,
      rows: b.stale.map((s) => ({ key: String(s.stepId), text: step(s.stepId, s.title), detail: s.reasons.map(flat).join('; '), nodeId: s.stepId })),
    },
    {
      id: 'next',
      title: 'Next',
      count: b.nextUp.length,
      note: `Backlog: ${b.backlog} ${b.backlog === 1 ? 'step' : 'steps'} not started and not in the queue`,
      rows: b.nextUp.map((n) => ({ key: String(n.stepId), text: step(n.stepId, n.title), meta: n.status, nodeId: n.stepId })),
    },
    {
      id: 'promises',
      title: "The lead's promises",
      count: b.forTheLead.length,
      rows: b.forTheLead.map((a) => ({
        key: `ask-${a.askId}`,
        text: `a${a.askId} · ${step(a.stepId, a.stepTitle)}`,
        detail: a.text,
        meta: a.dueAt === null ? 'no due time' : `due ${stamp(a.dueAt)}`,
        overdue: a.overdue,
        nodeId: a.stepId,
      })),
    },
    {
      id: 'landed',
      title: `Landed ${span}`,
      count: b.landedSince.length,
      rows: b.landedSince.map((n) => ({ key: String(n.stepId), text: step(n.stepId, n.title), ...(flat(n.outcome) ? { detail: flat(n.outcome) } : {}), nodeId: n.stepId })),
    },
    {
      id: 'said',
      title: `Said in your name ${span}`,
      count: b.saidInAidensName.length,
      rows: b.saidInAidensName.map((e, i) => ({ key: String(i), text: `${stamp(e.at)} ${e.kind} ${e.ref}`, detail: `"${flat(e.words)}"` })),
    },
  ];
}

/** What was decided for Aiden, newest first as the brief gives it. */
export function deskDecided(b: LeadBrief, now: number): DeskDecided[] {
  return b.decided.map((d, i) => {
    const on = d.stepId === null ? '' : ` on ${step(d.stepId, d.stepTitle)}`;
    const mine = d.tag !== '';
    return {
      key: mine ? d.tag : `s${i}`,
      line: mine ? `${d.by} ${flat(d.what)}${on}` : `a session${on}: ${flat(d.what)}`,
      why: flat(d.why),
      undo: mine ? `Say: undo ${d.tag}` : null,
      isNew: d.isNew,
      age: `${spanAgo(d.at, now)} ago`,
    };
  });
}

export function logLines(events: readonly LeadEventOut[]): LogLine[] {
  return events.map((e) => ({
    key: e.id,
    at: stamp(e.at),
    kind: e.kind.replace(/_/g, ' '),
    ref: e.askId !== null ? `a${e.askId}` : e.nodeId !== null ? `#${e.nodeId}` : '',
    // The intent record is long and has headings of its own: the log names it and does not print it. A park whose reason
    // is Aiden's words would print them twice: the words alone say it.
    text: e.kind === 'intent' ? `the intent record, ${e.text.length} characters` : e.aidenWords !== null && flat(e.text) === flat(e.aidenWords) ? '' : flat(e.text),
    words: e.aidenWords,
    by: `${e.lead} · v${e.instructions}`,
    ...(e.nodeId !== null ? { nodeId: e.nodeId } : {}),
  }));
}
