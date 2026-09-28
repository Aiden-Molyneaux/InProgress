import { ancestors, buildIndex, dfsOrder, isNeedsYou, kids, progress, type TreeIndex } from '../core/tree';
import { sessionDisplayTitle, type ProjectSnapshot, type Session, type TreeNode } from '../core/types';

const MAX_FRONTIER_LINES = 25;

export const UPDATE_RULES = [
  'Keeping InProgress current (the tree beside Claude that Aiden watches):',
  '- Never edit it yourself. Brief the inprogress-scribe agent (Agent tool, subagent_type "inprogress-scribe"); it runs in the background. At most one brief per turn, batching every change.',
  '- Brief at these checkpoints: a plan is made or changed (backtracking = mark steps dropped or move them); a step starts, finishes, or is blocked; something worth finding again is produced (test suite, runbook, walkthrough, roadmap, diagram, handoff); something is handed to Aiden (assignee me) or he reports doing it; an open question appears or is answered.',
  '- Steps are plan-level with outcomes, never single actions. Detours go in the log of the step they interrupted.',
  '- Resources: pass a file path with snapshot_file. Content that only exists in chat is first written to ~/.inprogress/resources/<slug>/<yyyy-mm-dd>-<kebab-title>.md.',
  '- Brief format: "Session: <id> · Project: <slug>", then one "- " line per change, e.g. "#57 → done; outcome ...", "add under #55: \\"Run signing tests\\" (assignee me)", "resource on #58: test-suite \\"Signing suite\\", path ..., snapshot_file", "log on #55: ...", "focus → #58".',
  '- After dispatching, write one line in chat ("↳ InProgress: #57 done, suite attached to #58"). The scribe\'s completion notice needs no reply beyond that line.',
];

function statusText(n: TreeNode): string {
  if (!isNeedsYou(n)) return n.status;
  return n.status === 'todo' ? 'NEEDS YOU' : `NEEDS YOU (${n.status})`;
}

function lineFor(index: TreeIndex, n: TreeNode, focusOf: Map<number, Session[]>, sessionId?: string): string {
  const prog = progress(index, n.id);
  const here = (focusOf.get(n.id) ?? []).map((s) => (s.id === sessionId ? '◆ this session' : `◆ "${sessionDisplayTitle(s)}"`));
  return `#${n.id} ${n.title}${n.kind === 'question' ? ' (question)' : ''} — ${statusText(n)}${prog ? ` (${prog.done}/${prog.total})` : ''}${here.length ? `  ${here.join(' ')}` : ''}`;
}

export function frontierLines(snapshot: ProjectSnapshot, sessionId?: string): string[] {
  const index = buildIndex(snapshot.nodes);
  const root = index.root;
  if (!root) return ['(empty project)'];
  const live = snapshot.sessions.filter((s) => s.state !== 'ended');
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
      walk(k, depth + 1);
    }
    const upcoming = list.slice(last + 1).filter((k) => k.status === 'todo' && !chain.has(k.id));
    if (upcoming.length) {
      lines.push(`${'  '.repeat(depth)}Next: ${upcoming.slice(0, 2).map((k) => `#${k.id} ${k.title}`).join(' · ')}${upcoming.length > 2 ? ` (+${upcoming.length - 2} more)` : ''}`);
    }
  };
  walk(root, 0);
  if (lines.length > MAX_FRONTIER_LINES) {
    const extra = lines.length - MAX_FRONTIER_LINES;
    return [...lines.slice(0, MAX_FRONTIER_LINES), `+${extra} more active items (run: inprogress outline ${snapshot.project.slug})`];
  }
  return lines;
}

function needsYouLine(snapshot: ProjectSnapshot): string | undefined {
  const index = buildIndex(snapshot.nodes);
  const order = dfsOrder(index);
  const needs = snapshot.nodes.filter(isNeedsYou).sort((a, b) => (order.get(a.id) ?? 0) - (order.get(b.id) ?? 0));
  if (!needs.length) return undefined;
  const shown = needs.slice(0, 8).map((n) => `#${n.id} ${n.title}${n.kind === 'question' ? ' (question)' : ''}`);
  return `Needs you (${needs.length}): ${shown.join(' · ')}${needs.length > 8 ? ` · +${needs.length - 8} more` : ''}`;
}

export function renderBriefing(snapshot: ProjectSnapshot, sessionId: string): string {
  const { project, resources, sessions } = snapshot;
  const lines = [
    `[InProgress] This session is tracked in project "${project.name}" (slug ${project.slug}). Session id: ${sessionId}.`,
    'All InProgress edits go through the inprogress-scribe agent in the background; follow the inprogress skill.',
  ];
  const playbook = project.playbook.trim();
  if (playbook) {
    const pl = playbook.split('\n');
    lines.push('Playbook:', ...pl.slice(0, 15).map((l) => `  ${l}`));
    if (pl.length > 15) lines.push(`  … (${pl.length - 15} more lines)`);
  }
  lines.push(...UPDATE_RULES);
  lines.push('Where things stand:', ...frontierLines(snapshot, sessionId).map((l) => `  ${l}`));
  const needs = needsYouLine(snapshot);
  if (needs) lines.push(needs);
  const recent = [...resources].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt) || b.id - a.id).slice(0, 5);
  if (recent.length) lines.push(`Recent resources: ${recent.map((r) => `r${r.id} ${r.title} (on #${r.nodeId})`).join(' · ')}`);
  const others = sessions.filter((s) => s.id !== sessionId && s.state !== 'ended');
  if (others.length) {
    lines.push(`Other sessions here: ${others.map((s) => `"${sessionDisplayTitle(s)}" (${s.state}${s.focusNodeId ? `, on #${s.focusNodeId}` : ''})`).join(' · ')}`);
  }
  return lines.join('\n');
}

export function renderStatusAnswer(snapshot: ProjectSnapshot, sessionId: string): string {
  const lines = [`[InProgress] Where things stand in ${snapshot.project.name} (live):`, ...frontierLines(snapshot, sessionId).map((l) => `  ${l}`)];
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
