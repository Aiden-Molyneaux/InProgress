import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { agentTag, sessionTag } from '../../src/core/types';
import { FAMILY_COUNT, familyVar } from '../../web/src/family';

describe('sessionTag', () => {
  it('letters a slot from A, then AA after Z (bijective base 26)', () => {
    expect([0, 1, 2, 25].map(sessionTag)).toEqual(['A', 'B', 'C', 'Z']);
    expect([26, 27, 51, 52, 701, 702].map(sessionTag)).toEqual(['AA', 'AB', 'AZ', 'BA', 'ZZ', 'AAA']);
  });

  it('is empty for a session with no slot yet', () => {
    expect(sessionTag(null)).toBe('');
  });
});

describe('agentTag', () => {
  it("is the session's letter in lower case and the subagent's number", () => {
    expect(agentTag(0, 1)).toBe('a1');
    expect(agentTag(1, 2)).toBe('b2');
    expect(agentTag(26, 12)).toBe('aa12');
  });

  it('is empty when either the slot or the number is missing', () => {
    expect(agentTag(null, 1)).toBe('');
    expect(agentTag(0, null)).toBe('');
    expect(agentTag(null, null)).toBe('');
  });
});

describe('familyVar', () => {
  it('names one of six family hues by slot, repeating past six, with slot 0 for none', () => {
    expect(FAMILY_COUNT).toBe(6);
    expect([0, 1, 5].map(familyVar)).toEqual(['var(--family-0)', 'var(--family-1)', 'var(--family-5)']);
    expect([6, 13].map(familyVar)).toEqual(['var(--family-0)', 'var(--family-1)']);
    expect(familyVar(null)).toBe('var(--family-0)');
  });

  it('has each hue in the stylesheet, day in :root and night in the dark block: teal, clay, green, rose, brown, indigo', () => {
    const css = readFileSync('web/src/styles.css', 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
    const day = /:root\s*\{([^}]*)\}/.exec(css)?.[1] ?? '';
    const night = /@media \(prefers-color-scheme: dark\)\s*\{\s*:root\s*\{([^}]*)\}/.exec(css)?.[1] ?? '';
    const hues = [
      ['#0b6b7d', '#3cc3d6'],
      ['#b4532f', '#e8956f'],
      ['#287a3a', '#7ad68f'],
      ['#b0204f', '#f27aa5'],
      ['#85593a', '#d4a574'],
      ['#4f4dc4', '#9a98ff'],
    ];
    hues.forEach(([dayHue, nightHue], slot) => {
      expect(day, `slot ${slot} by day`).toContain(`--family-${slot}: ${dayHue};`);
      expect(night, `slot ${slot} by night`).toContain(`--family-${slot}: ${nightHue};`);
    });
  });
});
