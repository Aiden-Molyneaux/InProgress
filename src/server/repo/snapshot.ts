import type { NodeDetail, ProjectSnapshot } from '../../core/types';
import type { Ctx } from '../db/tx';
import { lastProjectEvent, maxEventId } from './events';
import { listLogs } from './logs';
import { listNodes, requireNode } from './nodes';
import { resolveProject } from './projects';
import { listNodeResources, listResourceMeta } from './resources';
import { listPastSessions, listProjectSessions } from './sessions';
import { listTrailAgents } from './subagents';
import { listWorkItems } from './work';

/**
 * Everything the UI and briefing need for one project. Reads sessions through
 * listProjectSessions, which may write (stale-session expiry): never call this from inside
 * another write().
 */
export function getProjectSnapshot(ctx: Ctx, ref: string | number): ProjectSnapshot {
  const project = resolveProject(ctx, ref);
  // First: stale sessions expire here, so the trail reads below find them ended.
  const sessions = listProjectSessions(ctx, project.id);
  return {
    project,
    nodes: listNodes(ctx, project.id),
    resources: listResourceMeta(ctx, project.id),
    sessions,
    workItems: listWorkItems(ctx, project.id),
    trailAgents: listTrailAgents(ctx, project.id),
    pastSessions: listPastSessions(ctx, project.id),
    lastEventId: maxEventId(ctx),
    lastEvent: lastProjectEvent(ctx, project.id),
  };
}

export function getNodeDetail(ctx: Ctx, id: number): NodeDetail {
  const node = requireNode(ctx, id);
  const parent = node.parentId === null
    ? null
    : ((ctx.db.prepare('SELECT id, title FROM nodes WHERE id = ?').get(node.parentId) as { id: number; title: string } | undefined) ?? null);
  const children = ctx.db
    .prepare('SELECT id, title, status, assignee, kind FROM nodes WHERE parent_id = ? ORDER BY position, id')
    .all(id) as NodeDetail['children'];
  return { node, parent, children, resources: listNodeResources(ctx, id), log: listLogs(ctx, id, 20) };
}
