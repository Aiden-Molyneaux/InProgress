/** How much of a step's title a line keeps where the title only names the step. */
export const STEP_TITLE_MAX = 50;

/**
 * `Fix the exp…`: text flattened to one line and clipped to `max` UTF-16 units, the last one `…`. The cut never splits a
 * surrogate pair: a lone surrogate in a hook's context can make the API reject every later request in that session. The
 * mod's `stepLine` (claude/mods/inprogress-step/hooks/register.ts) keeps a copy of this rule.
 */
export function clipLine(text: string, max: number): string {
  const line = text.replace(/\s+/g, ' ').trim();
  if (line.length <= max) return line;
  const code = line.charCodeAt(max - 2);
  const cut = code >= 0xd800 && code <= 0xdbff ? max - 2 : max - 1;
  return `${line.slice(0, cut)}…`;
}

/**
 * `#42 Fix the export`: a step as a line names it to Aiden, who reads steps by title, never by a bare id (#440). The title
 * is flattened to one line and clipped to `max`; a step whose title is unknown (deleted, or not in the snapshot) is `#42`.
 */
export function stepRef(id: number, title: string | undefined, max = STEP_TITLE_MAX): string {
  const line = clipLine(title ?? '', max);
  return line ? `#${id} ${line}` : `#${id}`;
}
