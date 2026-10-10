import { constants, copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { HOOK_NAMES, type HookName } from '../hooks/handlers';
import { homeDir } from '../lib/home';
import { normalizePath } from '../lib/paths';
import { isTaskAllowRule, repoCli, taskAllowRules, taskPrefix } from '../lib/task-command';

/** The allow rules that are the same for every repo: the scribe's tools and its resource snapshots. */
export const STATIC_ALLOW_RULES = ['mcp__inprogress', 'Edit(~/.inprogress/resources/**)'];
export const HOOK_SCRIPT_SUFFIX = '/dist/hooks/hook.js';
const NOT_SCRIBE = '^(?!inprogress-scribe$).*';
/** What the hooks and the scribe's MCP server run: install refuses without them. */
const BUILT_ENTRIES = ['dist/hooks/hook.js', 'dist/mcp/main.js'];
const BACKUP_PREFIX = 'settings.json.inprogress-backup-';
const BACKUPS_KEPT = 5;

export interface HookDef {
  event: string;
  name: HookName;
  matcher?: string;
  timeout: number;
  /** Written as `"async": true`: Claude Code runs the hook in the background, so the tool call never waits on it. */
  async?: boolean;
}

export const HOOK_DEFS: HookDef[] = [
  { event: 'SessionStart', name: 'session-start', timeout: 10 },
  { event: 'UserPromptSubmit', name: 'prompt-submit', timeout: 5 },
  { event: 'Stop', name: 'stop', timeout: 5 },
  { event: 'Notification', name: 'notification', matcher: 'permission_prompt', timeout: 5 },
  { event: 'SubagentStart', name: 'subagent-start', matcher: NOT_SCRIBE, timeout: 5 },
  { event: 'SubagentStop', name: 'subagent-stop', matcher: NOT_SCRIBE, timeout: 5 },
  { event: 'SessionEnd', name: 'session-end', timeout: 5 },
  // Live work: a subagent's dispatch before the Agent tool runs; its launch, and the task tools' changes, after.
  { event: 'PreToolUse', name: 'pre-tool', matcher: '^(Agent|Task)$', timeout: 5 },
  { event: 'PostToolUse', name: 'post-tool', matcher: '^(Agent|Task|TaskCreate|TaskUpdate)$', timeout: 5 },
  // Background commands, messages to agents and stopped tasks, after the call. Async: about 2,700 Bash calls a day must
  // never wait on a Node start. The hook posts a command's start, its stop, a stopped agent and a message to one
  // (buildToolHookBody), and also copies these inputs to the capture folder (src/hooks/capture.ts).
  { event: 'PostToolUse', name: 'post-tool', matcher: '^(Bash|PowerShell|Monitor|SendMessage|TaskStop)$', timeout: 5, async: true },
];

type HookEntry = { type?: string; command?: string; args?: string[]; timeout?: number; async?: boolean };
type HookGroup = { matcher?: string; hooks?: HookEntry[] };
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Settings = Record<string, any>;

/** Claude's config dir: INPROGRESS_CLAUDE_DIR (tests), else Claude Code's own CLAUDE_CONFIG_DIR, else ~/.claude. */
export function claudeDir(): string {
  const configured = process.env.INPROGRESS_CLAUDE_DIR || process.env.CLAUDE_CONFIG_DIR;
  if (!configured) return join(homedir(), '.claude');
  return isAbsolute(configured) ? configured : resolve(configured);
}

/** Repo root from the bundled CLI at dist/cli/main.js. */
export function repoRoot(): string {
  return resolve(fileURLToPath(new URL('../..', import.meta.url))).replace(/\\/g, '/');
}

/**
 * The Node binary running the installer, as an absolute forward-slash path. Hooks and the scribe's MCP server use it
 * instead of relying on `node` being on the PATH the Claude desktop app inherits. The real path, not a symlink such as
 * nvm4w's, so switching Node versions cannot silently change the runtime under the hooks, the scribe and the server.
 */
export function nodeBinary(execPath: string = process.execPath): string {
  return realpathSync(execPath).replace(/\\/g, '/');
}

export function hookEntry(repo: string, name: HookName, timeout: number, async = false): HookEntry {
  return { type: 'command', command: nodeBinary(), args: [`${repo}${HOOK_SCRIPT_SUFFIX}`, name], timeout, ...(async ? { async: true } : {}) };
}

/**
 * Only an exec-form entry running `<...>/dist/hooks/hook.js <InProgress hook name>` is ours. Shell-form
 * commands and other tools' exec-form hooks, even with the same script layout, are left alone.
 */
export function isInProgressHook(entry: HookEntry): boolean {
  if (!Array.isArray(entry.args)) return false;
  const [script, name] = entry.args;
  return typeof script === 'string' && script.replace(/\\/g, '/').endsWith(HOOK_SCRIPT_SUFFIX) && (HOOK_NAMES as readonly string[]).includes(name);
}

export function stripInProgressHooks(settings: Settings): Settings {
  const hooks = settings.hooks as Record<string, HookGroup[]> | undefined;
  if (!hooks) return settings;
  for (const [event, groups] of Object.entries(hooks)) {
    const kept = groups
      .map((g) => ({ ...g, hooks: (g.hooks ?? []).filter((h) => !isInProgressHook(h)) }))
      .filter((g) => g.hooks.length > 0);
    if (kept.length) hooks[event] = kept;
    else delete hooks[event];
  }
  if (Object.keys(hooks).length === 0) delete settings.hooks;
  return settings;
}

export function addInProgressHooks(settings: Settings, repo: string): Settings {
  stripInProgressHooks(settings);
  settings.hooks ??= {};
  for (const d of HOOK_DEFS) {
    const group: HookGroup = { ...(d.matcher ? { matcher: d.matcher } : {}), hooks: [hookEntry(repo, d.name, d.timeout, d.async)] };
    (settings.hooks[d.event] ??= []).push(group);
  }
  return settings;
}

/**
 * Every allow rule install writes for a repo: the static ones, then the tasks command in the Bash and the PowerShell
 * tool, built by the same helper as the command the briefing prints. A repo path with a space gets no tasks rules.
 */
export function allowRules(repo: string): string[] {
  return [...STATIC_ALLOW_RULES, ...taskAllowRules(repoCli(repo))];
}

const isTaskRule = (rule: unknown): boolean => typeof rule === 'string' && isTaskAllowRule(rule);

/**
 * Adds this repo's allow rules once each. Tasks rules for another repo path go first, as addInProgressHooks replaces
 * old hooks: an older checkout must not leave a rule behind. Every other rule stays where it is.
 */
export function addAllowRules(settings: Settings, repo: string): Settings {
  const wanted = allowRules(repo);
  settings.permissions ??= {};
  settings.permissions.allow ??= [];
  settings.permissions.allow = settings.permissions.allow.filter((r: unknown) => !isTaskRule(r) || wanted.includes(r as string));
  for (const rule of wanted) if (!settings.permissions.allow.includes(rule)) settings.permissions.allow.push(rule);
  return settings;
}

/**
 * Removes our allow rules: the static ones, and the tasks rules of any repo path, found by their pattern (uninstall
 * takes no repo). An allow list (and then a permissions object) that this leaves empty goes too.
 */
export function removeAllowRules(settings: Settings): Settings {
  const permissions = settings.permissions;
  if (!Array.isArray(permissions?.allow)) return settings;
  const kept = permissions.allow.filter((r: unknown) => !STATIC_ALLOW_RULES.includes(r as string) && !isTaskRule(r));
  if (kept.length === permissions.allow.length) return settings;
  if (kept.length) permissions.allow = kept;
  else {
    delete permissions.allow;
    if (Object.keys(permissions).length === 0) delete settings.permissions;
  }
  return settings;
}

/**
 * Fills a kit template. Replacer functions keep `$&`-style sequences in a path literal; every path gets forward slashes.
 * `{{TASKS}}` is the tasks command's prefix from the helper the allow rules and the briefing use, so all three match.
 */
export function renderTemplate(text: string, repo: string): string {
  const values: Record<string, string> = { REPO: repo, NODE: nodeBinary(), RESOURCES: `${homeDir()}/resources`, TASKS: taskPrefix(repoCli(repo)) };
  return text.replace(/\{\{(REPO|NODE|RESOURCES|TASKS)\}\}/g, (_match, key: string) => values[key].replace(/\\/g, '/'));
}

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

/** The first value in settings.json that install or uninstall would trip over, named by its key. */
export function settingsShapeError(settings: unknown): string | undefined {
  if (!isObject(settings)) return 'the top level is not a JSON object';
  const { hooks, permissions } = settings;
  if (hooks !== undefined) {
    if (!isObject(hooks)) return '"hooks" is not an object';
    for (const [event, groups] of Object.entries(hooks)) {
      if (!Array.isArray(groups)) return `"hooks.${event}" is not an array`;
      for (const [i, group] of groups.entries()) {
        const key = `hooks.${event}[${i}]`;
        if (!isObject(group)) return `"${key}" is not an object`;
        if (group.hooks === undefined) continue;
        if (!Array.isArray(group.hooks)) return `"${key}.hooks" is not an array`;
        if (!group.hooks.every(isObject)) return `"${key}.hooks" holds an entry that is not an object`;
      }
    }
  }
  if (permissions !== undefined) {
    if (!isObject(permissions)) return '"permissions" is not an object';
    if (permissions.allow !== undefined && !Array.isArray(permissions.allow)) return '"permissions.allow" is not an array';
  }
  return undefined;
}

/** Throws, naming the file, before anything is written. A leading BOM is ignored and an empty file reads as {}. */
function readSettings(file: string): Settings {
  if (!existsSync(file)) return {};
  const text = readFileSync(file, 'utf8').replace(/^\uFEFF/, '');
  if (!text.trim()) return {};
  let settings: unknown;
  try {
    settings = JSON.parse(text);
  } catch (err) {
    throw new Error(`settings.json at ${file} is not valid JSON (${(err as Error).message}); nothing was changed`);
  }
  const problem = settingsShapeError(settings);
  if (problem) throw new Error(`settings.json at ${file}: ${problem}; nothing was changed`);
  return settings as Settings;
}

function countInProgressHooks(settings: Settings): number {
  return Object.values((settings.hooks ?? {}) as Record<string, HookGroup[]>)
    .flat()
    .flatMap((g) => g.hooks ?? [])
    .filter(isInProgressHook).length;
}

const hookEntryLabel = (n: number): string => `InProgress hook ${n === 1 ? 'entry' : 'entries'}`;

/** Newest last: stamps sort by time, and a numeric suffix (`-2` before `-10`) by number. */
const byStamp = new Intl.Collator('en', { numeric: true }).compare;

/**
 * Copies settings.json aside without ever replacing an earlier backup (a clash gets `-1`, `-2`, ...), then keeps the
 * new backup and the newest four before it.
 */
function backup(file: string, stamp: string, log: string[]): void {
  if (!existsSync(file)) return;
  const base = `${file}.inprogress-backup-${stamp}`;
  let target = base;
  for (let n = 1; ; n++) {
    try {
      copyFileSync(file, target, constants.COPYFILE_EXCL);
      break;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST' || n > 100) throw err;
      target = `${base}-${n}`;
    }
  }
  log.push(`Backed up settings to ${target}`);
  const dir = dirname(file);
  const older = readdirSync(dir, { withFileTypes: true })
    .filter((d) => d.isFile() && d.name.startsWith(BACKUP_PREFIX) && d.name !== basename(target))
    .map((d) => d.name)
    .sort(byStamp);
  let pruned = 0;
  for (const name of older.slice(0, Math.max(0, older.length - (BACKUPS_KEPT - 1)))) {
    try {
      rmSync(join(dir, name));
      pruned++;
    } catch {
      // A backup we cannot delete stays; it never blocks the install.
    }
  }
  if (pruned) log.push(`Removed ${pruned} older settings ${pruned === 1 ? 'backup' : 'backups'} (keeping the newest ${BACKUPS_KEPT})`);
}

/** The agent file and the skill folder exactly as install writes them for this repo. */
function renderKit(repo: string): { agent: string; skill: (readonly [string, string])[] } {
  const agent = renderTemplate(readFileSync(join(repo, 'claude', 'agents', 'inprogress-scribe.md'), 'utf8'), repo);
  const skillSrc = join(repo, 'claude', 'skills', 'inprogress');
  const skill = readdirSync(skillSrc).map((f) => [f, renderTemplate(readFileSync(join(skillSrc, f), 'utf8'), repo)] as const);
  return { agent, skill };
}

const readText = (file: string): string | undefined => (existsSync(file) ? readFileSync(file, 'utf8') : undefined);

/** JSON with object keys sorted at every level; arrays keep their order. */
const canonical = (value: unknown): string =>
  JSON.stringify(value, (_key, v: unknown) => (isObject(v) ? Object.fromEntries(Object.keys(v).sort().map((k) => [k, v[k]])) : v));

/**
 * Whether InProgress is installed in a Claude dir, and which parts differ from what `install` would write for this
 * repo now (so a deploy re-runs install only when the kit really changed). Throws on an unreadable settings.json.
 */
export function kitStatus(o: { repo: string; claudeDir: string }): { installed: boolean; differs: ('settings' | 'agent' | 'skill')[] } {
  const repo = normalizePath(o.repo);
  const current = readSettings(join(o.claudeDir, 'settings.json'));
  const { agent, skill } = renderKit(repo);
  const agentFile = join(o.claudeDir, 'agents', 'inprogress-scribe.md');
  const skillDir = join(o.claudeDir, 'skills', 'inprogress');
  const installed = countInProgressHooks(current) > 0 || existsSync(agentFile);
  const differs: ('settings' | 'agent' | 'skill')[] = [];
  // The merge helpers edit in place, so they get a copy; key order is not a difference (a re-merge appends keys).
  if (canonical(addAllowRules(addInProgressHooks(structuredClone(current), repo), repo)) !== canonical(current)) differs.push('settings');
  if (readText(agentFile) !== agent) differs.push('agent');
  const installedSkill = existsSync(skillDir) ? readdirSync(skillDir).sort() : [];
  const skillSame = installedSkill.join('\n') === skill.map(([f]) => f).sort().join('\n') && skill.every(([f, text]) => readText(join(skillDir, f)) === text);
  if (!skillSame) differs.push('skill');
  return { installed, differs };
}

export function install(o: { repo: string; claudeDir: string; stamp: string }): { log: string[]; agentsDirCreated: boolean } {
  // One spelling of the repo everywhere (forward slashes, upper-case drive): the tasks rules must match, byte for byte,
  // the command the server prints from its own path.
  const repo = normalizePath(o.repo);
  // Everything is checked, read and rendered first, so a refusal or a broken template leaves the Claude dir untouched.
  const unbuilt = BUILT_ENTRIES.find((entry) => !existsSync(join(repo, entry)));
  if (unbuilt) throw new Error(`Build InProgress first: npm run deploy (${repo}/${unbuilt} is missing)`);
  const settingsFile = join(o.claudeDir, 'settings.json');
  const current = readSettings(settingsFile);
  const { agent, skill } = renderKit(repo);
  const replaced = countInProgressHooks(current);
  const settings = addAllowRules(addInProgressHooks(current, repo), repo);

  const log = [`Claude directory: ${o.claudeDir}`, `Node binary: ${nodeBinary()}`];
  mkdirSync(o.claudeDir, { recursive: true });
  backup(settingsFile, o.stamp, log);
  writeFileSync(settingsFile, `${JSON.stringify(settings, null, 2)}\n`);
  if (replaced > 0) log.push(`Replaced ${replaced} existing ${hookEntryLabel(replaced)}`);
  log.push(`Hooks: ${[...new Set(HOOK_DEFS.map((d) => d.event))].join(', ')}`, `Allow rules: ${allowRules(repo).join(', ')}`);
  if (!taskAllowRules(repoCli(repo)).length) {
    log.push(`Left out the tasks command's allow rules: the repo path ${repo} holds a space, which an unquoted path cannot hold and a quoted one never matches in PowerShell. Sessions are asked before each tasks command; a repo path without spaces avoids that.`);
  }

  const agentsDir = join(o.claudeDir, 'agents');
  const agentsDirCreated = !existsSync(agentsDir);
  mkdirSync(agentsDir, { recursive: true });
  const agentFile = join(agentsDir, 'inprogress-scribe.md');
  writeFileSync(agentFile, agent);
  log.push(`Agent: ${agentFile}`);

  const skillDst = join(o.claudeDir, 'skills', 'inprogress');
  rmSync(skillDst, { recursive: true, force: true });
  mkdirSync(skillDst, { recursive: true });
  for (const [f, text] of skill) writeFileSync(join(skillDst, f), text);
  log.push(`Skill: ${skillDst}`);

  if (agentsDirCreated) log.push('The agents folder is new: restart any open Claude sessions so they can see the scribe.');
  return { log, agentsDirCreated };
}

export function uninstall(o: { claudeDir: string; stamp: string }): string[] {
  const log = [`Claude directory: ${o.claudeDir}`];
  const settingsFile = join(o.claudeDir, 'settings.json');
  if (existsSync(settingsFile)) {
    // Read and checked before the backup, so a refused settings.json leaves the agent and skill in place too.
    const current = readSettings(settingsFile);
    const removed = countInProgressHooks(current);
    const settings = removeAllowRules(stripInProgressHooks(current));
    backup(settingsFile, o.stamp, log);
    writeFileSync(settingsFile, `${JSON.stringify(settings, null, 2)}\n`);
    log.push(`Removed ${removed} ${hookEntryLabel(removed)} and the allow rules`);
  }
  rmSync(join(o.claudeDir, 'agents', 'inprogress-scribe.md'), { force: true });
  rmSync(join(o.claudeDir, 'skills', 'inprogress'), { recursive: true, force: true });
  log.push('Removed the scribe agent and the inprogress skill');
  return log;
}
