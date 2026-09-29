import { useCallback, useEffect, useRef, useState } from 'react';
import { eventTarget } from '../../src/core/layout';
import type { EventRow, ProjectSnapshot, ProjectSummary } from '../../src/core/types';
import { api } from './api';
import { load, save } from './storage';
import { subscribe } from './stream';

const hashSlug = () => /^#\/p\/([^/]+)$/.exec(window.location.hash)?.[1] ?? null;

export interface InProgressState {
  projects: ProjectSummary[];
  slug: string | null;
  snapshot: ProjectSnapshot | null;
  /** Newest event for the activity strip, including the one loaded with the snapshot. */
  lastEvent: EventRow | null;
  /** Only events that arrived live over SSE and have a camera target: the camera follows these, never the loaded one. */
  liveEvent: EventRow | null;
  connection: 'open' | 'reconnecting';
  loaded: boolean;
  selectProject: (slug: string) => void;
}

export function useInProgress(): InProgressState {
  const [projects, setProjects] = useState<ProjectSummary[]>([]);
  const [slug, setSlug] = useState<string | null>(() => hashSlug() ?? load('ip.project'));
  const [snapshot, setSnapshot] = useState<ProjectSnapshot | null>(null);
  const [lastEvent, setLastEvent] = useState<EventRow | null>(null);
  const [liveEvent, setLiveEvent] = useState<EventRow | null>(null);
  const [connection, setConnection] = useState<'open' | 'reconnecting'>('open');
  const [loaded, setLoaded] = useState(false);
  const slugRef = useRef(slug);
  slugRef.current = slug;
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

  const loadProjects = useCallback(async () => {
    const list = await api.projects().catch(() => null);
    if (!list) {
      // Open the stream anyway: its reconnect loop shows that the server is unreachable and retries.
      startStream();
      return;
    }
    setProjects(list);
    setLoaded(true);
    if (!list.length) startStream();
    setSlug((cur) => (cur && list.some((p) => p.slug === cur) ? cur : (list.find((p) => p.status === 'active') ?? list[0])?.slug ?? null));
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
    if (!slug) return;
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
        }
      },
    );
    return () => {
      unsubscribe();
      window.clearTimeout(projectTimer);
      window.clearTimeout(snapshotTimer);
    };
  }, [stream, loadProjects, loadSnapshot]);

  return { projects, slug, snapshot, lastEvent, liveEvent, connection, loaded, selectProject: setSlug };
}
