import { existsSync, mkdtempSync, readdirSync, readFileSync, renameSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { LEAD_INSTRUCTIONS_VERSION } from '../../src/core/lead';
import { buildApp } from '../../src/server/app';
import { openDb } from '../../src/server/db/connection';
import { createCtx, deskOnly, write } from '../../src/server/db/tx';
import { heldActions, playbookHeldLines } from '../../src/core/hold';
import { leadAllow, leadDisallow } from '../../src/server/lead-commands';
import { applyVerdict } from '../../src/server/lead/apply';
import { heldKeysOf, heldOutcome, heldWhatOf, NPM_CONFIG_WHY, STUCK_POLL_MS, STUCK_WAIT_MS, stuckWait, watchHeldLines, writeHeldLines } from '../../src/server/lead/hold';
import { PUBLISH_NO_YES } from '../../src/server/lead/landing';
import { realGit, type LandingDeps } from '../../src/server/lead/landing';
import { deskUserMessage } from '../../src/server/lead/prompt';
import { getDeskItem } from '../../src/server/repo/desk';
import { applyTurn, leaseItem, saveAnswer } from '../../src/server/repo/leadTurns';
import { addNodes } from '../../src/server/repo/nodes';
import { addBinding, createProject, setProjectLead, updateProject } from '../../src/server/repo/projects';
import { handleHookEvent } from '../../src/server/session-flow';
import { commit, lines, makeRepo, write as writeFile, type TestRepo } from '../git-repo';

const V = LEAD_INSTRUCTIONS_VERSION;
let repo: TestRepo;
beforeEach(() => {
  repo = makeRepo();
});
afterEach(() => {
  vi.useRealTimers();
  repo.cleanup();
});

/** InProgress led by Progresser, bound to the repo's worktree, session s1 focused on a step; the round on unless told. */
function world(opts: { roundOn?: boolean } = {}) {
  let t = Date.parse('2026-11-25T09:00:00.000Z');
  const ctx = createCtx(openDb(':memory:'), () => new Date((t += 1000)).toISOString());
  const project = createProject(ctx, 'test', { name: 'InProgress' });
  addBinding(ctx, 'test', project.slug, repo.wt);
  const [step] = addNodes(ctx, 'test', { parentId: project.rootNodeId, nodes: [{ title: 'Hold hook' }] });
  setProjectLead(ctx, 'window', project.slug, 'Progresser');
  const roundOn = () => leadAllow(ctx, project.slug, 'Progresser', V, { switch: 'round', aidenWords: 'run the round' });
  if (opts.roundOn !== false) roundOn();
  leadAllow(ctx, project.slug, 'Progresser', V, { switch: 'landing', aidenWords: 'land what is clear' });
  handleHookEvent(ctx, 's1', { event: 'start', source: 'startup', cwd: repo.wt });
  ctx.db.prepare("UPDATE sessions SET focus_node_id = ? WHERE id = 's1'").run(step!.id);
  const landing: LandingDeps = { git: realGit, visibility: async () => false };
  const app = buildApp({ ctx, token: 'tok', uiToken: 'u', version: 'test', landing });
  /**
   * The hook's call about one command of the line: the `nth` command the list holds (as the hook reads it, with this
   * project's Held lines), sent with its place, text and folder.
   */
  const hold = async (command: string, o: { nth?: number; sessionId?: string | null; cwd?: string; segment?: string } = {}) => {
    const cwd = o.cwd ?? repo.wt;
    const playbook = ctx.db.prepare('SELECT playbook FROM projects WHERE id = ?').pluck().get(project.id) as string;
    const match = heldActions(command, playbookHeldLines(playbook), cwd)[o.nth ?? 0];
    const payload = { sessionId: o.sessionId === undefined ? 's1' : o.sessionId, cwd, command, action: match?.action ?? 'push', index: match?.index ?? 0, segment: o.segment ?? match?.segment, folder: match?.folder ?? null };
    const res = await app.inject({ method: 'POST', url: '/api/lead/hold', headers: { authorization: 'Bearer tok' }, payload });
    expect(res.statusCode).toBe(200);
    return res.json() as Record<string, unknown>;
  };
  const items = (kind: string) => ctx.db.prepare('SELECT * FROM desk_items WHERE kind = ? ORDER BY id').all(kind) as { id: number; state: string; node_id: number | null; outcome: string | null }[];
  const events = (kind: string) => ctx.db.prepare('SELECT text, node_id, session_id FROM lead_events WHERE kind = ? ORDER BY id').all(kind) as Record<string, unknown>[];
  /** The runner's turn on an item: leased, answered, applied by applyVerdict in the lead's write. */
  const verdict = (itemId: number, v: string, kind: string, answer: string) => {
    const turn = leaseItem(ctx.db, itemId, { way: 'headless', model: 'claude-opus-5-5', leaseMs: 360_000 }, ctx.now())!;
    saveAnswer(ctx.db, turn.id, { verdict: v, kind, answer, why: 'the record says so' }, ctx.now());
    return write(ctx, 'lead:Progresser', (record) => applyTurn(ctx.db, turn.id, ctx.now(), (tu, item) => applyVerdict(ctx, tu, item, record)), { immediate: true });
  };
  return { ctx, project, step: step!, app, hold, items, events, verdict, roundOn };
}

describe('POST /api/lead/hold', () => {
  it('says nothing and makes no item when the round is off', async () => {
    const w = world({ roundOn: false });
    writeFile(repo.wt, 'src/hooks/x.ts', lines(9, 'feature'));
    commit(repo.wt, 'hooks');
    expect(await w.hold('git push')).toEqual({ say: 'nothing' });
    expect(w.items('held')).toEqual([]);
  });

  it('a push off the risk list with Landing on is clear', async () => {
    const w = world();
    writeFile(repo.wt, 'web/app.ts', lines(9, 'feature'));
    commit(repo.wt, 'web');
    expect(await w.hold('git push origin feature')).toEqual({ say: 'nothing' });
    expect(w.items('held')).toEqual([]);
  });

  it('a push touching src/hooks/ is held: one item waiting on Aiden and a held line; the same command again makes no second item', async () => {
    const w = world();
    writeFile(repo.wt, 'src/hooks/x.ts', lines(9, 'feature'));
    commit(repo.wt, 'hooks');
    const desk: unknown[] = [];
    w.ctx.bus.on('event', (e: { type: string; data: unknown }) => void (deskOnly(e) && desk.push(e)));
    expect(await w.hold('npm test && git push')).toEqual({ held: true, text: 'a push of feature to origin' });
    // Y13: the held item is made in a transaction of its own, and the window hears of it at once.
    expect(desk).toHaveLength(1);
    expect(w.items('held')).toEqual([expect.objectContaining({ state: 'waiting_aiden', node_id: w.step.id })]);
    expect(w.items('held')[0]!.outcome).toMatch(/^held: hold: this is Aiden's \(it touches src\/hooks\/x\.ts\)\nwhat: a push of feature to origin\nkeys: \{/);
    // K1: the hold keeps the folder, the branch it read and the key its check computed.
    expect(heldKeysOf(w.items('held')[0]!.outcome)).toEqual({ folder: repo.wt.replace(/\\/g, '/'), branch: 'feature', keys: { push: expect.stringMatching(/^[0-9a-f]{40}$/) } });
    expect(w.events('held')).toEqual([{ text: "npm test && git push -> hold: this is Aiden's (it touches src/hooks/x.ts)", node_id: w.step.id, session_id: 's1' }]);
    expect(await w.hold('npm test && git push')).toEqual({ held: true, text: 'a push of feature to origin' });
    expect(w.items('held')).toHaveLength(1);
    expect(w.events('held')).toHaveLength(1);
  });

  it('a merge in a checkout on another branch is not into main; in the main checkout it names the branch, or holds when it names none', async () => {
    const w = world();
    writeFile(repo.wt, 'web/app.ts', lines(9, 'feature'));
    commit(repo.wt, 'web');
    expect(await w.hold('git merge main')).toEqual({ say: 'nothing' });
    expect(await w.hold('git merge feature', { cwd: repo.main })).toEqual({ say: 'nothing' });
    expect(await w.hold('git merge --abort', { cwd: repo.main })).toEqual({ held: true, text: 'a merge into main' });
    expect(await w.hold('git merge nosuch', { cwd: repo.main })).toEqual({ held: true, text: 'a merge of nosuch into main' });
  });

  it("a change to a repository on Aiden's account and a delete under the live home are held without a check", async () => {
    const w = world();
    expect(await w.hold('gh repo create acme/x --public')).toEqual({ held: true, text: "a change to a repository on Aiden's account (gh repo create acme/x --public)" });
    expect(await w.hold('rm -rf ~/.inprogress')).toEqual({ held: true, text: 'a delete under the live home (rm -rf ~/.inprogress)' });
  });

  it("a Held line of this project's playbook holds; another project's does not", async () => {
    const w = world();
    expect(await w.hold('npm run seed-prod')).toEqual({ say: 'nothing' });
    updateProject(w.ctx, 'test', w.project.slug, { playbook: 'Held: npm run seed-prod' });
    expect(await w.hold('npm run seed-prod')).toEqual({ held: true, text: 'a command the playbook holds for Aiden (npm run seed-prod)' });
  });

  it('a session with no focus step is held: the check needs one', async () => {
    const w = world();
    w.ctx.db.prepare("UPDATE sessions SET focus_node_id = NULL WHERE id = 's1'").run();
    writeFile(repo.wt, 'web/app.ts', lines(9, 'feature'));
    commit(repo.wt, 'web');
    expect(await w.hold('git push')).toEqual({ held: true, text: 'a push of feature to origin' });
    expect(w.items('held')[0]!.outcome).toBe('held: could not tell which step this is for\nwhat: a push of feature to origin');
  });

  it("an npm, pnpm or yarn publish names the folder's package and version; with no readable name and version, or another publish, it names the branch", async () => {
    const w = world();
    // No focus step: every publish is held, so each one's what is seen.
    w.ctx.db.prepare("UPDATE sessions SET focus_node_id = NULL WHERE id = 's1'").run();
    writeFile(repo.wt, 'package.json', JSON.stringify({ name: 'x', version: '1.2.0' }));
    expect(await w.hold('npm publish')).toEqual({ held: true, text: 'a publish of x 1.2.0 to npm' });
    expect(await w.hold('pnpm publish --access public')).toEqual({ held: true, text: 'a publish of x 1.2.0 to npm' });
    expect(await w.hold('yarn publish', { sessionId: null })).toEqual({ held: true, text: 'a publish of x 1.2.0 to npm' });
    expect(await w.hold('cargo publish')).toEqual({ held: true, text: 'a publish of feature' });
    expect(heldWhatOf(w.items('held')[0]!.outcome)).toBe('a publish of x 1.2.0 to npm');
    writeFile(repo.wt, 'package.json', JSON.stringify({ name: 'x' }));
    expect(await w.hold('npm publish --tag beta')).toEqual({ held: true, text: 'a publish of feature' });
    writeFile(repo.wt, 'package.json', '{ not json');
    expect(await w.hold('npm publish --dry-run')).toEqual({ held: true, text: 'a publish of feature' });
  });

  it('a publish of a tarball, a path or a workspace is held before the landing check, so no yes can clear it', async () => {
    const w = world();
    writeFile(repo.wt, 'package.json', JSON.stringify({ name: 'x', version: '1.2.0' }));
    for (const command of ['npm publish ./x-1.2.0.tgz', 'npm publish --workspace a', 'pnpm publish -r']) {
      expect((await w.hold(command)).held, command).toBe(true);
    }
    const why = (w.events('held') as { text: string }[]).map((e) => e.text.slice(e.text.lastIndexOf(' -> ') + 4));
    expect(why).toEqual([PUBLISH_NO_YES, PUBLISH_NO_YES, PUBLISH_NO_YES]);
  });

  it("a publish with npm's settings changed by the environment is held before the landing check, so no yes can clear it", async () => {
    const w = world();
    writeFile(repo.wt, 'package.json', JSON.stringify({ name: 'x', version: '1.2.0' }));
    for (const command of ['NPM_CONFIG_REGISTRY=https://x.invalid npm publish', 'export npm_config_tag=next && npm publish']) {
      expect((await w.hold(command)).held, command).toBe(true);
    }
    const why = (w.events('held') as { text: string }[]).map((e) => e.text.slice(e.text.lastIndexOf(' -> ') + 4));
    expect(why).toEqual([NPM_CONFIG_WHY, NPM_CONFIG_WHY]);
  });

  it('heldWhatOf reads the what back from the outcome, and nothing from an item held before it was stored', () => {
    expect(heldWhatOf(heldOutcome('why\nwhat: not this', 'a deploy of main to the live build'))).toBe('a deploy of main to the live build');
    expect(heldWhatOf("held: hold: this is Aiden's")).toBeUndefined();
    expect(heldWhatOf(null)).toBeUndefined();
    expect(heldWhatOf('ANSWERED d4\nwhat: x')).toBeUndefined();
    // K1: the keys line after the what is read apart from it, and round-trips.
    const keys = { folder: 'C:/r/packages/a', branch: 'main', keys: { publish: 'k', push: null } };
    const withKeys = heldOutcome('why\nkeys: {"folder":"x"}', 'a publish of a 1.0.0 to npm', keys);
    expect(heldWhatOf(withKeys)).toBe('a publish of a 1.0.0 to npm');
    expect(heldKeysOf(withKeys)).toEqual(keys);
    expect(heldKeysOf(heldOutcome('why\nkeys: {"folder":"x","branch":null,"keys":{}}', 'a push'))).toBeUndefined();
    expect(heldKeysOf('held: x\nwhat: y\nkeys: not json')).toBeUndefined();
  });

  it('judges the merge in the folder a cd moved to, not the session\'s: from a worktree, a merge in the main checkout is held', async () => {
    const w = world();
    writeFile(repo.wt, 'src/hooks/x.ts', lines(9, 'feature'));
    commit(repo.wt, 'hooks');
    expect(await w.hold('git merge --ff-only feature')).toEqual({ say: 'nothing' });
    expect(await w.hold(`cd ${repo.main.replace(/\\/g, '/')} && git merge --ff-only feature`)).toEqual({ held: true, text: 'a merge of feature into main' });
    expect(await w.hold('cd $MAIN && git merge --ff-only feature')).toEqual({ held: true, text: 'a merge into main' });
    expect(w.items('held').map((i) => heldWhatOf(i.outcome))).toEqual(['a merge of feature into main', 'a merge into main']);
    expect(w.items('held')[1]!.outcome).toBe('held: could not tell which folder it runs in\nwhat: a merge into main');
    expect(heldKeysOf(w.items('held')[0]!.outcome)).toMatchObject({ branch: 'feature', keys: { merge: expect.stringMatching(/^[0-9a-f]{40}$/) } });
  });

  it('judges the command at the place the hook names: a second push of the line is judged on its own', async () => {
    const w = world();
    writeFile(repo.wt, 'src/hooks/x.ts', lines(9, 'feature'));
    commit(repo.wt, 'hooks');
    // main has nothing to push; feature touches the hooks.
    const line = 'git push origin main && git push origin feature';
    expect(await w.hold(line)).toEqual({ say: 'nothing' });
    expect(await w.hold(line, { nth: 1 })).toEqual({ held: true, text: 'a push of feature to origin' });
    // A command that reads differently here than the hook sent it is held.
    expect(await w.hold(line, { segment: 'git push origin elsewhere' })).toMatchObject({ held: true });
  });

  it("on main, an octopus merge is held, and updating main from origin is not a landing; gh pr merge is held without a check", async () => {
    const w = world();
    expect(await w.hold('git merge a b', { cwd: repo.main })).toEqual({ held: true, text: 'a merge into main' });
    expect(w.items('held')[0]!.outcome).toBe('held: a merge of several branches at once\nwhat: a merge into main');
    expect(await w.hold('git merge origin/main', { cwd: repo.main })).toEqual({ say: 'nothing' });
    expect(await w.hold('git merge --ff-only @{u}', { cwd: repo.main })).toEqual({ say: 'nothing' });
    expect(await w.hold('gh pr merge 12 --squash')).toEqual({ held: true, text: 'a merge of a pull request into main (gh pr merge 12 --squash)' });
  });

  it('wants the token', async () => {
    const w = world();
    const res = await w.app.inject({ method: 'POST', url: '/api/lead/hold', payload: { cwd: repo.wt, command: 'git push', action: 'push' } });
    expect(res.statusCode).toBe(401);
  });
});

describe('POST /api/lead/stuck', () => {
  const ask = { sessionId: 's1', cwd: '', toolName: 'Edit', toolInput: { file_path: 'C:/repo/web/app.ts', old_string: 'a', new_string: 'b' } };

  it('says nothing at once with the round off, and makes no item', async () => {
    const w = world({ roundOn: false });
    const res = await w.app.inject({ method: 'POST', url: '/api/lead/stuck', headers: { authorization: 'Bearer tok' }, payload: { ...ask, cwd: repo.wt } });
    expect(res.json()).toEqual({ say: 'nothing' });
    expect(w.items('stuck')).toEqual([]);
  });

  it('makes a stuck item; DECIDE ALLOW resolves the waiting request with allow, and records a permission decision', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const w = world();
    const waiting = stuckWait(w.ctx, { ...ask, cwd: repo.wt });
    const [item] = w.items('stuck');
    expect(item).toMatchObject({ state: 'open', node_id: w.step.id });
    expect(deskUserMessage(w.ctx, getDeskItem(w.ctx.db, item!.id)!)).toContain('The tool: Edit');
    await vi.advanceTimersByTimeAsync(3 * STUCK_POLL_MS);
    expect(w.verdict(item!.id, 'DECIDE', 'TECHNICAL', 'ALLOW: the edit is inside the step')).toBe(true);
    await vi.advanceTimersByTimeAsync(STUCK_POLL_MS);
    expect(await waiting).toEqual({ behavior: 'allow', message: 'the edit is inside the step' });
    expect(getDeskItem(w.ctx.db, item!.id)).toMatchObject({ state: 'done', outcome: 'ALLOW the edit is inside the step' });
    expect(w.ctx.db.prepare('SELECT kind, line, said_where FROM lead_decisions').all()).toEqual([
      { kind: 'permission', line: `Edit ${JSON.stringify(ask.toolInput)} -> allow`.replace(/^(Edit .{79}).*( -> allow)$/, '$1…$2'), said_where: 'desk' },
    ]);
  });

  it('DENY resolves with deny; an answer with neither is unclear and says nothing', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const w = world();
    const denied = stuckWait(w.ctx, { ...ask, cwd: repo.wt });
    w.verdict(w.items('stuck')[0]!.id, 'DECIDE', 'TECHNICAL', 'DENY: another project');
    await vi.advanceTimersByTimeAsync(STUCK_POLL_MS);
    expect(await denied).toEqual({ behavior: 'deny', message: 'another project' });
    const unclear = stuckWait(w.ctx, { ...ask, cwd: repo.wt });
    w.verdict(w.items('stuck')[1]!.id, 'DECIDE', 'TECHNICAL', 'go ahead');
    await vi.advanceTimersByTimeAsync(STUCK_POLL_MS);
    expect(await unclear).toEqual({ say: 'nothing' });
    expect(w.items('stuck')[1]!.outcome).toBe('unclear');
  });

  it('AIDEN resolves to nothing, the item left waiting on him', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const w = world();
    const waiting = stuckWait(w.ctx, { ...ask, cwd: repo.wt });
    w.verdict(w.items('stuck')[0]!.id, 'AIDEN', 'CANNOT-BE-TAKEN-BACK', 'He should say');
    await vi.advanceTimersByTimeAsync(STUCK_POLL_MS);
    expect(await waiting).toEqual({ say: 'nothing' });
    expect(w.items('stuck')[0]!.state).toBe('waiting_aiden');
  });

  it('stops waiting when the hook has gone, and the item stays', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const w = world();
    let gone = false;
    const waiting = stuckWait(w.ctx, { ...ask, cwd: repo.wt }, { gone: () => gone });
    await vi.advanceTimersByTimeAsync(2 * STUCK_POLL_MS);
    gone = true;
    await vi.advanceTimersByTimeAsync(STUCK_POLL_MS);
    expect(await waiting).toEqual({ say: 'nothing' });
    expect(w.items('stuck')[0]!.state).toBe('open');
  });

  it('no verdict in 170 s by the clock resolves to nothing, and the item stays', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    const w = world();
    let done = false;
    const waiting = stuckWait(w.ctx, { ...ask, cwd: repo.wt }).finally(() => (done = true));
    await vi.advanceTimersByTimeAsync(STUCK_WAIT_MS - STUCK_POLL_MS);
    expect(done).toBe(false);
    await vi.advanceTimersByTimeAsync(STUCK_POLL_MS);
    expect(await waiting).toEqual({ say: 'nothing' });
    expect(w.items('stuck')[0]!.state).toBe('open');
  });
});

