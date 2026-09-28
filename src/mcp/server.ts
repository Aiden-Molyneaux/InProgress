import { readFileSync, statSync } from 'node:fs';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import {
  ASSIGNEES, NODE_KINDS, NODE_STATUSES, RESOURCE_KINDS,
  type Binding, type LogEntry, type NodeDetail, type NodeInput, type Project, type ProjectSummary, type Resource, type SearchResult, type TreeNode,
} from '../core/types';
import { ApiClientError, type Client } from '../lib/client';
import { VERSION } from '../lib/version';
import { formatCreated, formatNodeDetail, formatResource, formatSearch } from './format';

const SNAPSHOT_LIMIT = 200 * 1024;

type ToolResult = { content: { type: 'text'; text: string }[]; isError?: boolean };
const ok = (text: string): ToolResult => ({ content: [{ type: 'text', text }] });
const fail = (err: unknown): ToolResult => {
  const text = err instanceof ApiClientError ? (err.hint ? `${err.message}. ${err.hint}` : err.message) : err instanceof Error ? err.message : String(err);
  return { isError: true, content: [{ type: 'text', text }] };
};
const actor = (session?: string) => (session ? `scribe:${session}` : 'scribe');
const enc = encodeURIComponent;

const nodeInputSchema: z.ZodType<NodeInput> = z.lazy(() =>
  z.object({
    title: z.string().min(1).max(200),
    kind: z.enum(NODE_KINDS).optional(),
    status: z.enum(NODE_STATUSES).optional(),
    assignee: z.enum(ASSIGNEES).optional(),
    body: z.string().optional(),
    outcome: z.string().optional(),
    children: z.array(nodeInputSchema).optional(),
  }),
);
const after = z.union([z.number().int().positive(), z.enum(['start', 'end'])]).optional().describe('Insert after this sibling #id, or "start" / "end" (default end)');
const session = z.string().optional().describe('The Claude session id from the brief. Always pass it on writes.');
const id = z.number().int().positive();

