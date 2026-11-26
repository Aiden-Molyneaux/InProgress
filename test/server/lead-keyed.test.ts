import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { heldActions } from '../../src/core/hold';
import { LEAD_INSTRUCTIONS_VERSION } from '../../src/core/lead';
import { buildApp } from '../../src/server/app';
import { leadAllow, leadDisallow } from '../../src/server/lead-commands';
import { heldCards } from '../../src/server/lead/carry';
import { GIT_CHANGED_WHY, heldKeysOf, heldOutcome, heldWhatOf, PUBLISH_MORE_WHY } from '../../src/server/lead/hold';
import { checkLanding, DEPLOY_WHERE_WHY, deployScript, FORCE_WHY, forcePush, realGit, recordYes, ROLLBACK_WHY, TAG_TOO_WHY, type LandingDeps } from '../../src/server/lead/landing';
import { addNodes } from '../../src/server/repo/nodes';
import { addBinding, createProject, setProjectLead } from '../../src/server/repo/projects';
import { handleHookEvent } from '../../src/server/session-flow';
import { commit, git, lines, makeRepo, write, type TestRepo } from '../git-repo';
import { keysAtHold } from '../held-keys';
import { makeCtx } from '../helpers';

/*
 * Lead stage 1, #743, the guard fixes after Murr's one more look (Part A): a command is keyed (a yes can match it, or
 * Landing can clear it) only when InProgress can read exactly what it does; anything else is held with no key.
 */

const V = LEAD_INSTRUCTIONS_VERSION;
const UI = { origin: 'http://localhost:80', 'x-ip-ui-token': 'ui' };

let repo: TestRepo;
beforeEach(() => {
  repo = makeRepo();
});
afterEach(() => repo.cleanup());

/** InProgress led by Progresser with the round and Landing on, session s1 in the feature worktree on the step, and the app. */
function world() {
  // A minute ahead of the real clock: a hold made now is after the commits git stamps.
  const ctx = makeCtx(new Date(Date.now() + 60_000).toISOString());
  const project = createProject(ctx, 'test', { name: 'InProgress' });
  addBinding(ctx, 'test', project.slug, repo.main);
  setProjectLead(ctx, 'window', project.slug, 'Progresser');
  const [step] = addNodes(ctx, 'test', { parentId: project.rootNodeId, nodes: [{ title: 'Guard' }] });
  leadAllow(ctx, project.slug, 'Progresser', V, { switch: 'round', aidenWords: 'run the round' });
  leadAllow(ctx, project.slug, 'Progresser', V, { switch: 'landing', aidenWords: 'land what is clear' });
  handleHookEvent(ctx, 's1', { event: 'start', source: 'startup', cwd: repo.main });
  // The session is the project's, so a command it runs in either checkout is judged for this project.
  ctx.db.prepare("UPDATE sessions SET project_id = ?, cwd = ?, branch = 'feature', focus_node_id = ? WHERE id = 's1'").run(project.id, repo.wt, step!.id);
  const deps: LandingDeps = { git: realGit, visibility: async () => false };
  const app = buildApp({ ctx, token: 'tok', uiToken: 'ui', version: 'test', landing: deps });
  /** The hook's call about the first held command of the line, run in `cwd`. */
  const hold = async (command: string, cwd = repo.wt) => {
    const match = heldActions(command, [], cwd)[0]!;
    expect(match, command).toBeDefined();
    const payload = { sessionId: 's1', cwd, command, action: match.action, index: match.index, segment: match.segment, folder: match.folder };
    const res = await app.inject({ method: 'POST', url: '/api/lead/hold', headers: { authorization: 'Bearer tok' }, payload });
    expect(res.statusCode, res.body).toBe(200);
    return res.json() as Record<string, unknown>;
  };
  /** The newest held item, its why (from its held line), its stored keys, and whether its card offers Go ahead. */
  const last = () => {
    const row = ctx.db.prepare("SELECT id, outcome FROM desk_items WHERE kind = 'held' ORDER BY id DESC LIMIT 1").get() as { id: number; outcome: string };
    const line = ctx.db.prepare("SELECT text FROM lead_events WHERE kind = 'held' ORDER BY id DESC LIMIT 1").pluck().get() as string;
    const card = heldCards(ctx, project.id).cards.find((c) => c.id === row.id);
    return { id: row.id, why: line.slice(line.lastIndexOf(' -> ') + 4), keys: heldKeysOf(row.outcome), what: heldWhatOf(row.outcome), goAhead: card?.goAhead };
  };
  const check = (action: 'merge' | 'push' | 'deploy', folder: string, segment?: string, branch?: string) =>
    checkLanding(ctx, { ref: project.slug, stepId: step!.id, action, folder, ...(branch === undefined ? {} : { branch }), ...(segment === undefined ? {} : { segment }) }, deps, { record: false });
  const click = (id: number) => app.inject({ method: 'POST', url: `/api/ui/held/${id}`, headers: UI, payload: { answer: 'go' } });
  return { ctx, project, step: step!, app, hold, last, check, click, deps };
}

