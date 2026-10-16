import type { Board } from '../../../src/core/board';
import type { TaskBox, TaskCell } from '../../../src/core/taskState';
import type { ViewProps } from '../views/props';

/** What each Board band gets: the window's props, the derived board, the boxes by cell, the width, and the last look for Done's divider. */
export interface BandProps extends ViewProps {
  board: Board;
  /** Every box on the Board by cell: one cell per task. */
  boxes: Record<TaskCell, TaskBox[]>;
  wide: boolean;
}
