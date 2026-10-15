import { deriveBoard, type Mark } from '../core/board';
import { stepRef } from '../core/step-ref';
import { ASK_GLYPHS, STALE_SESSION_MS, TRAIL_MS, askTag, sessionTag, type Ask, type ProjectSnapshot } from '../core/types';
import type { Ctx } from './db/tx';
import { listAsksClearedSince, listAsksRaisedSince } from './repo/asks';
import { resolveProject } from './repo/projects';
import { getProjectSnapshot } from './repo/snapshot';

const DAY_MS = 24 * 60 * 60 * 1000;
/** Spec 1.7: with no state note and no --since, the digest looks back this far. */
export const DEFAULT_LOOKBACK_MS = 7 * DAY_MS;
/** Item lines the formatted digest prints in all, before "+n more" (spec 4). */
export const MAX_DIGEST_LINES = 20;
/** A section with more items than this prints one line per item. */
const COMPACT_MAX = 3;
/** A run this long of session ends in one minute prints as one swept line. */
const SWEPT_RUN = 3;
const TEXT_MAX = 80;

export interface DigestSession {
  id: string;
  letter: string;
  title: string;
  startedAt: string;
  /** MIN(ended_at, last_seen_at) for an ended session, else null. */
  endedAt: string | null;
  /** The sweep's time (raw ended_at) when the stale-session sweep ended it: ended_at is 12 hours or more after last_seen_at. */
  sweptAt: string | null;
  focusNodeId: number | null;
  handoff: boolean;
  openTasks: number;
}

export interface Digest {
  project: { slug: string; name: string };
  /** The window start: --since, else the state note's updatedAt, else 7 days ago. */
  since: string;
  sinceSource: 'given' | 'state_note' | 'default';
  done: { id: number; title: string; outcome: string; completedAt: string }[];
  asksRaised: Ask[];
  asksCleared: Ask[];
  /** Sessions started, or ended (by MIN(ended_at, last_seen_at)), in the window; ended ones within the 7-day trail only. */
  sessions: DigestSession[];
  /** Steps created by actor 'window' in the window. */
  quickAdds: { id: number; title: string; createdAt: string }[];
  /** project.updated events by actor 'window' with data.op, in the window. */
  moves: { ts: string; op: 'move' | 'remove'; nodeId: number }[];
  /** Resources created in the window. */
  documents: { id: number; title: string; nodeId: number; purpose: string | null; createdAt: string }[];
  /** deriveBoard(...).marked, as id, title and marks. */
  marked: { id: number; title: string; marks: Mark[] }[];
  /** The title of each step the asks, moves and documents name, so the text never shows a bare id. */
  stepTitles: Record<number, string>;
}

interface EventRowLite {
  ts: string;
  type: string;
  data: string;
}

function parseData(text: string): Record<string, unknown> {
  try {
    const v: unknown = JSON.parse(text);
    return typeof v === 'object' && v !== null ? (v as Record<string, unknown>) : {};
  } catch {
    // An event row whose data is not JSON is not one of ours; it reads as carrying nothing.
    return {};
  }
}

