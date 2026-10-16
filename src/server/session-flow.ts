import { commandLabel, sessionActivity } from '../core/activity';
import { clipLine, stepRef } from '../core/step-ref';
import { SCRIBE_AGENT, type CommandKind, type CommandOutcome, type HookEvent, type Session, type TreeNode, type WorkStatus } from '../core/types';
import { write, type Ctx, type RecordEvent } from './db/tx';
import { badRequest } from './errors';
import { renderBriefing, renderStatusAnswer, renderStatusLine, untrackedHint } from './briefing';
import { renderOrchestratorBriefing, stepBlock } from './briefing-scoped';
import { deriveBoard, isLive, reconcileLine } from '../core/board';
import { askTag, sessionDisplayTitle } from '../core/types';
import { formatCounts, formatDigest, readDigest } from './digest';
import { markAnswersDelivered, owedAnswers, undeliveredAnswers } from './repo/asks';
import { endCommand, endSessionCommands, pruneCommands, reconcileCommands, startCommand, type BackgroundEntry } from './repo/commands';
import { findNode, leadingNode, patchNode, requireNode, setDriver } from './repo/nodes';
import { getProjectById, isTracking, notTracked, releaseQueue, resolveBinding, resolveProject } from './repo/projects';
import { assignSlot, briefingDue, clearBriefingDue, findSession, markBriefingDue, markRevived, saveSession } from './repo/sessions';
import { getProjectSnapshot } from './repo/snapshot';
import { endAgent, endSubagents, launchSubagent, messageAgent, pinStartFocus, pruneSubagents, recordDispatch, startSubagent, stopSubagent, subagentNode } from './repo/subagents';
import { taskCreated, taskUpdated } from './repo/work';

export interface HookEventInput {
  event: HookEvent;
  source?: string;
  cwd?: string;
  branch?: string | null;
  transcriptPath?: string;
  title?: string;
  agentId?: string;
  agentType?: string;
  mentionsInProgress?: boolean;
  asksStatus?: boolean;
  notice?: boolean;
  toolUseId?: string;
  description?: string;
  model?: string;
  /** agent-dispatch: the prompt's first sentence. */
  purpose?: string;
  taskKey?: string;
  subject?: string;
  status?: WorkStatus | 'deleted';
  addBlocks?: string[];
  addBlockedBy?: string[];
  /** command-started: Claude Code's task id, the tool (kind), a Monitor's persistence, the command's first words and how long the call took. */
  taskId?: string;
  kind?: CommandKind;
  persistent?: boolean;
  commandHead?: string;
  durationMs?: number;
  /** command-ended: how it ended. */
  outcome?: CommandOutcome;
  exitCode?: number;
  /** agent-ended: why (only 'killed'). agent-messaged: whether it resumed the agent, and the message's summary. */
  reason?: 'killed';
  resumed?: boolean;
  summary?: string;
  /** A notice prompt: the task-notification blocks it carries. */
  tasks?: { taskId: string; toolUseId?: string; status: 'completed' | 'failed' | 'killed'; exitCode?: number }[];
  /** A stop: the session's running background tasks, also when empty; `backgroundTruncated` when the list was cut at 50. */
  background?: BackgroundEntry[];
  backgroundTruncated?: boolean;
}

export interface HookEventResult {
  tracked: boolean;
  context?: string;
}

const VISIBLE = ['projectId', 'title', 'state', 'focusNodeId', 'slot'] as const;

/** SessionStart sources that reset the state to idle. 'compact' (mid-turn) and unknown sources leave it alone. */
const RESET_SOURCES = new Set(['startup', 'resume', 'clear']);

/** A new session, with the lowest slot free in its project: the hook path and enrollSession both create through here. */
function insertSession(ctx: Ctx, id: string, projectId: number, state: Session['state']): void {
  const now = ctx.now();
  ctx.db
    .prepare('INSERT INTO sessions (id, project_id, state, started_at, last_seen_at, slot) VALUES (?, ?, ?, ?, ?, ?)')
    .run(id, projectId, state, now, now, assignSlot(ctx, id, projectId));
}

