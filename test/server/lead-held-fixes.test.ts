import { execFileSync } from 'node:child_process';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { LEAD_INSTRUCTIONS_VERSION } from '../../src/core/lead';
import { ONLY_YOU } from '../../src/core/landing';
import { buildApp } from '../../src/server/app';
import { write as dbWrite } from '../../src/server/db/tx';
import { CHANGED_SINCE_HELD, heldCards } from '../../src/server/lead/carry';
import { heldKeysOf, heldOutcome, heldRef } from '../../src/server/lead/hold';
import { checkLanding, publishDestination, PUBLISH_NO_YES, realGit, type LandingDeps } from '../../src/server/lead/landing';
import { createSender, type SenderT3 } from '../../src/server/lead/sends';
import { intendHeldLine } from '../../src/server/lead/voice';
import { WORK_PROJECT } from '../../src/server/lead-commands';
import { raiseAsk } from '../../src/server/repo/asks';
import { getDeskItem, moveDeskItem } from '../../src/server/repo/desk';
import { produceDeskItem } from '../../src/server/repo/deskProducers';
import { insertLeadEvent } from '../../src/server/repo/leadEvents';
import { addNodes, parkNode } from '../../src/server/repo/nodes';
import { addBinding, createProject, setProjectLead } from '../../src/server/repo/projects';
import { getProjectSnapshot } from '../../src/server/repo/snapshot';
import { handleHookEvent } from '../../src/server/session-flow';
import { commit, git, lines, makeRepo, write, type TestRepo } from '../git-repo';
import { keysAtHold } from '../held-keys';
import { makeCtx } from '../helpers';

/*
 * Lead stage 1, #743, the held-card fixes after Murr: a yes Aiden gives on a held command covers exactly what he saw, as it
 * was when he could first see it, and Go ahead is offered only where it can release the command.
 */

const V = LEAD_INSTRUCTIONS_VERSION;
const UI = { origin: 'http://localhost:80', 'x-ip-ui-token': 'ui' };

let repo: TestRepo;
const others: TestRepo[] = [];
beforeEach(() => {
  repo = makeRepo();
});
afterEach(() => {
  repo.cleanup();
  for (const o of others.splice(0)) o.cleanup();
});

/** A project led by Progresser bound to the test repo, a T3 Code session s1 in `cwd` on `branch`, focused on the step, and the app. */
function setup(opts: { calls?: string[][]; cwd?: string; branch?: string; thread?: boolean } = {}) {
  const calls = opts.calls ?? [];
  // The ctx clock runs a minute ahead of the real one: a hold made now is after the commits git stamps.
  const ctx = makeCtx(new Date(Date.now() + 60_000).toISOString());
  const project = createProject(ctx, 'test', { name: 'InGame' });
  addBinding(ctx, 'test', project.slug, repo.main);
  setProjectLead(ctx, 'window', project.slug, 'Progresser');
  const [step] = addNodes(ctx, 'test', { parentId: project.rootNodeId, nodes: [{ title: 'Tabs' }] });
  handleHookEvent(ctx, 's1', { event: 'start', source: 'startup', cwd: repo.main });
  ctx.db
    .prepare("UPDATE sessions SET cwd = ?, branch = ?, app = 't3', t3_thread_id = ?, focus_node_id = ? WHERE id = 's1'")
    .run(opts.cwd ?? repo.wt, opts.branch ?? 'feature', opts.thread === false ? null : 'th_1', step.id);
  const deps: LandingDeps = {
    git: (folder, args, input) => {
      calls.push(args);
      return realGit(folder, args, input);
    },
    visibility: async () => false,
  };
  const fakeT3: SenderT3 = { list: async () => [], show: async () => ({ thread: {} as never, messages: [] }), start: async () => ({ threadId: 'x' }), send: async () => undefined };
  const sender = createSender(ctx, { t3: fakeT3 }, { log: { info: () => undefined, error: () => undefined } });
  const app = buildApp({ ctx, token: 't', uiToken: 'ui', version: 'test', landing: deps, sender });
  const click = (itemId: number, answer: string) => app.inject({ method: 'POST', url: `/api/ui/held/${itemId}`, headers: UI, payload: { answer } });
  const check = (action: 'merge' | 'push' | 'publish' | 'deploy', folder = repo.wt, branch: string | undefined = 'feature', segment?: string) =>
    checkLanding(ctx, { ref: project.slug, stepId: step.id, action, folder, ...(branch === undefined ? {} : { branch }), ...(segment === undefined ? {} : { segment }) }, deps, { record: false });
  const yesCount = () => ctx.db.prepare("SELECT COUNT(*) FROM lead_events WHERE kind = 'yes'").pluck().get() as number;
  const answers = () => ctx.db.prepare("SELECT COUNT(*) FROM lead_events WHERE kind = 'answer'").pluck().get() as number;
  const answer = (payload: Record<string, unknown>) =>
    app.inject({ method: 'POST', url: `/api/lead/${project.slug}/answer`, headers: { authorization: 'Bearer t' }, payload: { as: 'Progresser', instructions: V, ...payload } });
  write(repo.wt, 'web/app.ts', lines(20, 'tabs'));
  commit(repo.wt, 'tabs');
  return { ctx, project, step, app, click, check, yesCount, answers, answer, calls, cwd: opts.cwd ?? repo.wt };
}

