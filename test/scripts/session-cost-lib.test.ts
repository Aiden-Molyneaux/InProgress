import { describe, expect, it } from 'vitest';
import {
  MAIN, agentWorktreeEntry, branchOfWorktree, committedWithin, isCold, nameMerges, parseMainLog,
  parseWorktreeList, priceOf, readCallsFromText,
} from '../../scripts/session-cost-lib.mjs';

const usage = (o: Partial<{ input: number; cacheRead: number; cw5m: number; cw1h: number; output: number }> = {}) =>
  ({ input: 0, cacheRead: 0, cw5m: 0, cw1h: 0, output: 0, ...o });

/** One assistant request as Claude Code writes it to a transcript. */
function assistant(id: string, o: { model?: string; branch?: string; tools?: object[]; out?: number } = {}): string {
  return JSON.stringify({
    type: 'assistant',
    timestamp: '2026-10-09T10:00:00.000Z',
    gitBranch: o.branch ?? 'main',
    message: {
      id,
      model: o.model ?? 'claude-opus-5-5',
      content: o.tools ?? [],
      usage: { input_tokens: 1, cache_read_input_tokens: 0, cache_creation: { ephemeral_5m_input_tokens: 0, ephemeral_1h_input_tokens: 0 }, output_tokens: o.out ?? 1 },
    },
  });
}
const tool = (id: string, name: string, input: object) => ({ type: 'tool_use', id, name, input });
const worktrees = () => new Map([
  ['goto', 'goto'],
  ['quiet-t1', 'quiet/t1-tokens'],
  ['agent-ae03e131a99d47df8', '#98 P4 session identity implementer'],
]);
const branches = (lines: string[], map = worktrees()) => readCallsFromText(lines.join('\n'), MAIN, map).calls.map((c) => c.branch);
/** The branch of three requests: one on feat/x, one that runs `command`, and the one after it. */
const branchesAfter = (command: string) => branches([assistant('a', { branch: 'feat/x' }), assistant('b', { tools: [tool('t1', 'Bash', { command })] }), assistant('c')]);

describe('priceOf', () => {
  it('prices every bucket at Opus 5.5 list rates', () => {
    const m = 1_000_000;
    expect(priceOf('claude-opus-5-5', usage({ input: m, cacheRead: m, cw5m: m, cw1h: m, output: m }))).toEqual({ input: 4, write: 13, read: 0.2, output: 20 });
  });
  it('moves Haiku 5.5 to its long card on prompts over 100K', () => {
    expect(priceOf('claude-haiku-5-5', usage({ input: 100_000 }))!.input).toBeCloseTo(0.01, 10);
    expect(priceOf('claude-haiku-5-5', usage({ input: 100_001 }))!.input).toBeCloseTo(0.0500005, 10);
  });
  it('ignores a dated suffix and returns null for an unknown model', () => {
    expect(priceOf('claude-haiku-4-5-20251001', usage({ output: 1_000_000 }))!.output).toBe(5);
    expect(priceOf('claude-mystery-9', usage({ input: 1 }))).toBeNull();
  });
});

describe('readCallsFromText', () => {
  it('keeps the last usage line written for a message id', () => {
    const { calls } = readCallsFromText([assistant('m1', { out: 5 }), assistant('m1', { out: 9 })].join('\n'), MAIN, new Map());
    expect(calls).toHaveLength(1);
    expect(calls[0].output).toBe(9);
  });
  it('skips synthetic messages and a partial last line', () => {
    const raw = [assistant('m1'), assistant('m2', { model: '<synthetic>' }), '{"type":"assist'].join('\n');
    expect(readCallsFromText(raw, MAIN, new Map()).calls).toHaveLength(1);
  });
  it('prices a message id once across texts that share a seen set, and still keeps the last line within one text', () => {
    const seen = new Set<string>();
    const first = readCallsFromText([assistant('m1', { out: 1 }), assistant('m2', { out: 2 }), assistant('m2', { out: 3 })].join('\n'), MAIN, new Map(), seen);
    // A forked or resumed session's file starts with copies of the messages it was forked from.
    const second = readCallsFromText([assistant('m2', { out: 20 }), assistant('m3', { out: 4 })].join('\n'), MAIN, new Map(), seen);
    expect(first.calls.map((c) => c.output)).toEqual([1, 3]);
    expect(second.calls.map((c) => c.output)).toEqual([4]);
    expect([...seen].sort()).toEqual(['m1', 'm2', 'm3']);
  });
});

