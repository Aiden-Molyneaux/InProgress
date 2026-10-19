import type { Board, BoardInput } from '../../../src/core/board';
import { taskBoxes } from '../../../src/core/taskState';
import type { BuildInfo } from '../../../src/core/build';
import type { ProjectSummary } from '../../../src/core/types';
import { waitingOn } from './tabs';

type Counted = Pick<ProjectSummary, 'slug' | 'name' | 'status' | 'openAsks' | 'permissionWaits' | 'busySessions'>;

export interface HudFigures {
  asks: number;
  asksTitle: string;
  live: number;
  liveTitle: string;
}

/** The active projects in the tab strip's order; an active project the order does not name follows the others. */
function inTabOrder<T extends Pick<ProjectSummary, 'slug' | 'status'>>(projects: T[], tabOrder: Pick<ProjectSummary, 'slug'>[]): T[] {
  const rank = (p: T) => {
    const at = tabOrder.findIndex((t) => t.slug === p.slug);
    return at < 0 ? tabOrder.length : at;
  };
  return projects.filter((p) => p.status === 'active').sort((a, b) => rank(a) - rank(b));
}

/** The title of a figure: one `name: n` line per project with something, or `none` when nothing counts. */
const titleOf = (rows: { name: string; n: number }[], none: string): string =>
  rows.filter((r) => r.n > 0).map((r) => `${r.name}: ${r.n}`).join('\n') || none;

/**
 * The HUD's cross-project figures over the active projects: what waits on Aiden (a tab's count, summed) and the sessions
 * busy, each with a title that lists the projects behind it in tab order.
 */
export function hudFigures(projects: Counted[], tabOrder: Pick<ProjectSummary, 'slug'>[]): HudFigures {
  const active = inTabOrder(projects, tabOrder);
  const asks = active.map((p) => ({ name: p.name, n: waitingOn(p) }));
  const live = active.map((p) => ({ name: p.name, n: p.busySessions }));
  const sum = (rows: { n: number }[]) => rows.reduce((total, r) => total + r.n, 0);
  return {
    asks: sum(asks),
    asksTitle: titleOf(asks, 'Nothing waits on you'),
    live: sum(live),
    liveTitle: titleOf(live, 'No sessions working'),
  };
}

/**
 * Where the ASKS click goes: `'here'` when the open tab is active and has asks, else the slug of the first active tab in
 * strip order that has some, else null.
 */
export function askTarget(tabs: Pick<ProjectSummary, 'slug' | 'status' | 'openAsks' | 'permissionWaits'>[], currentSlug: string | null): 'here' | string | null {
  const waiting = tabs.filter((t) => t.status === 'active' && waitingOn(t) > 0);
  if (waiting.some((t) => t.slug === currentSlug)) return 'here';
  return waiting[0]?.slug ?? null;
}

/**
 * READY and BACKLOG for the open project: the Next steps nothing blocks, and the Backlog total the preview's "N ›" shows
 * (the Backlog cell's boxes, the same list it counts).
 */
export function boardFigures(board: Board, input: BoardInput, now: number): { ready: number; backlog: number } {
  return { ready: board.next.filter((r) => r.ready).length, backlog: taskBoxes(board, input, now).backlog.length };
}

const TIME = new Intl.DateTimeFormat('en-US', { hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
const DATE = new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric', year: 'numeric' });

/** The HUD's clock: `HH:MM` on 24 hours and `Oct 19, 2026`, both in local time. */
export function clockText(d: Date): { time: string; date: string } {
  return { time: TIME.format(d), date: DATE.format(d) };
}

/** The footer's server line: `LOCALHOST:4317 · BUILD 8b796d9`, `+DIRTY` after the sha of a dirty build. The host alone without a build. */
export function serverLine(host: string, build: BuildInfo | null): string {
  const upper = host.toUpperCase();
  return build ? `${upper} · BUILD ${build.sha}${build.dirty ? '+DIRTY' : ''}` : upper;
}

export interface FooterKey {
  keys: string[];
  label: string;
}

/** The key hints along the footer: Find always, Projects with two or more tabs, Close while something can be closed. */
export function footerKeys({ tabs, escapable }: { tabs: number; escapable: boolean }): FooterKey[] {
  return [
    { keys: ['Ctrl K'], label: 'Find' },
    ...(tabs >= 2 ? [{ keys: ['[ ]'], label: 'Projects' }] : []),
    ...(escapable ? [{ keys: ['Esc'], label: 'Close' }] : []),
  ];
}
