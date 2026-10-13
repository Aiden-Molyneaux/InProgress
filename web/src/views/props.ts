import type { ProjectSnapshot } from '../../../src/core/types';

/** What the Board and the Project view get from the window. */
export interface ViewProps {
  snapshot: ProjectSnapshot;
  /** The clock, for ages and for who is live. */
  now: number;
  /** A step picked: the window opens its Details. */
  onOpenNode: (id: number) => void;
  /** A resource picked: the window opens its viewer. */
  onOpenResource: (id: number) => void;
  /** The Board's "Where we are" line opens the Project view. */
  onOpenProject?: () => void;
}
