import { describe, expect, it } from 'vitest';
import type { SyncFile } from '../../src/core/types';
import { adaptationName, adaptationRow } from '../../web/src/docs/adaptations';

const file = (template: string, extra: Partial<SyncFile> = {}): SyncFile => ({ template, local: template, base: null, state: 'current', behind: 0, commits: [], fills: {}, detail: null, ...extra });

describe('the Docs index rows for adaptations', () => {
  it('names a skill by its folder, an agent by its file stem and anything else by its file name', () => {
    expect(adaptationName('skills/sigmund/SKILL.md')).toBe('sigmund');
    expect(adaptationName('agents/sev.md')).toBe('sev');
    expect(adaptationName('CLAUDE.md')).toBe('CLAUDE.md');
    expect(adaptationName('rules/house.md')).toBe('house.md');
  });

  it('codes the kind from the template folder', () => {
    expect(['agents/sev.md', 'skills/a/SKILL.md', 'CLAUDE.md'].map((t) => adaptationRow(file(t)).kind)).toEqual(['AGT', 'SKL', 'KIT']);
  });

  it('says current, "N behind" in the behind colour, and the other states in alarm', () => {
    expect(adaptationRow(file('a.md')).state).toEqual({ text: 'current', tone: 'plain' });
    expect(adaptationRow(file('a.md', { state: 'behind', behind: 3 })).state).toEqual({ text: '3 behind', tone: 'behind' });
    for (const state of ['pending', 'missing', 'gone', 'error'] as const) expect(adaptationRow(file('a.md', { state })).state).toEqual({ text: state, tone: 'alarm' });
  });

  it('counts the file fills, with none shown for none', () => {
    expect(adaptationRow(file('a.md')).fills).toBeNull();
    expect(adaptationRow(file('a.md', { fills: { A: 'x' } })).fills).toBe('1 file fill');
    expect(adaptationRow(file('a.md', { fills: { A: 'x', B: 'y' } })).fills).toBe('2 file fills');
  });
});
