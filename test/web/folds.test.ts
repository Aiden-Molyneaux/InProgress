import { describe, expect, it } from 'vitest';
import { withFold } from '../../web/src/folds';

describe('withFold', () => {
  it('sets the override without changing the one it was given', () => {
    const cur = { 'n:4': 'open' as const };
    expect(withFold(cur, 'done:7', 'open')).toEqual({ 'n:4': 'open', 'done:7': 'open' });
    expect(cur).toEqual({ 'n:4': 'open' });
  });

  it('folding a node closes its "+n more" tail and its "✓ n done" runs again', () => {
    const cur = { 'more:7': 'open' as const, 'done:7': 'open' as const, 'more:8': 'open' as const, 'done:8': 'open' as const };
    expect(withFold(cur, 'n:7', 'closed')).toEqual({ 'n:7': 'closed', 'more:8': 'open', 'done:8': 'open' });
  });

  it('unfolding a node leaves its runs as they were', () => {
    const cur = { 'n:7': 'closed' as const, 'done:7': 'open' as const };
    expect(withFold(cur, 'n:7', 'open')).toEqual({ 'n:7': 'open', 'done:7': 'open' });
  });
});
