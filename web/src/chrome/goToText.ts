import type { GoToQuery, StepHit } from '../../../src/core/goto';

/** A Go to option's name: the step as `#77 Title`, then its project, which the row shows muted. */
export function hitLabel(h: StepHit): string {
  return `#${h.id} ${h.title}, ${h.projectName}${h.projectStatus === 'archived' ? ' (archived)' : ''}`;
}

/**
 * The Go to field's muted line under the list. `settled` is the server's answer to the text as it is now (null while it
 * is not in), and `missing` the id Enter found nothing at. Empty when there is nothing to say.
 */
export function goToMessage(query: GoToQuery, settled: { hits: StepHit[]; error?: string } | null, missing: number | null): string {
  if (query.kind === 'id' && missing === query.id) return `No step #${query.id}`;
  if (!settled) return '';
  if (settled.error) return `Couldn't search: ${settled.error}`;
  if (query.kind === 'words' && settled.hits.length === 0) return 'No step titles match';
  return '';
}
