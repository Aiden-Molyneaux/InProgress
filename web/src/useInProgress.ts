import { useCallback, useEffect, useRef, useState } from 'react';
import { sameBuild, type BuildInfo } from '../../src/core/build';
import { eventTarget } from '../../src/core/layout';
import type { DeletedProject, EventRow, ProjectSnapshot, ProjectSummary } from '../../src/core/types';
import { api } from './api';
import { pickSlug } from './chrome/tabs';
import { patchDeleted, patchName, patchProjects, renamedSnapshot, summaryOf, type ActionTarget, type ProjectAction } from './projectActions';
import { load, save } from './storage';
import { subscribe } from './stream';

const hashSlug = () => /^#\/p\/([^/]+)$/.exec(window.location.hash)?.[1] ?? null;

export interface InProgressState {
  projects: ProjectSummary[];
  /** Projects deleted in the last 30 days, restorable from ⋯. */
  deleted: DeletedProject[];
  slug: string | null;
  snapshot: ProjectSnapshot | null;
  /** Newest event for the activity strip, including the one loaded with the snapshot. */
  lastEvent: EventRow | null;
  /** Only events that arrived live over SSE and have a camera target: the camera follows these, never the loaded one. */
  liveEvent: EventRow | null;
  connection: 'open' | 'reconnecting';
  loaded: boolean;
  selectProject: (slug: string) => void;
  /**
   * Archives, unarchives, deletes or restores a project. When it goes through, the lists change at once and `goTo` opens
   * if the window is still on the target (null: stay, or fall back as when the open project leaves the list), then the
   * lists reload. A 401 reloads the page.
   * Answers 'ok', 'reload', or the server's message.
   */
  act: (action: ProjectAction, target: ActionTarget, goTo: string | null) => Promise<'ok' | 'reload' | string>;
  /**
   * Renames a project. When it goes through, the tab, ⋯ and the window title show the new name at once, then the lists
   * reload. A 401 reloads the page. Answers 'ok', 'reload', or the server's message.
   */
  rename: (target: ActionTarget, name: string) => Promise<'ok' | 'reload' | string>;
}

