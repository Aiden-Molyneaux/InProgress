import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { HOOK_NAMES, type HookName } from '../hooks/handlers';

export const ALLOW_RULES = ['mcp__inprogress', 'Edit(~/.inprogress/resources/**)'];
export const HOOK_SCRIPT_SUFFIX = '/dist/hooks/hook.js';
const NOT_SCRIBE = '^(?!inprogress-scribe$).*';

export interface HookDef {
  event: string;
  name: HookName;
  matcher?: string;
  timeout: number;
}

export const HOOK_DEFS: HookDef[] = [
  { event: 'SessionStart', name: 'session-start', timeout: 10 },
  { event: 'UserPromptSubmit', name: 'prompt-submit', timeout: 5 },
  { event: 'Stop', name: 'stop', timeout: 5 },
  { event: 'Notification', name: 'notification', matcher: 'permission_prompt', timeout: 5 },
  { event: 'SubagentStart', name: 'subagent-start', matcher: NOT_SCRIBE, timeout: 5 },
  { event: 'SubagentStop', name: 'subagent-stop', matcher: NOT_SCRIBE, timeout: 5 },
  { event: 'SessionEnd', name: 'session-end', timeout: 5 },
];

type HookEntry = { type?: string; command?: string; args?: string[]; timeout?: number };
type HookGroup = { matcher?: string; hooks?: HookEntry[] };
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Settings = Record<string, any>;

export function claudeDir(): string {
  const configured = process.env.INPROGRESS_CLAUDE_DIR;
  if (!configured) return join(homedir(), '.claude');
  return isAbsolute(configured) ? configured : resolve(configured);
}

/** Repo root from the bundled CLI at dist/cli/main.js. */
export function repoRoot(): string {
  return resolve(fileURLToPath(new URL('../..', import.meta.url))).replace(/\\/g, '/');
}

/**
 * The Node binary running the installer, as an absolute forward-slash path. Hooks and the scribe's
 * MCP server use it instead of relying on `node` being on the PATH the Claude desktop app inherits.
 */
export function nodeBinary(): string {
  return process.execPath.replace(/\\/g, '/');
}

export function hookEntry(repo: string, name: HookName, timeout: number): HookEntry {
  return { type: 'command', command: nodeBinary(), args: [`${repo}${HOOK_SCRIPT_SUFFIX}`, name], timeout };
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
    const group: HookGroup = { ...(d.matcher ? { matcher: d.matcher } : {}), hooks: [hookEntry(repo, d.name, d.timeout)] };
    (settings.hooks[d.event] ??= []).push(group);
  }
  return settings;
}

export function addAllowRules(settings: Settings): Settings {
  settings.permissions ??= {};
  settings.permissions.allow ??= [];
  for (const rule of ALLOW_RULES) if (!settings.permissions.allow.includes(rule)) settings.permissions.allow.push(rule);
  return settings;
}

export function removeAllowRules(settings: Settings): Settings {
  const allow = settings.permissions?.allow;
  if (Array.isArray(allow)) settings.permissions.allow = allow.filter((r: string) => !ALLOW_RULES.includes(r));
  return settings;
}

export const renderTemplate = (text: string, repo: string): string => text.replaceAll('{{REPO}}', repo).replaceAll('{{NODE}}', nodeBinary());

function readSettings(file: string): Settings {
  return existsSync(file) ? (JSON.parse(readFileSync(file, 'utf8')) as Settings) : {};
}

function countInProgressHooks(settings: Settings): number {
  return Object.values((settings.hooks ?? {}) as Record<string, HookGroup[]>)
    .flat()
    .flatMap((g) => g.hooks ?? [])
    .filter(isInProgressHook).length;
}

const hookEntries = (n: number): string => `InProgress hook ${n === 1 ? 'entry' : 'entries'}`;

function backup(file: string, stamp: string): string | undefined {
  if (!existsSync(file)) return undefined;
  const target = `${file}.inprogress-backup-${stamp}`;
  copyFileSync(file, target);
  return target;
}

export function install(o: { repo: string; claudeDir: string; stamp: string }): { log: string[]; agentsDirCreated: boolean } {
  const repo = o.repo.replace(/\\/g, '/');
  const log: string[] = [];
  mkdirSync(o.claudeDir, { recursive: true });
  const settingsFile = join(o.claudeDir, 'settings.json');
  const saved = backup(settingsFile, o.stamp);
  if (saved) log.push(`Backed up settings to ${saved}`);
  const current = readSettings(settingsFile);
  const replaced = countInProgressHooks(current);
  const settings = addAllowRules(addInProgressHooks(current, repo));
  writeFileSync(settingsFile, `${JSON.stringify(settings, null, 2)}\n`);
  if (replaced > 0) log.push(`Replaced ${replaced} existing ${hookEntries(replaced)}`);
  log.push(`Hooks: ${HOOK_DEFS.map((d) => d.event).join(', ')}`, `Allow rules: ${ALLOW_RULES.join(', ')}`);

  const agentsDir = join(o.claudeDir, 'agents');
  const agentsDirCreated = !existsSync(agentsDir);
  mkdirSync(agentsDir, { recursive: true });
  const agentFile = join(agentsDir, 'inprogress-scribe.md');
  writeFileSync(agentFile, renderTemplate(readFileSync(join(repo, 'claude', 'agents', 'inprogress-scribe.md'), 'utf8'), repo));
  log.push(`Agent: ${agentFile}`);

  const skillSrc = join(repo, 'claude', 'skills', 'inprogress');
  const skillDst = join(o.claudeDir, 'skills', 'inprogress');
  rmSync(skillDst, { recursive: true, force: true });
  mkdirSync(skillDst, { recursive: true });
  for (const f of readdirSync(skillSrc)) writeFileSync(join(skillDst, f), renderTemplate(readFileSync(join(skillSrc, f), 'utf8'), repo));
  log.push(`Skill: ${skillDst}`);

  if (agentsDirCreated) log.push('The agents folder is new: restart any open Claude sessions so they can see the scribe.');
  return { log, agentsDirCreated };
}

export function uninstall(o: { claudeDir: string; stamp: string }): string[] {
  const log: string[] = [];
  const settingsFile = join(o.claudeDir, 'settings.json');
  const saved = backup(settingsFile, o.stamp);
  if (saved) log.push(`Backed up settings to ${saved}`);
  if (existsSync(settingsFile)) {
    const current = readSettings(settingsFile);
    const removed = countInProgressHooks(current);
    const settings = removeAllowRules(stripInProgressHooks(current));
    writeFileSync(settingsFile, `${JSON.stringify(settings, null, 2)}\n`);
    log.push(`Removed ${removed} ${hookEntries(removed)} and the allow rules`);
  }
  rmSync(join(o.claudeDir, 'agents', 'inprogress-scribe.md'), { force: true });
  rmSync(join(o.claudeDir, 'skills', 'inprogress'), { recursive: true, force: true });
  log.push('Removed the scribe agent and the inprogress skill');
  return log;
}
