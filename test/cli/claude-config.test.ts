import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { allowRules, claudeDir, HOOK_DEFS, hookEntry, install, isInProgressHook, kitStatus, nodeBinary, renderTemplate, STATIC_ALLOW_RULES, uninstall } from '../../src/cli/claude-config';
import { homeDir } from '../../src/lib/home';
import { CLI_SUBCOMMANDS, cliAllowRules, cliPrefix, isCliAllowRule, repoCli, taskPrefix } from '../../src/lib/task-command';

const temps: string[] = [];
function tempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  temps.push(dir);
  return dir;
}
afterAll(() => {
  for (const dir of temps) rmSync(dir, { recursive: true, force: true });
});

/** A stand-in repo: the real claude/ templates plus empty built entries, so these tests never depend on a build. */
function fixtureRepo(prefix = 'ip-repo-'): string {
  const dir = tempDir(prefix);
  cpSync(join(process.cwd(), 'claude'), join(dir, 'claude'), { recursive: true });
  for (const entry of ['dist/hooks/hook.js', 'dist/mcp/main.js']) {
    mkdirSync(dirname(join(dir, entry)), { recursive: true });
    writeFileSync(join(dir, entry), '');
  }
  return dir.replace(/\\/g, '/');
}
const repo = fixtureRepo();

function claudeDirWithSettings(settings: object | string | undefined) {
  const dir = tempDir('ip-claude-');
  if (settings !== undefined) writeFileSync(join(dir, 'settings.json'), typeof settings === 'string' ? settings : JSON.stringify(settings, null, 2));
  return dir;
}
const readSettings = (dir: string) => JSON.parse(readFileSync(join(dir, 'settings.json'), 'utf8'));
const backups = (dir: string) => readdirSync(dir).filter((f) => f.startsWith('settings.json.inprogress-backup-')).sort();
const slashed = (p: string) => p.replace(/\\/g, '/');

/** Every file and folder under `dir` with its contents, to prove a refused install or uninstall wrote nothing. */
function snapshot(dir: string): Record<string, string> {
  const files: Record<string, string> = {};
  for (const rel of readdirSync(dir, { recursive: true }) as string[]) {
    const full = join(dir, rel);
    files[slashed(rel)] = statSync(full).isDirectory() ? '<dir>' : readFileSync(full, 'utf8');
  }
  return files;
}

function thrownBy(fn: () => unknown): string {
  try {
    fn();
  } catch (err) {
    return (err as Error).message;
  }
  throw new Error('expected a throw');
}

const existing = {
  model: 'opus',
  enabledPlugins: { 'superpowers@claude-plugins-official': true },
  permissions: { allow: ['Bash(git status)'] },
  hooks: { Stop: [{ hooks: [{ type: 'command', command: 'other-tool --stop' }] }] },
};

// Other tools' hooks that share InProgress's dist/hooks/hook.js layout: install and uninstall must keep them.
const foreignShell = { type: 'command', command: 'node C:/tools/foo/dist/hooks/hook.js' };
const foreignExec = { type: 'command', command: 'C:/x/node.exe', args: ['C:/tools/foo/dist/hooks/hook.js', 'lint'] };
const withForeign = {
  ...existing,
  hooks: { ...existing.hooks, SessionStart: [{ hooks: [foreignShell] }], PreToolUse: [{ matcher: 'Bash', hooks: [foreignExec] }] },
};

/** The CLI commands' rules (tasks, claim, ask, orchestrate, digest) for the fixture repo, written out as Claude Code's settings hold them. */
const taskRules = CLI_SUBCOMMANDS.flatMap((sub) => [`Bash(node ${repo}/dist/cli/main.js ${sub} *)`, `PowerShell(node ${repo}/dist/cli/main.js ${sub} *)`]);
/** A tasks rule an older checkout left behind. */
const staleTaskRules = ['Bash(node D:/old/InProgress/dist/cli/main.js tasks *)', 'PowerShell(node D:/old/InProgress/dist/cli/main.js tasks *)'];

/** `settings` plus exactly what install adds: the allow rules and one InProgress group per hook event. */
function withInstall(settings: object) {
  const s = JSON.parse(JSON.stringify(settings));
  s.permissions.allow.push(...allowRules(repo));
  for (const d of HOOK_DEFS) (s.hooks[d.event] ??= []).push({ ...(d.matcher ? { matcher: d.matcher } : {}), hooks: [hookEntry(repo, d.name, d.timeout, d.async)] });
  return s;
}

