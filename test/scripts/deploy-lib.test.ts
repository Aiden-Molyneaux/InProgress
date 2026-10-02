import { existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { promote, suitesFor, swapWithPrev } from '../../scripts/deploy-lib.mjs';

const temps: string[] = [];
afterAll(() => {
  for (const dir of temps) rmSync(dir, { recursive: true, force: true });
});

/** A repo with a live build `label`, plus a candidate build in .build labelled `next`. */
function layout(label: string | null, next: string | null) {
  const repo = mkdtempSync(join(tmpdir(), 'ip-deploy-'));
  temps.push(repo);
  const put = (root: string, text: string) => {
    for (const tree of ['dist', join('web', 'dist')]) {
      mkdirSync(join(root, tree), { recursive: true });
      writeFileSync(join(root, tree, 'marker.txt'), text);
    }
  };
  if (label) put(repo, label);
  if (next) put(join(repo, '.build'), next);
  return { repo, from: join(repo, '.build'), prev: join(repo, '.deploy', 'prev') };
}
const live = (repo: string) => [readFileSync(join(repo, 'dist', 'marker.txt'), 'utf8'), readFileSync(join(repo, 'web', 'dist', 'marker.txt'), 'utf8')];

describe('deploy directory moves', () => {
  it('promotes a build and keeps the previous one; rollback swaps them both ways', () => {
    const l = layout('old', 'new');
    promote(l);
    expect(live(l.repo)).toEqual(['new', 'new']);
    expect(live(l.prev)).toEqual(['old', 'old']);
    expect(existsSync(join(l.from, 'dist'))).toBe(false);
    swapWithPrev(l);
    expect(live(l.repo)).toEqual(['old', 'old']);
    swapWithPrev(l);
    expect(live(l.repo)).toEqual(['new', 'new']);
  });

  it('promotes onto a repo with no live build yet', () => {
    const l = layout(null, 'first');
    promote(l);
    expect(live(l.repo)).toEqual(['first', 'first']);
  });

  it('refuses before moving anything when the candidate build is incomplete', () => {
    const l = layout('old', 'new');
    rmSync(join(l.from, 'web', 'dist'), { recursive: true });
    expect(() => promote(l)).toThrow(/missing; build first/);
    expect(live(l.repo)).toEqual(['old', 'old']);
  });

  it('moves everything back when a move fails partway', () => {
    const l = layout('old', 'new');
    let calls = 0;
    const flaky = (from: string, to: string) => {
      if (++calls === 3) throw Object.assign(new Error('disk said no'), { code: 'EIO' });
      renameSync(from, to);
    };
    expect(() => promote({ ...l, rename: flaky })).toThrow('disk said no');
    expect(live(l.repo)).toEqual(['old', 'old']);
    expect(readFileSync(join(l.from, 'dist', 'marker.txt'), 'utf8')).toBe('new');
  });

  it('retries a move Windows briefly refuses', () => {
    const l = layout('old', 'new');
    let refusals = 2;
    const busy = (from: string, to: string) => {
      if (refusals-- > 0) throw Object.assign(new Error('busy'), { code: 'EBUSY' });
      renameSync(from, to);
    };
    promote({ ...l, rename: busy });
    expect(live(l.repo)).toEqual(['new', 'new']);
  });
});

describe('which test suites a deploy runs', () => {
  it('runs smoke for hook, CLI, MCP, server and kit changes, and e2e for UI, core and server changes', () => {
    expect(suitesFor(['src/hooks/handlers.ts'])).toMatchObject({ smoke: true, e2e: false });
    expect(suitesFor(['claude/skills/inprogress/SKILL.md', 'src/cli/doctor.ts'])).toMatchObject({ smoke: true, e2e: false });
    expect(suitesFor(['web/src/chrome/TopBar.tsx', 'web/src/styles.css'])).toMatchObject({ smoke: false, e2e: true });
    expect(suitesFor(['src/core/layout.ts'])).toMatchObject({ smoke: false, e2e: true });
    expect(suitesFor(['src/server/routes/read.ts'])).toMatchObject({ smoke: true, e2e: true });
    expect(suitesFor(['package.json'])).toMatchObject({ smoke: true, e2e: true });
    expect(suitesFor(['docs/guide/inprogress-guide.html', 'README.md'])).toMatchObject({ smoke: false, e2e: false });
    expect(suitesFor(['src\\hooks\\main.ts'])).toMatchObject({ smoke: true });
  });

  it('runs everything when the deployed build is unknown', () => {
    expect(suitesFor(null)).toMatchObject({ smoke: true, e2e: true });
  });
});
