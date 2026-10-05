import {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
  type FocusEvent as ReactFocusEvent,
  type MouseEvent as ReactMouseEvent,
} from 'react';
import { Background, BackgroundVariant, Controls, ReactFlow, useReactFlow, type Edge, type Node, type NodeChange, type Viewport } from '@xyflow/react';
import { layoutOutline, type LayoutItem } from '../../../src/core/layout';
import { buildIndex, type FoldOverrides } from '../../../src/core/tree';
import { sessionDisplayTitle, sessionTag, type EventRow, type ProjectSnapshot } from '../../../src/core/types';
import { taskFamily, taskOwner, waitsFor, withTag } from '../live';
import { useNow } from '../useNow';
import { AgentBadge, type AgentBadgeData } from './AgentBadge';
import { BadgeNode } from './BadgeNode';
import { breadcrumbFor } from './breadcrumb';
import { MoreNode, type MoreNodeData } from './MoreNode';
import { NodeCard, type NodeCardData } from './NodeCard';
import { ReadersRow, type ReadersRowData } from './ReadersRow';
import { visibleHeight } from './sheet';
import { TrailAgentRow, type TrailAgentRowData } from './TrailAgentRow';
import { useCamera } from './useCamera';
import { WorkDoneRow, type WorkDoneRowData } from './WorkDoneRow';
import { WorkRow, type WorkRowData } from './WorkRow';

/** How many frames a newly shown card gets to appear before focus stops waiting for it. */
const FOCUS_FRAMES = 30;
/**
 * How often time-based labels ("12 min", "done 2 min ago") catch up, and with them the 5-minute greyed badge of an ended
 * subagent, which then moves into its step's trail.
 */
const CLOCK_MS = 30_000;

const nodeTypes = {
  ipNode: NodeCard,
  ipMore: MoreNode,
  ipBadge: BadgeNode,
  ipAgent: AgentBadge,
  ipReaders: ReadersRow,
  ipWork: WorkRow,
  ipWorkDone: WorkDoneRow,
  ipTrailAgent: TrailAgentRow,
};

export interface CanvasHandle {
  focusNode: (id: number) => void;
  nextNeedsYou: () => void;
  goRoot: () => void;
  goFrontier: () => void;
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
  const layout = useMemo(
    () =>
      layoutOutline({
        nodes: snapshot.nodes,
        resources: snapshot.resources,
        sessions: snapshot.sessions,
        workItems: snapshot.workItems,
        trailAgents: snapshot.trailAgents,
        pastSessions: snapshot.pastSessions,
        queue: snapshot.project.queue,
        overrides,
        now,
      }),
    [snapshot, overrides, now],
  );
  const index = useMemo(() => buildIndex(snapshot.nodes), [snapshot.nodes]);
  const [flash, setFlash] = useState<number | null>(null);
  const [crumb, setCrumb] = useState<string[]>([]);
  const camera = useCamera({ layout, snapshot, index, lastEvent: props.lastEvent, follow: props.follow, selected: selectedNode });
  const root = useRef<HTMLDivElement>(null);
  const flashTimer = useRef(0);
  const flashFrame = useRef(0);
  const initFrame = useRef(0);
  const focusFrame = useRef(0);

