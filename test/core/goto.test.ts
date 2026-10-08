import { describe, expect, it } from 'vitest';
import { GOTO_MAX_WORDS, parseGoTo } from '../../src/core/goto';

describe('parseGoTo', () => {
  it('reads "#77", "77" and either with spaces round it as an id', () => {
    for (const text of ['#77', '77', ' #77 ', '\t77\n', '#077']) expect(parseGoTo(text), JSON.stringify(text)).toEqual({ kind: 'id', id: 77 });
  });

  it('reads anything else as words, split on spaces', () => {
    expect(parseGoTo('signing')).toEqual({ kind: 'words', words: ['signing'] });
    expect(parseGoTo('  play   app\tsigning ')).toEqual({ kind: 'words', words: ['play', 'app', 'signing'] });
    expect(parseGoTo('#77 signing')).toEqual({ kind: 'words', words: ['#77', 'signing'] });
    expect(parseGoTo('# 77')).toEqual({ kind: 'words', words: ['#', '77'] });
    expect(parseGoTo('77a')).toEqual({ kind: 'words', words: ['77a'] });
    expect(parseGoTo('-77')).toEqual({ kind: 'words', words: ['-77'] });
    expect(parseGoTo('#')).toEqual({ kind: 'words', words: ['#'] });
  });

  it('reads nothing but spaces as empty', () => {
    for (const text of ['', ' ', '\t \n']) expect(parseGoTo(text)).toEqual({ kind: 'empty' });
  });

  it(`keeps the first ${GOTO_MAX_WORDS} words of a longer query`, () => {
    const words = Array.from({ length: GOTO_MAX_WORDS + 3 }, (_, i) => `w${i}`);
    expect(parseGoTo(words.join(' '))).toEqual({ kind: 'words', words: words.slice(0, GOTO_MAX_WORDS) });
  });

  it('reads an id too long to be one as an id all the same, which finds nothing', () => {
    const q = parseGoTo('#123456789012345678901');
    expect(q.kind).toBe('id');
    expect(q.kind === 'id' && Number.isSafeInteger(q.id)).toBe(false);
  });
});