export function createMcpServer(client: Client): McpServer {
  const server = new McpServer({ name: 'inprogress', version: VERSION });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const tool = (name: string, description: string, shape: z.ZodRawShape, run: (args: any) => Promise<string>) => {
    server.registerTool(name, { description, inputSchema: shape }, async (args: unknown) => {
      try {
        return ok(await run(args));
      } catch (err) {
        return fail(err);
      }
    });
  };

  tool('list_projects', 'List projects with needs-you counts, live sessions and folder bindings (binding ids are for unbind_folder).', {}, async () => {
    const [projects, bindings] = await Promise.all([client.get<ProjectSummary[]>('/api/projects'), client.get<Binding[]>('/api/bindings')]);
    if (!projects.length) return 'No projects yet.';
    return projects
      .map((p) => {
        const own = bindings.filter((b) => b.projectId === p.id).map((b) => `  binding ${b.id}: ${b.path}${b.branchPattern ? ` [branch ${b.branchPattern}]` : ''}`);
        return [`${p.slug} — ${p.name} (${p.status}) · root #${p.rootNodeId} · ${p.needsYou} need you · ${p.activeSessions} session(s)`, ...own].join('\n');
      })
      .join('\n');
  });

  tool('get_outline', 'Outline of a project tree with #ids, statuses, assignees and resource ids. Finished branches are folded unless full is true.', { project: z.string().describe('slug, name or id'), full: z.boolean().optional() },
    async (a: { project: string; full?: boolean }) => client.text(`/api/projects/${enc(a.project)}/outline${a.full ? '?full=1' : ''}`));

  tool('get_node', 'One node with its parent, children, resources and recent log.', { id },
    async (a: { id: number }) => formatNodeDetail(await client.get<NodeDetail>(`/api/nodes/${a.id}`)));

  tool('get_resource', 'A resource including its saved content.', { id },
    async (a: { id: number }) => formatResource(await client.get<Resource>(`/api/resources/${a.id}`)));

  tool('search', 'Find nodes and resources in a project by text.', { project: z.string(), query: z.string().min(1) },
    async (a: { project: string; query: string }) => formatSearch(await client.get<SearchResult>(`/api/search?project=${enc(a.project)}&q=${enc(a.query)}`)));

  tool('create_project', 'Create a project with its root node, optionally binding a folder (and git branch glob) so sessions there are tracked automatically.',
    { name: z.string().min(1), description: z.string(), playbook: z.string().optional(), slug: z.string().optional(), bind_path: z.string().optional(), branch_pattern: z.string().optional(), session },
    async (a: { name: string; description: string; playbook?: string; slug?: string; bind_path?: string; branch_pattern?: string; session?: string }) => {
      const p = await client.post<Project>('/api/projects', { name: a.name, description: a.description, playbook: a.playbook, slug: a.slug }, { actor: actor(a.session) });
      const lines = [`Created project ${p.slug} "${p.name}" (root #${p.rootNodeId}).`];
      if (a.bind_path) {
        // The project exists by now: report a rejected binding without failing, so a retry cannot duplicate the project.
        try {
          const b = await client.post<Binding>(`/api/projects/${enc(p.slug)}/bindings`, { path: a.bind_path, branchPattern: a.branch_pattern ?? null }, { actor: actor(a.session) });
          lines.push(`Bound ${b.path}${b.branchPattern ? ` [branch ${b.branchPattern}]` : ''} (binding ${b.id}).`);
        } catch (err) {
          lines.push(`Binding failed: ${err instanceof Error ? err.message : String(err)}. Use bind_folder to retry.`);
        }
      }
      return lines.join('\n');
    });

  tool('update_project', 'Rename a project, change its description or playbook, or archive / unarchive it.',
    { project: z.string(), name: z.string().optional(), description: z.string().optional(), playbook: z.string().optional(), status: z.enum(['active', 'archived']).optional(), session },
    async ({ project, session: s, ...patch }: { project: string; session?: string; name?: string; description?: string; playbook?: string; status?: 'active' | 'archived' }) => {
      const p = await client.patch<Project>(`/api/projects/${enc(project)}`, patch, { actor: actor(s) });
      return `Updated project ${p.slug} (${p.status}).`;
    });

  tool('bind_folder', 'Bind a folder, optionally with a git branch glob like *VCAD-978*, so sessions started there are tracked.', { project: z.string(), path: z.string(), branch_pattern: z.string().optional(), session },
    async (a: { project: string; path: string; branch_pattern?: string; session?: string }) => {
      const b = await client.post<Binding>(`/api/projects/${enc(a.project)}/bindings`, { path: a.path, branchPattern: a.branch_pattern ?? null }, { actor: actor(a.session) });
      return `Binding ${b.id}: ${b.path}${b.branchPattern ? ` [branch ${b.branchPattern}]` : ''} → ${a.project}.`;
    });

  tool('unbind_folder', 'Remove a folder binding by id (list_projects shows ids).', { binding_id: id, session },
    async (a: { binding_id: number; session?: string }) => {
      await client.del(`/api/bindings/${a.binding_id}`, { actor: actor(a.session) });
      return `Removed binding ${a.binding_id}.`;
    });

  tool('add_nodes', 'Add one node or a whole nested plan under a parent #id. Defaults: kind task, status todo, assignee claude. Use assignee "me" for anything Aiden must do.',
    { parent: id, nodes: z.array(nodeInputSchema).min(1), after, session },
    async (a: { parent: number; nodes: NodeInput[]; after?: number | 'start' | 'end'; session?: string }) =>
      formatCreated(await client.post<TreeNode[]>('/api/nodes', { parentId: a.parent, after: a.after, nodes: a.nodes }, { actor: actor(a.session) })));

  tool('update_node', "Change a node's title, kind, status, assignee, body or outcome. Set outcome when something finishes.",
    { id, title: z.string().optional(), kind: z.enum(NODE_KINDS).optional(), status: z.enum(NODE_STATUSES).optional(), assignee: z.enum(ASSIGNEES).optional(), body: z.string().optional(), outcome: z.string().optional(), session },
    async ({ id: nodeId, session: s, ...patch }: { id: number; session?: string } & Record<string, unknown>) => {
      const n = await client.patch<TreeNode>(`/api/nodes/${nodeId}`, patch, { actor: actor(s) });
      return `#${n.id} ${n.title} — ${n.status}${n.assignee === 'me' ? ' (you)' : ''}.`;
    });

  tool('move_node', 'Move a node and its subtree under a new parent, optionally after a sibling.', { id, parent: id, after, session },
    async (a: { id: number; parent: number; after?: number | 'start' | 'end'; session?: string }) => {
      const n = await client.post<TreeNode>(`/api/nodes/${a.id}/move`, { parentId: a.parent, after: a.after }, { actor: actor(a.session) });
      return `Moved #${n.id} under #${n.parentId}.`;
    });

  tool('delete_node', 'Delete a node created by mistake. For abandoned work prefer status "dropped". cascade=true also deletes its subtree.', { id, cascade: z.boolean().optional(), session },
    async (a: { id: number; cascade?: boolean; session?: string }) => {
      const r = await client.del<{ ids: number[] }>(`/api/nodes/${a.id}${a.cascade ? '?cascade=1' : ''}`, { actor: actor(a.session) });
      return `Deleted ${r.ids.map((i) => `#${i}`).join(', ')}.`;
    });

  tool('add_resource', 'Attach a resource to the node where it was produced. Give a path (with snapshot_file=true for text files up to 200 KB), a url, or content.',
    { node: id, kind: z.enum(RESOURCE_KINDS), title: z.string().min(1), content: z.string().optional(), path: z.string().optional(), url: z.string().optional(), snapshot_file: z.boolean().optional(), session },
    async (a: { node: number; kind: string; title: string; content?: string; path?: string; url?: string; snapshot_file?: boolean; session?: string }) => {
      let content = a.content;
      if (a.snapshot_file) {
        if (!a.path) throw new Error('snapshot_file needs a path');
        const size = statSync(a.path).size;
        if (size > SNAPSHOT_LIMIT) throw new Error(`${a.path} is ${Math.round(size / 1024)} KB; the snapshot limit is 200 KB. Attach it by path only.`);
        content = readFileSync(a.path, 'utf8');
      }
      const r = await client.post<Resource>('/api/resources', { nodeId: a.node, kind: a.kind, title: a.title, content: content ?? null, path: a.path ?? null, url: a.url ?? null, sessionId: a.session ?? null }, { actor: actor(a.session) });
      return `r${r.id} "${r.title}" (${r.kind}) attached to #${r.nodeId}${r.contentLength ? ` · ${r.contentLength} chars saved` : ''}.`;
    });

  tool('update_resource', 'Edit a resource or move it to another node in the same project.',
    { id, node: id.optional(), kind: z.enum(RESOURCE_KINDS).optional(), title: z.string().optional(), content: z.string().optional(), path: z.string().optional(), url: z.string().optional(), session },
    async ({ id: rid, node, session: s, ...patch }: { id: number; node?: number; session?: string } & Record<string, unknown>) => {
      const r = await client.patch<Resource>(`/api/resources/${rid}`, { ...patch, nodeId: node }, { actor: actor(s) });
      return `r${r.id} "${r.title}" on #${r.nodeId}.`;
    });

  tool('delete_resource', 'Delete a resource.', { id, session }, async (a: { id: number; session?: string }) => {
    await client.del(`/api/resources/${a.id}`, { actor: actor(a.session) });
    return `Deleted r${a.id}.`;
  });

  tool('add_log', 'Add a timeline note to a node: detours, context, decisions made along the way.', { node: id, text: z.string().min(1), session },
    async (a: { node: number; text: string; session?: string }) => {
      const l = await client.post<LogEntry>(`/api/nodes/${a.node}/log`, { text: a.text, sessionId: a.session ?? null }, { actor: actor(a.session) });
      return `Logged on #${l.nodeId}.`;
    });

  tool('enroll_session', 'Track a Claude session in a project (also repoints a session bound to the wrong project). Returns the project briefing.', { session: z.string().min(1), project: z.string(), title: z.string().optional() },
    async (a: { session: string; project: string; title?: string }) => {
      const r = await client.post<{ briefing: string }>(`/api/sessions/${enc(a.session)}/enroll`, { project: a.project, title: a.title }, { actor: actor(a.session) });
      return r.briefing;
    });

  tool('set_focus', 'Set which node a session is working on (null clears it). Drives the session badge in the UI.', { session: z.string().min(1), node: id.nullable() },
    async (a: { session: string; node: number | null }) => {
      await client.post(`/api/sessions/${enc(a.session)}/focus`, { nodeId: a.node }, { actor: actor(a.session) });
      return a.node === null ? 'Focus cleared.' : `Focus → #${a.node}.`;
    });

  return server;
}
