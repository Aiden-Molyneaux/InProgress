import { describe, expect, it } from 'vitest';
import { NODE_LABELS, type TreeNode } from '../../src/core/types';
import { NEEDS_YOU_STALE_MS, ancestors, buildIndex, computeVisible, countDone, isNeedsYou, needsYouAge, pinnedIds, progress, renderOutline } from '../../src/core/tree';
import type { VisibleItem } from '../../src/core/tree';

let nextId = 1;
function n(parentId: number | null, title: string, extra: Partial<TreeNode> = {}): TreeNode {
  const id = extra.id ?? nextId++;
  return { id, projectId: 1, parentId, position: id, kind: parentId === null ? 'goal' : 'task', title, body: '', status: 'todo', assignee: 'claude', outcome: '', label: null, createdAt: 't', updatedAt: 't', completedAt: null, ...extra };
}

function sample() {
  nextId = 1;
  const root = n(null, 'InGame', { status: 'active' });
  const m = n(root.id, 'M1-M6 build', { status: 'done', kind: 'phase' });
  const m1 = n(m.id, 'M1', { status: 'done' });
  const m2 = n(m.id, 'M2', { status: 'done' });
  const road = n(root.id, 'Road to market', { status: 'active', kind: 'phase' });
  const s1 = n(road.id, '1 iOS certificate', { status: 'done' });
  const s2 = n(road.id, '2 Android signing', { status: 'active' });
  const a1 = n(s2.id, 'Upload keystore', { status: 'done' });
  const a2 = n(s2.id, 'Play app signing', { status: 'active' });
  const a3 = n(s2.id, 'Run signing tests', { assignee: 'me' });
  const s3 = n(road.id, '3 RevenueCat');
  const s4 = n(road.id, '4 Build to GitHub');
  const s5 = n(road.id, '5 Store listing');
  const s6 = n(road.id, '6 Beta');
  const s7 = n(road.id, '7 Launch');
  const nodes = [root, m, m1, m2, road, s1, s2, a1, a2, a3, s3, s4, s5, s6, s7];
  return { nodes, root, m, road, s1, s2, a1, a2, a3, s3, s4, s5, s6, s7 };
}

const label = (i: VisibleItem): string => (i.type === 'node' ? i.node.title : `+${i.hiddenIds.length} more`);

describe('derived stats', () => {
  it('computes needs-you, progress, done counts and ancestors', () => {
    const t = sample();
    const index = buildIndex(t.nodes);
    expect(isNeedsYou(t.a3)).toBe(true);
    expect(isNeedsYou({ ...t.a3, status: 'done' })).toBe(false);
    expect(progress(index, t.road.id)).toEqual({ done: 1, total: 7 });
    expect(progress(index, t.a1.id)).toBeNull();
    expect(countDone(index, t.m.id)).toBe(2);
    expect(ancestors(index, t.a2.id).map((x) => x.title)).toEqual(['InGame', 'Road to market', '2 Android signing']);
  });

  it('pins active nodes, needs-you nodes and session focus, with their ancestors', () => {
    const t = sample();
    const index = buildIndex(t.nodes);
    const pinned = pinnedIds(index, [{ focusNodeId: t.s6.id, state: 'idle' }, { focusNodeId: t.s7.id, state: 'ended' }]);
    expect(pinned.has(t.a3.id)).toBe(true);
    expect(pinned.has(t.road.id)).toBe(true);
    expect(pinned.has(t.s6.id)).toBe(true);
    expect(pinned.has(t.s7.id)).toBe(false);
    expect(pinned.has(t.m.id)).toBe(false);
  });
});

describe('needsYouAge', () => {
  const HOUR = 60 * 60 * 1000;
  const DAY = 24 * HOUR;
  const at = '2026-10-01T09:00:00.000Z';
  const age = (ms: number, updatedAt = at) => needsYouAge({ updatedAt }, Date.parse(at) + ms);

  it('is null under 24 hours, then whole days floored', () => {
    expect([0, HOUR, DAY - 1].map((ms) => age(ms))).toEqual([null, null, null]);
    expect(age(DAY)).toBe('1d');
    expect(age(2 * DAY - 1)).toBe('1d');
    expect(age(2 * DAY)).toBe('2d');
    expect(age(5 * DAY + 23 * HOUR)).toBe('5d');
    expect(age(14 * DAY - 1)).toBe('13d');
  });

  it('turns to whole weeks floored at 14 days', () => {
    expect(age(14 * DAY)).toBe('2w');
    expect(age(21 * DAY - 1)).toBe('2w');
    expect(age(21 * DAY)).toBe('3w');
    expect(age(70 * DAY)).toBe('10w');
  });

  it('is null for a time it cannot read or one ahead of now', () => {
    expect(age(30 * DAY, 't')).toBeNull();
    expect(age(-DAY)).toBeNull();
  });

  it('calls an item stale past three days', () => {
    expect(NEEDS_YOU_STALE_MS).toBe(3 * DAY);
  });
});

