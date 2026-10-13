import type { BoardRow } from '../../../src/core/board';
import type { TreeNode } from '../../../src/core/types';
import { endedLine, LabelChip, rowClick, StepMarks } from './Marks';
import type { BandProps } from './bandProps';

/** Backlog rows grouped by parent, in the order the parents first appear; rows at the top level come first with no line. */
export function groupByParent(rows: BoardRow[]): { parent: TreeNode | null; rows: BoardRow[] }[] {
  const groups = new Map<number, { parent: TreeNode | null; rows: BoardRow[] }>();
  for (const row of rows) {
    const parent = row.crumb[row.crumb.length - 1] ?? null;
    const key = parent?.id ?? 0;
    const group = groups.get(key) ?? { parent, rows: [] };
    group.rows.push(row);
    groups.set(key, group);
  }
  return [...groups.entries()].sort(([a], [b]) => (a === 0 ? 0 : 1) - (b === 0 ? 0 : 1)).map(([, g]) => g);
}

/** The open Backlog: one-line rows under their parent's title, each draggable, with "to Next" shown on hover and on focus. */
export function Backlog({ rows, snapshot, now, onOpenNode, onOpenResource, onDragStart, onDragEnd, onToNext }: Pick<BandProps, 'snapshot' | 'now' | 'onOpenNode' | 'onOpenResource'> & {
  rows: BoardRow[];
  onDragStart: (id: number) => void;
  onDragEnd: () => void;
  onToNext: (id: number) => void;
}) {
  if (rows.length === 0) return <p className="ip-quiet ip-empty-line">Backlog is empty</p>;
  const slotOf = (id: string) => snapshot.sessions.find((s) => s.id === id)?.slot ?? null;
  return (
    <div className="ip-backlog-groups">
      {groupByParent(rows).map((g) => (
        <section key={g.parent?.id ?? 0} className="ip-backlog-group" aria-label={g.parent ? `Backlog under ${g.parent.title}` : 'Backlog at the top level'}>
          {g.parent && <div className="ip-group-line" title={g.parent.title}>{g.parent.title}</div>}
          <ul>
            {g.rows.map((row) => {
              const ended = endedLine(row, snapshot.pastSessions, slotOf, now);
              return (
                <li
                  key={row.node.id}
                  className="ip-row ip-backlog-row"
                  data-node={row.node.id}
                  draggable
                  onDragStart={(e) => {
                    e.dataTransfer.effectAllowed = 'move';
                    e.dataTransfer.setData('text/plain', String(row.node.id));
                    onDragStart(row.node.id);
                  }}
                  onDragEnd={onDragEnd}
                  onClick={rowClick('backlog', () => onOpenNode(row.node.id))}
                >
                  <div className="ip-line">
                    <button type="button" className="ip-row-title">{row.node.title}</button>
                    <LabelChip label={row.node.label} />
                    <StepMarks row={row} now={now} onOpenResource={onOpenResource} />
                    <button type="button" className="ip-hover-act" data-act onClick={() => onToNext(row.node.id)}>to Next</button>
                  </div>
                  {ended && <div className="ip-system-line">{ended}</div>}
                </li>
              );
            })}
          </ul>
        </section>
      ))}
    </div>
  );
}
