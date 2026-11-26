/**
 * What is Aiden's is held by the action (plan 2026-11-25-lead-stage-1-the-desk-answers.md, How it works 9): a shell command
 * tested in plain code against a short list before it runs. Pure, with no Node imports (the window's build checks src/core too): the hold hook runs it on every
 * watched command, and the server runs it again to name the action.
 */

/** What a held command does, as the hook and the server name it. The first four go to the landing check; the rest are Aiden's. */
export const HELD_ACTIONS = ['publish', 'push', 'merge', 'deploy', 'repo', 'pr-merge', 'delete', 'playbook'] as const;
export type HeldActionName = (typeof HELD_ACTIONS)[number];

/** The actions the landing check judges; any other held action is Aiden's without a check. */
export const CHECKED_ACTIONS: readonly HeldActionName[] = ['merge', 'deploy', 'push', 'publish'];

/** The two shells the hold hook is registered for. */
export type HoldTool = 'Bash' | 'PowerShell';

/** One command of a compound command that is on the list. */
export interface HeldMatch {
  action: HeldActionName;
  /** Where the command is among the compound command's commands, from 0: the server judges exactly this one. */
  index: number;
  /** The command, as written (quotes kept), trimmed. */
  segment: string;
  /** The folder it runs in: the session's, moved by any `cd`, `Set-Location`, `pushd` or `git -C` before it; null when one could not be read. */
  folder: string | null;
  /** What it does, in plain words, without reading git: the hook says this when InProgress is not answering. */
  what: string;
}

/** A command of a compound one: as written, and with every quoted string emptied and every heredoc body taken out. */
export interface CommandSegment {
  raw: string;
  masked: string;
}

/** What a rule reads of one command. */
interface SegmentView {
  /** The command with quoted strings emptied (`""`), so text inside a string never matches. */
  masked: string;
  /** Its words, quotes taken off, without the environment assignments in front of it. */
  argv: string[];
  /** The words of `masked`, without the assignments in front of them: `X="a b" npm publish` reads as one assignment here. */
  maskedArgv: string[];
}

/**
 * One rule of the list, with the `if` rules (Claude Code's permission-rule syntax, inside `<Tool>(...)`) that start the hook
 * for it in each shell, and examples that must be held through those rules (a test runs each one through a model of them).
 */
interface HoldRule {
  action: Exclude<HeldActionName, 'playbook'>;
  what: string;
  test: (s: SegmentView) => boolean;
  families: Record<HoldTool, readonly string[]>;
  examples: Record<HoldTool, readonly string[]>;
}

/** The program a command runs, lower case, without a folder or `.exe`/`.cmd`/`.bat`/`.ps1`. */
const program = (argv: string[]): string => (argv[0] ?? '').replace(/^.*[\\/]/, '').replace(/\.(?:exe|cmd|bat|ps1)$/i, '').toLowerCase();

/** A word that sets an environment variable for the command after it (`NPM_CONFIG_X=y`, `GIT_DIR=x`). */
const isAssignment = (word: string): boolean => /^[A-Za-z_][A-Za-z0-9_]*=/.test(word);

/** A command's words without the environment assignments in front of it: the program they run comes first. */
export function withoutAssignments(argv: string[]): string[] {
  let i = 0;
  while (i < argv.length && isAssignment(argv[i])) i++;
  return argv.slice(i);
}

/**
 * Where the first word that `is` accepts stands among a tool's words past its options (`npm --registry x publish`), or -1
 * when the subcommand is another. A word after a bare option (`--tag next`) may be that option's value, so the word after
 * it is read as well: holding too much is the safe side. `is` is given the word in lower case.
 */
function subcommandIndex(words: readonly string[], is: (word: string) => boolean): number {
  let afterOption = false;
  for (let i = 0; i < words.length; i++) {
    const w = words[i];
    if (w.startsWith('-')) {
      afterOption = !w.includes('=');
      continue;
    }
    if (is(w.toLowerCase())) return i;
    if (!afterOption) return -1;
    afterOption = false;
  }
  return -1;
}

