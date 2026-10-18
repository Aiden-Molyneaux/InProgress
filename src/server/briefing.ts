import { sessionActivity } from '../core/activity';
import { clipLine, stepRef } from '../core/step-ref';
import { deriveBoard, isLive } from '../core/board';
import { formatUpNext, type QueueView } from '../core/layout';
import { ancestors, buildIndex, dfsOrder, kids, progress, shelvedIds, type TreeIndex } from '../core/tree';
import { ASK_GLYPHS, NODE_LABELS, askTag, glyphTitle, sessionDisplayTitle, type Ask, type ProjectSnapshot, type Session, type TreeNode, type WorkItem } from '../core/types';
import { homeDir } from '../lib/home';
import { claimCommand, taskCommand } from '../lib/task-command';
import { renderOrchestratorBriefing, renderUnclaimedBriefing, renderWorkerBriefing, stepBlock, unclaimedLines } from './briefing-scoped';

const MAX_FRONTIER_LINES = 25;
/** Working tasks listed under the focused step: in progress first, then pending. */
const MAX_TASK_LINES = 5;
const DAY_MS = 24 * 60 * 60 * 1000;
/** How long an open ask waits before a fresh briefing asks the session to check it with Aiden. */
const CHECK_AFTER_MS = 3 * DAY_MS;

/** Which lines of the update rules a session sees (spec 3.4): a scoped worker, an orchestrator, or today's full set. */
export interface RulesMode {
  scoped: boolean;
  orchestrator: boolean;
}

export interface UpdateRulesOptions {
  /** The data dir (default: the real one). */
  home?: string;
  /** The briefed session, whose id the tasks command carries. */
  sessionId: string;
  /** The CLI the tasks command runs (default: the dist/cli/main.js beside the running server). */
  cli?: string;
}

/**
 * The update rules the briefing carries: a header and six bullets, complete on their own, at most 1,600 characters
 * with real-length values (review-actions spec §8). Relabelling and backtracking live in the skill's brief template
 * only. The labels are named as words; their glyphs show on the node lines. The resources folder is spelled out in full
 * from the data dir `home` (forward slashes, as the installed skill has it): the Write tool needs an absolute path. The
 * tasks command is written out in full, built by the same helper as its allow rules so it runs without a permission
 * prompt; the Bash tool's rule matches at once, where PowerShell's check can time out and ask.
 *
 * `mode` trims the checkpoint bullet (spec 3.4): a scoped worker claims its step and leaves ordering to the
 * orchestrator, so it has no "queue:" or "later:" and starts a step with the claim command; the orchestrator keeps
 * "later:" only.
 */
export function updateRules(o: UpdateRulesOptions & { mode?: RulesMode }): string[] {
  const resources = `${(o.home ?? homeDir()).replace(/\\/g, '/')}/resources`;
  const mode = o.mode ?? { scoped: false, orchestrator: false };
  const orderClause = mode.scoped
    ? ''
    : mode.orchestrator
      ? 'the plan or an order changes ("later: #c, #d" is the unowned order); '
      : 'the plan or an order changes ("queue: #a, #b" is yours, "later: #c, #d" unowned); ';
  const startClause = mode.scoped ? `a step starts ("${claimCommand(o.sessionId, { cli: o.cli })}"; add --take-over when you inherit the step)` : 'a step starts ("focus → #id")';
  return [
    'Keeping InProgress current:',
    '- Brief the inprogress-scribe agent (Agent tool, subagent_type "inprogress-scribe", background), at most once per turn, every change batched. Never edit the tree another way, except tasks below.',
    `- Brief when: a request with a deliverable arrives (a new step with one label: ${NODE_LABELS.join(', ')}); ${orderClause}${startClause}, finishes ("#id → done; outcome …") or blocks; Aiden must answer, allow or look at something ("ask on #id: <question|permission|review>, <text>"; "assignee me" only for a step Aiden does himself) or he answers ("a7 answered: <answer>").`,
    '- Steps are plan-level with outcomes. Detours go in "log on #id: …".',
    `- Something worth finding again is a resource: "resource on #id: <kind> "<title>", path <file>, snapshot_file". Chat-only content is first written to ${resources}/<slug>/<yyyy-mm-dd>-<kebab-title>.md.`,
    `- Working tasks: TaskCreate/TaskUpdate mirror on their own (start a task's subject with #id when its step is not your focus); else, after each change, run in the Bash tool: \`${taskCommand(o.sessionId, { cli: o.cli })}\` (flags repeat in list order; no flags clears the list; no step id uses your focus). No double quotes in subjects; single-quote one with $ or a backtick. Start an Agent description with its step's #id.`,
    '- After a brief, one line in chat ("↳ InProgress: #57 Fix export → done"). Name a step to Aiden by id and title, never a bare id. The scribe\'s notice needs no reply. Brief header: "Session: <id> · Project: <slug>". Full format: the inprogress skill.',
  ];
}

