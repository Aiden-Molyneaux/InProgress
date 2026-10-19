import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import Database from 'better-sqlite3';
import { readToken } from '../lib/home';
import { parseStamp } from '../server/backup';
import { buildLabel, readBuild, sameBuild, VERSION, type BuildInfo } from '../lib/version';
import { allowRules, HOOK_DEFS, isInProgressHook, nodeBinary, settingsShapeError, SKILL_NAMES } from './claude-config';
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
  /** The clock for the Backups check's ages; defaults to the real one. */
  now?: Date;
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
 * How to go back to a backup: the server keeps tiered snapshots as backups/inprogress-<stamp>.db (backup.ts), and
 * `inprogress restore` does the swap. By hand, a leftover -wal file would be replayed onto the restored copy, so it goes first.
 */
function restoreHint(file: string): string {
  const dir = dirname(file);
  return `run \`inprogress stop\`, delete any ${basename(file)}-wal and -shm in ${dir}, then copy the newest ${join(dir, 'backups', 'inprogress-<stamp>.db')} over ${file}, or run \`inprogress restore\` (newest snapshot) or \`inprogress restore --from ${join(dir, 'offsite')}\``;
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

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

const ago = (ms: number): string => (ms >= DAY_MS ? `${Math.floor(ms / DAY_MS)} d` : `${Math.floor(ms / HOUR_MS)} h`);

/** Runs git in the backup repo without touching the network; nothing when it fails. */
function gitQuiet(dir: string, args: string[]): string | undefined {
  try {
    return execFileSync('git', ['-C', dir, ...args], { encoding: 'utf8', windowsHide: true, timeout: 10_000, stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  } catch {
    // Not a repo, no such ref, or no git: each reads as "nothing to report" and the caller says what is missing.
    return undefined;
  }
}

/** The stored result of the last backup drill, read without writing; nothing when there is none. */
function readDrill(file: string): { at: string; ok: boolean; detail: string } | undefined {
  if (!existsSync(file)) return undefined;
  let db: Database.Database | undefined;
  try {
    db = new Database(file, { readonly: true, fileMustExist: true });
    const raw = db.prepare("SELECT value FROM meta WHERE key = 'backup_drill'").pluck().get() as string | undefined;
    return raw ? (JSON.parse(raw) as { at: string; ok: boolean; detail: string }) : undefined;
  } catch {
    // An unreadable database is the Database check's to report; here it only means no drill is known.
    return undefined;
  } finally {
    db?.close();
  }
}

/**
 * The backups: the newest snapshot (stale after 26 hours while the server is up), the newest pushed commit (warns after
 * 3 days, fails after 7), the last drill (warns when missing, failed or over 14 days old) and the backup repo's size
 * (warns over 500 MB). Only a push over 7 days old fails the run.
 */
export function backupsCheck(home: string, serverUp: boolean, now: Date): Check {
  const warnings: string[] = [];
  let fail = false;
  const parts: string[] = [];
  // Snapshots
  const dir = join(home, 'backups');
  const newest = (existsSync(dir) ? readdirSync(dir) : []).filter((f) => parseStamp(f)).sort().pop();
  if (newest) {
    // A tick that finds nothing changed touches the newest snapshot instead of writing another, so its mtime counts too.
    const age = now.getTime() - Math.max(parseStamp(newest)!.getTime(), statSync(join(dir, newest)).mtimeMs);
    parts.push(`newest snapshot ${newest} (${ago(age)} ago)`);
    if (age > 26 * HOUR_MS && serverUp) warnings.push('the newest snapshot is over 26 hours old');
  } else {
    parts.push(`no snapshot in ${dir}`);
    if (serverUp) warnings.push('no snapshot yet');
  }
  // Pushed commit, drill and size
  const repo = join(home, 'offsite');
  const pushedAt = existsSync(join(repo, '.git')) ? gitQuiet(repo, ['log', '-1', '--format=%cI', 'origin/main']) : undefined;
  if (!existsSync(join(repo, '.git'))) {
    parts.push('not set up: run inprogress backup --init <remote url>');
    warnings.push('the off-machine copy is not set up');
  } else if (!pushedAt) {
    parts.push('no pushed commit yet: run inprogress backup --push');
    warnings.push('nothing is pushed yet');
  } else {
    const age = now.getTime() - new Date(pushedAt).getTime();
    parts.push(`newest pushed commit ${ago(age)} ago`);
    if (age > 7 * DAY_MS) {
      fail = true;
      warnings.push('the newest pushed commit is over 7 days old');
    } else if (age > 3 * DAY_MS) {
      warnings.push('the newest pushed commit is over 3 days old');
    }
  }
  if (existsSync(join(repo, '.git'))) {
    const drill = readDrill(join(home, 'inprogress.db'));
    if (!drill) {
      parts.push('no drill yet');
      warnings.push('the backup has never been drilled');
    } else {
      const age = now.getTime() - Date.parse(drill.at);
      parts.push(`last drill ${drill.ok ? 'passed' : `FAILED (${drill.detail})`} ${ago(age)} ago`);
      if (!drill.ok) warnings.push('the last drill failed');
      else if (age > 14 * DAY_MS) warnings.push('the last drill is over 14 days old');
    }
    const counts = gitQuiet(repo, ['count-objects', '-v']);
    if (counts !== undefined) {
      const kib = (key: string) => Number(new RegExp(`^${key}: (\\d+)$`, 'm').exec(counts)?.[1] ?? 0);
      const total = kib('size-pack') + kib('size');
      parts.push(`repo ${(total / 1024).toFixed(1)} MB`);
      if (total > 500 * 1024) warnings.push('the backup repo is over 500 MB');
    }
  }
  const detail = parts.join('; ');
  if (!warnings.length) return { name: 'Backups', ok: true, detail };
  return { name: 'Backups', ok: false, warnOnly: !fail, detail: `${warnings.join('; ')} (${detail})` };
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
  const missing = [...new Set(HOOK_DEFS.filter((d) => !(hooks[d.event] ?? []).some((g) => (g.hooks ?? []).some((h) => isInProgressHook(h)))).map((d) => d.event))];
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
  checks.push(backupsCheck(o.home, server.ok, o.now ?? new Date()));
  const settingsFile = join(o.claudeDir, 'settings.json');
  const settings = readJson(settingsFile);
  checks.push(hooksCheck(settingsFile, settings));
  checks.push(agentCheck(join(o.claudeDir, 'agents', 'inprogress-scribe.md')));
  const skills = SKILL_NAMES.map((name) => join(o.claudeDir, 'skills', name, 'SKILL.md'));
  const missingSkill = skills.find((f) => !existsSync(f));
  checks.push({ name: 'Skill', ok: !missingSkill, detail: missingSkill ? `${missingSkill} is missing: run npm run claude:install` : skills.join(', ') });
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