const PACKAGE_MANAGERS = new Set(['npm', 'pnpm', 'yarn']);
/** A package as npx or dlx names it, without its version (`npm@10` is npm), lower case. */
const packageName = (word: string): string => program([word.replace(/(.)@.*$/, '$1')]);

/**
 * The package manager a command runs (npm, pnpm or yarn, by any spelling program() reads) and its words after it, also when
 * it is run through `npx [options] npm[@<v>]`, or `pnpm dlx` or `yarn dlx` the same way; undefined when it runs none.
 */
function packageRun(argv: string[]): { tool: string; rest: string[] } | undefined {
  let tool = program(argv);
  let rest = argv.slice(1);
  for (let hop = 0; hop < 3; hop++) {
    let runner: string[] | undefined = tool === 'npx' ? rest : undefined;
    if (tool === 'pnpm' || tool === 'yarn') {
      const dlx = subcommandIndex(rest, (w) => w === 'dlx');
      if (dlx >= 0) runner = rest.slice(dlx + 1);
    }
    if (runner === undefined) return PACKAGE_MANAGERS.has(tool) ? { tool, rest } : undefined;
    const at = subcommandIndex(runner, (w) => PACKAGE_MANAGERS.has(packageName(w)));
    if (at < 0) return undefined;
    tool = packageName(runner[at]);
    rest = runner.slice(at + 1);
  }
  return undefined;
}

/** Whether a command's words publish through npm, pnpm or yarn, by any spelling packageRun reads. */
function publishesPackage(argv: string[]): boolean {
  const run = packageRun(argv);
  return run !== undefined && subcommandIndex(run.rest, (w) => w === 'publish') >= 0;
}

/** A script name the deploy rule holds: it ends at anything but a letter or digit, so deploy:prod and deploy-web are held too. */
const DEPLOY_SCRIPT = /^(?:deploy|release|rollback)(?![a-z0-9])/;
/** npm's names for `run` (pnpm and yarn take `run`). */
const RUN_WORDS = new Set(['run', 'run-script', 'rum', 'urn']);

/** Whether a command's words run a deploy, release or rollback script through npm, pnpm or yarn (`yarn deploy` too). */
function runsDeployScript(argv: string[]): boolean {
  const run = packageRun(argv);
  if (run === undefined) return false;
  const at = subcommandIndex(run.rest, (w) => RUN_WORDS.has(w) || (run.tool === 'yarn' && DEPLOY_SCRIPT.test(w)));
  if (at < 0) return false;
  if (!RUN_WORDS.has(run.rest[at].toLowerCase())) return true;
  return subcommandIndex(run.rest.slice(at + 1), (w) => DEPLOY_SCRIPT.test(w)) >= 0;
}

/** git with any global options before its subcommand (`git -C <dir> push`, `git -C "a b" push`, `git -c k=v push`, `git --no-pager push`). */
const GIT = String.raw`\bgit(?:\.exe)?(?:\s+(?:-[Cc]\s+(?:"[^"]*"|'[^']*'|\S+)|--?[\w-]+(?:=\S+)?))*\s+`;
const GIT_PUSH = new RegExp(`${GIT}push(?![\\w-])`, 'i');
const GIT_MERGE = new RegExp(`${GIT}merge(?![\\w-])`, 'i');
/** git's global options as `if` rules: a push or merge behind them starts the hook too. */
const GIT_FAMILIES = ['git -C *', 'git -c *', 'git --*', 'git -P *', 'git -p *', 'git.exe *', '*git.exe *', '*/git *', '*\\git *'];
/** Spellings of git that a push or merge example is also run through. */
const GIT_SPELLINGS = ['git -P push', 'git -p push', 'git.exe push', 'C:/Program Files/Git/cmd/git.exe push', '/usr/bin/git push', 'C:\\tools\\git push'];
const both = (list: readonly string[]): Record<HoldTool, readonly string[]> => ({ Bash: list, PowerShell: list });
/**
 * A command with environment assignments in front of it (`NPM_CONFIG_X=y npm publish`, `GIT_DIR=x git push`), as `if`
 * rules: one per program a rule reads, the program a word of its own after an `=`. The server decides what it does.
 */
