import type { CSSProperties } from 'react';
import { Handle, Position, type Node, type NodeProps } from '@xyflow/react';
import { LABEL_GLYPHS, ownerTag, type ResourceMeta, type TreeNode } from '../../../src/core/types';
import { familyVar } from '../family';
import { queueMark } from '../live';

export interface NodeCardData extends Record<string, unknown> {
  node: TreeNode;
  folded: boolean;
  doneCount: number;
  progress: { done: number; total: number } | null;
  needsYou: boolean;
  hasChildren: boolean;
  working: boolean;
  /**
   * Its place in the Up next queue, or null: its number in its owner's list (1 is next), and the owning session's slot,
   * or no owner when it is unowned.
   */
  queue: { pos: number; owner: { slot: number | null } | null } | null;
  resources: ResourceMeta[];
  flash: boolean;
  selected: boolean;
  /** Opens Details, as a click on the card does. */
  onSelect: (id: number) => void;
  onToggleFold: (key: string, value: 'open' | 'closed') => void;
  onOpenResource: (id: number) => void;
}

export function NodeCard({ data }: NodeProps<Node<NodeCardData, 'ipNode'>>) {
  const { node, folded, doneCount, progress, needsYou, hasChildren, working, queue, resources, flash, selected } = data;
  // The type label shows as its glyph only; the word is the chip's tooltip and accessible name.
  const glyph = node.label ? LABEL_GLYPHS[node.label] : undefined;
  const classes = ['ip-node', `st-${node.status}`, needsYou && 'needs-you', working && 'working', flash && 'flash', selected && 'selected', node.parentId === null && 'root']
    .filter(Boolean)
    .join(' ');
  return (
    <div className="ip-row">
      <Handle type="target" position={Position.Left} id="in" className="ip-handle" />
      {/* React Flow's own Enter/Space handling needs selectable nodes, so the card is the tab stop and handles them.
          Keys aimed at the fold chevron inside are the chevron's. */}
      <div
        className={classes}
        title={`#${node.id}`}
        role="button"
        tabIndex={0}
        onKeyDown={(e) => {
          if (e.target !== e.currentTarget || (e.key !== 'Enter' && e.key !== ' ')) return;
          e.preventDefault();
          data.onSelect(node.id);
        }}
      >
        <span className={`ip-marker m-${node.status}${node.kind === 'question' ? ' q' : ''}`}>{node.kind === 'question' ? '?' : ''}</span>
        <span className="ip-title">
          {node.title}
          {folded ? ` · ${doneCount} done` : ''}
        </span>
        {node.label && glyph && (
          <span className={`ip-type l-${node.label}`} role="img" title={node.label} aria-label={node.label}>
            {glyph}
          </span>
        )}
        {/* In a narrow window (styles.css) the resource chips beside the card give way to this one count, which opens
            Details, where every resource is listed. */}
        {resources.length > 0 && (
          <button
            className="ip-res-count"
            title={resources.map((r) => `r${r.id} ${r.title}`).join('\n')}
            aria-label={`${resources.length} ${resources.length === 1 ? 'resource' : 'resources'}`}
            onClick={(e) => {
              e.stopPropagation();
              data.onSelect(node.id);
            }}
          >
            ▤ {resources.length}
          </button>
        )}
        {/* An owned place wears its session's letter and hue (A①); an unowned one stays a neutral numeral (①). */}
        {queue && (
          <span
            className={`ip-queue${queue.owner ? ' owned' : ''}`}
            style={queue.owner ? ({ '--fam': familyVar(queue.owner.slot) } as CSSProperties) : undefined}
            title={queue.owner ? `Up next for ${ownerTag(queue.owner.slot)}: ${queue.pos}` : `Up next, later: ${queue.pos}`}
          >
            {queueMark(queue.pos, queue.owner)}
          </span>
        )}
        {needsYou && <span className="ip-you">YOU</span>}
        {node.status === 'blocked' && <span className="ip-blocked">blocked</span>}
        {progress && <span className="ip-progress">{progress.done}/{progress.total}</span>}
        {hasChildren && (
          <button
            className="ip-chevron"
            aria-label={folded ? 'Unfold' : 'Fold'}
            onClick={(e) => {
              e.stopPropagation();
              data.onToggleFold(`n:${node.id}`, folded ? 'open' : 'closed');
            }}
          >
            {folded ? '▸' : '▾'}
          </button>
        )}
      </div>
      {resources.slice(0, 2).map((r) => (
        <button
          key={r.id}
          className="ip-chip"
          title={`r${r.id} ${r.title}`}
          onClick={(e) => {
            e.stopPropagation();
            data.onOpenResource(r.id);
          }}
        >
          ▤ {r.title}
        </button>
      ))}
      {resources.length > 2 && <span className="ip-chip">+{resources.length - 2}</span>}
      <Handle type="source" position={Position.Bottom} id="out" className="ip-handle" style={{ left: 12 }} />
    </div>
  );
}
