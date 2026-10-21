import type { DragEvent, RefObject } from 'react';
import type { TaskBox as BoxData } from '../../../src/core/taskState';
import { QuickAdd } from '../board/QuickAdd';
import type { BandProps } from '../board/bandProps';
import { BoardTile } from '../board/BoardTile';
import { focusTargetAfter } from '../board/focus';
import { noteAction } from '../measure';
import { Button } from '../parts/Button';
import { Chip } from '../parts/Chip';
import { EmptyState } from '../parts/EmptyState';
import { Eyebrow } from '../parts/Eyebrow';
import { useListCursor } from '../parts/ListCursor';

/**
 * The Backlog preview at the foot of Next (and of the narrow Next band): `>> SOON · N`, + Add and Open ›, then Soon's first
 * five steps in rank order, each its own numbered tile (their own arrow-key list, draggable into Next), and "N more in Soon
 * · Open Backlog ›" past five. An empty Soon says so, with Triage › when unranked steps wait. + Add creates at the bottom
 * of Soon; the quick-add field sits under the rows when + Add has opened it.
 */
export function PreviewPanel({ rows, count, more, triage, adding, field, addButton, snapshot, now, selectedNode, dragging, onTriage, onOpenAll, onAdd, onCloseAdd, onStatus, onOpenNode, onOpenResource, onDragStart, onDragEnd, onToNext }: Pick<BandProps, 'snapshot' | 'now' | 'selectedNode' | 'onOpenNode' | 'onOpenResource' | 'onStatus'> & {
  /** Soon's first five (see soonPreview), each with its Ranked number. */
  rows: { box: BoxData; number: number | null }[];
  /** How many steps Soon holds in the Backlog cell. */
  count: number;
  /** How many lie past the rows. */
  more: number;
  /** An unranked step waits: an empty Soon offers Triage ›. */
  triage: boolean;
  adding: boolean;
  field: RefObject<HTMLInputElement>;
  addButton: RefObject<HTMLButtonElement>;
  onTriage: () => void;
  onOpenAll: () => void;
  onAdd: () => void;
  onCloseAdd: () => void;
  onDragStart: (e: DragEvent, id: number) => void;
  onDragEnd: () => void;
  onToNext: (id: number) => void;
  /** The id being dragged, so its tile dims. */
  dragging?: number | null;
}) {
  const { project } = snapshot;
  const { itemProps } = useListCursor(
    [rows.length],
    ({ row }) => {
      const r = rows[row];
      if (r) onOpenNode(r.box.row!.node.id);
    },
    [rows.map((r) => String(r.box.row!.node.id))],
  );
  return (
    <div className="ip-preview">
      <div className="ip-backlog-head">
        <Eyebrow glyph=">>" className="ip-backlog-name">{`Soon · ${count}`}</Eyebrow>
        <span className="ip-backlog-acts">
          <Button ref={addButton} variant="ghost" size="sm" className="ip-add" onClick={onAdd}>+ Add</Button>
          <Button variant="ghost" size="sm" glyph="›" className="ip-backlog-all" title="Open the full Backlog" onClick={onOpenAll}>Open</Button>
        </span>
      </div>
      {rows.length === 0 ? (
        <>
          <EmptyState>Nothing in Soon</EmptyState>
          {triage && <Button variant="ghost" size="sm" glyph="›" className="ip-preview-triage" onClick={onTriage}>Triage</Button>}
        </>
      ) : (
        <ul className="ip-list ip-backlog-list" aria-label="Soon">
          {rows.map(({ box, number }, i) => {
            const id = box.row!.node.id;
            return (
              <BoardTile
                key={id}
                box={box}
                number={number}
                now={now}
                area="backlog"
                band="backlog"
                docs={snapshot.resources.filter((r) => r.nodeId === id).length}
                cursor={itemProps(0, i)}
                selected={selectedNode === id}
                dragging={dragging === id}
                chips={box.state === 'blocked' ? <Chip tone="blocked">BLOCKED</Chip> : undefined}
                li={{ draggable: true, onDragStart: (e) => onDragStart(e, id), onDragEnd }}
                lead={
                  <Button
                    variant="ghost"
                    size="sm"
                    className="ip-hover-act"
                    data-act
                    onClick={(e) => {
                      noteAction('backlog', 'to_next');
                      focusTargetAfter(e.currentTarget.closest('li'))?.focus();
                      onToNext(id);
                    }}
                  >
                    to Next
                  </Button>
                }
                onOpenNode={onOpenNode}
                onOpenResource={onOpenResource}
              />
            );
          })}
        </ul>
      )}
      {more > 0 && (
        <p className="ip-backlog-more">
          {`${more} more in Soon`}
          <Button variant="ghost" size="sm" glyph="›" onClick={onOpenAll}>Open Backlog</Button>
        </p>
      )}
      {adding && <QuickAdd projectId={project.id} slug={project.slug} inputRef={field} parent={null} band="soon" label="Add a step to Soon" onStatus={onStatus} onClose={onCloseAdd} />}
    </div>
  );
}