/**
 * Sets `next.slot` for a flow about to save it. A session moved to another project takes the lowest slot free there. One
 * that is live after this flow keeps its slot while no other live session of the project holds it, else takes the
 * lowest free one: that covers a session revived from ended or from stale (another may have taken its slot meanwhile)
 * and a slot still null from before migration 4. An ended session keeps what it had, for its revival.
 */
function placeSlot(ctx: Ctx, before: Session, next: Session): void {
  if (next.projectId === null) return;
  if (next.projectId !== before.projectId) next.slot = assignSlot(ctx, next.id, next.projectId);
  else if (next.state !== 'ended') next.slot = assignSlot(ctx, next.id, next.projectId, before.slot);
}

/**
 * After placeSlot, for a flow that is not a hook event (setFocus, enrollSession): a session live after it in another
 * slot holds a briefing that names its old letter or none, so its next real prompt brings a fresh one, as the hook path
 * marks it (review-actions ruling 40). markBriefingDue is idempotent.
 */
function markIfRelettered(ctx: Ctx, before: Session, next: Session): void {
  if (next.state !== 'ended' && before.slot !== next.slot) markBriefingDue(ctx, next.id);
}

/** An answer on one line, at most 300 characters with the ellipsis inside them. */
function oneLine(text: string): string {
  const line = text.replace(/\s+/g, ' ').trim();
  return line.length > 300 ? `${line.slice(0, 299)}…` : line;
}

const clean = (text: string | undefined): string | null => text?.trim() || null;