/** One step's line: `#42 ⧉ Title · active (2/5)`, then the sessions on it. A step's asks show on the Needs you line. */
export function lineFor(index: TreeIndex, n: TreeNode, focusOf: Map<number, Session[]>, sessionId?: string): string {
  const prog = progress(index, n.id);
  const here = (focusOf.get(n.id) ?? []).map((s) => (s.id === sessionId ? '◆ this session' : `◆ "${sessionDisplayTitle(s)}"`));
  return `#${n.id} ${glyphTitle(n)} · ${n.status}${prog ? ` (${prog.done}/${prog.total})` : ''}${here.length ? `  ${here.join(' ')}` : ''}`;
}

/** The line telling a session its focus is parked, or under a parked step, or undefined when neither. Keyed on the status, never on the reason being set. */
export function parkedFocusLine(snapshot: ProjectSnapshot, session: Session): string | undefined {
  const focus = session.focusNodeId !== null ? snapshot.nodes.find((n) => n.id === session.focusNodeId) : undefined;
  if (!focus) return undefined;
  if (focus.status === 'parked') return `#${focus.id} is parked: ${clipLine(focus.parkedReason, 80)}`;
  // The nearest parked ancestor (ancestors run outermost first).
  const above = ancestors(buildIndex(snapshot.nodes), focus.id).reverse().find((a) => a.status === 'parked');
  return above ? `#${focus.id} is under parked #${above.id}: ${clipLine(above.parkedReason, 80)}` : undefined;
}

/** The open ones of `items`: in progress first, then pending, each in the order given (creation order). */
export const inProgressFirst = (items: WorkItem[]): WorkItem[] => [...items.filter((i) => i.status === 'in_progress'), ...items.filter((i) => i.status === 'pending')];

/**
 * The open working tasks of live sessions on a node, in progress first, then pending, each in creation order. An ended
 * session's tasks are trail, never live work: the Left unfinished line names them.
 */
export function openTasks(items: WorkItem[], nodeId: number): WorkItem[] {
  return inProgressFirst(items.filter((i) => i.nodeId === nodeId && i.endedAt === null));
}

export interface FrontierOptions {
  /**
   * Print the sibling `Next:` lines (default true). The briefing and the status answer pass false when they print an Up
   * next line, so "what's next" has one answer (review-actions ruling 13).
   */
  siblingNext?: boolean;
}