type T = ReturnType<typeof setup>;

/**
 * A held item for `command` by session s1, waiting on Aiden as holdCheck leaves it (with the keys its check computes now,
 * when it is on a step, unless `keyed` is false), with its line to the Voice.
 */
async function held(t: T, command: string, why = 'by the check', nodeId: number | null = t.step.id, projectId = t.project.id, keyed = true) {
  const keys = nodeId === null || !keyed ? undefined : await keysAtHold(t.ctx, t.project.slug, nodeId, command, t.cwd);
  return dbWrite(t.ctx, 'test', () => {
    const now = t.ctx.now();
    const { item } = produceDeskItem(t.ctx.db, { projectId, kind: 'held', ref: heldRef('s1', command), nodeId }, now);
    moveDeskItem(t.ctx.db, item.id, ['open'], 'waiting_aiden', { outcome: heldOutcome(why, 'a held command', keys), now });
    insertLeadEvent(t.ctx.db, { projectId, lead: 'Progresser', instructions: V, kind: 'held', ...(nodeId === null ? {} : { nodeId }), sessionId: 's1', text: `${command} -> ${why}` }, now);
    intendHeldLine(t.ctx.db, { projectId, itemId: item.id, projectName: 'InGame', stepId: nodeId, what: 'a held command' }, now);
    const send = t.ctx.db.prepare("SELECT id FROM lead_sends WHERE kind = 'voice_line' AND item_id = ?").pluck().get(item.id) as number;
    return { item, send };
  });
}

/** A package.json for `name` at `version` in `dir` (or its folder `sub`), committed. */
function pkg(dir: string, name: string, version: string, sub = ''): void {
  write(dir, `${sub}${sub === '' ? '' : '/'}package.json`, JSON.stringify({ name, version }));
  commit(dir, `package ${name}`);
}

/** A commit in `dir` whose committer time is `at`, as a commit made then would have. */
function commitAt(dir: string, message: string, at: Date): void {
  git(dir, 'add', '-A');
  execFileSync('git', ['-C', dir, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '-m', message], { env: { ...process.env, GIT_COMMITTER_DATE: at.toISOString(), GIT_AUTHOR_DATE: at.toISOString() } });
}

const fwd = (p: string) => p.replace(/\\/g, '/');
const state = (t: T, id: number) => getDeskItem(t.ctx.db, id)!.state;

