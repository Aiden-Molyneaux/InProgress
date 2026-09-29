import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useReactFlow } from '@xyflow/react';
import { NODE_H, eventTarget, findFrontier, type LayoutNodeItem, type LayoutResult } from '../../../src/core/layout';
import { dfsOrder, isNeedsYou, type TreeIndex } from '../../../src/core/tree';
import type { EventRow, ProjectSnapshot } from '../../../src/core/types';
import { createFollowThrottle } from './followThrottle';

interface CameraArgs {
  layout: LayoutResult;
  snapshot: ProjectSnapshot;
  index: TreeIndex;
  lastEvent: EventRow | null;
  follow: boolean;
}

/** Horizontal offset so the card, not its left edge, sits in the middle of the view. */
const CARD_CENTER_X = 140;

export function useCamera({ layout, snapshot, index, lastEvent, follow }: CameraArgs) {
  const rf = useReactFlow();
  const layoutRef = useRef(layout);
  layoutRef.current = layout;
  const indexRef = useRef(index);
  indexRef.current = index;
  const snapRef = useRef(snapshot);
  snapRef.current = snapshot;
  const followRef = useRef(follow);
  followRef.current = follow;
  const lastMove = useRef(0);
  const cursor = useRef(-1);

  /** The node's row, or its nearest visible ancestor's when it is folded away. */
  const itemFor = useCallback((nodeId: number): LayoutNodeItem | undefined => {
    let id: number | null = nodeId;
    while (id !== null) {
      const item = layoutRef.current.nodeItems.get(id);
      if (item) return item;
      id = indexRef.current.byId.get(id)?.parentId ?? null;
    }
    return undefined;
  }, []);

  const centerOn = useCallback(
    (nodeId: number, duration = 400): boolean => {
      const item = itemFor(nodeId);
      if (!item) return false;
      void rf.setCenter(item.x + CARD_CENTER_X, item.y + NODE_H / 2, { zoom: rf.getZoom(), duration });
      lastMove.current = Date.now();
      return true;
    },
    [rf, itemFor],
  );

  const centerOnFrontier = useCallback(
    (duration = 400, zoom?: number) => {
      const s = snapRef.current;
      const id = findFrontier(s.nodes, s.sessions, layoutRef.current);
      const item = id !== undefined ? itemFor(id) : undefined;
      if (!item) return;
      void rf.setCenter(item.x + CARD_CENTER_X, item.y + NODE_H / 2, { zoom: zoom ?? rf.getZoom(), duration });
      lastMove.current = Date.now();
    },
    [rf, itemFor],
  );

  // Follow Claude's changes: at most one move per 1.5 s, to the newest target, retrying briefly because the
  // snapshot that contains a brand-new node arrives ~150 ms after its event (see followThrottle). An event without
  // a target (a session state change, say) leaves a waiting move alone, and turning Follow back on never replays
  // an event that arrived while it was off.
  const centerOnRef = useRef(centerOn);
  centerOnRef.current = centerOn;
  const [follower] = useState(() =>
    createFollowThrottle({ move: (target) => !followRef.current || centerOnRef.current(target), lastMove: () => lastMove.current }),
  );
  useEffect(() => {
    const target = lastEvent ? eventTarget(lastEvent) : undefined;
    if (target !== undefined && followRef.current) follower.push(target);
  }, [lastEvent, follower]);

  // Turning Follow off cancels a follow move that is still waiting.
  useEffect(() => {
    if (!follow) follower.cancel();
  }, [follow, follower]);

  // So does unmounting: the canvas remounts for every project.
  useEffect(() => () => follower.cancel(), [follower]);

  /**
   * Centres the next needs-you node in outline order and returns the row it landed on. A node inside a
   * manually folded branch lands on its nearest visible ancestor, so N and the pill never do nothing.
   */
  const nextNeedsYou = useCallback((): number | undefined => {
    const index = indexRef.current;
    const ids = [...dfsOrder(index).keys()].filter((id) => isNeedsYou(index.byId.get(id)!));
    if (!ids.length) return undefined;
    cursor.current = (cursor.current + 1) % ids.length;
    const id = ids[cursor.current];
    const anchor = itemFor(id)?.nodeId;
    centerOn(id);
    return anchor;
  }, [centerOn, itemFor]);

  return useMemo(() => ({ centerOn, centerOnFrontier, nextNeedsYou }), [centerOn, centerOnFrontier, nextNeedsYou]);
}
