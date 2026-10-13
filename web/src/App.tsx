import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { deriveBoard, isLive } from '../../src/core/board';
import type { StepHit } from '../../src/core/goto';
import type { ProjectSnapshot } from '../../src/core/types';
import { api, postEvent } from './api';
import { Board } from './board/Board';
import { useLastLook } from './board/lastLook';
import { noteHidden, noteShown, setPoster } from './measure';
import { ActivityStrip } from './chrome/ActivityStrip';
import type { GoToHandle } from './chrome/GoTo';
import { archivedProjects, neighbourTab, projectTabs, stepTab } from './chrome/tabs';
import { TopBar } from './chrome/TopBar';
import { Details } from './panels/Details';
import { ResourceViewer } from './panels/ResourceViewer';
import { ProjectView } from './project/ProjectView';
import { actionMessage, renameMessage, type ActionTarget, type ProjectAction } from './projectActions';
import { useInProgress } from './useInProgress';
import { useKeyboard } from './useKeyboard';
import { useNow } from './useNow';
import { loadView, saveView, type View } from './views/view';

// The measurements go out through the window's own event post.
setPoster(postEvent);

const holds = (snapshot: ProjectSnapshot, id: number) => snapshot.nodes.some((n) => n.id === id);

export function App() {
  const state = useInProgress();
  const { snapshot, projects } = state;
  const [view, setView] = useState<View>(loadView);
  const now = useNow(30_000);
  const lastLook = useLastLook(snapshot?.project.id ?? null);
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
  const goToField = useRef<GoToHandle>(null);
  const app = useRef<HTMLDivElement>(null);
  /** Whatever had focus when the viewer opened. It gets focus back when the viewer closes. */
  const opener = useRef<HTMLElement | null>(null);
  /** Open asks plus live sessions waiting on a permission: the title's count, as a tab's is (spec 2.1). */
  const waiting = useMemo(
    () => (snapshot ? snapshot.asks.filter((a) => a.clearedAt === null).length + snapshot.sessions.filter((s) => s.state === 'permission' && isLive(s, now)).length : 0),
    [snapshot, now],
  );
  const pickView = (v: View) => {
    setView(v);
    saveView(v);
    postEvent('view', snapshot?.project.id ?? null, { view: v });
  };
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

  // Coming back to the window (spec 2.6): shown or focused again. The handler reads the latest state through a ref.
  const shownNow = useRef({ snapshot, view });
  shownNow.current = { snapshot, view };
  useEffect(() => {
    const shown = () => {
      const { snapshot: s, view: v } = shownNow.current;
      if (!s) return;
      noteShown(s.project.id, v, deriveBoard(s, Date.now()).marked.length);
    };
    const onVisible = () => {
      if (document.visibilityState === 'visible') shown();
      else noteHidden();
    };
    const hidden = () => noteHidden();
    window.addEventListener('focus', shown);
    window.addEventListener('blur', hidden);
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      window.removeEventListener('focus', shown);
      window.removeEventListener('blur', hidden);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, []);
  useEffect(() => {
    document.title = `${waiting ? `(${waiting}) ` : ''}InProgress${snapshot ? ` · ${snapshot.project.name}` : ''}`;
  }, [waiting, snapshot]);
  useEffect(() => {
    setSelectedNode(null);
    setViewerResource(null);
  }, [snapshot?.project.id]);

  /**
   * A step picked in the Go to field, until the window shows its project with the step in it. Declared after the
   * effect above, so on a switch the selection that effect clears is set again here, in the same commit.
   */
  const [goingTo, setGoingTo] = useState<{ id: number; projectId: number; slug: string } | null>(null);
  const goingRef = useRef(goingTo);
  goingRef.current = goingTo;
  /** The jump whose step the snapshot lacked, checked with the server once so a stale snapshot never drops it. */
  const checked = useRef<typeof goingTo>(null);
  const goTo = (hit: StepHit) => {
    setGoingTo({ id: hit.id, projectId: hit.projectId, slug: hit.projectSlug });
    if (hit.projectSlug !== state.slug) state.selectProject(hit.projectSlug);
  };
  useEffect(() => {
    const going = goingTo;
    if (!going) return;
    const drop = () => {
      setGoingTo(null);
      say(`No step #${going.id}`);
    };
    if (state.slug !== going.slug) {
      setGoingTo(null);
      // The project left the list (deleted since the search, so its address answered 404) and the window moved on. A
      // project Aiden opened himself before this one loaded only calls the jump off.
      if (!projects.some((p) => p.slug === going.slug)) drop();
      return;
    }
    if (snapshot?.project.id !== going.projectId) return;
    if (!holds(snapshot, going.id)) {
      // Gone since the search, or newer than this snapshot: the server knows which. A newer one waits for the next.
      if (checked.current === going) return;
      checked.current = going;
      api.node(going.id).then(
        (d) => d.node.projectId !== going.projectId && goingRef.current === going && drop(),
        () => goingRef.current === going && drop(),
      );
      return;
    }
    setGoingTo(null);
    // The step's Details open over whichever view is showing.
    setSelectedNode(going.id);
  }, [goingTo, snapshot, state.slug, projects]);

  // The viewer covers the window, so while it is open only Escape is ours: [ ] and 1-9 go to the browser.
  useKeyboard(
    viewerOpen
      ? { onEscape: () => setViewerResource(null) }
      : {
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
        <TopBar tabs={tabs} archived={archived} deleted={state.deleted} current={state.slug} onSelect={state.selectProject} onAction={onAction} onRename={onRename} goTo={goToField} onGoTo={goTo} view={view} onView={pickView} />
        {state.connection === 'reconnecting' && <div className="ip-banner">Reconnecting to InProgress…</div>}
        <main className="ip-main">
          {projects.length === 0 ? (
            <div className="ip-empty">
              {state.deleted.length > 0
                ? 'No projects. Restore one from ⋯, or in a Claude session say "track this in InProgress".'
                : 'No projects yet. In a Claude session, say "track this in InProgress".'}
            </div>
          ) : snapshot ? (
            view === 'board' ? (
              <Board key={snapshot.project.id} snapshot={snapshot} now={now} onOpenNode={setSelectedNode} onOpenResource={openViewer} onOpenProject={() => pickView('project')} lastLook={lastLook} onStatus={say} />
            ) : (
              <ProjectView key={snapshot.project.id} snapshot={snapshot} now={now} onOpenNode={setSelectedNode} onOpenResource={openViewer} onStatus={say} />
            )
          ) : (
            <div className="ip-empty">Loading project…</div>
          )}
          {snapshot && selectedNode !== null && (
            <Details
              key={selectedNode}
              nodeId={selectedNode}
              snapshot={snapshot}
              onClose={() => setSelectedNode(null)}
              onSelectNode={setSelectedNode}
              onOpenResource={openViewer}
              onStatus={say}
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
