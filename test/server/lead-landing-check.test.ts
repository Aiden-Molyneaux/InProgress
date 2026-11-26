import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { LEAD_INSTRUCTIONS_VERSION } from '../../src/core/lead';
import { leadAllow, leadDisallow } from '../../src/server/lead-commands';
import { VISIBILITY_TTL_MS, checkLanding, githubRepoOf, realGit, recordYes, remoteLabel, type LandingDeps } from '../../src/server/lead/landing';
import { addNodes } from '../../src/server/repo/nodes';
import { createProject, setProjectLead, updateProject } from '../../src/server/repo/projects';
import { commit, git, lines, makeRepo, write, type TestRepo } from '../git-repo';
import { makeCtx } from '../helpers';

const V = LEAD_INSTRUCTIONS_VERSION;
const HELD = "hold: this is Aiden's";
let repo: TestRepo;

beforeEach(() => {
  repo = makeRepo();
});
afterEach(() => repo.cleanup());

/** A project led by Progresser, one step, another project's step, and a visibility reader that is a spy. */
function setup(visible: boolean | null = false) {
  const ctx = makeCtx();
  const project = createProject(ctx, 'test', { name: 'InGame' });
  setProjectLead(ctx, 'window', project.slug, 'Progresser');
  const [step] = addNodes(ctx, 'test', { parentId: project.rootNodeId, nodes: [{ title: 'Build tabs' }] });
  const elsewhere = createProject(ctx, 'test', { name: 'Other' });
  const [other] = addNodes(ctx, 'test', { parentId: elsewhere.rootNodeId, nodes: [{ title: 'Elsewhere' }] });
  const visibility = vi.fn(async (_url: string): Promise<boolean | null> => visible);
  const deps: LandingDeps = { git: realGit, visibility };
  const landingOn = () => leadAllow(ctx, project.slug, 'Progresser', V, { switch: 'landing', aidenWords: 'yes' });
  const landingOff = () => leadDisallow(ctx, project.slug, 'Progresser', V, { switch: 'landing' });
  const check = (action: Parameters<typeof checkLanding>[1]['action'], extra: { folder?: string; branch?: string; stepId?: number } = {}) =>
    checkLanding(ctx, { ref: project.slug, stepId: step.id, action, folder: repo.wt, ...extra }, deps);
  const events = (kind: string) => ctx.db.prepare('SELECT text, node_id FROM lead_events WHERE kind = ? ORDER BY id').all(kind) as { text: string; node_id: number }[];
  return { ctx, project, step, other, visibility, landingOn, landingOff, check, events };
}

