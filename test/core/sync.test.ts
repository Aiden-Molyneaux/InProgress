import { describe, expect, it } from 'vitest';
import { cellState, groupTemplates, isSyncStep, rowSummary, syncSentence } from '../../src/core/sync';
import type { SyncCheck, SyncCommit, SyncFile, SyncRow } from '../../src/core/types';

const commit = (sha: string, date: string, subject = `subject ${sha}`): SyncCommit => ({ sha, date, subject });
const file = (template: string, state: SyncFile['state'], o: Partial<SyncFile> = {}): SyncFile => ({ template, local: template, base: 'b1', state, behind: state === 'behind' ? 1 : 0, commits: [], fills: {}, detail: null, ...o });
const check = (files: SyncFile[], o: Partial<SyncCheck> = {}): SyncCheck => ({ shipwright: { head: 'abc1234', date: '2026-10-21', subject: 's' }, project: 'P', lastSync: null, files, skip: [], notAdopted: [], fills: {}, ...o });
const row = (name: string, c: SyncCheck | string, syncStep: SyncRow['syncStep'] = null): SyncRow => ({ projectId: 1, slug: name.toLowerCase(), name, dir: 'C:/x', check: typeof c === 'string' ? { ok: false, error: c } : { ok: true, result: c }, syncStep });

describe('cellState', () => {
  const c = check([file('a', 'current'), file('b', 'behind'), file('c', 'pending'), file('d', 'missing'), file('e', 'gone'), file('f', 'error')], { skip: ['s'] });
  it('takes a file its own state, then the skip list, then not adopted', () => {
    for (const t of ['a', 'b', 'c', 'd', 'e', 'f']) expect(cellState(c, t)).toEqual({ state: c.files.find((f) => f.template === t)!.state, file: c.files.find((f) => f.template === t) });
    expect(cellState(c, 's')).toEqual({ state: 'skipped', file: null });
    expect(cellState(c, 'zzz')).toEqual({ state: 'not-adopted', file: null });
  });
  it('lets a file in files win over the skip list', () => {
    expect(cellState(check([file('a', 'current')], { skip: ['a'] }), 'a').state).toBe('current');
  });
});

describe('groupTemplates', () => {
  it('groups by folder in the order Agents, Skills, Starter kit, Other, keeping the given order within each', () => {
    expect(groupTemplates(['starter-kit/x', 'skills/b/SKILL.md', 'agents/z.md', 'README.md', 'skills/a/SKILL.md', 'agents/a.md'])).toEqual([
      { group: 'Agents', templates: ['agents/z.md', 'agents/a.md'] },
      { group: 'Skills', templates: ['skills/b/SKILL.md', 'skills/a/SKILL.md'] },
      { group: 'Starter kit', templates: ['starter-kit/x'] },
      { group: 'Other', templates: ['README.md'] },
    ]);
  });
});

describe('rowSummary', () => {
  it('counts behind and adopted, takes the most common base (a tie goes to the first), and passes lastSync on', () => {
    const last = commit('l1', '2026-10-18');
    const s = rowSummary(check([file('a', 'behind', { base: 'x' }), file('b', 'current', { base: 'y' }), file('c', 'current', { base: 'y' }), file('d', 'current', { base: null })], { lastSync: last }));
    expect(s).toEqual({ behind: 1, adopted: 4, base: 'y', lastSync: last });
    expect(rowSummary(check([file('a', 'current', { base: 'x' }), file('b', 'current', { base: 'y' })])).base).toBe('x');
    expect(rowSummary(check([file('a', 'current', { base: null })])).base).toBeNull();
  });
});

describe('syncSentence', () => {
  const behindFile = (...commits: SyncCommit[]) => file('skills/x/SKILL.md', 'behind', { commits });
  it('says everything is current when nothing is behind', () => {
    expect(syncSentence([row('A', check([file('a', 'current')])), row('B', check([]))])).toBe('Every project with a manifest is current with Shipwright abc1234.');
  });
  it('names the behind projects, their commits newest first, and each one\'s sync step or lack of it', () => {
    const c1 = commit('c1', '2026-10-19', 'older');
    const c2 = commit('c2', '2026-10-21', 'newer');
    const text = syncSentence([row('InThink', check([behindFile(c1, c2)]), { id: 9, title: 'Sync' }), row('InProgress', check([behindFile(c2)])), row('Clean', check([file('a', 'current')]))]);
    expect(text).toBe('InThink and InProgress are behind Shipwright: c2 newer, c1 older. InThink has a sync step, #9. InProgress has none.');
  });
  it('uses "is" for one project and cuts the commits at three with "and N more"', () => {
    const cs = [1, 2, 3, 4, 5].map((n) => commit(`c${n}`, `2026-10-0${n}`));
    expect(syncSentence([row('A', check([behindFile(...cs)]))])).toBe('A is behind Shipwright: c5 subject c5, c4 subject c4, c3 subject c3, and 2 more. A has none.');
  });
  it('says a failed row\'s check failed, beside the others', () => {
    expect(syncSentence([row('A', check([file('a', 'current')])), row('B', 'boom')])).toBe('Every project that checked is current with Shipwright abc1234. B\'s check failed.');
    expect(syncSentence([row('B', 'boom')])).toBe('B\'s check failed.');
  });
});

describe('isSyncStep', () => {
  const adopted = ['agents/sev.md', 'skills/sigmund/SKILL.md'];
  it('wants the word sync and either Shipwright or an adopted template', () => {
    expect(isSyncStep('Sync InThink to Shipwright fbdaaa7', adopted)).toBe(true);
    expect(isSyncStep('sync the roster', adopted)).toBe(false);
    expect(isSyncStep('Sync sev.md', adopted)).toBe(true);
    expect(isSyncStep('Sync skills/sigmund/SKILL.md', adopted)).toBe(true);
  });
  it('misses near words and an unrelated sync', () => {
    expect(isSyncStep('Resync with Shipwright', adopted)).toBe(false);
    expect(isSyncStep('Synchronise Shipwright', adopted)).toBe(false);
    expect(isSyncStep('Sync the database', adopted)).toBe(false);
    expect(isSyncStep('Shipwright notes', adopted)).toBe(false);
  });
});
