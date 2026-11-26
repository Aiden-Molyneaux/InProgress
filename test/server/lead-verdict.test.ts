import { describe, expect, it } from 'vitest';
import { parseVerdict } from '../../src/server/lead/verdict';

const answer = (verdict: string, kind: string, ans = 'Use port 4410.', why = 'It is free.') => `${verdict}\nKIND: ${kind}\nANSWER: ${ans}\nWHY: ${why}`;

describe('parseVerdict', () => {
  it.each([
    ['DECIDE', 'PRODUCT'],
    ['DECIDE', 'TECHNICAL'],
    ['AIDEN', 'TASTE'],
    ['AIDEN', 'DIRECTION'],
    ['AIDEN', 'CANNOT-BE-TAKEN-BACK'],
    ['CARD', 'NONE'],
  ])('accepts %s with KIND %s', (verdict, kind) => {
    expect(parseVerdict(answer(verdict, kind))).toEqual({ ok: true, value: { verdict, kind, answer: 'Use port 4410.', why: 'It is free.' } });
  });

  it.each([
    ['DECIDE', 'NONE'],
    ['DECIDE', 'TASTE'],
    ['AIDEN', 'TECHNICAL'],
    ['AIDEN', 'NONE'],
    ['CARD', 'PRODUCT'],
    ['CARD', ''],
  ])('refuses %s with KIND %s, naming the kinds it allows', (verdict, kind) => {
    const r = parseVerdict(answer(verdict, kind));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toContain(`for ${verdict}`);
  });

  it('reads only the last four non-empty lines: text before them and blank lines between are ignored', () => {
    const text = `I looked at step #12 and the branch.\n\nIt is merged.\n\n${answer('DECIDE', 'TECHNICAL').replace(/\n/g, '\n\n')}\n\n`;
    expect(parseVerdict(text)).toMatchObject({ ok: true, value: { verdict: 'DECIDE', kind: 'TECHNICAL' } });
    expect(parseVerdict(answer('CARD', 'NONE').replace(/\n/g, '\r\n'))).toMatchObject({ ok: true, value: { verdict: 'CARD' } });
  });

  it('refuses a missing line', () => {
    expect(parseVerdict('DECIDE\nKIND: TECHNICAL\nANSWER: Yes.')).toEqual({ ok: false, reason: 'the answer has 3 non-empty lines, not four' });
    // With text before, a missing WHY shifts the lines: the verdict line is no verdict.
    expect(parseVerdict('Looked.\nDECIDE\nKIND: TECHNICAL\nANSWER: Yes.')).toMatchObject({ ok: false, reason: expect.stringContaining('verdict line is "Looked."') });
    expect(parseVerdict('DECIDE\nKIND: TECHNICAL\nANSWER: Yes.\nWHY:')).toMatchObject({ ok: false, reason: expect.stringContaining('fourth line') });
    expect(parseVerdict('DECIDE\nKIND: TECHNICAL\nANSWER:\nWHY: Because.')).toMatchObject({ ok: false, reason: expect.stringContaining('third line') });
    expect(parseVerdict('DECIDE\nTECHNICAL\nANSWER: Yes.\nWHY: Because.')).toMatchObject({ ok: false, reason: expect.stringContaining('second line') });
  });

  it('refuses a lowercase or otherwise unknown verdict', () => {
    expect(parseVerdict(answer('decide', 'TECHNICAL'))).toMatchObject({ ok: false, reason: expect.stringContaining('"decide", not DECIDE, AIDEN or CARD') });
    expect(parseVerdict(answer('Aiden', 'TASTE')).ok).toBe(false);
    expect(parseVerdict(answer('toString', 'NONE')).ok).toBe(false);
    expect(parseVerdict(answer('DECIDE', 'technical')).ok).toBe(false);
  });
  it('reads a numbered verdict line, or the verdict after a colon, as the exam turns wrote them; still one word or nothing', () => {
    const numbered = parseVerdict(answer('1. CARD', 'NONE'));
    expect(numbered.ok && numbered.value.verdict).toBe('CARD');
    const restated = parseVerdict(answer('DECIDE or AIDEN or CARD: AIDEN', 'TASTE'));
    expect(restated.ok && restated.value.verdict).toBe('AIDEN');
    expect(parseVerdict(answer('DECIDE or AIDEN', 'TASTE')).ok).toBe(false);
    expect(parseVerdict(answer('VERDICT: DECIDE or AIDEN', 'TASTE')).ok).toBe(false);
    expect(parseVerdict(answer('1. aiden', 'TASTE')).ok).toBe(false);
  });
});
