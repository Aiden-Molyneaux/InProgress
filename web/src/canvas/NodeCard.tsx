import type { CSSProperties } from 'react';
import { Handle, Position, type Node, type NodeProps } from '@xyflow/react';
import { NODE_H } from '../../../src/core/layout';
import { LABEL_GLYPHS, ownerTag, type ResourceMeta, type TreeNode } from '../../../src/core/types';
import { familyVar } from '../family';
import { circled } from '../live';
import { Marker } from '../Marker';
import { AgentLine, type AgentLineProps } from './AgentLine';
import { CommandLine, type CommandLineProps } from './CommandLine';
import { ReadersRow, type ReadersRowProps } from './ReadersRow';
import { TrailAgentRow, type TrailAgentRowProps } from './TrailAgentRow';
import { WorkDoneRow, type WorkDoneRowProps } from './WorkDoneRow';
import { WorkRow, type WorkRowProps } from './WorkRow';

/** One line inside a card, from a layout row item, in layout's order. A done row that shares a line rides on its `done`. */
export type CardRow =
  | { kind: 'line'; id: string; props: AgentLineProps }
  | { kind: 'readers'; id: string; props: ReadersRowProps }
  | { kind: 'commands'; id: string; props: CommandLineProps }
  | { kind: 'workDone'; id: string; props: WorkDoneRowProps }
  | { kind: 'work'; id: string; props: WorkRowProps }
  | { kind: 'trailAgent'; id: string; props: TrailAgentRowProps };

export interface NodeCardData extends Record<string, unknown> {
  node: TreeNode;
  folded: boolean;
  doneCount: number;
  progress: { done: number; total: number } | null;
  needsYou: boolean;
  /** How long a needs-you item has waited (needsYouAge), or null: its YOU tag reads "YOU · 3d". */
  age: string | null;
  hasChildren: boolean;
  /**
   * On a live step's chain (a running worker or reader, a counting command, a pulsing task, a working session's focus) or
   * a working focus: an active marker pulses.
   */
  working: boolean;
  /** An active step nobody is on (LayoutNodeItem.paused): its marker draws hollow, with `lastChange` in its tooltip. */
  paused: boolean;
  /** When the step last changed, as relativeTime puts it ("3 d ago"). */
  lastChange: string;
  /**
   * Its place in the Up next queue, or null: its number in its owner's list (1 is next), and the owning session's slot,
   * or no owner when it is unowned.
   */
  queue: { pos: number; owner: { slot: number | null } | null } | null;
  resources: ResourceMeta[];
  flash: boolean;
  selected: boolean;
  /** Its flow x (LayoutNodeItem.x): the queue gutter sits at a fixed flow x, whatever the card's indent. */
  x: number;
  /** Its frame's width and height, from layout (LayoutNodeItem.w and .h). */
  w: number;
  h: number;
  /** A depth-1 phase (LayoutNodeItem.stack): an unframed stack head with a progress track. */
  stack: boolean;
  /** A working session's focus (LayoutNodeItem.workingFocus): the orange hairline, the active fill, the large title. */
  workingFocus: boolean;
  /** Work runs on this step or under a fold (LayoutNodeItem.live): the hairline and fill of the focus, the title at the normal size. */
  live: boolean;
  /** Its lines: agent, readers and commands lines, a done row on a line of its own, task rows, trail rows. */
  rows: CardRow[];
  /** Opens Details, as a click on the card does. */
  onSelect: (id: number) => void;
  onToggleFold: (key: string, value: 'open' | 'closed') => void;
  onOpenResource: (id: number) => void;
}

function CardLine({ row }: { row: CardRow }) {
  switch (row.kind) {
    case 'line':
      return <AgentLine {...row.props} />;
    case 'readers':
      return <ReadersRow {...row.props} />;
    case 'commands':
      return <CommandLine {...row.props} />;
    case 'workDone':
      return <WorkDoneRow {...row.props} />;
    case 'work':
      return <WorkRow {...row.props} />;
    case 'trailAgent':
      return <TrailAgentRow {...row.props} />;
  }
}