export function handleHookEvent(ctx: Ctx, sessionId: string, input: HookEventInput): HookEventResult {
  let created = false;
  /**
   * The session owed the full briefing (its "briefing due" marker was set) and this response carries it: a start, a
   * session this event created, or a real prompt, which gets it in place of a status answer or nudge.
   */
  let briefingOwed = false;
  const session = write(ctx, `hook:${input.event}`, (record): Session | undefined => {
    let before = findSession(ctx, sessionId);
    // A session whose project is archived or deleted is not tracked: nothing it does is recorded, so it never comes back
    // into that project, even one that had ended before the archive. It is tracked again once the project is unarchived,
    // or after an enroll elsewhere.
    if (before && !isTracking(ctx, before.projectId)) return undefined;
    if (!before) {
      // A start begins tracking, and so does a first prompt when the start was missed (the server
      // was down then, say): both resolve the binding the same way.
      if ((input.event !== 'start' && input.event !== 'prompt') || !input.cwd) return undefined;
      const project = resolveBinding(ctx, input.cwd, input.branch ?? null);
      if (!project) return undefined;
      insertSession(ctx, sessionId, project.id, 'idle');
      before = findSession(ctx, sessionId)!;
      created = true;
    }
    const now = ctx.now();
    const next: Session = { ...before, lastSeenAt: now };
    /** Nodes whose working tasks this event changed: one work.updated each. */
    const worked: number[] = [];
    if (input.cwd) next.cwd = input.cwd;
    if (input.branch !== undefined) next.branch = input.branch;
    if (input.transcriptPath) next.transcriptPath = input.transcriptPath;
    if (input.title?.trim()) next.title = input.title.trim();
    switch (input.event) {
      case 'start':
        // A missing source counts as 'startup'.
        if (RESET_SOURCES.has(input.source ?? 'startup')) next.state = 'idle';
        // A clear starts a new conversation: an orchestrator that cleared is a worker again. Compaction and resume keep the role.
        if (input.source === 'clear') next.role = 'worker';
        // A resumed session is a new life: what ran in the old one is gone.
        if (input.source === 'resume') endSessionCommands(ctx, sessionId, now);
        break;
      case 'prompt':
        next.state = 'working';
        // A notice ends the commands it names. Agent ids never have a row, so an agent's notice does nothing here.
        for (const t of input.tasks ?? []) endCommand(ctx, sessionId, t.taskId, t.status, now, t.exitCode);
        // A background-task notice (the scribe finishing, say) is not a prompt Aiden typed: no stale count.
        if (!input.notice) next.promptsSinceUpdate += 1;
        break;
      case 'stop':
        next.state = 'idle';
        // Absent `background` says nothing about what runs; an empty one says nothing does.
        if (input.background) reconcileCommands(ctx, sessionId, input.background, now, { truncated: input.backgroundTruncated === true, nodeId: before.focusNodeId });
        break;
      case 'permission':
        next.state = 'permission';
        break;
      case 'subagent-start':
        if (input.agentId && input.agentType && input.agentType !== SCRIBE_AGENT) {
          pruneSubagents(ctx);
          // A subagent-start never moves the focus, so `before`'s is the focus at its start.
          startSubagent(ctx, sessionId, input.agentId, input.agentType, now, before.focusNodeId);
        }
        if (next.state === 'permission') next.state = 'working';
        break;
      case 'subagent-stop':
        if (input.agentId) stopSubagent(ctx, sessionId, input.agentId, now);
        if (next.state === 'permission') next.state = 'working';
        break;
      case 'agent-dispatch': {
        // Without a subagent_type the Agent tool runs a general-purpose agent, and that is the type SubagentStart reports.
        const agentType = clean(input.agentType) ?? 'general-purpose';
        if (input.toolUseId && agentType !== SCRIBE_AGENT) {
          const nodeId = leadingNode(ctx, input.description, before.projectId) ?? before.focusNodeId;
          recordDispatch(ctx, sessionId, {
            toolUseId: input.toolUseId,
            agentType,
            description: input.description?.trim() ?? '',
            model: clean(input.model),
            nodeId,
            purpose: clean(input.purpose),
          });
        }
        break;
      }
      case 'agent-launched':
        if (input.toolUseId && input.agentId) launchSubagent(ctx, sessionId, input.toolUseId, input.agentId, clean(input.model));
        break;
      case 'command-started':
        if (input.taskId && input.kind) {
          pruneCommands(ctx);
          const inProject = (id: number | null | undefined) => (id != null && findNode(ctx, id)?.projectId === before.projectId ? id : undefined);
          // A leading #id in the description is exact; then the subagent's node (as a working task attributes), then the focus.
          const nodeId = leadingNode(ctx, input.description, before.projectId)
            ?? (input.agentId ? inProject(subagentNode(ctx, sessionId, input.agentId)) : undefined)
            ?? before.focusNodeId;
          startCommand(ctx, sessionId, {
            taskId: input.taskId,
            toolUseId: input.toolUseId,
            agentId: input.agentId,
            kind: input.kind,
            persistent: input.persistent,
            description: clean(input.description) ?? undefined,
            commandHead: input.commandHead,
            startedAt: new Date(Date.parse(now) - (input.durationMs ?? 0)).toISOString(),
            nodeId,
          });
        }
        if (next.state === 'permission') next.state = 'working';
        break;
      case 'command-ended':
        if (input.taskId && input.outcome) endCommand(ctx, sessionId, input.taskId, input.outcome, now, input.exitCode);
        if (next.state === 'permission') next.state = 'working';
        break;
      case 'agent-ended':
        if (input.agentId) endAgent(ctx, sessionId, input.agentId, 'killed', now, now);
        if (next.state === 'permission') next.state = 'working';
        break;
      case 'agent-messaged':
        if (input.agentId) {
          messageAgent(
            ctx,
            sessionId,
            input.agentId,
            { resumed: input.resumed === true, summary: clean(input.summary) ?? undefined, purpose: clean(input.purpose) ?? undefined, focusNodeId: before.focusNodeId, projectId: before.projectId },
            now,
          );
        }
        if (next.state === 'permission') next.state = 'working';
        break;
      case 'task-created':
        if (input.taskKey && input.subject) worked.push(...taskCreated(ctx, before, input.agentId ?? '', input.taskKey, input.subject));
        break;
      case 'task-updated':
        if (input.taskKey) {
          const { agentId = '', taskKey, subject, status, addBlocks, addBlockedBy } = input;
          worked.push(...taskUpdated(ctx, before, { agentId, taskKey, subject, status, addBlocks, addBlockedBy }));
        }
        break;
      case 'end':
        next.state = 'ended';
        next.endedAt = now;
        endSubagents(ctx, sessionId, now);
        endSessionCommands(ctx, sessionId, now);
        // Its Up next entries turn unowned. Recorded before session.updated (after the switch), so the activity strip
        // still reads "<session> ended".
        releaseQueue(ctx, record, sessionId);
        break;
    }
    // Only an ended session has an end time; this also covers one revived after expiry.
    if (next.state !== 'ended') next.endedAt = null;
    placeSlot(ctx, before, next);
    saveSession(ctx, next);
    // Back from ended: a new life, which leaves the subagents its last one ended in the trail (markRevived). Before the
    // read below, so a usage-limit subagent leaving its line counts as a change to the subagents.
    if (before.state === 'ended' && next.state !== 'ended') markRevived(ctx, sessionId, now);
    const after = findSession(ctx, sessionId)!;
    const changed: string[] = VISIBLE.filter((k) => before![k] !== after[k]);
    if (JSON.stringify(before.subagents) !== JSON.stringify(after.subagents)) changed.push('subagents');
    if (JSON.stringify(before.commands) !== JSON.stringify(after.commands)) changed.push('commands');
    if (created || changed.length) {
      // The one command this event started or ended, for the window's line; none when it touched several.
      // New rows (a start) and rows that ended or changed how they ended; a start that only fills a field does not count.
      const touched = after.commands.filter((c) => {
        const was = before!.commands.find((b) => b.taskId === c.taskId);
        return !was || was.endedAt !== c.endedAt || was.outcome !== c.outcome;
      });
      const command = touched.length === 1 ? { label: commandLabel(touched[0]), ...(touched[0].outcome ? { outcome: touched[0].outcome } : {}) } : undefined;
      record({
        projectId: after.projectId,
        type: 'session.updated',
        entity: 'session',
        entityId: sessionId,
        data: { changed: created ? ['created', ...changed] : changed, state: after.state, activity: sessionActivity(after, Date.parse(now)), ...(command ? { command } : {}) },
      });
    }
    for (const nodeId of new Set(worked)) {
      const node = findNode(ctx, nodeId);
      if (node) record({ projectId: node.projectId, type: 'work.updated', entity: 'node', entityId: nodeId, data: { nodeId } });
    }
    // A session live after this event in another letter (back from ended, or from past the stale limit before expiry
    // marked it ended, or given its first slot) holds a briefing that names the old letter or none: its next prompt
    // brings a fresh one (review-actions ruling 35). A start carries the full briefing already.
    if (input.event !== 'start' && after.state !== 'ended' && before.slot !== after.slot) markBriefingDue(ctx, sessionId);
    // Decided here, rendered after commit: the snapshot read may open its own write (stale expiry). Any response that
    // carries the full briefing clears the marker, so it arrives once; a background-task notice is not a prompt Aiden
    // typed, and leaves it for the next one (ruling 27). Nothing is decided for a project that is not active, which gets
    // no briefing.
    const mayBrief = input.event === 'start' || created || (input.event === 'prompt' && !input.notice);
    if (mayBrief && isTracking(ctx, after.projectId) && briefingDue(ctx, sessionId)) {
      clearBriefingDue(ctx, sessionId);
      briefingOwed = true;
    }
    return after;
  });

  if (!session || !isTracking(ctx, session.projectId)) {
    return input.event === 'prompt' && input.mentionsInProgress ? { tracked: false, context: untrackedHint(sessionId) } : { tracked: false };
  }
  const projectId = session.projectId!;
  // Needs-you ages count to the server's clock (ctx.now), never the wall clock behind it.
  // A session that has just begun tracking gets the full briefing, whichever event brought it in, and so does the first
  // real prompt after an enroll or a revival into another letter. Every one but a compaction's is fresh, and asks about
  // old needs-you items: a session first tracked by a prompt (its start was missed), a start with a missing or unknown
  // source, and an owed briefing count as new. An owed briefing is the enroll's even when a compaction's start brings
  // it: the one the enroll returned went to the scribe.
  const nowMs = Date.parse(ctx.now());
  let context: string | undefined;
  if (input.event === 'start' || created || briefingOwed) {
    const checkOld = briefingOwed || !(input.event === 'start' && input.source === 'compact');
    // The orchestrator's counts line reads the digest, outside any write as the snapshot is.
    const counts = session.role === 'orchestrator' ? formatCounts(readDigest(ctx, projectId), nowMs) : undefined;
    context = renderBriefing(getProjectSnapshot(ctx, projectId), sessionId, nowMs, { checkOld, ...(counts === undefined ? {} : { counts }) });
  } else if (input.event === 'prompt' && !input.notice) {
    if (input.asksStatus) context = renderStatusAnswer(getProjectSnapshot(ctx, projectId), sessionId, nowMs);
    else if (session.promptsSinceUpdate >= 2) context = renderStatusLine(getProjectSnapshot(ctx, projectId), session);
  }
  // The answers line (spec 2, 3.3): once, on the next real prompt after an ask this session holds was cleared, or an
  // answered one on a step it drives whose asker no longer holds it (undeliveredAnswers says which route applies).
  if (input.event === 'prompt' && !input.notice) {
    const answers = undeliveredAnswers(ctx, sessionId);
    if (answers.length) {
      const lines = answers.map((a) => (a.answer ? `Answered: ${askTag(a.id)} "${oneLine(a.answer)}" (yours: act on it, or add it to your tasks)` : `Cleared: ${askTag(a.id)}, no answer`));
      markAnswersDelivered(ctx, answers.map((a) => a.id));
      context = [...lines, ...(context ? [context] : [])].join('\n');
    }
  }
  return context === undefined ? { tracked: true } : { tracked: true, context };
}

