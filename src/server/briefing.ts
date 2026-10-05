import { formatUpNext, queueView } from '../core/layout';
import { NEEDS_YOU_STALE_MS, ancestors, buildIndex, dfsOrder, isNeedsYou, kids, needsYouAge, progress, type TreeIndex } from '../core/tree';
import { NODE_LABELS, glyphTitle, sessionDisplayTitle, sessionTag, type ProjectSnapshot, type Session, type TreeNode, type WorkItem } from '../core/types';
import { homeDir } from '../lib/home';
import { taskCommand } from '../lib/task-command';

const MAX_FRONTIER_LINES = 25;
/** Working tasks listed under the focused step: in progress first, then pending. */
const MAX_TASK_LINES = 5;

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
 * with real-length values (review-actions spec §8). Questions, relabelling and backtracking live in the skill's brief
 * template only. The labels are named as words; their glyphs show on the node lines. The resources folder is spelled
 * out in full from the data dir `home` (forward slashes, as the installed skill has it): the Write tool needs an
 * absolute path. The tasks command is written out in full, built by the same helper as its allow rules so it runs
 * without a permission prompt; the Bash tool's rule matches at once, where PowerShell's check can time out and ask.
 */
export function updateRules(o: UpdateRulesOptions): string[] {
  const resources = `${(o.home ?? homeDir()).replace(/\\/g, '/')}/resources`;
  return [
    'Keeping InProgress current:',
    '- Brief the inprogress-scribe agent (Agent tool, subagent_type "inprogress-scribe", background), at most once per turn, every change batched. Never edit the tree another way, except tasks below.',
    `- Brief when: a request with a deliverable arrives (a new step with one label: ${NODE_LABELS.join(', ')}); the plan or an order changes ("queue: #a, #b" is yours, "later: #c, #d" unowned); a step starts ("focus → #id"), finishes ("#id → done; outcome …") or blocks; something goes to Aiden (assignee me) or he answers.`,
    '- Steps are plan-level with outcomes. Detours go in "log on #id: …".',
    `- Something worth finding again is a resource: "resource on #id: <kind> "<title>", path <file>, snapshot_file". Chat-only content is first written to ${resources}/<slug>/<yyyy-mm-dd>-<kebab-title>.md.`,
    `- Working tasks: TaskCreate/TaskUpdate mirror on their own (start a task's subject with #id when its step is not your focus); else, after each change, run in the Bash tool: \`${taskCommand(o.sessionId, { cli: o.cli })}\` (flags repeat in list order; no flags clears the list; no step id uses your focus). No double quotes in subjects; single-quote one with $ or a backtick. Start an Agent description with its step's #id.`,
    '- After a brief, one line in chat ("↳ InProgress: #57 done"). The scribe\'s notice needs no reply. Brief header: "Session: <id> · Project: <slug>". Full format: the inprogress skill.',
  ];
}

function statusText(n: TreeNode): string {
  if (!isNeedsYou(n)) return n.status;
  return n.status === 'todo' ? 'NEEDS YOU' : `NEEDS YOU (${n.status})`;
}

function lineFor(index: TreeIndex, n: TreeNode, focusOf: Map<number, Session[]>, sessionId?: string): string {
  const prog = progress(index, n.id);
  const here = (focusOf.get(n.id) ?? []).map((s) => (s.id === sessionId ? '◆ this session' : `◆ "${sessionDisplayTitle(s)}"`));
  return `#${n.id} ${glyphTitle(n)}${n.kind === 'question' ? ' (question)' : ''} — ${statusText(n)}${prog ? ` (${prog.done}/${prog.total})` : ''}${here.length ? `  ${here.join(' ')}` : ''}`;
}

/** The open ones of `items`: in progress first, then pending, each in the order given (creation order). */
const inProgressFirst = (items: WorkItem[]): WorkItem[] => [...items.filter((i) => i.status === 'in_progress'), ...items.filter((i) => i.status === 'pending')];

/**
 * The open working tasks of live sessions on a node, in progress first, then pending, each in creation order. An ended
 * session's tasks are trail, never live work: the Left unfinished line names them.
 */
