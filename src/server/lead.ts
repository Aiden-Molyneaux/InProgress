import { deriveBoard } from '../core/board';
import { LEAD_INSTRUCTIONS_VERSION, type LeadBrief, type LeadEventKind } from '../core/lead';
import type { Project } from '../core/types';
import { write, type Ctx } from './db/tx';
import { conflict } from './errors';
import { intentHeadlines } from './lead-text';
import { listProjectSummaries, resolveProject } from './repo/projects';
import { readProjectSessions } from './repo/sessions';
import { getProjectSnapshot } from './repo/snapshot';

const DAY_MS = 24 * 60 * 60 * 1000;
/** With no last look on record, the brief looks back this far for what landed and what was said. */
const DEFAULT_LOOK_BACK_MS = 7 * DAY_MS;
/** What a session with no focus step is called in the brief. */
const NO_STEP = 'no step claimed';

/** The refusal of a lead command on a project that has no lead, or another one. */
export const noLeadNamed = (as: string): string => `This project has no lead named ${as}. Only Aiden can give a project a lead, from its actions in the window.`;
/** The refusal of a change from instructions older than the current ones. */
export const outOfDate = (yours: number): string =>
  `Your instructions are version ${yours}; version ${LEAD_INSTRUCTIONS_VERSION} is needed to change anything. Ask Aiden to paste the new ones.`;

/**
 * The project `ref`, when its lead is the one named `as` (ignoring case and surrounding spaces). A project with no lead,
 * or another one's, is refused with a 409. With `write` true, instructions older than LEAD_INSTRUCTIONS_VERSION are
 * refused too. It changes nothing.
 */
export function requireLead(ctx: Ctx, ref: string, as: string, instructions: number, write: boolean): Project {
  const project = resolveProject(ctx, ref);
  const name = as.trim();
  if (project.lead === null || project.lead.trim().toLowerCase() !== name.toLowerCase()) throw conflict(noLeadNamed(name));
  if (write && instructions < LEAD_INSTRUCTIONS_VERSION) throw conflict(outOfDate(instructions));
  return project;
}

interface LeadEventRow {
  at: string;
  kind: string;
  ask_id: number | null;
  node_id: number | null;
  aiden_words: string;
}

/**
 * Where Aiden's words are cited from: the project's lead_events with his words, `at` or after `since`, newest first. The
 * ref is the ask (`a7`) when the line names one, else the step (`#42`).
 */
function saidSince(ctx: Ctx, projectId: number, since: string): LeadBrief['saidInAidensName'] {
  const rows = ctx.db
    .prepare('SELECT at, kind, ask_id, node_id, aiden_words FROM lead_events WHERE project_id = ? AND aiden_words IS NOT NULL AND at >= ? ORDER BY at DESC, id DESC')
    .all(projectId, since) as LeadEventRow[];
  return rows.map((r) => ({
    at: r.at,
    kind: r.kind as LeadEventKind,
    ref: r.ask_id !== null ? `a${r.ask_id}` : `#${r.node_id}`,
    words: r.aiden_words,
  }));
}

/**
 * Where the project stands, built from the record: every row, uncut (only renderLeadBrief cuts a list). `yours` is the
 * instructions version the reader holds, null for the window. Never call it inside a write(): the snapshot read may expire
 * stale sessions.
 */