/** The digest of one project since a time. Reads tables, and events only for the window's own moves and quick-adds (spec 1.7). Never call inside a write(): the snapshot read may expire stale sessions. */
export function readDigest(ctx: Ctx, ref: string | number, since?: string): Digest {
  const project = resolveProject(ctx, ref);
  const snapshot: ProjectSnapshot = getProjectSnapshot(ctx, project.id);
  const nowMs = Date.parse(ctx.now());
  let from: string;
  let sinceSource: Digest['sinceSource'];
  if (since !== undefined) {
    from = new Date(Date.parse(since)).toISOString();
    sinceSource = 'given';
  } else if (snapshot.stateNote) {
    from = snapshot.stateNote.updatedAt;
    sinceSource = 'state_note';
  } else {
    from = new Date(nowMs - DEFAULT_LOOKBACK_MS).toISOString();
    sinceSource = 'default';
  }
  const trailCutoff = new Date(nowMs - TRAIL_MS).toISOString();

  const done = snapshot.nodes
    .filter((n): n is typeof n & { completedAt: string } => n.parentId !== null && n.status === 'done' && n.completedAt !== null && n.completedAt >= from)
    .sort((a, b) => a.completedAt.localeCompare(b.completedAt) || a.id - b.id)
    .map((n) => ({ id: n.id, title: n.title, outcome: n.outcome, completedAt: n.completedAt }));

  const handoffSessions = new Set(snapshot.resources.filter((r) => r.purpose === 'handoff' && r.sessionId !== null).map((r) => r.sessionId as string));
  const rows = ctx.db
    .prepare(
      `SELECT id, title, slot, started_at, state, focus_node_id,
              CASE WHEN state = 'ended' THEN MIN(ended_at, last_seen_at) END AS end_at, ended_at AS raw_end, last_seen_at AS seen_at,
              (SELECT COUNT(*) FROM work_items w WHERE w.session_id = sessions.id AND w.status IN ('pending', 'in_progress')) AS open_tasks
         FROM sessions
        WHERE project_id = :project
          AND (started_at >= :since OR (state = 'ended' AND MIN(ended_at, last_seen_at) >= MAX(:since, :trail)))
        ORDER BY started_at, id`,
    )
    .all({ project: project.id, since: from, trail: trailCutoff }) as {
    id: string;
    title: string | null;
    slot: number | null;
    started_at: string;
    state: string;
    focus_node_id: number | null;
    end_at: string | null;
    raw_end: string | null;
    seen_at: string;
    open_tasks: number;
  }[];
  const sessions: DigestSession[] = rows.map((r) => ({
    id: r.id,
    letter: sessionTag(r.slot) || '?',
    title: r.title?.trim() || `Session ${r.id.slice(0, 6)}`,
    startedAt: r.started_at,
    endedAt: r.end_at,
    sweptAt: r.state === 'ended' && r.raw_end !== null && Date.parse(r.raw_end) - Date.parse(r.seen_at) >= STALE_SESSION_MS ? r.raw_end : null,
    focusNodeId: r.focus_node_id,
    handoff: handoffSessions.has(r.id),
    openTasks: r.open_tasks,
  }));

  const events = ctx.db
    .prepare("SELECT ts, type, data FROM events WHERE project_id = ? AND actor = 'window' AND ts >= ? AND type IN ('node.created', 'project.updated') ORDER BY id")
    .all(project.id, from) as EventRowLite[];
  const byId = new Map(snapshot.nodes.map((n) => [n.id, n]));
  const quickAdds: Digest['quickAdds'] = [];
  const moves: Digest['moves'] = [];
  for (const e of events) {
    const data = parseData(e.data);
    if (e.type === 'node.created') {
      const ids = Array.isArray(data.ids) ? data.ids.filter((x): x is number => typeof x === 'number') : [];
      for (const id of ids) {
        const n = byId.get(id);
        if (n) quickAdds.push({ id: n.id, title: n.title, createdAt: e.ts });
      }
    } else if (data.op === 'move' || data.op === 'remove') {
      const nodeId = typeof data.node === 'number' ? data.node : typeof data.nodeId === 'number' ? data.nodeId : null;
      if (nodeId !== null) moves.push({ ts: e.ts, op: data.op, nodeId });
    }
  }

  const documents = snapshot.resources
    .filter((r) => r.createdAt >= from)
    .map((r) => ({ id: r.id, title: r.title, nodeId: r.nodeId, purpose: r.purpose, createdAt: r.createdAt }));

  const asksRaised = listAsksRaisedSince(ctx, project.id, from);
  const asksCleared = listAsksClearedSince(ctx, project.id, from);
  const stepTitles: Digest['stepTitles'] = {};
  for (const id of [...asksRaised, ...asksCleared, ...moves, ...documents].map((x) => x.nodeId)) {
    const n = byId.get(id);
    if (n) stepTitles[id] = n.title;
  }

  const board = deriveBoard(snapshot, nowMs);
  return {
    project: { slug: project.slug, name: project.name },
    since: from,
    sinceSource,
    done,
    asksRaised,
    asksCleared,
    sessions,
    quickAdds,
    moves,
    documents,
    marked: board.marked.map((r) => ({ id: r.node.id, title: r.node.title, marks: r.marks })),
    stepTitles,
  };
}

