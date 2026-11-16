import { deriveBoard, type BoardRow, type Mark } from '../core/board';
import { LEAD_IDLE_MARKS, LEAD_INSTRUCTIONS_VERSION, LEAD_LOOK_BACK_DAYS, LEAD_STALE_MARKS, isAidens, type LeadBrief, type LeadEventKind, type LeadEventOut } from '../core/lead';
import { leadBootstrap, leadRules } from '../core/lead-rules';
import { buildIndex, dfsOrder, shelvedIds } from '../core/tree';
import { ASK_TRAIL_MS, askTag, type Ask, type Project } from '../core/types';
import { spanAgo } from './briefing';
import { write, type Ctx } from './db/tx';
import { conflict } from './errors';
import { intentHeadlines } from './lead-text';
import { listProjectSummaries, resolveProject } from './repo/projects';
import { readProjectSessions } from './repo/sessions';
import { getProjectSnapshot } from './repo/snapshot';

const DAY_MS = 24 * 60 * 60 * 1000;
/** With no last look on record, the brief looks back this far for what landed and what was said. */
const DEFAULT_LOOK_BACK_MS = LEAD_LOOK_BACK_DAYS * DAY_MS;
/** What a session with no focus step is called in the brief. */
const NO_STEP = 'no step claimed';

/** The refusal of a lead command on a project that has no lead, or another one. */
export const noLeadNamed = (as: string): string => `This project has no lead named ${as}. Only Aiden can give a project a lead, from its actions in the window.`;
/** The refusal of a lead command on an archived project: it keeps no lead. */
export const ARCHIVED = 'This project is archived, so it has no lead.';
/** The refusal of a change from instructions older than the current ones. */
export const outOfDate = (yours: number, slug: string, lead: string): string =>
  `Your rules are version ${yours}; version ${LEAD_INSTRUCTIONS_VERSION} is current. Run "lead rules ${slug} --as ${lead}" again and follow what it prints.`;

/**
 * The project `ref`, when its lead is the one named `as` (ignoring case and surrounding spaces). A project with no lead,
 * or another one's, is refused with a 409. With `write` true, instructions older than LEAD_INSTRUCTIONS_VERSION are
 * refused too. An archived project has no lead and is refused with its own sentence. It changes nothing.
 */
export function requireLead(ctx: Ctx, ref: string, as: string, instructions: number, write: boolean): Project {
  const project = resolveProject(ctx, ref);
  const name = as.trim();
  if (project.status === 'archived') throw conflict(ARCHIVED);
  if (project.lead === null || project.lead.trim().toLowerCase() !== name.toLowerCase()) throw conflict(noLeadNamed(name));
  if (write && instructions < LEAD_INSTRUCTIONS_VERSION) throw conflict(outOfDate(instructions, project.slug, project.lead.trim()));
  return project;
}

