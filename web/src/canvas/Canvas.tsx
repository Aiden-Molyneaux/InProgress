import {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type FocusEvent as ReactFocusEvent,
  type MouseEvent as ReactMouseEvent,
} from 'react';
import { Controls, ReactFlow, useReactFlow, type Edge, type Node, type NodeChange, type Viewport } from '@xyflow/react';
import { layoutOutline, type LayoutInput, type LayoutItem } from '../../../src/core/layout';
import { ancestors, buildIndex, needsYouAge, type FoldOverrides } from '../../../src/core/tree';
import { sessionDisplayTitle, sessionTag, type EventRow, type ProjectSnapshot } from '../../../src/core/types';
import { revealKeys } from '../folds';
import { taskFamily, taskOwner, waitsFor, withTag } from '../live';
import { relativeTime } from '../time';
import { useNow } from '../useNow';
import { breadcrumbFor } from './breadcrumb';
import { LaneNode } from './LaneNode';
import { MoreNode, type MoreNodeData } from './MoreNode';
import { NodeCard, type CardRow, type NodeCardData } from './NodeCard';
import { PITCH } from './pitch';
import { visibleHeight } from './sheet';
import { useCamera } from './useCamera';
import type { WorkDoneRowProps } from './WorkDoneRow';

/** How many frames a newly shown card gets to appear before focus stops waiting for it. */
const FOCUS_FRAMES = 30;
/**
 * How often time-based labels ("12 min", a kin's "18m", "done 2 min ago") catch up, and with them the 5-minute grey
 * kin of an ended subagent, which then moves into its step's trail.
 */
const CLOCK_MS = 30_000;

/** A step is one node with its lines inside it. Fold rows and lanes are nodes of their own. */
const nodeTypes = {
  ipNode: NodeCard,
  ipMore: MoreNode,
  ipLane: LaneNode,
};

export interface CanvasHandle {
  focusNode: (id: number) => void;
  nextNeedsYou: () => void;
  goRoot: () => void;
  goFrontier: () => void;
  /**
   * The Go to field's jump: opens whatever folds hide the step (its folded ancestors, and a "+n more" or "✓ n done" run
   * on the way down), then centres on it and flashes it. Waits for the canvas's first paint when it is new. False when
   * the step is not in this snapshot.
   */
  goTo: (id: number) => boolean;
}

export interface CanvasProps {
  snapshot: ProjectSnapshot;
  lastEvent: EventRow | null;
  follow: boolean;
  onFollowChange: (follow: boolean) => void;
  overrides: FoldOverrides;
  onToggleFold: (key: string, value: 'open' | 'closed') => void;
  selectedNode: number | null;
  onSelectNode: (id: number) => void;
  onOpenResource: (id: number) => void;
}

