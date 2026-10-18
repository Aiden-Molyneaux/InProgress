import { useMemo, useRef } from 'react';
import { deriveBoard } from '../../../src/core/board';
import { taskBoxes } from '../../../src/core/taskState';
import { queueOp } from '../api';
import { Backlog } from './Backlog';
import { dropToOp } from '../board/dragQueue';
import { QuickAdd } from '../board/QuickAdd';
import type { ViewProps } from '../views/props';

/**
 * The full Backlog (opened from "N ›" on the Board), built like All done: it replaces the Board body while open, with
 * "‹ Board" to go back. Every open entry, the filter and order controls, and a Parked group at the bottom; the quick-add
 * at the foot creates a root step (No phase).
 */
export function BacklogList({ snapshot, now, onOpenNode, onOpenResource, onStatus, onBack }: ViewProps & { onBack: () => void }) {
  const { project } = snapshot;
  const board = useMemo(() => deriveBoard(snapshot, now), [snapshot, now]);
  const boxes = useMemo(() => taskBoxes(board, snapshot, now).backlog, [board, snapshot, now]);
  const field = useRef<HTMLInputElement>(null);
  const heading = useRef<HTMLHeadingElement>(null);
  const toNext = async (id: number) => {
    const result = await queueOp(project.id, project.slug, dropToOp(id, { zone: 'next', before: null }));
    if (result === 'reload') window.location.reload();
    else if (result !== 'ok') onStatus?.(result);
  };
  return (
    <div className="ip-donelist ip-backlogview">
      <div className="ip-donelist-head">
        <button type="button" className="ip-donelist-back ip-backlogview-back" onClick={onBack}>‹ Board</button>
        <h2 ref={heading} className="ip-backlogview-title" tabIndex={-1}>{`Backlog · ${boxes.length}`}</h2>
      </div>
      <Backlog
        boxes={boxes}
        parked={board.parked}
        snapshot={snapshot}
        now={now}
        projectId={project.id}
        slug={project.slug}
        onStatus={onStatus}
        onOpenNode={onOpenNode}
        onOpenResource={onOpenResource}
        onToNext={toNext}
      />
      <QuickAdd projectId={project.id} slug={project.slug} inputRef={field} onStatus={onStatus} onClose={() => heading.current?.focus()} />
    </div>
  );
}
