import { useCallback, useEffect, useMemo, useRef } from 'react';
import { useReactFlow } from '@xyflow/react';
import { NODE_H, eventTarget, findFrontier, needsYouOrder, type LayoutNodeItem, type LayoutResult } from '../../../src/core/layout';
import type { TreeIndex } from '../../../src/core/tree';
import type { EventRow, ProjectSnapshot } from '../../../src/core/types';

interface CameraArgs {
  layout: LayoutResult;
  snapshot: ProjectSnapshot;
  index: TreeIndex;
  lastEvent: EventRow | null;
  follow: boolean;
}

/** Horizontal offset so the card, not its left edge, sits in the middle of the view. */
const CARD_CENTER_X = 140;
const FOLLOW_INTERVAL_MS = 1500;

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
  const timer = useRef(0);
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

  // Follow Claude's changes: at most one move per 1.5 s (latest target wins), retrying
  // briefly because the snapshot that contains a brand-new node arrives ~150 ms after its event.
  // Only a new event moves the camera: turning Follow back on must not replay one that arrived while it was off.
  useEffect(() => {
    if (!followRef.current || !lastEvent) return;
    const target = eventTarget(lastEvent);
    if (target === undefined) return;
    let attempts = 0;
    const attempt = () => {
      if (centerOn(target) || ++attempts >= 4) return;
      timer.current = window.setTimeout(attempt, 300);
    };
    window.clearTimeout(timer.current);
    timer.current = window.setTimeout(attempt, Math.max(350, FOLLOW_INTERVAL_MS - (Date.now() - lastMove.current)));
    return () => window.clearTimeout(timer.current);
  }, [lastEvent, centerOn]);

  // Turning Follow off cancels a follow move that is still waiting.
  useEffect(() => {
    if (!follow) window.clearTimeout(timer.current);
  }, [follow]);

  const nextNeedsYou = useCallback((): number | undefined => {
    const ids = needsYouOrder(layoutRef.current);
    if (!ids.length) return undefined;
    cursor.current = (cursor.current + 1) % ids.length;
    const id = ids[cursor.current];
    centerOn(id);
    return id;
  }, [centerOn]);

  return useMemo(() => ({ centerOn, centerOnFrontier, nextNeedsYou }), [centerOn, centerOnFrontier, nextNeedsYou]);
}
