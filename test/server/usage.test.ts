import { describe, expect, it } from 'vitest';
import { write, type Ctx } from '../../src/server/db/tx';
import { clearAsk, raiseAsk } from '../../src/server/repo/asks';
import { addNodes } from '../../src/server/repo/nodes';
import { createProject } from '../../src/server/repo/projects';
import { formatUsage, readUsage } from '../../src/server/usage';
import { makeCtx } from '../helpers';

const HOUR = 60 * 60_000;

function setClock(ctx: Ctx, iso: string): void {
  let t = Date.parse(iso) - 1000;
  ctx.now = () => new Date((t += 1000)).toISOString();
}

/** Local noon of `daysAgo` days before the clock's day, as an ISO time: safe from midnight and from any time zone offset under 12 hours. */
function noon(base: string, daysAgo: number): string {
  const d = new Date(base);
  d.setDate(d.getDate() - daysAgo);
  d.setHours(12, 0, 0, 0);
  return d.toISOString();
}

const NOW = '2026-10-14T12:00:00.000Z';

function setup() {
  const ctx = makeCtx(NOW);
  const project = createProject(ctx, 'test', { name: 'InProgress' });
  const [step] = addNodes(ctx, 'test', { parentId: project.rootNodeId, nodes: [{ title: 'Step', status: 'active' }] });
  const event = (at: string, actor: string, type: string, data: unknown) => {
    setClock(ctx, at);
    write(ctx, actor, (record) => record({ projectId: project.id, type, entity: 'project', entityId: project.id, data }));
  };
  return { ctx, project, step, event };
}

describe('readUsage', () => {
  it('gives one row per day, newest last, with zeros where nothing happened', () => {
    const { ctx, project } = setup();
    setClock(ctx, noon(NOW, 0));
    const u = readUsage(ctx, project.slug, 3);
    expect(u.days).toHaveLength(3);
    expect(u.days.map((d) => d.day)).toEqual([...u.days.map((d) => d.day)].sort());
    expect(u.days[2]).toMatchObject({ shownBoard: 0, shownProject: 0, switches: 0, firstBand: null, quickAdds: 0, medianClearMs: null, marks: null, orchestrate: { opens: 0, status: 0 } });
  });

  it('counts the window events, quick-adds, asks and orchestrate opens of a day', () => {
    const { ctx, project, step, event } = setup();
    const today = noon(NOW, 0);
    event(today, 'window', 'window.shown', { view: 'board', gapMs: 4 * HOUR, marks: 3 });
    event(today, 'window', 'window.shown', { view: 'project', gapMs: 2 * HOUR, marks: 4 });
    event(today, 'window', 'window.shown', { view: 'board', gapMs: 2 * HOUR, marks: 5 });
    event(today, 'window', 'window.view', { view: 'project' });
    event(today, 'window', 'window.view', { view: 'board' });
    event(today, 'window', 'window.first_action', { area: 'needs_me', action: 'clear' });
    event(today, 'window', 'window.first_action', { area: 'next', action: 'drag' });
    event(today, 'window', 'window.first_action', { area: 'needs_me', action: 'answer' });
    event(today, 'window', 'window.backlog_open', {});
    event(today, 'window', 'window.details_open', { node: step.id });
    event(today, 'window', 'window.details_open', { node: step.id });
    event(today, 'scribe', 'session.orchestrate', { status: true, marks: 6 });
    event(today, 'scribe', 'session.orchestrate', { status: false, marks: 2 });
    // The window's own quick-add counts; the scribe's step does not.
    setClock(ctx, today);
    addNodes(ctx, 'window', { parentId: step.id, nodes: [{ title: 'Quick' }] });
    addNodes(ctx, 'scribe', { parentId: step.id, nodes: [{ title: 'Planned' }] });
    // Asks raised today by kind, one of them cleared two hours later, and one cleared four hours later.
    const q = raiseAsk(ctx, 'scribe', { nodeId: step.id, kind: 'question', text: 'q1' });
    const q2 = raiseAsk(ctx, 'scribe', { nodeId: step.id, kind: 'question', text: 'q2' });
    raiseAsk(ctx, 'scribe', { nodeId: step.id, kind: 'review', text: 'r1' });
    ctx.db.prepare('UPDATE asks SET raised_at = ? WHERE id IN (?, ?)').run(today, q.id, q2.id);
    setClock(ctx, new Date(Date.parse(today) + 2 * HOUR).toISOString());
    clearAsk(ctx, 'window', q.id);
    setClock(ctx, new Date(Date.parse(today) + 4 * HOUR).toISOString());
    clearAsk(ctx, 'window', q2.id);

    setClock(ctx, today);
    const d = readUsage(ctx, project.slug, 2).days[1];
    expect(d.shownBoard).toBe(2);
    expect(d.shownProject).toBe(1);
    expect(d.switches).toBe(2);
    expect(d.firstBand).toEqual({ area: 'needs_me', count: 2 });
    expect(d.backlogOpens).toBe(1);
    expect(d.detailsOpens).toBe(2);
    expect(d.quickAdds).toBe(1);
    expect(d.asks).toEqual({ question: 2, permission: 0, review: 1 });
    // Two clears, 2h and 4h after they were raised: the median is 3h.
    expect(d.medianClearMs).toBe(3 * HOUR);
    expect(d.orchestrate).toEqual({ opens: 2, status: 1 });
    // The last marks value of the day, from either source.
    expect(d.marks).toBe(2);
  });

  it('keeps one day from leaking into another, and ignores another project', () => {
    const { ctx, project, event } = setup();
    const other = createProject(ctx, 'test', { name: 'Other' });
    event(noon(NOW, 1), 'window', 'window.view', { view: 'project' });
    setClock(ctx, noon(NOW, 0));
    write(ctx, 'window', (record) => record({ projectId: other.id, type: 'window.view', entity: 'project', entityId: other.id, data: {} }));
    const days = readUsage(ctx, project.slug, 2).days;
    expect(days.map((d) => d.switches)).toEqual([1, 0]);
  });
});

describe('formatUsage', () => {
  it('prints the header and a padded row per day', () => {
    const { ctx, project, event } = setup();
    event(noon(NOW, 0), 'window', 'window.shown', { view: 'board', gapMs: 1, marks: 4 });
    setClock(ctx, noon(NOW, 0));
    const text = formatUsage(readUsage(ctx, project.slug, 2));
    const lines = text.split('\n');
    expect(lines[0]).toBe('Usage for InProgress, last 2 days:');
    expect(lines[1].split(/\s{2,}/)).toEqual(['day', 'shown(board/project)', 'switches', 'first band', 'backlog', 'details', 'quick-adds', 'asks q/p/r', 'median clear', 'mip-orc(status)', 'marks']);
    expect(lines).toHaveLength(4);
    expect(lines[3].split(/\s{2,}/).slice(1)).toEqual(['1/0', '0', '-', '0', '0', '0', '0/0/0', '-', '0(0)', '4']);
  });
});
