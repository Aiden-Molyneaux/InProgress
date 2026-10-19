import type { BoardRow } from '../../../src/core/board';
import { sessionDisplayTitle, type TreeNode } from '../../../src/core/types';
import { LiveDot } from '../parts/LiveDot';
import { Marker } from '../parts/Marker';

/** The marks the left column draws, and the key to them. */
export type PositionKind = 'live' | 'idle' | 'queue' | 'own' | 'backlog' | 'parked' | 'done';

/** One mark. `label` is its accessible name; a mark in the key passes none and is hidden, its word being beside it. */
export function PositionMark({ kind, number, label, title }: { kind: PositionKind; number?: number; label?: string; title?: string }) {
  const named = label ? { role: 'img', 'aria-label': label } : { 'aria-hidden': true as const };
  switch (kind) {
    case 'live':
      return <span className="ip-pm" {...named}><LiveDot /></span>;
    case 'idle':
      return <span className="ip-pm ip-pm-idle" {...named} />;
    case 'queue':
      return <span className="ip-pm ip-pm-num" {...named}>{number ?? 0}</span>;
    case 'own':
      return <span className="ip-pm ip-pm-own" title={title} {...named}>◆</span>;
    case 'backlog':
      return <span className="ip-pm ip-pm-backlog" {...named} />;
    case 'parked':
      return <span className="ip-pm" title={title} {...named}><Marker status="parked" question={false} paused={false} needsYou={false} pulse={false} /></span>;
    default:
      return <span className="ip-pm ip-pm-done" {...named}>✓</span>;
  }
}

/** The mark for a step's row: where it stands in the position rail (a parked step shows its own mark). */
export function RowMark({ node, row }: { node: TreeNode; row: BoardRow | null }) {
  if (node.status === 'parked') return <PositionMark kind="parked" title="Parked" />;
  if (!row) return null;
  switch (row.column) {
    case 'now':
      return row.sessions.length > 0 ? <PositionMark kind="live" label="now, a session is on it" /> : <PositionMark kind="idle" label="now, no session" />;
    case 'next': {
      const owner = row.owner;
      return owner ? (
        <PositionMark kind="own" label={`next, in the own queue of "${sessionDisplayTitle(owner)}"`} title={sessionDisplayTitle(owner)} />
      ) : (
        <PositionMark kind="queue" number={row.queueNumber ?? 0} label={`next, number ${row.queueNumber ?? 0}`} />
      );
    }
    case 'backlog':
      return <PositionMark kind="backlog" label="backlog" />;
    default:
      return <PositionMark kind="done" label="done" />;
  }
}
