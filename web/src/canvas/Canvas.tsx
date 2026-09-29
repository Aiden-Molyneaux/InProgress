import { forwardRef, useCallback, useEffect, useImperativeHandle, useMemo, useRef, useState, type FocusEvent as ReactFocusEvent, type MouseEvent as ReactMouseEvent } from 'react';
import { Background, BackgroundVariant, Controls, MiniMap, ReactFlow, useReactFlow, type Edge, type Node, type NodeChange, type Viewport } from '@xyflow/react';
import { layoutOutline, type LayoutItem } from '../../../src/core/layout';
import { buildIndex, type FoldOverrides } from '../../../src/core/tree';
import type { EventRow, ProjectSnapshot } from '../../../src/core/types';
import { BadgeNode } from './BadgeNode';
import { breadcrumbFor } from './breadcrumb';
import { MoreNode } from './MoreNode';
import { NodeCard, type NodeCardData } from './NodeCard';
import { useCamera } from './useCamera';

const nodeTypes = { ipNode: NodeCard, ipMore: MoreNode, ipBadge: BadgeNode };

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

function minimapColor(n: Node): string {
  if (n.type === 'ipBadge') return '#d97757';
  if (n.type === 'ipMore') return '#aeaeb2';
  const d = n.data as NodeCardData;
  if (d.needsYou) return '#ff9f0a';
  if (d.node.status === 'done') return '#34c759';
  if (d.node.status === 'active') return '#0a84ff';
  return '#aeaeb2';
}

export const Canvas = forwardRef<CanvasHandle, CanvasProps>(function Canvas(props, ref) {
  const { snapshot, overrides, onToggleFold, onOpenResource, onSelectNode, selectedNode } = props;
  const rf = useReactFlow();
  const layout = useMemo(
    () => layoutOutline({ nodes: snapshot.nodes, resources: snapshot.resources, sessions: snapshot.sessions, overrides }),
    [snapshot, overrides],
  );
  const index = useMemo(() => buildIndex(snapshot.nodes), [snapshot.nodes]);
  const [flash, setFlash] = useState<number | null>(null);
  const [crumb, setCrumb] = useState<string[]>([]);
  const camera = useCamera({ layout, snapshot, index, lastEvent: props.lastEvent, follow: props.follow, detailsOpen: selectedNode !== null });
  const flashTimer = useRef(0);
  const flashFrame = useRef(0);
  const initFrame = useRef(0);
  const minimapHeld = useRef(false);

  // React Flow 12.12's minimap sizes each node from the node objects passed in, not from its own
  // measurements. Keep the sizes it reports and pass them back, or the minimap draws no nodes.
  const [sizes, setSizes] = useState<Record<string, { width: number; height: number }>>({});
  const onNodesChange = useCallback((changes: NodeChange[]) => {
    const measured = changes.flatMap((c) => (c.type === 'dimensions' && c.dimensions ? [[c.id, c.dimensions] as const] : []));
    if (measured.length) setSizes((cur) => ({ ...cur, ...Object.fromEntries(measured) }));
  }, []);

  const nodes = useMemo<Node[]>(() => {
    const resourcesById = new Map(snapshot.resources.map((r) => [r.id, r]));
    const sessionsById = new Map(snapshot.sessions.map((s) => [s.id, s]));
    const toNode = (item: LayoutItem): Node | null => {
      const position = { x: item.x, y: item.y };
      const measured = sizes[item.id];
      if (item.kind === 'more') {
        return { id: item.id, type: 'ipMore', position, measured, data: { count: item.hiddenIds.length, parentId: item.parentId, onToggleFold }, draggable: false, selectable: false };
      }
      if (item.kind === 'badge') {
        const session = sessionsById.get(item.sessionId);
        return session ? { id: item.id, type: 'ipBadge', position, measured, data: { session }, draggable: false, selectable: false } : null;
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
        resources: item.resourceIds.map((id) => resourcesById.get(id)).filter((r): r is NonNullable<typeof r> => !!r),
        flash: flash === item.nodeId,
        selected: selectedNode === item.nodeId,
        onSelect: onSelectNode,
        onToggleFold,
        onOpenResource,
      };
      return { id: item.id, type: 'ipNode', position, measured, data, draggable: false, selectable: false };
    };
    return layout.items.map(toNode).filter((n): n is Node => n !== null);
  }, [layout, index, snapshot.resources, snapshot.sessions, flash, selectedNode, onSelectNode, onToggleFold, onOpenResource, sizes]);

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
      focusNode: (id) => void camera.centerOn(id),
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

  // The minimap and the zoom buttons move the camera without a user event reaching onMove.
  const manualMove = useCallback(() => onFollowChange(false), [onFollowChange]);

  const onNodeClick = useCallback(
    (_: ReactMouseEvent, n: Node) => {
      if (n.type === 'ipNode') onSelectNode((n.data as NodeCardData).node.id);
    },
    [onSelectNode],
  );

  // The cards and their buttons are the tab stops (nodesFocusable is off), so React Flow no longer pans to a node that
  // takes keyboard focus. Do it here: anything focused by keyboard outside the view comes to the middle.
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
      if (top >= view.top && top + r.height <= view.bottom && left >= view.left && left + r.width <= view.right) return;
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
      window.clearTimeout(flashTimer.current);
    },
    [],
  );

  return (
    <div className="ip-canvas" onFocus={onFocus}>
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
        proOptions={{ hideAttribution: true }}
      >
        <Background variant={BackgroundVariant.Dots} gap={16} size={1} />
        {/* display: contents leaves the panel positioned by React Flow. Capture-phase handlers, because the
            minimap's d3 handlers stop wheel and mousedown events from bubbling. A press only arms: the first move
            with the button held is a drag and turns Follow off, while a plain click or a right-click leaves it on. */}
        <div
          style={{ display: 'contents' }}
          onPointerDownCapture={(e) => {
            minimapHeld.current = e.button === 0;
          }}
          onPointerMoveCapture={(e) => {
            if (!minimapHeld.current || !(e.buttons & 1)) return;
            minimapHeld.current = false;
            manualMove();
          }}
          onPointerUpCapture={() => {
            minimapHeld.current = false;
          }}
          onWheelCapture={manualMove}
        >
          <MiniMap position="bottom-right" pannable zoomable nodeColor={minimapColor} />
        </div>
        <Controls position="bottom-left" showInteractive={false} onZoomIn={manualMove} onZoomOut={manualMove} onFitView={manualMove} />
      </ReactFlow>
    </div>
  );
});