describe('isInProgressHook', () => {
  it('matches only exec-form entries that run an InProgress hook', () => {
    const ours = hookEntry(repo, 'stop', 5);
    expect(isInProgressHook(ours)).toBe(true);
    expect(isInProgressHook({ ...ours, args: [`${repo}/dist/hooks/hook.js`.replace(/\//g, '\\'), 'stop'] })).toBe(true);
    expect(isInProgressHook(foreignShell)).toBe(false);
    expect(isInProgressHook(foreignExec)).toBe(false);
  });

  it('knows the tool hooks', () => {
    expect(isInProgressHook(hookEntry(repo, 'pre-tool', 5))).toBe(true);
    expect(isInProgressHook(hookEntry(repo, 'post-tool', 5))).toBe(true);
  });
});

describe('HOOK_DEFS', () => {
  it('hooks the Agent tool before it runs; the Agent and task tools after, in step; and the command tools after, async', () => {
    expect(HOOK_DEFS.filter((d) => d.event === 'PreToolUse' || d.event === 'PostToolUse')).toEqual([
      { event: 'PreToolUse', name: 'pre-tool', matcher: '^(Agent|Task)$', timeout: 5 },
      { event: 'PostToolUse', name: 'post-tool', matcher: '^(Agent|Task|TaskCreate|TaskUpdate)$', timeout: 5 },
      { event: 'PostToolUse', name: 'post-tool', matcher: '^(Bash|PowerShell|Monitor|SendMessage|TaskStop)$', timeout: 5, async: true },
    ]);
    const matching = (event: string, tool: string) => HOOK_DEFS.filter((d) => d.event === event && new RegExp(d.matcher!).test(tool));
    const matches = (event: string, tool: string) => matching(event, tool).length > 0;
    expect(['Agent', 'Task', 'TaskCreate', 'Bash'].map((t) => matches('PreToolUse', t))).toEqual([true, true, false, false]);
    expect(['Agent', 'Task', 'TaskCreate', 'TaskUpdate', 'TaskList', 'TaskGet', 'AgentX'].map((t) => matches('PostToolUse', t))).toEqual([true, true, true, true, false, false, false]);
    const commandTools = ['Bash', 'PowerShell', 'Monitor', 'SendMessage', 'TaskStop'];
    expect(commandTools.map((t) => matching('PostToolUse', t).map((d) => d.async))).toEqual(commandTools.map(() => [true]));
    expect(['BashOutput', 'TaskStopX', 'Read', 'mcp__x__Bash'].map((t) => matches('PostToolUse', t))).toEqual([false, false, false, false]);
    // No tool runs two InProgress PostToolUse hooks: the groups' matchers never overlap.
    for (const t of ['Agent', 'Task', 'TaskCreate', 'TaskUpdate', ...commandTools]) expect(matching('PostToolUse', t), t).toHaveLength(1);
  });
});

describe('nodeBinary', () => {
  it('resolves the running Node through symlinks, with forward slashes', () => {
    expect(nodeBinary()).toBe(slashed(realpathSync(process.execPath)));
    // nvm4w reaches the active Node through a linked folder: the real path pins the version that was installed.
    const real = tempDir('ip-node-real-');
    writeFileSync(join(real, 'node.exe'), '');
    const link = join(tempDir('ip-node-link-'), 'nodejs');
    symlinkSync(real, link, 'junction');
    expect(nodeBinary(join(link, 'node.exe'))).toBe(slashed(join(realpathSync(real), 'node.exe')));
  });
});

describe('claudeDir', () => {
  it('prefers INPROGRESS_CLAUDE_DIR, then CLAUDE_CONFIG_DIR, then ~/.claude', () => {
    const saved = { INPROGRESS_CLAUDE_DIR: process.env.INPROGRESS_CLAUDE_DIR, CLAUDE_CONFIG_DIR: process.env.CLAUDE_CONFIG_DIR };
    try {
      process.env.INPROGRESS_CLAUDE_DIR = 'C:/tmp/ip-claude';
      process.env.CLAUDE_CONFIG_DIR = 'C:/tmp/claude-config';
      expect(claudeDir()).toBe('C:/tmp/ip-claude');
      delete process.env.INPROGRESS_CLAUDE_DIR;
      expect(claudeDir()).toBe('C:/tmp/claude-config');
      process.env.CLAUDE_CONFIG_DIR = 'relative-claude';
      expect(claudeDir()).toBe(resolve('relative-claude'));
      delete process.env.CLAUDE_CONFIG_DIR;
      expect(claudeDir()).toBe(join(homedir(), '.claude'));
    } finally {
      for (const [key, value] of Object.entries(saved)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }
  });
});

describe('renderTemplate', () => {
  it('fills every placeholder with a forward-slash path and never expands $ patterns', () => {
    const text = 'node {{NODE}} · repo {{REPO}} · resources {{RESOURCES}}/ingame';
    expect(renderTemplate(text, "C:\\odd$&\\repo$'")).toBe(`node ${nodeBinary()} · repo C:/odd$&/repo$' · resources ${slashed(homeDir())}/resources/ingame`);
  });

  it('fills {{TASKS}} with the tasks command prefix the allow rules are built from', () => {
    expect(renderTemplate('{{TASKS}} <step id>', 'c:\\personal\\InProgress\\')).toBe('node C:/personal/InProgress/dist/cli/main.js tasks <step id>');
    expect(renderTemplate('{{TASKS}}', 'C:/My Repos/InProgress')).toBe('node "C:/My Repos/InProgress/dist/cli/main.js" tasks');
  });
});

describe('install', () => {
  it('merges exec-form hooks and allow rules while preserving everything else', () => {
    const dir = claudeDirWithSettings(existing);
    const { log, agentsDirCreated } = install({ repo, claudeDir: dir, stamp: '20260927-120000' });
    expect(agentsDirCreated).toBe(true);
    expect(log.join('\n')).toContain('restart');
    const s = readSettings(dir);
    expect(s.model).toBe('opus');
    expect(s.enabledPlugins).toEqual(existing.enabledPlugins);
    expect(s.permissions.allow).toEqual(['Bash(git status)', ...STATIC_ALLOW_RULES, ...taskRules]);
    expect(s.hooks.Stop).toHaveLength(2);
    expect(s.hooks.Stop[0].hooks[0].command).toBe('other-tool --stop');
    for (const def of HOOK_DEFS) {
      const group = s.hooks[def.event].find((g: { matcher?: string; hooks: object[] }) => g.matcher === def.matcher && g.hooks.some(isInProgressHook));
      const entry = { type: 'command', command: nodeBinary(), args: [`${repo}/dist/hooks/hook.js`, def.name], timeout: def.timeout };
      expect(group.hooks).toEqual([def.async ? { ...entry, async: true } : entry]);
    }
    // The command tools' group is the one async entry, written as Claude Code reads it.
    expect(s.hooks.PostToolUse.map((g: { hooks: { async?: boolean }[] }) => g.hooks[0].async)).toEqual([undefined, true]);
    expect(existsSync(join(dir, 'settings.json.inprogress-backup-20260927-120000'))).toBe(true);
    const agent = readFileSync(join(dir, 'agents', 'inprogress-scribe.md'), 'utf8');
    expect(agent).toContain(`args: ["${repo}/dist/mcp/main.js"]`);
    expect(agent).toContain(`command: "${nodeBinary()}"`);
    expect(agent).not.toMatch(/\{\{\w+\}\}/);
    const skill = readFileSync(join(dir, 'skills', 'inprogress', 'SKILL.md'), 'utf8');
    expect(skill).toContain(`"${nodeBinary()}" "${repo}/dist/cli/main.js" status`);
    expect(skill).not.toMatch(/`node "/);
    // The brief template's resource path; the chat-only rule itself is the briefing's (P8).
    expect(skill).toContain(`${slashed(homeDir())}/resources/ingame/`);
    expect(skill).not.toContain('~/.inprogress/resources');
    expect(skill).not.toMatch(/\{\{\w+\}\}/);
  });

  it('writes the mip-orc skill beside the inprogress skill, with the CLI path filled in', () => {
    const dir = claudeDirWithSettings(existing);
    const { log } = install({ repo, claudeDir: dir, stamp: 'orc' });
    const skill = readFileSync(join(dir, 'skills', 'mip-orc', 'SKILL.md'), 'utf8');
    expect(skill).toMatch(/^name: mip-orc$/m);
    // The commands start with the prefix the installed allow rules use, so none asks for permission.
    const allowed = readSettings(dir).permissions.allow as string[];
    for (const sub of ['orchestrate', 'digest', 'outline'] as const) {
      const prefix = cliPrefix(repoCli(repo), sub);
      expect(skill).toContain(`${prefix} `);
      expect(allowed).toContain(`Bash(${prefix} *)`);
    }
    expect(skill).not.toMatch(/\{\{\w+\}\}/);
    expect(log).toContain(`Skill: ${join(dir, 'skills', 'mip-orc')}`);
  });

  it('writes the full brief template into the skill, which points at the briefing for the rules, and the live-work rules into the scribe', () => {
    const dir = claudeDirWithSettings(existing);
    install({ repo, claudeDir: dir, stamp: 'lw' });
    const skill = readFileSync(join(dir, 'skills', 'inprogress', 'SKILL.md'), 'utf8');
    // For opting in, adopting and the full brief format; never for "what's next" or a restatement of the rules.
    const description = /^description: (.*)$/m.exec(skill)?.[1] ?? '';
    expect(description).toMatch(/[Oo]pt a Claude session into InProgress, adopt an existing project into it, or look up the full .*brief format/);
    expect(description).not.toMatch(/what's next|restated|update rules/i);
    // The briefing's rules are complete; the skill no longer restates them.
    expect(skill).toMatch(/update rules, which are complete/);
    expect(skill).not.toContain('In short');
    expect(skill).not.toMatch(/new request with a deliverable .* becomes a step right away/);
    expect(skill).not.toMatch(/`queue: #a, #b` is this session's own order/);
    // The template: changes, a question and its answer, a relabel, backtracking, a resource, a log, the focus, and
    // the steps queued after the focus, then the unowned order.
    const template = /Brief template:\n\n```\n([\s\S]*?)```/.exec(skill)?.[1] ?? '';
    expect(template).toMatch(/^Session: <session id> · Project: <slug>\nChanges:\n/);
    expect(template).toContain('- #57 → done; outcome "Play app signing configured"');
    // An ask, then its answer; no question step, and no guidance inside the template.
    expect(template).toMatch(/- ask on #55: question, [^\n]+\?\n- a\d+ answered: [^\n]+\n/);
    expect(template).not.toMatch(/\(question/);
    expect(template).toMatch(/- handoff on #55: "[^"]+", path [^\n]+, snapshot_file\n- state on #\d+: /);
    expect(skill).not.toMatch(/needs.you/i);
    expect(template).not.toMatch(/\(the answer/);
    expect(template).toMatch(/- #\d+ label → fix\n/);
    expect(template).toMatch(/- #\d+ → dropped; outcome "[^"]+"\n- move #\d+ under #55 after #57\n/);
    expect(template).toContain(`path ${slashed(homeDir())}/resources/ingame/2026-09-27-signing-test-suite.md, snapshot_file`);
    expect(template).toMatch(/- focus → the new "Run signing tests" node\n- queue: #59, #60\n- later: #61\n$/);
    expect(skill).not.toContain('tasks on #');
    // An opted-in or adopting session gets the full briefing with Aiden's next message, not with the scribe's notice.
    expect(skill).toMatch(/## Opting in[\s\S]*full briefing[^.]*arrives with Aiden's next message after the enroll, not with the scribe's notice/);
    expect(skill).toMatch(/## Adopting[\s\S]*full briefing arrives with Aiden's next message/);
    expect(skill).not.toMatch(/with your next prompt/);
    const agent = readFileSync(join(dir, 'agents', 'inprogress-scribe.md'), 'utf8');
    expect(agent).toMatch(/`set_queue`/);
    expect(agent).toMatch(/`queue: #a, #b`.*`set_queue` with those ids, next first, and `session`/);
    expect(agent).toMatch(/`later: #c, #d`.*`set_queue` with `unowned: true`/);
    expect(agent).not.toMatch(/whole queue/);
    // An adoption enrolls the session before it queues: a queue for a session not enrolled is refused.
    expect(agent).toMatch(/then `enroll_session` and `set_focus`, and only then `set_queue`/);
    // The scribe no longer sets working tasks: the main session runs the tasks command itself.
    expect(agent).not.toMatch(/set_tasks|tasks on #/);
  });

  it('writes the tasks command into the skill, exactly as the allow rules allow it', () => {
    const dir = claudeDirWithSettings(existing);
    install({ repo, claudeDir: dir, stamp: 'tc' });
    const skill = readFileSync(join(dir, 'skills', 'inprogress', 'SKILL.md'), 'utf8');
    expect(skill).toContain(`\`node ${repo}/dist/cli/main.js tasks <step id> --session <session id> --done "…" --doing "…" --todo "…"\``);
    // The rule's text minus " *" is the start of the command the skill prints: Claude Code matches by prefix.
    const skillPrefix = /`(node \S+ tasks) <step id> --session <session id>/.exec(skill)?.[1];
    expect(skillPrefix).toBe(taskPrefix(repoCli(repo)));
    const rules = readSettings(dir).permissions.allow.filter((r: string) => r.includes(' tasks '));
    expect(rules).toHaveLength(2);
    for (const rule of rules) expect(rule.replace(/^\w+\(/, '').replace(/ \*\)$/, ''), rule).toBe(skillPrefix);
    // The first paragraph names the exception to "you never edit it yourself"; nothing prints a step as "tasks #".
    expect(skill).toMatch(/You never edit it yourself, with one exception: .*tasks/);
    expect(skill).not.toMatch(/tasks #/);
    // Windows PowerShell 5.1 splits a " even inside single quotes, which could retarget the write to another step.
    expect(skill).toContain('Put single quotes around a subject that contains `$` or a backtick, and leave double quotes out of subjects.');
    expect(skill).not.toMatch(/single quotes around a subject that contains[^.]*`"`/);
    // It sits in the opt-in steps, for the prompts before the briefing arrives, and prefers the Bash tool, whose
    // permission check matches at once (PowerShell's can time out and ask).
    const optIn = /## Opting in[^\n]*\n([\s\S]*?)\n## /.exec(skill)?.[1] ?? '';
    expect(optIn).toContain(`\`node ${repo}/dist/cli/main.js tasks <step id> --session <session id>`);
    expect(optIn).toMatch(/Run it with the Bash tool/);
    expect(skill).not.toMatch(/runs in the Bash and the PowerShell tool/);
  });

  it('allows the tasks command in the Bash and the PowerShell tool, keeping the static rules and every other rule', () => {
    expect(allowRules(repo)).toEqual([...STATIC_ALLOW_RULES, ...taskRules]);
    const dir = claudeDirWithSettings({ ...existing, permissions: { allow: ['Bash(git status)', 'Bash(npm test:*)', 'Bash(node C:/tools/x.js tasks *)'], deny: ['Bash(rm:*)'] } });
    const { log } = install({ repo, claudeDir: dir, stamp: 'ar' });
    expect(readSettings(dir).permissions).toEqual({
      allow: ['Bash(git status)', 'Bash(npm test:*)', 'Bash(node C:/tools/x.js tasks *)', ...STATIC_ALLOW_RULES, ...taskRules],
      deny: ['Bash(rm:*)'],
    });
    expect(log).toContain(`Allow rules: ${[...STATIC_ALLOW_RULES, ...taskRules].join(', ')}`);
  });

  it.runIf(process.platform === 'win32')('normalises the repo path, so the rules match what the server prints whatever drive-letter case install got', () => {
    const lower = `${repo[0].toLowerCase()}${repo.slice(1)}/`;
    const dir = claudeDirWithSettings(existing);
    install({ repo: lower, claudeDir: dir, stamp: 'lc' });
    const s = readSettings(dir);
    expect(s.permissions.allow).toEqual(['Bash(git status)', ...STATIC_ALLOW_RULES, ...taskRules]);
    expect(s.hooks.Stop.at(-1).hooks[0].args[0]).toBe(`${repo}/dist/hooks/hook.js`);
    expect(readFileSync(join(dir, 'skills', 'inprogress', 'SKILL.md'), 'utf8')).toContain(`\`${taskPrefix(repoCli(lower))} <step id>`);
    expect(kitStatus({ repo: lower, claudeDir: dir })).toEqual({ installed: true, differs: [] });
  });

  it("upgrades an older install's rules (the two static ones) to the tasks rules, once each", () => {
    const old = JSON.parse(JSON.stringify(withInstall(existing)));
    old.permissions.allow = ['Bash(git status)', ...STATIC_ALLOW_RULES];
    const dir = claudeDirWithSettings(old);
    expect(kitStatus({ repo, claudeDir: dir }).differs).toContain('settings');
    install({ repo, claudeDir: dir, stamp: 'up1' });
    expect(readSettings(dir)).toEqual(withInstall(existing));
    install({ repo, claudeDir: dir, stamp: 'up2' });
    expect(readSettings(dir)).toEqual(withInstall(existing));
  });

  it('replaces the tasks rules an older checkout left, before adding its own', () => {
    const dir = claudeDirWithSettings({ ...existing, permissions: { allow: ['Bash(git status)', ...staleTaskRules, 'mcp__inprogress'] } });
    install({ repo, claudeDir: dir, stamp: 'st' });
    expect(readSettings(dir).permissions.allow).toEqual(['Bash(git status)', 'mcp__inprogress', 'Edit(~/.inprogress/resources/**)', ...taskRules]);
  });

  it('leaves the tasks rules out for a repo path with a space, and says why', () => {
    const spaced = fixtureRepo('ip repo-');
    const dir = claudeDirWithSettings({ ...existing, permissions: { allow: ['Bash(git status)', ...staleTaskRules] } });
    const { log } = install({ repo: spaced, claudeDir: dir, stamp: 'sp' });
    // Nothing could allow it, and another checkout's rules still go.
    expect(readSettings(dir).permissions.allow).toEqual(['Bash(git status)', ...STATIC_ALLOW_RULES]);
    expect(log).toContain(`Allow rules: ${STATIC_ALLOW_RULES.join(', ')}`);
    expect(log.join('\n')).toMatch(/Left out the allow rules for the tasks, claim, ask, orchestrate and digest commands: the repo path .*ip repo-.* holds a space/);
    expect(kitStatus({ repo: spaced, claudeDir: dir }).differs).not.toContain('settings');
    // The skill quotes the path, as the briefing does, so its command still runs (with a prompt).
    const skill = readFileSync(join(dir, 'skills', 'inprogress', 'SKILL.md'), 'utf8');
    expect(skill).toContain(`\`node "${spaced}/dist/cli/main.js" tasks <step id> --session <session id>`);
  });

  it('writes the type-label rules into the skill and the scribe', () => {
    const dir = claudeDirWithSettings(existing);
    install({ repo, claudeDir: dir, stamp: 'tl' });
    const skill = readFileSync(join(dir, 'skills', 'inprogress', 'SKILL.md'), 'utf8');
    // Claude picks the label as it briefs a new step, by the picking rule, and relabels when the purpose changes. The
    // test gates moved to the inprogress project's playbook.
    expect(skill).toContain('`add under #41: "Faster cold start" (task, server)`');
    expect(skill).toContain('⧉ `ui` · ⚙ `server` · ⛁ `data` · ⇄ `integration` · ⚒ `ops` · ¶ `docs` · ⚑ `fix` · ↻ `refactor` · ⌕ `research`');
    expect(skill).toMatch(/Pick by purpose first \(`fix`, `refactor`, `research`\), else by where the work lands/);
    expect(skill).toMatch(/[Rr]elabel .* when its purpose changes/);
    for (const row of ['| `ui` |', '| `integration` |', '| `data` |', '| everything else |', '| Label | Gate |']) expect(skill, row).not.toContain(row);
    expect(skill).not.toMatch(/test gate|typecheck/i);
    const agent = readFileSync(join(dir, 'agents', 'inprogress-scribe.md'), 'utf8');
    expect(agent).toMatch(/`label`/);
    expect(agent).toMatch(/[Nn]ever invent a label/);
    expect(agent).toMatch(/no label .* unlabelled/);
  });

  it('writes the no-em-dash rule into the scribe and the skill', () => {
    const dir = claudeDirWithSettings(existing);
    install({ repo, claudeDir: dir, stamp: 'ed' });
    const agent = readFileSync(join(dir, 'agents', 'inprogress-scribe.md'), 'utf8');
    const skill = readFileSync(join(dir, 'skills', 'inprogress', 'SKILL.md'), 'utf8');
    for (const text of [agent, skill]) expect(text).toMatch(/Never write an em dash.*: use a comma, a colon, a period or " · "/);
  });

  it('begins its log with the target Claude directory and the node binary it wrote', () => {
    const dir = claudeDirWithSettings(existing);
    const { log } = install({ repo, claudeDir: dir, stamp: 's' });
    expect(log.slice(0, 2)).toEqual([`Claude directory: ${dir}`, `Node binary: ${nodeBinary()}`]);
  });

  it('is idempotent across every hook event and allow rule', () => {
    const dir = claudeDirWithSettings(existing);
    mkdirSync(join(dir, 'agents'));
    install({ repo, claudeDir: dir, stamp: 'a' });
    const once = readSettings(dir);
    const second = install({ repo, claudeDir: dir, stamp: 'b' });
    expect(second.agentsDirCreated).toBe(false);
    expect(readSettings(dir)).toEqual(once);
    expect(once).toEqual(withInstall(existing));
    for (const d of HOOK_DEFS) {
      const ours = once.hooks[d.event].filter((g: { matcher?: string }) => g.matcher === d.matcher).flatMap((g: { hooks: object[] }) => g.hooks).filter(isInProgressHook);
      expect(ours, `${d.event} ${d.matcher ?? ''}`).toHaveLength(1);
    }
    for (const rule of allowRules(repo)) expect(once.permissions.allow.filter((r: string) => r === rule), rule).toHaveLength(1);
  });

  it('works without a settings file or Claude directory, and makes no backup', () => {
    const dir = join(tempDir('ip-claude-'), 'fresh');
    const { log } = install({ repo, claudeDir: dir, stamp: 'c' });
    const s = readSettings(dir);
    expect(Object.keys(s.hooks).sort()).toEqual([...new Set(HOOK_DEFS.map((d) => d.event))].sort());
    expect(s.permissions.allow).toEqual(allowRules(repo));
    expect(backups(dir)).toEqual([]);
    expect(log.join('\n')).not.toContain('Backed up');
  });

  it("keeps other tools' hooks, even ones with the same script layout", () => {
    const dir = claudeDirWithSettings(withForeign);
    const first = install({ repo, claudeDir: dir, stamp: 'f' });
    expect(readSettings(dir)).toEqual(withInstall(withForeign));
    expect(first.log.join('\n')).not.toContain('Replaced');
    const second = install({ repo, claudeDir: dir, stamp: 'g' });
    expect(readSettings(dir)).toEqual(withInstall(withForeign));
    expect(second.log.join('\n')).toContain(`Replaced ${HOOK_DEFS.length} existing InProgress hook entries`);
  });

  it('keeps a foreign entry that shares a group with an InProgress entry', () => {
    const dir = claudeDirWithSettings({ hooks: { Stop: [{ hooks: [foreignExec, hookEntry(repo, 'stop', 5)] }] } });
    const { log } = install({ repo, claudeDir: dir, stamp: 'm' });
    expect(readSettings(dir).hooks.Stop).toEqual([{ hooks: [foreignExec] }, { hooks: [hookEntry(repo, 'stop', 5)] }]);
    expect(log).toContain('Replaced 1 existing InProgress hook entry');
    uninstall({ claudeDir: dir, stamp: 'n' });
    expect(readSettings(dir)).toEqual({ hooks: { Stop: [{ hooks: [foreignExec] }] } });
  });

  it('reads a settings.json that starts with a UTF-8 BOM', () => {
    const dir = claudeDirWithSettings(`\uFEFF${JSON.stringify(existing, null, 2)}`);
    install({ repo, claudeDir: dir, stamp: 'bom' });
    expect(readSettings(dir)).toEqual(withInstall(existing));
  });

  it('treats an empty or whitespace-only settings.json as {}', () => {
    for (const text of ['', ' \r\n\t']) {
      const dir = claudeDirWithSettings(text);
      install({ repo, claudeDir: dir, stamp: 'empty' });
      expect(readSettings(dir).permissions.allow).toEqual(allowRules(repo));
    }
  });

  it.each([
    ['malformed JSON', '{ "hooks": ', /is not valid JSON \(.+\); nothing was changed$/],
    ['a top level that is not an object', '[1, 2]', /: the top level is not a JSON object; nothing was changed$/],
    ['a hook event that is not an array', JSON.stringify({ hooks: { Stop: { hooks: [] } } }), /: "hooks\.Stop" is not an array; nothing was changed$/],
    ['a hook group without a hooks array', JSON.stringify({ hooks: { Stop: [{ hooks: 'x' }] } }), /: "hooks\.Stop\[0\]\.hooks" is not an array; nothing was changed$/],
    ['an allow list that is not an array', JSON.stringify({ permissions: { allow: 'mcp__inprogress' } }), /: "permissions\.allow" is not an array; nothing was changed$/],
  ])('refuses %s before writing anything', (_label, text, error) => {
    const dir = claudeDirWithSettings(text);
    // An earlier install's files, which uninstall would otherwise delete.
    mkdirSync(join(dir, 'agents'));
    writeFileSync(join(dir, 'agents', 'inprogress-scribe.md'), 'agent');
    mkdirSync(join(dir, 'skills', 'inprogress'), { recursive: true });
    writeFileSync(join(dir, 'skills', 'inprogress', 'SKILL.md'), 'skill');
    const before = snapshot(dir);
    for (const run of [() => install({ repo, claudeDir: dir, stamp: 'bad' }), () => uninstall({ claudeDir: dir, stamp: 'bad' })]) {
      const message = thrownBy(run);
      expect(message.startsWith(`settings.json at ${join(dir, 'settings.json')}`)).toBe(true);
      expect(message).toMatch(error);
    }
    expect(snapshot(dir)).toEqual(before);
  });

  it('refuses to install from an unbuilt repo before writing anything', () => {
    for (const entry of ['dist/hooks/hook.js', 'dist/mcp/main.js']) {
      const unbuilt = fixtureRepo();
      rmSync(join(unbuilt, entry));
      const dir = claudeDirWithSettings(existing);
      const before = snapshot(dir);
      expect(thrownBy(() => install({ repo: unbuilt, claudeDir: dir, stamp: 'nb' }))).toContain('Build InProgress first: npm run deploy');
      expect(snapshot(dir)).toEqual(before);
    }
  });

  it('renders the templates before writing anything', () => {
    const broken = fixtureRepo();
    rmSync(join(broken, 'claude', 'skills'), { recursive: true });
    const dir = claudeDirWithSettings(existing);
    const before = snapshot(dir);
    expect(thrownBy(() => install({ repo: broken, claudeDir: dir, stamp: 't' }))).toMatch(/ENOENT/);
    expect(snapshot(dir)).toEqual(before);
  });

  it('never overwrites an earlier backup with the same stamp', () => {
    const dir = claudeDirWithSettings(existing);
    const first = join(dir, 'settings.json.inprogress-backup-20260927-120000');
    writeFileSync(first, 'earlier backup');
    const { log } = install({ repo, claudeDir: dir, stamp: '20260927-120000' });
    expect(readFileSync(first, 'utf8')).toBe('earlier backup');
    expect(JSON.parse(readFileSync(`${first}-1`, 'utf8'))).toEqual(existing);
    expect(log).toContain(`Backed up settings to ${first}-1`);
    install({ repo, claudeDir: dir, stamp: '20260927-120000' });
    expect(existsSync(`${first}-2`)).toBe(true);
  });

  it('keeps only the newest five settings backups', () => {
    const dir = claudeDirWithSettings(existing);
    const older = ['20260920-090000', '20260921-090000', '20260922-090000', '20260922-090000-1', '20260923-090000', '20260924-090000-2', '20260924-090000-10'];
    for (const stamp of older) writeFileSync(join(dir, `settings.json.inprogress-backup-${stamp}`), stamp);
    writeFileSync(join(dir, 'settings.json.unrelated'), 'keep me');
    const { log } = install({ repo, claudeDir: dir, stamp: '20260925-090000' });
    const kept = ['20260922-090000-1', '20260923-090000', '20260924-090000-2', '20260924-090000-10', '20260925-090000'];
    expect(backups(dir)).toEqual(kept.map((s) => `settings.json.inprogress-backup-${s}`).sort());
    expect(readFileSync(join(dir, 'settings.json.unrelated'), 'utf8')).toBe('keep me');
    expect(log).toContain('Removed 3 older settings backups (keeping the newest 5)');
  });
});

describe('uninstall', () => {
  it('removes exactly what install added', () => {
    const dir = claudeDirWithSettings(existing);
    install({ repo, claudeDir: dir, stamp: 'd' });
    const log = uninstall({ claudeDir: dir, stamp: 'e' });
    expect(log[0]).toBe(`Claude directory: ${dir}`);
    const s = readSettings(dir);
    expect(s).toEqual(existing);
    expect(existsSync(join(dir, 'agents', 'inprogress-scribe.md'))).toBe(false);
    expect(existsSync(join(dir, 'skills', 'inprogress'))).toBe(false);
    expect(existsSync(join(dir, 'skills', 'mip-orc'))).toBe(false);
  });

  it("round-trips settings that hold other tools' hooks and counts what it removed", () => {
    const dir = claudeDirWithSettings(withForeign);
    install({ repo, claudeDir: dir, stamp: 'h' });
    const log = uninstall({ claudeDir: dir, stamp: 'i' });
    expect(readSettings(dir)).toEqual(withForeign);
    expect(log.join('\n')).toContain(`Removed ${HOOK_DEFS.length} InProgress hook entries`);
  });

  it("strips the async group and keeps other tools' async hooks on the same tools", () => {
    const foreignAsync = { type: 'command', command: 'C:/x/node.exe', args: ['C:/tools/foo/bin/check.js', 'post-tool'], async: true };
    const settings = { ...existing, hooks: { ...existing.hooks, PostToolUse: [{ matcher: '^(Bash|PowerShell|Monitor|SendMessage|TaskStop)$', hooks: [foreignAsync] }] } };
    const dir = claudeDirWithSettings(settings);
    install({ repo, claudeDir: dir, stamp: 'as1' });
    const installed = readSettings(dir);
    expect(installed.hooks.PostToolUse[0]).toEqual(settings.hooks.PostToolUse[0]);
    expect(installed.hooks.PostToolUse).toHaveLength(3);
    const log = uninstall({ claudeDir: dir, stamp: 'as2' });
    expect(readSettings(dir)).toEqual(settings);
    expect(log.join('\n')).toContain(`Removed ${HOOK_DEFS.length} InProgress hook entries`);
  });

  it("removes the tasks rules of any checkout by their pattern, and leaves every other allow rule", () => {
    const others = ['Bash(git status)', 'Bash(npm test:*)', 'Bash(node C:/tools/x.js tasks *)', 'Bash(node C:/x/dist/cli/main.js usage *)'];
    const dir = claudeDirWithSettings({ ...existing, permissions: { allow: others } });
    install({ repo, claudeDir: dir, stamp: 'ua' });
    // A rule left by another checkout, which uninstall (it takes no repo) must find too.
    const settings = readSettings(dir);
    settings.permissions.allow.push(...staleTaskRules);
    writeFileSync(join(dir, 'settings.json'), JSON.stringify(settings, null, 2));
    uninstall({ claudeDir: dir, stamp: 'ub' });
    expect(readSettings(dir)).toEqual({ ...existing, permissions: { allow: others } });
  });

  it('leaves settings without permissions or hooks as they were, and drops what it emptied', () => {
    const plain = { model: 'opus' };
    const dir = claudeDirWithSettings(plain);
    uninstall({ claudeDir: dir, stamp: 'u1' });
    expect(readSettings(dir)).toEqual(plain);
    install({ repo, claudeDir: dir, stamp: 'u2' });
    uninstall({ claudeDir: dir, stamp: 'u3' });
    expect(readSettings(dir)).toEqual(plain);
    // An allow list InProgress never touched stays, even when empty.
    const untouched = { permissions: { allow: [], ask: ['Bash(rm:*)'] } };
    const other = claudeDirWithSettings(untouched);
    uninstall({ claudeDir: other, stamp: 'u4' });
    expect(readSettings(other)).toEqual(untouched);
  });
});

describe('kitStatus', () => {
  it('tells not installed, in sync, and which parts differ from what install would write', () => {
    const dir = claudeDirWithSettings({ theme: 'dark' });
    expect(kitStatus({ repo, claudeDir: dir })).toEqual({ installed: false, differs: ['settings', 'agent', 'skill'] });
    install({ repo, claudeDir: dir, stamp: 'k1' });
    expect(kitStatus({ repo, claudeDir: dir })).toEqual({ installed: true, differs: [] });
    // A newer skill template, an edited agent file and a missing allow rule are each reported.
    const changed = fixtureRepo();
    writeFileSync(join(changed, 'claude', 'skills', 'inprogress', 'SKILL.md'), 'new skill text');
    writeFileSync(join(dir, 'agents', 'inprogress-scribe.md'), 'edited by hand');
    const settings = readSettings(dir);
    settings.permissions.allow = settings.permissions.allow.filter((r: string) => r !== 'mcp__inprogress');
    writeFileSync(join(dir, 'settings.json'), JSON.stringify(settings, null, 2));
    expect(kitStatus({ repo: changed, claudeDir: dir })).toEqual({ installed: true, differs: ['settings', 'agent', 'skill'] });
  });

  it('reports a changed, missing or extra file in the mip-orc skill as a skill difference', () => {
    const dir = claudeDirWithSettings({ theme: 'dark' });
    install({ repo, claudeDir: dir, stamp: 'ko1' });
    const file = join(dir, 'skills', 'mip-orc', 'SKILL.md');
    writeFileSync(file, 'edited by hand');
    expect(kitStatus({ repo, claudeDir: dir })).toEqual({ installed: true, differs: ['skill'] });
    install({ repo, claudeDir: dir, stamp: 'ko2' });
    expect(kitStatus({ repo, claudeDir: dir })).toEqual({ installed: true, differs: [] });
    rmSync(join(dir, 'skills', 'mip-orc'), { recursive: true });
    expect(kitStatus({ repo, claudeDir: dir })).toEqual({ installed: true, differs: ['skill'] });
    install({ repo, claudeDir: dir, stamp: 'ko3' });
    writeFileSync(join(dir, 'skills', 'mip-orc', 'extra.md'), 'x');
    expect(kitStatus({ repo, claudeDir: dir })).toEqual({ installed: true, differs: ['skill'] });
  });

  it('reports the settings as different for an install from before the async command-tools group, until install runs again', () => {
    const dir = claudeDirWithSettings({ theme: 'dark' });
    install({ repo, claudeDir: dir, stamp: 'ka1' });
    // What the previous kit wrote: the same hooks without the async group.
    const settings = readSettings(dir);
    settings.hooks.PostToolUse = settings.hooks.PostToolUse.filter((g: { hooks: { async?: boolean }[] }) => !g.hooks[0].async);
    writeFileSync(join(dir, 'settings.json'), JSON.stringify(settings, null, 2));
    expect(kitStatus({ repo, claudeDir: dir })).toEqual({ installed: true, differs: ['settings'] });
    // The group without its async flag would make every Bash call wait on the hook: also a difference.
    const sync = readSettings(dir);
    sync.hooks.PostToolUse.push({ matcher: '^(Bash|PowerShell|Monitor|SendMessage|TaskStop)$', hooks: [hookEntry(repo, 'post-tool', 5)] });
    writeFileSync(join(dir, 'settings.json'), JSON.stringify(sync, null, 2));
    expect(kitStatus({ repo, claudeDir: dir })).toEqual({ installed: true, differs: ['settings'] });
    install({ repo, claudeDir: dir, stamp: 'ka2' });
    expect(kitStatus({ repo, claudeDir: dir })).toEqual({ installed: true, differs: [] });
    expect(readSettings(dir).hooks.PostToolUse.filter((g: { hooks: { async?: boolean }[] }) => g.hooks[0].async)).toHaveLength(1);
  });

  it('reports the settings as different when a tasks rule is missing or belongs to another checkout', () => {
    const dir = claudeDirWithSettings({ theme: 'dark' });
    install({ repo, claudeDir: dir, stamp: 'kt' });
    const settings = readSettings(dir);
    const write = (allow: string[]) => writeFileSync(join(dir, 'settings.json'), JSON.stringify({ ...settings, permissions: { allow } }, null, 2));
    write([...STATIC_ALLOW_RULES, taskRules[0]]);
    expect(kitStatus({ repo, claudeDir: dir })).toEqual({ installed: true, differs: ['settings'] });
    write([...STATIC_ALLOW_RULES, ...staleTaskRules]);
    expect(kitStatus({ repo, claudeDir: dir })).toEqual({ installed: true, differs: ['settings'] });
    write([...STATIC_ALLOW_RULES, ...taskRules]);
    expect(kitStatus({ repo, claudeDir: dir })).toEqual({ installed: true, differs: [] });
  });
});

describe('allow rules for every session command', () => {
  it('are twelve: two tools for each of tasks, claim, ask, orchestrate, digest and outline', () => {
    expect(cliAllowRules(repoCli(repo))).toEqual(taskRules);
    expect(taskRules).toHaveLength(12);
    expect(cliAllowRules(repoCli('C:/My Repos/InProgress'))).toEqual([]);
  });

  it('are recognised for any repo path and subcommand, and nothing else', () => {
    for (const rule of [...taskRules, ...cliAllowRules(repoCli('D:/old/checkout'))]) expect(isCliAllowRule(rule), rule).toBe(true);
    for (const rule of [`Bash(node ${repo}/dist/cli/main.js rm *)`, `Bash(node ${repo}/dist/cli/main.js usage *)`, 'Bash(git status)', 'mcp__inprogress']) expect(isCliAllowRule(rule), rule).toBe(false);
  });
});
