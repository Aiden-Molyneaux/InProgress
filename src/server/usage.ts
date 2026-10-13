import { resolveProject } from './repo/projects';
import type { Ctx } from './db/tx';

const DAY_MS = 24 * 60 * 60 * 1000;

export interface UsageDay {
  /** Local calendar day, `2026-10-14`. */
  day: string;
  shownBoard: number;
  shownProject: number;
  switches: number;
  /** The band or section most first actions were in that day, with its count; null with none. */
  firstBand: { area: string; count: number } | null;
  backlogOpens: number;
  detailsOpens: number;
  quickAdds: number;
  asks: { question: number; permission: number; review: number };
  /** Median of cleared_at - raised_at, in ms, for the asks cleared that day; null with none. */
  medianClearMs: number | null;
  orchestrate: { opens: number; status: number };
  /** The last `marks` count that day from window.shown or session.orchestrate; null with none. */
  marks: number | null;
}

export interface Usage {
  project: { slug: string; name: string };
  days: UsageDay[];
}

interface Ev {
  ts: string;
  actor: string;
  type: string;
  data: string;
}

const pad = (n: number): string => String(n).padStart(2, '0');
const dayKey = (d: Date): string => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;

function parse(text: string): Record<string, unknown> {
  try {
    const v: unknown = JSON.parse(text);
    return typeof v === 'object' && v !== null ? (v as Record<string, unknown>) : {};
  } catch {
    // Not JSON means not one of the window's events: it carries nothing to count.
    return {};
  }
}

const median = (xs: number[]): number | null => {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : Math.round((s[mid - 1] + s[mid]) / 2);
};

/**
 * The week's counts for stage 2's evidence (spec 2.6), one row per local day for `days` days, newest last. Window
 * measurements and orchestrate opens come from events (actor `window`, types `window.*` and `session.orchestrate`);
 * quick-adds from the window's node.created events; asks from the asks table.
 */
export function readUsage(ctx: Ctx, ref: string | number, days: number): Usage {
  const project = resolveProject(ctx, ref);
  const now = new Date(ctx.now());
  const keys: string[] = [];
  for (let i = days - 1; i >= 0; i--) {
    const d = new Date(now);
    d.setDate(d.getDate() - i);
    keys.push(dayKey(d));
  }
  const first = new Date(now);
  first.setDate(first.getDate() - (days - 1));
  first.setHours(0, 0, 0, 0);
  const from = first.toISOString();
  const rows = new Map<string, UsageDay>(
    keys.map((day) => [
      day,
      { day, shownBoard: 0, shownProject: 0, switches: 0, firstBand: null, backlogOpens: 0, detailsOpens: 0, quickAdds: 0, asks: { question: 0, permission: 0, review: 0 }, medianClearMs: null, orchestrate: { opens: 0, status: 0 }, marks: null },
    ]),
  );
  const bands = new Map<string, Map<string, number>>();

  const events = ctx.db
    .prepare(
      `SELECT ts, actor, type, data FROM events
        WHERE project_id = ? AND ts >= ? AND (type LIKE 'window.%' OR type = 'session.orchestrate' OR (type = 'node.created' AND actor = 'window'))
        ORDER BY id`,
    )
    .all(project.id, from) as Ev[];
  for (const e of events) {
    const row = rows.get(dayKey(new Date(e.ts)));
    if (!row) continue;
    const data = parse(e.data);
    const marks = typeof data.marks === 'number' ? data.marks : null;
    switch (e.type) {
      case 'window.shown':
        if (data.view === 'project') row.shownProject++;
        else row.shownBoard++;
        if (marks !== null) row.marks = marks;
        break;
      case 'window.view':
        row.switches++;
        break;
      case 'window.first_action': {
        const area = typeof data.area === 'string' ? data.area : 'unknown';
        const counts = bands.get(row.day) ?? new Map<string, number>();
        counts.set(area, (counts.get(area) ?? 0) + 1);
        bands.set(row.day, counts);
        break;
      }
      case 'window.backlog_open':
        row.backlogOpens++;
        break;
      case 'window.details_open':
        row.detailsOpens++;
        break;
      case 'node.created':
        row.quickAdds += Array.isArray(data.ids) ? Math.max(1, (data.ids as unknown[]).length) : 1;
        break;
      case 'session.orchestrate':
        row.orchestrate.opens++;
        if (data.status === true) row.orchestrate.status++;
        if (marks !== null) row.marks = marks;
        break;
    }
  }
  for (const [day, counts] of bands) {
    // The most common band; a tie goes to the one seen first (Map keeps insertion order).
    const [area, count] = [...counts].reduce((best, c) => (c[1] > best[1] ? c : best));
    rows.get(day)!.firstBand = { area, count };
  }

  const asks = ctx.db
    .prepare('SELECT kind, raised_at, cleared_at FROM asks WHERE project_id = ? AND (raised_at >= ? OR cleared_at >= ?)')
    .all(project.id, from, from) as { kind: string; raised_at: string; cleared_at: string | null }[];
  const clears = new Map<string, number[]>();
  for (const a of asks) {
    const raised = rows.get(dayKey(new Date(a.raised_at)));
    if (raised && (a.kind === 'question' || a.kind === 'permission' || a.kind === 'review')) raised.asks[a.kind]++;
    if (a.cleared_at) {
      const key = dayKey(new Date(a.cleared_at));
      if (rows.has(key)) clears.set(key, [...(clears.get(key) ?? []), Date.parse(a.cleared_at) - Date.parse(a.raised_at)]);
    }
  }
  for (const [day, times] of clears) rows.get(day)!.medianClearMs = median(times);

  return { project: { slug: project.slug, name: project.name }, days: keys.map((k) => rows.get(k)!) };
}

function span(ms: number): string {
  if (ms < 60_000) return '<1m';
  if (ms < 60 * 60_000) return `${Math.round(ms / 60_000)}m`;
  if (ms < DAY_MS) return `${Math.round(ms / (60 * 60_000))}h`;
  return `${Math.round(ms / DAY_MS)}d`;
}

const COLUMNS = ['day', 'shown(board/project)', 'switches', 'first band', 'backlog', 'details', 'quick-adds', 'asks q/p/r', 'median clear', 'mip-orc(status)', 'marks'] as const;

/** The table of spec 2.6, columns padded to their widest cell. */
export function formatUsage(u: Usage): string {
  const cells = u.days.map((d) => [
    d.day,
    `${d.shownBoard}/${d.shownProject}`,
    String(d.switches),
    d.firstBand ? `${d.firstBand.area} ${d.firstBand.count}` : '-',
    String(d.backlogOpens),
    String(d.detailsOpens),
    String(d.quickAdds),
    `${d.asks.question}/${d.asks.permission}/${d.asks.review}`,
    d.medianClearMs === null ? '-' : span(d.medianClearMs),
    `${d.orchestrate.opens}(${d.orchestrate.status})`,
    d.marks === null ? '-' : String(d.marks),
  ]);
  const widths = COLUMNS.map((c, i) => Math.max(c.length, ...cells.map((r) => r[i].length)));
  const line = (r: readonly string[]) => r.map((c, i) => c.padEnd(widths[i])).join('  ').trimEnd();
  return [`Usage for ${u.project.name}, last ${u.days.length} ${u.days.length === 1 ? 'day' : 'days'}:`, line(COLUMNS), ...cells.map(line)].join('\n');
}
