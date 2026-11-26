import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { LEAD_INSTRUCTIONS_VERSION } from '../../src/core/lead';
import { openDb } from '../../src/server/db/connection';
import { createCtx } from '../../src/server/db/tx';
import { leadAllow } from '../../src/server/lead-commands';
import { reserveAllowsStart } from '../../src/server/lead/reserve';
import { TurnRunError, type TurnInput, type TurnWay } from '../../src/server/lead/runner';
import { importUsage, leadCounts, PROBE_MODEL, probeUsage, weekText } from '../../src/server/lead/usage';
import { insertLeadEvent } from '../../src/server/repo/leadEvents';
import { addNodes } from '../../src/server/repo/nodes';
import { raiseAskDetailed } from '../../src/server/repo/asks';
import { addBinding, createProject, setProjectLead } from '../../src/server/repo/projects';
import { addReading, latestReading } from '../../src/server/repo/usageReadings';
import { handleHookEvent } from '../../src/server/session-flow';

const V = LEAD_INSTRUCTIONS_VERSION;
const MIN = 60_000;
const NOW = Date.parse('2026-11-25T14:00:00.000Z');
const iso = (ms: number): string => new Date(ms).toISOString();

function world(opts: { round?: boolean } = {}) {
  let t = NOW;
  const ctx = createCtx(openDb(':memory:'), () => iso(t));
  const project = createProject(ctx, 'test', { name: 'InProgress' });
  addBinding(ctx, 'test', project.slug, 'C:/personal/InProgress');
  setProjectLead(ctx, 'window', project.slug, 'Progresser');
  if (opts.round !== false) leadAllow(ctx, project.slug, 'Progresser', V, { switch: 'round', aidenWords: 'go' });
  const reading = (agoMin: number, week: number | null, window: number | null, extra: Partial<Parameters<typeof addReading>[1]> = {}) =>
    addReading(ctx.db, { at: iso(t - agoMin * MIN), source: 'turn', weekUsed: week, windowUsed: window, weekResets: iso(t + 3 * 24 * 60 * MIN), windowResets: iso(t + 90 * MIN), ...extra });
  return { ctx, project, reading, move: (ms: number) => void (t += ms) };
}

const dirs: string[] = [];
afterEach(() => {
  while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
});

/** A way that records what it was asked and streams the given rate limits, or fails. */
function fakeWay(limits: unknown[], fail = false): { way: TurnWay; inputs: TurnInput[] } {
  const inputs: TurnInput[] = [];
  return {
    inputs,
    way: {
      name: 'headless',
      async run(input) {
        inputs.push(input);
        if (fail) throw new TurnRunError('claude is not logged in', { rateLimits: [], model: PROBE_MODEL }, true);
        return { text: 'ok', costUsd: 0, durationMs: 1, tokensIn: 1, tokensOut: 1, refusedTools: [], rateLimits: limits, model: PROBE_MODEL };
      },
    },
  };
}
const RATE = { status: 'allowed', unifiedWindows: { five_hour: { utilization: 0.2, resetsAt: NOW / 1000 + 3600 }, seven_day: { utilization: 0.5, resetsAt: NOW / 1000 + 86400 * 3 } } };

describe('the reserve', () => {
  it('passes on a fresh reading under every limit', () => {
    const w = world();
    w.reading(5, 0.5, 0.3);
    expect(reserveAllowsStart(w.ctx, w.ctx.now())).toEqual({ ok: true });
  });

  it('refuses on no reading, an old one, the week at 0.95, the window at 0.85, and the window above 0.70 while Aiden is at work', () => {
    const w = world();
    expect(reserveAllowsStart(w.ctx, w.ctx.now())).toMatchObject({ ok: false });
    w.reading(75, 0.1, 0.1);
    expect(reserveAllowsStart(w.ctx, w.ctx.now())).toEqual({ ok: false, why: 'the newest usage reading is 75 min old', wait: true });
    w.reading(2, 0.95, 0.1);
    expect(reserveAllowsStart(w.ctx, w.ctx.now())).toEqual({ ok: false, why: 'the week is 95 percent used' });
    w.reading(1, 0.5, 0.85);
    expect(reserveAllowsStart(w.ctx, w.ctx.now())).toEqual({ ok: false, why: 'the window is 85 percent used' });
    w.reading(0, 0.5, 0.75);
    // Nobody at work: allowed.
    expect(reserveAllowsStart(w.ctx, w.ctx.now())).toEqual({ ok: true });
    // A prompt of Aiden's 10 minutes ago: refused. A relayed message sets no prompt time, so it never counts.
    handleHookEvent(w.ctx, 's1', { event: 'start', source: 'startup', cwd: 'C:/personal/InProgress' });
    w.ctx.db.prepare('UPDATE sessions SET last_prompt_at = ? WHERE id = ?').run(iso(NOW - 10 * MIN), 's1');
    expect(reserveAllowsStart(w.ctx, w.ctx.now())).toEqual({ ok: false, why: 'the window is 75 percent used and Aiden is at work' });
    w.ctx.db.prepare('UPDATE sessions SET last_prompt_at = ? WHERE id = ?').run(iso(NOW - 40 * MIN), 's1');
    expect(reserveAllowsStart(w.ctx, w.ctx.now())).toEqual({ ok: true });
  });
});

