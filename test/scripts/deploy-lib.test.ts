import { existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { promote, restartCheck, suitesFor, swapWithPrev } from '../../scripts/deploy-lib.mjs';

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

describe('the restart check after a deploy or rollback', () => {
  const live = { sha: '8b796d9', dirty: false, builtAt: '2026-10-16T19:31:58.000Z' };
  const answer = (build: unknown, status = 200) => ({ status, text: JSON.stringify({ ok: true, app: 'inprogress', build, pid: 39988 }) });

  it('passes when health reports the live build', () => {
    expect(restartCheck(live, answer({ ...live }))).toBeNull();
  });

  it('says which build health reported against the one expected, with the status and body', () => {
    const seen = answer({ sha: '27f1190', dirty: false, builtAt: '2026-10-16T18:02:11.000Z' });
    const said = restartCheck(live, seen);
    expect(said).toContain('expected 8b796d9 (2026-10-16T19:31:58.000Z)');
    expect(said).toContain('answered 200 with 27f1190 (2026-10-16T18:02:11.000Z)');
    expect(said).toContain(seen.text);
  });

  it('fails a build that matches on sha but not on builtAt', () => {
    expect(restartCheck(live, answer({ ...live, builtAt: '2026-10-16T19:00:00.000Z' }))).toContain('with 8b796d9 (2026-10-16T19:00:00.000Z)');
  });

  it('reports a health answer with no build, or one that is not JSON', () => {
    expect(restartCheck(live, answer(null))).toContain('answered 200 with no build');
    const said = restartCheck(live, { status: 503, text: 'Service Unavailable' });
    expect(said).toContain('answered 503 with no build');
    expect(said).toContain('Service Unavailable');
  });

  it('reports the error when health did not answer', () => {
    const refused = Object.assign(new TypeError('fetch failed'), { cause: Object.assign(new Error('connect ECONNREFUSED 127.0.0.1:4317'), { code: 'ECONNREFUSED' }) });
    expect(restartCheck(live, { error: refused })).toBe('/api/health did not answer: TypeError: fetch failed (ECONNREFUSED: connect ECONNREFUSED 127.0.0.1:4317)');
    const timedOut = new DOMException('The operation was aborted due to timeout', 'TimeoutError');
    expect(restartCheck(live, { error: timedOut })).toContain('TimeoutError: The operation was aborted due to timeout');
  });

  it('reports a live build.json it could not read, with what health said', () => {
    const said = restartCheck(null, answer({ ...live }));
    expect(said).toContain('dist/build.json is missing or unreadable');
    expect(said).toContain('answered 200 with 8b796d9');
  });

  it('cuts a long body short', () => {
    const said = restartCheck(live, { status: 500, text: 'x'.repeat(5000) }) ?? '';
    expect(said.length).toBeLessThan(700);
    expect(said).toContain('(5000 chars)');
  });
});
