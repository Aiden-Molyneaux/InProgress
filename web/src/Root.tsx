import { Component, lazy, Suspense, useSyncExternalStore, type ErrorInfo, type ReactNode } from 'react';
import { App } from './App';
import { isLabHash } from './lab/route';
import { ErrorLine } from './parts/ErrorLine';

/** The parts lab loads as its own chunk, so the window's bundle does not carry it. */
const Lab = lazy(() => import('./lab/Lab'));

/** Watches the hash for the lab's route. */
function subscribe(onChange: () => void): () => void {
  window.addEventListener('hashchange', onChange);
  return () => window.removeEventListener('hashchange', onChange);
}

/** Catches a lab chunk that fails to load (or throws), and offers a reload. The App is never inside it. */
class LabBoundary extends Component<{ children: ReactNode }, { failed: boolean }> {
  state = { failed: false };

  static getDerivedStateFromError(): { failed: boolean } {
    return { failed: true };
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    console.error('The parts lab failed.', error, info.componentStack);
  }

  render() {
    if (this.state.failed) return <ErrorLine message="The parts lab didn't load." onRetry={() => window.location.reload()} />;
    return this.props.children;
  }
}

/**
 * The window, or the parts lab when the hash is `#/lab`. The App is not mounted while the lab shows, so its hash sync
 * never rewrites `#/lab`; leaving the hash mounts the App again.
 */
export function Root() {
  const lab = useSyncExternalStore(subscribe, () => isLabHash(window.location.hash));
  if (!lab) return <App />;
  return (
    <LabBoundary>
      <Suspense fallback={<div className="ip-empty">Loading…</div>}>
        <Lab />
      </Suspense>
    </LabBoundary>
  );
}