describe('M1: a publish yes is keyed on what goes out', () => {
  it('two packages in one repository: a yes for a does not clear b', async () => {
    const t = setup();
    pkg(repo.wt, 'a', '1.0.0', 'packages/a');
    pkg(repo.wt, 'b', '1.0.0', 'packages/b');
    const h = await held(t, 'cd packages/a && npm publish');
    expect(getProjectSnapshot(t.ctx, t.project.id).held?.[0]?.goAhead).toBe(true);
    const res = await t.click(h.item.id, 'go');
    expect(res.statusCode, res.body).toBe(200);
    const tree = (await realGit(repo.wt, ['rev-parse', 'HEAD^{tree}'])).stdout.trim();
    expect(t.ctx.db.prepare("SELECT text FROM lead_events WHERE kind = 'yes'").pluck().all()).toEqual([`publish ${tree}:packages/a/:a@1.0.0`]);
    expect(await t.check('publish', `${repo.wt}/packages/a`)).toMatchObject({ clear: true, why: 'his yes' });
    expect((await t.check('publish', `${repo.wt}/packages/b`)).clear).toBe(false);
    // The repository's own folder is not package a either.
    expect((await t.check('publish')).clear).toBe(false);
  });

  it('a tarball or workspace publish takes no yes: Not yet alone on its card, and Go ahead is refused', async () => {
    const t = setup();
    pkg(repo.wt, 'x', '1.2.0');
    for (const command of ['npm publish ./x-1.2.0.tgz', 'npm publish --workspace a']) {
      const h = await held(t, command);
      const card = heldCards(t.ctx, t.project.id).cards.find((c) => c.id === h.item.id)!;
      expect(card.goAhead).toBe(false);
      const res = await t.click(h.item.id, 'go');
      expect(res.statusCode).toBe(409);
      expect(res.json().error).toBe(ONLY_YOU);
      expect(state(t, h.item.id)).toBe('waiting_aiden');
      // By the Voice, his yes is not recorded either, and the answer says why.
      const voice = await t.answer({ sendId: h.send, aidenWords: 'go ahead', saidAt: new Date(Date.now() + 1000).toISOString(), yes: ['publish'] });
      expect(voice.json().text).toContain(`No yes recorded for publish: ${PUBLISH_NO_YES}.`);
    }
    expect(t.yesCount()).toBe(0);
  });

  it('a folder with changes not committed takes no yes: its card offers Not yet alone, and a click changes nothing', async () => {
    const calls: string[][] = [];
    const t = setup({ calls });
    pkg(repo.wt, 'x', '1.2.0');
    write(repo.wt, 'notes.txt', 'not committed\n');
    const h = await held(t, 'npm publish');
    const res = await t.click(h.item.id, 'go');
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toBe(ONLY_YOU);
    expect({ state: state(t, h.item.id), yes: t.yesCount(), answers: t.answers() }).toEqual({ state: 'waiting_aiden', yes: 0, answers: 0 });
    expect(t.ctx.db.prepare("SELECT COUNT(*) FROM lead_sends WHERE kind = 'carry'").pluck().get()).toBe(0);
  });

  it('a yes on a folder of another repository does not clear this one', async () => {
    const t = setup();
    pkg(repo.wt, 'x', '1.2.0');
    const other = makeRepo();
    others.push(other);
    pkg(other.wt, 'x', '1.2.0');
    const h = await held(t, `cd ${fwd(other.wt)} && npm publish`);
    expect((await t.click(h.item.id, 'go')).statusCode).toBe(200);
    expect(await t.check('publish', other.wt)).toMatchObject({ clear: true, why: 'his yes' });
    expect((await t.check('publish')).clear).toBe(false);
  });

  it('a yes already given does not cover the folder once it has changes not committed', async () => {
    const t = setup();
    pkg(repo.wt, 'x', '1.2.0');
    const h = await held(t, 'npm publish');
    expect((await t.click(h.item.id, 'go')).statusCode).toBe(200);
    expect((await t.check('publish')).clear).toBe(true);
    write(repo.wt, 'package.json', JSON.stringify({ name: 'x', version: '9.9.9' }));
    expect((await t.check('publish')).clear).toBe(false);
  });

  it('--yes publish on a review is refused before any git', async () => {
    const calls: string[][] = [];
    const t = setup({ calls });
    const review = raiseAsk(t.ctx, 'session:s1', { nodeId: t.step.id, kind: 'review', text: 'Ship?', sessionId: 's1' });
    const res = await t.answer({ askId: review.id, aidenWords: 'publish it', saidAt: new Date(Date.now() + 1000).toISOString(), yes: ['publish'] });
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toContain(PUBLISH_NO_YES);
    expect(calls).toEqual([]);
    expect(t.answers()).toBe(0);
  });
});