describe('computeVisible', () => {
  it('folds done branches and hides the far todo tail', () => {
    const t = sample();
    const items = computeVisible(buildIndex(t.nodes), []);
    const titles = items.map((i) => (i.type === 'node' ? `${i.node.title}${i.folded ? ' [folded]' : ''}` : `+${i.hiddenIds.length} more`));
    expect(titles).toEqual([
      'InGame', 'M1-M6 build [folded]', 'Road to market', '1 iOS certificate', '2 Android signing',
      'Upload keystore', 'Play app signing', 'Run signing tests', '3 RevenueCat', '4 Build to GitHub', '+3 more',
    ]);
  });

  it('splits hidden runs around a pinned node', () => {
    const t = sample();
    const nodes = t.nodes.map((x) => (x.id === t.s6.id ? { ...x, assignee: 'me' as const } : x));
    const items = computeVisible(buildIndex(nodes), []);
    const tail = items.slice(-4).map((i) => (i.type === 'node' ? i.node.title : `+${i.hiddenIds.length} more`));
    expect(tail).toEqual(['4 Build to GitHub', '+1 more', '6 Beta', '+1 more']);
  });

  it('does not hide a single leftover node', () => {
    const t = sample();
    const nodes = t.nodes.filter((x) => x.id !== t.s6.id && x.id !== t.s7.id);
    const items = computeVisible(buildIndex(nodes), []);
    expect(items.some((i) => i.type === 'more')).toBe(false);
  });

  it('honours manual overrides and noFold', () => {
    const t = sample();
    const index = buildIndex(t.nodes);
    const opened = computeVisible(index, [], { overrides: { [`n:${t.m.id}`]: 'open', [`more:${t.road.id}`]: 'open' } });
    expect(opened.filter((i) => i.type === 'node')).toHaveLength(15);
    const closed = computeVisible(index, [], { overrides: { [`n:${t.s2.id}`]: 'closed' } });
    expect(closed.find((i) => i.type === 'node' && i.node.id === t.s2.id)).toMatchObject({ folded: true });
    expect(computeVisible(index, [], { noFold: true }).filter((i) => i.type === 'node')).toHaveLength(15);
  });

  it('keeps a done branch open while it holds a needs-you node', () => {
    const t = sample();
    const signOff = n(t.m.id, 'Sign off M6', { assignee: 'me' });
    const items = computeVisible(buildIndex([...t.nodes, signOff]), []);
    expect(items.find((i) => i.type === 'node' && i.node.id === t.m.id)).toMatchObject({ folded: false });
    expect(items.slice(1, 5).map(label)).toEqual(['M1-M6 build', 'M1', 'M2', 'Sign off M6']);
  });

  it('never hides a tail node that has active work under it', () => {
    const t = sample();
    const checklist = n(t.s7.id, 'Launch checklist', { status: 'active' });
    const items = computeVisible(buildIndex([...t.nodes, checklist]), []);
    expect(items.slice(-4).map(label)).toEqual(['4 Build to GitHub', '+2 more', '7 Launch', 'Launch checklist']);
    expect(items.filter((i) => i.type === 'more')).toMatchObject([{ hiddenIds: [t.s5.id, t.s6.id] }]);
  });

  it('keeps a live session focus open and folds it once the session ends', () => {
    const t = sample();
    const index = buildIndex(t.nodes);
    const mWhen = (state: 'idle' | 'ended') =>
      computeVisible(index, [{ focusNodeId: t.m.id, state }]).find((i) => i.type === 'node' && i.node.id === t.m.id);
    expect(mWhen('idle')).toMatchObject({ folded: false });
    expect(mWhen('ended')).toMatchObject({ folded: true });
  });

  it('orders siblings by position, not id', () => {
    nextId = 1;
    const p = n(null, 'P', { status: 'active' });
    const inIdOrder = [n(p.id, 'c', { position: 3 }), n(p.id, 'b', { position: 2 }), n(p.id, 'a', { position: 1 })];
    const items = computeVisible(buildIndex([p, ...inIdOrder]), []);
    expect(items.map(label)).toEqual(['P', 'a', 'b', 'c']);
  });

  it('hides dropped children past the visible slots along with the far todo tail', () => {
    nextId = 1;
    const p = n(null, 'P', { status: 'active' });
    const frontier = n(p.id, 'frontier', { status: 'active' });
    const [t1, t2, t3] = [n(p.id, 't1'), n(p.id, 't2'), n(p.id, 't3')];
    const dropped = n(p.id, 'dropped', { status: 'dropped' });
    const t4 = n(p.id, 't4');
    const items = computeVisible(buildIndex([p, frontier, t1, t2, t3, dropped, t4]), []);
    expect(items.map(label)).toEqual(['P', 'frontier', 't1', 't2', '+3 more']);
    expect(items[4]).toMatchObject({ type: 'more', parentId: p.id, hiddenIds: [t3.id, dropped.id, t4.id] });
  });

  it('keeps dropped children visible until both todo slots are filled', () => {
    nextId = 1;
    const p = n(null, 'P', { status: 'active' });
    const children = [n(p.id, 'frontier', { status: 'active' }), n(p.id, 'dropped', { status: 'dropped' }), n(p.id, 't1'), n(p.id, 't2'), n(p.id, 't3')];
    expect(computeVisible(buildIndex([p, ...children]), []).map(label)).toEqual(['P', 'frontier', 'dropped', 't1', 't2', 't3']);
  });

  it('hides only what follows the second visible todo', () => {
    nextId = 1;
    const p = n(null, 'P', { status: 'active' });
    const children = [n(p.id, 'frontier', { status: 'active' }), n(p.id, 'dropped', { status: 'dropped' }), n(p.id, 't1'), n(p.id, 't2')];
    const [t3, t4] = [n(p.id, 't3'), n(p.id, 't4')];
    const items = computeVisible(buildIndex([p, ...children, t3, t4]), []);
    expect(items.map(label)).toEqual(['P', 'frontier', 'dropped', 't1', 't2', '+2 more']);
    expect(items[5]).toMatchObject({ type: 'more', parentId: p.id, hiddenIds: [t3.id, t4.id] });
  });

  it('never spends one of the two visible slots on a pinned child', () => {
    nextId = 1;
    const p = n(null, 'P', { status: 'active' });
    const children = [n(p.id, 'frontier', { status: 'active' }), n(p.id, 'Y', { assignee: 'me' }), n(p.id, 't1'), n(p.id, 't2'), n(p.id, 't3')];
    expect(computeVisible(buildIndex([p, ...children]), []).map(label)).toEqual(['P', 'frontier', 'Y', 't1', 't2', 't3']);
  });
});

