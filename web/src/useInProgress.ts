import { useCallback, useEffect, useRef, useState } from 'react';
import { sameBuild, type BuildInfo } from '../../src/core/build';
import { eventTarget } from '../../src/core/layout';
import type { DeletedProject, EventRow, ProjectSnapshot, ProjectSummary } from '../../src/core/types';
import { api } from './api';
import { pickSlug } from './chrome/tabs';
import { patchDeleted, patchProjects, type ActionTarget, type ProjectAction } from './projectActions';
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
   * (null: stay, or fall back as when the open project leaves the list), then the lists reload. A 401 reloads the page.
   * Answers 'ok', 'reload', or the server's message.
   */
  act: (action: ProjectAction, target: ActionTarget, goTo: string | null) => Promise<'ok' | 'reload' | string>;
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
    setSlug((cur) => pickSlug(list, cur));
  }, [startStream]);

  const loadSnapshot = useCallback(
    async (s: string) => {
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
      const result = await api.projectAction(action, target);
      if (result === 'reload') window.location.reload();
      if (result !== 'ok') return result;
      // One batch: the patched lists and the project to open land together, so no tab jumps on the way.
      const list = patchProjects(projectsRef.current, action, target.id);
      listApplied.current = listSeq.current;
      setProjects(list);
      setDeleted((cur) => patchDeleted(cur, action, target, Date.now()));
      setSlug((cur) => goTo ?? pickSlug(list, cur));
      // Reconcile now, not after the stream's 400 ms.
      void loadProjects();
      return result;
    },
    [loadProjects],
  );

  return { projects, deleted, slug, snapshot, lastEvent, liveEvent, connection, loaded, selectProject: setSlug, act };
}