describe('attribution', () => {
  it('follows a feature gitBranch and carries it forward', () => {
    expect(branches([assistant('a', { branch: 'feat/x' }), assistant('b')])).toEqual(['feat/x', 'feat/x']);
  });
  it('follows a worktree path in a tool call, with Windows separators', () => {
    const read = tool('t1', 'Read', { file_path: 'C:\\personal\\InProgress\\.claude\\worktrees\\quiet-t1\\src\\a.ts' });
    expect(branches([assistant('a'), assistant('b', { tools: [read] })])).toEqual([MAIN, 'quiet/t1-tokens']);
  });
  it('follows a created branch and learns its worktree', () => {
    const map = worktrees();
    const add = tool('t1', 'Bash', { command: 'git worktree add .claude/worktrees/new-thing -b feat/new-thing main' });
    const edit = tool('t2', 'Edit', { file_path: 'C:/personal/InProgress/.claude/worktrees/new-thing/x.ts' });
    expect(branches([assistant('a', { tools: [add] }), assistant('b'), assistant('c', { tools: [edit] })], map))
      .toEqual(['feat/new-thing', 'feat/new-thing', 'feat/new-thing']);
    expect(map.get('new-thing')).toBe('feat/new-thing');
  });
  it('ends a branch after a merge in the main checkout, not after one inside a worktree', () => {
    const mergeMain = tool('t1', 'Bash', { command: 'git merge --no-ff goto -m "Merge"' });
    const mergeInWorktree = tool('t2', 'Bash', { command: 'git -C .claude/worktrees/goto merge main' });
    expect(branches([assistant('a', { branch: 'feat/x' }), assistant('b', { tools: [mergeMain] }), assistant('c')])).toEqual(['feat/x', 'feat/x', MAIN]);
    expect(branches([assistant('a', { tools: [mergeInWorktree] }), assistant('b')])).toEqual(['goto', 'goto']);
  });
  it('sees a merge followed by its cleanup in one command, but not a merge after moving into a worktree', () => {
    const mergeAndClean = tool('t1', 'Bash', { command: 'git merge --no-ff goto -m "Merge" && git worktree remove .claude/worktrees/goto' });
    const cdThenMerge = tool('t2', 'Bash', { command: 'cd .claude/worktrees/goto && git merge main' });
    expect(branches([assistant('a', { branch: 'feat/x' }), assistant('b', { tools: [mergeAndClean] }), assistant('c')])).toEqual(['feat/x', 'feat/x', MAIN]);
    expect(branches([assistant('a', { tools: [cdThenMerge] }), assistant('b')])).toEqual(['goto', 'goto']);
  });
  it('does not read a merge into quoted text or a heredoc body', () => {
    const quoted = tool('t1', 'Bash', { command: 'git commit -m "Fix: x; git merge y"' });
    const heredoc = tool('t2', 'Bash', { command: "git commit -q -F - <<'EOF'\nTitle\n\ngit merge main is mentioned here\nEOF\ngit log --oneline -1" });
    const echoed = tool('t3', 'Bash', { command: 'echo "run:\ngit merge main"' });
    for (const t of [quoted, heredoc, echoed]) {
      expect(branches([assistant('a', { branch: 'feat/x' }), assistant('b', { tools: [t] }), assistant('c')])).toEqual(['feat/x', 'feat/x', 'feat/x']);
    }
  });
  it('learns no branch from a worktree added at HEAD, a commit id or a remote ref', () => {
    for (const ref of ['HEAD', 'abc1234', 'origin/main']) {
      const map = worktrees();
      readCallsFromText(assistant('a', { tools: [tool('t1', 'Bash', { command: `git worktree add .claude/worktrees/foo ${ref}` })] }), MAIN, map);
      expect(map.has('foo')).toBe(false);
    }
  });
  it('ends a branch for a git merge anywhere in a command chain', () => {
    for (const command of [
      'git merge --no-ff x',
      'cd /c/personal/InProgress && git merge --no-ff x -m "Merge x" && npm run deploy',
      'git status; git merge x',
      'git -C /c/personal/InProgress merge x',
    ]) {
      expect(branchesAfter(command), command).toEqual(['feat/x', 'feat/x', MAIN]);
    }
  });
  it('does not end a branch for a command that only mentions a merge', () => {
    for (const command of [
      'git merge-base main HEAD',
      'git merge --abort',
      'git merge --quit',
      'git log --oneline --grep="git merge"',
      'grep -rn "git merge" docs',
      'git commit -m "Fix git merge detection"',
    ]) {
      expect(branchesAfter(command), command).toEqual(['feat/x', 'feat/x', 'feat/x']);
    }
  });
  it('does not follow a worktree that a cleanup command removes', () => {
    for (const command of [
      'git worktree remove .claude/worktrees/old',
      'git worktree remove --force .claude/worktrees/old && git branch -D old',
      'git -C /c/personal/InProgress worktree remove .claude\\worktrees\\old',
      'git worktree prune && rm -rf .claude/worktrees/old',
    ]) {
      expect(branchesAfter(command), command).toEqual(['feat/x', 'feat/x', 'feat/x']);
    }
  });
  it('stays on main through the post-merge cleanup', () => {
    const merge = tool('t1', 'Bash', { command: 'git merge --no-ff goto -m "Merge"' });
    const cleanup = tool('t2', 'Bash', { command: 'git worktree remove .claude/worktrees/goto && git branch -d goto' });
    expect(branches([assistant('a', { branch: 'feat/x' }), assistant('b', { tools: [merge] }), assistant('c', { tools: [cleanup] }), assistant('d')]))
      .toEqual(['feat/x', 'feat/x', MAIN, MAIN]);
  });
  it('learns the branch of a worktree added for an existing branch, and not of a detached one', () => {
    const map = worktrees();
    const add = (id: string, command: string) => assistant(id, { tools: [tool(id, 'Bash', { command })] });
    expect(branches([add('a', 'git worktree add .claude/worktrees/foo existing-branch')], map)).toEqual(['existing-branch']);
    expect(map.get('foo')).toBe('existing-branch');
    branches([add('b', 'git worktree add -f .claude/worktrees/bar team/other-branch')], map);
    expect(map.get('bar')).toBe('team/other-branch');
    branches([add('c', 'git worktree add --detach .claude/worktrees/baz HEAD'), add('d', 'git worktree add .claude/worktrees/qux')], map);
    expect(map.has('baz')).toBe(false);
    expect(map.has('qux')).toBe(false);
  });
  it('resolves a trailing dot always, and a prefix only for a glob', () => {
    expect(branchOfWorktree('goto.', worktrees())).toBe('goto');
    expect(branchOfWorktree('agent-ae03', worktrees(), true)).toBe('#98 P4 session identity implementer');
    expect(branchOfWorktree('agent-ae03', worktrees())).toBe('agent-ae03');
    expect(branchOfWorktree('unknown-wt', worktrees())).toBe('unknown-wt');
  });
  it('treats a worktree glob in a command as that worktree', () => {
    const ls = tool('t1', 'Bash', { command: 'ls -d /c/personal/InProgress/.claude/worktrees/agent-ae03* 2>&1' });
    expect(branches([assistant('a', { tools: [ls] })])).toEqual(['#98 P4 session identity implementer']);
  });
  it('records the branch current when each tool call was issued, for subagents to start from', () => {
    const dispatch = tool('toolu_1', 'Agent', { description: '#1 build', prompt: 'Work in .claude/worktrees/goto only.' });
    expect(readCallsFromText(assistant('a', { tools: [dispatch] }), MAIN, worktrees()).spawns.get('toolu_1')).toBe('goto');
  });
});

