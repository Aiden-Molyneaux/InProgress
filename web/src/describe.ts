import { sessionDisplayTitle, type CommandOutcome, type EndReason, type EventRow, type ProjectSnapshot } from '../../src/core/types';
import { COMMAND_OUTCOME_WORDS, END_WORDS, agentName } from './live';

const STATE_WORDS: Record<string, string> = { working: 'working', idle: 'idle', permission: 'waiting for a permission' };

function nodeLabel(id: number | undefined, snapshot: ProjectSnapshot | null): string {
  if (id === undefined) return 'a step';
  const node = snapshot?.nodes.find((n) => n.id === id);
  return node ? `#${id} ${node.title}` : `#${id}`;
}

function sessionLabel(id: string, snapshot: ProjectSnapshot | null): string {
  const s = snapshot?.sessions.find((x) => x.id === id);
  return s ? sessionDisplayTitle(s) : 'a session';
}

/** A subagent the watcher ended, by its name, found in its session's list or the trail; else "a subagent". */
function agentLabel(sessionId: string, agentId: string, snapshot: ProjectSnapshot | null): string {
  const s = snapshot?.sessions.find((x) => x.id === sessionId);
  const a = s?.subagents?.find((x) => x.agentId === agentId) ?? snapshot?.trailAgents?.find((x) => x.sessionId === sessionId && x.agentId === agentId);
  return a ? agentName(a) : 'a subagent';
}

/** The driver change of a node.updated whose only change is its driver (setDriver's event); else undefined. */
function driverOnlyChange(e: EventRow): { to: string | null } | undefined {
  if (e.type !== 'node.updated') return undefined;
  const changes = ((e.data ?? {}) as { changes?: Record<string, { to: unknown }> }).changes ?? {};
  const keys = Object.keys(changes);
  if (keys.length !== 1 || keys[0] !== 'driverSessionId') return undefined;
  const to = changes.driverSessionId.to;
  return { to: typeof to === 'string' ? to : null };
}

/**
 * Events the activity strip leaves out: a driver cleared, which says nothing on its own (the focus change recorded in
 * the same write says it).
 */
export function stripSkips(e: EventRow): boolean {
  return driverOnlyChange(e)?.to === null;
}

export function describeEvent(e: EventRow, snapshot: ProjectSnapshot | null): string {
  const driver = driverOnlyChange(e);
  if (driver?.to) return `${sessionLabel(driver.to, snapshot)} drives ${nodeLabel(Number(e.entityId), snapshot)}`;
  const d = (e.data ?? {}) as {
    ask?: { nodeId: number };
    ids?: number[]; parentId?: number; nodeId?: number; title?: string; path?: string;
    changes?: { status?: { to: string }; queue?: unknown; name?: unknown }; changed?: string[]; state?: string; focusNodeId?: number | null;
    ended?: { agentId: string; reason: EndReason }[];
    activity?: string; command?: { label: string; outcome?: CommandOutcome };
  };
  switch (e.type) {
    case 'node.created':
      return (d.ids?.length ?? 1) === 1 ? `added ${nodeLabel(d.ids?.[0] ?? Number(e.entityId), snapshot)}` : `added ${d.ids!.length} steps under ${nodeLabel(d.parentId, snapshot)}`;
    case 'node.updated':
      return d.changes?.status ? `${nodeLabel(Number(e.entityId), snapshot)} → ${d.changes.status.to}` : `updated ${nodeLabel(Number(e.entityId), snapshot)}`;
    case 'node.moved':
      return `moved ${nodeLabel(Number(e.entityId), snapshot)}`;
    case 'node.deleted':
      return `removed ${d.ids?.length ?? 1} step(s)`;
    case 'resource.created':
      return `"${d.title ?? `r${e.entityId}`}" attached to ${nodeLabel(d.nodeId, snapshot)}`;
    case 'resource.updated':
      return `updated r${e.entityId}`;
    case 'resource.deleted':
      return `removed r${e.entityId}`;
    case 'ask.raised':
      return `asked on ${nodeLabel(d.ask?.nodeId, snapshot)}`;
    case 'ask.cleared':
      return `cleared an ask on ${nodeLabel(d.ask?.nodeId, snapshot)}`;
    case 'log.created':
      return `note on ${nodeLabel(d.nodeId, snapshot)}`;
    case 'session.updated': {
      const who = sessionLabel(e.entityId, snapshot);
      if (d.changed?.includes('focusNodeId')) return d.focusNodeId ? `${who} is on ${nodeLabel(d.focusNodeId, snapshot)}` : `${who} cleared its focus`;
      // The transcript watcher ended subagents that died without a stop: `<session> · <subagent> hit the usage limit`.
      if (d.ended?.length) return `${who} · ${d.ended.map((x) => `${agentLabel(e.entityId, x.agentId, snapshot)} ${END_WORDS[x.reason] ?? 'ended'}`).join(', ')}`;
      // A session's end is its end, whatever commands it took along.
      if (d.state === 'ended') return `${who} ended`;
      // session-flow records the one command an event started (no outcome) or ended.
      const command = d.command ? (d.command.outcome ? `${d.command.label} ${COMMAND_OUTCOME_WORDS[d.command.outcome] ?? 'ended'}` : `started ${d.command.label}`) : null;
      // Idle with work still running: the session is busy, not idle.
      const state = d.state === 'idle' && d.activity === 'busy' ? 'is busy' : `is ${STATE_WORDS[d.state ?? ''] ?? d.state ?? 'updated'}`;
      if (d.changed?.includes('state')) return command ? `${who} ${state} · ${command}` : `${who} ${state}`;
      if (d.command) return d.command.outcome ? `${who}: ${command}` : `${who} ${command}`;
      // The transcript watcher ended commands and recorded no single one.
      if (d.changed?.includes('commands')) return `${who}: a background command ended`;
      return `${who} ${state}`;
    }
    case 'project.created':
      return 'project created';
    case 'project.updated':
      if (d.changes?.status) return d.changes.status.to === 'archived' ? 'archived the project' : 'unarchived the project';
      if (d.changes?.name) return 'renamed the project';
      return d.changes?.queue ? 'Up next changed' : 'project updated';
    case 'project.deleted':
      return 'deleted the project';
    case 'project.restored':
      return 'restored the project';
    case 'work.updated':
      return `tasks updated on ${nodeLabel(d.nodeId ?? Number(e.entityId), snapshot)}`;
    case 'binding.created':
      return `folder bound: ${d.path ?? ''}`;
    case 'binding.deleted':
      return 'folder unbound';
    default:
      return e.type;
  }
}

export function actorLabel(e: EventRow, snapshot: ProjectSnapshot | null): string {
  if (e.actor.startsWith('scribe:')) {
    const s = snapshot?.sessions.find((x) => x.id === e.actor.slice('scribe:'.length));
    return s ? `scribe (${sessionDisplayTitle(s)})` : 'scribe';
  }
  if (e.actor.startsWith('hook:')) return 'Claude';
  // The tasks command a main session runs itself. An ended session has left the snapshot: its short id stands in.
  if (e.actor.startsWith('session:')) {
    const id = e.actor.slice('session:'.length);
    return sessionDisplayTitle(snapshot?.sessions.find((x) => x.id === id) ?? { id, title: null });
  }
  // Archive, unarchive, delete and restore from the window itself: the person reading this.
  if (e.actor === 'window') return 'you';
  return e.actor;
}
