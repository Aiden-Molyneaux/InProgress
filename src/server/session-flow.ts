import { SCRIBE_AGENT, type HookEvent, type Session, type WorkStatus } from '../core/types';
import { write, type Ctx } from './db/tx';
import { badRequest } from './errors';
import { renderBriefing, renderStatusAnswer, renderStatusLine, untrackedHint } from './briefing';
import { findNode, leadingNode, requireNode } from './repo/nodes';
import { getProjectById, resolveBinding, resolveProject } from './repo/projects';
import { findSession, saveSession } from './repo/sessions';
import { getProjectSnapshot } from './repo/snapshot';
import { clearSubagents, launchSubagent, pruneSubagents, recordDispatch, startSubagent, stopSubagent } from './repo/subagents';
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

const VISIBLE = ['projectId', 'title', 'state', 'focusNodeId'] as const;

/** SessionStart sources that reset the state to idle. 'compact' (mid-turn) and unknown sources leave it alone. */
const RESET_SOURCES = new Set(['startup', 'resume', 'clear']);

function insertSession(ctx: Ctx, id: string, projectId: number, state: Session['state']): void {
  const now = ctx.now();
  ctx.db.prepare('INSERT INTO sessions (id, project_id, state, started_at, last_seen_at) VALUES (?, ?, ?, ?, ?)').run(id, projectId, state, now, now);
}

const clean = (text: string | undefined): string | null => text?.trim() || null;

export function handleHookEvent(ctx: Ctx, sessionId: string, input: HookEventInput): HookEventResult {
  let created = false;
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
          startSubagent(ctx, sessionId, input.agentId, input.agentType, now);
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
          recordDispatch(ctx, sessionId, { toolUseId: input.toolUseId, agentType, description: input.description?.trim() ?? '', model: clean(input.model), nodeId });
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
        clearSubagents(ctx, sessionId);
        break;
    }
    // Only an ended session has an end time; this also covers one revived after expiry.
    if (next.state !== 'ended') next.endedAt = null;
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
    return after;
  });

  const project = session?.projectId != null ? getProjectById(ctx, session.projectId) : undefined;
  if (!session || !project || project.status !== 'active') {
    return input.event === 'prompt' && input.mentionsInProgress ? { tracked: false, context: untrackedHint(sessionId) } : { tracked: false };
  }
  // A session that has just begun tracking gets the full briefing, whichever event brought it in.
  if (input.event === 'start' || created) return { tracked: true, context: renderBriefing(getProjectSnapshot(ctx, project.id), sessionId) };
  if (input.event === 'prompt' && !input.notice) {
    if (input.asksStatus) return { tracked: true, context: renderStatusAnswer(getProjectSnapshot(ctx, project.id), sessionId) };
    if (session.promptsSinceUpdate >= 2) return { tracked: true, context: renderStatusLine(getProjectSnapshot(ctx, project.id), session) };
  }
  return { tracked: true };
}

export function enrollSession(ctx: Ctx, actor: string, sessionId: string, projectRef: string | number, title?: string): { session: Session; briefing: string } {
  write(ctx, actor, (record) => {
    const project = resolveProject(ctx, projectRef);
    if (project.status !== 'active') throw badRequest(`Project ${project.slug} is archived`, 'Unarchive it with update_project first.');
    if (!findSession(ctx, sessionId)) insertSession(ctx, sessionId, project.id, 'working');
    const before = findSession(ctx, sessionId)!;
    const next: Session = { ...before, projectId: project.id, lastSeenAt: ctx.now() };
    if (title?.trim() && !before.title) next.title = title.trim();
    // A focus node belongs to the old project, so a repoint clears it.
    if (before.projectId !== project.id) next.focusNodeId = null;
    saveSession(ctx, next);
    // Tell the old project's viewers too, so they drop this session's badge.
    if (before.projectId !== null && before.projectId !== project.id) {
      record({ projectId: before.projectId, type: 'session.updated', entity: 'session', entityId: sessionId, data: { changed: ['projectId'], state: next.state } });
    }
    record({ projectId: project.id, type: 'session.updated', entity: 'session', entityId: sessionId, data: { changed: ['projectId'], state: next.state } });
  });
  // Re-read after commit: write() resets prompts_since_update for scribe actors after fn() runs.
  const session = findSession(ctx, sessionId)!;
  return { session, briefing: renderBriefing(getProjectSnapshot(ctx, session.projectId!), sessionId) };
}

export function setFocus(ctx: Ctx, actor: string, sessionId: string, nodeId: number | null): Session {
  write(ctx, actor, (record) => {
    const existing = findSession(ctx, sessionId);
    if (!existing) throw badRequest(`Session ${sessionId} is not tracked`, 'Use enroll_session first.');
    let projectId = existing.projectId;
    if (nodeId !== null) {
      const node = requireNode(ctx, nodeId);
      if (projectId === null) projectId = node.projectId;
      else if (node.projectId !== projectId) throw badRequest(`#${nodeId} is not in this session's project`, 'Use enroll_session to move the session to another project first.');
    }
    if (projectId === null) throw badRequest(`Session ${sessionId} is not tracked`, 'Use enroll_session first.');
    saveSession(ctx, { ...existing, projectId, focusNodeId: nodeId, lastSeenAt: ctx.now() });
    record({ projectId, type: 'session.updated', entity: 'session', entityId: sessionId, data: { changed: ['focusNodeId'], focusNodeId: nodeId } });
  });
  return findSession(ctx, sessionId)!;
}