export function enrollSession(ctx: Ctx, actor: string, sessionId: string, projectRef: string | number, title?: string): { session: Session; briefing: string } {
  write(ctx, actor, (record) => {
    const project = resolveProject(ctx, projectRef);
    if (project.status !== 'active') throw badRequest(`Project ${project.slug} is archived`, 'Unarchive it with update_project first.');
    const isNew = !findSession(ctx, sessionId);
    if (isNew) insertSession(ctx, sessionId, project.id, 'working');
    const before = findSession(ctx, sessionId)!;
    const next: Session = { ...before, projectId: project.id, lastSeenAt: ctx.now() };
    if (title?.trim() && !before.title) next.title = title.trim();
    // A focus node belongs to the old project, so a repoint clears it.
    if (before.projectId !== project.id) next.focusNodeId = null;
    // Never revives an ended session (it keeps its state), so only a repoint gives an ended one a slot.
    placeSlot(ctx, before, next);
    // Its Up next entries stay behind in the old project, unowned: that project no longer lists the session.
    if (before.projectId !== null && before.projectId !== project.id) releaseQueue(ctx, record, sessionId);
    saveSession(ctx, next);
    // The briefing returned below goes to the scribe, which passes on its first line only: the session's next real
    // prompt brings the full one. A live session re-enrolled where it already is keeps what it has, due or not (ruling
    // 29), unless placeSlot just gave it another letter (ruling 40).
    if (isNew || before.projectId !== project.id || before.state === 'ended') markBriefingDue(ctx, sessionId);
    markIfRelettered(ctx, before, next);
    // Tell the old project's viewers too, so they drop this session's badge.
    if (before.projectId !== null && before.projectId !== project.id) {
      record({ projectId: before.projectId, type: 'session.updated', entity: 'session', entityId: sessionId, data: { changed: ['projectId'], state: next.state } });
    }
    record({ projectId: project.id, type: 'session.updated', entity: 'session', entityId: sessionId, data: { changed: ['projectId'], state: next.state } });
  });
  // Re-read after commit: write() resets prompts_since_update for scribe actors after fn() runs. An enroll's briefing is
  // fresh, so it asks about old needs-you items.
  const session = findSession(ctx, sessionId)!;
  return { session, briefing: renderBriefing(getProjectSnapshot(ctx, session.projectId!), sessionId, Date.parse(ctx.now()), { checkOld: true }) };
}

