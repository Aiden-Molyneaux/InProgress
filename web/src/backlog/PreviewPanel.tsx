import type { DragEvent, RefObject } from 'react';
import type { TaskBox as BoxData } from '../../../src/core/taskState';
import { focusTargetAfter } from '../board/focus';
import { endedLine } from '../board/Marks';
import { QuickAdd } from '../board/QuickAdd';
import { TaskBox } from '../board/TaskBox';
import type { BandProps } from '../board/bandProps';
import { noteAction } from '../measure';
import type { PhaseChoice, PreviewPhase } from './backlogPreview';

/**
 * The Backlog preview at the foot of Next (and of the narrow Next band): "Backlog", a phase picker, and "N ›" that opens
 * the full view; under it up to five entries of the picked phase, then the quick-add field when "+ add" has opened it.
 * Rows are the shared task box with "to Next" on hover, and draggable into Next.
 */
export function PreviewPanel({ rows, choices, phase, total, adding, field, addButton, snapshot, now, onPick, onOpenAll, onAdd, onCloseAdd, onStatus, onOpenNode, onOpenResource, onDragStart, onDragEnd, onToNext }: Pick<BandProps, 'snapshot' | 'now' | 'onOpenNode' | 'onOpenResource' | 'onStatus'> & {
  /** The entries to draw: the picked phase's, already cut to five. */
  rows: BoxData[];
  choices: PhaseChoice[];
  phase: PreviewPhase;
  /** Every open Backlog entry, parked excluded. */
  total: number;
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
}) {
  const { project } = snapshot;
  const title = choices.find((c) => c.value === phase)?.title ?? 'No phase';
  return (
    <>
      <div className="ip-rail-foot ip-backlog-head">
        <span className="ip-backlog-name">Backlog</span>
        <select
          className="ip-backlog-phase"
          aria-label="Backlog phase"
          value={String(phase)}
          onChange={(e) => onPick(e.target.value === 'none' ? 'none' : Number(e.target.value))}
        >
          {choices.map((c) => <option key={String(c.value)} value={String(c.value)}>{c.title}</option>)}
        </select>
        <button type="button" className="ip-fold ip-backlog-all" title="Open the full Backlog" onClick={onOpenAll}>{`${total} ›`}</button>
        <button type="button" ref={addButton} className="ip-link-btn ip-add" onClick={onAdd}>+ add</button>
      </div>
      {rows.length === 0 ? (
        <p className="ip-quiet ip-empty-line">{`Nothing in ${title}`}</p>
      ) : (
        <ul className="ip-list ip-backlog-list" aria-label={`Backlog: ${title}`}>
          {rows.map((box) => {
            const row = box.row!;
            return (
              <TaskBox
                key={row.node.id}
                box={box}
                now={now}
                area="backlog"
                docs={snapshot.resources.filter((r) => r.nodeId === row.node.id).length}
                system={endedLine(row, snapshot.pastSessions, now)}
                className="ip-backlog-row"
                noHue
                li={{
                  draggable: true,
                  onDragStart: (e) => onDragStart(e, row.node.id),
                  onDragEnd,
                }}
                extra={
                  <button type="button" className="ip-hover-act" data-act onClick={(e) => {
                    noteAction('backlog', 'to_next');
                    focusTargetAfter(e.currentTarget.closest('li'))?.focus();
                    onToNext(row.node.id);
                  }}>to Next</button>
                }
                onOpenNode={onOpenNode}
                onOpenResource={onOpenResource}
              />
            );
          })}
        </ul>
      )}
      {adding && <QuickAdd projectId={project.id} slug={project.slug} inputRef={field} parent={phase === 'none' ? null : phase} label={`Add a step to ${title}`} onStatus={onStatus} onClose={onCloseAdd} />}
    </>
  );
}
