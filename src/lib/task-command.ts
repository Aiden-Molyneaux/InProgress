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

/** The subcommands a session runs itself, so install allows each (usage is Aiden's and is left out). */
export const CLI_SUBCOMMANDS = ['tasks', 'claim', 'ask', 'orchestrate', 'digest'] as const;
export type CliSubcommand = (typeof CLI_SUBCOMMANDS)[number];

/**
 * `node C:/…/dist/cli/main.js claim`: the start of every command of that subcommand and of its allow rules. A path with
 * a space is quoted so the command still runs; no rule can allow it, so it asks for permission.
 */
export function cliPrefix(cli: string, sub: CliSubcommand): string {
  const path = normalizePath(cli);
  return `node ${hasSpace(path) ? `"${path}"` : path} ${sub}`;
}

/** `node C:/…/dist/cli/main.js tasks`: cliPrefix for the working-tasks command. */
export function taskPrefix(cli: string): string {
  return cliPrefix(cli, 'tasks');
}

/** The command written out for a session, with its id filled in. The CLI defaults to the one beside the server. */
export function taskCommand(sessionId: string, o: { cli?: string } = {}): string {
  return `${taskPrefix(o.cli ?? cliBesideServer())} <step id> --session ${sessionId} --done "…" --doing "…" --todo "…"`;
}

/** `node <cli> claim <id> --session <sid>`: the claim command written out for a session; the step id is left for it to fill. */
export function claimCommand(sessionId: string, o: { cli?: string } = {}): string {
  return `${cliPrefix(o.cli ?? cliBesideServer(), 'claim')} <id> --session ${sessionId}`;
}

/**
 * The allow rules for every subcommand, in the Bash and the PowerShell tool, subcommand by subcommand. None for a path
 * with a space: an unquoted path cannot hold one, and a quoted one never matches.
 */
export function cliAllowRules(cli: string): string[] {
  if (hasSpace(normalizePath(cli))) return [];
  return CLI_SUBCOMMANDS.flatMap((sub) => {
    const prefix = cliPrefix(cli, sub);
    return [`Bash(${prefix} *)`, `PowerShell(${prefix} *)`];
  });
}

/** An allow rule for any subcommand as install writes it, for any repo path: what uninstall removes and install replaces. */
export function isCliAllowRule(rule: string): boolean {
  return new RegExp(String.raw`^(Bash|PowerShell)\(node \S+/dist/cli/main\.js (${CLI_SUBCOMMANDS.join('|')}) \*\)$`).test(rule);
}
