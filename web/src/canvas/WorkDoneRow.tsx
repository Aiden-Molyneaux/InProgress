import type { Node, NodeProps } from '@xyflow/react';

export interface WorkDoneRowData extends Record<string, unknown> {
  nodeId: number;
  count: number;
  /** Whether the completed tasks show. */
  open: boolean;
  onToggleFold: (key: string, value: 'open' | 'closed') => void;
}

/** `✓ n done`: a node's completed working tasks, folded into one row that shows them on a click. */
export function WorkDoneRow({ data }: NodeProps<Node<WorkDoneRowData, 'ipWorkDone'>>) {
  return (
    <button
      className="ip-work-done"
      aria-expanded={data.open}
      title={data.open ? 'Hide the done tasks' : 'Show the done tasks'}
      onClick={(e) => {
        e.stopPropagation();
        data.onToggleFold(`work:${data.nodeId}`, data.open ? 'closed' : 'open');
      }}
    >
      <span className="ip-work-mark">✓</span> {data.count} done
    </button>
  );
}