describe('agentWorktreeEntry', () => {
  it('labels an isolated agent worktree with its dispatch description', () => {
    expect(agentWorktreeEntry('agent-a1.meta.json', { worktreePath: 'C:\\personal\\InProgress\\.claude\\worktrees\\agent-a1', description: '#102 P8 implementer' }))
      .toEqual(['agent-a1', '#102 P8 implementer']);
    expect(agentWorktreeEntry('agent-a2.meta.json', { description: '#98 P4 implementer' })).toEqual(['agent-a2', '#98 P4 implementer']);
    expect(agentWorktreeEntry('agent-a3.meta.json', { worktreeBranch: 'worktree-agent-a3' })).toEqual(['agent-a3', 'worktree-agent-a3']);
  });
});

describe('parseWorktreeList', () => {
  it('maps each nested worktree with a branch', () => {
    const porcelain = [
      'worktree C:/personal/InProgress', 'HEAD d080341', 'branch refs/heads/main', '',
      'worktree C:/personal/InProgress/.claude/worktrees/quiet-t1', 'HEAD 9e309b7', 'branch refs/heads/quiet/t1-tokens', '',
      'worktree C:/personal/InProgress/.claude/worktrees/loose', 'HEAD 1234567', 'detached', '',
    ].join('\n');
    expect([...parseWorktreeList(porcelain)]).toEqual([['quiet-t1', 'quiet/t1-tokens']]);
  });
});

