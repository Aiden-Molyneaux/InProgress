/**
 * What is Aiden's is held by the action (plan 2026-11-25-lead-stage-1-the-desk-answers.md, How it works 9): a shell command
 * tested in plain code against a short list before it runs. Pure: the hold hook runs it on every watched command, and the
 * server runs it again to name the action.
 */

/** What a held command does, as the hook and the server name it. The first four go to the landing check; the rest are Aiden's. */
export const HELD_ACTIONS = ['publish', 'push', 'merge', 'deploy', 'repo', 'delete', 'playbook'] as const;
export type HeldActionName = (typeof HELD_ACTIONS)[number];

/** The actions the landing check judges; any other held action is Aiden's without a check. */
export const CHECKED_ACTIONS: readonly HeldActionName[] = ['merge', 'deploy', 'push', 'publish'];

/** One command of a compound command that is on the list. */
export interface HeldMatch {
  action: HeldActionName;
  /** The part of the command that matched: one command of a compound one, trimmed. */
  segment: string;
  /** What it does, in plain words, without reading git: the hook says this when InProgress is not answering. */
  what: string;
}

/**
 * The families the hook is started for (HOOK_DEFS writes one handler per prefix, as an `if` rule `<Tool>(<prefix>*)`), so an
 * ordinary command starts no hook at all. A playbook's `Held:` line outside these is never seen by the hook.
 */
export const HOLD_RULE_PREFIXES: Readonly<Record<'Bash' | 'PowerShell', readonly string[]>> = {
  Bash: ['git push', 'git merge', 'npm publish', 'npm run deploy', 'node scripts/deploy', 'gh ', 'rm '],
  PowerShell: ['git push', 'git merge', 'npm publish', 'npm run deploy', 'node scripts/deploy', 'gh ', 'Remove-Item '],
};

/** git with any global options before its subcommand (`git -C <dir> push`, `git -c k=v push`, `git --no-pager push`). */
const GIT = String.raw`\bgit(?:\s+(?:-[Cc]\s+\S+|--?[\w-]+(?:=\S+)?))*\s+`;

/**
 * The list, P3's rules (spikes/lead-stage0/p3/hold-hook.cjs) in its order, each tested on one command of a compound one.
 * Case is ignored: holding too much is the safe side. Text inside a quoted string is matched too: the hook does not parse
 * the shell, so `echo "git push"` is held like a push.
 */
const RULES: { action: HeldActionName; re: RegExp; what: string }[] = [
  { action: 'publish', re: /\b(?:npm|pnpm|yarn)\s+publish\b|\bcargo\s+publish\b|\btwine\s+upload\b/i, what: 'a publish of a package for anyone to install' },
  { action: 'push', re: new RegExp(`${GIT}push(?![\\w-])`, 'i'), what: 'a push to a remote' },
  { action: 'deploy', re: /\b(?:npm|pnpm|yarn)\s+run\s+(?:deploy|release)\b|\bscripts[\\/]deploy/i, what: 'a deploy' },
  { action: 'repo', re: /\bgh\s+(?:repo\s+(?:create|delete|edit)|release\s+create)\b/i, what: "a change to a repository on Aiden's account" },
  { action: 'delete', re: /\b(?:rm|Remove-Item)\b.*\.inprogress\b/i, what: 'a delete under the live home' },
  { action: 'merge', re: new RegExp(`${GIT}merge(?![\\w-])`, 'i'), what: 'a merge into main' },
];

/** The commands of a compound command: split on `&&`, `||`, `;`, `|` and line breaks, quotes not considered. */
export function commandSegments(command: string): string[] {
  return command
    .split(/&&|\|\||;|\||\r?\n/)
    .map((s) => s.trim())
    .filter((s) => s !== '');
}

/**
 * Every command of `command` on the list, in order, one match per command: P3's rules first, then `extra` (the playbook's
 * `Held:` lines, each a command prefix, case ignored). Empty when nothing is held.
 */
export function heldActions(command: string, extra: readonly string[] = []): HeldMatch[] {
  const prefixes = extra.map((l) => l.trim()).filter((l) => l !== '');
  const matches: HeldMatch[] = [];
  for (const segment of commandSegments(command)) {
    const rule = RULES.find((r) => r.re.test(segment));
    if (rule) {
      matches.push({ action: rule.action, segment, what: rule.what });
      continue;
    }
    const line = prefixes.find((p) => segment.toLowerCase().startsWith(p.toLowerCase()));
    if (line !== undefined) matches.push({ action: 'playbook', segment, what: `a command the playbook holds for Aiden (${line})` });
  }
  return matches;
}

/** The first command of `command` on the list, or undefined when nothing is held. */
export function heldAction(command: string, extra: readonly string[] = []): HeldMatch | undefined {
  return heldActions(command, extra)[0];
}

/** The `Held: <command prefix>` lines of a playbook, one per line. */
export function playbookHeldLines(playbook: string): string[] {
  const lines: string[] = [];
  for (const line of playbook.split(/\r?\n/)) {
    const m = /^\s*Held:\s*(\S.*?)\s*$/.exec(line);
    if (m) lines.push(m[1]);
  }
  return lines;
}

