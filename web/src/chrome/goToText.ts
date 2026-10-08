import type { GoToQuery, StepHit } from '../../../src/core/goto';

/** A Go to option's name: the step as `#77 Title`, then its project, which the row shows muted. */
export function hitLabel(h: StepHit): string {
  return `#${h.id} ${h.title}, ${h.projectName}${h.projectStatus === 'archived' ? ' (archived)' : ''}`;
}

/**
 * The Go to field's muted line under the list, which a screen reader hears: how many steps the list holds, or why it
 * holds none. `settled` is the server's answer to the text as it is now (null while it is not in), and `missing` the id
 * Enter found nothing at. Empty when there is nothing to say.
 */
export function goToMessage(query: GoToQuery, settled: { hits: StepHit[]; error?: string } | null, missing: number | null): string {
  if (query.kind === 'id' && missing === query.id) return `No step #${query.id}`;
  if (!settled) return '';
  if (settled.error) return `Couldn't search: ${settled.error}`;
  if (query.kind === 'words' && settled.hits.length === 0) return 'No step titles match';
  const n = settled.hits.length;
  return n === 0 ? '' : n === 1 ? '1 step' : `${n} steps`;
}

/**
 * The step Enter picks from `hits`: the one highlighted (by id, so a highlight never lands on a different row of a newer
 * list), else the first. Undefined when there are none.
 */
export function pickHit(hits: readonly StepHit[], highlighted: number | undefined): StepHit | undefined {
  return hits.find((h) => h.id === highlighted) ?? hits[0];
}

/** Ctrl+K (Cmd+K on a Mac), with nothing else held: the Go to field's chord. */
export function isGoToChord(e: { key: string; ctrlKey: boolean; metaKey: boolean; altKey: boolean; shiftKey: boolean }): boolean {
  return (e.ctrlKey || e.metaKey) && !e.altKey && !e.shiftKey && (e.key === 'k' || e.key === 'K');
}
