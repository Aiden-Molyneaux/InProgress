import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import Database from 'better-sqlite3';
import { readToken } from '../lib/home';
import { VERSION } from '../lib/version';
import { ALLOW_RULES, HOOK_DEFS, isInProgressHook } from './claude-config';
import { findEdge } from './open';

export interface Check {
  name: string;
  ok: boolean;
  detail: string;
  warnOnly?: boolean;
}

export interface DoctorOptions {
  baseUrl: string;
  home: string;
  claudeDir: string;
  repo: string;
  skipMcp?: boolean;
}

function readJson(file: string): Record<string, any> | undefined { // eslint-disable-line @typescript-eslint/no-explicit-any
  try {
    return JSON.parse(readFileSync(file, 'utf8'));
  } catch {
    return undefined;
  }
}

async function serverCheck(baseUrl: string): Promise<Check> {
  try {
    const res = await fetch(`${baseUrl}/api/health`, { signal: AbortSignal.timeout(1000) });
    const body = (await res.json()) as { app?: string; version?: string };
    if (body.app !== 'inprogress') return { name: 'Server', ok: false, detail: `${baseUrl} answers but is not InProgress` };
    if (body.version !== VERSION) return { name: 'Server', ok: false, detail: `running ${body.version}, built ${VERSION}: run \`inprogress stop\`; the next session starts the new build` };
    return { name: 'Server', ok: true, detail: `running ${body.version} at ${baseUrl}` };
  } catch {
    return { name: 'Server', ok: false, detail: 'not running: run `inprogress start` and check server.log' };
  }
}

function dbCheck(file: string): Check {
  if (!existsSync(file)) return { name: 'Database', ok: false, detail: `${file} is missing: start the server once` };
  try {
    const db = new Database(file, { readonly: true, fileMustExist: true });
    const result = db.pragma('quick_check', { simple: true });
    db.close();
    return { name: 'Database', ok: result === 'ok', detail: result === 'ok' ? 'integrity ok' : String(result) };
  } catch (err) {
    return { name: 'Database', ok: false, detail: (err as Error).message };
  }
}

function agentCheck(file: string): Check {
  if (!existsSync(file)) return { name: 'Scribe agent', ok: false, detail: `${file} is missing: run npm run claude:install` };
  const text = readFileSync(file, 'utf8');
  const front = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text)?.[1] ?? '';
  const missing = ['name: inprogress-scribe', 'model:', 'tools: mcp__inprogress', 'mcpServers:', 'dist/mcp/main.js'].filter((k) => !front.includes(k));
  return missing.length ? { name: 'Scribe agent', ok: false, detail: `frontmatter missing: ${missing.join(', ')}` } : { name: 'Scribe agent', ok: true, detail: file };
}

async function mcpCheck(entry: string): Promise<Check> {
  if (!existsSync(entry)) return { name: 'MCP server', ok: false, detail: `${entry} is missing: run npm run build` };
  const client = new Client({ name: 'inprogress-doctor', version: VERSION });
  try {
    await client.connect(new StdioClientTransport({ command: process.execPath, args: [entry], env: { ...process.env } as Record<string, string> }));
    const res = (await client.callTool({ name: 'list_projects', arguments: {} })) as { isError?: boolean; content: { text?: string }[] };
    await client.close();
    return { name: 'MCP server', ok: !res.isError, detail: res.isError ? String(res.content[0]?.text) : 'answers list_projects' };
  } catch (err) {
    return { name: 'MCP server', ok: false, detail: (err as Error).message };
  }
}

export async function runChecks(o: DoctorOptions): Promise<Check[]> {
  const checks: Check[] = [await serverCheck(o.baseUrl)];
  const token = readToken(o.home);
  checks.push({ name: 'Token', ok: !!token, detail: token ? 'readable' : `missing at ${join(o.home, 'token')}: start the server once` });
  checks.push(dbCheck(join(o.home, 'inprogress.db')));
  const settings = readJson(join(o.claudeDir, 'settings.json'));
  const missingHooks = HOOK_DEFS.filter(
    (d) => !(settings?.hooks?.[d.event] ?? []).some((g: { hooks?: { args?: string[]; command?: string }[] }) => (g.hooks ?? []).some((h) => isInProgressHook(h))),
  ).map((d) => d.event);
  const ourHooks = (Object.values(settings?.hooks ?? {}) as { hooks?: { command?: string; args?: string[] }[] }[][])
    .flat()
    .flatMap((g) => g.hooks ?? [])
    .filter((h) => isInProgressHook(h));
  const badBinary = ourHooks.find((h) => h.command && /[\\/]/.test(h.command) && !existsSync(h.command))?.command;
  checks.push({
    name: 'Hooks',
    ok: missingHooks.length === 0 && !badBinary,
    detail: missingHooks.length
      ? `missing: ${missingHooks.join(', ')}: run npm run claude:install`
      : badBinary
        ? `node binary ${badBinary} no longer exists: rerun npm run claude:install`
        : 'all installed',
  });
  checks.push(agentCheck(join(o.claudeDir, 'agents', 'inprogress-scribe.md')));
  const skill = join(o.claudeDir, 'skills', 'inprogress', 'SKILL.md');
  checks.push({ name: 'Skill', ok: existsSync(skill), detail: skill });
  const allow: string[] = settings?.permissions?.allow ?? [];
  const missingRules = ALLOW_RULES.filter((r) => !allow.includes(r));
  checks.push({ name: 'Allow rules', ok: missingRules.length === 0, detail: missingRules.length ? `missing: ${missingRules.join(', ')}` : ALLOW_RULES.join(', ') });
  if (!o.skipMcp) checks.push(await mcpCheck(join(o.repo, 'dist', 'mcp', 'main.js')));
  const edge = findEdge();
  checks.push({ name: 'Edge', ok: !!edge, detail: edge ?? 'not found: `inprogress open` will use the default browser', warnOnly: true });
  return checks;
}

export async function doctor(o: DoctorOptions, out: (line: string) => void): Promise<number> {
  const checks = await runChecks(o);
  for (const c of checks) out(`${c.ok ? '✓' : c.warnOnly ? '!' : '✗'} ${c.name}: ${c.detail}`);
  return checks.every((c) => c.ok || c.warnOnly) ? 0 : 1;
}
