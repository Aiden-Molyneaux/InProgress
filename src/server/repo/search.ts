import { GOTO_LIMIT, parseGoTo, type StepHit } from '../../core/goto';
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

/**
 * The window's Go to field, across every project that is not deleted, archived ones included. An id (`#77`, `77`)
 * answers that step alone, or nothing when it is gone or its project is deleted. Words answer the steps whose titles
 * hold every one of them, in any order and ignoring case: active projects' first, then open steps before finished
 * ones, then the most recently changed. At most GOTO_LIMIT.
 */
export function findSteps(ctx: Ctx, text: string): StepHit[] {
  const q = parseGoTo(text);
  const select = `SELECT n.id, n.title, n.status, p.id AS projectId, p.slug AS projectSlug, p.name AS projectName, p.status AS projectStatus
    FROM nodes n JOIN projects p ON p.id = n.project_id WHERE p.deleted_at IS NULL`;
  if (q.kind === 'empty') return [];
  if (q.kind === 'id') return Number.isSafeInteger(q.id) && q.id > 0 ? (ctx.db.prepare(`${select} AND n.id = ?`).all(q.id) as StepHit[]) : [];
  const likes = q.words.map((w) => `%${w.replace(/[\\%_]/g, (m) => `\\${m}`)}%`);
  return ctx.db
    .prepare(
      `${select} AND ${likes.map(() => "n.title LIKE ? ESCAPE '\\'").join(' AND ')}
       ORDER BY p.status = 'archived', n.status IN ('done', 'dropped'), n.updated_at DESC, n.id DESC LIMIT ${GOTO_LIMIT}`,
    )
    .all(...likes) as StepHit[];
}