export const Canvas = forwardRef<CanvasHandle, CanvasProps>(function Canvas(props, ref) {
  const { snapshot, overrides, onToggleFold, onOpenResource, onSelectNode, selectedNode } = props;
  const rf = useReactFlow();
  const now = useNow(CLOCK_MS);
  /** Everything layout reads but the folds. */
  const layoutInput = useMemo<LayoutInput>(
    () => ({
      nodes: snapshot.nodes,
      resources: snapshot.resources,
      sessions: snapshot.sessions,
      workItems: snapshot.workItems,
      trailAgents: snapshot.trailAgents,
      pastSessions: snapshot.pastSessions,
      queue: snapshot.project.queue,
      now,
    }),
    [snapshot, now],
  );
  const layout = useMemo(() => layoutOutline({ ...layoutInput, overrides }), [layoutInput, overrides]);
  const index = useMemo(() => buildIndex(snapshot.nodes), [snapshot.nodes]);
  const [flash, setFlash] = useState<number | null>(null);
  const [crumb, setCrumb] = useState<string[]>([]);
  const camera = useCamera({ layout, snapshot, index, lastEvent: props.lastEvent, follow: props.follow, selected: selectedNode });
  const root = useRef<HTMLDivElement>(null);
  const flashTimer = useRef(0);
  const flashFrame = useRef(0);
  const initFrame = useRef(0);
  const focusFrame = useRef(0);
  /** Set once the first paint has its fonts: a Go to jump waits for it, so it never moves a canvas not yet measured. */
  const [ready, setReady] = useState(false);
  /** A Go to jump whose folds have opened, waiting for the layout that shows them (and, on a new canvas, for ready). */
  const [going, setGoing] = useState<{ id: number } | null>(null);
  const goingRef = useRef(going);
  goingRef.current = going;

  // React Flow 12.12 keeps a node hidden until the node object passed in carries a size, and the nodes below are new
  // objects on every snapshot, flash, selection and clock tick. A new object without a `measured` size also drops the
  // handle positions React Flow measured, and an edge draws only between measured handles. Cards and lanes carry
  // layout's size as both their size and their measured size, which is the size of their DOM box: React Flow measures
  // a card's handles when it first draws, again whenever it resizes, and keeps them across rebuilds. Fold rows are
  // measured: keep the sizes React Flow reports and pass them back, so they stay measured across rebuilds and never
  // blink out (ruling 1).
  const [sizes, setSizes] = useState<Record<string, { width: number; height: number }>>({});
  const onNodesChange = useCallback((changes: NodeChange[]) => {
    const measured = changes.flatMap((c) => (c.type === 'dimensions' && c.dimensions ? [[c.id, c.dimensions] as const] : []));
    if (measured.length) setSizes((cur) => ({ ...cur, ...Object.fromEntries(measured) }));
  }, []);

  /**
   * Shows a "+n more" or "✓ n done" run, by its override (`more:<parentId>` or `done:<parentId>`). Its button goes away
   * with it, which would drop focus to the page, so focus moves to the first card the run shows. React Flow keeps a new
   * card hidden until it has measured it, and a hidden card can't take focus: try again each frame until it shows.
   */
  const expandRun = useCallback(
    (foldKey: string, firstId: number) => {
      onToggleFold(foldKey, 'open');
      let frames = 0;
      const attempt = () => {
        // Focus that something else has taken meanwhile stays there. Focus on the page, or still on the button, moves.
        const active = document.activeElement;
        if (active && active !== document.body && !active.classList.contains('ip-more')) return;
        const card = root.current?.querySelector<HTMLElement>(`.react-flow__node[data-id="n${firstId}"] .ip-node`);
        if (card && getComputedStyle(card).visibility === 'visible') card.focus();
        else if (++frames < FOCUS_FRAMES) focusFrame.current = requestAnimationFrame(attempt);
      };
      cancelAnimationFrame(focusFrame.current);
      focusFrame.current = requestAnimationFrame(attempt);
    },
    [onToggleFold],
  );

  const nodes = useMemo<Node[]>(() => {
    const resourcesById = new Map(snapshot.resources.map((r) => [r.id, r]));
    const sessionsById = new Map(snapshot.sessions.map((s) => [s.id, s]));
    const workById = new Map(snapshot.workItems.map((w) => [w.id, w]));
    const { pastSessions, trailAgents } = snapshot;

    /** A row item as its card draws it, or null when what it stands for has left the snapshot. */
    const toRow = (item: LayoutItem): CardRow | null => {
      switch (item.kind) {
        case 'line': {
          const session = sessionsById.get(item.sessionId);
          if (!session) return null;
          const agents = item.agentIds.flatMap((id) => session.subagents.find((a) => a.agentId === id) ?? []);
          return { kind: 'line', id: item.id, props: { session, nodeId: item.nodeId, lead: item.lead, agents, now, done: null } };
        }
        case 'readers': {
          const session = sessionsById.get(item.sessionId);
          const readers = session ? session.subagents.filter((a) => item.agentIds.includes(a.agentId)) : [];
          if (!session || !readers.length) return null;
          return { kind: 'readers', id: item.id, props: { readers, slot: session.slot, nodeId: item.nodeId, done: null } };
        }
        case 'work': {
          const w = workById.get(item.workId);
          if (!w) return null;
          // A trail row is neutral: no hue, no tag, no letter (its session's slot may be a live session's by now).
          const family = item.stale ? null : taskFamily(w, snapshot.sessions, trailAgents);
          const owner = taskOwner(w, snapshot.sessions, pastSessions, trailAgents);
          return {
            kind: 'work',
            id: item.id,
            props: {
              item: w,
              pulse: item.pulse,
              stale: item.stale,
              family,
              // A live row's tooltip names its session's letter, or its subagent's tag.
              owner: family ? withTag(w.agentId ? family.tag : sessionTag(family.slot), owner) : owner,
              waits: waitsFor(w, snapshot.workItems),
            },
          };
        }
        case 'trailAgent': {
          const agent = trailAgents.find((a) => a.sessionId === item.sessionId && a.agentId === item.agentId);
          if (!agent) return null;
          const session = sessionsById.get(item.sessionId) ?? pastSessions.find((s) => s.id === item.sessionId);
          return { kind: 'trailAgent', id: item.id, props: { agent, nodeId: item.nodeId, sessionTitle: session ? sessionDisplayTitle(session) : 'a session', now } };
        }
        default:
          return null;
      }
    };

    // Each card's lines, in layout's order. A done row that shares a line rides at that line's right end: layout gave it
    // that line's y and no height of its own.
    const rowsByNode = new Map<number, CardRow[]>();
    for (const item of layout.items) {
      if (item.kind === 'node' || item.kind === 'more') continue;
      const rows = rowsByNode.get(item.nodeId) ?? [];
      rowsByNode.set(item.nodeId, rows);
      if (item.kind === 'workDone') {
        const done: WorkDoneRowProps = { nodeId: item.nodeId, count: item.count, unfinished: item.unfinished, agents: item.agents, open: item.open, onToggleFold };
        const last = rows[rows.length - 1];
        if (item.shared && (last?.kind === 'line' || last?.kind === 'readers')) last.props.done = done;
        else rows.push({ kind: 'workDone', id: item.id, props: done });
        continue;
      }
      const row = toRow(item);
      if (row) rows.push(row);
    }

    const cards = layout.items.flatMap((item): Node[] => {
      const position = { x: item.x, y: item.y };
      if (item.kind === 'more') {
        const data: MoreNodeData = {
          count: item.hiddenIds.length,
          variant: item.variant,
          foldKey: `${item.variant === 'done' ? 'done' : 'more'}:${item.parentId}`,
          firstId: item.hiddenIds[0],
          onExpand: expandRun,
        };
        return [{ id: item.id, position, measured: sizes[item.id], draggable: false, selectable: false, type: 'ipMore', data }];
      }
      if (item.kind !== 'node') return [];
      const node = index.byId.get(item.nodeId)!;
      const data: NodeCardData = {
        node,
        folded: item.folded,
        doneCount: item.doneCount,
        progress: item.progress,
        needsYou: item.needsYou,
        // Both age with the clock, which only Canvas holds.
        age: item.needsYou ? needsYouAge(node, now) : null,
        hasChildren: item.hasChildren,
        working: item.working,
        paused: item.paused,
        lastChange: relativeTime(node.updatedAt, now),
        // An owned place takes its session's slot, for the letter and hue it wears.
        queue: item.queue && { pos: item.queue.pos, owner: item.queue.sessionId === null ? null : { slot: sessionsById.get(item.queue.sessionId)?.slot ?? null } },
        resources: item.resourceIds.map((id) => resourcesById.get(id)).filter((r): r is NonNullable<typeof r> => !!r),
        flash: flash === item.nodeId,
        selected: selectedNode === item.nodeId,
        x: item.x,
        w: item.w,
        h: item.h,
        stack: item.stack,
        workingFocus: item.workingFocus,
        rows: rowsByNode.get(item.nodeId) ?? [],
        onSelect: onSelectNode,
        onToggleFold,
        onOpenResource,
      };
      // Layout's size: React Flow shows the card without waiting to measure it, keeps its handles across rebuilds so
      // its rails draw, and the frame is as tall as layout spaced it.
      const size = { width: item.w, height: item.h };
      return [{ id: item.id, position, ...size, measured: size, draggable: false, selectable: false, type: 'ipNode', data }];
    });

    // Lanes first, and below everything, edges included. React Flow writes pointer-events: all on every node while the
    // flow has an onNodeClick, then spreads node.style over it: only the style lets clicks, pans and wheel ticks through.
    const lanes = layout.lanes.map(
      (lane): Node => ({
        id: lane.id,
        type: 'ipLane',
        position: { x: lane.x, y: lane.y },
        width: lane.w,
        height: lane.h,
        measured: { width: lane.w, height: lane.h },
        zIndex: -1,
        draggable: false,
        selectable: false,
        focusable: false,
        style: { pointerEvents: 'none' },
        data: {},
      }),
    );
    return [...lanes, ...cards];
  }, [layout, index, snapshot, now, flash, selectedNode, onSelectNode, onToggleFold, onOpenResource, expandRun, sizes]);

  const edges = useMemo<Edge[]>(
    () =>
      layout.edges.map((e) => ({
        id: e.id,
        source: e.source,
        target: e.target,
        sourceHandle: 'out',
        targetHandle: 'in',
        type: 'step',
        // The source handle sits 18 px in and children indent 28 px: an offset of 10 keeps the rail 10 px left of them.
        pathOptions: { offset: 10 },
        selectable: false,
        focusable: false,
        style: { stroke: 'var(--border)', strokeWidth: 1 },
      })),
    [layout.edges],
  );

  /** Flashes a row. Clear, then set on the next frame: a row already flashing flashes again. */
  const flashRow = useCallback((id: number) => {
    setFlash(null);
    cancelAnimationFrame(flashFrame.current);
    flashFrame.current = requestAnimationFrame(() => setFlash(id));
    window.clearTimeout(flashTimer.current);
    flashTimer.current = window.setTimeout(() => setFlash((f) => (f === id ? null : f)), 1500);
  }, []);

  // The jump lands once the layout shows the step: the folds it opened render with it.
  useEffect(() => {
    if (!going || !ready) return;
    setGoing(null);
    camera.centerOn(going.id);
    flashRow(going.id);
  }, [going, ready, camera, flashRow]);

  useImperativeHandle(
    ref,
    () => ({
      focusNode: (id) => camera.focusNode(id),
      nextNeedsYou: () => {
        const id = camera.nextNeedsYou();
        if (id !== undefined) flashRow(id);
      },
      goRoot: () => {
        if (index.root) camera.centerOn(index.root.id);
      },
      goFrontier: () => camera.centerOnFrontier(),
      goTo: (id) => {
        if (!index.byId.has(id)) return false;
        const path = [...ancestors(index, id).map((n) => n.id), id];
        for (const key of revealKeys(path, overrides, (o) => layoutOutline({ ...layoutInput, overrides: o }))) onToggleFold(key, 'open');
        setGoing({ id });
        return true;
      },
    }),
    [camera, index, overrides, layoutInput, onToggleFold, flashRow],
  );

  // Keep the same array while the titles are unchanged, so a glide doesn't re-render the canvas every frame.
  const updateCrumb = useCallback(
    (vp: Viewport) => {
      const next = breadcrumbFor(layout, index, vp);
      setCrumb((cur) => (cur.length === next.length && cur.every((t, i) => t === next[i]) ? cur : next));
    },
    [layout, index],
  );

  // A fold, an unfold or an insert moves the rows under a camera that stays put.
  useEffect(() => updateCrumb(rf.getViewport()), [rf, updateCrumb]);

  const { onFollowChange } = props;
  // onMove fires only when the viewport actually changes: a user pan or zoom carries an event,
  // programmatic camera moves carry null. (onMoveStart would also fire on plain clicks.)
  const onMove = useCallback(
    (event: MouseEvent | TouchEvent | null, vp: Viewport) => {
      if (event) onFollowChange(false);
      updateCrumb(vp);
    },
    [onFollowChange, updateCrumb],
  );

  // A wheel pan reports its first tick only to onMoveStart (onMove starts at the second), so a single tick is caught
  // here. Other move starts include plain clicks on the pane, which keep Follow on.
  const onMoveStart = useCallback(
    (event: MouseEvent | TouchEvent | null, vp: Viewport) => {
      if (event?.type !== 'wheel') return;
      onFollowChange(false);
      updateCrumb(vp);
    },
    [onFollowChange, updateCrumb],
  );

  // The zoom buttons move the camera without a user event reaching onMove.
  const manualMove = useCallback(() => onFollowChange(false), [onFollowChange]);

  const onNodeClick = useCallback(
    (_: ReactMouseEvent, n: Node) => {
      if (n.type === 'ipNode') onSelectNode((n.data as NodeCardData).node.id);
    },
    [onSelectNode],
  );

  // The cards and their buttons are the tab stops (nodesFocusable is off), so React Flow no longer pans to a node that
  // takes keyboard focus. Do it here: anything focused by keyboard outside the view comes to the middle. While Details
  // is open as the bottom sheet, only the part of the canvas above the sheet counts as the view.
  const onFocus = useCallback(
    (e: ReactFocusEvent<HTMLDivElement>) => {
      const el = e.target as HTMLElement;
      const flow = el.closest<HTMLElement>('.react-flow');
      if (!flow || !el.closest('.react-flow__node') || !el.matches(':focus-visible')) return;
      // By now the browser has scrolled the wrapper to show the element, and React Flow undoes that scroll a frame
      // later: measure where the element sits without it.
      const r = el.getBoundingClientRect();
      const top = r.top + flow.scrollTop;
      const left = r.left + flow.scrollLeft;
      const view = flow.getBoundingClientRect();
      const bottom = view.top + visibleHeight(view.height, camera.sheetOpen());
      if (top >= view.top && top + r.height <= bottom && left >= view.left && left + r.width <= view.right) return;
      // Only its height counts: the camera keeps flow x 0 at the canvas's left edge.
      const p = rf.screenToFlowPosition({ x: left + r.width / 2, y: top + r.height / 2 });
      camera.centerOnY(p.y);
    },
    [rf, camera],
  );

  // The first move waits for the bundled fonts, so it never runs on fallback metrics. A promise can't be cancelled:
  // skip the move once the canvas has gone, or once the camera has moved already (a Home pressed meanwhile, say).
  const alive = useRef(true);
  const onInit = useCallback(() => {
    void document.fonts.ready.then(() => {
      if (!alive.current) return;
      setReady(true);
      // A Go to jump waiting for the first paint takes the camera instead.
      if (camera.hasMoved() || goingRef.current) return;
      initFrame.current = requestAnimationFrame(() => {
        if (!camera.hasMoved() && !goingRef.current) camera.centerOnFrontier(0, 1);
      });
    });
  }, [camera]);

  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
      cancelAnimationFrame(initFrame.current);
      cancelAnimationFrame(flashFrame.current);
      cancelAnimationFrame(focusFrame.current);
      window.clearTimeout(flashTimer.current);
    };
  }, []);

  return (
    // Layout's pitch, written once: the canvas rules read it for every fixed height.
    <div className="ip-canvas" ref={root} onFocus={onFocus} style={PITCH as CSSProperties}>
      {crumb.length > 0 && <div className="ip-crumb">{crumb.join(' › ')}</div>}
      <ReactFlow
        nodes={nodes}
        edges={edges}
        nodeTypes={nodeTypes}
        onNodesChange={onNodesChange}
        onInit={onInit}
        onNodeClick={onNodeClick}
        onMoveStart={onMoveStart}
        onMove={onMove}
        minZoom={0.15}
        maxZoom={2}
        panOnScroll
        nodesDraggable={false}
        nodesConnectable={false}
        nodesFocusable={false}
        elementsSelectable={false}
        colorMode="system"
        proOptions={{ hideAttribution: true }}
      >
        <Controls position="top-right" orientation="horizontal" showInteractive={false} onZoomIn={manualMove} onZoomOut={manualMove} onFitView={manualMove} />
      </ReactFlow>
    </div>
  );
});