const assigned = (programs: readonly string[]): string[] => programs.map((p) => `*=* ${p} *`);
/**
 * npm, pnpm and yarn as a path or with `.cmd`, `.exe` or `.ps1`, with options before the subcommand, and run through npx
 * or dlx, as `if` rules: a publish or a deploy behind them starts the hook too.
 */
const PACKAGE_FAMILIES = [
  'npm -*',
  'pnpm -*',
  'yarn -*',
  '*npm.cmd *',
  '*npm.exe *',
  '*npm.ps1 *',
  '*yarn.cmd *',
  '*yarn.exe *',
  '*yarn.ps1 *',
  '*/npm *',
  '*\\npm *',
  '*/pnpm *',
  '*\\pnpm *',
  '*/yarn *',
  '*\\yarn *',
  'npx *npm*',
  '*npx.cmd *npm*',
  '*npx.ps1 *npm*',
  'pnpm dlx *',
  'yarn dlx *',
];
const DELETERS = new Set(['rm', 'rmdir', 'remove-item', 'del', 'ri', 'rd', 'erase']);

/**
 * The list: P3's rules (spikes/lead-stage0/p3/hold-hook.cjs), and a merge of a pull request. Case is ignored: holding too
 * much is the safe side.
 */
export const HOLD_RULES: readonly HoldRule[] = [
  {
    action: 'publish',
    what: 'a publish of a package for anyone to install',
    test: (s) => /\b(?:npm|pnpm|yarn)\s+publish\b|\bcargo\s+publish\b|\btwine\s+upload\b/i.test(s.masked) || publishesPackage(s.argv) || publishesPackage(s.maskedArgv),
    families: both(['npm publish*', 'pnpm publish*', 'yarn publish*', 'cargo publish*', 'twine upload*', ...PACKAGE_FAMILIES, ...assigned(['npm', 'pnpm', 'yarn', 'npx', 'cargo', 'twine'])]),
    examples: both([
      'npm publish',
      'pnpm publish --access public',
      'yarn publish',
      'cargo publish',
      'twine upload dist/*',
      'npm.cmd publish',
      'npm.exe publish',
      'npm.ps1 publish',
      'pnpm.cmd publish',
      'yarn.cmd publish',
      'yarn.ps1 publish',
      'C:/nodejs/npm.cmd publish',
      '/usr/local/bin/npm publish',
      'C:\\nodejs\\pnpm publish',
      '/usr/bin/yarn publish',
      'npm --registry https://x.invalid publish',
      'npm -w a publish',
      'npm --tag next publish',
      'pnpm --filter web publish',
      'yarn --cwd x publish',
      'npx npm publish',
      'npx -y npm@10 publish',
      'npx.cmd -y npm@10 publish',
      'pnpm dlx npm publish',
      'yarn dlx npm@10 publish',
      'NPM_CONFIG_REGISTRY=https://x.invalid npm publish',
      'npm_config_registry=x npm --tag next publish',
      'A=1 B=2 pnpm publish',
      'X="a b" npm.cmd publish',
      'X=1 npx -y npm publish',
      'X=1 cargo publish',
      'X=1 twine upload dist/*',
    ]),
  },
  {
    action: 'push',
    what: 'a push to a remote',
    test: (s) => GIT_PUSH.test(s.masked),
    families: both(['git push*', ...GIT_FAMILIES, ...assigned(['git'])]),
    examples: both([
      'git push',
      'git push origin feature',
      'git -C C:/repo push',
      'git -C "C:/a b" push',
      'git -c core.x=1 push',
      'git --no-pager push',
      'git -c remote.origin.pushurl=x push origin main',
      'git push -f',
      'GIT_DIR=.git git push',
      'GIT_SSH_COMMAND=x git -C C:/repo push origin main',
      ...GIT_SPELLINGS,
    ]),
  },
  {
    action: 'deploy',
    what: 'a deploy',
    test: (s) =>
      // The name ends at anything but a letter or digit, so deploy:prod and deploy-web are held too: over-holding is the safe side.
      /\b(?:npm|pnpm)\s+run\s+(?:deploy|release|rollback)(?![a-z0-9])|\byarn\s+(?:run\s+)?(?:deploy|release|rollback)(?![a-z0-9])/i.test(s.masked) ||
      runsDeployScript(s.argv) ||
      runsDeployScript(s.maskedArgv) ||
      (program(s.argv) === 'node' && s.argv.slice(1).some((a) => /(?:^|[\\/])scripts[\\/]deploy[^\\/]*$/i.test(a))),
    families: both([
      'npm run deploy*',
      'npm run release*',
      'npm run rollback*',
      'pnpm run deploy*',
      'pnpm run release*',
      'pnpm run rollback*',
      'yarn run deploy*',
      'yarn run release*',
      'yarn run rollback*',
      'yarn deploy*',
      'yarn release*',
      'yarn rollback*',
      'node *deploy*',
      ...PACKAGE_FAMILIES,
      ...assigned(['npm', 'pnpm', 'yarn', 'npx', 'node']),
    ]),
    examples: both([
      'npm run deploy',
      'npm run release',
      'npm run rollback',
      'npm run deploy>deploy.log',
      'yarn deploy<in',
      'pnpm run deploy',
      'yarn deploy',
      'yarn run release',
      'node scripts/deploy.mjs',
      'node scripts\\deploy-web.mjs',
      'node C:/personal/InProgress/scripts/deploy.mjs',
      'npm.cmd run deploy',
      'npm.cmd run rollback',
      'npm --silent run deploy',
      'npm.cmd --silent run rollback',
      'npm --prefix C:/repo run deploy',
      'npm -s run-script deploy:prod',
      'pnpm.cmd run release',
      'yarn.cmd deploy',
      'yarn --cwd x rollback',
      'C:/nodejs/npm.cmd run deploy',
      'npx npm run deploy',
      'pnpm dlx npm@10 run rollback',
      'NODE_ENV=production npm run deploy',
      'X=1 npm --silent run rollback',
      'X=1 node scripts/deploy.mjs',
    ]),
  },
  {
    action: 'repo',
    what: "a change to a repository on Aiden's account",
    test: (s) => program(s.argv) === 'gh' && ((s.argv[1] === 'repo' && ['create', 'delete', 'edit'].includes(s.argv[2] ?? '')) || (s.argv[1] === 'release' && s.argv[2] === 'create')),
    families: both(['gh *', ...assigned(['gh'])]),
    examples: both(['gh repo create acme/widgets --public', 'gh repo delete acme/widgets --yes', 'gh repo edit --visibility public', 'gh release create v1.0.0', 'GH_TOKEN=x gh repo delete acme/widgets --yes']),
  },
  {
    action: 'pr-merge',
    what: 'a merge of a pull request into main',
    test: (s) => program(s.argv) === 'gh' && s.argv[1] === 'pr' && s.argv[2] === 'merge',
    families: both(['gh *', ...assigned(['gh'])]),
    examples: both(['gh pr merge 12 --squash', 'GH_TOKEN=x gh pr merge 12 --squash']),
  },
  {
    action: 'delete',
    what: 'a delete under the live home',
    test: (s) => DELETERS.has(program(s.argv)) && s.argv.slice(1).some((a) => /\.inprogress(?![\w-])/i.test(a)),
    families: { Bash: ['rm *', 'rmdir *', ...assigned(['rm', 'rmdir'])], PowerShell: ['rm *', 'del *', 'ri *', 'rmdir *', 'rd *', 'Remove-Item *'] },
    examples: {
      Bash: ['rm -rf ~/.inprogress', 'rm ~/.inprogress/inprogress.db', 'rmdir ~/.inprogress/x', 'X=1 rm -rf ~/.inprogress'],
      PowerShell: ['Remove-Item -Recurse -Force $HOME\\.inprogress\\resources', 'rm C:/Users/a/.inprogress', 'del "C:\\Users\\a\\.inprogress\\token"', 'ri ~/.inprogress', 'rd ~/.inprogress', 'rmdir ~/.inprogress'],
    },
  },
  {
    action: 'merge',
    what: 'a merge into main',
    test: (s) => GIT_MERGE.test(s.masked),
    families: both(['git merge*', ...GIT_FAMILIES, ...assigned(['git'])]),
    examples: both(['git merge feature', 'git merge --no-ff -m "land it" feature', 'git -C ../main merge x', 'git --no-pager merge x', 'GIT_DIR=x git merge feature',...GIT_SPELLINGS.map((x) => x.replace(/push$/, 'merge x'))]),
  },
];

