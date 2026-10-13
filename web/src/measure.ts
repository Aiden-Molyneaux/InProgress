/** Measurements of how the window is used (spec 2.6): the window comes back after an hour, then its first click. */

/** The two events this module posts; api.ts's postEvent is handed in by the window (see setPoster). */
type Poster = (name: 'shown' | 'first_action', projectId: number | null, data: Record<string, string | number | boolean | null>) => void;
let postEvent: Poster = () => {};

/** Gives the module the function that posts a window event: kept apart from api.ts so the unit tests need no DOM. */
export function setPoster(post: Poster): void {
  postEvent = post;
}

/** The band or section a click happened in. */
export type MeasureArea = 'needs_me' | 'now' | 'next' | 'backlog' | 'done' | 'header' | 'project' | 'details' | 'done_list';

/** How long the window must have been unseen for a return to count (spec 2.6): one hour. */
export const GAP_MS = 60 * 60 * 1000;

/** The last time the window was shown, focused or clicked in; the module is loaded when the window is. */
let lastSeen = Date.now();
/** The project the last `shown` named, for the `first_action` that follows. */
let shownProject: number | null = null;
/** Set by a `shown` after a gap; the next click clears it and posts. */
let awaitingFirst = false;

/** Forgets what was seen: for tests, which run on a fake clock. */
export function resetMeasure(at: number = Date.now()): void {
  lastSeen = at;
  shownProject = null;
  awaitingFirst = false;
}

/**
 * Call on window show or focus: posts `window.shown` when the last time the window was seen is an hour or more ago, with
 * the gap and the mark count, and arms `first_action`. Any call counts as seen.
 */
export function noteShown(projectId: number | null, view: string, marks: number, now: number = Date.now()): void {
  const gap = now - lastSeen;
  lastSeen = now;
  if (gap < GAP_MS) return;
  shownProject = projectId;
  awaitingFirst = true;
  postEvent('shown', projectId, { view, gapMs: gap, marks });
}

/** Call on window blur or hide: the window was seen until now, so the gap a later `shown` measures starts here. */
export function noteHidden(now: number = Date.now()): void {
  lastSeen = now;
}

/** The first click after a gap posts `window.first_action` once: where it was and what it did. Every click counts as seen. */
export function noteAction(area: MeasureArea, action: string): void {
  lastSeen = Date.now();
  if (!awaitingFirst) return;
  awaitingFirst = false;
  postEvent('first_action', shownProject, { area, action });
}
