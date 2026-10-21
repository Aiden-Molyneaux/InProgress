import type { BoardInput } from '../../core/board';
import type { NodeDetail, ProjectSnapshot } from '../../core/types';
import type { Ctx } from '../db/tx';
import { listProjectAsks } from './asks';
import { lastProjectEvent, maxEventId } from './events';
import { listLogs } from './logs';
import { listNodes, requireNode } from './nodes';
import { getProjectById, resolveProject } from './projects';
import { listStepTouches } from './rank';
import { listNodeResources, listResourceMeta, readStateNote } from './resources';
import { expireStaleSessions, listPastSessions, readProjectSessions } from './sessions';
import { listTrailAgents } from './subagents';
import { listWorkItems } from './work';

/**
 * What deriveBoard reads for one project, by plain reads only (no stale-session expiry), so it can run inside a write:
 * the Board reconcile reads it there, and the snapshot after expiring stale sessions. Undefined for an unknown project.
 */
export function readBoardInput(ctx: Ctx, projectId: number): BoardInput | undefined {
  const project = getProjectById(ctx, projectId);
  if (!project) return undefined;
  return {
    project,
    nodes: listNodes(ctx, projectId),
    resources: listResourceMeta(ctx, projectId),
    sessions: readProjectSessions(ctx, projectId),
    pastSessions: listPastSessions(ctx, projectId),
    asks: listProjectAsks(ctx, projectId),
  };
}

/**
 * Everything the UI and briefing need for one project. Expires stale sessions first, which opens
 * its own write(), then reads the Board's part through readBoardInput: never call this from inside
 * another write().
 */
export function getProjectSnapshot(ctx: Ctx, ref: string | number): ProjectSnapshot {
  const { id } = resolveProject(ctx, ref);
  // First: stale sessions expire here, releasing their Up next entries in the same write, so the project row and the
  // trail reads below find them ended.
  expireStaleSessions(ctx);
  const { project, nodes, resources, sessions, pastSessions, asks } = readBoardInput(ctx, id)!;
  return {
    project,
    nodes,
    resources,
    sessions,
    workItems: listWorkItems(ctx, project.id),
    trailAgents: listTrailAgents(ctx, project.id),
    pastSessions,
    asks,
    stepTouches: listStepTouches(ctx, project.id),
    stateNote: readStateNote(ctx, project.id),
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