describe('computeVisible with doneRuns', () => {
  const NOW = Date.parse('2026-10-04T12:00:00Z');
  const HOUR = 60 * 60 * 1000;
  const at = (hoursAgo: number) => new Date(NOW - hoursAgo * HOUR).toISOString();
  /** A done step finished `hoursAgo` hours before NOW. */
  const done = (parentId: number, title: string, hoursAgo = 48) => n(parentId, title, { status: 'done', completedAt: at(hoursAgo), updatedAt: at(hoursAgo) });
  /** A dropped step last changed `hoursAgo` hours before NOW. */
  const dropped = (parentId: number, title: string, hoursAgo = 48) => n(parentId, title, { status: 'dropped', updatedAt: at(hoursAgo) });
  const opts = { doneRuns: { now: NOW } };
  const show = (i: VisibleItem): string => (i.type === 'node' ? i.node.title : i.variant === 'done' ? `✓ ${i.hiddenIds.length} done` : `+${i.hiddenIds.length} more`);

  it('leaves a run of two old finished steps alone', () => {
    nextId = 1;
    const p = n(null, 'P', { status: 'active' });
    const nodes = [p, done(p.id, 'd1'), dropped(p.id, 'd2'), n(p.id, 'frontier', { status: 'active' })];
    expect(computeVisible(buildIndex(nodes), [], opts).map(show)).toEqual(['P', 'd1', 'd2', 'frontier']);
  });

  it('folds a run of three old done or dropped steps, with their subtrees, into one row', () => {
    nextId = 1;
    const p = n(null, 'P', { status: 'active' });
    const d1 = done(p.id, 'd1');
    const inner = done(d1.id, 'inner');
    const d2 = dropped(p.id, 'd2');
    const d3 = done(p.id, 'd3', 25);
    const items = computeVisible(buildIndex([p, d1, inner, d2, d3, n(p.id, 'frontier', { status: 'active' })]), [], opts);
    expect(items.map(show)).toEqual(['P', '✓ 3 done', 'frontier']);
    expect(items[1]).toEqual({ type: 'more', parentId: p.id, run: 0, depth: 1, hiddenIds: [d1.id, d2.id, d3.id], variant: 'done' });
  });

  it('splits a run at a step finished an hour ago, and counts a done step with no completion time as recent', () => {
    nextId = 1;
    const p = n(null, 'P', { status: 'active' });
    const first = [done(p.id, 'a1'), done(p.id, 'a2'), done(p.id, 'a3')];
    const recent = done(p.id, 'recent', 1);
    const second = [dropped(p.id, 'b1'), done(p.id, 'b2'), done(p.id, 'b3')];
    const legacy = n(p.id, 'legacy', { status: 'done', completedAt: null, updatedAt: at(48) });
    const third = [done(p.id, 'c1'), done(p.id, 'c2')];
    const items = computeVisible(buildIndex([p, ...first, recent, ...second, legacy, ...third]), [], opts);
    expect(items.map(show)).toEqual(['P', '✓ 3 done', 'recent', '✓ 3 done', 'legacy', 'c1', 'c2']);
    expect(items.filter((i) => i.type === 'more')).toMatchObject([
      { run: 0, hiddenIds: first.map((x) => x.id) },
      { run: 1, hiddenIds: second.map((x) => x.id) },
    ]);
  });

  it('splits a run at a pinned step: a canvas pin, or the ancestor of a session focus', () => {
    nextId = 1;
    const p = n(null, 'P', { status: 'active' });
    const kids = ['d1', 'd2', 'd3', 'd4', 'd5', 'd6', 'd7', 'd8', 'd9'].map((t) => done(p.id, t));
    const focus = n(kids[8].id, 'reopened', { status: 'done', completedAt: at(48) });
    const index = buildIndex([p, ...kids, focus]);
    const items = computeVisible(index, [{ focusNodeId: focus.id, state: 'idle' }], { ...opts, pins: [kids[3].id] });
    expect(items.map(show)).toEqual(['P', '✓ 3 done', 'd4', '✓ 4 done', 'd9', 'reopened']);
  });

  it('opens a parent\'s runs with its done: override, but not with its chevron', () => {
    nextId = 1;
    const p = n(null, 'P', { status: 'active' });
    const phase = n(p.id, 'Old phase', { status: 'done', completedAt: at(48) });
    const kids = [done(phase.id, 'd1'), done(phase.id, 'd2'), done(phase.id, 'd3')];
    const index = buildIndex([p, phase, ...kids]);
    // Unfolded by its chevron, a done parent still folds its old runs.
    const chevron = computeVisible(index, [], { ...opts, overrides: { [`n:${phase.id}`]: 'open' } });
    expect(chevron.map(show)).toEqual(['P', 'Old phase', '✓ 3 done']);
    const opened = computeVisible(index, [], { ...opts, overrides: { [`n:${phase.id}`]: 'open', [`done:${phase.id}`]: 'open' } });
    expect(opened.map(show)).toEqual(['P', 'Old phase', 'd1', 'd2', 'd3']);
  });

  it('leaves steps the tail hides to the tail, and folds nothing without doneRuns or with noFold', () => {
    nextId = 1;
    const p = n(null, 'P', { status: 'active' });
    const nodes = [p, n(p.id, 'frontier', { status: 'active' }), n(p.id, 't1'), n(p.id, 't2'), dropped(p.id, 'x1'), dropped(p.id, 'x2'), dropped(p.id, 'x3')];
    const items = computeVisible(buildIndex(nodes), [], opts);
    expect(items.map(show)).toEqual(['P', 'frontier', 't1', 't2', '+3 more']);
    expect(items[4]).toMatchObject({ type: 'more', run: 0, variant: 'tail' });
    const finished = [p, done(p.id, 'd1'), done(p.id, 'd2'), done(p.id, 'd3')];
    expect(computeVisible(buildIndex(finished), []).map(show)).toEqual(['P', 'd1', 'd2', 'd3']);
    expect(computeVisible(buildIndex(finished), [], { ...opts, noFold: true }).map(show)).toEqual(['P', 'd1', 'd2', 'd3']);
  });

  it('never folds the steps an opened "+n more" shows, while old runs elsewhere under the parent still fold', () => {
    nextId = 1;
    const p = n(null, 'P', { status: 'active' });
    const nodes = [
      p, done(p.id, 'd1'), done(p.id, 'd2'), done(p.id, 'd3'),
      n(p.id, 'frontier', { status: 'active' }), n(p.id, 't1'), n(p.id, 't2'),
      dropped(p.id, 'x1'), dropped(p.id, 'x2'), dropped(p.id, 'x3'),
    ];
    const index = buildIndex(nodes);
    expect(computeVisible(index, [], opts).map(show)).toEqual(['P', '✓ 3 done', 'frontier', 't1', 't2', '+3 more']);
    const opened = computeVisible(index, [], { ...opts, overrides: { [`more:${p.id}`]: 'open' } });
    expect(opened.map(show)).toEqual(['P', '✓ 3 done', 'frontier', 't1', 't2', 'x1', 'x2', 'x3']);
  });

  it('leaves the text outline unchanged: every old finished step still prints', () => {
    nextId = 1;
    const p = n(null, 'P', { status: 'active' });
    const kids = [done(p.id, 'd1'), dropped(p.id, 'd2'), done(p.id, 'd3'), done(p.id, 'd4')];
    const index = buildIndex([p, ...kids]);
    // The canvas folds them...
    expect(computeVisible(index, [], opts).map(show)).toEqual(['P', '✓ 4 done']);
    // ...and the outline the CLI, MCP and briefing read never does.
    expect(renderOutline(index, []).split('\n')).toEqual([
      `#${p.id} P — active (3/3)`,
      `  #${kids[0].id} d1 — done`,
      `  #${kids[1].id} d2 — dropped`,
      `  #${kids[2].id} d3 — done`,
      `  #${kids[3].id} d4 — done`,
    ]);
  });
});