/** A web change on feature, off the risk list: with Landing on, a plain push of it is clear. */
function webChange(): void {
  write(repo.wt, 'web/app.ts', lines(9, 'feature'));
  commit(repo.wt, 'web');
}

describe('A1: a publish is keyed only when the rest of its command is folder changes', () => {
  it('a publish after another command is held with no key and no Go ahead; after cd or pushd it keeps its key', async () => {
    const w = world();
    write(repo.wt, 'package.json', JSON.stringify({ name: 'x', version: '1.2.0' }));
    commit(repo.wt, 'package');
    for (const command of ['npm test && npm publish', 'npm publish; echo done', 'npm version patch && npm publish']) {
      expect((await w.hold(command)).held, command).toBe(true);
      expect(w.last(), command).toMatchObject({ why: PUBLISH_MORE_WHY, keys: undefined, goAhead: false });
    }
    for (const command of ['cd . && npm publish', 'pushd . && npm publish']) {
      expect((await w.hold(command)).held, command).toBe(true);
      expect(w.last().keys?.keys.publish, command).toMatch(/:x@1\.2\.0$/);
      expect(w.last().goAhead, command).toBe(true);
    }
  });

  it("the card's npm_config_ test applies only when a publish is among the commands", async () => {
    const w = world();
    write(repo.wt, 'src/hooks/x.ts', lines(9, 'feature'));
    commit(repo.wt, 'hooks');
    expect((await w.hold('export npm_config_color=false && git push')).held).toBe(true);
    expect(w.last()).toMatchObject({ goAhead: true, keys: { keys: { push: expect.stringMatching(/^[0-9a-f]{40}$/) } } });
  });
});

describe("A2: a push or merge with git's options or environment changed is held with no key", () => {
  it('holds each spelling even with Landing on and nothing risky; the options InProgress reads stay clear', async () => {
    const w = world();
    webChange();
    for (const command of [
      'GIT_DIR=.git git push',
      'git -c remote.origin.pushurl=x push origin feature',
      'git --git-dir=.git push',
      'git --work-tree=. push',
      'env git push',
      'export GIT_SSH_COMMAND=x && git push',
      "$env:GIT_DIR='.git'; git push",
      'set GIT_DIR=.git && git push',
      'git_dir=.git git push',
    ]) {
      expect((await w.hold(command)).held, command).toBe(true);
      expect(w.last(), command).toMatchObject({ why: GIT_CHANGED_WHY, keys: undefined, goAhead: false });
    }
    for (const command of ['git push', 'git --no-pager push', 'git -P push origin feature', `git -C ${repo.wt.replace(/\\/g, '/')} push`]) {
      expect(await w.hold(command), command).toEqual({ say: 'nothing' });
    }
  });

  it('a merge into main with git config changed is held with no key, though the same merge alone is clear', async () => {
    const w = world();
    webChange();
    expect(await w.hold('git merge feature', repo.main)).toEqual({ say: 'nothing' });
    expect((await w.hold('git -c merge.ff=false merge feature', repo.main)).held).toBe(true);
    expect(w.last()).toMatchObject({ why: GIT_CHANGED_WHY, keys: undefined, goAhead: false });
  });
});