/** How a focus change left the step's driver (spec 1.2): null for no step. */
type Drive = 'drives' | 'helping' | 'took_over' | 'same' | null;

/** A session as a claim's notes name it: its title, clipped and quoted, as the briefing's session lines do (#438). */
function sessionName(s: Session): string {
  return `"${clipLine(sessionDisplayTitle(s), 30)}"`;
}

/** The note a claim prints for `drive`, or none. */
function driveNote(drive: Drive, nodeId: number, from: Session | null): string | null {
  const name = from ? sessionName(from) : '?';
  if (drive === 'drives') return `You drive #${nodeId}.`;
  if (drive === 'helping') return `${name} drives #${nodeId}; you are helping. Pass --take-over to drive.`;
  if (drive === 'took_over') return `You drive #${nodeId}; took over from ${name}.`;
  return null;
}

/**
 * setFocus's work inside an open write: validates, activates a todo step, moves the driver (spec 1.2, 1.3), saves the
 * session and records the change.
 */
function applyFocus(ctx: Ctx, record: RecordEvent, sessionId: string, nodeId: number | null, o: { takeOver: boolean }): { existing: Session; projectId: number; drive: Drive; from: Session | null } {
  const existing = findSession(ctx, sessionId);
  if (!existing) throw badRequest(`Session ${sessionId} is not tracked`, 'Use enroll_session first.');
  const untracked = (id: number) => notTracked(ctx, sessionId, id, 'Unarchive the project with update_project first, or move the session to an active project with enroll_session.');
  if (existing.projectId !== null && !isTracking(ctx, existing.projectId)) throw untracked(existing.projectId);
  let projectId = existing.projectId;
  let node: TreeNode | undefined;
  if (nodeId !== null) {
    node = requireNode(ctx, nodeId);
    if (projectId === null) projectId = node.projectId;
    else if (node.projectId !== projectId) throw badRequest(`#${nodeId} is not in this session's project`, 'Use enroll_session to move the session to another project first.');
  }
  if (projectId === null) throw badRequest(`Session ${sessionId} is not tracked`, 'Use enroll_session first.');
  // A session with no project takes the step's, which must be tracked too.
  if (!isTracking(ctx, projectId)) throw untracked(projectId);
  // Focus on a todo step of Claude's makes it active, in this write and under this actor. Any other status, or a step
  // assigned to Aiden, stays as it is. Recorded before session.updated, so the activity strip's latest line still
  // reads "<session> is on #id".
  // patchNode writes the node's driver back as it read it, so it runs before any setDriver here, and the driver checks
  // below use the node it returns.
  if (node && node.status === 'todo' && node.assignee === 'claude') node = patchNode(ctx, record, node, { status: 'active' });
  // Focus that leaves a step this session drives stops the driving (spec 1.3).
  if (existing.focusNodeId !== null && existing.focusNodeId !== nodeId) {
    const old = findNode(ctx, existing.focusNodeId);
    if (old && old.driverSessionId === sessionId) setDriver(ctx, record, old, null);
  }
  let drive: Drive = null;
  let from: Session | null = null;
  // Only an open step gets a driver: a done or dropped one keeps none (spec 1.3), and the project root never has one.
  if (node && node.parentId !== null && node.status !== 'done' && node.status !== 'dropped') {
    // A driver id that names no session row counts as no driver, and so does a session no longer focused on the step
    // (an enrollSession repoint, or any other drift that left the column behind).
    const current = node.driverSessionId === null ? undefined : findSession(ctx, node.driverSessionId);
    if (node.driverSessionId === sessionId) drive = 'same';
    else if (!current || !isLive(current, Date.parse(ctx.now())) || current.focusNodeId !== node.id) {
      setDriver(ctx, record, node, sessionId);
      drive = 'drives';
    } else if (o.takeOver) {
      // Cleared directly, not through applyFocus, so the old driver's lastSeenAt does not move and keep it live.
      // Never clears a focus on another step (the live check above means it is on this one).
      ctx.db.prepare('UPDATE sessions SET focus_node_id = NULL WHERE id = ? AND focus_node_id = ?').run(current.id, node.id);
      record({ projectId: current.projectId ?? projectId, type: 'session.updated', entity: 'session', entityId: current.id, data: { changed: ['focusNodeId'], focusNodeId: null } });
      markBriefingDue(ctx, current.id);
      setDriver(ctx, record, node, sessionId);
      drive = 'took_over';
      from = current;
    } else {
      drive = 'helping';
      from = current;
    }
  }
  const next: Session = { ...existing, projectId, focusNodeId: nodeId, lastSeenAt: ctx.now() };
  // Being heard from again can bring a stale session back.
  placeSlot(ctx, existing, next);
  saveSession(ctx, next);
  // A subagent that started while the session had no focus stays on this first one (session.updated below refetches).
  pinStartFocus(ctx, sessionId, nodeId);
  markIfRelettered(ctx, existing, next);
  record({ projectId, type: 'session.updated', entity: 'session', entityId: sessionId, data: { changed: ['focusNodeId'], focusNodeId: nodeId } });
  return { existing, projectId, drive, from };
}

