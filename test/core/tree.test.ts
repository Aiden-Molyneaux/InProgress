import { describe, expect, it } from 'vitest';
import type { TreeNode } from '../../src/core/types';
import { ancestors, buildIndex, computeVisible, countDone, isNeedsYou, pinnedIds, progress, renderOutline } from '../../src/core/tree';
import type { VisibleItem } from '../../src/core/tree';

let nextId = 1;
function n(parentId: number | null, title: string, extra: Partial<TreeNode> = {}): TreeNode {
  const id = extra.id ?? nextId++;
  return { id, projectId: 1, parentId, position: id, kind: parentId === null ? 'goal' : 'task', title, body: '', status: 'todo', assignee: 'claude', outcome: '', createdAt: 't', updatedAt: 't', completedAt: null, ...extra };
}

function sample() {
  nextId = 1;
  const root = n(null, 'InGame', { status: 'active' });
  const m = n(root.id, 'M1-M6 build', { status: 'done', kind: 'phase' });
  const m1 = n(m.id, 'M1', { status: 'done' });
  const m2 = n(m.id, 'M2', { status: 'done' });
  const road = n(root.id, 'Road to market', { status: 'active', kind: 'phase' });
  const s1 = n(road.id, '1 iOS certificate', { status: 'done' });
  const s2 = n(road.id, '2 Android signing', { status: 'active' });
  const a1 = n(s2.id, 'Upload keystore', { status: 'done' });
  const a2 = n(s2.id, 'Play app signing', { status: 'active' });
  const a3 = n(s2.id, 'Run signing tests', { assignee: 'me' });
  const s3 = n(road.id, '3 RevenueCat');
  const s4 = n(road.id, '4 Build to GitHub');
  const s5 = n(road.id, '5 Store listing');
  const s6 = n(road.id, '6 Beta');
  const s7 = n(road.id, '7 Launch');
  const nodes = [root, m, m1, m2, road, s1, s2, a1, a2, a3, s3, s4, s5, s6, s7];
  return { nodes, root, m, road, s1, s2, a1, a2, a3, s3, s4, s5, s6, s7 };
}

const label = (i: VisibleItem): string => (i.type === 'node' ? i.node.title : `+${i.hiddenIds.length} more`);

describe('derived stats', () => {
  it('computes needs-you, progress, done counts and ancestors', () => {
    const t = sample();
    const index = buildIndex(t.nodes);
    expect(isNeedsYou(t.a3)).toBe(true);
    expect(isNeedsYou({ ...t.a3, status: 'done' })).toBe(false);
    expect(progress(index, t.road.id)).toEqual({ done: 1, total: 7 });
    expect(progress(index, t.a1.id)).toBeNull();
    expect(countDone(index, t.m.id)).toBe(2);
    expect(ancestors(index, t.a2.id).map((x) => x.title)).toEqual(['InGame', 'Road to market', '2 Android signing']);
  });

  it('pins active nodes, needs-you nodes and session focus, with their ancestors', () => {
    const t = sample();
    const index = buildIndex(t.nodes);
    const pinned = pinnedIds(index, [{ focusNodeId: t.s6.id, state: 'idle' }, { focusNodeId: t.s7.id, state: 'ended' }]);
    expect(pinned.has(t.a3.id)).toBe(true);
    expect(pinned.has(t.road.id)).toBe(true);
    expect(pinned.has(t.s6.id)).toBe(true);
    expect(pinned.has(t.s7.id)).toBe(false);
    expect(pinned.has(t.m.id)).toBe(false);
  });
});

