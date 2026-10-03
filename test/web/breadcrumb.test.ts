import { describe, expect, it } from 'vitest';
import { ROW, layoutOutline } from '../../src/core/layout';
import { buildIndex } from '../../src/core/tree';
import type { TreeNode } from '../../src/core/types';
import { breadcrumbFor } from '../../web/src/canvas/breadcrumb';

const node = (id: number, parentId: number | null, title: string): TreeNode => ({
  id, projectId: 1, parentId, position: id, kind: parentId === null ? 'goal' : 'task', title, body: '', status: 'active', assignee: 'claude', outcome: '', label: null, createdAt: 't', updatedAt: 't', completedAt: null,
});

describe('breadcrumbFor', () => {
  const nodes = [node(1, null, 'InGame'), node(2, 1, 'Road to market'), node(3, 2, 'Android signing'), node(4, 3, 'Play app signing')];
  const layout = layoutOutline({ nodes, resources: [], sessions: [] });
  const index = buildIndex(nodes);

  it('is empty when the root is at the top of the view', () => {
    expect(breadcrumbFor(layout, index, { x: 0, y: 0, zoom: 1 })).toEqual([]);
  });

  it('shows the ancestors of the topmost visible row', () => {
    expect(breadcrumbFor(layout, index, { x: 0, y: -2 * ROW, zoom: 1 })).toEqual(['InGame', 'Road to market']);
    expect(breadcrumbFor(layout, index, { x: 0, y: -1 * ROW, zoom: 0.5 })).toEqual(['InGame', 'Road to market']);
  });
});
