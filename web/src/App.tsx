import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { deriveBoard, isLive } from '../../src/core/board';
import type { StepHit } from '../../src/core/goto';
import { buildIndex, shelvedIds } from '../../src/core/tree';
import type { ProjectSnapshot } from '../../src/core/types';
import { api, postEvent } from './api';
import { Board } from './board/Board';
import { useLastLook } from './board/lastLook';
import { noteAction, noteHidden, noteShown, setPoster } from './measure';
import { Footer } from './chrome/Footer';
import type { GoToHandle } from './chrome/GoTo';
import { Hud, HudEdge } from './chrome/Hud';
import { askTarget } from './chrome/hudLogic';
import { archivedProjects, loadTabOrder, moveTab, neighbourTab, projectTabs, pruneOrder, saveTabOrder, stepTab, TAB_ORDER_KEY } from './chrome/tabs';
import { TopBar } from './chrome/TopBar';
import { BacklogList } from './backlog/BacklogList';
import { DoneList } from './done/DoneList';
import { Details } from './panels/Details';
import { EmptyState } from './parts/EmptyState';
import { Toast, ToastRegion } from './parts/Toast';
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
  const selectedNodeRef = useRef(selectedNode);
  selectedNodeRef.current = selectedNode;
  // A node deleted while Details shows it closes Details: the snapshot before held it, the new one doesn't. A node picked
  // from Details' own lists can be newer than the snapshot on screen, so missing from one snapshot alone doesn't count.
  // Cleared during render, so Details never refetches a node that is gone.
  const [lastSnapshot, setLastSnapshot] = useState(snapshot);
  if (snapshot !== lastSnapshot) {
    setLastSnapshot(snapshot);
    if (selectedNode !== null && snapshot && lastSnapshot && holds(lastSnapshot, selectedNode) && !holds(snapshot, selectedNode)) setSelectedNode(null);
  }
  // Details gives focus back to what opened it, as the viewer does: the element that had focus when it opened, else the
  // title button of the row that opened it.
  const detailsOpener = useRef<{ element: HTMLElement | null; node: number } | null>(null);
  const detailsOpen = selectedNode !== null;
  useLayoutEffect(() => {
    if (detailsOpen) {
      const active = document.activeElement;
      detailsOpener.current = { element: active instanceof HTMLElement && active !== document.body ? active : null, node: selectedNodeRef.current! };
      return;
    }
    const from = detailsOpener.current;
    detailsOpener.current = null;
    // Only when focus went down with Details: a close Aiden did not cause (its step deleted) leaves his focus alone.
    if (!from || (document.activeElement && document.activeElement !== document.body)) return;
    const target = from.element?.isConnected ? from.element : document.querySelector<HTMLElement>(`[data-node="${from.node}"] .ip-row-title`);
    target?.focus();
  }, [detailsOpen]);
  const [viewerResource, setViewerResource] = useState<number | null>(null);
  const viewerOpen = viewerResource !== null;
  const goToField = useRef<GoToHandle>(null);
  const app = useRef<HTMLDivElement>(null);
  /** Whatever had focus when the viewer opened. It gets focus back when the viewer closes. */
  const opener = useRef<HTMLElement | null>(null);
  /** Open asks plus live sessions waiting on a permission: the title's count, as a tab's is (spec 2.1). */
  const waiting = useMemo(
    () => {
      if (!snapshot) return 0;
      // An ask on a shelved step (parked, or under a parked one) is not waiting on Aiden: the Board's Needs me leaves it out too.
      const shelved = shelvedIds(buildIndex(snapshot.nodes));
      return snapshot.asks.filter((a) => a.clearedAt === null && !shelved.has(a.nodeId)).length + snapshot.sessions.filter((s) => s.state === 'permission' && isLive(s, now)).length;
    },
    [snapshot, now],
  );
  // The full done list stands in for the Board while open. Opening it focuses its ‹ Board; going back focuses the Board's
  // All done button, or the Done heading when nothing is done. Only these two moves take focus: a project switch leaves it.
  const [doneOpen, setDoneOpen] = useState(false);
  const doneMoved = useRef(false);
  const openDone = () => {
    noteAction('done', 'all');
    doneMoved.current = true;
    setDoneOpen(true);
  };
  const closeDone = () => {
    doneMoved.current = true;
    setDoneOpen(false);
  };
  useEffect(() => {
    if (!doneMoved.current) return;
    doneMoved.current = false;
    const to = doneOpen ? ['.ip-donelist-back'] : ['.ip-done-all', '.ip-band-done h3'];
    to.map((sel) => document.querySelector<HTMLElement>(sel)).find(Boolean)?.focus();
  }, [doneOpen]);
  // The full Backlog stands in for the Board the same way. Opening it focuses its ‹ Board; going back focuses the preview's
  // "N ›" button. Its filter lives in the view, so leaving it clears the filter.
  const [backlogOpen, setBacklogOpen] = useState(false);
  const backlogMoved = useRef(false);
  const openBacklog = () => {
    noteAction('backlog', 'all');
    backlogMoved.current = true;
    setBacklogOpen(true);
    postEvent('backlog_open', snapshot?.project.id ?? null);
  };
  const closeBacklog = () => {
    backlogMoved.current = true;
    setBacklogOpen(false);
  };
  useEffect(() => {
    if (!backlogMoved.current) return;
    backlogMoved.current = false;
    const to = backlogOpen ? ['.ip-backlogview-back'] : ['.ip-backlog-all', '.ip-band-next h3'];
    to.map((sel) => document.querySelector<HTMLElement>(sel)).find(Boolean)?.focus();
  }, [backlogOpen]);
  const pickView = (v: View) => {
    setDoneOpen(false);
    setBacklogOpen(false);
    if (v === view) return;
    noteAction('header', 'view');
    setView(v);
    saveView(v);
    postEvent('view', snapshot?.project.id ?? null, { view: v });
  };
  // The tabs follow the picked slug, not the loaded snapshot, so a tab lights up on the click and [ ] step on from it.
  // The tab order Aiden dragged, kept in the window's localStorage. A second window follows a move through `storage`.
  const [order, setOrder] = useState(loadTabOrder);
  const tabs = useMemo(() => projectTabs(projects, state.slug, order), [projects, state.slug, order]);
  const orderNow = useRef(order);
  useLayoutEffect(() => {
    orderNow.current = order;
  }, [order]);
  // A project that left the active list (archived, deleted or purged) loses its place, so it returns at the end. Only
  // once the server's list has loaded: the empty list before it would drop every place. It runs when this window's list
  // changes, not when another window's order arrives: that window may already list as active a project this one has
  // not caught up on, and saving the prune would undo its move.
  useEffect(() => {
    if (!state.loaded) return;
    const kept = pruneOrder(orderNow.current, projects);
    if (kept.length < orderNow.current.length) {
      setOrder(kept);
      saveTabOrder(kept);
    }
  }, [projects, state.loaded]);
  useEffect(() => {
    const changed = (e: StorageEvent) => {
      if (e.key === TAB_ORDER_KEY) setOrder(loadTabOrder());
    };
    window.addEventListener('storage', changed);
    return () => window.removeEventListener('storage', changed);
  }, []);
  const onMoveTab = (id: number, before: number | null) => {
    const next = moveTab(tabs, id, before);
    const shown = tabs.filter((t) => t.status === 'active').map((t) => t.id);
    if (next.join() === shown.join()) return;
    setOrder(next);
    saveTabOrder(next);
    noteAction('header', 'tab_move');
  };
  const archived = useMemo(() => archivedProjects(projects), [projects]);
  // ASKS: the open project's Board with focus on Needs me, or the first project in tab order that has asks. The counter
  // moves focus after the Board shows.
  const [needsFocus, setNeedsFocus] = useState(0);
  useEffect(() => {
    if (needsFocus > 0) document.querySelector<HTMLElement>('.ip-band-needs h3')?.focus();
  }, [needsFocus]);
  const onAsks = () => {
    const target = askTarget(tabs, state.slug);
    if (target === null) return;
    pickView('board');
    if (target === 'here') setNeedsFocus((n) => n + 1);
    else state.selectProject(target);
  };
  const stepProject = (step: 1 | -1) => {
    const slug = stepTab(tabs, state.slug, step);
    if (slug) state.selectProject(slug);
  };

  /**
   * The status line, a toast: what an archive, unarchive, rename, delete or restore did, or why it failed. A neutral one
   * goes after four seconds; an alarm one (a failed action) stays until dismissed. A new message replaces the old one.
   */
  const [status, setStatus] = useState<{ id: number; text: string; tone: 'neutral' | 'alarm' } | null>(null);
  const statusId = useRef(0);
  /** What had focus when the toast appeared: an alarm toast's × gives focus back to it. */
  const statusOpener = useRef<HTMLElement | null>(null);
  const say = (text: string, tone: 'neutral' | 'alarm' = 'neutral') => {
    const active = document.activeElement;
    // Focus inside the toasts keeps the opener it had; focus nowhere forgets an older one, so × never jumps to it.
    if (!(active instanceof HTMLElement) || active === document.body) statusOpener.current = null;
    else if (!active.closest('.p-toasts')) statusOpener.current = active;
    setStatus({ id: ++statusId.current, text, tone });
  };
  /** The surfaces report only failures: those stay up, in alarm, until dismissed. */
  const fail = (text: string) => say(text, 'alarm');
  /** Only the toast still showing goes: a timer that fires as a new message lands leaves the new one up. */
  const dismiss = (id: number) => {
    const from = document.activeElement;
    if (from instanceof HTMLElement && from.closest('.p-toasts') && statusOpener.current?.isConnected) statusOpener.current.focus();
    setStatus((s) => (s?.id === id ? null : s));
  };
  const onAction = async (action: ProjectAction, target: ActionTarget): Promise<boolean> => {
    // Picked before the write: archiving or deleting the open project opens the tab beside it, as a browser does when a
    // tab closes. With none, an archived project stays open as the end tab and a deleted one falls back.
    const leaving = (action === 'archive' || action === 'delete') && target.slug === state.slug;
    const result = await state.act(action, target, leaving ? neighbourTab(tabs, target.slug) : null);
    if (result === 'reload') return false;
    say(result === 'ok' ? actionMessage(action, target.name) : result, result === 'ok' ? 'neutral' : 'alarm');
    return result === 'ok';
  };
  const onRename = async (target: ActionTarget, name: string): Promise<boolean> => {
    const result = await state.rename(target, name);
    if (result === 'reload') return false;
    say(result === 'ok' ? renameMessage(name) : result, result === 'ok' ? 'neutral' : 'alarm');
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
  const hud = (loaded: boolean) => (
    <>
      <Hud loaded={loaded} connection={state.connection} projects={projects} tabs={tabs} current={state.slug} snapshot={snapshot} now={now} goTo={goToField} onGoTo={goTo} onBoard={() => pickView('board')} onAsks={onAsks} />
      <HudEdge connection={state.connection} />
    </>
  );
  if (!state.loaded) {
    const unreachable = state.connection === 'reconnecting';
    return (
      <div className="ip-app">
        {hud(false)}
        <main className="ip-main">
          <EmptyState className="ip-wait" data-alarm={unreachable || undefined}>
            {unreachable ? "Can't reach the InProgress server, retrying…" : 'Loading…'}
          </EmptyState>
        </main>
      </div>
    );
  }
  return (
    <>
      <div className="ip-app" ref={app}>
        {hud(true)}
        <TopBar tabs={tabs} archived={archived} deleted={state.deleted} current={state.slug} onSelect={state.selectProject} onAction={onAction} onRename={onRename} onMove={onMoveTab} view={view} onView={pickView} />
        <main className="ip-main">
          {projects.length === 0 ? (
            <EmptyState className="ip-wait">
              {state.deleted.length > 0
                ? 'No projects. Restore one from ⋯, or in a Claude session say "track this in InProgress".'
                : 'No projects yet. A Claude session adds one when it opts in.'}
            </EmptyState>
          ) : snapshot ? (
            view === 'board' && backlogOpen ? (
              <BacklogList key={snapshot.project.id} snapshot={snapshot} now={now} onOpenNode={setSelectedNode} onOpenResource={openViewer} onStatus={fail} onBack={closeBacklog} />
            ) : view === 'board' && doneOpen ? (
              <DoneList key={snapshot.project.id} snapshot={snapshot} now={now} onOpenNode={setSelectedNode} onOpenResource={openViewer} onBack={closeDone} />
            ) : view === 'board' ? (
              <Board key={snapshot.project.id} snapshot={snapshot} now={now} onOpenNode={setSelectedNode} onOpenResource={openViewer} onOpenDone={openDone} onOpenBacklog={openBacklog} lastLook={lastLook} onStatus={fail} />
            ) : (
              <ProjectView key={snapshot.project.id} snapshot={snapshot} now={now} onOpenNode={setSelectedNode} onOpenResource={openViewer} onStatus={fail} />
            )
          ) : (
            <EmptyState className="ip-wait">Loading project…</EmptyState>
          )}
          {snapshot && selectedNode !== null && (
            <Details
              key={selectedNode}
              nodeId={selectedNode}
              snapshot={snapshot}
              onClose={() => setSelectedNode(null)}
              onSelectNode={setSelectedNode}
              onOpenResource={openViewer}
              onStatus={fail}
            />
          )}
        </main>
        <Footer event={state.lastEvent} snapshot={snapshot} tabs={tabs.length} closable={detailsOpen || viewerOpen} />
      </div>
      {/* Outside .ip-app, which turns inert while the viewer is open. */}
      {viewerOpen && <ResourceViewer key={viewerResource} resourceId={viewerResource} onClose={() => setViewerResource(null)} />}
      {/* Always mounted, so a screen reader hears each new line. */}
      <ToastRegion>
        {status && (
          <Toast key={status.id} tone={status.tone} onDismiss={() => dismiss(status.id)}>
            {status.text}
          </Toast>
        )}
      </ToastRegion>
    </>
  );
}