describe('computeVisible', () => {
  it('folds done branches and hides the far todo tail', () => {
    const t = sample();
    const items = computeVisible(buildIndex(t.nodes), []);
    const titles = items.map((i) => (i.type === 'node' ? `${i.node.title}${i.folded ? ' [folded]' : ''}` : `+${i.hiddenIds.length} more`));
    expect(titles).toEqual([
      'InGame', 'M1-M6 build [folded]', 'Road to market', '1 iOS certificate', '2 Android signing',
      'Upload keystore', 'Play app signing', 'Run signing tests', '3 RevenueCat', '4 Build to GitHub', '+3 more',
    ]);
  });

  it('splits hidden runs around a pinned node', () => {
    const t = sample();
    const nodes = t.nodes.map((x) => (x.id === t.s6.id ? { ...x, assignee: 'me' as const } : x));
    const items = computeVisible(buildIndex(nodes), []);
    const tail = items.slice(-4).map((i) => (i.type === 'node' ? i.node.title : `+${i.hiddenIds.length} more`));
    expect(tail).toEqual(['4 Build to GitHub', '+1 more', '6 Beta', '+1 more']);
  });

  it('does not hide a single leftover node', () => {
    const t = sample();
    const nodes = t.nodes.filter((x) => x.id !== t.s6.id && x.id !== t.s7.id);
    const items = computeVisible(buildIndex(nodes), []);
    expect(items.some((i) => i.type === 'more')).toBe(false);
  });

  it('honours manual overrides and noFold', () => {
    const t = sample();
    const index = buildIndex(t.nodes);
    const opened = computeVisible(index, [], { overrides: { [`n:${t.m.id}`]: 'open', [`more:${t.road.id}`]: 'open' } });
    expect(opened.filter((i) => i.type === 'node')).toHaveLength(15);
    const closed = computeVisible(index, [], { overrides: { [`n:${t.s2.id}`]: 'closed' } });
    expect(closed.find((i) => i.type === 'node' && i.node.id === t.s2.id)).toMatchObject({ folded: true });
    expect(computeVisible(index, [], { noFold: true }).filter((i) => i.type === 'node')).toHaveLength(15);
  });

  it('keeps a done branch open while it holds a needs-you node', () => {
    const t = sample();
    const signOff = n(t.m.id, 'Sign off M6', { assignee: 'me' });
    const items = computeVisible(buildIndex([...t.nodes, signOff]), []);
    expect(items.find((i) => i.type === 'node' && i.node.id === t.m.id)).toMatchObject({ folded: false });
    expect(items.slice(1, 5).map(label)).toEqual(['M1-M6 build', 'M1', 'M2', 'Sign off M6']);
  });

  it('never hides a tail node that has active work under it', () => {
    const t = sample();
    const checklist = n(t.s7.id, 'Launch checklist', { status: 'active' });
    const items = computeVisible(buildIndex([...t.nodes, checklist]), []);
    expect(items.slice(-4).map(label)).toEqual(['4 Build to GitHub', '+2 more', '7 Launch', 'Launch checklist']);
    expect(items.filter((i) => i.type === 'more')).toMatchObject([{ hiddenIds: [t.s5.id, t.s6.id] }]);
  });

  it('keeps a live session focus open and folds it once the session ends', () => {
    const t = sample();
    const index = buildIndex(t.nodes);
    const mWhen = (state: 'idle' | 'ended') =>
      computeVisible(index, [{ focusNodeId: t.m.id, state }]).find((i) => i.type === 'node' && i.node.id === t.m.id);
    expect(mWhen('idle')).toMatchObject({ folded: false });
    expect(mWhen('ended')).toMatchObject({ folded: true });
  });

  it('orders siblings by position, not id', () => {
    nextId = 1;
    const p = n(null, 'P', { status: 'active' });
    const inIdOrder = [n(p.id, 'c', { position: 3 }), n(p.id, 'b', { position: 2 }), n(p.id, 'a', { position: 1 })];
    const items = computeVisible(buildIndex([p, ...inIdOrder]), []);
    expect(items.map(label)).toEqual(['P', 'a', 'b', 'c']);
  });

  it('hides unpinned dropped children after the frontier along with the far todo tail', () => {
    nextId = 1;
    const p = n(null, 'P', { status: 'active' });
    const frontier = n(p.id, 'frontier', { status: 'active' });
    const [t1, t2, t3] = [n(p.id, 't1'), n(p.id, 't2'), n(p.id, 't3')];
    const dropped = n(p.id, 'dropped', { status: 'dropped' });
    const t4 = n(p.id, 't4');
    const items = computeVisible(buildIndex([p, frontier, t1, t2, t3, dropped, t4]), []);
    expect(items.map(label)).toEqual(['P', 'frontier', 't1', 't2', '+3 more']);
    expect(items[4]).toMatchObject({ type: 'more', parentId: p.id, hiddenIds: [t3.id, dropped.id, t4.id] });
  });

  it('never spends one of the two visible slots on a pinned child', () => {
    nextId = 1;
    const p = n(null, 'P', { status: 'active' });
    const children = [n(p.id, 'frontier', { status: 'active' }), n(p.id, 'Y', { assignee: 'me' }), n(p.id, 't1'), n(p.id, 't2'), n(p.id, 't3')];
    expect(computeVisible(buildIndex([p, ...children]), []).map(label)).toEqual(['P', 'frontier', 'Y', 't1', 't2', 't3']);
  });
});

describe('renderOutline', () => {
  it('renders ids, statuses, needs-you, progress, resources and folds', () => {
    const t = sample();
    const text = renderOutline(buildIndex(t.nodes), [], { resourcesByNode: new Map([[t.a3.id, [12]]]) });
    expect(text.split('\n')).toEqual([
      `#${t.root.id} InGame — active (1/2)`,
      `  #${t.m.id} M1-M6 build (phase) — done (2/2) · 2 done inside (folded)`,
      `  #${t.road.id} Road to market (phase) — active (1/7)`,
      `    #${t.s1.id} 1 iOS certificate — done`,
      `    #${t.s2.id} 2 Android signing — active (1/3)`,
      `      #${t.a1.id} Upload keystore — done`,
      `      #${t.a2.id} Play app signing — active`,
      `      #${t.a3.id} Run signing tests — NEEDS YOU [r12]`,
      `    #${t.s3.id} 3 RevenueCat — todo`,
      `    #${t.s4.id} 4 Build to GitHub — todo`,
      `    +3 more: #${t.s5.id}, #${t.s6.id}, #${t.s7.id}`,
    ]);
  });
});
