import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { LEAD_INSTRUCTIONS_VERSION } from '../../src/core/lead';
import { buildApp } from '../../src/server/app';
import { openDb } from '../../src/server/db/connection';
import { createCtx, write } from '../../src/server/db/tx';
import { leadAllow } from '../../src/server/lead-commands';
import { applyVerdict } from '../../src/server/lead/apply';
import { STUCK_POLL_MS, STUCK_WAIT_MS, stuckWait, watchHeldLines, writeHeldLines } from '../../src/server/lead/hold';
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
  const hold = async (command: string, action: string, sessionId: string | null = 's1', cwd = repo.wt) => {
    const res = await app.inject({ method: 'POST', url: '/api/lead/hold', headers: { authorization: 'Bearer tok' }, payload: { sessionId, cwd, command, action } });
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
    expect(await w.hold('git push', 'push')).toEqual({ say: 'nothing' });
    expect(w.items('held')).toEqual([]);
  });

  it('a push off the risk list with Landing on is clear', async () => {
    const w = world();
    writeFile(repo.wt, 'web/app.ts', lines(9, 'feature'));
    commit(repo.wt, 'web');
    expect(await w.hold('git push origin feature', 'push')).toEqual({ say: 'nothing' });
    expect(w.items('held')).toEqual([]);
  });

  it('a push touching src/hooks/ is held: one item waiting on Aiden and a held line; the same command again makes no second item', async () => {
    const w = world();
    writeFile(repo.wt, 'src/hooks/x.ts', lines(9, 'feature'));
    commit(repo.wt, 'hooks');
    expect(await w.hold('npm test && git push', 'push')).toEqual({ held: true, text: 'a push of feature to origin' });
    expect(w.items('held')).toEqual([expect.objectContaining({ state: 'waiting_aiden', node_id: w.step.id, outcome: "held: hold: this is Aiden's (it touches src/hooks/x.ts)" })]);
    expect(w.events('held')).toEqual([{ text: "npm test && git push -> hold: this is Aiden's (it touches src/hooks/x.ts)", node_id: w.step.id, session_id: 's1' }]);
    expect(await w.hold('npm test && git push', 'push')).toEqual({ held: true, text: 'a push of feature to origin' });
    expect(w.items('held')).toHaveLength(1);
    expect(w.events('held')).toHaveLength(1);
  });

  it('a merge in a checkout on another branch is not into main; in the main checkout it names the branch, or holds when it names none', async () => {
    const w = world();
    writeFile(repo.wt, 'web/app.ts', lines(9, 'feature'));
    commit(repo.wt, 'web');
    expect(await w.hold('git merge main', 'merge')).toEqual({ say: 'nothing' });
    expect(await w.hold('git merge feature', 'merge', 's1', repo.main)).toEqual({ say: 'nothing' });
    expect(await w.hold('git merge --abort', 'merge', 's1', repo.main)).toEqual({ held: true, text: 'a merge into main' });
    expect(await w.hold('git merge nosuch', 'merge', 's1', repo.main)).toEqual({ held: true, text: 'a merge of nosuch into main' });
  });

  it("a change to a repository on Aiden's account and a delete under the live home are held without a check", async () => {
    const w = world();
    expect(await w.hold('gh repo create acme/x --public', 'repo')).toEqual({ held: true, text: "a change to a repository on Aiden's account (gh repo create acme/x --public)" });
    expect(await w.hold('rm -rf ~/.inprogress', 'delete')).toEqual({ held: true, text: 'a delete under the live home (rm -rf ~/.inprogress)' });
  });

  it("a Held line of this project's playbook holds; another project's does not", async () => {
    const w = world();
    expect(await w.hold('gh pr merge 3', 'playbook')).toEqual({ say: 'nothing' });
    updateProject(w.ctx, 'test', w.project.slug, { playbook: 'Held: gh pr merge' });
    expect(await w.hold('gh pr merge 3', 'playbook')).toEqual({ held: true, text: 'a command the playbook holds for Aiden (gh pr merge) (gh pr merge 3)' });
  });

  it('a session with no focus step is held: the check needs one', async () => {
    const w = world();
    w.ctx.db.prepare("UPDATE sessions SET focus_node_id = NULL WHERE id = 's1'").run();
    writeFile(repo.wt, 'web/app.ts', lines(9, 'feature'));
    commit(repo.wt, 'web');
    expect(await w.hold('git push', 'push')).toEqual({ held: true, text: 'a push of feature to origin' });
    expect(w.items('held')[0]!.outcome).toBe('held: could not tell which step this is for');
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

  it('no verdict in 170 s resolves to nothing, and the item stays', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
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
  it('holds the Held lines of every project with a lead, rewritten when a playbook changes', () => {
    const home = mkdtempSync(join(tmpdir(), 'ip-held-'));
    try {
      const w = world();
      const other = createProject(w.ctx, 'test', { name: 'NoLead', playbook: 'Held: npm run nope' });
      expect(other.lead).toBeNull();
      const stop = watchHeldLines(w.ctx, home, { error: () => undefined });
      const read = () => JSON.parse(readFileSync(join(home, 'lead', 'held.json'), 'utf8')) as string[];
      expect(read()).toEqual([]);
      updateProject(w.ctx, 'test', w.project.slug, { playbook: 'Risk: billing/**\nHeld: gh pr merge\nHeld: npm run seed-prod' });
      expect(read()).toEqual(['gh pr merge', 'npm run seed-prod']);
      setProjectLead(w.ctx, 'window', other.slug, 'Nora');
      expect(read()).toEqual(['gh pr merge', 'npm run seed-prod', 'npm run nope']);
      stop();
      expect(writeHeldLines(w.ctx, home)).toEqual(['gh pr merge', 'npm run seed-prod', 'npm run nope']);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});