describe('renderOutline', () => {
  it('renders ids, statuses, needs-you, progress, resources and folds', () => {
    const t = sample();
    const text = renderOutline(buildIndex(t.nodes), [], { resourcesByNode: new Map([[t.a3.id, [12]]]) });
    expect(text.split('\n')).toEqual([
      `#${t.root.id} InGame — active (1/2)`,
      `  #${t.m.id} M1-M6 build (phase) — done (2/2) · 2 done inside (folded)`,
      `  #${t.road.id} Road to market (phase) — active (1/7)`,
      `    #${t.s1.id} 1 iOS certificate — done`,
      `    #${t.s2.id} 2 Android signing — active (1/3)`,
      `      #${t.a1.id} Upload keystore — done`,
      `      #${t.a2.id} Play app signing — active`,
      `      #${t.a3.id} Run signing tests — NEEDS YOU [r12]`,
      `    #${t.s3.id} 3 RevenueCat — todo`,
      `    #${t.s4.id} 4 Build to GitHub — todo`,
      `    +3 more: #${t.s5.id}, #${t.s6.id}, #${t.s7.id}`,
    ]);
  });

  it('prints a labelled step with its glyph before the title, for every label', () => {
    nextId = 1;
    const root = n(null, 'InProgress', { status: 'active' });
    const phase = n(root.id, 'Live work', { kind: 'phase', status: 'active', label: 'ui' });
    const rows = n(phase.id, 'UI: working-task rows', { status: 'active', label: 'ui' });
    const plain = n(phase.id, 'Unlabelled step');
    const lines = renderOutline(buildIndex([root, phase, rows, plain]), []).split('\n');
    expect(lines).toEqual([
      `#${root.id} InProgress — active (0/1)`,
      `  #${phase.id} ⧉ Live work (phase) — active (0/2)`,
      `    #${rows.id} ⧉ UI: working-task rows — active`,
      `    #${plain.id} Unlabelled step — todo`,
    ]);
    const glyphs = NODE_LABELS.map((label) => renderOutline(buildIndex([n(null, 'R', { id: 1 }), n(1, 'Step', { id: 2, label })]), []).split('\n')[1]);
    expect(glyphs).toEqual(['⧉', '⚙', '⛁', '⇄', '⚒', '¶', '⚑', '↻', '⌕'].map((g) => `  #2 ${g} Step — todo`));
  });
});
