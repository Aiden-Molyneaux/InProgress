import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { StepHit } from '../../src/core/goto';
import { isNeedsYou } from '../../src/core/tree';
import type { ProjectSnapshot } from '../../src/core/types';
import { Canvas, type CanvasHandle } from './canvas/Canvas';
import { ActivityStrip } from './chrome/ActivityStrip';
import type { GoToHandle } from './chrome/GoTo';
import { SessionRow } from './chrome/SessionRow';
import { archivedProjects, neighbourTab, projectTabs, stepTab } from './chrome/tabs';
import { TopBar } from './chrome/TopBar';
import { UpNext } from './chrome/UpNext';
import { Details } from './panels/Details';
import { ResourceViewer } from './panels/ResourceViewer';
import { actionMessage, renameMessage, type ActionTarget, type ProjectAction } from './projectActions';
import { useFoldOverrides } from './useFoldOverrides';
import { useInProgress } from './useInProgress';
import { useKeyboard } from './useKeyboard';

const holds = (snapshot: ProjectSnapshot, id: number) => snapshot.nodes.some((n) => n.id === id);

export function App() {
  const state = useInProgress();
  const { snapshot, projects } = state;
  const [follow, setFollow] = useState(true);
  const [selectedNode, setSelectedNode] = useState<number | null>(null);
  // A node deleted while Details shows it closes Details: the snapshot before held it, the new one doesn't. A node picked
  // from Details' own lists can be newer than the snapshot on screen, so missing from one snapshot alone doesn't count.
  // Cleared during render, so Details never refetches a node that is gone.
  const [lastSnapshot, setLastSnapshot] = useState(snapshot);
  if (snapshot !== lastSnapshot) {
    setLastSnapshot(snapshot);
    if (selectedNode !== null && snapshot && lastSnapshot && holds(lastSnapshot, selectedNode) && !holds(snapshot, selectedNode)) setSelectedNode(null);
  }
  const [viewerResource, setViewerResource] = useState<number | null>(null);
  const viewerOpen = viewerResource !== null;
  const [overrides, setOverride] = useFoldOverrides(snapshot?.project.id);
  const canvas = useRef<CanvasHandle>(null);
  const goToField = useRef<GoToHandle>(null);
  const app = useRef<HTMLDivElement>(null);
  /** Whatever had focus when the viewer opened. It gets focus back when the viewer closes. */
  const opener = useRef<HTMLElement | null>(null);
  const needsYou = useMemo(() => (snapshot ? snapshot.nodes.filter(isNeedsYou).length : 0), [snapshot]);
  // The tabs follow the picked slug, not the loaded snapshot, so a tab lights up on the click and [ ] step on from it.
  const tabs = useMemo(() => projectTabs(projects, state.slug), [projects, state.slug]);
  const archived = useMemo(() => archivedProjects(projects), [projects]);
  const stepProject = (step: 1 | -1) => {
    const slug = stepTab(tabs, state.slug, step);
    if (slug) state.selectProject(slug);
  };

  /** The status line: what an archive, unarchive, rename, delete or restore did, or why it failed. Shown for 3 s. */
  const [status, setStatus] = useState<string | null>(null);
  const statusTimer = useRef(0);
  const say = (text: string) => {
    setStatus(text);
    window.clearTimeout(statusTimer.current);
    statusTimer.current = window.setTimeout(() => setStatus(null), 3000);
  };
  useEffect(() => () => window.clearTimeout(statusTimer.current), []);
  const onAction = async (action: ProjectAction, target: ActionTarget): Promise<boolean> => {
    // Picked before the write: archiving or deleting the open project opens the tab beside it, as a browser does when a
    // tab closes. With none, an archived project stays open as the end tab and a deleted one falls back.
    const leaving = (action === 'archive' || action === 'delete') && target.slug === state.slug;
    const result = await state.act(action, target, leaving ? neighbourTab(tabs, target.slug) : null);
    if (result === 'reload') return false;
    say(result === 'ok' ? actionMessage(action, target.name) : result);
    return result === 'ok';
  };
  const onRename = async (target: ActionTarget, name: string): Promise<boolean> => {
    const result = await state.rename(target, name);
    if (result === 'reload') return false;
    say(result === 'ok' ? renameMessage(name) : result);
    return result === 'ok';
  };

  const openViewer = useCallback((id: number) => {
    opener.current ??= document.activeElement instanceof HTMLElement ? document.activeElement : null;
    setViewerResource(id);
  }, []);

  // The viewer is aria-modal: while it is open the rest of the app is inert. When it closes, focus returns to its
  // opener. A layout effect, so the app is interactive again before the opener takes focus.
  useLayoutEffect(() => {
    if (app.current) app.current.inert = viewerOpen;
    if (viewerOpen) return;
    if (opener.current?.isConnected) opener.current.focus();
    opener.current = null;
  }, [viewerOpen]);

  useEffect(() => {
    document.title = `${needsYou ? `(${needsYou}) ` : ''}InProgress${snapshot ? ` · ${snapshot.project.name}` : ''}`;
  }, [needsYou, snapshot]);
  useEffect(() => {
    setSelectedNode(null);
    setViewerResource(null);
  }, [snapshot?.project.id]);

  /**
   * A step picked in the Go to field, until the window shows its project with the step in it. Declared after the
   * effect above, so on a switch the selection that effect clears is set again here, in the same commit.
   */
  const [goingTo, setGoingTo] = useState<{ id: number; projectId: number; slug: string } | null>(null);
  const goTo = (hit: StepHit) => {
    // A jump is a move of Aiden's own, as a pan is: Follow would take the camera straight back.
    setFollow(false);
    setGoingTo({ id: hit.id, projectId: hit.projectId, slug: hit.projectSlug });
    if (hit.projectSlug !== state.slug) state.selectProject(hit.projectSlug);
  };
  useEffect(() => {
    if (!goingTo) return;
    // Another project was opened before this one loaded: the jump is off.
    if (state.slug !== goingTo.slug) {
      setGoingTo(null);
      return;
    }
    // Its snapshot, holding the step (a step newer than the snapshot waits for the next one).
    if (snapshot?.project.id !== goingTo.projectId || !holds(snapshot, goingTo.id) || !canvas.current) return;
    setGoingTo(null);
    setSelectedNode(goingTo.id);
    canvas.current.goTo(goingTo.id);
  }, [goingTo, snapshot, state.slug]);

  const followOn = useCallback(() => {
    setFollow(true);
    canvas.current?.goFrontier();
  }, []);

  // The viewer covers the canvas, so while it is open only Escape is ours: F/N/Home/End, [ ] and 1-9 go to the browser.
  useKeyboard(
    viewerOpen
      ? { onEscape: () => setViewerResource(null) }
      : {
          onFollow: () => (follow ? setFollow(false) : followOn()),
          onNext: () => canvas.current?.nextNeedsYou(),
          onHome: () => canvas.current?.goRoot(),
          onEnd: () => canvas.current?.goFrontier(),
          onPrevTab: () => stepProject(-1),
          onNextTab: () => stepProject(1),
          onTab: (n) => {
            const tab = tabs[n - 1];
            if (tab) state.selectProject(tab.slug);
          },
          onEscape: () => setSelectedNode(null),
          onGoTo: () => goToField.current?.open(),
        },
  );

  // Before anything has loaded, a failing stream means the server is unreachable: say so instead of "Loading…".
  if (!state.loaded) return <div className="ip-empty">{state.connection === 'reconnecting' ? "Can't reach the InProgress server, retrying…" : 'Loading…'}</div>;
  return (
    <>
      <div className="ip-app" ref={app}>
        <TopBar tabs={tabs} archived={archived} deleted={state.deleted} current={state.slug} onSelect={state.selectProject} onAction={onAction} onRename={onRename} goTo={goToField} onGoTo={goTo} />
        {/* Always there, so the canvas doesn't jump while a project loads: it holds the needs-you pill and Follow. */}
        <SessionRow
          sessions={snapshot?.sessions ?? []}
          onPick={(s) => s.focusNodeId !== null && canvas.current?.focusNode(s.focusNodeId)}
          needsYou={needsYou}
          onNeedsYou={() => canvas.current?.nextNeedsYou()}
          follow={follow}
          onFollow={followOn}
        />
        {snapshot && <UpNext queue={snapshot.project.queue} nodes={snapshot.nodes} sessions={snapshot.sessions} onJump={(id) => canvas.current?.focusNode(id)} />}
        {state.connection === 'reconnecting' && <div className="ip-banner">Reconnecting to InProgress…</div>}
        <main className="ip-main">
          {projects.length === 0 ? (
            <div className="ip-empty">
              {state.deleted.length > 0
                ? 'No projects. Restore one from ⋯, or in a Claude session say "track this in InProgress".'
                : 'No projects yet. In a Claude session, say "track this in InProgress".'}
            </div>
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
              onOpenResource={openViewer}
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
              onOpenResource={openViewer}
            />
          )}
        </main>
        {snapshot && <ActivityStrip event={state.lastEvent} snapshot={snapshot} />}
      </div>
      {/* Outside .ip-app, which turns inert while the viewer is open. */}
      {viewerOpen && <ResourceViewer key={viewerResource} resourceId={viewerResource} onClose={() => setViewerResource(null)} />}
      {/* Always mounted, so a screen reader hears each new line; drawn over the activity strip, not on it. */}
      <div role="status" className="ip-status">
        {status && <div className="ip-toast">{status}</div>}
      </div>
    </>
  );
}
