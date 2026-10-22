import type { SyncCheck, SyncCommit, SyncFile, SyncRow } from './types';

/**
 * The Sync page's reading of a `template-sync.mjs --check --json` answer (spec 2026-10-20-library-and-docs-design.md,
 * "Sync"). Pure, so the window and the digest (#461) say the same thing.
 */

export type CellState = 'current' | 'behind' | 'pending' | 'skipped' | 'not-adopted' | 'missing' | 'gone' | 'error';

/** One template's cell in a project's row: a file in `files` takes its own state, else the skip list, else it is not adopted. */
export function cellState(check: SyncCheck, template: string): { state: CellState; file: SyncFile | null } {
  const file = check.files.find((f) => f.template === template) ?? null;
  if (file) return { state: file.state, file };
  return { state: check.skip.includes(template) ? 'skipped' : 'not-adopted', file: null };
}

export type TemplateGroup = 'Agents' | 'Skills' | 'Starter kit' | 'Other';
const GROUP_ORDER: TemplateGroup[] = ['Agents', 'Skills', 'Starter kit', 'Other'];

export function templateGroup(template: string): TemplateGroup {
  if (template.startsWith('agents/')) return 'Agents';
  if (template.startsWith('skills/')) return 'Skills';
  if (template.startsWith('starter-kit/')) return 'Starter kit';
  return 'Other';
}

/** The templates by group, groups in the order Agents, Skills, Starter kit, Other; `templates.json` order within each. Empty groups are left out. */
export function groupTemplates(templates: string[]): { group: TemplateGroup; templates: string[] }[] {
  return GROUP_ORDER.map((group) => ({ group, templates: templates.filter((t) => templateGroup(t) === group) })).filter((g) => g.templates.length > 0);
}

export interface RowSummary {
  behind: number;
  adopted: number;
  /** The most common base among the files (a tie goes to the first seen); null when none has one. */
  base: string | null;
  lastSync: SyncCommit | null;
}

export function rowSummary(check: SyncCheck): RowSummary {
  const counts = new Map<string, number>();
  for (const f of check.files) if (f.base) counts.set(f.base, (counts.get(f.base) ?? 0) + 1);
  let base: string | null = null;
  let best = 0;
  for (const [sha, n] of counts) {
    if (n > best) {
      base = sha;
      best = n;
    }
  }
  return { behind: check.files.filter((f) => f.state === 'behind').length, adopted: check.files.length, base, lastSync: check.lastSync };
}

const COMMITS_SHOWN = 3;

const list = (names: string[]): string => (names.length <= 1 ? (names[0] ?? '') : `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`);

/** The comms slab's one sentence about every project's row. */
export function syncSentence(rows: SyncRow[]): string {
  const ok = rows.flatMap((r) => (r.check.ok ? [{ row: r, check: r.check.result }] : []));
  const failed = rows.filter((r) => !r.check.ok);
  const behind = ok.filter((o) => o.check.files.some((f) => f.state === 'behind'));
  const parts: string[] = [];
  if (rows.length === 0) return 'No project has a manifest.';
  if (behind.length === 0) {
    if (ok.length > 0) parts.push(failed.length === 0 ? `Every project with a manifest is current with Shipwright ${ok[0].check.shipwright.head}.` : `Every project that checked is current with Shipwright ${ok[0].check.shipwright.head}.`);
  } else {
    const seen = new Set<string>();
    const commits: SyncCommit[] = [];
    for (const o of behind) {
      for (const f of o.check.files) {
        if (f.state !== 'behind') continue;
        for (const c of f.commits) if (!seen.has(c.sha)) (seen.add(c.sha), commits.push(c));
      }
    }
    // Newest first; the sort is stable, so commits of one date keep the order the script gave them.
    commits.sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0));
    const shown = commits.slice(0, COMMITS_SHOWN).map((c) => `${c.sha} ${c.subject}`);
    const more = commits.length - shown.length;
    const names = behind.map((o) => o.row.name);
    const what = shown.length === 0 ? '' : `: ${shown.join(', ')}${more > 0 ? `, and ${more} more` : ''}`;
    parts.push(`${list(names)} ${names.length === 1 ? 'is' : 'are'} behind Shipwright${what}.`);
    for (const o of behind) parts.push(o.row.syncStep ? `${o.row.name} has a sync step, #${o.row.syncStep.id}.` : `${o.row.name} has none.`);
  }
  for (const r of failed) parts.push(`${r.name}'s check failed.`);
  return parts.join(' ');
}

/**
 * Whether a project's open step is its sync step: the title says sync, and names Shipwright or one of the adopted
 * templates (its path or its file name).
 */
export function isSyncStep(title: string, adopted: string[]): boolean {
  if (!/\bsync\b/i.test(title)) return false;
  if (/shipwright/i.test(title)) return true;
  const lower = title.toLowerCase();
  return adopted.some((t) => lower.includes(t.toLowerCase()) || lower.includes((t.split('/').pop() ?? t).toLowerCase()));
}