export function frontierLines(snapshot: ProjectSnapshot, sessionId?: string, opts: FrontierOptions = {}): string[] {
  const siblingNext = opts.siblingNext ?? true;
  const index = buildIndex(snapshot.nodes);
  const root = index.root;
  if (!root) return ['(empty project)'];
  const live = snapshot.sessions.filter((s) => s.state !== 'ended');
  const focusId = live.find((s) => s.id === sessionId)?.focusNodeId ?? null;
  const focusOf = new Map<number, Session[]>();
  for (const s of live) if (s.focusNodeId !== null) focusOf.set(s.focusNodeId, [...(focusOf.get(s.focusNodeId) ?? []), s]);
  const chain = new Set<number>();
  // Active steps, and steps with an open ask, which the Needs you line names.
  const asked = new Set(snapshot.asks.filter((a) => a.clearedAt === null).map((a) => a.nodeId));
  // A shelved step (parked, or under a parked one) is set aside: it is no frontier of its own, only its focus shows.
  const shelved = shelvedIds(index);
  const targets = snapshot.nodes.filter((n) => n.parentId !== null && !shelved.has(n.id) && (n.status === 'active' || asked.has(n.id)));
  for (const id of [...targets.map((t) => t.id), ...focusOf.keys()]) {
    if (!index.byId.has(id)) continue;
    chain.add(id);
    for (const a of ancestors(index, id)) chain.add(a.id);
  }
  const lines: string[] = [];
  if (chain.size <= 1) {
    lines.push('Nothing is active yet. Top level:');
    for (const k of kids(index, root.id).slice(0, 10)) lines.push(`  ${lineFor(index, k, focusOf, sessionId)}`);
    return lines;
  }
  const walk = (parent: TreeNode, depth: number) => {
    const list = kids(index, parent.id);
    let last = -1;
    list.forEach((k, i) => {
      if (chain.has(k.id) || k.status === 'done' || k.status === 'active') last = i;
    });
    for (const k of list) {
      if (!chain.has(k.id)) continue;
      lines.push(`${'  '.repeat(depth)}${lineFor(index, k, focusOf, sessionId)}`);
      if (k.id === focusId) {
        for (const t of openTasks(snapshot.workItems, k.id).slice(0, MAX_TASK_LINES)) lines.push(`${'  '.repeat(depth + 1)}${t.status === 'in_progress' ? '◐' : '○'} ${t.subject}`);
      }
      walk(k, depth + 1);
    }
    const upcoming = siblingNext ? list.slice(last + 1).filter((k) => k.status === 'todo' && !chain.has(k.id) && !shelved.has(k.id)) : [];
    if (upcoming.length) {
      lines.push(`${'  '.repeat(depth)}Next: ${upcoming.slice(0, 2).map((k) => `#${k.id} ${glyphTitle(k)}`).join(' · ')}${upcoming.length > 2 ? ` (+${upcoming.length - 2} more)` : ''}`);
    }
  };
  walk(root, 0);
  if (lines.length > MAX_FRONTIER_LINES) {
    const extra = lines.length - MAX_FRONTIER_LINES;
    return [...lines.slice(0, MAX_FRONTIER_LINES), `+${extra} more active items (run: inprogress outline ${snapshot.project.slug})`];
  }
  return lines;
}

/**
 * The planned order, read from the Board's position function so the queue numbers agree with the window: this session's
 * own steps first, with titles, then the other live sessions' by title and the unowned ones. An ended or stale owner's
 * entries are not in Next (spec 1.5 rule 4), and a session's focus is Now, so neither is listed. Undefined when no step
 * is up next (formatUpNext's guarantee), which is when the frontier keeps its sibling Next: lines.
 */
function upNextLine(snapshot: ProjectSnapshot, sessionId: string, now: number): string | undefined {
  const view: QueueView = { bySession: new Map(), unowned: [] };
  // Rows come in rail order: the unowned entries by queue number, then each live owner's by slot.
  for (const row of deriveBoard(snapshot, now).next) {
    if (row.owner) view.bySession.set(row.owner.id, [...(view.bySession.get(row.owner.id) ?? []), row.node.id]);
    else view.unowned.push(row.node.id);
  }
  return formatUpNext(view, snapshot.sessions, { sessionId, nodes: snapshot.nodes });
}

/** How many items the Needs you line and the check line each name before "+n more". */
const MAX_NEEDS_YOU = 8;

/** The project's open asks, oldest first. */
function openAsks(snapshot: ProjectSnapshot): Ask[] {
  // An ask on a shelved step stays stored, and comes back on unpark.
  const shelved = shelvedIds(buildIndex(snapshot.nodes));
  return snapshot.asks.filter((a) => a.clearedAt === null && !shelved.has(a.nodeId)).sort((a, b) => a.raisedAt.localeCompare(b.raisedAt) || a.id - b.id);
}

/** How long ago, whole days from one day old, then whole weeks from two weeks ("1d" … "13d", "2w"); null under 24 hours or for a time it cannot read. */
export function askAge(raisedAt: string, now: number): string | null {
  const age = now - Date.parse(raisedAt);
  // A NaN age fails this too.
  if (!(age >= DAY_MS)) return null;
  const days = Math.floor(age / DAY_MS);
  return days < 14 ? `${days}d` : `${Math.floor(days / 7)}w`;
}

/** Shorter spans too: "2m", "3h", "4d"; "<1m" under a minute. */
export function spanAgo(iso: string, now: number): string {
  const age = now - Date.parse(iso);
  if (!(age >= 60_000)) return '<1m';
  if (age < 60 * 60_000) return `${Math.floor(age / 60_000)}m`;
  if (age < DAY_MS) return `${Math.floor(age / (60 * 60_000))}h`;
  return `${Math.floor(age / DAY_MS)}d`;
}

/** `a7 ? on #42 Pick a port: "Which port?" (3d)`: an open ask as the Needs you line names it, with its age once it is a day old. */
export function askItem(a: Ask, now: number, stepTitle?: string): string {
  const age = askAge(a.raisedAt, now);
  return `${askTag(a.id)} ${ASK_GLYPHS[a.kind]} on ${stepRef(a.nodeId, stepTitle, NAMED_STEP_MAX)}: "${clipLine(a.text, 60)}"${age ? ` (${age})` : ''}`;
}

/** A step's title where a briefing line only names it: shorter than the digest's, since a briefing reaches every prompt. */
const NAMED_STEP_MAX = 40;
/** A session's title where a line names it, as formatUpNext clips it: one line, at most 30 characters. */
const TITLE_MAX = 30;
const titleOf = (snapshot: ProjectSnapshot, id: number): string | undefined => snapshot.nodes.find((n) => n.id === id)?.title;

/**
 * `Needs you (2): a7 ? on #42 Pick a port: "Which port?" (3d) · "Docs pass" waiting for permission on #45 Run the tests (2m)`: open asks oldest first, then
 * live permission waits (spec 1.4). `now` is the server's clock (ms).
 */
export function needsYouLine(snapshot: ProjectSnapshot, now: number): string | undefined {
  const items = openAsks(snapshot).map((a) => askItem(a, now, titleOf(snapshot, a.nodeId)));
  for (const s of snapshot.sessions) {
    if (s.state !== 'permission' || !isLive(s, now)) continue;
    items.push(`"${clipLine(sessionDisplayTitle(s), TITLE_MAX)}" waiting for permission${s.focusNodeId !== null ? ` on ${stepRef(s.focusNodeId, titleOf(snapshot, s.focusNodeId), NAMED_STEP_MAX)}` : ''} (${spanAgo(s.lastSeenAt, now)})`);
  }
  if (!items.length) return undefined;
  return `Needs you (${items.length}): ${items.slice(0, MAX_NEEDS_YOU).join(' · ')}${items.length > MAX_NEEDS_YOU ? ` · +${items.length - MAX_NEEDS_YOU} more` : ''}`;
}

/**
 * The fresh briefing's ask about old open asks: every one raised more than CHECK_AFTER_MS ago, from all of them (not only
 * those the Needs you line shows), oldest first, up to MAX_NEEDS_YOU, then "+n more". A "not yet" goes in the step's
 * log, which leaves the ask open.
 */
function checkLine(snapshot: ProjectSnapshot, now: number): string | undefined {
  const old = openAsks(snapshot).filter((a) => now - Date.parse(a.raisedAt) > CHECK_AFTER_MS);
  if (!old.length) return undefined;
  const named = old.slice(0, MAX_NEEDS_YOU).map((a) => askTag(a.id));
  if (old.length > MAX_NEEDS_YOU) named.push(`+${old.length - MAX_NEEDS_YOU} more`);
  return `Check with Aiden whether these asks are already answered, then brief the answer ("a7 answered: <answer>"; a "not yet" goes in "log on #id: …"): ${named.join(', ')}.`;
}

/** How many finished steps the Recently done line names. */
const RECENTLY_DONE = 2;
/** How long an outcome may run on the Recently done line, its "…" included. */
const OUTCOME_MAX = 80;
/** How many task subjects the Left unfinished line names, in all. */
const MAX_LEFT_UNFINISHED = 3;

/** An outcome on one line, at most OUTCOME_MAX characters (`.length` units): a longer one is cut to one less, plus "…". */
function clipOutcome(outcome: string): string {
  const line = outcome.replace(/\s+/g, ' ').trim();
  return line.length > OUTCOME_MAX ? `${line.slice(0, OUTCOME_MAX - 1)}…` : line;
}

/**
 * `Recently done: #87 ¶ Title: "outcome" · #86 Title`: the steps finished last, a tie (addNodes stamps one time per
 * call) to the newer id, each with its outcome clipped, or bare without one. Only `done` sets completedAt, so a dropped
 * step never shows. Undefined when nothing is done.
 */
function recentlyDoneLine(snapshot: ProjectSnapshot): string | undefined {
  const done = snapshot.nodes
    .filter((n): n is TreeNode & { completedAt: string } => n.parentId !== null && n.status === 'done' && n.completedAt !== null)
    .sort((a, b) => b.completedAt.localeCompare(a.completedAt) || b.id - a.id)
    .slice(0, RECENTLY_DONE);
  if (!done.length) return undefined;
  const named = done.map((n) => {
    const outcome = clipOutcome(n.outcome);
    return `#${n.id} ${glyphTitle(n)}${outcome ? `: "${outcome}"` : ''}`;
  });
  return `Recently done: ${named.join(' · ')}`;
}

/**
 * A subject without the leading `#id` of the step it is listed under (`#86 Review it` under #86 reads `Review it`), as
 * leadingNode reads one, so the line names the step once. Another step's `#id`, or a subject that is only the `#id`, stays.
 */
function withoutStepId(subject: string, nodeId: number): string {
  return subject.replace(new RegExp(`^\\s*#${nodeId}\\b[\\s:]*`), '') || subject;
}

/** The open tasks of ended sessions on steps still open, by step in tree order, in progress first within a step. */
function leftUnfinished(snapshot: ProjectSnapshot, only?: number): { nodeId: number; items: WorkItem[] }[] {
  const index = buildIndex(snapshot.nodes);
  const order = dfsOrder(index);
  const shelved = shelvedIds(index);
  const stillOpen = (id: number) => {
    const n = index.byId.get(id);
    return n !== undefined && n.status !== 'done' && n.status !== 'dropped' && !shelved.has(id);
  };
  const left = snapshot.workItems.filter((i) => i.endedAt !== null && stillOpen(i.nodeId) && (only === undefined || i.nodeId === only));
  const steps = [...new Set(left.map((i) => i.nodeId))].sort((a, b) => (order.get(a) ?? 0) - (order.get(b) ?? 0));
  return steps.map((nodeId) => ({ nodeId, items: inProgressFirst(left.filter((i) => i.nodeId === nodeId)) }));
}

/**
 * `Left unfinished by an earlier session: on #86 Ship the export: "Review it", "Write tests" · on #90 Hints: "Check the hint"`: the open tasks
 * of ended sessions (their subagents' too) on steps still open, by step in tree order, in progress first within a step,
 * MAX_LEFT_UNFINISHED subjects in all. The snapshot holds only sessions that ended within the 7-day trail. Undefined when
 * there are none.
 */
function leftUnfinishedLine(snapshot: ProjectSnapshot): string | undefined {
  const parts: string[] = [];
  let room = MAX_LEFT_UNFINISHED;
  for (const { nodeId, items } of leftUnfinished(snapshot)) {
    const subjects = items.slice(0, room);
    if (!subjects.length) continue;
    parts.push(`on ${stepRef(nodeId, titleOf(snapshot, nodeId), NAMED_STEP_MAX)}: ${subjects.map((i) => `"${withoutStepId(i.subject, nodeId)}"`).join(', ')}`);
    room -= subjects.length;
    if (room === 0) break;
  }
  return parts.length ? `Left unfinished by an earlier session: ${parts.join(' · ')}` : undefined;
}

/** `Left unfinished on #42 by an earlier session: "a", "b"`: leftUnfinishedLine for one step. Undefined when there are none. */
export function leftUnfinishedOn(snapshot: ProjectSnapshot, nodeId: number): string | undefined {
  const items = leftUnfinished(snapshot, nodeId).flatMap((s) => s.items).slice(0, MAX_LEFT_UNFINISHED);
  return items.length ? `Left unfinished on #${nodeId} by an earlier session: ${items.map((i) => `"${withoutStepId(i.subject, nodeId)}"`).join(', ')}` : undefined;
}

/** `Other sessions here: "title" (working, on #42 Pick a port) · ...`, or undefined when no other session is live. */
export function othersLine(snapshot: ProjectSnapshot, sessionId: string, now: number): string | undefined {
  const others = snapshot.sessions.filter((s) => s.id !== sessionId && s.state !== 'ended');
  if (!others.length) return undefined;
  const named = (s: Session) => {
    return `"${clipLine(sessionDisplayTitle(s), TITLE_MAX)}" (${sessionActivity(s, now)}${s.focusNodeId ? `, on ${stepRef(s.focusNodeId, titleOf(snapshot, s.focusNodeId), NAMED_STEP_MAX)}` : ''})`;
  };
  return `Other sessions here: ${others.map(named).join(' · ')}`;
}

export interface BriefingOptions {
  /** Ask about open asks older than three days: every fresh briefing does, one after a compaction does not. */
  checkOld: boolean;
  /** An orchestrator's counts line (S1 formatCounts); the caller reads the digest only for that role. */
  counts?: string;
  /** The CLI the commands in the rules run (default: the one beside the running server); tests pass one. */
  cli?: string;
}

export const PLAN_EDIT_LINE =
  'Plan edits go through the inprogress-scribe agent in the background (working tasks excepted, below). The rules below are complete; the inprogress skill is for opt-in, adoption and the full brief format.';

/** `[InProgress] This session is tracked in project "X" (slug x). Session id: ID.` */
export function headerLine(snapshot: ProjectSnapshot, sessionId: string): string {
  const { project } = snapshot;
  return `[InProgress] This session is tracked in project "${project.name}" (slug ${project.slug}). Session id: ${sessionId}.`;
}

/** The playbook block: up to 15 lines under `Playbook:`, or nothing for an empty one. */
export function playbookLines(snapshot: ProjectSnapshot): string[] {
  const playbook = snapshot.project.playbook.trim();
  if (!playbook) return [];
  const pl = playbook.split('\n');
  return ['Playbook:', ...pl.slice(0, 15).map((l) => `  ${l}`), ...(pl.length > 15 ? [`  … (${pl.length - 15} more lines)`] : [])];
}

/** Today's briefing from `Where things stand` to `Other sessions here`: what an orchestrator gets after its rules. */
export function bodyLines(snapshot: ProjectSnapshot, sessionId: string, now: number, opts: BriefingOptions): string[] {
  const lines: string[] = [];
  // One answer to "what's next": an Up next line (always at least one step) replaces the sibling Next: lines.
  const upNext = upNextLine(snapshot, sessionId, now);
  lines.push('Where things stand:', ...frontierLines(snapshot, sessionId, { siblingNext: upNext === undefined }).map((l) => `  ${l}`));
  if (upNext) lines.push(upNext);
  const me = snapshot.sessions.find((x) => x.id === sessionId);
  const parkedFocus = me ? parkedFocusLine(snapshot, me) : undefined;
  if (parkedFocus) lines.push(parkedFocus);
  const needs = needsYouLine(snapshot, now);
  if (needs) lines.push(needs);
  const check = opts.checkOld ? checkLine(snapshot, now) : undefined;
  if (check) lines.push(check);
  const recentlyDone = recentlyDoneLine(snapshot);
  if (recentlyDone) lines.push(recentlyDone);
  const leftUnfinished = leftUnfinishedLine(snapshot);
  if (leftUnfinished) lines.push(leftUnfinished);
  const recent = [...snapshot.resources].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt) || b.id - a.id).slice(0, 5);
  if (recent.length) lines.push(`Recent resources: ${recent.map((r) => `r${r.id} ${r.title} (on ${stepRef(r.nodeId, titleOf(snapshot, r.nodeId), NAMED_STEP_MAX)})`).join(' · ')}`);
  const others = othersLine(snapshot, sessionId, now);
  if (others) lines.push(others);
  return lines;
}