describe('M2: a window click covers what was held', () => {
  it('a commit between the hold and the click gets no yes, and nothing is answered', async () => {
    const t = setup();
    const h = await held(t, 'git push');
    write(repo.wt, 'web/later.ts', lines(3, 'later'));
    commit(repo.wt, 'later');
    const res = await t.click(h.item.id, 'go');
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toContain(`push: ${CHANGED_SINCE_HELD}`);
    expect({ state: state(t, h.item.id), yes: t.yesCount(), answers: t.answers() }).toEqual({ state: 'waiting_aiden', yes: 0, answers: 0 });
    // Not yet still answers it.
    expect((await t.click(h.item.id, 'not-yet')).statusCode).toBe(200);
  });
});

describe('M3: push and deploy yeses are keyed as the landing check keys them', () => {
  it('a branch pushed before, with a new commit, is released by one Go ahead', async () => {
    const t = setup();
    git(repo.wt, 'update-ref', 'refs/remotes/origin/feature', git(repo.wt, 'rev-parse', 'HEAD'));
    write(repo.wt, 'web/next.ts', lines(4, 'next'));
    commit(repo.wt, 'next');
    const h = await held(t, 'git push');
    expect((await t.check('push')).clear).toBe(false);
    const res = await t.click(h.item.id, 'go');
    expect(res.statusCode, res.body).toBe(200);
    expect(await t.check('push')).toMatchObject({ clear: true, why: 'his yes' });
  });

  it('a push with nothing to send needs no yes', async () => {
    const t = setup();
    git(repo.wt, 'update-ref', 'refs/remotes/origin/feature', git(repo.wt, 'rev-parse', 'HEAD'));
    const h = await held(t, 'git push');
    const res = await t.click(h.item.id, 'go');
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json().text).toContain('No yes needed for push: nothing to push.');
    expect(t.yesCount()).toBe(0);
  });

  it('a deploy from the main checkout is released by one Go ahead', async () => {
    const t = setup({ cwd: repo.main, branch: 'main' });
    write(repo.main, 'web/deployed.ts', lines(4, 'deployed'));
    commit(repo.main, 'to deploy');
    const h = await held(t, 'npm run deploy');
    expect((await t.check('deploy', repo.main, undefined)).clear).toBe(false);
    const res = await t.click(h.item.id, 'go');
    expect(res.statusCode, res.body).toBe(200);
    expect(await t.check('deploy', repo.main, undefined)).toMatchObject({ clear: true, why: 'his yes' });
  });
});

