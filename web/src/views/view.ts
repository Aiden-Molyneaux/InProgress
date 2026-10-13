import { load, save } from '../storage';

/** The two views of a project: the Board (default) and the Project view. */
export type View = 'board' | 'project';

const KEY = 'ip.view';

/** The view picked last, or the Board: nothing stored, storage blocked, or a value that is neither view. */
export function loadView(): View {
  return load(KEY) === 'project' ? 'project' : 'board';
}

export function saveView(v: View): void {
  save(KEY, v);
}
