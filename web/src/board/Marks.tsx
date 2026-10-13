import type { MouseEvent } from 'react';
import type { BoardRow, Mark } from '../../../src/core/board';
import { LABEL_GLYPHS, type NodeLabel, type TreeNode } from '../../../src/core/types';
import { noteAction, type MeasureArea } from '../measure';
import { ageShort } from './text';

export { endedLine } from './text';

/** Marks that are the grey hygiene kind, with the words they read as. */
export const MARK_WORDS: Record<Mark, string> = {
  ended_open: 'ended without closing',
  no_outcome: 'no outcome',
  stale_ask: 'ask open over 7 days',
  done_focus: 'a session is still on it',
  deep: 'deep',
};

/** The label chip: glyph plus word in muted ink. Its accessible name is the word. */
export function LabelChip({ label }: { label: NodeLabel | null }) {
  if (!label) return null;
  return (
    <span className="ip-type ip-glyph" role="img" aria-label={label} title={label}>
      <span aria-hidden="true">{`${LABEL_GLYPHS[label]} ${label}`}</span>
    </span>
  );
}

/** The marks on a step's quote: the amber ask, "you", the handoff chip and the grey hygiene marks. */
export function StepMarks({ row, now, onOpenResource, skip = [], area }: { row: BoardRow; now: number; onOpenResource: (id: number) => void; skip?: Mark[]; area?: MeasureArea }) {
  const hygiene = row.marks.filter((m) => !skip.includes(m) && m !== 'ended_open');
  return (
    <>
      {row.asks.length > 0 && (
        <span className="ip-mark ask" title={row.asks.map((a) => a.text).join('\n')}>
          {row.asks.length === 1 ? 'ask open' : `${row.asks.length} asks open`}
        </span>
      )}
      {row.node.assignee === 'me' && row.node.status !== 'done' && <span className="ip-you">YOU</span>}
      {row.handoff && (
        <button
          type="button"
          className="ip-chip-handoff"
          data-act
          onClick={(e: MouseEvent) => {
            e.stopPropagation();
            noteAction(area ?? row.column, 'open_handoff');
            onOpenResource(row.handoff!.id);
          }}
        >
          {`handoff · ${ageShort(row.handoff.createdAt, now)}`}
        </button>
      )}
      {hygiene.map((m) => (
        <span key={m} className="ip-mark hygiene">
          {MARK_WORDS[m]}
        </span>
      ))}
    </>
  );
}

/** "on #id title" for a step, the title being the button that opens its Details. */
export function StepLine({ node }: { node: Pick<TreeNode, 'id' | 'title'> }) {
  return (
    <span className="ip-on">
      <span className="ip-on-word">on </span>
      <span className="ip-id">{`#${node.id}`}</span>{' '}
      <button type="button" className="ip-row-title">
        {node.title}
      </button>
    </span>
  );
}

/** A click on a row opens Details, unless it landed on a button of the row's own (marked data-act). */
export function rowClick(area: MeasureArea, open: () => void) {
  return (e: MouseEvent) => {
    if ((e.target as HTMLElement).closest('[data-act], input, textarea')) return;
    noteAction(area, 'open');
    open();
  };
}
