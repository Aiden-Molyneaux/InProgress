import { describe, expect, it } from 'vitest';
import { STEP_TITLE_MAX, stepRef } from '../../src/core/step-ref';

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
});