describe('owner-calls: Go ahead only where a yes can release the command', () => {
  it('a playbook-held command shows only Not yet; Go ahead is refused before any git, and Not yet answers it', async () => {
    const calls: string[][] = [];
    const t = setup({ calls });
    t.ctx.db.prepare('UPDATE projects SET playbook = ? WHERE id = ?').run('Held: make release', t.project.id);
    const h = await held(t, 'make release', "this is Aiden's without a check");
    expect(heldCards(t.ctx, t.project.id).cards[0]).toMatchObject({ id: h.item.id, goAhead: false });
    const before = calls.length;
    const res = await t.click(h.item.id, 'go');
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toBe(ONLY_YOU);
    expect(calls.length).toBe(before);
    expect({ state: state(t, h.item.id), answers: t.answers() }).toEqual({ state: 'waiting_aiden', answers: 0 });
    expect((await t.click(h.item.id, 'not-yet')).statusCode).toBe(200);
  });

  it('a push held as public, a command on no step, and a pull request merge show only Not yet', async () => {
    const t = setup();
    await held(t, 'git push origin feature', "hold: this is Aiden's (a push-public goes out in his name)");
    await held(t, 'git push', 'by the check', null);
    await held(t, 'gh pr merge 12 --squash');
    expect(heldCards(t.ctx, t.project.id).cards.map((c) => c.goAhead)).toEqual([false, false, false]);
  });

  it("the window's answer is recorded as the window", async () => {
    const t = setup({ thread: false });
    const h = await held(t, 'git push');
    const mark = t.ctx.db.prepare('SELECT COALESCE(MAX(id), 0) FROM events').pluck().get() as number;
    expect((await t.click(h.item.id, 'not-yet')).statusCode).toBe(200);
    expect(t.ctx.db.prepare('SELECT DISTINCT actor FROM events WHERE id > ?').pluck().all(mark)).toEqual(['window']);
    expect(t.ctx.db.prepare('SELECT said_where FROM lead_decisions').pluck().get()).toBe('window');
  });

  it('a C:\\work project is refused before any git', async () => {
    const calls: string[][] = [];
    const t = setup({ calls });
    const work = createProject(t.ctx, 'test', { name: 'Client' });
    addBinding(t.ctx, 'test', work.slug, 'C:/work/client');
    setProjectLead(t.ctx, 'window', work.slug, 'Progresser');
    const h = await held(t, 'git push', 'by the check', null, work.id);
    const before = calls.length;
    const res = await t.click(h.item.id, 'go');
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toBe(WORK_PROJECT);
    expect(calls.length).toBe(before);
  });
});

describe('minors: the held cards the snapshot carries', () => {
  it('clips the command, counts every one waiting past the cap, and leaves out a parked step and a C:\\work project', async () => {
    const t = setup();
    const long = `git push ${'x'.repeat(3000)}`;
    await held(t, long, 'by the check', t.step.id, t.project.id, false);
    expect(heldCards(t.ctx, t.project.id).cards[0]!.command).toHaveLength(2000);
    // Cards alone are counted here: no keys are read for them.
    for (let i = 0; i < 100; i++) await held(t, `git push origin b${i}`, 'by the check', t.step.id, t.project.id, false);
    const snap = getProjectSnapshot(t.ctx, t.project.id);
    expect([snap.held?.length, snap.heldTotal]).toEqual([100, 101]);
    parkNode(t.ctx, 'window', t.step.id, { reason: 'later' }, () => undefined);
    expect(heldCards(t.ctx, t.project.id)).toEqual({ cards: [], total: 0 });

    const work = createProject(t.ctx, 'test', { name: 'Client' });
    addBinding(t.ctx, 'test', work.slug, 'C:/work/client');
    await held(t, 'git push origin w', 'by the check', null, work.id);
    expect(heldCards(t.ctx, work.id)).toEqual({ cards: [], total: 0 });
  });
});

/*
 * The second fixes after Murr's re-check: a held command remembers what it would do (K1), a yes is recorded only for exactly
 * that (K2), and a publish's key names where it goes (K3).
 */