export function setFocus(ctx: Ctx, actor: string, sessionId: string, nodeId: number | null): Session {
  write(ctx, actor, (record) => {
    // A scribe's set_focus never takes over (spec 1.2): it drives only a step with no live driver.
    const { existing, projectId } = applyFocus(ctx, record, sessionId, nodeId, { takeOver: false });
    // In a scoped project the scribe's focus change brings the step block on the next prompt (spec 3.1). A claim prints it itself.
    if (actor.startsWith('scribe') && existing.focusNodeId !== nodeId && getProjectById(ctx, projectId)?.briefingMode === 'scoped') markBriefingDue(ctx, sessionId);
  });
  return findSession(ctx, sessionId)!;
}

export interface ClaimResult {
  session: Session;
  notes: string[];
  block: string[];
}

/**
 * `inprogress claim` (spec 3.1): setFocus, then the role worker, and the step block at once. Readiness is advisory in
 * stage 1: each reason is a note and the claim goes ahead. Marks no briefing due, because the block is the answer.
 */
export function claimStep(ctx: Ctx, actor: string, sessionId: string, nodeId: number, o: { takeOver?: boolean } = {}): ClaimResult {
  const notes: string[] = [];
  // "Also claimed by" notes, held back until the write says which session the driver note names.
  const alsoClaimed: { sessionId: string; note: string }[] = [];
  const before = findSession(ctx, sessionId);
  const target = findNode(ctx, nodeId);
  // A refusal (another project's step, an untracked session) comes from applyFocus below; notes only for a claim that can go ahead.
  if (before && before.projectId !== null && target && target.projectId === before.projectId) {
    const nowMs = Date.parse(ctx.now());
    const row = deriveBoard(getProjectSnapshot(ctx, before.projectId), nowMs).byId.get(nodeId);
    if (!row || (row.column !== 'next' && row.column !== 'now')) notes.push(`Note: #${nodeId} is not in Next.`);
    for (const a of row?.asks ?? []) notes.push(`Note: #${nodeId} has open ask ${askTag(a.id)}.`);
    for (const s of row?.sessions ?? []) {
      if (s.id !== sessionId) alsoClaimed.push({ sessionId: s.id, note: `Note: #${nodeId} is also claimed by ${sessionName(s)} (${sessionActivity(s, nowMs)}).` });
    }
  }
  let drove: { drive: Drive; from: Session | null } = { drive: null, from: null };
  let owedLines: string[] = [];
  write(ctx, actor, (record) => {
    // The role first, so the focus event ("is on #id") is the latest line on the activity strip. A session with no
    // project takes the step's; applyFocus refuses what cannot be claimed, and the write rolls the role back with it.
    const existing = findSession(ctx, sessionId);
    const roleProject = existing?.projectId ?? target?.projectId;
    if (existing && existing.role !== 'worker' && roleProject !== undefined) {
      ctx.db.prepare("UPDATE sessions SET role = 'worker' WHERE id = ?").run(sessionId);
      record({ projectId: roleProject, type: 'session.updated', entity: 'session', entityId: sessionId, data: { changed: ['role'], role: 'worker' } });
    }
    const { drive, from } = applyFocus(ctx, record, sessionId, nodeId, { takeOver: o.takeOver ?? false });
    drove = { drive, from };
    // A claim names a step to work on: not the project root, not a dropped step (as raiseAsk refuses them). Checked after
    // applyFocus, so an untracked session or another project's step gets that reason first.
    if (target && target.parentId === null) throw badRequest(`#${nodeId} is the project root`, 'Claim the step you will work on.');
    if (target && target.status === 'dropped') throw badRequest(`#${nodeId} is dropped`, 'Reopen it first, or claim another step.');
    // A session that starts driving is told the answers no live asker will hear (spec 2), once: marked in this write.
    if (drive === 'drives' || drive === 'took_over') {
      const owed = owedAnswers(ctx, nodeId);
      markAnswersDelivered(ctx, owed.map((a) => a.id));
      owedLines = owed.map((a) => `Owed: ${askTag(a.id)} answered "${oneLine(a.answer)}"`);
    }
  });
  // The driver note names its session, so that session's "also claimed" note would say it twice.
  for (const a of alsoClaimed) if (a.sessionId !== drove.from?.id) notes.push(a.note);
  const driveLine = driveNote(drove.drive, nodeId, drove.from);
  if (driveLine) notes.push(driveLine);
  const session = findSession(ctx, sessionId)!;
  const snapshot = getProjectSnapshot(ctx, session.projectId!);
  return { session, notes, block: [...stepBlock(snapshot, nodeId, session, Date.parse(ctx.now())), ...owedLines] };
}

