import { existsSync, readFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import Database from 'better-sqlite3';
import { readToken } from '../lib/home';
import { buildLabel, readBuild, sameBuild, VERSION, type BuildInfo } from '../lib/version';
import { allowRules, HOOK_DEFS, isInProgressHook, nodeBinary, settingsShapeError } from './claude-config';
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
  /** The deployed build to compare the running server with; defaults to this CLI's own dist/build.json. */
  build?: BuildInfo | null;
}

type Json = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
type HookGroup = { hooks?: { command?: string; args?: string[] }[] };

/**
 * settings.json's contents, read as install reads them (a leading BOM is ignored, an empty file is {}): no value when
 * the file does not exist, `error` when it cannot be read, parsed, or used.
 */
function readJson(file: string): { value?: Json; error?: string } {
  if (!existsSync(file)) return {};
  let value: unknown;
  try {
    const text = readFileSync(file, 'utf8').replace(/^\uFEFF/, '');
    value = text.trim() ? JSON.parse(text) : {};
  } catch (err) {
    return { error: `settings.json is not valid JSON: ${(err as Error).message}` };
  }
  const problem = settingsShapeError(value);
  return problem ? { error: `settings.json: ${problem}` } : { value: value as Json };
}

const invalidSettings = (file: string, error: string): string =>
  `${error}: fix ${file} by hand, or restore its newest settings.json.inprogress-backup-<stamp> copy`;

async function serverCheck(baseUrl: string, deployed: BuildInfo | null): Promise<Check> {
  try {
    const res = await fetch(`${baseUrl}/api/health`, { signal: AbortSignal.timeout(1000) });
    // An answer that is not JSON (another program's web page) is not InProgress either.
    const body = (await res.json().catch(() => ({}))) as { app?: string; version?: string; build?: BuildInfo | null };
    if (body.app !== 'inprogress') {
      return { name: 'Server', ok: false, detail: `${baseUrl} answers but is not InProgress: another program holds the port; set INPROGRESS_PORT to pick another port` };
    }
    if (body.version !== VERSION) return { name: 'Server', ok: false, detail: `running ${body.version}, built ${VERSION}: run \`inprogress stop\`; the next session starts the new build` };
    if (!sameBuild(body.build, deployed)) {
      return { name: 'Server', ok: false, detail: `running build ${buildLabel(body.build)}, deployed ${buildLabel(deployed)}: run \`inprogress stop\`, then \`inprogress start\`` };
    }
    return { name: 'Server', ok: true, detail: `running ${body.version} ${buildLabel(body.build ?? deployed)} at ${baseUrl}` };
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
  let db: Database.Database | undefined;
  try {
    db = new Database(file, { readonly: true, fileMustExist: true });
    const result = db.pragma('quick_check', { simple: true });
    return { name: 'Database', ok: result === 'ok', detail: result === 'ok' ? 'integrity ok' : `${String(result)}: ${restoreHint(file)}` };
  } catch (err) {
    return { name: 'Database', ok: false, detail: `${(err as Error).message}: ${restoreHint(file)}` };
  } finally {
    // A damaged file fails at the pragma, after the open: close it either way, or Windows keeps the file locked.
    db?.close();
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
  if (!existsSync(entry)) return { name: 'MCP server', ok: false, detail: `${entry} is missing: run npm run deploy` };
  const fix = 'run npm run deploy, then `inprogress doctor` again';
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

/** A path for comparison: forward slashes, and on Windows no case. */
const pathKey = (path: string): string => {
  const slashed = path.replace(/\\/g, '/');
  return process.platform === 'win32' ? slashed.toLowerCase() : slashed;
};

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
  if (badScript) return fail(`hook script ${badScript} no longer exists: run npm run deploy, or rerun npm run claude:install if the repo moved`);
  // The hooks keep the Node that ran install. After an nvm switch this shell runs another one, and once the repo's
  // native modules are rebuilt for it, a server the hooks start under the old Node cannot load better-sqlite3.
  const node = nodeBinary();
  const otherNode = ours.map((h) => h.command).find((command) => command && pathKey(command) !== pathKey(node));
  if (otherNode) {
    return { name: 'Hooks', ok: false, warnOnly: true, detail: `hooks run ${otherNode}; this shell's node is ${node}: after an nvm switch, rerun npm run claude:install` };
  }
  return { name: 'Hooks', ok: true, detail: 'all installed' };
}

export async function runChecks(o: DoctorOptions): Promise<Check[]> {
  const server = await serverCheck(o.baseUrl, o.build === undefined ? readBuild() : o.build);
  const checks: Check[] = [server];
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
  // The rules install writes for this repo, the tasks command's among them: another checkout's tasks rules never match.
  const rules = allowRules(o.repo);
  const allow: string[] = settings.value?.permissions?.allow ?? [];
  const missingRules = rules.filter((r) => !allow.includes(r));
  checks.push(
    settings.error
      ? { name: 'Allow rules', ok: false, detail: invalidSettings(settingsFile, settings.error) }
      : {
          name: 'Allow rules',
          ok: missingRules.length === 0,
          detail: missingRules.length ? `missing: ${missingRules.join(', ')}: run npm run claude:install` : rules.join(', '),
        },
  );
  if (!o.skipMcp) {
    // Without a working server the MCP server cannot answer either: it would take seconds to fail and blame the build.
    checks.push(server.ok ? await mcpCheck(join(o.repo, 'dist', 'mcp', 'main.js')) : { name: 'MCP server', ok: false, warnOnly: true, detail: 'skipped: server check failed' });
  }
  const edge = findEdge();
  checks.push({ name: 'Edge', ok: !!edge, detail: edge ?? 'not found: `inprogress open` will use the default browser', warnOnly: true });
  return checks;
}

export async function doctor(o: DoctorOptions, out: (line: string) => void): Promise<number> {
  const checks = await runChecks(o);
  for (const c of checks) out(`${c.ok ? '✓' : c.warnOnly ? '!' : '✗'} ${c.name}: ${c.detail}`);
  return checks.every((c) => c.ok || c.warnOnly) ? 0 : 1;
}
