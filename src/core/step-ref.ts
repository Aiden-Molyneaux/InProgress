/** How much of a step's title a line keeps where the title only names the step. */
export const STEP_TITLE_MAX = 50;

/**
 * `#42 Fix the export`: a step as a line names it to Aiden, who reads steps by title, never by a bare id (#440). The title
 * is flattened to one line and clipped to `max`; a step whose title is unknown (deleted, or not in the snapshot) is `#42`.
 */
export function stepRef(id: number, title: string | undefined, max = STEP_TITLE_MAX): string {
  const line = (title ?? '').replace(/\s+/g, ' ').trim();
  if (!line) return `#${id}`;
  return `#${id} ${line.length > max ? `${line.slice(0, max - 1)}…` : line}`;
}
