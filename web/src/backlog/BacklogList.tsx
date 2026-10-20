import { useMemo, useRef } from 'react';
import { deriveBoard } from '../../../src/core/board';
import { taskBoxes } from '../../../src/core/taskState';
import { queueOp } from '../api';
import { Backlog } from './Backlog';
import { dropToOp } from '../board/dragQueue';
import { QuickAdd } from '../board/QuickAdd';
import { projectCode } from '../page/projectCode';
import type { ViewProps } from '../views/props';

/**
 * The full Backlog (a view of its own: the rail opens it, and so does "N ›" on the Board), a page like the Project view.
 * Every open entry, the filter and order controls, and a Parked group at the bottom; the quick-add
 * at the foot creates a root step (No phase).
 */
export function BacklogList({ snapshot, now, onOpenNode, onOpenResource, onStatus, codes }: ViewProps & { codes?: Map<number, string> }) {
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
    <div className="ip-backlogview">
      <div className="ip-page">
        <Backlog
          boxes={boxes}
          parked={board.parked}
          snapshot={snapshot}
          now={now}
          projectId={project.id}
          slug={project.slug}
          code={codes?.get(project.id) ?? projectCode(project.name)}
          titleRef={heading}
          onStatus={onStatus}
          onOpenNode={onOpenNode}
          onOpenResource={onOpenResource}
          onToNext={toNext}
        />
        <QuickAdd projectId={project.id} slug={project.slug} inputRef={field} onStatus={onStatus} onClose={() => heading.current?.focus()} />
      </div>
    </div>
  );
}
