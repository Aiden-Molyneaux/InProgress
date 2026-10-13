import type { Board } from '../../../src/core/board';
import type { ViewProps } from '../views/props';

/** What each Board band gets: the window's props, the derived board, the width, and the last look for Done's divider. */
export interface BandProps extends ViewProps {
  board: Board;
  wide: boolean;
}