describe('A3: a force push is held and keyed apart', () => {
  it('reads each spelling of a force', () => {
    for (const s of ['git push -f', 'git push --force', 'git push --force-with-lease', 'git push --force-with-lease=feature:abc origin feature', 'git push --force-if-includes', 'git push origin +feature', 'git push -uf origin feature', 'git -C x push --forc']) {
      expect(forcePush(s), s).toBe(true);
    }
    for (const s of ['git push', 'git push origin feature', 'git push -u origin feature', 'git push -o f origin feature', 'git push --tags']) {
      expect(forcePush(s), s).toBe(false);
    }
  });

  it('held with Landing on and nothing risky, keyed force:, and a yes on a plain push never clears it', async () => {
    const w = world();
    webChange();
    expect(await w.hold('git push origin feature')).toEqual({ say: 'nothing' });
    expect((await w.hold('git push -f origin feature')).held).toBe(true);
    const held = w.last();
    expect(held.why).toContain(FORCE_WHY);
    expect(held.keys?.keys.push).toMatch(/^force:[0-9a-f]{40}$/);
    expect(held.goAhead).toBe(true);
    // A yes on the plain push of the same change does not clear the force push.
    leadDisallow(w.ctx, w.project.slug, 'Progresser', V, { switch: 'landing' });
    const plain = (await w.check('push', repo.wt, 'git push origin feature', 'feature')).patchId!;
    recordYes(w.ctx, w.project.id, { action: 'push', patchId: plain, stepId: w.step.id, aidenWords: 'push it' });
    expect(await w.check('push', repo.wt, 'git push origin feature', 'feature')).toMatchObject({ clear: true, why: 'his yes' });
    // Held: its key is the force push's own, which no yes covers yet.
    expect(await w.check('push', repo.wt, 'git push -f origin feature', 'feature')).toMatchObject({ clear: false, patchId: `force:${plain}` });
    // His Go ahead on the force push releases it.
    expect((await w.click(held.id)).statusCode).toBe(200);
    expect(await w.check('push', repo.wt, 'git push -f origin feature', 'feature')).toMatchObject({ clear: true, why: 'his yes' });
  });

  it('a force push with no new commits is never nothing to push', async () => {
    const w = world();
    git(repo.wt, 'update-ref', 'refs/remotes/origin/feature', git(repo.wt, 'rev-parse', 'HEAD'));
    expect((await w.check('push', repo.wt, 'git push --force', 'feature')).clear).toBe(false);
    expect((await w.check('push', repo.wt, 'git push', 'feature')).clear).toBe(true);
  });
});

describe('A4: a merge of a name that is also a tag at another commit takes no key', () => {
  it('held with Landing on, no key and no Go ahead; a tag at the same commit changes nothing', async () => {
    const w = world();
    webChange();
    git(repo.main, 'tag', 'feature', repo.base);
    expect((await w.hold('git merge feature', repo.main)).held).toBe(true);
    expect(w.last()).toMatchObject({ why: `hold: this is Aiden's (${TAG_TOO_WHY})`, keys: { keys: { merge: null } }, goAhead: false });
    git(repo.main, 'tag', '-f', 'feature', git(repo.wt, 'rev-parse', 'HEAD'));
    expect(await w.hold('git merge feature', repo.main)).toEqual({ say: 'nothing' });
  });
});

