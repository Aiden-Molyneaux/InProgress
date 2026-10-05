import type { Node, NodeProps } from '@xyflow/react';
import { trailLabel } from '../live';

export interface WorkDoneRowData extends Record<string, unknown> {
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
function contents({ count, unfinished, agents }: WorkDoneRowData): string {
  const tasks = [count ? 'done' : '', unfinished ? 'unfinished' : ''].filter(Boolean).join(' and ');
  return [tasks ? `the ${tasks} tasks` : '', agents ? `the ${agents === 1 ? 'agent' : 'agents'} that stopped` : ''].filter(Boolean).join(' and ');
}

/**
 * `✓ 5 done · 2 unfinished · 2 agents`: a node's completed working tasks and its trail of ended work, folded into one
 * row that shows them on a click.
 */
export function WorkDoneRow({ data }: NodeProps<Node<WorkDoneRowData, 'ipWorkDone'>>) {
  const label = trailLabel({ done: data.count, unfinished: data.unfinished, agents: data.agents }).replace(/^✓ /, '');
  return (
    <button
      className="ip-work-done"
      aria-expanded={data.open}
      title={`${data.open ? 'Hide' : 'Show'} ${contents(data)}`}
      onClick={(e) => {
        e.stopPropagation();
        data.onToggleFold(`work:${data.nodeId}`, data.open ? 'closed' : 'open');
      }}
    >
      <span className="ip-work-mark">✓</span> {label}
    </button>
  );
}