/** The rules and the bootstrap for the project's lead, as the rules command prints them. `cli` is `node <path>`. A read: it changes nothing. */
export function readLeadRules(ctx: Ctx, ref: string, as: string, cli: string): { version: number; text: string; bootstrap: string } {
  const project = requireLead(ctx, ref, as, LEAD_INSTRUCTIONS_VERSION, false);
  const v = { lead: project.lead!.trim(), projectName: project.name, slug: project.slug, cli };
  return { version: LEAD_INSTRUCTIONS_VERSION, text: leadRules(v), bootstrap: leadBootstrap(v) };
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

/** Asks as a sentence names them: `a7`, `a7 and a9`, `a7, a8 and a9`. */
function askList(asks: readonly Ask[]): string {
  const tags = asks.map((a) => askTag(a.id));
  return tags.length < 2 ? tags.join('') : `${tags.slice(0, -1).join(', ')} and ${tags[tags.length - 1]}`;
}

/**
 * Why a Board row is under Stale in the lead's brief, in words: one entry per mark, none when it is not stale. First the
 * open work in nobody's hands (LEAD_IDLE_MARKS): a backlog row that is blocked, or active with no session on it. An active
 * one whose session ended in the last week says so through `ended_open` alone. Then the Board's marks that are
 * LEAD_STALE_MARKS, in the Board's order. `lastEnded` is when the newest ended session on the step ended, if one is known.
 */
export function staleReasons(
  r: Pick<BoardRow, 'node' | 'column' | 'sessions' | 'driver' | 'asks' | 'waiting' | 'marks'>,
  now: number,
  lastEnded: string | null,
): { mark: Mark | (typeof LEAD_IDLE_MARKS)[number]; text: string }[] {
  const why: ReturnType<typeof staleReasons> = [];
  const changed = `last changed ${spanAgo(r.node.updatedAt, now)} ago`;
  if (r.column === 'backlog' && r.node.status === 'blocked') why.push({ mark: 'blocked', text: `blocked, ${changed}` });
  if (r.column === 'backlog' && r.node.status === 'active' && !r.marks.includes('ended_open')) why.push({ mark: 'no_session', text: `active with no session on it, ${changed}` });
  for (const mark of r.marks) {
    if (!(LEAD_STALE_MARKS as readonly string[]).includes(mark)) continue;
    let text: string;
    if (mark === 'ended_open') text = `its session ended${lastEnded === null ? '' : ` ${spanAgo(lastEnded, now)} ago`} and left it open`;
    else if (mark === 'stale_ask') {
      const old = r.asks.filter((a) => now - Date.parse(a.raisedAt) > ASK_TRAIL_MS);
      // The Board set the mark by the same rule, so the list is never empty; if the rules ever part, the row still says why.
      text = old.map((a) => `${askTag(a.id)} has waited ${spanAgo(a.raisedAt, now)}`).join(', ') || 'an ask has waited over a week';
    } else if (mark === 'answered_in_chat') text = `${askList(r.asks.filter((a) => !r.waiting.includes(a))) || 'an ask'} may be answered already: Aiden has typed in its session since`;
    else if (mark === 'done_focus') text = 'done, but a session still has it claimed';
    else if (mark === 'stalled') text = r.driver === null ? 'sessions are on it but none drives it' : `its session has been idle ${spanAgo(r.driver.lastSeenAt, now)} with nothing waiting on Aiden`;
    else text = 'an answer has not reached a session yet';
    why.push({ mark, text });
  }
  return why;
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
  // An ask on a shelved step (parked, or under a parked one) is not waiting on Aiden, as the need-you count leaves it out.
  const index = buildIndex(snapshot.nodes);
  const shelved = shelvedIds(index);
  const waitingOnAiden = open
    .filter((a) => isAidens(a) && !shelved.has(a.nodeId))
    .map((a) => ({ askId: a.id, kind: a.kind, stepId: a.nodeId, stepTitle: titleOf(a.nodeId), text: a.text, raisedAt: a.raisedAt }));
  const aidenOpenAcrossProjects = listProjectSummaries(ctx)
    .filter((p) => p.status === 'active')
    .reduce((sum, p) => sum + p.openAsks, 0);

  const forTheLead = open
    .filter((a) => a.owner === 'lead')
    .sort((a, b) => (a.dueAt === null ? 1 : 0) - (b.dueAt === null ? 1 : 0) || (a.dueAt ?? '').localeCompare(b.dueAt ?? '') || a.id - b.id)
    .map((a) => ({ askId: a.id, stepId: a.nodeId, stepTitle: titleOf(a.nodeId), text: a.text, dueAt: a.dueAt, overdue: a.dueAt !== null && Date.parse(a.dueAt) < nowMs }));

  // One Board for all of it, so every open row is in the brief: a session's (In flight), Aiden's own, Next up in the
  // Board's order, Stale, or counted in the backlog. A row with a stale mark is under Stale as well as where it sits.
  const board = deriveBoard(snapshot, nowMs);
  const nextUp = board.next.map((r) => ({ stepId: r.node.id, title: r.node.title, status: r.node.status }));
  // A Now row with no session on it is a step Aiden does himself.
  const aidensOwn = board.now.filter((r) => !r.sessions.length).map((r) => ({ stepId: r.node.id, title: r.node.title, updatedAt: r.node.updatedAt }));
  const backlog = board.backlog.filter((r) => r.node.status === 'todo').length;
  const lastEnded = new Map<number, string>();
  for (const p of snapshot.pastSessions) if (p.focusNodeId !== null && p.endedAt > (lastEnded.get(p.focusNodeId) ?? '')) lastEnded.set(p.focusNodeId, p.endedAt);
  const order = dfsOrder(index);
  const stale = [...board.byId.values()]
    .sort((a, b) => (order.get(a.node.id) ?? 0) - (order.get(b.node.id) ?? 0))
    .flatMap((r) => {
      const why = staleReasons(r, nowMs, lastEnded.get(r.node.id) ?? null);
      return why.length ? [{ stepId: r.node.id, title: r.node.title, marks: why.map((w) => w.mark as string), reasons: why.map((w) => w.text) }] : [];
    });

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
    aidensOwn,
    aidenOpenAcrossProjects,
    forTheLead,
    nextUp,
    backlog,
    stale,
    landedSince,
    saidInAidensName: saidSince(ctx, project.id, since),
    links: { ...lastRelay(ctx, project.id), lastSeenAt: project.leadSeenAt },
  };
}

/**
 * How the project's last relay went, read from the lead's log so it survives a restart: `ok` when it was delivered,
 * `unavailable` when it failed or may not have got through, `not checked` with no relay on record. `t3At` is its time.
 */
function lastRelay(ctx: Ctx, projectId: number): Pick<LeadBrief['links'], 't3' | 't3At'> {
  const last = ctx.db
    .prepare("SELECT kind, at FROM lead_events WHERE project_id = ? AND kind IN ('relay', 'relay_unknown', 'relay_failed') ORDER BY at DESC, id DESC LIMIT 1")
    .get(projectId) as { kind: string; at: string } | undefined;
  if (last === undefined) return { t3: 'not checked', t3At: null };
  return { t3: last.kind === 'relay' ? 'ok' : 'unavailable', t3At: last.at };
}

/**
 * The lead has read the brief built at `at`: the next one counts what landed and what was said from here. The look never
 * moves back, so two looks marked out of order keep the later one. Answers the look now on record.
 */
export function markLeadSeen(ctx: Ctx, ref: string, at: Date): string {
  const project = resolveProject(ctx, ref);
  return write(ctx, 'lead', (): string => {
    const iso = at.toISOString();
    ctx.db.prepare('UPDATE projects SET lead_seen_at = ? WHERE id = ? AND (lead_seen_at IS NULL OR lead_seen_at < ?)').run(iso, project.id, iso);
    return ctx.db.prepare('SELECT lead_seen_at FROM projects WHERE id = ?').pluck().get(project.id) as string;
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

// Moved to src/core/lead.ts so the window can use it; re-exported so no server import changes.
export type { LeadEventOut };
