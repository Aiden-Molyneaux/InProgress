import { describe, expect, it } from 'vitest';
import { layoutOutline } from '../../src/core/layout';
import { ancestors, buildIndex, type FoldOverrides } from '../../src/core/tree';
import type { TreeNode } from '../../src/core/types';
import { revealKeys, withFold } from '../../web/src/folds';

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

const NOW = Date.parse('2026-10-07T12:00:00Z');
const OLD = '2026-10-01T12:00:00Z';
let nextId = 1;
function n(parentId: number | null, title: string, extra: Partial<TreeNode> = {}): TreeNode {
  const id = nextId++;
  return { id, projectId: 1, parentId, position: id, kind: parentId === null ? 'goal' : 'task', title, body: '', status: 'todo', assignee: 'claude', outcome: '', label: null, createdAt: OLD, updatedAt: OLD, completedAt: null, ...extra };
}
const done = (parentId: number, title: string) => n(parentId, title, { status: 'done', completedAt: OLD });

/** What revealKeys opens to show `target` in `nodes` under `overrides`, and whether the layout then shows it. */
function reveal(nodes: TreeNode[], target: TreeNode, overrides: FoldOverrides = {}) {
  const index = buildIndex(nodes);
  const layoutWith = (o: FoldOverrides) => layoutOutline({ nodes, resources: [], sessions: [], overrides: o, now: NOW });
  const keys = revealKeys([...ancestors(index, target.id).map((a) => a.id), target.id], overrides, layoutWith);
  const opened = keys.reduce<FoldOverrides>((o, k) => withFold(o, k, 'open'), overrides);
  return { keys, shown: layoutWith(opened).nodeItems.has(target.id), before: layoutWith(overrides).nodeItems.has(target.id) };
}

describe('revealKeys', () => {
  it('opens nothing for a step that already shows', () => {
    nextId = 1;
    const root = n(null, 'Root', { status: 'active' });
    const a = n(root.id, 'A', { status: 'active' });
    expect(reveal([root, a], a)).toEqual({ keys: [], shown: true, before: true });
  });

  it('unfolds a finished ancestor that folds on its own, and one folded by hand', () => {
    nextId = 1;
    const root = n(null, 'Root', { status: 'active' });
    const a = done(root.id, 'A');
    const a1 = done(a.id, 'A1');
    const b = n(root.id, 'B', { status: 'active' });
    const b1 = n(b.id, 'B1');
    const b2 = n(b1.id, 'B2');
    const nodes = [root, a, a1, b, b1, b2];
    expect(reveal(nodes, a1)).toEqual({ keys: [`n:${a.id}`], shown: true, before: false });
    // Two hands-folded ancestors, outermost first.
    expect(reveal(nodes, b2, { [`n:${b.id}`]: 'closed', [`n:${b1.id}`]: 'closed' })).toEqual({ keys: [`n:${b.id}`, `n:${b1.id}`], shown: true, before: false });
  });

  it('opens the "+n more" tail that hides a step, then a fold inside it', () => {
    nextId = 1;
    const root = n(null, 'Root', { status: 'active' });
    const a = n(root.id, 'A', { status: 'active' });
    const b = n(root.id, 'B');
    const c = n(root.id, 'C');
    const d = n(root.id, 'D');
    const e = n(root.id, 'E');
    const e1 = n(e.id, 'E1');
    const nodes = [root, a, b, c, d, e, e1];
    expect(reveal(nodes, d)).toEqual({ keys: [`more:${root.id}`], shown: true, before: false });
    expect(reveal(nodes, e1, { [`n:${e.id}`]: 'closed' })).toEqual({ keys: [`more:${root.id}`, `n:${e.id}`], shown: true, before: false });
  });

  it('opens the "✓ n done" run that hides an old finished step', () => {
    nextId = 1;
    const root = n(null, 'Root', { status: 'active' });
    const f = [done(root.id, 'F1'), done(root.id, 'F2'), done(root.id, 'F3')];
    const g = n(root.id, 'G', { status: 'active' });
    expect(reveal([root, ...f, g], f[1])).toEqual({ keys: [`done:${root.id}`], shown: true, before: false });
  });

  it('gives up rather than loop when what it opens does not show the step', () => {
    const layoutWith = () => ({ nodeItems: new Map([[1, { folded: true }]]), items: [] }) as unknown as ReturnType<typeof layoutOutline>;
    expect(revealKeys([1, 2], {}, layoutWith)).toEqual(['n:1']);
    expect(revealKeys([], {}, layoutWith)).toEqual([]);
  });
});
