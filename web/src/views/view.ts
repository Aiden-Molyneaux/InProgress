import { load, save } from '../storage';

/** The views of a project: the Board (default), the Project view, the full Backlog, All done and Docs. */
export type View = 'board' | 'project' | 'backlog' | 'done' | 'docs';

const KEY = 'ip.view';

const VIEWS: readonly View[] = ['board', 'project', 'backlog', 'done', 'docs'];

/** The view picked last, or the Board: nothing stored, storage blocked, or a value that is none of the views. */
export function loadView(): View {
  const stored = load(KEY);
  return VIEWS.find((v) => v === stored) ?? 'board';
}

export function saveView(v: View): void {
  save(KEY, v);
}
