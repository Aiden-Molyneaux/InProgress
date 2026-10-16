import { ancestors, buildIndex, kids } from '../core/tree';
import { sessionActivity } from '../core/activity';
import { deriveBoard } from '../core/board';
import { ASK_GLYPHS, askTag, glyphTitle, sessionDisplayTitle, sessionTag, type ProjectSnapshot, type Session, type TreeNode } from '../core/types';
import { claimCommand } from '../lib/task-command';
import { PLAN_EDIT_LINE, bodyLines, headerLine, leftUnfinishedOn, lineFor, openTasks, othersLine, playbookLines, spanAgo, updateRules, type BriefingOptions } from './briefing';

/*
 * The scoped renderers of spec 3.4. briefing.ts dispatches to them by role and mode, and they use its line builders, so
 * the two modules import each other; every import is a function called at render time, never at load.
 */

/** Open children listed under the claimed step, and open tasks; more are counted. */
const MAX_CHILD_LINES = 8;
const MAX_TASK_LINES = 5;
const MAX_RESOURCES = 5;
const MAX_READY = 3;
const OPEN_STATUSES = new Set(['todo', 'active', 'blocked']);
const clip = (text: string, max = 60): string => {
  const line = text.replace(/\s+/g, ' ').trim();
  return line.length > max ? `${line.slice(0, max - 1)}…` : line;
};

/**
 * Spec 3.4 items 3 to 7 for one step: the block `claim` prints and the scoped worker briefing carries. Your step (the
 * parent chain, the step with status and progress, its open children, the session's live open tasks), the newest handoff,
 * its resources, its asks, and what an earlier session left unfinished on it.
 */
export function stepBlock(snapshot: ProjectSnapshot, nodeId: number, session: Session, now: number): string[] {
  const index = buildIndex(snapshot.nodes);
  const node = index.byId.get(nodeId);
  if (!node) return [];
  const chain = ancestors(index, nodeId).map((a) => `#${a.id} ${a.title}`);
  const lines = [`Your step:${chain.length ? ` ${chain.join(' › ')}` : ''}`, `  ${lineFor(index, node, new Map())}`];
  const open = kids(index, nodeId).filter((k) => OPEN_STATUSES.has(k.status));
  for (const k of open.slice(0, MAX_CHILD_LINES)) lines.push(`    ${lineFor(index, k, new Map())}`);
  if (open.length > MAX_CHILD_LINES) lines.push(`    +${open.length - MAX_CHILD_LINES} more open`);
  for (const t of openTasks(snapshot.workItems, nodeId).slice(0, MAX_TASK_LINES)) lines.push(`    ${t.status === 'in_progress' ? '◐' : '○'} ${t.subject}`);

  const row = deriveBoard(snapshot, now).byId.get(nodeId);
  // Who drives the step (spec 1.4): none when no live session does.
  const driver = row?.driver;
  if (driver) lines.push(`Driver: ${driver.id === session.id ? 'you' : `${sessionTag(driver.slot) || '?'} "${sessionDisplayTitle(driver)}" (${sessionActivity(driver, now)})`}`);
  const handoff = row?.handoff;
  if (handoff) lines.push(`Handoff: r${handoff.id} "${handoff.title}" (${spanAgo(handoff.createdAt, now)})`);

  const resources = snapshot.resources
    .filter((r) => r.nodeId === nodeId)
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt) || b.id - a.id)
    .slice(0, MAX_RESOURCES);
  if (resources.length) lines.push(`Resources on #${nodeId}: ${resources.map((r) => `r${r.id} ${r.title}`).join(' · ')}`);

  // Open asks, oldest first, then those cleared since this session began, with what Aiden said.
  const asks = snapshot.asks.filter((a) => a.nodeId === nodeId);
  const openAsks = asks.filter((a) => a.clearedAt === null).sort((a, b) => a.raisedAt.localeCompare(b.raisedAt) || a.id - b.id);
  const cleared = asks.filter((a) => a.clearedAt !== null && a.clearedAt >= session.startedAt).sort((a, b) => a.clearedAt!.localeCompare(b.clearedAt!) || a.id - b.id);
  const askParts = [
    ...openAsks.map((a) => `${askTag(a.id)} ${ASK_GLYPHS[a.kind]} "${clip(a.text)}" (open, ${spanAgo(a.raisedAt, now)})`),
    ...cleared.map((a) => `${askTag(a.id)} ${ASK_GLYPHS[a.kind]} "${clip(a.text)}" (${a.answer ? `answered: "${clip(a.answer)}"` : 'cleared'})`),
  ];
  if (askParts.length) lines.push(`Asks on #${nodeId}: ${askParts.join(' · ')}`);

  const left = leftUnfinishedOn(snapshot, nodeId);
  if (left) lines.push(left);
  return lines;
}

