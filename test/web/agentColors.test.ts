import { describe, expect, it } from 'vitest';
import { AGENT_COLORS, assignSlots } from '../../web/src/agentColors';

const SIZE = AGENT_COLORS.length;

describe('assignSlots', () => {
  it('gives subagents seen together different slots while there are slots to go round', () => {
    const keys = Array.from({ length: SIZE }, (_, i) => `s1:agent-${i}`);
    const slots = assignSlots(new Map(), keys);
    expect([...slots.keys()]).toEqual(keys);
    expect(new Set(slots.values()).size).toBe(SIZE);
    for (const s of slots.values()) expect(s >= 0 && s < SIZE).toBe(true);
  });

  it('keeps the slot a subagent already has, whatever else comes or goes', () => {
    const before = new Map([['s1:a', 3], ['s1:b', 0]]);
    const after = assignSlots(before, ['s1:b', 's1:c']);
    expect(after.get('s1:b')).toBe(0);
    expect(after.has('s1:a')).toBe(false);
    expect(after.get('s1:c')).not.toBe(0);
  });

  it('gives a newcomer the one slot still free', () => {
    const taken = new Map(Array.from({ length: SIZE - 1 }, (_, i) => [`s1:old-${i}`, i] as [string, number]));
    const after = assignSlots(taken, [...taken.keys(), 's1:new']);
    expect(after.get('s1:new')).toBe(SIZE - 1);
  });

  it('shares slots only when there are more subagents than slots, and gives the same answer every time', () => {
    const keys = Array.from({ length: SIZE + 2 }, (_, i) => `s2:agent-${i}`);
    const slots = assignSlots(new Map(), keys);
    expect(slots.size).toBe(SIZE + 2);
    expect(new Set(slots.values()).size).toBe(SIZE);
    expect(assignSlots(new Map(), keys)).toEqual(slots);
  });
});
