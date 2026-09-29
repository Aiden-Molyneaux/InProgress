import { describe, expect, it } from 'vitest';
import { globMatch } from '../../src/lib/glob';

describe('globMatch', () => {
  it('matches * anywhere, case-insensitively', () => {
    expect(globMatch('*VCAD-978*', 'feature/VCAD-978-fix')).toBe(true);
    expect(globMatch('*vcad-978*', 'feature/VCAD-978')).toBe(true);
    expect(globMatch('release/*', 'release/1.2')).toBe(true);
  });
  it('anchors the whole value', () => {
    expect(globMatch('main', 'main2')).toBe(false);
  });
  it('treats regex characters literally and ? as one character', () => {
    expect(globMatch('v1.2', 'v1x2')).toBe(false);
    expect(globMatch('v?.2', 'v1.2')).toBe(true);
    expect(globMatch('(a|b)+[c]', '(a|b)+[c]')).toBe(true);
    expect(globMatch('v?.2', 'v.2')).toBe(false);
  });
  it('matches runs of * like a single *', () => {
    expect(globMatch('a**b', 'ab')).toBe(true);
    expect(globMatch('feature/***VCAD***', 'feature/x-vcad-978')).toBe(true);
    expect(globMatch('feature/***VCAD***', 'bugfix/VCAD-978')).toBe(false);
    expect(globMatch('**', '')).toBe(true);
    expect(globMatch('a*', '')).toBe(false);
  });
  it('never matches a pattern longer than 200 characters', () => {
    expect(globMatch('*'.repeat(201), 'anything')).toBe(false);
    expect(globMatch('x'.repeat(200), 'x'.repeat(200))).toBe(true);
  });
  it('answers pathological patterns at once instead of backtracking', () => {
    let started = performance.now();
    expect(globMatch(`${'*a'.repeat(8)}*b`, 'a'.repeat(30))).toBe(false);
    // Checked before the bigger case, which a backtracking matcher would never finish.
    expect(performance.now() - started).toBeLessThan(50);
    started = performance.now();
    // The longest allowed pattern against a branch as long as the hook body allows.
    expect(globMatch(`${'*a'.repeat(99)}*b`, 'a'.repeat(300))).toBe(false);
    expect(globMatch(`${'*a'.repeat(99)}*`, 'a'.repeat(300))).toBe(true);
    expect(performance.now() - started).toBeLessThan(50);
  });
});