/** A scoped project's claimed step, as a worker's briefing needs it: the session's focus when it is a step of this project and not dropped. */
function claimedStep(snapshot: ProjectSnapshot, session: Session): TreeNode | undefined {
  const focus = session.focusNodeId !== null ? snapshot.nodes.find((n) => n.id === session.focusNodeId) : undefined;
  return focus && focus.parentId !== null && focus.status !== 'dropped' ? focus : undefined;
}

/**
 * The session's briefing, chosen by role then by the project's briefing mode (spec 3.4). An orchestrator gets its own in
 * either mode; a worker in a `scoped` project gets its step or the unclaimed view; everything else gets today's full
 * briefing. `now` is the server's clock (ms), which ask ages count to.
 */
export function renderBriefing(snapshot: ProjectSnapshot, sessionId: string, now: number, opts: BriefingOptions): string {
  const session = snapshot.sessions.find((s) => s.id === sessionId);
  if (session?.role === 'orchestrator') return renderOrchestratorBriefing(snapshot, session, now, opts.counts ?? '', opts);
  if (snapshot.project.briefingMode === 'scoped' && session) {
    return claimedStep(snapshot, session) ? renderWorkerBriefing(snapshot, session, now, opts.cli) : renderUnclaimedBriefing(snapshot, session, now, opts.cli);
  }
  return [
    headerLine(snapshot, sessionId),
    // The rules below stand alone (review-actions spec §8); the skill keeps opt-in, adoption and the full template.
    PLAN_EDIT_LINE,
    ...playbookLines(snapshot),
    ...updateRules({ sessionId, cli: opts.cli }),
    ...bodyLines(snapshot, sessionId, now, opts),
  ].join('\n');
}

