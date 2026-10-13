import { deriveBoard, type BoardRow, type Column } from '../../../src/core/board';
import type { ViewProps } from '../views/props';

const COLUMNS: { column: Column; label: string }[] = [
  { column: 'now', label: 'Now' },
  { column: 'next', label: 'Next' },
  { column: 'backlog', label: 'Backlog' },
  { column: 'done', label: 'Done' },
];

/**
 * The Board, as a skeleton: a heading per column and one button per step, in the order deriveBoard gives. The columns,
 * header lines, marks and the rest of spec 2.2 to 2.4 come in a later task.
 */
export function Board({ snapshot, now, onOpenNode }: ViewProps) {
  const board = deriveBoard(snapshot, now);
  return (
    <div className="ip-board">
      <h2 className="ip-view-name">{snapshot.project.name}</h2>
      {COLUMNS.map(({ column, label }) => (
        <section key={column} className={`ip-board-col ip-col-${column}`} aria-label={label}>
          <h3>{label}</h3>
          {(board[column] as BoardRow[]).map((row) => (
            <button key={row.node.id} className="ip-step-row" onClick={() => onOpenNode(row.node.id)}>
              {row.node.title}
            </button>
          ))}
        </section>
      ))}
    </div>
  );
}
