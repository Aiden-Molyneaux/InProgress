import { agentTag, sessionDisplayTitle, type EndReason, type EventRow, type ProjectSnapshot } from '../../src/core/types';
import { END_WORDS } from './live';

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

/** A subagent the watcher ended, by its tag (`a3`), found in its session's list or the trail; else "a subagent". */
function agentLabel(sessionId: string, agentId: string, snapshot: ProjectSnapshot | null): string {
  const s = snapshot?.sessions.find((x) => x.id === sessionId);
  const a = s?.subagents?.find((x) => x.agentId === agentId) ?? snapshot?.trailAgents?.find((x) => x.sessionId === sessionId && x.agentId === agentId);
  return agentTag(s?.slot ?? null, a?.ordinal ?? null) || 'a subagent';
}

export function describeEvent(e: EventRow, snapshot: ProjectSnapshot | null): string {
  const d = (e.data ?? {}) as {
    ids?: number[]; parentId?: number; nodeId?: number; title?: string; path?: string;
    changes?: { status?: { to: string }; queue?: unknown }; changed?: string[]; state?: string; focusNodeId?: number | null;
    ended?: { agentId: string; reason: EndReason }[];
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
    case 'log.created':
      return `note on ${nodeLabel(d.nodeId, snapshot)}`;
    case 'session.updated': {
      const who = sessionLabel(e.entityId, snapshot);
      if (d.changed?.includes('focusNodeId')) return d.focusNodeId ? `${who} is on ${nodeLabel(d.focusNodeId, snapshot)}` : `${who} cleared its focus`;
      // The transcript watcher ended subagents that died without a stop: `<session> · a3 hit the usage limit`.
      if (d.ended?.length) return `${who} · ${d.ended.map((x) => `${agentLabel(e.entityId, x.agentId, snapshot)} ${END_WORDS[x.reason] ?? 'ended'}`).join(', ')}`;
      if (d.state === 'ended') return `${who} ended`;
      return `${who} is ${STATE_WORDS[d.state ?? ''] ?? d.state ?? 'updated'}`;
    }
    case 'project.created':
      return 'project created';
    case 'project.updated':
      return d.changes?.queue ? 'Up next changed' : 'project updated';
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
  return e.actor;
}