describe('the reserve and a week value from an old reading (U5)', () => {
  it('a reading with no week figure does not make an old week figure fresh', () => {
    const w = world();
    w.reading(90, 0.4, 0.1);
    // The newest reading is fresh but holds only the window: the week figure comes from 90 minutes ago.
    w.reading(1, null, 0.2);
    expect(reserveAllowsStart(w.ctx, w.ctx.now())).toEqual({ ok: false, why: 'the week figure comes from a usage reading 90 min old', wait: true });
    w.reading(0, 0.4, 0.2);
    expect(reserveAllowsStart(w.ctx, w.ctx.now())).toEqual({ ok: true });
  });

  it('no reading, and an old one, wait for a fresh one: they are not a low reserve', () => {
    const w = world();
    expect(reserveAllowsStart(w.ctx, w.ctx.now())).toMatchObject({ ok: false, wait: true });
    w.reading(75, 0.1, 0.1);
    expect(reserveAllowsStart(w.ctx, w.ctx.now())).toMatchObject({ ok: false, wait: true });
    w.reading(0, 0.96, 0.1);
    expect(reserveAllowsStart(w.ctx, w.ctx.now())).not.toHaveProperty('wait');
  });
});

describe('lead week', () => {
  it('says the week, the line, the window, the other gauge, the reserve and the age', () => {
    const w = world();
    expect(weekText(w.ctx.db, w.ctx.now(), { ok: true })).toBe('No usage reading yet.');
    w.reading(6, 0.41, 0.12, { other: JSON.stringify({ seven_day_opus: 0.07 }) });
    const text = weekText(w.ctx.db, w.ctx.now(), { ok: true });
    // The week resets in 3 days, so 4 of 7 days are gone: the line says 57.
    expect(text).toMatch(/^Week 41 percent used, the line says 57 \(resets \w+ \d\d:\d\d\)\. Window 12 percent \(resets \d\d:\d\d\)\. seven_day_opus 7 percent\. Reserve: untouched\. Newest reading 6 min ago\.$/);
    expect(weekText(w.ctx.db, w.ctx.now(), { ok: false, why: 'the week is 95 percent used' })).toContain('Reserve: touched: the week is 95 percent used.');
  });
});

describe('the usage probe', () => {
  it('runs only when the newest reading is over an hour old and a round is on, writes its readings, and at most once an hour', async () => {
    const w = world();
    const f = fakeWay([RATE, RATE]);
    w.reading(30, 0.1, 0.1);
    expect(await probeUsage(w.ctx, { way: f.way, home: 'h' })).toBe(false);
    expect(f.inputs).toHaveLength(0);
    w.move(40 * MIN);
    expect(await probeUsage(w.ctx, { way: f.way, home: 'h' })).toBe(true);
    expect(f.inputs[0]).toMatchObject({ model: 'claude-haiku-5-5', userMessage: 'ok', slug: '_probe', noTools: true });
    const rows = w.ctx.db.prepare("SELECT source, window_used, week_used FROM usage_readings WHERE source = 'probe'").all();
    expect(rows).toEqual([
      { source: 'probe', window_used: 0.2, week_used: 0.5 },
      { source: 'probe', window_used: 0.2, week_used: 0.5 },
    ]);
    // The reading is fresh now: no second probe.
    expect(await probeUsage(w.ctx, { way: f.way, home: 'h' })).toBe(false);
    expect(f.inputs).toHaveLength(1);
  });

  it('does not probe with no round on, and a failed probe is logged once and not retried within the hour', async () => {
    const off = world({ round: false });
    const f0 = fakeWay([RATE]);
    expect(await probeUsage(off.ctx, { way: f0.way, home: 'h' })).toBe(false);
    const w = world();
    const f = fakeWay([], true);
    const logged: string[] = [];
    const deps = { way: f.way, home: 'h', log: { error: (m: string) => void logged.push(m) } };
    expect(await probeUsage(w.ctx, deps)).toBe(true);
    expect(await probeUsage(w.ctx, deps)).toBe(false);
    w.move(61 * MIN);
    expect(await probeUsage(w.ctx, deps)).toBe(true);
    expect(f.inputs).toHaveLength(2);
    expect(logged).toEqual(['The usage probe failed: claude is not logged in']);
    expect(latestReading(w.ctx.db)).toBeUndefined();
  });
});

