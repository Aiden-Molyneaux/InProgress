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

  it('has each hue defined in the stylesheet: session clay first, then the five old subagent colours', () => {
    const css = readFileSync('web/src/styles.css', 'utf8');
    const hues = ['var(--clay)', '#5856d6', '#0b7285', '#c2255c', '#8c6239', '#5c7a00'];
    hues.forEach((hue, slot) => expect(css).toContain(`--family-${slot}: ${hue};`));
  });
});
