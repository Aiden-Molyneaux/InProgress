import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useReactFlow, useStoreApi } from '@xyflow/react';
import { NODE_H, eventTarget, findFrontier, type LayoutNodeItem, type LayoutResult } from '../../../src/core/layout';
import { dfsOrder, isNeedsYou, type TreeIndex } from '../../../src/core/tree';
import type { EventRow, ProjectSnapshot } from '../../../src/core/types';
import { createFollowThrottle } from './followThrottle';
import { SHEET_QUERY, rowInView } from './sheet';

interface CameraArgs {
  layout: LayoutResult;
  snapshot: ProjectSnapshot;
  index: TreeIndex;
  lastEvent: EventRow | null;
  follow: boolean;
  /** The node Details is open for, or null while Details is closed. */
  selected: number | null;
}

/** Under this media feature every camera move is instant instead of a glide. */
const REDUCED_MOTION = '(prefers-reduced-motion: reduce)';

export function useCamera({ layout, snapshot, index, lastEvent, follow, selected }: CameraArgs) {
  const rf = useReactFlow();
  const store = useStoreApi();
  const detailsRef = useRef(selected !== null);
  detailsRef.current = selected !== null;
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

  /** True while Details is open as the narrow layout's bottom sheet. */
  const sheetOpen = useCallback(() => detailsRef.current && window.matchMedia(SHEET_QUERY).matches, []);

  /**
   * Every camera move goes through here, to a flow height. Flow x 0 stays at the canvas's left edge, so cards that run
   * to x 506 are never cut and the lanes stay left of the Details side panel. With the Details sheet open, the point
   * sits a quarter of the way down, above the sheet. Under reduced motion the move is instant.
   */
  const moveTo = useCallback(
    (y: number, duration: number, zoom = rf.getZoom()) => {
      const glide = window.matchMedia(REDUCED_MOTION).matches ? 0 : duration;
      const { width, height } = store.getState();
      void rf.setCenter(width / 2 / zoom, sheetOpen() ? y + height / 4 / zoom : y, { zoom, duration: glide });
      lastMove.current = Date.now();
    },
    [rf, store, sheetOpen],
  );

  const centerOn = useCallback(
    (nodeId: number, duration = 400): boolean => {
      const item = itemFor(nodeId);
      if (!item) return false;
      moveTo(item.y + NODE_H / 2, duration);
      return true;
    },
    [moveTo, itemFor],
  );

  /** Centres on the node only when its row is out of view, or under the open sheet. A row already in view stays put. */
  const reveal = useCallback(
    (nodeId: number) => {
      const item = itemFor(nodeId);
      if (item && !rowInView(item, rf.getViewport(), store.getState(), sheetOpen())) centerOn(nodeId);
    },
    [rf, store, itemFor, sheetOpen, centerOn],
  );

  /** A session chip or a link in Details. While the sheet is open it only reveals the row; otherwise it centres on it. */
  const focusNode = useCallback((nodeId: number) => (sheetOpen() ? reveal(nodeId) : void centerOn(nodeId)), [sheetOpen, reveal, centerOn]);

  // When Details opens as the bottom sheet over its own node's row, lift the row above the sheet. The move is the
  // camera's own, so Follow stays on.
  useEffect(() => {
    if (selected !== null && sheetOpen()) reveal(selected);
  }, [selected, sheetOpen, reveal]);

  /** Brings a flow height to the middle at once, for keyboard focus that lands outside the view. */
  const centerOnY = useCallback((y: number) => moveTo(y, 0), [moveTo]);

  /** Whether any camera move has run yet: the first move, held for the fonts, gives way to one that came first. */
  const hasMoved = useCallback(() => lastMove.current !== 0, []);

  const centerOnFrontier = useCallback(
    (duration = 400, zoom?: number) => {
      const s = snapRef.current;
      const id = findFrontier(s.nodes, s.sessions, layoutRef.current, s.project.queue);
      const item = id !== undefined ? itemFor(id) : undefined;
      if (item) moveTo(item.y + NODE_H / 2, duration, zoom);
    },
    [moveTo, itemFor],
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

  return useMemo(
    () => ({ centerOn, centerOnY, centerOnFrontier, focusNode, hasMoved, nextNeedsYou, sheetOpen }),
    [centerOn, centerOnY, centerOnFrontier, focusNode, hasMoved, nextNeedsYou, sheetOpen],
  );
}
