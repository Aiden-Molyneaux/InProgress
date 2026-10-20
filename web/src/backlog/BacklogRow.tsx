import type { DragEvent } from 'react';
import { LABEL_GLYPHS } from '../../../src/core/types';
import type { TaskBox } from '../../../src/core/taskState';
import { focusTargetAfter } from '../board/focus';
import { boxSince } from '../board/boxState';
import { rowClick } from '../board/Marks';
import { ageShort } from '../board/text';
import { noteAction } from '../measure';
import { Button } from '../parts/Button';
import { Chip } from '../parts/Chip';
import type { CursorItemProps } from '../parts/ListCursor';

/**
 * A Backlog entry as one line for the Board's preview: `#id`, the title, the age; a second line only for a label or a
 * blocked step. Hover or focus shows "to Next". A click on the row (not its button) opens Details. A cursor item of the
 * preview's list, and draggable into Next.
 */
export function BacklogRow({ box, now, cursor, onOpen, onToNext, onDragStart, onDragEnd }: {
  box: TaskBox;
  now: number;
  cursor: CursorItemProps;
  onOpen: (id: number) => void;
  onToNext: (id: number) => void;
  onDragStart: (e: DragEvent, id: number) => void;
  onDragEnd: () => void;
}) {
  const node = box.row!.node;
  const since = boxSince(box);
  const label = node.label;
  const blocked = box.state === 'blocked';
  return (
    <li
      {...cursor}
      className="ip-backlog-row"
      data-node={node.id}
      draggable
      onDragStart={(e) => onDragStart(e, node.id)}
      onDragEnd={onDragEnd}
      onClick={rowClick('backlog', () => onOpen(node.id))}
    >
      <span className="ip-bl-id">{`#${node.id}`}</span>
      <button type="button" className="ip-row-title">{node.title}</button>
      {since && <span className="ip-bl-age">{ageShort(since, now)}</span>}
      {(label || blocked) && (
        <span className="ip-bl-meta">
          {blocked && <Chip tone="blocked">BLOCKED</Chip>}
          {label && <Chip tone="label" glyph={LABEL_GLYPHS[label]} title={label}>{label}</Chip>}
        </span>
      )}
      <Button
        variant="ghost"
        size="sm"
        className="ip-hover-act"
        data-act
        onClick={(e) => {
          noteAction('backlog', 'to_next');
          focusTargetAfter(e.currentTarget.closest('li'))?.focus();
          onToNext(node.id);
        }}
      >
        to Next
      </Button>
    </li>
  );
}
