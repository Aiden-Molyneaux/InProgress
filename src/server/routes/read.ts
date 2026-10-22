import type { FastifyInstance } from 'fastify';
import { formatUpNext, queueView } from '../../core/layout';
import { buildIndex, renderOutline } from '../../core/tree';
import type { BuildInfo } from '../../lib/version';
import type { Ctx } from '../db/tx';
import { listBindings, listProjectSummaries, resolveProject } from '../repo/projects';
import { badRequest } from '../errors';
import { libraryPages, projectPages } from '../library';
import { frameHtml, PAGE_FRAME_HEADER_CSP, readPage } from '../pages';
import { requireResource } from '../repo/resources';
import { findSteps, search } from '../repo/search';
import { getNodeDetail, getProjectSnapshot } from '../repo/snapshot';
import { formatCounts, formatDigest, readDigest } from '../digest';
import { formatUsage, readUsage } from '../usage';
import { digestQuery, findQuery, idParam, searchQuery, usageQuery } from '../schemas';

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
    // `Up next: "Store listing": #82 → #78 | "Docs pass": #90 | later: #79`: each live session's own order by its title, then the unowned one.
    const upNext = formatUpNext(queueView(snap.project.queue, snap.nodes, snap.sessions), snap.sessions);
    if (upNext) header.push(upNext);
    // The scribe starts with get_outline, so this is where it reads the project's own instructions.
    const playbook = snap.project.playbook.trim();
    if (playbook) header.push('Playbook:', ...playbook.split(/\r?\n/).map((l) => `  ${l}`));
    const body = renderOutline(buildIndex(snap.nodes), snap.sessions, { full, resourcesByNode });
    return reply.type('text/plain; charset=utf-8').send(`${header.join('\n')}\n${body}`);
  });
  app.get('/api/projects/:ref/digest', async (req) => {
    const query = digestQuery.parse(req.query);
    const digest = readDigest(ctx, (req.params as { ref: string }).ref, query.since);
    const now = Date.parse(ctx.now());
    return { digest, text: formatDigest(digest, now, { all: query.all !== undefined }), counts: formatCounts(digest, now) };
  });
  app.get('/api/projects/:ref/usage', async (req) => {
    const usage = readUsage(ctx, (req.params as { ref: string }).ref, usageQuery.parse(req.query).days);
    return { usage, text: formatUsage(usage) };
  });
  app.get('/api/nodes/:id', async (req) => getNodeDetail(ctx, idParam.parse(req.params).id));
  app.get('/api/resources/:id', async (req) => requireResource(ctx, idParam.parse(req.params).id));
  // A page read live from its file (spec "Reading a page live"): rules re-checked, secrets refused, never cached.
  app.get('/api/resources/:id/body', async (req, reply) => {
    const body = await readPage(ctx, requireResource(ctx, idParam.parse(req.params).id));
    return reply.header('cache-control', 'no-store').send(body);
  });
  // An HTML page as its sandboxed frame loads it. An srcdoc frame would inherit the window's own CSP, which blocks the
  // page's inline scripts, so the page comes from here under a policy of its own.
  app.get('/api/resources/:id/frame', async (req, reply) => {
    const body = await readPage(ctx, requireResource(ctx, idParam.parse(req.params).id));
    if (body.format !== 'html') throw badRequest('Only an HTML page loads in a frame');
    return reply
      .type('text/html; charset=utf-8')
      .header('cache-control', 'no-store')
      .header('content-security-policy', PAGE_FRAME_HEADER_CSP)
      .header('x-content-type-options', 'nosniff')
      .header('referrer-policy', 'no-referrer')
      .send(frameHtml(body.text));
  });
  // The Library group: its pages (read live, so a gone file is a row with its error) and the Sync check of every manifest.
  app.get('/api/library/pages', async (_req, reply) => reply.header('cache-control', 'no-store').send(await libraryPages(ctx)));
  // A project's Docs view: its own pages, read live. An unknown slug is the same 404 as the project's other routes.
  app.get('/api/projects/:ref/pages', async (req, reply) =>
    reply.header('cache-control', 'no-store').send({ pages: await projectPages(ctx, resolveProject(ctx, (req.params as { ref: string }).ref).id) }),
  );
  app.get('/api/bindings', async () => listBindings(ctx));
  app.get('/api/search', async (req) => {
    const q = searchQuery.parse(req.query);
    return search(ctx, resolveProject(ctx, q.project).id, q.q);
  });
  // The window's Go to field: a step by id, or steps by title words, across every project that is not deleted.
  app.get('/api/find', async (req) => {
    const { q, here } = findQuery.parse(req.query);
    return findSteps(ctx, q, here);
  });
}
