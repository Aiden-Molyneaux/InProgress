import { describe, expect, it } from 'vitest';
import type { SubagentInfo } from '../../src/core/types';
import { CHIP_KIN, chipKin, chipOrder } from '../../web/src/chrome/chips';

const session = (id: string, slot: number | null) => ({ id, slot });
const ids = (list: { id: string }[]) => list.map((s) => s.id);

describe('chipOrder', () => {
  it('puts the chips in letter order, whatever order the server lists them in', () => {
    // The server lists the session seen last first.
    expect(ids(chipOrder([session('c', 2), session('a', 0), session('b', 1)]))).toEqual(['a', 'b', 'c']);
  });

  it('puts a session with no slot yet after the lettered ones, in the order it was given', () => {
    expect(ids(chipOrder([session('x', null), session('b', 1), session('y', null), session('a', 0)]))).toEqual(['a', 'b', 'x', 'y']);
  });

  it('leaves the list it was given as it was', () => {
    const given = [session('b', 1), session('a', 0)];
    chipOrder(given);
    expect(ids(given)).toEqual(['b', 'a']);
  });
});

describe('chipKin', () => {
  const ENDED = '2026-10-07T12:00:00Z';
  const agent = (agentId: string, extra: Partial<SubagentInfo> = {}): SubagentInfo => ({
    agentId, agentType: 'general-purpose', startedAt: '2026-10-07T11:00:00Z', runStartedAt: '2026-10-07T11:00:00Z', description: null, model: null, nodeId: null, endedAt: null,
    ordinal: null, purpose: null, endReason: null, lastActiveAt: null, ...extra,
  });
  const agentIds = (kin: { shown: SubagentInfo[] }) => kin.shown.map((a) => a.agentId);

  it('draws one kin per running worker, and no +n while they fit', () => {
    expect(chipKin([agent('w1'), agent('w2')])).toEqual({ shown: [agent('w1'), agent('w2')], more: 0 });
  });

  it('draws none for a session with no subagents', () => {
    expect(chipKin([])).toEqual({ shown: [], more: 0 });
  });

  it('leaves out readers, running or not, as the cards do', () => {
    const kin = chipKin([agent('r1', { agentType: 'Explore' }), agent('w1'), agent('r2', { agentType: 'Plan' }), agent('r3', { agentType: 'claude-code-guide' })]);
    expect(agentIds(kin)).toEqual(['w1']);
    expect(kin.more).toBe(0);
  });

  it('leaves out a worker that has stopped, however it stopped: cleanly, at the usage limit, or otherwise', () => {
    const kin = chipKin([
      agent('done', { endedAt: ENDED }),
      agent('limit', { endedAt: ENDED, endReason: 'limit' }),
      agent('w1'),
      agent('killed', { endedAt: ENDED, endReason: 'killed' }),
      agent('silent', { endedAt: ENDED, endReason: 'silent' }),
    ]);
    expect(agentIds(kin)).toEqual(['w1']);
    expect(kin.more).toBe(0);
  });

  it(`draws at most ${CHIP_KIN} kin, and counts the rest in +n`, () => {
    expect(CHIP_KIN).toBe(3);
    const three = chipKin([agent('w1'), agent('w2'), agent('w3')]);
    expect(agentIds(three)).toEqual(['w1', 'w2', 'w3']);
    expect(three.more).toBe(0);
    const four = chipKin([agent('w1'), agent('w2'), agent('w3'), agent('w4')]);
    expect(agentIds(four)).toEqual(['w1', 'w2', 'w3']);
    expect(four.more).toBe(1);
    const six = chipKin(['w1', 'w2', 'w3', 'w4', 'w5', 'w6'].map((id) => agent(id)));
    expect(agentIds(six)).toEqual(['w1', 'w2', 'w3']);
    expect(six.more).toBe(3);
  });

  it('counts only running workers in +n: readers and stopped workers past the cap add nothing', () => {
    const kin = chipKin([agent('w1'), agent('w2'), agent('w3'), agent('r1', { agentType: 'Explore' }), agent('done', { endedAt: ENDED }), agent('w4')]);
    expect(agentIds(kin)).toEqual(['w1', 'w2', 'w3']);
    expect(kin.more).toBe(1);
  });

  it("keeps the session's order (by start), so a kin stays in its place while the others come and go", () => {
    expect(agentIds(chipKin([agent('w2'), agent('w1'), agent('w3')]))).toEqual(['w2', 'w1', 'w3']);
    // The first stops: the next two keep their order and a fourth moves up into view.
    const before = chipKin([agent('w1'), agent('w2'), agent('w3'), agent('w4')]);
    const after = chipKin([agent('w1', { endedAt: ENDED }), agent('w2'), agent('w3'), agent('w4')]);
    expect(agentIds(before)).toEqual(['w1', 'w2', 'w3']);
    expect(agentIds(after)).toEqual(['w2', 'w3', 'w4']);
    expect(after.more).toBe(0);
  });

  it('leaves the list it was given as it was', () => {
    const given = [agent('w1', { endedAt: ENDED }), agent('w2'), agent('r1', { agentType: 'Explore' })];
    const copy = structuredClone(given);
    chipKin(given);
    expect(given).toEqual(copy);
  });
});
