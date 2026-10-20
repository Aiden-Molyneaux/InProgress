import type { CSSProperties } from 'react';
import { COLOURED, HUES, sinceFallback, type TaskBox, type TaskState } from '../../../src/core/taskState';

/** What the state pill says and which `ip-st` modifier and box class (`st-<class>`) it takes: the mock's STATES table. */
export const PILLS: Record<TaskState, { cls: string; label: string }> = {
  backlog: { cls: 'backlog', label: 'Backlog' },
  ready: { cls: 'ready', label: 'Ready' },
  working: { cls: 'working', label: 'Working' },
  idle: { cls: 'idle', label: 'Idle' },
  unattended: { cls: 'unattended', label: 'Unattended' },
  blocked: { cls: 'blocked', label: 'Blocked' },
  question: { cls: 'needs', label: 'Question' },
  permission: { cls: 'needs', label: 'Permission' },
  review: { cls: 'needs', label: 'Review' },
  done: { cls: 'done', label: '✓ Done' },
};

/**
 * The time a box's age counts from. The stored `stateSince` is used only while the stored state is the one the box shows:
 * a time-only change (a session going stale) writes nothing, so the stored state can lag. Otherwise the best honest time
 * for that state: when it was completed, when its oldest open ask was raised, or when the step last changed.
 */
export function boxSince(box: TaskBox): string | null {
  const node = box.row?.node;
  if (!node) return box.session?.lastSeenAt ?? null;
  if (node.boardState === box.state && node.stateSince) return node.stateSince;
  return sinceFallback(node, box.state, box.row?.waiting ?? []);
}

/** The box's task hue as a style (`--hue`), or undefined: none for Done and Backlog, and none while the step holds no hue. */
export function hueStyle(box: TaskBox): CSSProperties | undefined {
  const hue = box.row?.node.hue;
  if (hue == null || !COLOURED.has(box.state) || !Number.isInteger(hue) || hue < 0 || hue >= HUES) return undefined;
  return { ['--hue' as string]: `var(--hue-${hue})` };
}
