import { describe, expect, it } from 'vitest';
import { scrollToShow, tabStep } from '../../web/src/parts/tabStripLogic';

describe('tabStep', () => {
  it('moves right and left, wrapping round at either end', () => {
    expect(tabStep('ArrowRight', 0, 3)).toBe(1);
    expect(tabStep('ArrowRight', 2, 3)).toBe(0);
    expect(tabStep('ArrowLeft', 1, 3)).toBe(0);
    expect(tabStep('ArrowLeft', 0, 3)).toBe(2);
  });

  it('goes to the first and the last tab on Home and End', () => {
    expect(tabStep('Home', 2, 4)).toBe(0);
    expect(tabStep('End', 0, 4)).toBe(3);
  });

  it('starts at either end when no tab has focus', () => {
    expect(tabStep('ArrowRight', -1, 3)).toBe(0);
    expect(tabStep('ArrowLeft', -1, 3)).toBe(2);
  });

  it('leaves every other key, and an empty strip, alone', () => {
    expect(tabStep('ArrowDown', 0, 3)).toBeNull();
    expect(tabStep('a', 0, 3)).toBeNull();
    expect(tabStep('ArrowRight', 0, 0)).toBeNull();
    expect(tabStep('Home', -1, 0)).toBeNull();
  });
});

describe('scrollToShow', () => {
  it('keeps the scroll when the item is already in view', () => {
    expect(scrollToShow(120, 60, 100, 200)).toBe(100);
    expect(scrollToShow(100, 200, 100, 300)).toBe(100);
  });

  it('scrolls left just far enough to show an item cut off on the left', () => {
    expect(scrollToShow(40, 60, 100, 200)).toBe(40);
  });

  it('scrolls right just far enough to show an item cut off on the right', () => {
    expect(scrollToShow(320, 60, 100, 200)).toBe(180);
  });

  it('lines up the left edge of an item wider than the view', () => {
    expect(scrollToShow(300, 400, 0, 200)).toBe(300);
    expect(scrollToShow(10, 400, 250, 200)).toBe(10);
  });
});
