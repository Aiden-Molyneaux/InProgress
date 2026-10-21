import { loadJson, save } from '../storage';

/** `section:<id>` is a section (0 is "Top level"), `done:<parentId>` is a parent's folded done children (0 is the "Done groups" list), `someday` is the Backlog's Someday band. */
const KEY_PATTERN = /^((section|done):\d+|someday)$/;
const storeKey = (projectId: number) => `ip.folds.${projectId}`;

/**
 * Fold choices Aiden made in a project, true for open and false for closed. The key is the one earlier versions used, whose
 * values were 'open' or 'closed' by node id: anything that is not a `section:`, `done:` or `someday` key holding a boolean is dropped.
 */
export function loadFolds(projectId: number): Record<string, boolean> {
  const raw = loadJson<unknown>(storeKey(projectId), {});
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return {};
  const out: Record<string, boolean> = {};
  for (const [key, value] of Object.entries(raw)) if (KEY_PATTERN.test(key) && typeof value === 'boolean') out[key] = value;
  return out;
}

export function saveFolds(projectId: number, folds: Record<string, boolean>): void {
  save(storeKey(projectId), JSON.stringify(folds));
}
