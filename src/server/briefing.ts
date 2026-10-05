import { ancestors, buildIndex, dfsOrder, isNeedsYou, kids, progress, type TreeIndex } from '../core/tree';
import { LABEL_GLYPHS, NODE_LABELS, glyphTitle, sessionDisplayTitle, sessionTag, type ProjectSnapshot, type Session, type TreeNode, type WorkItem } from '../core/types';
import { homeDir } from '../lib/home';
import { taskCommand } from '../lib/task-command';

const MAX_FRONTIER_LINES = 25;
/** Working tasks listed under the focused step: in progress first, then pending. */
const MAX_TASK_LINES = 5;
const MAX_UP_NEXT = 5;

export interface UpdateRulesOptions {
  /** The data dir (default: the real one). */
  home?: string;
  /** The briefed session, whose id the tasks command carries. */
  sessionId: string;
  /** The CLI the tasks command runs (default: the dist/cli/main.js beside the running server). */
  cli?: string;
}

/**
 * The update rules the briefing carries. The resources folder is spelled out in full from the data dir
 * `home` (forward slashes, as the installed skill has it): the Write tool needs an absolute path. The tasks command
 * is written out in full, built by the same helper as its allow rules so it runs without a permission prompt.
 */
export function updateRules(o: UpdateRulesOptions): string[] {
  const resources = `${(o.home ?? homeDir()).replace(/\\/g, '/')}/resources`;
  return [
    'Keeping InProgress current (the tree beside Claude that Aiden watches):',
    '- Never edit it yourself. Brief the inprogress-scribe agent (Agent tool, subagent_type "inprogress-scribe"); it runs in the background. At most one brief per turn, batching every change.',
    '- Brief at these checkpoints: a new request with a deliverable arrives (it becomes a step right away); a plan is made or changed (backtracking = mark steps dropped or move them); the order of work is decided or changes ("queue: #a, #b, #c"); a step starts, finishes, or is blocked; something worth finding again is produced (test suite, runbook, walkthrough, roadmap, diagram, handoff); something is handed to Aiden (assignee me) or he reports doing it; an open question appears or is answered.',
    '- Steps are plan-level with outcomes, never single actions. Detours go in the log of the step they interrupted.',
    `- Give each new step one type label in its brief: add under #41: "Faster cold start" (task, server). Labels: ${NODE_LABELS.map((l) => `${LABEL_GLYPHS[l]} ${l}`).join(', ')}. Pick by purpose first (fix, refactor, research), else by where the work lands; relabel a step when its purpose changes.`,
    `- Working tasks sit under the steps, and Aiden watches them live. Start an Agent description with its step's #id ("#44 Build project tabs"). For multi-step work use the task tools (TaskCreate, TaskUpdate), and start a task's subject with #id when it belongs to a step other than your focus. Without the task tools, run this after each change; it is the one InProgress write you make yourself: \`${taskCommand(o.sessionId, { cli: o.cli })}\` (the flags repeat, in list order; none clears the list; leave out <step id> to use your focus).`,
    `- Resources: pass a file path with snapshot_file. Content that only exists in chat is first written to ${resources}/<slug>/<yyyy-mm-dd>-<kebab-title>.md.`,
    '- Brief format: "Session: <id> · Project: <slug>", then one "- " line per change, e.g. "#57 → done; outcome ...", "add under #55: \\"Run signing tests\\" (assignee me)", "resource on #58: test-suite \\"Signing suite\\", path ..., snapshot_file", "log on #55: ...", "focus → #58".',
    '- After dispatching, write one line in chat ("↳ InProgress: #57 done, suite attached to #58"). The scribe\'s completion notice needs no reply beyond that line.',
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

/**
 * The open working tasks of live sessions on a node, in progress first, then pending, each in creation order. An ended
 * session's tasks are trail, never live work.
 */
function openTasks(items: WorkItem[], nodeId: number): WorkItem[] {
  const on = items.filter((i) => i.nodeId === nodeId && i.endedAt === null);
  return [...on.filter((i) => i.status === 'in_progress'), ...on.filter((i) => i.status === 'pending')];
}

export function frontierLines(snapshot: ProjectSnapshot, sessionId?: string): string[] {
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
    const upcoming = list.slice(last + 1).filter((k) => k.status === 'todo' && !chain.has(k.id));
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

/** The planned order (set_queue), with titles: `Up next: #42 Build tabs → #44 Write the guide`. */
function upNextLine(snapshot: ProjectSnapshot): string | undefined {
  const byId = new Map(snapshot.nodes.map((n) => [n.id, n]));
  const queued = snapshot.project.queue.map((id) => byId.get(id)).filter((n): n is TreeNode => n !== undefined);
  if (!queued.length) return undefined;
  const shown = queued.slice(0, MAX_UP_NEXT).map((n) => `#${n.id} ${glyphTitle(n)}`);
  return `Up next: ${shown.join(' → ')}${queued.length > MAX_UP_NEXT ? ` (+${queued.length - MAX_UP_NEXT} more)` : ''}`;
}

function needsYouLine(snapshot: ProjectSnapshot): string | undefined {
  const index = buildIndex(snapshot.nodes);
  const order = dfsOrder(index);
  const needs = snapshot.nodes.filter(isNeedsYou).sort((a, b) => (order.get(a.id) ?? 0) - (order.get(b.id) ?? 0));
  if (!needs.length) return undefined;
  const shown = needs.slice(0, 8).map((n) => `#${n.id} ${glyphTitle(n)}${n.kind === 'question' ? ' (question)' : ''}`);
  return `Needs you (${needs.length}): ${shown.join(' · ')}${needs.length > 8 ? ` · +${needs.length - 8} more` : ''}`;
}

export function renderBriefing(snapshot: ProjectSnapshot, sessionId: string): string {
  const { project, resources, sessions } = snapshot;
  // Its letter, as the window shows it on its chip and badge; none while its slot is empty.
  const letter = sessionTag(sessions.find((s) => s.id === sessionId)?.slot ?? null);
  const lines = [
    `[InProgress] This session is tracked in project "${project.name}" (slug ${project.slug}). Session id: ${sessionId}.${letter ? ` You are session ${letter}.` : ''}`,
    'All InProgress edits go through the inprogress-scribe agent in the background; follow the inprogress skill.',
  ];
  const playbook = project.playbook.trim();
  if (playbook) {
    const pl = playbook.split('\n');
    lines.push('Playbook:', ...pl.slice(0, 15).map((l) => `  ${l}`));
    if (pl.length > 15) lines.push(`  … (${pl.length - 15} more lines)`);
  }
  lines.push(...updateRules({ sessionId }));
  lines.push('Where things stand:', ...frontierLines(snapshot, sessionId).map((l) => `  ${l}`));
  const upNext = upNextLine(snapshot);
  if (upNext) lines.push(upNext);
  const needs = needsYouLine(snapshot);
  if (needs) lines.push(needs);
  const recent =[...resources].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt) || b.id - a.id).slice(0, 5);
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

export function renderStatusAnswer(snapshot: ProjectSnapshot, sessionId: string): string {
  const lines = [`[InProgress] Where things stand in ${snapshot.project.name} (live):`, ...frontierLines(snapshot, sessionId).map((l) => `  ${l}`)];
  const upNext = upNextLine(snapshot);
  if (upNext) lines.push(upNext);
  const needs = needsYouLine(snapshot);
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
