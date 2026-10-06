import { SCRIBE_AGENT, type HookEvent, type Session, type TreeNode, type WorkStatus } from '../core/types';
import { write, type Ctx } from './db/tx';
import { badRequest } from './errors';
import { renderBriefing, renderStatusAnswer, renderStatusLine, untrackedHint } from './briefing';
import { findNode, leadingNode, patchNode, requireNode } from './repo/nodes';
import { getProjectById, releaseQueue, resolveBinding, resolveProject } from './repo/projects';
import { assignSlot, briefingDue, clearBriefingDue, findSession, markBriefingDue, saveSession } from './repo/sessions';
import { getProjectSnapshot } from './repo/snapshot';
import { endSubagents, launchSubagent, pinStartFocus, pruneSubagents, recordDispatch, startSubagent, stopSubagent } from './repo/subagents';
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
        break;
      case 'prompt':
        next.state = 'working';
        // A background-task notice (the scribe finishing, say) is not a prompt Aiden typed: no stale count.
        if (!input.notice) next.promptsSinceUpdate += 1;
        break;
      case 'stop':
        next.state = 'idle';
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
        // Its Up next entries turn unowned. Recorded before session.updated (after the switch), so the activity strip
        // still reads "<session> ended".
        releaseQueue(ctx, record, sessionId);
        break;
    }
    // Only an ended session has an end time; this also covers one revived after expiry.
    if (next.state !== 'ended') next.endedAt = null;
    placeSlot(ctx, before, next);
    saveSession(ctx, next);
    const after = findSession(ctx, sessionId)!;
    const changed: string[] = VISIBLE.filter((k) => before![k] !== after[k]);
    if (JSON.stringify(before.subagents) !== JSON.stringify(after.subagents)) changed.push('subagents');
    if (created || changed.length) {
      record({ projectId: after.projectId, type: 'session.updated', entity: 'session', entityId: sessionId, data: { changed: created ? ['created', ...changed] : changed, state: after.state } });
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
    if (mayBrief && after.projectId !== null && getProjectById(ctx, after.projectId)?.status === 'active' && briefingDue(ctx, sessionId)) {
      clearBriefingDue(ctx, sessionId);
      briefingOwed = true;
    }
    return after;
  });

  const project = session?.projectId != null ? getProjectById(ctx, session.projectId) : undefined;
  if (!session || !project || project.status !== 'active') {
    return input.event === 'prompt' && input.mentionsInProgress ? { tracked: false, context: untrackedHint(sessionId) } : { tracked: false };
  }
  // Needs-you ages count to the server's clock (ctx.now), never the wall clock behind it.
  // A session that has just begun tracking gets the full briefing, whichever event brought it in, and so does the first
  // real prompt after an enroll or a revival into another letter. Every one but a compaction's is fresh, and asks about
  // old needs-you items: a session first tracked by a prompt (its start was missed), a start with a missing or unknown
  // source, and an owed briefing count as new. An owed briefing is the enroll's even when a compaction's start brings
  // it: the one the enroll returned went to the scribe.
  if (input.event === 'start' || created || briefingOwed) {
    const checkOld = briefingOwed || !(input.event === 'start' && input.source === 'compact');
    return { tracked: true, context: renderBriefing(getProjectSnapshot(ctx, project.id), sessionId, Date.parse(ctx.now()), { checkOld }) };
  }
  if (input.event === 'prompt' && !input.notice) {
    if (input.asksStatus) return { tracked: true, context: renderStatusAnswer(getProjectSnapshot(ctx, project.id), sessionId, Date.parse(ctx.now())) };
    if (session.promptsSinceUpdate >= 2) return { tracked: true, context: renderStatusLine(getProjectSnapshot(ctx, project.id), session) };
  }
  return { tracked: true };
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

export function setFocus(ctx: Ctx, actor: string, sessionId: string, nodeId: number | null): Session {
  write(ctx, actor, (record) => {
    const existing = findSession(ctx, sessionId);
    if (!existing) throw badRequest(`Session ${sessionId} is not tracked`, 'Use enroll_session first.');
    let projectId = existing.projectId;
    let node: TreeNode | undefined;
    if (nodeId !== null) {
      node = requireNode(ctx, nodeId);
      if (projectId === null) projectId = node.projectId;
      else if (node.projectId !== projectId) throw badRequest(`#${nodeId} is not in this session's project`, 'Use enroll_session to move the session to another project first.');
    }
    if (projectId === null) throw badRequest(`Session ${sessionId} is not tracked`, 'Use enroll_session first.');
    // Focus on a todo step of Claude's makes it active, in this write and under this actor. Any other status, or a step
    // assigned to Aiden, stays as it is. Recorded before session.updated, so the activity strip's latest line still
    // reads "<session> is on #id".
    if (node && node.status === 'todo' && node.assignee === 'claude') patchNode(ctx, record, node, { status: 'active' });
    const next: Session = { ...existing, projectId, focusNodeId: nodeId, lastSeenAt: ctx.now() };
    // Being heard from again can bring a stale session back.
    placeSlot(ctx, existing, next);
    saveSession(ctx, next);
    // A subagent that started while the session had no focus stays on this first one (session.updated below refetches).
    pinStartFocus(ctx, sessionId, nodeId);
    markIfRelettered(ctx, existing, next);
    record({ projectId, type: 'session.updated', entity: 'session', entityId: sessionId, data: { changed: ['focusNodeId'], focusNodeId: nodeId } });
  });
  return findSession(ctx, sessionId)!;
}