describe('merge', () => {
  it('off the risk list is clear with Landing on and held with it off', async () => {
    const t = setup();
    t.landingOn();
    write(repo.wt, 'web/app.ts', lines(20, 'feature'));
    commit(repo.wt, 'feature');
    const on = await t.check('merge');
    expect(on).toMatchObject({ clear: true, text: 'Clear to land', action: 'merge', range: 'refs/heads/main...refs/heads/feature', files: 1 });
    expect(on.patchId).toMatch(/^[0-9a-f]{40}$/);
    t.landingOff();
    expect(await t.check('merge')).toMatchObject({ clear: false, text: `${HELD} (Landing is off)` });
  });

  it('touching src/hooks/x.ts is held, clear after his yes, still clear after main is merged in, held once the work changes', async () => {
    const t = setup();
    t.landingOn();
    write(repo.wt, 'src/hooks/x.ts', lines(6, 'feature'));
    commit(repo.wt, 'hooks');
    const held = await t.check('merge');
    expect(held).toMatchObject({ clear: false, text: `${HELD} (it touches src/hooks/x.ts)` });

    recordYes(t.ctx, t.project.id, { action: 'merge', patchId: held.patchId!, stepId: t.step.id, aidenWords: 'ship it' });
    expect(await t.check('merge')).toMatchObject({ clear: true, text: 'Clear to land', patchId: held.patchId });

    write(repo.main, 'README.md', lines(4, 'readme moved on'));
    commit(repo.main, 'main moves on');
    git(repo.wt, '-c', 'user.name=t', '-c', 'user.email=t@t', 'merge', '-q', '--no-edit', 'main');
    expect(await t.check('merge')).toMatchObject({ clear: true, patchId: held.patchId });

    write(repo.wt, 'src/hooks/x.ts', lines(9, 'feature again'));
    commit(repo.wt, 'work changes');
    const changed = await t.check('merge');
    expect(changed).toMatchObject({ clear: false, text: `${HELD} (changed since his yes)` });
    expect(changed.patchId).not.toBe(held.patchId);
  });

  it('a yes for merge does not clear a publish of the same change', async () => {
    const t = setup();
    t.landingOn();
    write(repo.wt, 'web/app.ts', lines(7, 'feature'));
    commit(repo.wt, 'feature');
    const merge = await t.check('merge');
    recordYes(t.ctx, t.project.id, { action: 'merge', patchId: merge.patchId!, stepId: t.step.id, aidenWords: 'ship it' });
    expect((await t.check('publish')).clear).toBe(false);
  });

  it("a playbook's Risk lines add to the default list and never replace it", async () => {
    const t = setup();
    t.landingOn();
    updateProject(t.ctx, 'test', t.project.slug, { playbook: 'Risk: billing/**' });
    write(repo.wt, 'src/hooks/x.ts', lines(6, 'feature'));
    commit(repo.wt, 'hooks');
    expect((await t.check('merge')).clear).toBe(false);
    git(repo.wt, 'reset', '-q', '--hard', 'main');
    write(repo.wt, 'web/app.ts', lines(6, 'feature'));
    commit(repo.wt, 'web');
    expect((await t.check('merge')).clear).toBe(true);
    write(repo.wt, 'billing/a.ts', lines(6, 'feature'));
    commit(repo.wt, 'billing');
    expect(await t.check('merge')).toMatchObject({ clear: false, text: `${HELD} (it touches billing/a.ts)` });
  });

  it('moving a risk file out of the list is held: a rename shows its old path', async () => {
    const t = setup();
    t.landingOn();
    git(repo.wt, 'mv', 'src/hooks/x.ts', 'web/x.ts');
    commit(repo.wt, 'move out of hooks');
    expect(await t.check('merge')).toMatchObject({ clear: false, files: 2, text: `${HELD} (it touches src/hooks/x.ts)` });
  });

  it('an indentation-only change voids a yes: whitespace counts in the patch id', async () => {
    const t = setup();
    t.landingOn();
    write(repo.wt, 'src/hooks/x.ts', lines(3, 'plain'));
    commit(repo.wt, 'hooks');
    const first = await t.check('merge');
    recordYes(t.ctx, t.project.id, { action: 'merge', patchId: first.patchId!, stepId: t.step.id, aidenWords: 'ship it' });
    write(repo.wt, 'src/hooks/x.ts', lines(3, 'plain').replace('plain line 1', '  plain line 1'));
    commit(repo.wt, 'indent');
    const second = await t.check('merge');
    expect(second.patchId).not.toBe(first.patchId);
    expect(second.clear).toBe(false);
  });

  it('from the main checkout it needs the branch named, and a branch with no change is never clear', async () => {
    const t = setup();
    t.landingOn();
    await expect(t.check('merge', { folder: repo.main })).rejects.toMatchObject({ status: 409, message: 'Name the branch being merged: --branch <name>' });
    await expect(t.check('merge', { branch: 'main' })).rejects.toMatchObject({ status: 409, message: 'Name the branch being merged: --branch <name>' });
    await expect(t.check('merge')).rejects.toMatchObject({ status: 409, message: 'Nothing to compare: feature has no change against main.' });
    expect(t.events('landing_check')).toEqual([]);
  });

  it('a detached HEAD is on no branch', async () => {
    const t = setup();
    t.landingOn();
    git(repo.wt, 'checkout', '-q', '--detach');
    await expect(t.check('merge')).rejects.toMatchObject({ status: 409, message: expect.stringContaining('This checkout is on no branch') });
    await expect(t.check('merge', { branch: 'feature' })).rejects.toMatchObject({ message: 'Nothing to compare: feature has no change against main.' });
  });

  it('takes the branch given, from any folder of the repository', async () => {
    const t = setup();
    t.landingOn();
    write(repo.wt, 'web/app.ts', lines(7, 'feature'));
    commit(repo.wt, 'feature');
    expect(await t.check('merge', { folder: repo.main, branch: 'feature' })).toMatchObject({ clear: true, range: 'refs/heads/main...refs/heads/feature', files: 1 });
  });
});