  // React Flow 12.12 keeps a node hidden until the node object passed in carries its measured size, and the nodes below
  // are new objects on every snapshot, flash, selection and clock tick. Keep the sizes it reports and pass them back, so
  // cards stay measured across rebuilds: without this, every card blinks out to be measured again and a focused card
  // can't keep focus.
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
    const toNode = (item: LayoutItem): Node | null => {
      const position = { x: item.x, y: item.y };
      const measured = sizes[item.id];
      const fixed = { id: item.id, position, measured, draggable: false, selectable: false };
      if (item.kind === 'more') {
        const data: MoreNodeData = {
          count: item.hiddenIds.length,
          variant: item.variant,
          foldKey: `${item.variant === 'done' ? 'done' : 'more'}:${item.parentId}`,
          firstId: item.hiddenIds[0],
          onExpand: expandRun,
        };
        return { ...fixed, type: 'ipMore', data };
      }
      if (item.kind === 'badge') {
        const session = sessionsById.get(item.sessionId);
        return session ? { ...fixed, type: 'ipBadge', data: { session } } : null;
      }
      if (item.kind === 'agent') {
        const session = sessionsById.get(item.sessionId);
        const agent = session?.subagents.find((a) => a.agentId === item.agentId);
        if (!session || !agent) return null;
        // In its session's hue, led by its tag.
        const data: AgentBadgeData = { agent, nodeId: item.nodeId, slot: session.slot, now };
        return { ...fixed, type: 'ipAgent', data };
      }
      if (item.kind === 'readers') {
        const session = sessionsById.get(item.sessionId);
        const readers = session ? session.subagents.filter((a) => item.agentIds.includes(a.agentId)) : [];
        if (!session || !readers.length) return null;
        const data: ReadersRowData = { readers, slot: session.slot, nodeId: item.nodeId };
        return { ...fixed, type: 'ipReaders', data };
      }
      if (item.kind === 'work') {
        const w = workById.get(item.workId);
        if (!w) return null;
        // A trail row is neutral: no hue, no tag, no letter (its session's slot may be a live session's by now).
        const family = item.stale ? null : taskFamily(w, snapshot.sessions, trailAgents);
        const owner = taskOwner(w, snapshot.sessions, pastSessions, trailAgents);
        const data: WorkRowData = {
          item: w,
          pulse: item.pulse,
          stale: item.stale,
          family,
          // A live row's tooltip names its session's letter, or its subagent's tag.
          owner: family ? withTag(w.agentId ? family.tag : sessionTag(family.slot), owner) : owner,
          waits: waitsFor(w, snapshot.workItems),
        };
        return { ...fixed, type: 'ipWork', data };
      }
      if (item.kind === 'workDone') {
        const data: WorkDoneRowData = { nodeId: item.nodeId, count: item.count, unfinished: item.unfinished, agents: item.agents, open: item.open, onToggleFold };
        return { ...fixed, type: 'ipWorkDone', data };
      }
      if (item.kind === 'trailAgent') {
        const agent = trailAgents.find((a) => a.sessionId === item.sessionId && a.agentId === item.agentId);
        if (!agent) return null;
        const session = sessionsById.get(item.sessionId) ?? pastSessions.find((s) => s.id === item.sessionId);
        const data: TrailAgentRowData = { agent, nodeId: item.nodeId, sessionTitle: session ? sessionDisplayTitle(session) : 'a session', now };
        return { ...fixed, type: 'ipTrailAgent', data };
      }
      const node = index.byId.get(item.nodeId)!;
      const data: NodeCardData = {
        node,
        folded: item.folded,
        doneCount: item.doneCount,
        progress: item.progress,
        needsYou: item.needsYou,
        hasChildren: item.hasChildren,
        working: item.working,
        // An owned place takes its session's slot, for the letter and hue it wears.
        queue: item.queue && { pos: item.queue.pos, owner: item.queue.sessionId === null ? null : { slot: sessionsById.get(item.queue.sessionId)?.slot ?? null } },
        resources: item.resourceIds.map((id) => resourcesById.get(id)).filter((r): r is NonNullable<typeof r> => !!r),
        flash: flash === item.nodeId,
        selected: selectedNode === item.nodeId,
        onSelect: onSelectNode,
        onToggleFold,
        onOpenResource,
      };
      return { ...fixed, type: 'ipNode', data };
    };
    return layout.items.map(toNode).filter((n): n is Node => n !== null);
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
        // The source handle sits 12 px in and children indent 28 px: an offset of 16 keeps the rail straight.
        pathOptions: { offset: 16 },
        selectable: false,
        focusable: false,
        style: { stroke: 'var(--edge)', strokeWidth: 1.2 },
      })),
    [layout.edges],
  );

  useImperativeHandle(
    ref,
    () => ({
      focusNode: (id) => camera.focusNode(id),
      nextNeedsYou: () => {
        const id = camera.nextNeedsYou();
        if (id === undefined) return;
        // Clear, then set on the next frame: a press that lands on the row already flashing restarts its flash.
        setFlash(null);
        cancelAnimationFrame(flashFrame.current);
        flashFrame.current = requestAnimationFrame(() => setFlash(id));
        window.clearTimeout(flashTimer.current);
        flashTimer.current = window.setTimeout(() => setFlash((f) => (f === id ? null : f)), 1500);
      },
      goRoot: () => {
        if (index.root) camera.centerOn(index.root.id);
      },
      goFrontier: () => camera.centerOnFrontier(),
    }),
    [camera, index],
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
      const p = rf.screenToFlowPosition({ x: left + r.width / 2, y: top + r.height / 2 });
      camera.centerOnPoint(p.x, p.y);
    },
    [rf, camera],
  );

  const onInit = useCallback(() => {
    initFrame.current = requestAnimationFrame(() => camera.centerOnFrontier(0, 1));
  }, [camera]);

  useEffect(
    () => () => {
      cancelAnimationFrame(initFrame.current);
      cancelAnimationFrame(flashFrame.current);
      cancelAnimationFrame(focusFrame.current);
      window.clearTimeout(flashTimer.current);
    },
    [],
  );

  return (
    <div className="ip-canvas" ref={root} onFocus={onFocus}>
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
        <Background variant={BackgroundVariant.Dots} gap={16} size={1} />
        <Controls position="bottom-left" showInteractive={false} onZoomIn={manualMove} onZoomOut={manualMove} onFitView={manualMove} />
      </ReactFlow>
    </div>
  );
});