describe('K1, K2: a yes covers the folder the hold read, not where the session is now', () => {
  it("a monorepo session's publish held in packages/a: the session moving to packages/b does not move the yes", async () => {
    const t = setup({ cwd: `${repo.wt}/packages/a` });
    pkg(repo.wt, 'a', '1.0.0', 'packages/a');
    pkg(repo.wt, 'b', '1.0.0', 'packages/b');
    const h = await held(t, 'npm publish');
    t.ctx.db.prepare("UPDATE sessions SET cwd = ? WHERE id = 's1'").run(`${repo.wt}/packages/b`);
    const res = await t.click(h.item.id, 'go');
    expect(res.statusCode, res.body).toBe(200);
    const tree = (await realGit(repo.wt, ['rev-parse', 'HEAD^{tree}'])).stdout.trim();
    expect(t.ctx.db.prepare("SELECT text FROM lead_events WHERE kind = 'yes'").pluck().all()).toEqual([`publish ${tree}:packages/a/:a@1.0.0`]);
    expect(await t.check('publish', `${repo.wt}/packages/a`, 'feature', 'npm publish')).toMatchObject({ clear: true, why: 'his yes' });
    // A later publish in b is held.
    expect((await t.check('publish', `${repo.wt}/packages/b`, 'feature', 'npm publish')).clear).toBe(false);
  });

  it('two folders with the same name and version: a yes for one does not clear the other', async () => {
    const t = setup({ cwd: `${repo.wt}/packages/a` });
    pkg(repo.wt, 'x', '1.0.0', 'packages/a');
    pkg(repo.wt, 'x', '1.0.0', 'packages/c');
    const h = await held(t, 'npm publish');
    expect((await t.click(h.item.id, 'go')).statusCode).toBe(200);
    expect((await t.check('publish', `${repo.wt}/packages/a`, 'feature', 'npm publish')).clear).toBe(true);
    expect((await t.check('publish', `${repo.wt}/packages/c`, 'feature', 'npm publish')).clear).toBe(false);
  });
});

describe('K2: a yes only for exactly what was held', () => {
  it('a deploy held, then main fast-forwarded to commits dated before the hold: Go ahead is refused, and by the Voice no yes', async () => {
    const t = setup({ cwd: repo.main, branch: 'main' });
    write(repo.main, 'web/deployed.ts', lines(4, 'deployed'));
    commit(repo.main, 'to deploy');
    const h = await held(t, 'npm run deploy');
    // A commit dated an hour back: no commit date says it came after the hold.
    write(repo.main, 'web/sneaked.ts', lines(4, 'sneaked'));
    commitAt(repo.main, 'sneaked in', new Date(Date.now() - 3_600_000));
    const res = await t.click(h.item.id, 'go');
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toContain(`deploy: ${CHANGED_SINCE_HELD}`);
    expect({ state: state(t, h.item.id), yes: t.yesCount(), answers: t.answers() }).toEqual({ state: 'waiting_aiden', yes: 0, answers: 0 });
    const voice = await t.answer({ sendId: h.send, aidenWords: 'go ahead', saidAt: new Date(Date.now() + 1000).toISOString(), yes: ['deploy'] });
    expect(voice.statusCode).toBe(200);
    expect(voice.json().text).toContain(`No yes recorded for deploy: ${CHANGED_SINCE_HELD}.`);
    expect(t.yesCount()).toBe(0);
  });

  it('a push held on one branch, the folder switched to another: Go ahead is refused', async () => {
    const t = setup();
    const h = await held(t, 'git push');
    git(repo.wt, 'checkout', '-q', '-b', 'other');
    const res = await t.click(h.item.id, 'go');
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toContain(`push: ${CHANGED_SINCE_HELD}`);
    expect({ state: state(t, h.item.id), yes: t.yesCount(), answers: t.answers() }).toEqual({ state: 'waiting_aiden', yes: 0, answers: 0 });
  });

  it('an item the hold stored no keys for offers no Go ahead', async () => {
    const t = setup();
    const h = await held(t, 'git push', 'by the check', t.step.id, t.project.id, false);
    expect(heldCards(t.ctx, t.project.id).cards.find((c) => c.id === h.item.id)!.goAhead).toBe(false);
    expect((await t.click(h.item.id, 'go')).statusCode).toBe(409);
    expect(t.yesCount()).toBe(0);
  });
});

