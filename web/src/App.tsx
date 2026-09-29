import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { isNeedsYou } from '../../src/core/tree';
import { Canvas, type CanvasHandle } from './canvas/Canvas';
import { ActivityStrip } from './chrome/ActivityStrip';
import { SessionRow } from './chrome/SessionRow';
import { TopBar } from './chrome/TopBar';
import { Details } from './panels/Details';
import { ResourceViewer } from './panels/ResourceViewer';
import { useFoldOverrides } from './useFoldOverrides';
import { useInProgress } from './useInProgress';
import { useKeyboard } from './useKeyboard';

export function App() {
  const state = useInProgress();
  const { snapshot, projects } = state;
  const [follow, setFollow] = useState(true);
  const [selectedNode, setSelectedNode] = useState<number | null>(null);
  const [viewerResource, setViewerResource] = useState<number | null>(null);
  const [overrides, setOverride] = useFoldOverrides(snapshot?.project.id);
  const canvas = useRef<CanvasHandle>(null);
  const needsYou = useMemo(() => (snapshot ? snapshot.nodes.filter(isNeedsYou).length : 0), [snapshot]);

  useEffect(() => {
    document.title = `${needsYou ? `(${needsYou}) ` : ''}InProgress${snapshot ? ` — ${snapshot.project.name}` : ''}`;
  }, [needsYou, snapshot]);
  useEffect(() => {
    setSelectedNode(null);
    setViewerResource(null);
  }, [snapshot?.project.id]);

  const followOn = useCallback(() => {
    setFollow(true);
    canvas.current?.goFrontier();
  }, []);

  // The viewer covers the canvas, so while it is open only Escape is ours: F/N/Home/End go to the browser.
  useKeyboard(
    viewerResource !== null
      ? { onEscape: () => setViewerResource(null) }
      : {
          onFollow: () => (follow ? setFollow(false) : followOn()),
          onNext: () => canvas.current?.nextNeedsYou(),
          onHome: () => canvas.current?.goRoot(),
          onEnd: () => canvas.current?.goFrontier(),
          onEscape: () => setSelectedNode(null),
        },
  );

  // Before anything has loaded, a failing stream means the server is unreachable: say so instead of "Loading…".
  if (!state.loaded) return <div className="ip-empty">{state.connection === 'reconnecting' ? "Can't reach the InProgress server, retrying…" : 'Loading…'}</div>;
  return (
    <div className="ip-app">
      <TopBar
        projects={projects}
        current={snapshot?.project ?? null}
        onSelect={state.selectProject}
        needsYou={needsYou}
        onNeedsYou={() => canvas.current?.nextNeedsYou()}
        follow={follow}
        onFollow={followOn}
      />
      {snapshot && <SessionRow sessions={snapshot.sessions} onPick={(s) => s.focusNodeId !== null && canvas.current?.focusNode(s.focusNodeId)} />}
      {state.connection === 'reconnecting' && <div className="ip-banner">Reconnecting to InProgress…</div>}
      <main className="ip-main">
        {projects.length === 0 ? (
          <div className="ip-empty">No projects yet. In a Claude session, say "track this in InProgress".</div>
        ) : snapshot ? (
          <Canvas
            key={snapshot.project.id}
            ref={canvas}
            snapshot={snapshot}
            lastEvent={state.liveEvent}
            follow={follow}
            onFollowChange={setFollow}
            overrides={overrides}
            onToggleFold={setOverride}
            selectedNode={selectedNode}
            onSelectNode={setSelectedNode}
            onOpenResource={setViewerResource}
          />
        ) : (
          <div className="ip-empty">Loading project…</div>
        )}
        {snapshot && selectedNode !== null && (
          <Details
            key={selectedNode}
            nodeId={selectedNode}
            snapshot={snapshot}
            onClose={() => setSelectedNode(null)}
            onSelectNode={(id) => {
              setSelectedNode(id);
              canvas.current?.focusNode(id);
            }}
            onOpenResource={setViewerResource}
          />
        )}
      </main>
      {snapshot && <ActivityStrip event={state.lastEvent} snapshot={snapshot} />}
      {viewerResource !== null && <ResourceViewer key={viewerResource} resourceId={viewerResource} onClose={() => setViewerResource(null)} />}
    </div>
  );
}