/** Every `if` rule of a shell, once each, in the list's order: HOOK_DEFS writes one hold handler for each. */
export function holdFamilies(tool: HoldTool): string[] {
  return [...new Set(HOLD_RULES.flatMap((r) => r.families[tool]))];
}

/** An `if` rule's pattern as Claude Code matches it, as this code models it: the whole command, `*` any text, case kept. */
export const familyRe = (family: string): RegExp => new RegExp(`^${family.replace(/[.+^${}()|[\]\\?]/g, '\\$&').replace(/\*/g, '.*')}$`, 's');

/** Whether a Held line is inside a family the hook is started for, in either shell. */
export function heldLineWatched(line: string): boolean {
  const l = line.trim();
  return [...holdFamilies('Bash'), ...holdFamilies('PowerShell')].some((f) => familyRe(f).test(l));
}

/** The end of a heredoc's delimiter line, from the start of the body: the index just past the line that closes it, or -1. */
function heredocEnd(s: string, from: number, delim: string): number {
  let i = from;
  while (i <= s.length) {
    const nl = s.indexOf('\n', i);
    const line = (nl < 0 ? s.slice(i) : s.slice(i, nl)).replace(/\r$/, '');
    if (line.trim() === delim) return nl < 0 ? s.length : nl + 1;
    if (nl < 0) return -1;
    i = nl + 1;
  }
  return -1;
}

