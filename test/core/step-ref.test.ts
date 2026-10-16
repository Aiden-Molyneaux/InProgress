import { describe, expect, it } from 'vitest';
import { STEP_TITLE_MAX, clipLine, stepRef } from '../../src/core/step-ref';

describe('stepRef', () => {
  it('names a step by its id and title', () => {
    expect(stepRef(42, 'Fix the export')).toBe('#42 Fix the export');
  });

  it('prints the bare id when the title is unknown or blank', () => {
    expect(stepRef(42, undefined)).toBe('#42');
    expect(stepRef(42, '  \n ')).toBe('#42');
  });

  it('flattens a multi-line title to one line and clips it to the limit', () => {
    const title = `Show each task's title\nnext to its id,   in agent text and a status line`;
    const ref = stepRef(440, title);
    expect(ref).not.toMatch(/\n/);
    expect(ref).toBe(`#440 ${"Show each task's title next to its id, in agent t"}…`);
    expect(ref.length - '#440 '.length).toBe(STEP_TITLE_MAX);
    expect(stepRef(440, title, 20)).toBe("#440 Show each task's ti…");
  });

  it('keeps a title exactly at the limit whole', () => {
    const title = 'x'.repeat(STEP_TITLE_MAX);
    expect(stepRef(1, title)).toBe(`#1 ${title}`);
  });

  it('never splits an emoji that straddles the cut', () => {
    // 48 units of x, then a two-unit emoji at units 48 and 49: a cut at 49 would keep its high half alone.
    const ref = stepRef(1, `${'x'.repeat(48)}\u{1F600} and more`);
    expect(ref).toBe(`#1 ${'x'.repeat(48)}…`);
    expect(ref).not.toMatch(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/);
  });
});

describe('clipLine', () => {
  it('flattens, trims and keeps text within the limit whole', () => {
    expect(clipLine('  a\n  b ', 10)).toBe('a b');
  });

  it('keeps an emoji that ends just before the cut whole', () => {
    expect(clipLine('ab\u{1F600}cdef', 5)).toBe('ab\u{1F600}…');
  });

  it('drops an emoji the cut would split, so no lone surrogate is left', () => {
    expect(clipLine('abc\u{1F600}def', 5)).toBe('abc…');
  });
});
