import { describe, expect, it } from 'vitest';
import { DELETED_RETENTION_MS } from '../../src/core/types';
import { daysLeft, daysLeftLabel } from '../../web/src/time';

const day = 24 * 60 * 60 * 1000;
const now = Date.parse('2026-10-06T12:00:00Z');
const at = (ms: number) => new Date(ms).toISOString();

describe('daysLeft', () => {
  it('is 30 right after a delete', () => {
    expect(daysLeft(at(now + DELETED_RETENTION_MS), now)).toBe(30);
    expect(daysLeft(at(now + DELETED_RETENTION_MS), now + 1000)).toBe(30);
  });

  it('counts a part day as a day, so the last day says 1', () => {
    expect(daysLeft(at(now + 29 * day + 1), now)).toBe(30);
    expect(daysLeft(at(now + 29 * day), now)).toBe(29);
    expect(daysLeft(at(now + 5 * 60 * 60 * 1000), now)).toBe(1);
    expect(daysLeft(at(now + 1), now)).toBe(1);
  });

  it('never goes below 0', () => {
    expect(daysLeft(at(now), now)).toBe(0);
    expect(daysLeft(at(now - 3 * day), now)).toBe(0);
  });
});

describe('daysLeftLabel', () => {
  it('says how many days are left, singular for one', () => {
    expect(daysLeftLabel(at(now + DELETED_RETENTION_MS), now)).toBe('30 days left');
    expect(daysLeftLabel(at(now + 2 * day), now)).toBe('2 days left');
    expect(daysLeftLabel(at(now + 60 * 1000), now)).toBe('1 day left');
    expect(daysLeftLabel(at(now - day), now)).toBe('0 days left');
  });
});
