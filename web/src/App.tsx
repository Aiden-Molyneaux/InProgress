import { useEffect, useMemo } from 'react';
import { isNeedsYou } from '../../src/core/tree';
import { ActivityStrip } from './chrome/ActivityStrip';
import { SessionRow } from './chrome/SessionRow';
import { TopBar } from './chrome/TopBar';
import { useInProgress } from './useInProgress';

export function App() {
  const state = useInProgress();
  const { snapshot, projects } = state;
  const needsYou = useMemo(() => (snapshot ? snapshot.nodes.filter(isNeedsYou).length : 0), [snapshot]);
  useEffect(() => {
    document.title = `${needsYou ? `(${needsYou}) ` : ''}InProgress${snapshot ? ` — ${snapshot.project.name}` : ''}`;
  }, [needsYou, snapshot]);
  if (!state.loaded) return <div className="ip-empty">Loading…</div>;
  return (
    <div className="ip-app">
      <TopBar projects={projects} current={snapshot?.project ?? null} onSelect={state.selectProject} needsYou={needsYou} onNeedsYou={() => undefined} follow onFollow={() => undefined} />
      {snapshot && <SessionRow sessions={snapshot.sessions} onPick={() => undefined} />}
      {state.connection === 'reconnecting' && <div className="ip-banner">Reconnecting to InProgress…</div>}
      <main className="ip-main">
        {projects.length === 0 ? (
          <div className="ip-empty">No projects yet. In a Claude session, say "track this in InProgress".</div>
        ) : (
          <div className="ip-empty">{snapshot ? `${snapshot.nodes.length} nodes` : 'Loading project…'}</div>
        )}
      </main>
      {snapshot && <ActivityStrip event={state.lastEvent} snapshot={snapshot} />}
    </div>
  );
}
