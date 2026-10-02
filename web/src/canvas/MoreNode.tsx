import { Handle, Position, type Node, type NodeProps } from '@xyflow/react';

export interface MoreNodeData extends Record<string, unknown> {
  count: number;
  parentId: number;
  /** The first node the run hides. It takes focus once the run shows. */
  firstId: number;
  /** Shows the run. */
  onExpand: (parentId: number, firstId: number) => void;
}

export function MoreNode({ data }: NodeProps<Node<MoreNodeData, 'ipMore'>>) {
  return (
    <>
      {/* Outside the button, which may only hold phrasing content. It still anchors to React Flow's node wrapper. */}
      <Handle type="target" position={Position.Left} id="in" className="ip-handle" />
      <button
        className="ip-more"
        aria-label={`Show ${data.count} more`}
        onClick={(e) => {
          e.stopPropagation();
          data.onExpand(data.parentId, data.firstId);
        }}
      >
        +{data.count} more
      </button>
    </>
  );
}
