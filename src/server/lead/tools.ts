import { execFile } from 'node:child_process';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { LEAD_INSTRUCTIONS_VERSION } from '../../core/lead';
import type { SearchResult } from '../../core/types';
import { ApiClientError, type Client } from '../../lib/client';
import { VERSION } from '../../lib/version';
import { formatSearch } from '../../mcp/format';

/** The most one answer may carry: a turn's context is not the place for a whole log. */
export const TOOL_ANSWER_MAX_BYTES = 40 * 1024;
/** The most file names change_size lists. */
const FILES_MAX = 200;
const GIT_TIMEOUT_MS = 10_000;
/** What every tool answers when nothing listens: said the same way each time, and nothing is started. */
export const NOT_ANSWERING = 'InProgress is not answering';
const BRANCH = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,199}$/;

export interface LeadToolsOptions {
  /** The project's slug. */
  slug: string;
  /** A client with no way to start a server: a call that finds none down says so. */
  client: Client;
  /** The folder git facts are read in. Without it the git tools say there is no repository. */
  repo?: string;
  /** The lead's name, as the project knows it. */
  as: string;
  /** The rules version the lead works to. */
  instructions: number;
}

type ToolResult = { content: { type: 'text'; text: string }[]; isError?: boolean };

/** The answer cut to the cap, with a last line saying so. */
export function capAnswer(text: string): string {
  const bytes = Buffer.from(text, 'utf8');
  if (bytes.length <= TOOL_ANSWER_MAX_BYTES) return text;
  const kept = bytes.subarray(0, TOOL_ANSWER_MAX_BYTES).toString('utf8').replace(/�+$/, '');
  return `${kept}\n[Cut: the answer was ${bytes.length} bytes and the limit is ${TOOL_ANSWER_MAX_BYTES}.]`;
}

export type LeadToolsStart = { ok: true; slug: string; port: number; as: string; instructions: number; repo?: string } | { ok: false; error: string };

/** The environment and arguments the tool server needs, or the line to say why it will not start. No fallback to a default home or port. */
export function checkLeadToolsStart(env: NodeJS.ProcessEnv, argv: string[]): LeadToolsStart {
  const slug = argv[0]?.trim();
  if (!slug) return { ok: false, error: 'lead tools: no project given. Usage: node dist/lead/tools.js <slug>' };
  if (!env.INPROGRESS_HOME?.trim()) return { ok: false, error: 'lead tools: INPROGRESS_HOME is not set, and this server will not guess a data folder' };
  const rawPort = env.INPROGRESS_PORT?.trim();
  if (!rawPort) return { ok: false, error: 'lead tools: INPROGRESS_PORT is not set, and this server will not guess a port' };
  const port = Number(rawPort);
  if (!Number.isInteger(port) || port < 1 || port > 65535) return { ok: false, error: `lead tools: INPROGRESS_PORT is "${rawPort}", not a port number` };
  const as = env.INPROGRESS_LEAD_AS?.trim();
  if (!as) return { ok: false, error: "lead tools: INPROGRESS_LEAD_AS is not set: the lead's name is needed to read as it" };
  const repo = env.INPROGRESS_LEAD_REPO?.trim();
  return { ok: true, slug, port, as, instructions: LEAD_INSTRUCTIONS_VERSION, ...(repo ? { repo } : {}) };
}

const ok = (text: string): ToolResult => ({ content: [{ type: 'text', text: capAnswer(text) }] });
const fail = (text: string): ToolResult => ({ isError: true, content: [{ type: 'text', text }] });
const enc = encodeURIComponent;

/** Runs git without a shell. Resolves with the exit code and output: a non-zero exit is an answer, not a throw. */
function git(repo: string, args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    execFile('git', args, { cwd: repo, timeout: GIT_TIMEOUT_MS, maxBuffer: 4 * 1024 * 1024, windowsHide: true, env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } }, (err, stdout, stderr) => {
      if (!err) return resolve({ code: 0, stdout, stderr });
      const code = (err as { code?: unknown }).code;
      if (typeof code === 'number') return resolve({ code, stdout, stderr });
      reject(new Error(`git ${args[0]} did not finish: ${err.message}`));
    });
  });
}

