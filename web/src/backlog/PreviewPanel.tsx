import type { DragEvent, RefObject } from 'react';
import type { TaskBox as BoxData } from '../../../src/core/taskState';
import { QuickAdd } from '../board/QuickAdd';
import type { BandProps } from '../board/bandProps';
import { Button } from '../parts/Button';
import { EmptyState } from '../parts/EmptyState';
import { Eyebrow } from '../parts/Eyebrow';
import { useListCursor } from '../parts/ListCursor';
import { TabStrip } from '../parts/TabStrip';
import { BacklogRow } from './BacklogRow';
import { phaseCounts, previewRows, type PhaseChoice, type PreviewPhase } from './backlogPreview';

/**
 * The Backlog preview at the foot of Next (and of the narrow Next band): `[+] BACKLOG · N`, + Add and Open ›, a tab strip of
 * the phases with their counts, then up to five one-line rows of the picked phase (their own arrow-key list), and
 * "N more in <phase> · Open Backlog ›" past five. The quick-add field sits under the rows when + Add has opened it.
 */
export function PreviewPanel({ entries, choices, phase, adding, field, addButton, snapshot, now, onPick, onOpenAll, onAdd, onCloseAdd, onStatus, onOpenNode, onDragStart, onDragEnd, onToNext }: Pick<BandProps, 'snapshot' | 'now' | 'onOpenNode' | 'onOpenResource' | 'onStatus'> & {
  /** Every open Backlog entry, parked excluded: the count, the tabs' counts and the rows come from it. */
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
      <TabStrip
        variant="tabs"
        label="Backlog phase"
        items={choices.map((c) => ({ id: String(c.value), label: c.title, count: counts.get(c.value) ?? 0 }))}
        value={String(phase)}
        onChange={(id) => onPick(id === 'none' ? 'none' : Number(id))}
      />
      {rows.length === 0 ? (
        <EmptyState>{`Nothing in ${title}`}</EmptyState>
      ) : (
        <ul className="ip-list ip-backlog-list" aria-label={`Backlog: ${title}`}>
          {rows.map((box, i) => (
            <BacklogRow
              key={box.row!.node.id}
              box={box}
              now={now}
              cursor={itemProps(0, i)}
              onOpen={onOpenNode}
              onToNext={onToNext}
              onDragStart={onDragStart}
              onDragEnd={onDragEnd}
            />
          ))}
        </ul>
      )}
      {more > 0 && (
        <p className="ip-backlog-more">
          {`${more} more in ${title} · `}
          <Button variant="ghost" size="sm" glyph="›" onClick={onOpenAll}>Open Backlog</Button>
        </p>
      )}
      {adding && <QuickAdd projectId={project.id} slug={project.slug} inputRef={field} parent={phase === 'none' ? null : phase} label={`Add a step to ${title}`} onStatus={onStatus} onClose={onCloseAdd} />}
    </div>
  );
}
