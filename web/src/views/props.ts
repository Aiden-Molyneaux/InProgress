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
  /** The Board's Done column opens the full list of done steps. */
  onOpenDone?: () => void;
  /** Where the Board's "new since you looked" divider sits (spec 1.7); null when there is none. */
  lastLook?: string | null;
  /** A line for the window's toast: why a write was refused. */
  onStatus?: (text: string) => void;
}