/** The lead's read-only tools: eight reads, no write of any kind, nothing that starts InProgress. */
export function createLeadToolsServer(o: LeadToolsOptions): McpServer {
  const server = new McpServer({ name: 'inprogress-lead', version: VERSION });
  const project = enc(o.slug);
  const asked = `as=${enc(o.as)}&instructions=${o.instructions}`;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const tool = (name: string, description: string, shape: z.ZodRawShape, run: (args: any) => Promise<string>) => {
    server.registerTool(name, { description, inputSchema: shape }, async (args: unknown) => {
      try {
        return ok(await run(args));
      } catch (err) {
        if (err instanceof ApiClientError && err.status === 0) return fail(NOT_ANSWERING);
        if (err instanceof ApiClientError) return fail(err.hint ? `${err.message}. ${err.hint}` : err.message);
        return fail(err instanceof Error ? err.message : String(err));
      }
    });
  };
  /** Git's answer for a branch tool, or the reason it was not asked. */
  const onBranch = (branch: string, run: (repo: string) => Promise<string>): Promise<string> => {
    if (!BRANCH.test(branch) || branch.includes('..')) return Promise.resolve(`Not a branch name: ${branch}`);
    if (!o.repo) return Promise.resolve('No repository for this project');
    return run(o.repo);
  };

  tool('desk', "The lead's desk: its open items, oldest first, with their limits.", {}, async () => (await o.client.get<{ text: string }>(`/api/lead/${project}/desk`)).text);
  tool('brief', "The lead's brief for this project: what landed, what is stuck and what is owed. Reading it marks nothing.", {}, async () =>
    (await o.client.get<{ text: string }>(`/api/lead/${project}/brief?${asked}`)).text);
  tool('step', 'One step in full: its text, state, log and resources, as `lead step` prints it.', { id: z.number().int().positive().describe('The step number: the number after "#"') },
    async (a: { id: number }) => (await o.client.get<{ text: string }>(`/api/lead/${project}/step/${a.id}?${asked}`)).text);
  tool('resource', 'One document stored in InProgress, as `lead resource` prints it.', { id: z.number().int().positive().describe('The resource number: the number after "r"') },
    async (a: { id: number }) => (await o.client.get<{ text: string }>(`/api/lead/${project}/resource/${a.id}?${asked}`)).text);
  tool('search', 'Find steps and resources in this project by text.', { query: z.string().min(1) },
    async (a: { query: string }) => formatSearch(await o.client.get<SearchResult>(`/api/search?project=${project}&q=${enc(a.query)}`)));

  const branchArg = { branch: z.string().describe('A local branch name, e.g. feature/tabs') };
  tool('branch_merged', 'Whether a branch is merged into main.', branchArg, (a: { branch: string }) =>
    onBranch(a.branch, async (repo) => {
      const r = await git(repo, ['merge-base', '--is-ancestor', `refs/heads/${a.branch}`, 'refs/heads/main']);
      if (r.code === 0) return `${a.branch} is merged into main`;
      if (r.code === 1) return `${a.branch} is not merged into main`;
      return `Could not tell: git said ${r.stderr.trim() || `exit ${r.code}`}`;
    }));
  tool('change_size', "How big a branch's change against main is: the shortstat and the files it touches (at most 200 listed).", branchArg, (a: { branch: string }) =>
    onBranch(a.branch, async (repo) => {
      const range = `refs/heads/main...refs/heads/${a.branch}`;
      const [stat, names] = await Promise.all([git(repo, ['diff', '--shortstat', range]), git(repo, ['diff', '--name-only', range])]);
      const bad = [stat, names].find((r) => r.code !== 0);
      if (bad) return `Could not tell: git said ${bad.stderr.trim() || `exit ${bad.code}`}`;
      const files = names.stdout.split('\n').filter(Boolean);
      const lines = [stat.stdout.trim() || `${a.branch} changes nothing against main`, ...files.slice(0, FILES_MAX)];
      if (files.length > FILES_MAX) lines.push(`... and ${files.length - FILES_MAX} more files`);
      return lines.join('\n');
    }));
  tool('branch_exists', 'Whether a local branch of that name exists.', branchArg, (a: { branch: string }) =>
    onBranch(a.branch, async (repo) => {
      const r = await git(repo, ['rev-parse', '--verify', '--quiet', `refs/heads/${a.branch}`]);
      if (r.code === 0) return `${a.branch} exists`;
      if (r.code === 1) return `${a.branch} does not exist`;
      return `Could not tell: git said ${r.stderr.trim() || `exit ${r.code}`}`;
    }));

  return server;
}