/**
 * A step: its frame, holding its header and then its lines. A depth-1 phase draws as an unframed stack head with its
 * progress track. The header is the tab stop and carries every state class; the frame draws the look. From 720 px the
 * first two resources sit beside the frame.
 */
export function NodeCard({ data }: NodeProps<Node<NodeCardData, 'ipNode'>>) {
  const { node, folded, doneCount, progress, needsYou, age, hasChildren, working, paused, lastChange, queue, resources, flash, selected, x, w, h, stack, workingFocus, live, rows } = data;
  // The type label shows as its glyph only; the word is the chip's tooltip and accessible name.
  const glyph = node.label ? LABEL_GLYPHS[node.label] : undefined;
  // A paused step keeps st-active (its stored status); `paused` only changes how its marker draws.
  const classes = ['ip-node', `st-${node.status}`, stack && 'stack', needsYou && 'needs-you', working && 'working', paused && 'paused', flash && 'flash', selected && 'selected', node.parentId === null && 'root']
    .filter(Boolean)
    .join(' ');
  const frame = ['ip-card', `st-${node.status}`, stack && 'stack', workingFocus && 'focus', live && !workingFocus && 'live', flash && 'flash', selected && 'selected'].filter(Boolean).join(' ');
  const marker = (
    <Marker
      status={node.status}
      question={node.kind === 'question'}
      paused={paused}
      needsYou={needsYou}
      pulse={working}
      title={paused ? `Nobody is on this. Last change ${lastChange}` : undefined}
    />
  );
  return (
    <div className="ip-row" style={{ '--x': `${x}px` } as CSSProperties}>
      {/* Pinned at the header's middle, not the middle of a tall card. */}
      <Handle type="target" position={Position.Left} id="in" className="ip-handle" style={{ top: NODE_H / 2 }} />
      <div className={frame} style={{ width: w, height: h }}>
        {/* React Flow's own Enter/Space handling needs selectable nodes, so the header is the tab stop and handles them.
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
          {stack ? marker : <span className="ip-node-col">{marker}</span>}
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
          {/* In the gutter left of the card (styles.css). An owned place wears its session's letter and hue (A①); an
              unowned one stays a neutral numeral (①). */}
          {queue && (
            <span
              className={`ip-queue${queue.owner ? ' owned' : ''}`}
              style={queue.owner ? ({ '--fam': familyVar(queue.owner.slot) } as CSSProperties) : undefined}
              title={queue.owner ? `Up next for ${ownerTag(queue.owner.slot)}: ${queue.pos}` : `Up next, later: ${queue.pos}`}
            >
              {queue.owner ? (
                <>
                  <span>{ownerTag(queue.owner.slot)}</span>
                  <span>{circled(queue.pos)}</span>
                </>
              ) : (
                circled(queue.pos)
              )}
            </span>
          )}
          {needsYou && <span className="ip-you">{age ? `YOU · ${age}` : 'YOU'}</span>}
          {node.status === 'blocked' && <span className="ip-blocked">blocked</span>}
          {progress && (
            <span className="ip-progress">
              {progress.done}/{progress.total}
            </span>
          )}
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
        {stack && progress && (
          <div className="ip-track">
            <div className="ip-track-fill" style={{ width: `${(progress.done / progress.total) * 100}%` }} />
          </div>
        )}
        {rows.length > 0 && (
          <div className="ip-lines">
            {rows.map((row) => (
              <CardLine key={row.id} row={row} />
            ))}
          </div>
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
      {/* At the frame's bottom, 18 px in: the rail to the children runs 10 px left of them. */}
      <Handle type="source" position={Position.Bottom} id="out" className="ip-handle" style={{ left: 18 }} />
    </div>
  );
}