/** A heredoc opener at `i` (`<<`, `<<-`, quoted or bare delimiter; not `<<<`): its delimiter and the index after it, or undefined. */
function heredocAt(s: string, i: number): { delim: string; next: number } | undefined {
  if (!s.startsWith('<<', i) || s[i + 2] === '<') return undefined;
  const m = /^<<-?\s*(?:'([^'\n]+)'|"([^"\n]+)"|\\?([A-Za-z_][\w-]*))/.exec(s.slice(i));
  if (!m) return undefined;
  return { delim: m[1] ?? m[2] ?? m[3] ?? '', next: i + m[0].length };
}

/** Past a `$(...)` whose body starts at `j`: quotes, nested parentheses and heredocs inside skipped. -1 when it never closes. */
function skipSubst(s: string, j: number): number {
  let depth = 1;
  const pending: string[] = [];
  while (j < s.length) {
    const c = s[j];
    const doc = heredocAt(s, j);
    if (doc) {
      pending.push(doc.delim);
      j = doc.next;
      continue;
    }
    if (c === '\n' && pending.length > 0) {
      let k = j + 1;
      for (const d of pending.splice(0)) {
        k = heredocEnd(s, k, d);
        if (k < 0) return -1;
      }
      j = k;
      continue;
    }
    if (c === "'") {
      const end = s.indexOf("'", j + 1);
      if (end < 0) return -1;
      j = end + 1;
    } else if (c === '"') {
      j = skipDouble(s, j + 1);
      if (j < 0) return -1;
    } else if (c === '(') {
      depth++;
      j++;
    } else if (c === ')') {
      depth--;
      j++;
      if (depth === 0) return j;
    } else j++;
  }
  return -1;
}

/** Past a double-quoted string whose body starts at `j`: `\"`, `$(...)` and backticks inside skipped. -1 when it never closes. */
function skipDouble(s: string, j: number): number {
  while (j < s.length) {
    const c = s[j];
    if (c === '\\' && '"\\$`'.includes(s[j + 1] ?? '')) j += 2;
    else if (c === '"') return j + 1;
    else if (s.startsWith('$(', j)) {
      j = skipSubst(s, j + 2);
      if (j < 0) return -1;
    } else if (c === '`') {
      // A backtick before a quote is PowerShell's escape; anywhere else it is bash's command substitution.
      if (s[j + 1] === '"') j += 2;
      else {
        const end = s.indexOf('`', j + 1);
        if (end < 0) return -1;
        j = end + 1;
      }
    } else j++;
  }
  return -1;
}

