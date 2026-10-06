/** How many hues a session family can wear: `--family-0` (teal) to `--family-5`. Past six, the letter tells them apart. */
export const FAMILY_COUNT = 6;

/**
 * A session family's hue, by the session's slot: its chip, focus badge, subagent badges and task marks all wear it.
 * A null slot gives slot 0's teal; a reader that needs a neutral look for "no slot" brings its own.
 */
export const familyVar = (slot: number | null): string => `var(--family-${(slot ?? 0) % FAMILY_COUNT})`;
