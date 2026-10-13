import { useEffect, useRef, useState } from 'react';
import { load, save } from '../storage';

/** The page's window and document, read through globalThis so a unit test (no DOM types) can compile this file. */
interface Page {
  addEventListener(type: string, fn: () => void): void;
  removeEventListener(type: string, fn: () => void): void;
  document: { visibilityState: string; addEventListener(type: string, fn: () => void): void; removeEventListener(type: string, fn: () => void): void };
}
const page = (): Page => globalThis as unknown as Page;

const key = (projectId: number) => `ip.look.${projectId}`;

/** The last time Aiden left this project's tab, blurred or hid the window (spec 1.7). Null when never, or when what is stored is not a time. */
export function loadLastLook(projectId: number): string | null {
  const raw = load(key(projectId));
  return raw && !Number.isNaN(Date.parse(raw)) ? raw : null;
}

export function saveLastLook(projectId: number, iso: string): void {
  save(key(projectId), iso);
}

/**
 * Installs the leave listeners (tab change, window blur, the page hiding) for the current project and returns the time
 * the "new since you looked" divider sits at until the next leave. A project's time is read when it opens, so the
 * divider stays put while Aiden works in the window.
 */
export function useLastLook(projectId: number | null): string | null {
  const [held, setHeld] = useState<{ id: number | null; look: string | null }>({ id: projectId, look: projectId === null ? null : loadLastLook(projectId) });
  const idRef = useRef(projectId);
  const previous = useRef(projectId);
  idRef.current = projectId;
  // Leaving the tab: the project it was is stamped, and the new one's time is read.
  useEffect(() => {
    if (previous.current === projectId) return;
    if (previous.current !== null) saveLastLook(previous.current, new Date().toISOString());
    previous.current = projectId;
    // Coming back to a project reads the time stamped when it was left, not the one held from before.
    setHeld({ id: projectId, look: projectId === null ? null : loadLastLook(projectId) });
  }, [projectId]);
  useEffect(() => {
    const leave = () => {
      const id = idRef.current;
      if (id === null) return;
      const at = new Date().toISOString();
      saveLastLook(id, at);
      setHeld({ id, look: at });
    };
    const onVisibility = () => {
      if (page().document.visibilityState === 'hidden') leave();
    };
    page().addEventListener('blur', leave);
    page().document.addEventListener('visibilitychange', onVisibility);
    return () => {
      page().removeEventListener('blur', leave);
      page().document.removeEventListener('visibilitychange', onVisibility);
    };
  }, []);
  if (projectId === null) return null;
  return held.id === projectId ? held.look : loadLastLook(projectId);
}
