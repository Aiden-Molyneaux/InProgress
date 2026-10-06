import { describe, expect, it } from 'vitest';
import { menuStep } from '../../web/src/chrome/menu';

describe('menuStep', () => {
  it('moves down and up through the items, wrapping round at either end', () => {
    expect(menuStep('ArrowDown', 0, 3)).toBe(1);
    expect(menuStep('ArrowDown', 2, 3)).toBe(0);
    expect(menuStep('ArrowUp', 1, 3)).toBe(0);
    expect(menuStep('ArrowUp', 0, 3)).toBe(2);
  });

  it('goes to the first and the last item on Home and End', () => {
    expect(menuStep('Home', 2, 3)).toBe(0);
    expect(menuStep('End', 0, 3)).toBe(2);
  });

  it('starts from the first item going down, or the last going up, when none has focus', () => {
    expect(menuStep('ArrowDown', -1, 3)).toBe(0);
    expect(menuStep('ArrowUp', -1, 3)).toBe(2);
  });

  it('leaves every other key alone, and has nowhere to go without items', () => {
    expect(menuStep('Enter', 0, 3)).toBeNull();
    expect(menuStep('ArrowLeft', 0, 3)).toBeNull();
    expect(menuStep('ArrowDown', -1, 0)).toBeNull();
  });
});