describe('deploy', () => {
  it("reads the live build's sha from dist/build.json in the main checkout", async () => {
    const t = setup();
    t.landingOn();
    write(repo.main, 'src/hooks/x.ts', lines(6, 'main'));
    const head = commit(repo.main, 'hooks on main');
    const held = await t.check('deploy', { folder: repo.main });
    expect(held).toMatchObject({ clear: false, range: `${repo.base}..refs/heads/main`, files: 1, text: `${HELD} (it touches src/hooks/x.ts)` });

    writeFileSync(join(repo.main, 'dist', 'build.json'), JSON.stringify({ sha: head, dirty: false, builtAt: '2026-11-25T01:00:00.000Z' }));
    expect(await t.check('deploy', { folder: repo.main })).toMatchObject({ clear: true, range: `${head}..refs/heads/main`, files: 0, patchId: null });
  });

  it('reads a 7-character sha as build-to.mjs writes it, and holds a live build that is not behind main', async () => {
    const t = setup();
    t.landingOn();
    write(repo.main, 'web/app.ts', lines(6, 'main'));
    const head = commit(repo.main, 'web on main');
    writeFileSync(join(repo.main, 'dist', 'build.json'), JSON.stringify({ sha: repo.base.slice(0, 7), dirty: false, builtAt: '2026-11-25T01:00:00.000Z' }));
    expect(await t.check('deploy', { folder: repo.main })).toMatchObject({ clear: true, range: `${repo.base.slice(0, 7)}..refs/heads/main`, files: 1 });

    // A build made from a commit main does not hold (a feature branch built and deployed).
    write(repo.wt, 'web/app.ts', lines(9, 'feature'));
    const off = commit(repo.wt, 'feature');
    writeFileSync(join(repo.main, 'dist', 'build.json'), JSON.stringify({ sha: off.slice(0, 7), dirty: false, builtAt: '2026-11-25T02:00:00.000Z' }));
    expect(await t.check('deploy', { folder: repo.main })).toMatchObject({ clear: false, text: `${HELD} (the live build is not behind main)` });
    expect(head).not.toBe(off);
  });

  it('holds a live build made from uncommitted work', async () => {
    const t = setup();
    t.landingOn();
    writeFileSync(join(repo.main, 'dist', 'build.json'), JSON.stringify({ sha: repo.base.slice(0, 7), dirty: true, builtAt: '2026-11-25T01:00:00.000Z' }));
    expect(await t.check('deploy', { folder: repo.main })).toMatchObject({ clear: false, text: `${HELD} (the live build was made from uncommitted work)` });
  });

  it('is refused with a plain line when there is no live build to compare with', async () => {
    const t = setup();
    t.landingOn();
    write(repo.main, 'dist/build.json', '{}');
    await expect(t.check('deploy', { folder: repo.main })).rejects.toMatchObject({ status: 409 });
  });
});

