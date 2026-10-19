import { describe, expect, it } from 'vitest';
import { countRose } from '../../web/src/parts/countLogic';

describe('countRose', () => {
  it('is false for the first value, whatever it is', () => {
    expect(countRose(undefined, 0)).toBe(false);
    expect(countRose(undefined, 5)).toBe(false);
  });

  it('is true only when the count went up', () => {
    expect(countRose(2, 3)).toBe(true);
    expect(countRose(0, 1)).toBe(true);
  });

  it('is false when the count stayed or fell', () => {
    expect(countRose(3, 3)).toBe(false);
    expect(countRose(3, 2)).toBe(false);
  });
});