/**
 * The commands of a compound command, split on `&&`, `||`, `;`, `|`, `&`, line breaks, parentheses and a bare `$(` or
 * backtick, outside quotes. A quoted string (with any `$(...)` in it), a heredoc's body and a PowerShell here-string are
 * text, never commands: they are emptied in `masked`. A command that does not close (an open quote, a heredoc with no end)
 * is split as plain text instead, quotes not considered, so nothing in it escapes the list.
 */
export function splitCommand(command: string): CommandSegment[] {
  const s = command;
  const out: CommandSegment[] = [];
  let raw = '';
  let masked = '';
  const push = () => {
    if (raw.trim() !== '') out.push({ raw: raw.trim(), masked: masked.trim() });
    raw = '';
    masked = '';
  };
  const pending: string[] = [];
  let i = 0;
  const plain = (): CommandSegment[] => command.split(/&&|\|\||[;|&\n()`]|\$\(/).map((x) => x.trim()).filter((x) => x !== '').map((x) => ({ raw: x, masked: x }));
  while (i < s.length) {
    const c = s[i];
    const atWordStart = i === 0 || /\s/.test(s[i - 1]);
    if (c === '\r') {
      i++;
      continue;
    }
    if (c === '\n') {
      push();
      i++;
      if (pending.length > 0) {
        for (const d of pending.splice(0)) {
          i = heredocEnd(s, i, d);
          if (i < 0) return plain();
        }
      }
      continue;
    }
    if (c === '#' && atWordStart) {
      // A comment runs to the end of the line.
      const nl = s.indexOf('\n', i);
      i = nl < 0 ? s.length : nl;
      continue;
    }
    if (c === '@' && (s[i + 1] === '"' || s[i + 1] === "'") && /^\r?\n/.test(s.slice(i + 2))) {
      // A PowerShell here-string: its body ends at a line that starts with the closing quote and @.
      const close = s.indexOf(`\n${s[i + 1]}@`, i + 2);
      if (close < 0) return plain();
      raw += s.slice(i, close + 3);
      masked += '""';
      i = close + 3;
      continue;
    }
    const doc = heredocAt(s, i);
    if (doc) {
      pending.push(doc.delim);
      raw += s.slice(i, doc.next);
      masked += s.slice(i, doc.next);
      i = doc.next;
      continue;
    }
    if (c === "'" || c === '"') {
      const end = c === "'" ? s.indexOf("'", i + 1) + 1 : skipDouble(s, i + 1);
      if (end <= 0) return plain();
      raw += s.slice(i, end);
      masked += c + c;
      i = end;
      continue;
    }
    const two = s.slice(i, i + 2);
    if (two === '&&' || two === '||' || two === '$(') {
      push();
      i += 2;
      continue;
    }
    if (c === '&' && (s[i - 1] === '>' || s[i - 1] === '<' || s[i + 1] === '>')) {
      // `2>&1`, `>&2`, `&>log`: the & belongs to a redirection, it does not end the command.
      raw += c;
      masked += c;
      i++;
      continue;
    }
    if (';|&()`'.includes(c)) {
      push();
      i++;
      continue;
    }
    raw += c;
    masked += c;
    i++;
  }
  if (pending.length > 0) return plain();
  push();
  return out;
}

/** The raw text of each command of a compound command (see splitCommand). */
export const commandSegments = (command: string): string[] => splitCommand(command).map((x) => x.raw);

/** A command's words, with simple single and double quotes taken off (no escapes, no expansion), and its redirections (`2>&1`, `> out`, `&>log`, `*>`) and their targets left out. */
export function words(segment: string): string[] {
  const out: string[] = [];
  const re = /"([^"]*)"|'([^']*)'|(\S+)/g;
  let skipNext = false;
  for (let m = re.exec(segment); m; m = re.exec(segment)) {
    const word = m[1] ?? m[2] ?? m[3] ?? '';
    if (skipNext) {
      skipNext = false;
      continue;
    }
    const redirect = m[3] === undefined ? null : /^(?:\d*|&|\*)(?:>>?|<{1,3})(&?)(.*)$/.exec(word);
    if (redirect) {
      // A bare operator (`>`, `2>`, `<<`) takes the next word as its target; a joined one (`>out`, `2>&1`) carries it.
      skipNext = redirect[2] === '';
      continue;
    }
    out.push(word);
  }
  return out;
}