/** The answer to a status question: the ask ages as the briefing has them (`now`, the server's clock), never its check line. */
export function renderStatusAnswer(snapshot: ProjectSnapshot, sessionId: string, now: number): string {
  const session = snapshot.sessions.find((s) => s.id === sessionId);
  if (session && session.role !== 'orchestrator' && snapshot.project.briefingMode === 'scoped') {
    const step = claimedStep(snapshot, session);
    return (step ? stepBlock(snapshot, step.id, session, now) : unclaimedLines(snapshot, session, now)).join('\n');
  }
  const upNext = upNextLine(snapshot, sessionId, now);
  const frontier = frontierLines(snapshot, sessionId, { siblingNext: upNext === undefined });
  const lines = [`[InProgress] Where things stand in ${snapshot.project.name} (live):`, ...frontier.map((l) => `  ${l}`)];
  if (upNext) lines.push(upNext);
  const needs = needsYouLine(snapshot, now);
  if (needs) lines.push(needs);
  return lines.join('\n');
}

const NUDGE = 'If a checkpoint happened, brief the inprogress-scribe; otherwise ignore this line.';

export function renderStatusLine(snapshot: ProjectSnapshot, session: Session): string {
  const focus = session.focusNodeId !== null ? snapshot.nodes.find((n) => n.id === session.focusNodeId) : undefined;
  const open = openAsks(snapshot);
  if (session.role !== 'orchestrator' && snapshot.project.briefingMode === 'scoped') {
    const step = claimedStep(snapshot, session);
    const mine = step ? open.filter((a) => a.nodeId === step.id) : [];
    const where = step ? `on #${step.id}${mine.length ? ` (${mine.map((a) => askTag(a.id)).join(', ')} open)` : ''}` : 'no step claimed';
    return `[InProgress] ${snapshot.project.name} · ${where} · last scribe update ${session.promptsSinceUpdate} prompts ago. ${NUDGE}`;
  }
  return `[InProgress] ${snapshot.project.name} · ${focus ? `focus #${focus.id} ${focus.title}` : 'no focus set'} · ${open.length} need you · last scribe update ${session.promptsSinceUpdate} prompts ago. ${NUDGE}`;
}

export function untrackedHint(sessionId: string): string {
  return `[InProgress] This session is not tracked yet. Session id: ${sessionId}. Use the inprogress skill to opt in.`;
}
