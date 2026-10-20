import { load, save } from '../storage';

/** The views of a project: the Board (default), the Project view, the full Backlog and All done. */
export type View = 'board' | 'project' | 'backlog' | 'done';

const KEY = 'ip.view';

const VIEWS: readonly View[] = ['board', 'project', 'backlog', 'done'];

/** The view picked last, or the Board: nothing stored, storage blocked, or a value that is none of the views. */
export function loadView(): View {
  const stored = load(KEY);
  return VIEWS.find((v) => v === stored) ?? 'board';
}

export function saveView(v: View): void {
  save(KEY, v);
}
