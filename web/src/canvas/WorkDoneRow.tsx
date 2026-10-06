import { trailLabel } from '../live';

export interface WorkDoneRowProps {
  nodeId: number;
  /** Completed tasks, of live and ended sessions. */
  count: number;
  /** Tasks an ended session left pending or in progress. */
  unfinished: number;
  /** Subagents in the trail on this node. */
  agents: number;
  /** Whether the completed tasks and the trail show. */
  open: boolean;
  onToggleFold: (key: string, value: 'open' | 'closed') => void;
}

/** What the row shows on a click: "the done and unfinished tasks and the agents". */
function contents({ count, unfinished, agents }: WorkDoneRowProps): string {
  const tasks = [count ? 'done' : '', unfinished ? 'unfinished' : ''].filter(Boolean).join(' and ');
  return [tasks ? `the ${tasks} tasks` : '', agents ? `the ${agents === 1 ? 'agent' : 'agents'} that stopped` : ''].filter(Boolean).join(' and ');
}

/**
 * `✓ 5 done · 2 unfinished · 2 agents`: a step's completed working tasks and its trail of ended work, folded into one
 * row that shows them on a click. It sits at the right end of its card's last line, or on a line of its own. Its label
 * is the part that cuts, so the ✓ and the ▸ stay.
 */
export function WorkDoneRow(props: WorkDoneRowProps) {
  const label = trailLabel({ done: props.count, unfinished: props.unfinished, agents: props.agents }).replace(/^✓ /, '');
  return (
    <button
      className="ip-work-done"
      aria-expanded={props.open}
      title={`${props.open ? 'Hide' : 'Show'} ${contents(props)}`}
      onClick={(e) => {
        // It opens the row, not Details.
        e.stopPropagation();
        props.onToggleFold(`work:${props.nodeId}`, props.open ? 'closed' : 'open');
      }}
    >
      <span className="ip-work-mark">✓</span> <span className="ip-work-done-label">{label}</span>
    </button>
  );
}
