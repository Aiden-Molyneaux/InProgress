import { fileURLToPath } from 'node:url';
import { normalizePath } from './paths';

/*
 * The working-tasks command a main session runs itself where the task tools are absent (spec §1). One prefix builds
 * both what the briefing prints and what install allows, so the two match byte for byte: Claude Code allows a command
 * only when it starts with the rule's text, quotes included. `node` is the bare word from PATH, because a PowerShell
 * rule never matches a program called by its path. The script path is unquoted with forward slashes, because a quoted
 * path never matches the unquoted rule. The step is printed bare: an unquoted `#` starts a comment in both shells.
 */

/** dist/cli/main.js beside the bundled entry that calls this (the running server's dist/server/main.js). */
export function cliBesideServer(): string {
  return fileURLToPath(new URL('../cli/main.js', import.meta.url));
}

/** The CLI script of a repo, `<repo>/dist/cli/main.js`: what install allows. */
export function repoCli(repo: string): string {
  return `${normalizePath(repo)}/dist/cli/main.js`;
}

const hasSpace = (path: string): boolean => /\s/.test(path);

/**
 * `node C:/…/dist/cli/main.js tasks`: the start of every tasks command and of its allow rules. A path with a space is
 * quoted so the command still runs; no rule can allow it, so it asks for permission.
 */
export function taskPrefix(cli: string): string {
  const path = normalizePath(cli);
  return `node ${hasSpace(path) ? `"${path}"` : path} tasks`;
}

/** The command written out for a session, with its id filled in. The CLI defaults to the one beside the server. */
export function taskCommand(sessionId: string, o: { cli?: string } = {}): string {
  return `${taskPrefix(o.cli ?? cliBesideServer())} <step id> --session ${sessionId} --done "…" --doing "…" --todo "…"`;
}

/**
 * The allow rules for the tasks command, in the Bash and the PowerShell tool. None for a path with a space: an
 * unquoted path cannot hold one, and a quoted one never matches.
 */
export function taskAllowRules(cli: string): string[] {
  if (hasSpace(normalizePath(cli))) return [];
  const prefix = taskPrefix(cli);
  return [`Bash(${prefix} *)`, `PowerShell(${prefix} *)`];
}

/** A tasks allow rule as install writes it, for any repo path: what uninstall removes and install replaces. */
export function isTaskAllowRule(rule: string): boolean {
  return /^(Bash|PowerShell)\(node \S+\/dist\/cli\/main\.js tasks \*\)$/.test(rule);
}