describe('held.json', () => {
  it('a rename Windows refuses while the file is open is tried again, and a failed write leaves no temporary file', () => {
    const home = mkdtempSync(join(tmpdir(), 'ip-held-'));
    try {
      const w = world();
      let calls = 0;
      const busy = (from: string, to: string) => {
        calls++;
        if (calls < 3) throw Object.assign(new Error('busy'), { code: 'EBUSY' });
        renameSync(from, to);
      };
      writeHeldLines(w.ctx, home, busy);
      expect(calls).toBe(3);
      expect(existsSync(join(home, 'lead', 'held.json'))).toBe(true);
      const never = () => {
        throw Object.assign(new Error('denied'), { code: 'EPERM' });
      };
      expect(() => writeHeldLines(w.ctx, home, never)).toThrow('denied');
      expect(readdirSync(join(home, 'lead'))).toEqual(['held.json']);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it('Y11: a desk-only change does not rewrite held.json; a real project change does', () => {
    const home = mkdtempSync(join(tmpdir(), 'ip-held-'));
    try {
      const w = world();
      const stop = watchHeldLines(w.ctx, home, { error: () => undefined });
      const file = join(home, 'lead', 'held.json');
      rmSync(file);
      w.ctx.bus.emit('event', { type: 'project.updated', projectId: w.project.id, data: { changes: { desk: true } } });
      expect(existsSync(file)).toBe(false);
      w.ctx.bus.emit('event', { type: 'project.updated', projectId: w.project.id, data: { changes: { playbook: true } } });
      expect(existsSync(file)).toBe(true);
      stop();
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it('holds the Held lines of every project with a lead, rewritten when a playbook changes', () => {
    const home = mkdtempSync(join(tmpdir(), 'ip-held-'));
    try {
      const w = world();
      const other = createProject(w.ctx, 'test', { name: 'NoLead', playbook: 'Held: npm run nope' });
      expect(other.lead).toBeNull();
      const stop = watchHeldLines(w.ctx, home, { error: () => undefined });
      const read = () => JSON.parse(readFileSync(join(home, 'lead', 'held.json'), 'utf8')) as { lines: string[]; folders: string[] };
      const wt = repo.wt.replace(/\\/g, '/');
      expect(read()).toEqual({ lines: [], folders: [wt] });
      updateProject(w.ctx, 'test', w.project.slug, { playbook: 'Risk: billing/**\nHeld: gh pr merge\nHeld: npm run seed-prod' });
      expect(read().lines).toEqual(['gh pr merge', 'npm run seed-prod']);
      setProjectLead(w.ctx, 'window', other.slug, 'Nora');
      expect(read().lines).toEqual(['gh pr merge', 'npm run seed-prod', 'npm run nope']);
      // The other project's folder is watched once its round is on, and a new binding is too.
      addBinding(w.ctx, 'test', other.slug, 'C:/personal/NoLead');
      expect(read().folders).toEqual([wt]);
      leadAllow(w.ctx, other.slug, 'Nora', V, { switch: 'round', aidenWords: 'go' });
      expect(read().folders).toEqual([wt, 'C:/personal/NoLead']);
      leadDisallow(w.ctx, w.project.slug, 'Progresser', V, { switch: 'round' });
      expect(read().folders).toEqual(['C:/personal/NoLead']);
      stop();
      expect(writeHeldLines(w.ctx, home)).toEqual({ lines: ['gh pr merge', 'npm run seed-prod', 'npm run nope'], folders: ['C:/personal/NoLead'] });
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});
