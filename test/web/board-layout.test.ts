import { describe, expect, it } from 'vitest';
import { layoutFor } from '../../web/src/board/layout';

describe('layoutFor', () => {
  it('is four columns from 1160 up', () => {
    expect(layoutFor(1160)).toBe('four');
    expect(layoutFor(1600)).toBe('four');
  });
  it('is two by two from 720 to 1159', () => {
    expect(layoutFor(1159)).toBe('two');
    expect(layoutFor(900)).toBe('two');
    expect(layoutFor(720)).toBe('two');
  });
  it('is one column under 720', () => {
    expect(layoutFor(719)).toBe('one');
    expect(layoutFor(400)).toBe('one');
  });
  it('counts width 0, before the first measure, as four', () => {
    expect(layoutFor(0)).toBe('four');
  });
});
