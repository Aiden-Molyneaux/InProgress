import { Handle, Position, type Node, type NodeProps } from '@xyflow/react';

export interface MoreNodeData extends Record<string, unknown> {
  count: number;
  parentId: number;
  onToggleFold: (key: string, value: 'open' | 'closed') => void;
}

export function MoreNode({ data }: NodeProps<Node<MoreNodeData, 'ipMore'>>) {
  return (
    <div
      className="ip-more"
      onClick={(e) => {
        e.stopPropagation();
        data.onToggleFold(`more:${data.parentId}`, 'open');
      }}
    >
      <Handle type="target" position={Position.Left} id="in" className="ip-handle" />+{data.count} more
    </div>
  );
}