/**
 * `inprogress orchestrate` (spec 3.2, 4): role orchestrator, no focus, one session.orchestrate event for the week's
 * count, and the opening: the briefing with the counts offer; with `status` also the digest, the reconcile lines and the
 * top of Next.
 */
export function orchestrate(ctx: Ctx, actor: string, sessionId: string, o: { status: boolean }): { session: Session; opening: string } {
  const before = findSession(ctx, sessionId);
  if (!before || before.projectId === null) throw badRequest(`Session ${sessionId} is not tracked`, 'Use enroll_session first.');
  const projectId = before.projectId;
  const marks = deriveBoard(getProjectSnapshot(ctx, projectId), Date.parse(ctx.now())).marked.length;
  write(ctx, actor, (record) => {
    if (!isTracking(ctx, projectId)) throw notTracked(ctx, sessionId, projectId, 'Unarchive the project with update_project first.');
    // Dropping the focus stops the driving of the step it was on (spec 1.3). Read inside the write, as setDriver needs.
    const focusId = findSession(ctx, sessionId)?.focusNodeId ?? null;
    const focused = focusId === null ? undefined : findNode(ctx, focusId);
    if (focused && focused.driverSessionId === sessionId) setDriver(ctx, record, focused, null);
    ctx.db.prepare("UPDATE sessions SET role = 'orchestrator', focus_node_id = NULL WHERE id = ?").run(sessionId);
    // The session line last, so the activity strip's latest event is about the session (it has no session.orchestrate line).
    record({ projectId, type: 'session.orchestrate', entity: 'session', entityId: sessionId, data: { status: o.status, marks } });
    record({ projectId, type: 'session.updated', entity: 'session', entityId: sessionId, data: { changed: ['role', 'focusNodeId'], role: 'orchestrator', focusNodeId: null } });
  });
  const session = findSession(ctx, sessionId)!;
  const nowMs = Date.parse(ctx.now());
  const snapshot = getProjectSnapshot(ctx, projectId);
  const digest = readDigest(ctx, projectId);
  const lines = [renderOrchestratorBriefing(snapshot, session, nowMs, formatCounts(digest, nowMs), { checkOld: true })];
  if (o.status) {
    const board = deriveBoard(snapshot, nowMs);
    lines.push('', formatDigest(digest, nowMs));
    if (board.marked.length) lines.push('Reconcile:', ...board.marked.flatMap((r) => r.marks.map((m) => `  ${reconcileLine(r, m, nowMs)}`)));
    if (board.next.length) lines.push('Next:', ...board.next.slice(0, 3).map((r) => `  ${stepRef(r.node.id, r.node.title)}: ${r.ready ? 'ready' : 'not ready'}`));
  }
  return { session, opening: lines.join('\n') };
}