describe('import-usage', () => {
  it('imports stage 0 readings with source import, skips error lines, and a second import adds nothing', () => {
    const w = world();
    const dir = mkdtempSync(join(tmpdir(), 'usage-'));
    dirs.push(dir);
    const file = join(dir, 'readings.jsonl');
    const lines = [
      { at: '2026-11-25T10:00:00.000Z', window: 0.1, windowResets: '2026-11-25T14:00:00.000Z', week: 0.4, weekResets: '2026-11-30T00:00:00.000Z', status: 'allowed', overage: false, costUsd: 0 },
      { at: '2026-11-25T11:00:00.000Z', error: 'not logged in' },
      { at: '2026-11-25T12:00:00.000Z', window: 0.2, week: 0.41 },
    ];
    writeFileSync(file, lines.map((l) => JSON.stringify(l)).join('\n') + '\nnot json\n');
    expect(importUsage(w.ctx, file)).toEqual({ added: 2, skipped: 2 });
    expect(importUsage(w.ctx, file)).toEqual({ added: 0, skipped: 4 });
    expect(w.ctx.db.prepare("SELECT COUNT(*) FROM usage_readings WHERE source = 'import'").pluck().get()).toBe(2);
    expect(latestReading(w.ctx.db)).toMatchObject({ at: '2026-11-25T12:00:00.000Z', weekUsed: 0.41, source: 'import' });
  });
});

describe('lead counts, as stage 0 measured 1.55', () => {
  it('counts review, question and permission asks raised since that reached Aiden, per task closed', () => {
    const w = world();
    const [t1, t2, g] = addNodes(w.ctx, 'test', { parentId: w.project.rootNodeId, nodes: [{ title: 'One' }, { title: 'Two' }, { title: 'Three' }] });
    const ask = (kind: 'review' | 'question' | 'permission', text: string, id = t1!.id) => raiseAskDetailed(w.ctx, 'scribe:x', { nodeId: id, kind, text }).ask;
    w.move(MIN);
    const a1 = ask('review', 'Look at this');
    const a2 = ask('question', 'Which port?');
    const a3 = ask('question', 'Which file?');
    const a4 = ask('permission', 'Run npm?');
    ask('question', 'Still open?');
    // The lead decided a3 and carded a4: they never reached Aiden. a2 was decided and then undone, so it did.
    w.ctx.db.prepare("UPDATE asks SET cleared_at = ?, answered_via = 'lead_decided' WHERE id IN (?, ?)").run(w.ctx.now(), a2.id, a3.id);
    w.ctx.db.prepare("UPDATE asks SET cleared_at = ?, answered_via = 'lead_card' WHERE id = ?").run(w.ctx.now(), a4.id);
    insertLeadEvent(w.ctx.db, { projectId: w.project.id, lead: 'Progresser', instructions: V, kind: 'undo', askId: a2.id, text: 'd1' }, w.ctx.now());
    void a1;
    // A promise of the lead's is not Aiden's, and an ask raised before `since` is another period's.
    w.ctx.db.prepare("INSERT INTO asks (project_id, node_id, kind, text, raised_at, owner) SELECT project_id, node_id, 'review', 'promise', raised_at, 'lead' FROM asks WHERE id = ?").run(a1.id);
    w.ctx.db.prepare("UPDATE nodes SET status = 'done', completed_at = ? WHERE id IN (?, ?)").run(iso(NOW + 5 * MIN), t1!.id, t2!.id);
    w.ctx.db.prepare("UPDATE nodes SET status = 'done', completed_at = ? WHERE id = ?").run(iso(NOW + 5 * MIN), g!.id);
    const c = leadCounts(w.ctx, w.project.id, iso(NOW));
    // Reached: a1, a2 (undone), the open one = 3. Closed: 3 tasks.
    expect(c).toMatchObject({ reached: 3, closed: 3, ratio: 1 });
    expect(c.text).toContain('Stage 0 was 1.55.');
    // The since bound is exclusive, as stage 0's was: asks raised at it are the period before.
    expect(leadCounts(w.ctx, w.project.id, w.ctx.now())).toMatchObject({ reached: 0 });
  });
});

describe('the reserve with no week figure (Y9)', () => {
  it('waits when no reading looked at has a week figure, never allows', () => {
    const w = world();
    w.reading(5, null, 0.2);
    expect(reserveAllowsStart(w.ctx, w.ctx.now())).toEqual({ ok: false, why: 'no usage reading has a week figure', wait: true });
  });
});