export function useInProgress(): InProgressState {
  const [projects, setProjects] = useState<ProjectSummary[]>([]);
  const [deleted, setDeleted] = useState<DeletedProject[]>([]);
  const [slug, setSlug] = useState<string | null>(() => hashSlug() ?? load('ip.project'));
  const [snapshot, setSnapshot] = useState<ProjectSnapshot | null>(null);
  const [lastEvent, setLastEvent] = useState<EventRow | null>(null);
  const [liveEvent, setLiveEvent] = useState<EventRow | null>(null);
  const [connection, setConnection] = useState<'open' | 'reconnecting'>('open');
  const [loaded, setLoaded] = useState(false);
  const slugRef = useRef(slug);
  slugRef.current = slug;
  const projectsRef = useRef(projects);
  projectsRef.current = projects;
  /** Numbers list requests, as snapshotSeq does snapshots, so a list fetched before an action never undoes its patch. */
  const listSeq = useRef(0);
  const listApplied = useRef(0);
  const projectIdRef = useRef<number | null>(null);
  projectIdRef.current = snapshot?.project.id ?? null;
  /** Numbers snapshot requests. A response lands when it is newer than the last one applied, so a slow older one never overwrites newer data. */
  const snapshotSeq = useRef(0);
  const appliedSeq = useRef(0);
  /**
   * The window's own deletes, by slug: 'sent' from just before the request until its answer, then 'done' while the
   * window is still on the project, until the switch away has rendered (the slug effect clears it). The server deletes
   * before it answers, and a refresh set off by an event or a reconnect can run in between, reading the slug only when
   * its timer fires. So loadSnapshot never asks for one of these (a deleted project's address answers 404 by design),
   * and loadProjects leaves the window on one for the answer to move on, to the tab beside it.
   */
  const deletes = useRef(new Map<string, 'sent' | 'done'>());
  /**
   * Where the event stream starts, set once by the first load that settles: the first snapshot's lastEventId
   * (spec §7.6), or nothing when there is no snapshot to start from (no projects, or no server yet).
   */
  const [stream, setStream] = useState<{ since?: number } | null>(null);
  const startStream = useCallback((since?: number) => setStream((cur) => cur ?? { since }), []);
  /** The build this page loaded against (undefined until the first health check answers). */
  const pageBuild = useRef<BuildInfo | null | undefined>(undefined);
  /** After `npm run deploy` the stream reconnects to a server running a new build: reload so the UI matches it. */
  const checkBuild = useCallback(async () => {
    const health = await api.health().catch(() => null);
    if (!health) return;
    if (pageBuild.current === undefined) pageBuild.current = health.build;
    else if (!sameBuild(pageBuild.current, health.build)) window.location.reload();
  }, []);

  const loadProjects = useCallback(async () => {
    const seq = ++listSeq.current;
    const [list, gone] = await Promise.all([api.projects().catch(() => null), api.deletedProjects().catch(() => null)]);
    if (seq <= listApplied.current) return;
    if (!list) {
      // Open the stream anyway: its reconnect loop shows that the server is unreachable and retries.
      startStream();
      return;
    }
    listApplied.current = seq;
    setProjects(list);
    if (gone) setDeleted(gone);
    setLoaded(true);
    if (!list.length) startStream();
    // A list the server sent after deleting the open project, landing before the delete's answer, would open the
    // busiest project here. The answer moves the window instead, to the tab beside it.
    setSlug((cur) => (cur !== null && deletes.current.has(cur) ? cur : pickSlug(list, cur)));
  }, [startStream]);

  const loadSnapshot = useCallback(
    async (s: string) => {
      // The delete's answer moves the window on.
      if (deletes.current.has(s)) return;
      const seq = ++snapshotSeq.current;
      const snap = await api.project(s).catch(() => null);
      if (slugRef.current !== s) return;
      if (!snap) {
        // Only the newest request's failure counts. Keep what is on screen. Re-checking the slug moves an unknown
        // one (a stale #/p/ link) to a real project.
        if (seq === snapshotSeq.current) {
          startStream();
          void loadProjects();
        }
        return;
      }
      // Under sustained events a newer request is nearly always in flight: waiting for the newest to land would starve the view.
      if (seq <= appliedSeq.current) return;
      appliedSeq.current = seq;
      startStream(snap.lastEventId);
      setSnapshot(snap);
      setLastEvent((cur) => (cur && cur.projectId === snap.project.id && cur.id >= (snap.lastEvent?.id ?? 0) ? cur : snap.lastEvent));
    },
    [loadProjects, startStream],
  );

  useEffect(() => {
    void loadProjects();
  }, [loadProjects]);

  useEffect(() => {
    // The switch away from a project the window deleted has rendered: slugRef no longer names it.
    for (const [s, state] of deletes.current) if (state === 'done' && s !== slug) deletes.current.delete(s);
    if (!slug) {
      // The last project left the list: nothing of it may stay on screen, and the URL must not name it.
      projectIdRef.current = null;
      setSnapshot(null);
      setLastEvent(null);
      setLiveEvent(null);
      if (window.location.hash) window.history.replaceState(null, '', window.location.pathname + window.location.search);
      return;
    }
    save('ip.project', slug);
    if (window.location.hash !== `#/p/${slug}`) window.history.replaceState(null, '', `#/p/${slug}`);
    setSnapshot(null);
    // A live event belongs to the project it came from: the next project's canvas must not follow it.
    // Clearing the ref now, not at the next render, stops an old project's event slipping in before that render.
    projectIdRef.current = null;
    setLiveEvent(null);
    void loadSnapshot(slug);
  }, [slug, loadSnapshot]);

  useEffect(() => {
    const onHash = () => {
      const s = hashSlug();
      if (s) setSlug(s);
    };
    window.addEventListener('hashchange', onHash);
    return () => window.removeEventListener('hashchange', onHash);
  }, []);

  useEffect(() => {
    if (!stream) return;
    let projectTimer = 0;
    let snapshotTimer = 0;
    const refreshSnapshot = () => {
      window.clearTimeout(snapshotTimer);
      snapshotTimer = window.setTimeout(() => slugRef.current && void loadSnapshot(slugRef.current), 150);
    };
    const refreshProjects = () => {
      window.clearTimeout(projectTimer);
      projectTimer = window.setTimeout(() => void loadProjects(), 400);
    };
    const unsubscribe = subscribe(
      stream.since,
      (e) => {
        refreshProjects();
        if (e.projectId !== null && e.projectId === projectIdRef.current) {
          setLastEvent(e);
          // React can render several events as one batch. Skipping untargeted ones here means one batched after
          // a targeted event can't take the camera's move away.
          if (eventTarget(e) !== undefined) setLiveEvent(e);
          refreshSnapshot();
        } else if (projectIdRef.current === null) {
          // No snapshot yet (a switch in flight): the pending response may predate this event.
          refreshSnapshot();
        }
      },
      (status) => {
        setConnection(status);
        // Refresh on every (re)connect: covers events that landed before the stream opened.
        if (status === 'open') {
          refreshProjects();
          refreshSnapshot();
          void checkBuild();
        }
      },
    );
    return () => {
      unsubscribe();
      window.clearTimeout(projectTimer);
      window.clearTimeout(snapshotTimer);
    };
  }, [stream, loadProjects, loadSnapshot, checkBuild]);

  const act = useCallback(
    async (action: ProjectAction, target: ActionTarget, goTo: string | null) => {
      // Marked before the request: the server may delete it before the answer arrives.
      if (action === 'delete') deletes.current.set(target.slug, 'sent');
      const answer = await api.projectAction(action, target);
      if (answer === 'reload') window.location.reload();
      if (typeof answer === 'string') {
        if (action === 'delete') {
          // Not deleted after all: the window may ask for it again, and makes up any refresh it skipped meanwhile.
          deletes.current.delete(target.slug);
          if (answer !== 'reload' && slugRef.current === target.slug) void loadSnapshot(target.slug);
        }
        return answer;
      }
      if (action === 'delete' || action === 'restore') {
        // The switch below leaves a deleted project the window is on, but a refresh can still read its slug until that
        // renders. Otherwise, and once restored (before the switch, which may open it), it may be asked for again.
        if (action === 'delete' && slugRef.current === target.slug) deletes.current.set(target.slug, 'done');
        else deletes.current.delete(target.slug);
      }
      // One batch: the patched lists and the project to open land together, so no tab jumps on the way. A restored
      // project joins the list now, under ⋯, rather than with the reload.
      const restored = action === 'restore' && answer.project ? summaryOf(answer.project) : undefined;
      const list = patchProjects(projectsRef.current, action, target.id, restored);
      listApplied.current = listSeq.current;
      setProjects(list);
      setDeleted((cur) => patchDeleted(cur, action, target, Date.now()));
      // goTo only while the window is still on the project that left: a switch made during the write stands.
      setSlug((cur) => (goTo !== null && cur === target.slug ? goTo : pickSlug(list, cur)));
      // Reconcile now, not after the stream's 400 ms.
      void loadProjects();
      return 'ok' as const;
    },
    [loadProjects, loadSnapshot],
  );

  const rename = useCallback(
    async (target: ActionTarget, name: string) => {
      const answer = await api.renameProject(target, name);
      if (answer === 'reload') window.location.reload();
      if (typeof answer === 'string') return answer;
      const named = answer.project.name;
      // So a list, or the open project's snapshot, fetched before the rename never undoes the patch.
      listApplied.current = listSeq.current;
      if (projectIdRef.current === target.id) appliedSeq.current = snapshotSeq.current;
      setProjects((cur) => patchName(cur, target.id, named));
      setSnapshot((cur) => renamedSnapshot(cur, target.id, named));
      void loadProjects();
      return 'ok' as const;
    },
    [loadProjects],
  );

  return { projects, deleted, slug, snapshot, lastEvent, liveEvent, connection, loaded, selectProject: setSlug, act, rename };
}