export function readLeadBrief(ctx: Ctx, ref: string, yours: number | null, now: Date): LeadBrief {
  const project = resolveProject(ctx, ref);
  const snapshot = getProjectSnapshot(ctx, project.id);
  const nowMs = now.getTime();
  const since = project.leadSeenAt ?? new Date(nowMs - DEFAULT_LOOK_BACK_MS).toISOString();
  const byId = new Map(snapshot.nodes.map((n) => [n.id, n]));
  const titleOf = (id: number): string => byId.get(id)?.title ?? '';

  const inFlight = readProjectSessions(ctx, project.id).map((s) => ({
    stepId: s.focusNodeId,
    title: s.focusNodeId === null ? NO_STEP : (byId.get(s.focusNodeId)?.title ?? NO_STEP),
    sessionId: s.id,
    app: s.app,
    state: s.state,
    lastSeenAt: s.lastSeenAt,
  }));

  const open = snapshot.asks.filter((a) => a.clearedAt === null);
  const waitingOnAiden = open
    .filter((a) => a.owner === 'aiden')
    .map((a) => ({ askId: a.id, kind: a.kind, stepId: a.nodeId, stepTitle: titleOf(a.nodeId), text: a.text, raisedAt: a.raisedAt }));
  const aidenOpenAcrossProjects = listProjectSummaries(ctx)
    .filter((p) => p.status === 'active')
    .reduce((sum, p) => sum + p.openAsks, 0);

  const forTheLead = open
    .filter((a) => a.owner === 'lead')
    .sort((a, b) => (a.dueAt === null ? 1 : 0) - (b.dueAt === null ? 1 : 0) || (a.dueAt ?? '').localeCompare(b.dueAt ?? '') || a.id - b.id)
    .map((a) => ({ askId: a.id, stepId: a.nodeId, stepTitle: titleOf(a.nodeId), text: a.text, dueAt: a.dueAt, overdue: a.dueAt !== null && Date.parse(a.dueAt) < nowMs }));

  const nextUp = project.queue.flatMap((e) => {
    const n = byId.get(e.nodeId);
    return n ? [{ stepId: n.id, title: n.title, status: n.status }] : [];
  });

  const stale = deriveBoard(snapshot, nowMs).marked.map((r) => ({ stepId: r.node.id, title: r.node.title, marks: [...r.marks] }));

  const landedSince = snapshot.nodes
    .filter((n): n is typeof n & { completedAt: string } => n.parentId !== null && n.status === 'done' && n.completedAt !== null && n.completedAt >= since)
    .sort((a, b) => b.completedAt.localeCompare(a.completedAt) || b.id - a.id)
    .map((n) => ({ stepId: n.id, title: n.title, outcome: n.outcome, completedAt: n.completedAt }));

  return {
    project: { slug: project.slug, name: project.name, lead: project.lead },
    at: now.toISOString(),
    instructions: { current: LEAD_INSTRUCTIONS_VERSION, yours },
    intent: { ...intentHeadlines(project.intent), updatedAt: project.intentUpdatedAt },
    inFlight,
    waitingOnAiden,
    aidenOpenAcrossProjects,
    forTheLead,
    nextUp,
    stale,
    landedSince,
    saidInAidensName: saidSince(ctx, project.id, since),
    // Task 3 fills in T3: until then the brief says it did not check.
    links: { t3: 'not checked', t3At: null, lastSeenAt: project.leadSeenAt },
  };
}

/** The lead has read the brief at `now`: the next one counts what landed and what was said from here. */
export function markLeadSeen(ctx: Ctx, ref: string, now: Date): void {
  const project = resolveProject(ctx, ref);
  write(ctx, 'lead', () => {
    ctx.db.prepare('UPDATE projects SET lead_seen_at = ? WHERE id = ?').run(now.toISOString(), project.id);
  });
}

/** One line in the lead's log. A plain insert: a command that changes something calls it inside its own write. */
export function logLeadEvent(
  ctx: Ctx,
  e: { projectId: number; lead: string; instructions: number; kind: LeadEventKind; nodeId?: number; askId?: number; sessionId?: string; text?: string; aidenWords?: string },
): void {
  ctx.db
    .prepare('INSERT INTO lead_events (project_id, at, lead, instructions, kind, node_id, ask_id, session_id, text, aiden_words) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
    .run(e.projectId, ctx.now(), e.lead, e.instructions, e.kind, e.nodeId ?? null, e.askId ?? null, e.sessionId ?? null, e.text ?? '', e.aidenWords ?? null);
}

/** The last `limit` lines of the project's log, newest first. */
export function listLeadEvents(ctx: Ctx, ref: string, limit = 100): LeadEventOut[] {
  const project = resolveProject(ctx, ref);
  const rows = ctx.db
    .prepare('SELECT id, at, lead, instructions, kind, node_id, ask_id, session_id, text, aiden_words FROM lead_events WHERE project_id = ? ORDER BY at DESC, id DESC LIMIT ?')
    .all(project.id, limit) as {
    id: number;
    at: string;
    lead: string;
    instructions: number;
    kind: string;
    node_id: number | null;
    ask_id: number | null;
    session_id: string | null;
    text: string;
    aiden_words: string | null;
  }[];
  return rows.map((r) => ({
    id: r.id,
    at: r.at,
    lead: r.lead,
    instructions: r.instructions,
    kind: r.kind as LeadEventKind,
    nodeId: r.node_id,
    askId: r.ask_id,
    sessionId: r.session_id,
    text: r.text,
    aidenWords: r.aiden_words,
  }));
}

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
