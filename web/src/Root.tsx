import { lazy, Suspense, useSyncExternalStore } from 'react';
import { App } from './App';
import { isLabHash } from './lab/route';

/** The parts lab loads as its own chunk, so the window's bundle does not carry it. */
const Lab = lazy(() => import('./lab/Lab'));

/** Watches the hash for the lab's route. */
function subscribe(onChange: () => void): () => void {
  window.addEventListener('hashchange', onChange);
  return () => window.removeEventListener('hashchange', onChange);
}

/**
 * The window, or the parts lab when the hash is `#/lab`. The App is not mounted while the lab shows, so its hash sync
 * never rewrites `#/lab`; leaving the hash mounts the App again.
 */
export function Root() {
  const lab = useSyncExternalStore(subscribe, () => isLabHash(window.location.hash));
  if (!lab) return <App />;
  return (
    <Suspense fallback={<div className="ip-empty">Loading…</div>}>
      <Lab />
    </Suspense>
  );
}