describe('K3: a publish key names where it goes', () => {
  it('reads --dry-run, --registry, --tag, --access and --publish-branch either way they are written, sorted, without --otp', () => {
    expect(publishDestination('npm publish')).toEqual([]);
    expect(publishDestination('NPM publish --TAG=beta --otp 123456 --Access public --dry-run')).toEqual(['--access=public', '--dry-run', '--tag=beta']);
    expect(publishDestination('pnpm publish --publish-branch "release" --registry=https://r.example/')).toEqual(['--publish-branch=release', '--registry=https://r.example/']);
    expect(publishDestination(undefined)).toEqual([]);
  });

  it('a yes on --dry-run does not clear --access public', async () => {
    const t = setup();
    pkg(repo.wt, 'x', '1.2.0');
    const h = await held(t, 'npm publish --dry-run');
    expect((await t.click(h.item.id, 'go')).statusCode).toBe(200);
    expect((await t.check('publish', repo.wt, 'feature', 'npm publish --dry-run')).clear).toBe(true);
    expect((await t.check('publish', repo.wt, 'feature', 'npm publish --access public')).clear).toBe(false);
    expect((await t.check('publish', repo.wt, 'feature', 'npm publish')).clear).toBe(false);
  });

  it('a yes for one registry does not clear a plain publish', async () => {
    const t = setup();
    pkg(repo.wt, 'x', '1.2.0');
    const h = await held(t, 'npm publish --registry https://r.example/');
    expect((await t.click(h.item.id, 'go')).statusCode).toBe(200);
    expect((await t.check('publish', repo.wt, 'feature', 'npm publish --registry=https://r.example/')).clear).toBe(true);
    expect((await t.check('publish', repo.wt, 'feature', 'npm publish')).clear).toBe(false);
  });

  it('a yes for --tag beta clears --tag=beta', async () => {
    const t = setup();
    pkg(repo.wt, 'x', '1.2.0');
    const h = await held(t, 'npm publish --tag beta');
    expect((await t.click(h.item.id, 'go')).statusCode).toBe(200);
    expect(await t.check('publish', repo.wt, 'feature', 'npm publish --tag=beta')).toMatchObject({ clear: true, why: 'his yes' });
  });
});

describe('the newest held line for a ref decides Go ahead', () => {
  it('a command held as a public push, answered, then held again by the check: its card offers Go ahead', async () => {
    const t = setup();
    const first = await held(t, 'git push', "hold: this is Aiden's (a push-public goes out in his name)");
    expect(heldCards(t.ctx, t.project.id).cards[0]!.goAhead).toBe(false);
    expect((await t.click(first.item.id, 'not-yet')).statusCode).toBe(200);
    const again = await held(t, 'git push');
    expect(again.item.id).not.toBe(first.item.id);
    expect(heldCards(t.ctx, t.project.id).cards).toEqual([expect.objectContaining({ id: again.item.id, goAhead: true })]);
  });
});

describe('the last look: Go ahead only where one yes can release the command', () => {
  const goAhead = (t: T, id: number) => heldCards(t.ctx, t.project.id).cards.find((c) => c.id === id)?.goAhead;

  it('a hold that kept a null key offers Not yet alone', async () => {
    const t = setup();
    pkg(repo.wt, 'x', '1.2.0');
    const h = await held(t, 'npm publish');
    const stored = heldKeysOf(getDeskItem(t.ctx.db, h.item.id)!.outcome)!;
    expect(goAhead(t, h.item.id)).toBe(true);
    t.ctx.db.prepare('UPDATE desk_items SET outcome = ? WHERE id = ?').run(heldOutcome('by the check', 'a held command', { ...stored, keys: { publish: null } }), h.item.id);
    expect(goAhead(t, h.item.id)).toBe(false);
  });

  it('a command with the same action twice offers Not yet alone', async () => {
    const t = setup();
    const h = await held(t, 'git push origin feature && git push origin release');
    expect(goAhead(t, h.item.id)).toBe(false);
  });

  it("a command that sets npm's settings by the environment offers Not yet alone", async () => {
    const t = setup();
    pkg(repo.wt, 'x', '1.2.0');
    for (const command of ['export npm_config_registry=https://x.invalid && npm publish', 'NPM_CONFIG_TAG=next npm publish']) {
      const h = await held(t, command);
      expect(goAhead(t, h.item.id), command).toBe(false);
    }
  });
});