/** `3h`, `2d`, `5m`: how long before `now` the time was; `0m` for one not in the past or unreadable. */
function ago(iso: string, now: number): string {
  const age = now - Date.parse(iso);
  if (!(age >= 60_000)) return '0m';
  if (age < 60 * 60_000) return `${Math.floor(age / 60_000)}m`;
  if (age < DAY_MS) return `${Math.floor(age / (60 * 60_000))}h`;
  return `${Math.floor(age / DAY_MS)}d`;
}

const pad = (n: number): string => String(n).padStart(2, '0');
/** Local `2026-10-10 12:15`. */
export function stamp(iso: string): string {
  const d = new Date(iso);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}
/** Local `12:52`. */
const clock = (iso: string): string => {
  const d = new Date(iso);
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
};

const clip = (text: string, max = TEXT_MAX): string => {
  const line = text.replace(/\s+/g, ' ').trim();
  return line.length > max ? `${line.slice(0, max - 1)}…` : line;
};
const plural = (n: number, one: string, many: string): string => `${n} ${n === 1 ? one : many}`;

/** Sessions that ended without a handoff. */
const endedBare = (d: Digest): number => d.sessions.filter((s) => s.endedAt !== null && !s.handoff).length;

/** The one-line counts offer of spec 4 step 1. Parts with zero leave out their clause. */
export function formatCounts(d: Digest, now: number): string {
  const parts: string[] = [];
  if (d.done.length) parts.push(`${d.done.length} done`);
  const answered = d.asksCleared.filter((a) => a.answer !== '').length;
  if (d.asksRaised.length || answered) {
    const clauses = [];
    if (d.asksRaised.length) clauses.push(`${plural(d.asksRaised.length, 'ask', 'asks')} raised`);
    if (answered) clauses.push(d.asksRaised.length ? `${answered} answered` : `${plural(answered, 'ask', 'asks')} answered`);
    parts.push(clauses.join(', '));
  }
  const ended = d.sessions.filter((s) => s.endedAt !== null).length;
  if (ended) {
    const bare = endedBare(d);
    parts.push(`${plural(ended, 'session', 'sessions')} ended${bare ? `, ${bare} without a handoff` : ''}`);
  }
  const marks = d.marked.length ? ` Marks: ${plural(d.marked.length, 'step', 'steps')}.` : '';
  return `Since your last look (${ago(d.since, now)}): ${parts.length ? parts.join(' · ') : 'nothing new'}.${marks}`;
}

interface Section {
  title: string;
  items: string[];
  /** The separator between items on the compact, single-line form. */
  joiner?: string;
}

function sessionItems(d: Digest, now: number): string[] {
  // The sweep ends stale sessions together: ended_at is the sweep's time, 12 hours or more after they were last heard from.
  // A run of SWEPT_RUN or more swept sessions in one minute is one line; ordinary ends in one minute stay separate.
  const minuteOf = (s: DigestSession) => (s.sweptAt === null ? null : s.sweptAt.slice(0, 16));
  const runs = new Map<string, DigestSession[]>();
  for (const s of d.sessions) {
    const key = minuteOf(s);
    if (key !== null) runs.set(key, [...(runs.get(key) ?? []), s]);
  }
  const swept = new Set([...runs.values()].filter((r) => r.length >= SWEPT_RUN).flat().map((s) => s.id));
  const items: string[] = [];
  const announced = new Set<string>();
  for (const s of d.sessions) {
    if (swept.has(s.id)) {
      const key = minuteOf(s)!;
      if (announced.has(key)) continue;
      announced.add(key);
      items.push(`${runs.get(key)!.length} sessions swept as ended at ${clock(s.sweptAt!)}`);
      continue;
    }
    const notes = [
      s.endedAt !== null ? `ended ${ago(s.endedAt, now)} ago` : `started ${ago(s.startedAt, now)} ago`,
      ...(s.endedAt !== null && !s.handoff ? ['no handoff'] : []),
      ...(s.openTasks ? [plural(s.openTasks, 'open task', 'open tasks')] : []),
    ];
    items.push(`${s.letter} ${s.id.slice(0, 8)} "${clip(s.title, 40)}" ${notes.join(', ')}`);
  }
  return items;
}

