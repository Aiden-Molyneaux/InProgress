import { existsSync, readFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
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

type Json = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
type HookGroup = { hooks?: { command?: string; args?: string[] }[] };

/** A JSON file's contents: no value when the file does not exist, `error` when it cannot be read or parsed. */
function readJson(file: string): { value?: Json; error?: string } {
  if (!existsSync(file)) return {};
  try {
    return { value: JSON.parse(readFileSync(file, 'utf8')) };
  } catch (err) {
    return { error: (err as Error).message };
  }
}

const invalidSettings = (file: string, error: string): string =>
  `settings.json is not valid JSON: ${error}: fix ${file} by hand, or restore its newest settings.json.inprogress-backup-<stamp> copy`;

async function serverCheck(baseUrl: string): Promise<Check> {
  try {
    const res = await fetch(`${baseUrl}/api/health`, { signal: AbortSignal.timeout(1000) });
    // An answer that is not JSON (another program's web page) is not InProgress either.
    const body = (await res.json().catch(() => ({}))) as { app?: string; version?: string };
    if (body.app !== 'inprogress') {
      return { name: 'Server', ok: false, detail: `${baseUrl} answers but is not InProgress: another program holds the port; set INPROGRESS_PORT to pick another port` };
    }
    if (body.version !== VERSION) return { name: 'Server', ok: false, detail: `running ${body.version}, built ${VERSION}: run \`inprogress stop\`; the next session starts the new build` };
    return { name: 'Server', ok: true, detail: `running ${body.version} at ${baseUrl}` };
  } catch {
    return { name: 'Server', ok: false, detail: 'not running: run `inprogress start` and check server.log' };
  }
}

/**
 * How to go back to a backup: the server keeps its newest 7 as backups/inprogress-<stamp>.db (backup.ts). A leftover
 * -wal file would be replayed onto the restored copy, so it goes first.
 */
function restoreHint(file: string): string {
  const dir = dirname(file);
  return `run \`inprogress stop\`, delete any ${basename(file)}-wal and -shm in ${dir}, then copy the newest ${join(dir, 'backups', 'inprogress-<stamp>.db')} over ${file}`;
}

function dbCheck(file: string): Check {
  if (!existsSync(file)) return { name: 'Database', ok: false, detail: `${file} is missing: start the server once` };
  try {
    const db = new Database(file, { readonly: true, fileMustExist: true });
    const result = db.pragma('quick_check', { simple: true });
    db.close();
    return { name: 'Database', ok: result === 'ok', detail: result === 'ok' ? 'integrity ok' : `${String(result)}: ${restoreHint(file)}` };
  } catch (err) {
    return { name: 'Database', ok: false, detail: `${(err as Error).message}: ${restoreHint(file)}` };
  }
}

function agentCheck(file: string): Check {
  if (!existsSync(file)) return { name: 'Scribe agent', ok: false, detail: `${file} is missing: run npm run claude:install` };
  const text = readFileSync(file, 'utf8');
  const front = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text)?.[1] ?? '';
  const missing = ['name: inprogress-scribe', 'model:', 'tools: mcp__inprogress', 'mcpServers:', 'dist/mcp/main.js'].filter((k) => !front.includes(k));
  return missing.length
    ? { name: 'Scribe agent', ok: false, detail: `frontmatter missing: ${missing.join(', ')}: rerun npm run claude:install` }
    : { name: 'Scribe agent', ok: true, detail: file };
}

async function mcpCheck(entry: string): Promise<Check> {
  if (!existsSync(entry)) return { name: 'MCP server', ok: false, detail: `${entry} is missing: run npm run build` };
  const fix = 'run npm run build, then `inprogress doctor` again';
  const client = new Client({ name: 'inprogress-doctor', version: VERSION });
  try {
    await client.connect(new StdioClientTransport({ command: process.execPath, args: [entry], env: { ...process.env } as Record<string, string> }));
    const res = (await client.callTool({ name: 'list_projects', arguments: {} })) as { isError?: boolean; content: { text?: string }[] };
    await client.close();
    return { name: 'MCP server', ok: !res.isError, detail: res.isError ? `${String(res.content[0]?.text)}: ${fix}` : 'answers list_projects' };
  } catch (err) {
    return { name: 'MCP server', ok: false, detail: `${(err as Error).message}: ${fix}` };
  }
}

function hooksCheck(file: string, settings: { value?: Json; error?: string }): Check {
  const fail = (detail: string): Check => ({ name: 'Hooks', ok: false, detail });
  if (settings.error) return fail(invalidSettings(file, settings.error));
  const hooks: Record<string, HookGroup[]> = settings.value?.hooks ?? {};
  const missing = HOOK_DEFS.filter((d) => !(hooks[d.event] ?? []).some((g) => (g.hooks ?? []).some((h) => isInProgressHook(h)))).map((d) => d.event);
  if (missing.length) return fail(`missing: ${missing.join(', ')}: run npm run claude:install`);
  const ours = Object.values(hooks)
    .flat()
    .flatMap((g) => g.hooks ?? [])
    .filter((h) => isInProgressHook(h));
  const badBinary = ours.find((h) => h.command && /[\\/]/.test(h.command) && !existsSync(h.command))?.command;
  if (badBinary) return fail(`node binary ${badBinary} no longer exists: rerun npm run claude:install`);
  // A moved repo or a deleted dist/ leaves the hooks pointing at a script that is gone.
  const badScript = ours.map((h) => h.args?.[0]).find((script) => script && !existsSync(script));
  if (badScript) return fail(`hook script ${badScript} no longer exists: run npm run build, or rerun npm run claude:install if the repo moved`);
  return { name: 'Hooks', ok: true, detail: 'all installed' };
}

export async function runChecks(o: DoctorOptions): Promise<Check[]> {
  const checks: Check[] = [await serverCheck(o.baseUrl)];
  const token = readToken(o.home);
  checks.push({ name: 'Token', ok: !!token, detail: token ? 'readable' : `missing at ${join(o.home, 'token')}: start the server once` });
  checks.push(dbCheck(join(o.home, 'inprogress.db')));
  const settingsFile = join(o.claudeDir, 'settings.json');
  const settings = readJson(settingsFile);
  checks.push(hooksCheck(settingsFile, settings));
  checks.push(agentCheck(join(o.claudeDir, 'agents', 'inprogress-scribe.md')));
  const skill = join(o.claudeDir, 'skills', 'inprogress', 'SKILL.md');
  const hasSkill = existsSync(skill);
  checks.push({ name: 'Skill', ok: hasSkill, detail: hasSkill ? skill : `${skill} is missing: run npm run claude:install` });
  const allow: string[] = settings.value?.permissions?.allow ?? [];
  const missingRules = ALLOW_RULES.filter((r) => !allow.includes(r));
  checks.push(
    settings.error
      ? { name: 'Allow rules', ok: false, detail: invalidSettings(settingsFile, settings.error) }
      : {
          name: 'Allow rules',
          ok: missingRules.length === 0,
          detail: missingRules.length ? `missing: ${missingRules.join(', ')}: run npm run claude:install` : ALLOW_RULES.join(', '),
        },
  );
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
