import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { heldActions } from '../../src/core/hold';
import { LEAD_INSTRUCTIONS_VERSION } from '../../src/core/lead';
import { buildApp } from '../../src/server/app';
import { leadAllow, leadDisallow } from '../../src/server/lead-commands';
import { CHANGED_SINCE_HELD, heldCards } from '../../src/server/lead/carry';
import { GIT_CHANGED_WHY, heldKeysOf, heldOutcome, heldRef, heldWhatOf } from '../../src/server/lead/hold';
import { checkLanding, DEPLOY_SCRIPT_WHY, DEPLOY_WHERE_WHY, deployScript, FORCE_WHY, forcePush, realGit, recordYes, ROLLBACK_WHY, TAG_TOO_WHY, type LandingDeps } from '../../src/server/lead/landing';
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

describe('G2: a held action runs as a command of its own', () => {
  /** How many held items, held lines and Voice lines there are: a split answer makes none. */
  const made = (w: ReturnType<typeof world>) => ({
    items: w.ctx.db.prepare("SELECT COUNT(*) FROM desk_items WHERE kind = 'held'").pluck().get(),
    lines: w.ctx.db.prepare("SELECT COUNT(*) FROM lead_events WHERE kind = 'held'").pluck().get(),
    voice: w.ctx.db.prepare('SELECT COUNT(*) FROM lead_sends').pluck().get(),
  });

  it('a push, merge, deploy or publish behind a command that may change it is answered split, and nothing is made', async () => {
    const w = world();
    webChange();
    write(repo.wt, 'package.json', JSON.stringify({ name: 'x', version: '1.2.0' }));
    commit(repo.wt, 'package');
    for (const [command, cwd, action] of [
      ['git add -A && git commit -m x && git push', repo.wt, 'push'],
      ['git checkout feature; git push origin feature', repo.wt, 'push'],
      ['echo x > notes.txt && git push', repo.wt, 'push'],
      ['git config user.name x && git merge feature', repo.main, 'merge'],
      ['npm version patch && npm publish', repo.wt, 'publish'],
      ['npm install && npm run deploy', repo.main, 'deploy'],
      ['git -C . status && git push', repo.wt, 'push'],
    ] as const) {
      expect(await w.hold(command, cwd), command).toEqual({ split: true, text: `Run the ${action} as a command of its own: InProgress reads it before the commands in front of it have run.` });
    }
    expect(made(w)).toEqual({ items: 0, lines: 0, voice: 0 });
  });

  it('folder changes and the read-only commands in front, and anything after, leave it read as before', async () => {
    const w = world();
    webChange();
    // Landing is on and the change is off the risk list: each push reads clear, as alone.
    for (const command of [
      'git status && git push',
      'git log --oneline -3 && git diff main && git push',
      'git fetch origin; git rev-parse HEAD; git show --stat; git push',
      'git branch --show-current && git push',
      'npm test && npm run typecheck && git push',
      `cd ${repo.wt.replace(/\\/g, '/')} && pushd . && git push`,
      'git push && git commit --allow-empty -m after',
      'git push; echo done',
    ]) {
      expect(await w.hold(command), command).toEqual({ say: 'nothing' });
    }
  });

  it('a publish behind a read-only command or a folder change, or with commands after it, keeps its key', async () => {
    const w = world();
    write(repo.wt, 'package.json', JSON.stringify({ name: 'x', version: '1.2.0' }));
    commit(repo.wt, 'package');
    for (const command of ['npm test && npm publish', 'npm publish; echo done', 'cd . && npm publish', 'pushd . && npm publish']) {
      expect((await w.hold(command)).held, command).toBe(true);
      expect(w.last().keys?.keys.publish, command).toMatch(/:x@1\.2\.0$/);
      expect(w.last().goAhead, command).toBe(true);
    }
  });

  it("what InProgress cannot read exactly stays held, also behind other commands: git's environment changed", async () => {
    const w = world();
    webChange();
    expect((await w.hold('export GIT_SSH_COMMAND=x && git push')).held).toBe(true);
    expect(w.last()).toMatchObject({ why: GIT_CHANGED_WHY, goAhead: false });
  });

  it('a held line from before, with a commit in front of its push, offers no Go ahead and takes no yes', async () => {
    const w = world();
    write(repo.wt, 'src/hooks/x.ts', lines(9, 'feature'));
    commit(repo.wt, 'hooks');
    expect((await w.hold('git push')).held).toBe(true);
    const held = w.last();
    expect(held.goAhead).toBe(true);
    // The same item's held line rewritten as the old hold made it: a commit in front of the push.
    w.ctx.db.prepare("UPDATE lead_events SET text = 'git commit -am x && git push -> by the check' WHERE kind = 'held'").run();
    w.ctx.db.prepare("UPDATE desk_items SET ref = ? WHERE id = ?").run(heldRef('s1', 'git commit -am x && git push'), held.id);
    expect(w.last().goAhead).toBe(false);
    const res = await w.click(held.id);
    expect(res.statusCode).toBe(409);
    expect(w.ctx.db.prepare("SELECT COUNT(*) FROM lead_events WHERE kind = 'yes'").pluck().get()).toBe(0);
  });

  it("the card's npm_config_ test applies only when a publish is among the commands", async () => {
    const w = world();
    write(repo.wt, 'src/hooks/x.ts', lines(9, 'feature'));
    commit(repo.wt, 'hooks');
    expect((await w.hold('git push && export npm_config_color=false')).held).toBe(true);
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

  it('G3: a rollback is never released by a yes: no key, Not yet alone, the Voice records no yes, and Landing never clears it', async () => {
    const w = world();
    mainAhead();
    expect(await w.hold('npm run rollback', repo.main)).toEqual({ held: true, text: 'a rollback of the live build (the rollback script)' });
    const rollback = w.last();
    expect(rollback).toMatchObject({ why: `hold: this is Aiden's (${ROLLBACK_WHY})`, keys: { keys: { deploy: null } }, goAhead: false });
    expect((await w.click(rollback.id)).statusCode).toBe(409);
    // Even a hand-made key a yes could match is no yes: yesCanRelease refuses a rollback by its words.
    w.ctx.db.prepare('UPDATE desk_items SET outcome = ? WHERE id = ?').run(heldOutcome(ROLLBACK_WHY, 'a rollback', { ...rollback.keys!, keys: { deploy: 'rollback:abc' } }), rollback.id);
    expect(w.last().goAhead).toBe(false);
    // Held with Landing on and nothing risky, by either spelling.
    for (const s of ['npm run rollback', 'node scripts/deploy.mjs --rollback']) {
      expect(await w.check('deploy', repo.main, s), s).toMatchObject({ clear: false, patchId: null, text: expect.stringContaining(ROLLBACK_WHY) });
    }
    // A yes on the deploy, or one recorded on a rollback key, never clears a rollback: its check computes no key.
    const deploy = (await w.check('deploy', repo.main, 'npm run deploy')).patchId!;
    recordYes(w.ctx, w.project.id, { action: 'deploy', patchId: deploy, stepId: w.step.id, aidenWords: 'deploy it' });
    recordYes(w.ctx, w.project.id, { action: 'deploy', patchId: deploy.replace(/^deploy:/, 'rollback:'), stepId: w.step.id, aidenWords: 'roll it back' });
    for (const s of ['npm run rollback', 'node scripts/deploy.mjs --rollback']) {
      expect(await w.check('deploy', repo.main, s), s).toMatchObject({ clear: false, patchId: null });
    }
  });

  it('G1: node <path>/deploy.mjs is the deploy only when the path is the checkout\'s own scripts/deploy.mjs', async () => {
    const w = world();
    mainAhead();
    leadDisallow(w.ctx, w.project.slug, 'Progresser', V, { switch: 'landing' });
    // The checkout as git names it (a temporary folder may be given by its short Windows name).
    const main = git(repo.main, 'rev-parse', '--show-toplevel');
    // Another checkout's deploy script, run from the main checkout: held with no key.
    const other = `cd ${main} && node ${main}/.claude/worktrees/x/scripts/deploy.mjs`;
    expect(await w.hold(other, repo.main)).toMatchObject({ held: true, text: expect.stringContaining('a deploy by a script InProgress cannot read (node ') });
    expect(w.last()).toMatchObject({ why: `hold: this is Aiden's (${DEPLOY_SCRIPT_WHY})`, keys: { keys: { deploy: null } }, goAhead: false });
    for (const s of ['node .claude/worktrees/x/scripts/deploy.mjs', 'node ../elsewhere/scripts/deploy.mjs', 'node deploy.mjs', 'node scripts/deploy.js']) {
      expect((await w.check('deploy', repo.main, s)).patchId, s).toBeNull();
    }
    // The checkout's own, relative, absolute or with its slashes the other way and its case changed: keyed.
    for (const s of ['node scripts/deploy.mjs', `node ${main}/scripts/deploy.mjs`, `node ${main.replace(/\//g, '\\').toUpperCase()}\\SCRIPTS\\DEPLOY.MJS`, 'node ./scripts/../scripts/deploy.mjs']) {
      expect((await w.check('deploy', repo.main, s)).patchId, s).toMatch(/^deploy:[0-9a-f]{40}$/);
    }
    expect((await w.hold('node scripts/deploy.mjs', repo.main)).held).toBe(true);
    expect(w.last()).toMatchObject({ keys: { keys: { deploy: expect.stringMatching(/^deploy:[0-9a-f]{40}$/) } }, goAhead: true });
  });

  it('a file not tracked counts as uncommitted, also where git is set to hide them', async () => {
    const w = world();
    mainAhead();
    leadDisallow(w.ctx, w.project.slug, 'Progresser', V, { switch: 'landing' });
    git(repo.main, 'config', 'status.showUntrackedFiles', 'no');
    write(repo.main, 'stray/new.txt', 'not committed\n');
    expect((await w.check('deploy', repo.main, 'npm run deploy')).text).toContain(DEPLOY_WHERE_WHY);
  });

  it('a key the hold kept that reads as none now is changed since held', async () => {
    const w = world();
    mainAhead();
    leadDisallow(w.ctx, w.project.slug, 'Progresser', V, { switch: 'landing' });
    expect((await w.hold('npm run deploy', repo.main)).held).toBe(true);
    const held = w.last();
    expect(held.goAhead).toBe(true);
    // The main checkout now has a change not committed: the deploy's key reads as none.
    write(repo.main, 'notes.txt', 'not committed\n');
    const res = await w.click(held.id);
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toContain(`deploy: ${CHANGED_SINCE_HELD}`);
  });

  it('reads the script exactly: deploy or rollback, nothing else; a node script only against its checkout', () => {
    const at = { folder: 'C:/repo', top: 'C:/repo' };
    expect([deployScript('npm run deploy'), deployScript('pnpm run-script deploy'), deployScript('yarn deploy'), deployScript('node scripts/deploy.mjs', at), deployScript(undefined)]).toEqual(['deploy', 'deploy', 'deploy', 'deploy', 'deploy']);
    expect([deployScript('npm run rollback'), deployScript('yarn run rollback'), deployScript('node C:/repo/scripts/deploy.mjs --rollback', at)]).toEqual(['rollback', 'rollback', 'rollback']);
    for (const s of ['npm run release', 'npm run deploy -- --rollback', 'node scripts/deploy-web.mjs', 'X=1 npm run deploy', 'npm run deploy:prod']) expect(deployScript(s, at), s).toBeNull();
    // A node script with no checkout to read it against, or another checkout's, is null.
    expect(deployScript('node scripts/deploy.mjs')).toBeNull();
    expect(deployScript('node C:/x/scripts/deploy.mjs --rollback', at)).toBeNull();
    expect(deployScript('node C:/repo/.claude/worktrees/x/scripts/deploy.mjs', at)).toBeNull();
    expect(deployScript('node ../scripts/deploy.mjs', { folder: 'C:/repo/web', top: 'C:/repo' })).toBe('deploy');
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
