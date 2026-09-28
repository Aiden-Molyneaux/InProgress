import { NODE_H, type LayoutNodeItem, type LayoutResult } from '../../../src/core/layout';
import { ancestors, type TreeIndex } from '../../../src/core/tree';

/** Titles above the topmost row that is still (partly) visible. */
export function breadcrumbFor(layout: LayoutResult, index: TreeIndex, viewport: { x: number; y: number; zoom: number }): string[] {
  const top = -viewport.y / viewport.zoom;
  const first = layout.items.find((i): i is LayoutNodeItem => i.kind === 'node' && i.y + NODE_H > top);
  return first ? ancestors(index, first.nodeId).map((n) => n.title) : [];
}