/** Whether a Held line is inside a family the hook is started for, in either shell (case ignored, as the line is matched). */
export function heldLineWatched(line: string): boolean {
  const l = line.trim().toLowerCase();
  return [...HOLD_RULE_PREFIXES.Bash, ...HOLD_RULE_PREFIXES.PowerShell].some((p) => l.startsWith(p.toLowerCase()));
}

/** A command's words, with simple single and double quotes taken off (no escapes, no expansion). */
function words(segment: string): string[] {
  const out: string[] = [];
  const re = /"([^"]*)"|'([^']*)'|(\S+)/g;
  for (let m = re.exec(segment); m; m = re.exec(segment)) out.push(m[1] ?? m[2] ?? m[3] ?? '');
  return out;
}

/** Where `git` (or a path to it) is among a command's words, or -1. */
const gitWord = (w: string[]): number => w.findIndex((x) => x.toLowerCase() === 'git' || /[\\/]git(?:\.exe)?$/i.test(x));

/** The words after git's subcommand `sub` in the segment (global options skipped), or undefined when there is none. */
function argsAfter(segment: string, sub: string): string[] | undefined {
  const w = words(segment);
  const git = gitWord(w);
  if (git < 0) return undefined;
  for (let i = git + 1; i < w.length; i++) {
    if (w[i].toLowerCase() === sub) return w.slice(i + 1);
    if (w[i] === '-C' || w[i] === '-c') i++;
    else if (!w[i].startsWith('-')) return undefined;
  }
  return undefined;
}

/** The folder a `git -C <dir> ...` command runs in (the last -C wins, as in git), or undefined when it names none. */
export function gitFolderOption(segment: string): string | undefined {
  const w = words(segment);
  const git = gitWord(w);
  if (git < 0) return undefined;
  let folder: string | undefined;
  for (let i = git + 1; i < w.length - 1; i++) {
    if (w[i] === '-C') folder = w[++i];
    else if (w[i] === '-c') i++;
    else if (!w[i].startsWith('-')) break;
  }
  return folder;
}

/** git merge's options that take the next word as their value. */
const MERGE_VALUE_OPTIONS = new Set(['-m', '-F', '-s', '-X', '--message', '--file', '--strategy', '--strategy-option', '--into-name', '--cleanup']);

/**
 * The branch a `git merge <x>` merges, or undefined when it names none (or only `--abort`, `--continue`, `--quit`): the
 * server then cannot tell what is being merged, and holds it.
 */
export function mergeTarget(segment: string): string | undefined {
  const args = argsAfter(segment, 'merge');
  if (args === undefined) return undefined;
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (MERGE_VALUE_OPTIONS.has(a)) {
      i++;
      continue;
    }
    if (a === '--abort' || a === '--continue' || a === '--quit') return undefined;
    if (a.startsWith('-')) continue;
    return a;
  }
  return undefined;
}

/** git push's options that take the next word as their value. */
const PUSH_VALUE_OPTIONS = new Set(['-o', '--push-option', '--repo', '--receive-pack', '--exec']);
/** git push's options that push more than one branch, or delete one: what they send cannot be read as one branch. */
const PUSH_UNCLEAR_OPTIONS = new Set(['--all', '--branches', '--mirror', '--tags', '--delete', '-d', '--prune', '--follow-tags']);

/** What a push sends: the remote (origin when none is named) and the branch (the checkout's own when none is named). */
export type PushTarget = { ok: true; remote: string; branch?: string } | { ok: false; why: string };

/**
 * What a `git push` sends, read from its words: one remote and at most one branch, pushed under its own name. Anything else
 * (several refspecs, a rename `a:b`, a delete, `--all`, `--tags`) is not ok: the server cannot tell what it sends, and holds it.
 */
export function pushTarget(segment: string): PushTarget {
  const args = argsAfter(segment, 'push');
  if (args === undefined) return { ok: false, why: 'could not read the push' };
  const positional: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (PUSH_VALUE_OPTIONS.has(a)) {
      i++;
      continue;
    }
    if (PUSH_UNCLEAR_OPTIONS.has(a) || a.startsWith('--repo=')) return { ok: false, why: `could not tell what a push with ${a} sends` };
    if (a.startsWith('-')) continue;
    positional.push(a);
  }
  const [remote = 'origin', ...refspecs] = positional;
  if (refspecs.length === 0) return { ok: true, remote };
  if (refspecs.length > 1) return { ok: false, why: 'could not tell what a push of several branches sends' };
  const spec = refspecs[0].replace(/^\+/, '');
  const [src, dst] = spec.includes(':') ? [spec.slice(0, spec.indexOf(':')), spec.slice(spec.indexOf(':') + 1)] : [spec, undefined];
  const short = (ref: string) => ref.replace(/^refs\/heads\//, '');
  if (src === '') return { ok: false, why: 'could not tell what a push that deletes a branch sends' };
  if (dst !== undefined && short(dst) !== short(src)) return { ok: false, why: `could not tell what a push of ${src} to ${dst} sends` };
  if (src === 'HEAD') return { ok: true, remote };
  return { ok: true, remote, branch: short(src) };
}