/** A path as written, resolved against `base`; null when it cannot be read without a shell (a variable, `~`, `-`). */
export function resolveFolder(base: string | null, path: string): string | null {
  // `~` only means home at the start: a Windows short name (AIDEN~1) is an ordinary path.
  if (base === null || path === '' || path === '-' || path.startsWith('~') || /[$%`*?]/.test(path)) return null;
  // Git Bash spells C:\x as /c/x.
  const msys = /^\/([A-Za-z])(\/.*)?$/.exec(path);
  const p = msys ? `${msys[1].toUpperCase()}:${msys[2] ?? '/'}` : path;
  const slashed = p.replace(/\\/g, '/');
  const absolute = /^[A-Za-z]:\//.test(slashed) || slashed.startsWith('//');
  return normalizeFolder(absolute ? slashed : `${base.replace(/\\/g, '/').replace(/\/+$/, '')}/${slashed}`);
}

/** `.` and `..` worked out, doubled and trailing slashes dropped, a drive letter in capitals; a drive's root keeps its slash. */
function normalizeFolder(path: string): string {
  const unc = path.startsWith('//');
  const parts = path.split('/').filter((x) => x !== '' && x !== '.');
  const root = unc ? 2 : /^[A-Za-z]:$/.test(parts[0] ?? '') ? 1 : 0;
  const out = parts.slice(0, root);
  for (const part of parts.slice(root)) {
    if (part === '..') {
      if (out.length > root) out.pop();
    } else out.push(part);
  }
  if (root === 1) out[0] = out[0].toUpperCase();
  const joined = out.join('/');
  if (unc) return `//${joined}`;
  if (root === 1) return out.length === 1 ? `${joined}/` : joined;
  return `${path.startsWith('/') ? '/' : ''}${joined}`;
}

const CD = new Set(['cd', 'chdir', 'set-location', 'sl', 'pushd', 'push-location']);
const POPD = new Set(['popd', 'pop-location']);

/** The folder after a `cd`-like command, from `folder`: undefined when the command is no folder change, null when it cannot be read. */
function folderAfter(argv: string[], folder: string | null): string | null | undefined {
  const prog = program(argv);
  if (POPD.has(prog)) return null;
  if (!CD.has(prog)) return undefined;
  // Options (`-L`, `-Path`) are skipped; `cd -` and a bare `cd` (home) cannot be read.
  const target = argv.slice(1).find((a) => !a.startsWith('-'));
  return target === undefined ? null : resolveFolder(folder, target);
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

/**
 * Every command of `command` on the list, in order, one match per command, each with the folder it runs in (from `cwd`,
 * moved by the commands before it). The playbook's `Held:` lines (`extra`, each a command prefix, case ignored) come
 * first: a command that starts with one is held, whatever it is. Then the list, on the command with its quoted strings and
 * heredoc bodies emptied. Empty when nothing is held.
 */
export function heldActions(command: string, extra: readonly string[] = [], cwd: string | null = null): HeldMatch[] {
  const prefixes = extra.map((l) => l.trim()).filter((l) => l !== '');
  const matches: HeldMatch[] = [];
  let folder: string | null = cwd === null ? null : cwd.replace(/\\/g, '/');
  splitCommand(command).forEach((seg, index) => {
    const argv = words(seg.raw);
    const moved = folderAfter(argv, folder);
    if (moved !== undefined) {
      folder = moved;
      return;
    }
    const named = gitFolderOption(seg.raw);
    const here = named === undefined ? folder : resolveFolder(folder, named);
    const line = prefixes.find((p) => seg.raw.toLowerCase().startsWith(p.toLowerCase()));
    if (line !== undefined) {
      matches.push({ action: 'playbook', index, segment: seg.raw, folder: here, what: `a command the playbook holds for Aiden (${line})` });
      return;
    }
    // A gh command is read on its own words, against the gh rules alone; assignments in front of a command are not its program.
    const view: SegmentView = { masked: seg.masked, argv: withoutAssignments(argv), maskedArgv: withoutAssignments(words(seg.masked)) };
    const rule = HOLD_RULES.find((r) => (program(view.argv) === 'gh' ?r.action === 'repo' || r.action === 'pr-merge' : true) && r.test(view));
    if (rule) matches.push({ action: rule.action, index, segment: seg.raw, folder: here, what: rule.what });
  });
  return matches;
}

/** The first command of `command` on the list, or undefined when nothing is held. */
export function heldAction(command: string, extra: readonly string[] = [], cwd: string | null = null): HeldMatch | undefined {
  return heldActions(command, extra, cwd)[0];
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

/** Whether `folder` is `root` or inside it (forward slashes, case ignored). */
export function folderInside(folder: string, root: string): boolean {
  const f = folder.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
  const r = root.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
  return f === r || f.startsWith(`${r}/`);
}

/** Where `git` (or a path to it) is among a command's words, or -1. */
const gitWord = (w: string[]): number => w.findIndex((x) => x.toLowerCase() === 'git' || /[\\/]git(?:\.exe)?$/i.test(x) || x.toLowerCase() === 'git.exe');

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

/** git merge's options that take the next word as their value. */
const MERGE_VALUE_OPTIONS = new Set(['-m', '-F', '-s', '-X', '--message', '--file', '--strategy', '--strategy-option', '--into-name', '--cleanup']);

/**
 * The commits a `git merge` merges, as named: empty when it names none (or only `--abort`, `--continue`, `--quit`), more
 * than one for an octopus merge. The server holds either when it cannot tell what is being merged.
 */
export function mergeTargets(segment: string): string[] {
  const args = argsAfter(segment, 'merge');
  if (args === undefined) return [];
  const targets: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (MERGE_VALUE_OPTIONS.has(a)) {
      i++;
      continue;
    }
    if (a === '--abort' || a === '--continue' || a === '--quit') return [];
    if (a.startsWith('-')) continue;
    targets.push(a);
  }
  return targets;
}

/** The one commit a `git merge` merges, or undefined when it names none or several. */
export function mergeTarget(segment: string): string | undefined {
  const t = mergeTargets(segment);
  return t.length === 1 ? t[0] : undefined;
}

/** Updating main from its remote: not a landing. */
export const isUpstreamOfMain = (target: string): boolean => target === 'origin/main' || /^@\{(?:u|upstream)\}$/i.test(target) || /^main@\{(?:u|upstream)\}$/i.test(target);

/** git push's options that take the next word as their value. */
const PUSH_VALUE_OPTIONS = new Set(['-o', '--push-option', '--receive-pack', '--exec']);
/** git push's options that push more than one branch, or delete one: what they send cannot be read as one branch. */
const PUSH_UNCLEAR_OPTIONS = new Set(['--all', '--branches', '--mirror', '--tags', '--delete', '-d', '--prune', '--follow-tags']);

/** What a push sends: the remote (origin when none is named) and the branch (the checkout's own when none is named). */
export type PushTarget = { ok: true; remote: string; branch?: string } | { ok: false; why: string };

/**
 * What a `git push` sends, read from its words: one remote and at most one branch, pushed under its own name. Anything else
 * (several refspecs, a rename `a:b`, a delete, `--all`, `--tags`) is not ok: the server cannot tell what it sends, and holds it.
 * `--repo <x>` names the remote.
 */
export function pushTarget(segment: string): PushTarget {
  const args = argsAfter(segment, 'push');
  if (args === undefined) return { ok: false, why: 'could not read the push' };
  const positional: string[] = [];
  let repo: string | undefined;
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--repo') {
      repo = args[++i] ?? '';
      continue;
    }
    if (a.startsWith('--repo=')) {
      repo = a.slice('--repo='.length);
      continue;
    }
    if (PUSH_VALUE_OPTIONS.has(a)) {
      i++;
      continue;
    }
    if (PUSH_UNCLEAR_OPTIONS.has(a)) return { ok: false, why: `could not tell what a push with ${a} sends` };
    if (a.startsWith('-')) continue;
    positional.push(a);
  }
  const [first = 'origin', ...refspecs] = positional;
  const remote = repo ?? first;
  if (repo !== undefined && positional.length > 0) refspecs.unshift(first);
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