function sections(d: Digest, now: number): Section[] {
  const letterOf = new Map(d.sessions.map((s) => [s.id, s.letter]));
  const step = (id: number): string => stepRef(id, d.stepTitles[id]);
  return [
    {
      title: 'Done',
      items: d.done.map((n) => `#${n.id} ${clip(n.title, 60)}${n.outcome.trim() ? `: "${clip(n.outcome)}"` : ''}`),
    },
    {
      title: 'Asks raised',
      items: d.asksRaised.map((a) => {
        const who = a.sessionId ? letterOf.get(a.sessionId) : undefined;
        return `${askTag(a.id)} ${ASK_GLYPHS[a.kind]} on ${step(a.nodeId)}: "${clip(a.text)}" (${who ? `${who}, ` : ''}${ago(a.raisedAt, now)})`;
      }),
    },
    {
      title: 'Asks cleared',
      items: d.asksCleared.map((a) => {
        const by = (a.clearedBy ?? 'unknown').replace(/^(scribe|session):.*$/, '$1');
        return `${askTag(a.id)} on ${step(a.nodeId)}: ${a.answer ? `"${clip(a.answer)}"` : 'no answer'} (${by})`;
      }),
    },
    { title: 'Sessions', items: sessionItems(d, now) },
    { title: 'Quick-added', items: d.quickAdds.map((n) => `#${n.id} ${clip(n.title, 60)}`) },
    { title: 'Moved in Next', items: d.moves.map((m) => `${step(m.nodeId)} ${m.op === 'move' ? 'moved' : 'removed'}`) },
    {
      title: 'New documents',
      items: d.documents.map((r) => `r${r.id} "${clip(r.title, 60)}" on ${step(r.nodeId)}${r.purpose ? ` (${r.purpose})` : ''}`),
    },
    { title: 'Marks', items: d.marked.map((m) => `${stepRef(m.id, m.title)}: ${m.marks.join(', ')}`) },
  ];
}

/**
 * The digest as text: a header, then each non-empty section. A section of three items or fewer is one line joined by
 * " · "; a longer one has a line per item, indented two spaces. At most MAX_DIGEST_LINES items in all, then
 * `+n more (inprogress digest <slug> --since <iso> --all)`; `all` lifts the cap. Nothing at all prints `Nothing since <time>.`
 */
export function formatDigest(d: Digest, now: number, o: { all?: boolean } = {}): string {
  const sourceText = { given: 'given', state_note: 'state note', default: 'last 7 days' }[d.sinceSource];
  const all = sections(d, now).filter((s) => s.items.length);
  if (!all.length) return `Nothing since ${stamp(d.since)}.`;
  const lines = [`Digest for ${d.project.name} since ${stamp(d.since)} (${sourceText}):`];
  let room = o.all ? Infinity : MAX_DIGEST_LINES;
  let omitted = 0;
  for (const s of all) {
    const shown = s.items.slice(0, Math.max(0, room));
    room -= shown.length;
    omitted += s.items.length - shown.length;
    if (!shown.length) continue;
    const head = `${s.title} (${s.items.length}):`;
    if (s.items.length <= COMPACT_MAX) lines.push(`${head} ${shown.join(s.joiner ?? ' · ')}`);
    else lines.push(head, ...shown.map((i) => `  ${i}`));
  }
  if (omitted) lines.push(`+${omitted} more (inprogress digest ${d.project.slug} --since ${d.since} --all)`);
  return lines.join('\n');
}
