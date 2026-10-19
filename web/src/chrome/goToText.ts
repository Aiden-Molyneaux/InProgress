import { parseGoTo, type GoToQuery, type StepHit } from '../../../src/core/goto';

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

export type GoView = 'board' | 'project' | 'backlog' | 'done';

/** A place the command bar lists without a search: one of the window's views, or a project. */
export type GoTarget = { kind: 'view'; view: GoView; label: string } | { kind: 'project'; slug: string; label: string; name: string };

const VIEWS: { view: GoView; label: string }[] = [
  { view: 'board', label: 'Board' },
  { view: 'project', label: 'Project' },
  { view: 'backlog', label: 'Backlog' },
  { view: 'done', label: 'All done' },
];

/** What the bar lists with nothing typed: the views in order, then "Open <name>" for each project, `current` left out. */
export function goTargets(projects: { slug: string; name: string }[], current: string | null): GoTarget[] {
  return [
    ...VIEWS.map((v): GoTarget => ({ kind: 'view', ...v })),
    ...projects.filter((p) => p.slug !== current).map((p): GoTarget => ({ kind: 'project', slug: p.slug, label: `Open ${p.name}`, name: p.name })),
  ];
}

/**
 * The targets the typed text narrows to: all of them for nothing typed, none for an id. Otherwise each typed word (a
 * leading "open" dropped) must start a word of the view's label or the project's name, in any case.
 */
export function matchTargets(text: string, targets: GoTarget[]): GoTarget[] {
  const query = parseGoTo(text);
  if (query.kind === 'empty') return targets;
  if (query.kind === 'id') return [];
  const typed = query.words.map((w) => w.toLowerCase());
  if (typed[0] === 'open') typed.shift();
  if (typed.length === 0) return targets;
  return targets.filter((t) => {
    const words = (t.kind === 'view' ? t.label : t.name).toLowerCase().split(/\s+/);
    return typed.every((w) => words.some((x) => x.startsWith(w)));
  });
}

/** A row's identity, which the highlight follows as the list changes. */
export function targetKey(t: GoTarget): string {
  return t.kind === 'view' ? `view:${t.view}` : `project:${t.slug}`;
}
