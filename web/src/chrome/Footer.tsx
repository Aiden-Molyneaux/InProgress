import { useEffect, useState } from 'react';
import { isLive } from '../../../src/core/board';
import type { BuildInfo } from '../../../src/core/build';
import type { EventRow, ProjectSnapshot } from '../../../src/core/types';
import { api } from '../api';
import { actorLabel, describeEvent } from '../describe';
import { KeyHint } from '../parts/KeyHint';
import { LiveDot } from '../parts/LiveDot';
import { relativeTime } from '../time';
import { useNow } from '../useNow';
import { Backups } from './Backups';
import { footerKeys, serverLine } from './hudLogic';
import { useMenuOpen } from './useMenuOpen';

/**
 * The latest change on one line: `↳ actor · when · what`, after a live dot while a session works in the project. Only the
 * event shrinks, cut short with an ellipsis. With no project there is no event to name.
 */
function Activity({ event, snapshot }: { event: EventRow | null; snapshot: ProjectSnapshot | null }) {
  const now = useNow(30_000);
  const working = snapshot?.sessions.some((s) => s.state === 'working' && isLive(s, now)) ?? false;
  const dot = working && <LiveDot />;
  if (!event || !snapshot)
    return (
      <div className="ip-activity muted">
        {dot}
        No activity yet
      </div>
    );
  return (
    <div className="ip-activity" title={event.ts}>
      {dot}
      <span aria-hidden="true">↳ </span>
      <span className="ip-act-who">{actorLabel(event, snapshot)}</span>
      {' · '}
      <span className="ip-act-when">{relativeTime(event.ts, now)}</span>
      {' · '}
      <span className="ip-act-what">{describeEvent(event, snapshot)}</span>
    </div>
  );
}

export interface FooterProps {
  event: EventRow | null;
  snapshot: ProjectSnapshot | null;
  /** How many project tabs there are: `[ ]` shows with two or more. */
  tabs: number;
  /** Details or the viewer is open: Esc closes it. A menu open anywhere adds to this. */
  closable: boolean;
}

/** The line along the bottom: the latest change, the key hints, and which server and build the window talks to. */
export function Footer({ event, snapshot, tabs, closable }: FooterProps) {
  const menuOpen = useMenuOpen();
  // The build is read once; a failed read leaves the host alone on the line.
  const [build, setBuild] = useState<BuildInfo | null>(null);
  useEffect(() => {
    let live = true;
    api.health().then(
      (h) => live && setBuild(h.build),
      () => undefined, // The server line then shows the host alone, which is all there is to say.
    );
    return () => {
      live = false;
    };
  }, []);
  return (
    <footer className="ip-footer">
      <Activity event={event} snapshot={snapshot} />
      <div className="ip-footer-keys">
        {footerKeys({ tabs, escapable: closable || menuOpen }).map((k) => (
          <KeyHint key={k.label} keys={k.keys} label={k.label} />
        ))}
      </div>
      <Backups />
      <span className="ip-footer-server" title={build ? `Built ${build.builtAt}` : undefined}>
        {serverLine(window.location.host, build)}
      </span>
    </footer>
  );
}