describe('push, push-public and publish', () => {
  it('a push to a remote the reader calls public is held as a push-public, and the reader is asked once per remote URL', async () => {
    const t = setup(true);
    t.landingOn();
    write(repo.wt, 'web/app.ts', lines(7, 'feature'));
    commit(repo.wt, 'feature');
    const first = await t.check('push');
    expect(first).toMatchObject({ clear: false, text: `${HELD} (a push-public goes out in his name)`, range: 'refs/remotes/origin/feature..refs/heads/feature' });
    await t.check('push');
    expect(t.visibility).toHaveBeenCalledTimes(1);
    expect(t.visibility).toHaveBeenCalledWith('https://github.com/acme/widgets.git');
    git(repo.main, 'config', 'remote.origin.url', 'https://github.com/acme/other.git');
    await t.check('push');
    expect(t.visibility).toHaveBeenCalledTimes(2);
  });

  it('a private remote is an ordinary push', async () => {
    const t = setup(false);
    t.landingOn();
    write(repo.wt, 'web/app.ts', lines(7, 'feature'));
    commit(repo.wt, 'feature');
    expect((await t.check('push')).clear).toBe(true);
    expect(t.events('landing_check')).toEqual([]);
  });

  it('a reader that fails, or a remote that is not on GitHub, is held as could not tell, and a failure is asked again', async () => {
    const failing = setup(null);
    failing.landingOn();
    write(repo.wt, 'web/app.ts', lines(7, 'feature'));
    commit(repo.wt, 'feature');
    const held = await failing.check('push');
    expect(held).toMatchObject({ clear: false, text: `${HELD} (could not tell whether https://github.com/acme/widgets.git is public)` });
    await failing.check('push');
    expect(failing.visibility).toHaveBeenCalledTimes(2);

    git(repo.main, 'config', 'remote.origin.url', 'C:/somewhere/origin.git');
    const local = setup(false);
    local.landingOn();
    expect(await local.check('push')).toMatchObject({ clear: false, text: `${HELD} (could not tell whether C:/somewhere/origin.git is public)` });
  });

  it('judges the push URL, which honours pushurl, and keeps a user name out of the line', async () => {
    const t = setup(true);
    t.landingOn();
    write(repo.wt, 'web/app.ts', lines(7, 'feature'));
    commit(repo.wt, 'feature');
    git(repo.main, 'config', 'remote.origin.pushurl', 'https://tok@github.com/acme/pushed.git');
    await t.check('push');
    expect(t.visibility).toHaveBeenCalledWith('https://tok@github.com/acme/pushed.git');
    expect(remoteLabel('https://tok:x@github.com/acme/pushed.git')).toBe('https://github.com/acme/pushed.git');
  });

  it('keeps a read of visibility for ten minutes and asks again after', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    try {
      const t = setup(false);
      t.landingOn();
      write(repo.wt, 'web/app.ts', lines(7, 'feature'));
      commit(repo.wt, 'feature');
      await t.check('push');
      vi.setSystemTime(Date.now() + VISIBILITY_TTL_MS - 1000);
      await t.check('push');
      expect(t.visibility).toHaveBeenCalledTimes(1);
      vi.setSystemTime(Date.now() + 2000);
      await t.check('push');
      expect(t.visibility).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it('a push with nothing to push is clear, and a branch never pushed is read against main', async () => {
    const t = setup(false);
    t.landingOn();
    expect(await t.check('push')).toMatchObject({ clear: true, text: 'Clear to land', files: 0, patchId: null });
    git(repo.wt, 'checkout', '-q', '-b', 'fresh');
    write(repo.wt, 'src/hooks/x.ts', lines(6, 'fresh'));
    commit(repo.wt, 'fresh');
    expect(await t.check('push')).toMatchObject({ clear: false, range: 'refs/heads/main...refs/heads/fresh', text: `${HELD} (it touches src/hooks/x.ts)` });
  });

  it('a push of commits that change nothing (a commit and its revert) still goes out, so it is judged, not clear', async () => {
    const t = setup(true);
    t.landingOn();
    write(repo.wt, 'web/app.ts', lines(7, 'feature'));
    commit(repo.wt, 'feature');
    git(repo.wt, 'revert', '--no-edit', 'HEAD');
    const verdict = await t.check('push');
    expect(verdict.clear).toBe(false);
    expect(verdict.why).not.toBe('nothing to push');
  });

  it('publish is held without a yes whatever the change, never asks the reader, and clears with a yes for it', async () => {
    const t = setup(true);
    t.landingOn();
    write(repo.wt, 'web/app.ts', lines(7, 'feature'));
    write(repo.wt, 'package.json', JSON.stringify({ name: 'x', version: '1.0.0' }));
    commit(repo.wt, 'feature');
    const held = await t.check('publish');
    expect(held).toMatchObject({ clear: false, text: `${HELD} (a publish goes out in his name)` });
    expect(t.visibility).not.toHaveBeenCalled();
    recordYes(t.ctx, t.project.id, { action: 'publish', patchId: held.patchId!, stepId: t.step.id, aidenWords: 'publish it' });
    expect((await t.check('publish')).clear).toBe(true);
  });

  it('a publish of a head that is already pushed (an empty range) is keyed on what goes out, and a yes on it clears', async () => {
    const t = setup(false);
    t.landingOn();
    write(repo.wt, 'package.json', JSON.stringify({ name: 'x', version: '1.0.0' }));
    commit(repo.wt, 'package');
    git(repo.wt, 'update-ref', 'refs/remotes/origin/feature', 'HEAD');
    const held = await t.check('publish');
    expect(held).toMatchObject({ clear: false, files: 0 });
    expect(held.patchId).toBe(`${git(repo.wt, 'rev-parse', 'HEAD^{tree}')}::x@1.0.0`);
    recordYes(t.ctx, t.project.id, { action: 'publish', patchId: held.patchId!, stepId: t.step.id, aidenWords: 'publish it' });
    expect((await t.check('publish')).clear).toBe(true);
    write(repo.wt, 'web/app.ts', lines(7, 'later'));
    commit(repo.wt, 'later');
    expect((await t.check('publish')).text).toBe(`${HELD} (changed since his yes)`);
  });
});

describe('the log and the refusals', () => {
  it('writes a landing_check row for each held check, with the verdict text, and none for a clear one', async () => {
    const t = setup();
    t.landingOn();
    write(repo.wt, 'src/hooks/x.ts', lines(6, 'feature'));
    commit(repo.wt, 'hooks');
    const first = await t.check('merge');
    await t.check('publish');
    // A clear answer writes no row.
    recordYes(t.ctx, t.project.id, { action: 'merge', patchId: first.patchId!, stepId: t.step.id, aidenWords: 'ship it' });
    expect((await t.check('merge')).clear).toBe(true);
    expect(t.events('landing_check')).toEqual([
      { text: `merge: ${HELD} (it touches src/hooks/x.ts)`, node_id: t.step.id },
      { text: `publish: ${HELD} (a publish goes out in his name)`, node_id: t.step.id },
    ]);
  });

  it('refuses a step that is not there or not in the project, an unknown branch, a folder that is not a checkout, a relative folder', async () => {
    const t = setup();
    t.landingOn();
    await expect(t.check('merge', { stepId: 9999 })).rejects.toMatchObject({ status: 404 });
    await expect(t.check('merge', { stepId: t.other.id })).rejects.toMatchObject({ status: 409, message: `#${t.other.id} is not in this project.` });
    await expect(t.check('merge', { branch: 'nope' })).rejects.toMatchObject({ status: 409, message: `There is no branch nope in ${repo.wt}.` });
    await expect(t.check('merge', { branch: '--upload-pack=x' })).rejects.toMatchObject({ status: 400 });
    await expect(t.check('merge', { folder: 'relative/dir' })).rejects.toMatchObject({ status: 400 });
    const plain = mkdtempSync(join(tmpdir(), 'ip-notgit-'));
    try {
      await expect(t.check('merge', { folder: plain })).rejects.toMatchObject({ status: 400, message: `${plain} is not a git checkout.` });
    } finally {
      rmSync(plain, { recursive: true, force: true });
    }
    expect(t.events('landing_check')).toEqual([]);
  });
});

describe('githubRepoOf', () => {
  it('reads github.com remotes however they are spelled, and no other', () => {
    for (const url of [
      'https://github.com/acme/widgets.git',
      'https://github.com/acme/widgets',
      'https://user:tok@github.com/acme/widgets.git',
      'HTTPS://GitHub.com/acme/widgets.git',
      'https://www.github.com/acme/widgets',
      'git@github.com:acme/widgets.git',
      'git@github.com-work:acme/widgets.git',
      'ssh://git@github.com/acme/widgets.git',
      'ssh://git@github.com:22/acme/widgets.git',
      'ssh://git@github.com-work/acme/widgets.git',
      'git://github.com/acme/widgets.git',
    ]) {
      expect(githubRepoOf(url), url).toBe('acme/widgets');
    }
    for (const url of ['https://gitlab.com/acme/widgets.git', 'https://github.com.evil.io/acme/widgets.git', 'https://github.com-work/acme/widgets.git', 'https://github.com/acme', 'C:/somewhere/origin.git', '']) {
      expect(githubRepoOf(url), url).toBeNull();
    }
  });
});