/**
 * The unclaimed worker's lines: up to three Next steps that are ready (no open ask, none of Aiden's own), this
 * session's own queue first, then the unowned ones, then another live session's; or that nothing is ready.
 */
export function unclaimedLines(snapshot: ProjectSnapshot, session: Session, now: number, cli?: string): string[] {
  const ready = deriveBoard(snapshot, now).next.filter((r) => r.ready && r.node.assignee !== 'me');
  const rank = (owner: Session | null) => (owner === null ? 1 : owner.id === session.id ? 0 : 2);
  // Array.prototype.sort is stable, so each group keeps the Board's rail order.
  const chosen = [...ready].sort((a, b) => rank(a.owner) - rank(b.owner)).slice(0, MAX_READY);
  if (!chosen.length) return ["Nothing is ready. Planning is the Orchestrator's job (mip-orc)."];
  const name = (n: TreeNode) => `#${n.id} ${glyphTitle(n)}`;
  return [`Ready to claim: ${chosen.map((r) => name(r.node)).join(' · ')}`, `Claim one: ${claimCommand(session.id, { cli })}`, 'Inheriting a step from a session that handed it to you: add --take-over.'];
}

/** A worker's briefing in a scoped project, once it has claimed a step. */
export function renderWorkerBriefing(snapshot: ProjectSnapshot, session: Session, now: number, cli?: string): string {
  const lines = [
    headerLine(snapshot, session.id),
    `Role: worker on #${session.focusNodeId}.`,
    PLAN_EDIT_LINE,
    ...playbookLines(snapshot),
    ...updateRules({ sessionId: session.id, cli, mode: { scoped: true, orchestrator: false } }),
    ...stepBlock(snapshot, session.focusNodeId!, session, now),
  ];
  const others = othersLine(snapshot, session.id, now);
  if (others) lines.push(others);
  return lines.join('\n');
}

/** A worker's briefing in a scoped project that has not claimed a step. */
export function renderUnclaimedBriefing(snapshot: ProjectSnapshot, session: Session, now: number, cli?: string): string {
  const lines = [
    headerLine(snapshot, session.id),
    'Role: worker, no step claimed.',
    PLAN_EDIT_LINE,
    ...updateRules({ sessionId: session.id, cli, mode: { scoped: true, orchestrator: false } }),
    ...playbookLines(snapshot),
    ...unclaimedLines(snapshot, session, now, cli),
  ];
  const others = othersLine(snapshot, session.id, now);
  if (others) lines.push(others);
  return lines.join('\n');
}

/** An orchestrator's briefing, in either mode: its rules, the counts offer, then every line of today's briefing after the rules. */
export function renderOrchestratorBriefing(snapshot: ProjectSnapshot, session: Session, now: number, counts: string, opts: BriefingOptions): string {
  return [
    headerLine(snapshot, session.id),
    'Role: orchestrator. You never implement: no code edits, commits, builds or implementers.',
    PLAN_EDIT_LINE,
    ...updateRules({ sessionId: session.id, cli: opts.cli, mode: { scoped: false, orchestrator: true } }),
    ...playbookLines(snapshot),
    ...(counts ? [counts] : []),
    ...bodyLines(snapshot, session.id, now, opts),
  ].join('\n');
}
