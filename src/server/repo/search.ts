import type { SearchResult } from '../../core/types';
import type { Ctx } from '../db/tx';
import { badRequest } from '../errors';

export function search(ctx: Ctx, projectId: number, query: string): SearchResult {
  const q = query.trim();
  if (!q) throw badRequest('Search query is empty');
  const like = `%${q.replace(/[\\%_]/g, (m) => `\\${m}`)}%`;
  const nodes = ctx.db
    .prepare("SELECT id, title, status, kind FROM nodes WHERE project_id = ? AND (title LIKE ? ESCAPE '\\' OR body LIKE ? ESCAPE '\\' OR outcome LIKE ? ESCAPE '\\') ORDER BY updated_at DESC LIMIT 20")
    .all(projectId, like, like, like) as SearchResult['nodes'];
  const resources = ctx.db
    .prepare("SELECT id, title, kind, node_id AS nodeId FROM resources WHERE project_id = ? AND (title LIKE ? ESCAPE '\\' OR content LIKE ? ESCAPE '\\') ORDER BY updated_at DESC LIMIT 20")
    .all(projectId, like, like) as SearchResult['resources'];
  return { nodes, resources: resources.slice(0, Math.max(0, 20 - nodes.length)) };
}