function openTasks(items: WorkItem[], nodeId: number): WorkItem[] {
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
  const targets = snapshot.nodes.filter((n) => n.parentId !== null && (n.status === 'active' || isNeedsYou(n)));
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
    const upcoming = siblingNext ? list.slice(last + 1).filter((k) => k.status === 'todo' && !chain.has(k.id)) : [];
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
 * The planned order (set_queue), this session's own steps first, with titles, then the other sessions' by letter and
 * the unowned ones: `Up next (you, A): #42 ⧉ Build tabs → #44 ¶ Write the guide · B: #45 · later: #47`. Undefined when no
 * step is up next (formatUpNext's guarantee), which is when the frontier keeps its sibling Next: lines.
 */
function upNextLine(snapshot: ProjectSnapshot, sessionId: string): string | undefined {
  const view = queueView(snapshot.project.queue, snapshot.nodes, snapshot.sessions);
  return formatUpNext(view, snapshot.sessions, { sessionId, nodes: snapshot.nodes });
}

/** How many items the Needs you line and the check line each name before "+n more". */
const MAX_NEEDS_YOU = 8;

/** The project's needs-you items, in tree order. */
function needsYouItems(snapshot: ProjectSnapshot): TreeNode[] {
  const order = dfsOrder(buildIndex(snapshot.nodes));
  return snapshot.nodes.filter(isNeedsYou).sort((a, b) => (order.get(a.id) ?? 0) - (order.get(b.id) ?? 0));
}

/** `Needs you (2): #14 Merge PRs (5d) · #45 Pick a price (question)`: each with its age once it is a day old. `now` is the server's clock (ms). */
function needsYouLine(snapshot: ProjectSnapshot, now: number): string | undefined {
  const needs = needsYouItems(snapshot);
  if (!needs.length) return undefined;
  const shown = needs.slice(0, MAX_NEEDS_YOU).map((n) => {
    const age = needsYouAge(n, now);
    return `#${n.id} ${glyphTitle(n)}${n.kind === 'question' ? ' (question)' : ''}${age ? ` (${age})` : ''}`;
  });
  return `Needs you (${needs.length}): ${shown.join(' · ')}${needs.length > MAX_NEEDS_YOU ? ` · +${needs.length - MAX_NEEDS_YOU} more` : ''}`;
}

/**
 * The fresh briefing's ask about old needs-you items: every one last changed more than NEEDS_YOU_STALE_MS ago, from all
 * of them (not only those the Needs you line shows), in its order, up to MAX_NEEDS_YOU, then "+n more". A "not yet" goes
 * in the step's log, which leaves its age counting.
 */
function checkLine(snapshot: ProjectSnapshot, now: number): string | undefined {
  const old = needsYouItems(snapshot).filter((n) => now - Date.parse(n.updatedAt) > NEEDS_YOU_STALE_MS);
  if (!old.length) return undefined;
  const named = old.slice(0, MAX_NEEDS_YOU).map((n) => `#${n.id}`);
  if (old.length > MAX_NEEDS_YOU) named.push(`+${old.length - MAX_NEEDS_YOU} more`);
  return `Check with Aiden whether these are already done, then brief the answer (a "not yet" goes in "log on #id: …"): ${named.join(', ')}.`;
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
 * `Recently done: #87 ¶ Title — "outcome" · #86 Title`: the steps finished last, a tie (addNodes stamps one time per
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
    return `#${n.id} ${glyphTitle(n)}${outcome ? ` — "${outcome}"` : ''}`;
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

/**
 * `Left unfinished by an earlier session: on #86: "Review it", "Write tests" · on #90: "Check the hint"`: the open tasks
 * of ended sessions (their subagents' too) on steps still open, by step in tree order, in progress first within a step,
 * MAX_LEFT_UNFINISHED subjects in all. The snapshot holds only sessions that ended within the 7-day trail. Undefined when
 * there are none.
 */
function leftUnfinishedLine(snapshot: ProjectSnapshot): string | undefined {
  const index = buildIndex(snapshot.nodes);
  const order = dfsOrder(index);
  const stillOpen = (id: number) => {
    const n = index.byId.get(id);
    return n !== undefined && n.status !== 'done' && n.status !== 'dropped';
  };
  const left = snapshot.workItems.filter((i) => i.endedAt !== null && stillOpen(i.nodeId));
  const steps = [...new Set(left.map((i) => i.nodeId))].sort((a, b) => (order.get(a) ?? 0) - (order.get(b) ?? 0));
  const parts: string[] = [];
  let room = MAX_LEFT_UNFINISHED;
  for (const nodeId of steps) {
    const subjects = inProgressFirst(left.filter((i) => i.nodeId === nodeId)).slice(0, room);
    if (!subjects.length) continue;
    parts.push(`on #${nodeId}: ${subjects.map((i) => `"${withoutStepId(i.subject, nodeId)}"`).join(', ')}`);
    room -= subjects.length;
    if (room === 0) break;
  }
  return parts.length ? `Left unfinished by an earlier session: ${parts.join(' · ')}` : undefined;
}

export interface BriefingOptions {
  /** Ask about needs-you items older than NEEDS_YOU_STALE_MS: every fresh briefing does, one after a compaction does not. */
  checkOld: boolean;
}

/** The session's briefing. `now` is the server's clock (ms), which needs-you ages count to. */
export function renderBriefing(snapshot: ProjectSnapshot, sessionId: string, now: number, opts: BriefingOptions): string {
  const { project, resources, sessions } = snapshot;
  // Its letter, as the window shows it on its chip and badge; none while its slot is empty.
  const letter = sessionTag(sessions.find((s) => s.id === sessionId)?.slot ?? null);
  const lines = [
    `[InProgress] This session is tracked in project "${project.name}" (slug ${project.slug}). Session id: ${sessionId}.${letter ? ` You are session ${letter}.` : ''}`,
    // The rules below stand alone (review-actions spec §8); the skill keeps opt-in, adoption and the full template.
    'Plan edits go through the inprogress-scribe agent in the background (working tasks excepted, below). The rules below are complete; the inprogress skill is for opt-in, adoption and the full brief format.',
  ];
  const playbook = project.playbook.trim();
  if (playbook) {
    const pl = playbook.split('\n');
    lines.push('Playbook:', ...pl.slice(0, 15).map((l) => `  ${l}`));
    if (pl.length > 15) lines.push(`  … (${pl.length - 15} more lines)`);
  }
  lines.push(...updateRules({ sessionId }));
  // One answer to "what's next": an Up next line (always at least one step) replaces the sibling Next: lines.
  const upNext = upNextLine(snapshot, sessionId);
  lines.push('Where things stand:', ...frontierLines(snapshot, sessionId, { siblingNext: upNext === undefined }).map((l) => `  ${l}`));
  if (upNext) lines.push(upNext);
  const needs = needsYouLine(snapshot, now);
  if (needs) lines.push(needs);
  const check = opts.checkOld ? checkLine(snapshot, now) : undefined;
  if (check) lines.push(check);
  const recentlyDone = recentlyDoneLine(snapshot);
  if (recentlyDone) lines.push(recentlyDone);
  const leftUnfinished = leftUnfinishedLine(snapshot);
  if (leftUnfinished) lines.push(leftUnfinished);
  const recent = [...resources].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt) || b.id - a.id).slice(0, 5);
  if (recent.length) lines.push(`Recent resources: ${recent.map((r) => `r${r.id} ${r.title} (on #${r.nodeId})`).join(' · ')}`);
  const others = sessions.filter((s) => s.id !== sessionId && s.state !== 'ended');
  if (others.length) {
    const named = (s: Session) => {
      const tag = sessionTag(s.slot);
      return `${tag ? `${tag} ` : ''}"${sessionDisplayTitle(s)}" (${s.state}${s.focusNodeId ? `, on #${s.focusNodeId}` : ''})`;
    };
    lines.push(`Other sessions here: ${others.map(named).join(' · ')}`);
  }
  return lines.join('\n');
}

/** The answer to a status question: the needs-you ages as the briefing has them (`now`, the server's clock), never its check line. */
export function renderStatusAnswer(snapshot: ProjectSnapshot, sessionId: string, now: number): string {
  const upNext = upNextLine(snapshot, sessionId);
  const frontier = frontierLines(snapshot, sessionId, { siblingNext: upNext === undefined });
  const lines = [`[InProgress] Where things stand in ${snapshot.project.name} (live):`, ...frontier.map((l) => `  ${l}`)];
  if (upNext) lines.push(upNext);
  const needs = needsYouLine(snapshot, now);
  if (needs) lines.push(needs);
  return lines.join('\n');
}

export function renderStatusLine(snapshot: ProjectSnapshot, session: Session): string {
  const focus = session.focusNodeId !== null ? snapshot.nodes.find((n) => n.id === session.focusNodeId) : undefined;
  const needs = snapshot.nodes.filter(isNeedsYou).length;
  return `[InProgress] ${snapshot.project.name} · ${focus ? `focus #${focus.id} ${focus.title}` : 'no focus set'} · ${needs} need you · last scribe update ${session.promptsSinceUpdate} prompts ago. If a checkpoint happened, brief the inprogress-scribe; otherwise ignore this line.`;
}

export function untrackedHint(sessionId: string): string {
  return `[InProgress] This session is not tracked yet. Session id: ${sessionId}. Use the inprogress skill to opt in.`;
}