describe('isCold', () => {
  it('flags a prompt of 50k or more that is at least half cache writes', () => {
    expect(isCold(usage({ cacheRead: 20_000, cw1h: 40_000 }))).toBe(true);
    expect(isCold(usage({ cacheRead: 40_000, cw1h: 20_000 }))).toBe(false);
    expect(isCold(usage({ cw1h: 40_000 }))).toBe(false);
  });
});

describe('lines landed', () => {
  // Each record starts with a NUL, the way `--format=%x00%H%x09%P%x09%cI%x09%s` writes it.
  const log = [
    '\u0000aaa\tp1 p2\t2026-10-09T12:00:00+00:00\tMerge: Go to a step (#227)',
    '10\t2\tweb/src/chrome/GoTo.tsx',
    '500\t0\tpackage-lock.json',
    '',
    '\u0000bbb\tp0\t2026-10-08T12:00:00+00:00\tSpec: something (#228)',
    '30\t0\tdocs/superpowers/specs/x.md',
    '-\t-\tdocs/image.png',
    '',
  ].join('\n');

  it('counts added plus deleted lines per first-parent commit, without lockfiles or binaries', () => {
    expect(parseMainLog(log).map((c) => [c.sha, c.second, c.lines, c.branch])).toEqual([['aaa', 'p2', 12, null], ['bbb', null, 30, MAIN]]);
  });
  it('parses a subject that contains @@', () => {
    const tricky = [
      '\u0000ccc\tp0\t2026-10-09T12:00:00+00:00\tFix the @@ marker (#300)',
      '5\t1\tsrc/a.ts',
      '',
      '\u0000ddd\tp0\t2026-10-08T12:00:00+00:00\tNext',
      '2\t0\tsrc/b.ts',
      '',
    ].join('\n');
    expect(parseMainLog(tricky).map((c) => [c.sha, c.subject, c.lines])).toEqual([['ccc', 'Fix the @@ marker (#300)', 6], ['ddd', 'Next', 2]]);
  });
  it('names a merge by a clean name-rev result, else by a "Merge branch" subject', () => {
    const commits = parseMainLog(log);
    nameMerges(commits, ['goto']);
    expect(commits[0].branch).toBe('goto');
    const renamed = parseMainLog(log.replace('Merge: Go to a step (#227)', "Merge branch 'feat/x'"));
    nameMerges(renamed, ['quiet/t1-tokens~7^2']);
    expect(renamed[0].branch).toBe('feat/x');
  });
  it('credits a span with the commits that landed inside it', () => {
    expect(committedWithin(parseMainLog(log), { first: '2026-10-09T11:00:00.000Z', last: '2026-10-09T13:00:00.000Z' }).map((c) => c.sha)).toEqual(['aaa']);
  });
});
