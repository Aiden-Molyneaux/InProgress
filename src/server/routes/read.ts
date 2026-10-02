import type { FastifyInstance } from 'fastify';
import { buildIndex, renderOutline } from '../../core/tree';
import type { BuildInfo } from '../../lib/version';
import type { Ctx } from '../db/tx';
import { listBindings, listProjectSummaries, resolveProject } from '../repo/projects';
import { requireResource } from '../repo/resources';
import { search } from '../repo/search';
import { getNodeDetail, getProjectSnapshot } from '../repo/snapshot';
import { idParam, searchQuery } from '../schemas';

export function registerReadRoutes(app: FastifyInstance, ctx: Ctx, version: string, build: BuildInfo | null): void {
  app.get('/api/health', async () => ({ ok: true, app: 'inprogress', version, build, pid: process.pid }));
  app.get('/api/projects', async () => listProjectSummaries(ctx));
  app.get('/api/projects/:ref', async (req) => getProjectSnapshot(ctx, (req.params as { ref: string }).ref));
  app.get('/api/projects/:ref/outline', async (req, reply) => {
    const snap = getProjectSnapshot(ctx, (req.params as { ref: string }).ref);
    const full = ['1', 'true'].includes(String((req.query as { full?: string }).full));
    const resourcesByNode = new Map<number, number[]>();
    for (const r of snap.resources) resourcesByNode.set(r.nodeId, [...(resourcesByNode.get(r.nodeId) ?? []), r.id]);
    const header = [`Project ${snap.project.name} (slug ${snap.project.slug}${snap.project.status === 'archived' ? ', archived' : ''})`];
    if (snap.project.queue.length) header.push(`Up next: ${snap.project.queue.map((id) => `#${id}`).join(' → ')}`);
    // The scribe starts with get_outline, so this is where it reads the project's own instructions.
    const playbook = snap.project.playbook.trim();
    if (playbook) header.push('Playbook:', ...playbook.split(/\r?\n/).map((l) => `  ${l}`));
    const body = renderOutline(buildIndex(snap.nodes), snap.sessions, { full, resourcesByNode });
    return reply.type('text/plain; charset=utf-8').send(`${header.join('\n')}\n${body}`);
  });
  app.get('/api/nodes/:id', async (req) => getNodeDetail(ctx, idParam.parse(req.params).id));
  app.get('/api/resources/:id', async (req) => requireResource(ctx, idParam.parse(req.params).id));
  app.get('/api/bindings', async () => listBindings(ctx));
  app.get('/api/search', async (req) => {
    const q = searchQuery.parse(req.query);
    return search(ctx, resolveProject(ctx, q.project).id, q.q);
  });
}
