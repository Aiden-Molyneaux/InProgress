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
import { MenuButton } from '../parts/MenuButton';
import { phaseCounts, previewRows, type PhaseChoice, type PreviewPhase } from './backlogPreview';

/**
 * The Backlog preview at the foot of Next (and of the narrow Next band): `[+] BACKLOG · N`, + Add and Open ›, a menu button
 * for the phase (`<phase> · <count> ▾`), then up to five entries of the picked phase, each its own tile (their own
 * arrow-key list, draggable into Next), and "N more in <phase> · Open Backlog ›" past five. The quick-add field sits under the rows when + Add has opened it.
 */
export function PreviewPanel({ entries, choices, phase, adding, field, addButton, snapshot, now, selectedNode, dragging, onPick, onOpenAll, onAdd, onCloseAdd, onStatus, onOpenNode, onOpenResource, onDragStart, onDragEnd, onToNext }: Pick<BandProps, 'snapshot' | 'now' | 'selectedNode' | 'onOpenNode' | 'onOpenResource' | 'onStatus'> & {
  /** Every open Backlog entry, parked excluded: the count, the phase menu's counts and the rows come from it. */
  entries: BoxData[];
  choices: PhaseChoice[];
  phase: PreviewPhase;
  adding: boolean;
  field: RefObject<HTMLInputElement>;
  addButton: RefObject<HTMLButtonElement>;
  onPick: (phase: PreviewPhase) => void;
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
  const title = choices.find((c) => c.value === phase)?.title ?? 'No phase';
  const rows = previewRows(entries, phase);
  const counts = phaseCounts(entries);
  const more = (counts.get(phase) ?? 0) - rows.length;
  const { itemProps } = useListCursor(
    [rows.length],
    ({ row }) => {
      const box = rows[row];
      if (box) onOpenNode(box.row!.node.id);
    },
    [rows.map((b) => String(b.row!.node.id))],
  );
  return (
    <div className="ip-preview">
      <div className="ip-backlog-head">
        <Eyebrow glyph="[+]" className="ip-backlog-name">{`Backlog · ${entries.length}`}</Eyebrow>
        <span className="ip-backlog-acts">
          <Button ref={addButton} variant="ghost" size="sm" className="ip-add" onClick={onAdd}>+ Add</Button>
          <Button variant="ghost" size="sm" glyph="›" className="ip-backlog-all" title="Open the full Backlog" onClick={onOpenAll}>Open</Button>
        </span>
      </div>
      <MenuButton
        menuLabel="Backlog phase"
        variant="outline"
        align="start"
        items={choices.filter((c) => c.value === phase || (counts.get(c.value) ?? 0) > 0).map((c) => ({ key: String(c.value), label: `${c.title} · ${counts.get(c.value) ?? 0}`, current: c.value === phase, onSelect: () => onPick(c.value) }))}
      >
        {`${title} · ${counts.get(phase) ?? 0} `}<span aria-hidden="true">▾</span>
      </MenuButton>
      {rows.length === 0 ? (
        <EmptyState>{`Nothing in ${title}`}</EmptyState>
      ) : (
        <ul className="ip-list ip-backlog-list" aria-label={`Backlog: ${title}`}>
          {rows.map((box, i) => {
            const id = box.row!.node.id;
            return (
              <BoardTile
                key={id}
                box={box}
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
          {`${more} more in ${title}`}
          <Button variant="ghost" size="sm" glyph="›" onClick={onOpenAll}>Open Backlog</Button>
        </p>
      )}
      {adding && <QuickAdd projectId={project.id} slug={project.slug} inputRef={field} parent={phase === 'none' ? null : phase} label={`Add a step to ${title}`} onStatus={onStatus} onClose={onCloseAdd} />}
    </div>
  );
}