describe('A5: a deploy is keyed, or cleared, only from the main checkout on main with nothing uncommitted', () => {
  /** A web change on main, ahead of the live build: with Landing on, a deploy of it from the main checkout is clear. */
  function mainAhead(): void {
    write(repo.main, 'web/deployed.ts', lines(4, 'deployed'));
    commit(repo.main, 'to deploy');
  }

  it('from the main checkout, clean, on main: clear with Landing on; held and keyed deploy: with it off, the card naming the script', async () => {
    const w = world();
    mainAhead();
    expect(await w.hold('npm run deploy', repo.main)).toEqual({ say: 'nothing' });
    leadDisallow(w.ctx, w.project.slug, 'Progresser', V, { switch: 'landing' });
    expect(await w.hold('npm run deploy', repo.main)).toEqual({ held: true, text: 'a deploy of main to the live build (the deploy script)' });
    expect(w.last()).toMatchObject({ keys: { keys: { deploy: expect.stringMatching(/^deploy:[0-9a-f]{40}$/) } }, goAhead: true });
  });

  it('from a worktree, with changes not committed, or on a detached HEAD: held with no key, even with Landing on', async () => {
    const w = world();
    mainAhead();
    expect((await w.hold('npm run deploy', repo.wt)).held).toBe(true);
    expect(w.last()).toMatchObject({ why: `hold: this is Aiden's (${DEPLOY_WHERE_WHY})`, keys: { keys: { deploy: null } }, goAhead: false });
    write(repo.main, 'notes.txt', 'not committed\n');
    expect((await w.hold('node scripts/deploy.mjs', repo.main)).held).toBe(true);
    expect(w.last()).toMatchObject({ why: `hold: this is Aiden's (${DEPLOY_WHERE_WHY})`, keys: { keys: { deploy: null } } });
    git(repo.main, 'clean', '-q', '-f', 'notes.txt');
    git(repo.main, 'checkout', '-q', '--detach');
    expect((await w.check('deploy', repo.main, 'npm run deploy')).text).toContain(DEPLOY_WHERE_WHY);
    expect((await w.check('deploy', repo.main, 'npm run deploy')).patchId).toBeNull();
  });

  it("a rollback is always held, and only his yes on that rollback releases it; a yes on the deploy does not", async () => {
    const w = world();
    mainAhead();
    expect(await w.hold('npm run rollback', repo.main)).toEqual({ held: true, text: 'a rollback of the live build (the rollback script)' });
    const rollback = w.last();
    expect(rollback).toMatchObject({ why: `hold: this is Aiden's (${ROLLBACK_WHY})`, keys: { keys: { deploy: expect.stringMatching(/^rollback:[0-9a-f]{40}$/) } }, goAhead: true });
    const deploy = (await w.check('deploy', repo.main, 'npm run deploy')).patchId!;
    recordYes(w.ctx, w.project.id, { action: 'deploy', patchId: deploy, stepId: w.step.id, aidenWords: 'deploy it' });
    expect(await w.check('deploy', repo.main, 'node scripts/deploy.mjs --rollback')).toMatchObject({ clear: false, patchId: deploy.replace(/^deploy:/, 'rollback:') });
    expect((await w.click(rollback.id)).statusCode).toBe(200);
    expect(await w.check('deploy', repo.main, 'npm run rollback')).toMatchObject({ clear: true, why: 'his yes' });
  });

  it('reads the script exactly: deploy or rollback, nothing else', () => {
    expect([deployScript('npm run deploy'), deployScript('pnpm run-script deploy'), deployScript('yarn deploy'), deployScript('node scripts/deploy.mjs'), deployScript(undefined)]).toEqual(['deploy', 'deploy', 'deploy', 'deploy', 'deploy']);
    expect([deployScript('npm run rollback'), deployScript('yarn run rollback'), deployScript('node C:/x/scripts/deploy.mjs --rollback')]).toEqual(['rollback', 'rollback', 'rollback']);
    for (const s of ['npm run release', 'npm run deploy -- --rollback', 'node scripts/deploy-web.mjs', 'X=1 npm run deploy', 'npm run deploy:prod']) expect(deployScript(s), s).toBeNull();
  });
});

describe('minors', () => {
  it('a check that throws keeps no key: a push of a missing branch offers no Go ahead, and keysAtHold stores none either', async () => {
    const w = world();
    expect((await w.hold('git push origin nosuch')).held).toBe(true);
    const held = w.last();
    expect(held.why).toContain('the landing check could not answer');
    expect(held).toMatchObject({ keys: { branch: 'nosuch', keys: {} }, goAhead: false });
    expect(await keysAtHold(w.ctx, w.project.slug, w.step.id, 'git push origin nosuch', repo.wt)).toEqual({ folder: repo.wt.replace(/\\/g, '/'), branch: 'nosuch', keys: {} });
  });

  it('a held push with a null key offers no Go ahead', async () => {
    const w = world();
    write(repo.wt, 'src/hooks/x.ts', lines(9, 'feature'));
    commit(repo.wt, 'hooks');
    expect((await w.hold('git push')).held).toBe(true);
    const held = w.last();
    expect(held.goAhead).toBe(true);
    w.ctx.db.prepare('UPDATE desk_items SET outcome = ? WHERE id = ?').run(heldOutcome('by the check', 'a push', { ...held.keys!, keys: { push: null } }), held.id);
    expect(w.last().goAhead).toBe(false);
  });
});
