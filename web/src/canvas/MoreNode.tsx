import { Handle, Position, type Node, type NodeProps } from '@xyflow/react';

export interface MoreNodeData extends Record<string, unknown> {
  count: number;
  /** The far todo tail ("+n more") or a run of old finished steps ("✓ n done"). */
  variant: 'tail' | 'done';
  /** The override that shows the run: `more:<parentId>` or `done:<parentId>`. */
  foldKey: string;
  /** The first node the run hides. It takes focus once the run shows. */
  firstId: number;
  /** Shows the run. */
  onExpand: (foldKey: string, firstId: number) => void;
}

export function MoreNode({ data }: NodeProps<Node<MoreNodeData, 'ipMore'>>) {
  const done = data.variant === 'done';
  return (
    <>
      {/* Outside the button, which may only hold phrasing content. It still anchors to React Flow's node wrapper. */}
      <Handle type="target" position={Position.Left} id="in" className="ip-handle" />
      <button
        className={done ? 'ip-more ip-more-done' : 'ip-more'}
        aria-label={`Show ${data.count} ${done ? 'done' : 'more'}`}
        onClick={(e) => {
          e.stopPropagation();
          data.onExpand(data.foldKey, data.firstId);
        }}
      >
        {done ? (
          <>
            {/* The space keeps the text "✓ n done". The flex row collapses it, so the row's gap spaces the mark. */}
            <span className="ip-more-mark">✓</span> {data.count} done
          </>
        ) : (
          `+${data.count} more`
        )}
      </button>
    </>
  );
}
