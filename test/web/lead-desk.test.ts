import { describe, expect, it } from 'vitest';
import { LEAD_INSTRUCTIONS_VERSION, type LeadBrief, type LeadEventOut } from '../../src/core/lead';
import { stamp } from '../../src/core/span';
import { deskGroups, deskHead, logLines } from '../../web/src/lead/leadDesk';

const NOW = Date.parse('2026-11-15T12:00:00.000Z');
const ago = (ms: number): string => new Date(NOW - ms).toISOString();
const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

const empty = (): LeadBrief => ({
  project: { slug: 'p', name: 'P', lead: null },
  at: new Date(NOW).toISOString(),
  instructions: { current: LEAD_INSTRUCTIONS_VERSION, yours: null },
  intent: { goal: '', phase: '', updatedAt: null },
  inFlight: [],
  waitingOnAiden: [],
  aidensOwn: [],
  aidenOpenAcrossProjects: 0,
  forTheLead: [],
  nextUp: [],
  backlog: 0,
  stale: [],
  landedSince: [],
  saidInAidensName: [],
  links: { t3: 'not checked', t3At: null, lastSeenAt: null },
});

const longText = 'x'.repeat(600);
const full = (): LeadBrief => ({
  ...empty(),
  project: { slug: 'p', name: 'P', lead: 'Progresser' },
  intent: { goal: 'Ship it', phase: 'Building', updatedAt: ago(DAY) },
  inFlight: [
    { stepId: 4, title: 'Build', sessionId: 's1', app: 'cli', state: 'working', lastSeenAt: ago(5 * MIN) },
    { stepId: null, title: 'Chat', sessionId: 's2', app: 'cli', state: 'idle', lastSeenAt: ago(2 * HOUR) },
  ],
  waitingOnAiden: [{ askId: 7, kind: 'question', stepId: 9, stepTitle: 'Pick a port', text: longText, raisedAt: ago(3 * DAY) }],
  aidensOwn: [{ stepId: 3, title: 'Sign it', updatedAt: ago(HOUR) }],
  aidenOpenAcrossProjects: 7,
  forTheLead: [
    { askId: 11, stepId: 5, stepTitle: 'Late', text: 'Do it', dueAt: ago(DAY), overdue: true },
    { askId: 12, stepId: 6, stepTitle: 'Open', text: 'Later', dueAt: null, overdue: false },
  ],
  nextUp: [{ stepId: 8, title: 'Next one', status: 'todo' }],
  backlog: 21,
  stale: [{ stepId: 2, title: 'Old', marks: ['blocked'], reasons: ['blocked', 'no session'] }],
  landedSince: [
    { stepId: 1, title: 'Done', outcome: 'It shipped', completedAt: ago(DAY) },
    { stepId: 10, title: 'Bare', outcome: '', completedAt: ago(DAY) },
  ],
  saidInAidensName: [{ at: ago(DAY), kind: 'answer', ref: 'a3', words: 'ship it' }],
  links: { t3: 'ok', t3At: ago(HOUR), lastSeenAt: ago(DAY) },
});

describe('deskGroups', () => {
  it('has the seven groups in order, with titles, counts and notes', () => {
    const g = deskGroups(full(), NOW);
    expect(g.map((x) => x.id)).toEqual(['needs', 'moving', 'stuck', 'next', 'promises', 'landed', 'said']);
    expect(g.map((x) => x.title)).toEqual([
      'Needs you',
      'Moving',
      'Stuck',
      'Next',
      "The lead's promises",
      "Landed since the lead's last look",
      "Said in your name since the lead's last look",
    ]);
    expect(g.map((x) => x.count)).toEqual([2, 2, 1, 1, 2, 2, 1]);
    expect(g[0].note).toBe('Open asks across all projects: 7 of 5, 2 over the limit');
    expect(g[1].note).toBe('2 of 3 in flight');
    expect(g[3].note).toBe('Backlog: 21 steps not started and not in the queue');
    expect(g[2].note).toBeUndefined();
  });

  it('puts own steps before asks and keeps an ask whole', () => {
    const needs = deskGroups(full(), NOW)[0];
    expect(needs.rows[0]).toMatchObject({ text: '#3 Sign it', meta: 'your own step, active · last changed 1h ago', nodeId: 3 });
    expect(needs.rows[1].text).toBe('a7 question · #9 Pick a port');
    expect(needs.rows[1].meta).toMatch(/^raised \S+ ago$/);
    expect(needs.rows[1].detail).toBe(longText);
    expect(needs.rows[1].meta).toBe('raised 3d ago');
  });

  it('words the other groups', () => {
    const g = deskGroups(full(), NOW);
    expect(g[1].rows[0]).toMatchObject({ text: '#4 Build', meta: 'working · cli · seen 5m ago', nodeId: 4 });
    expect(g[1].rows[1].text).toBe('Chat');
    expect(g[1].rows[1].nodeId).toBeUndefined();
    expect(g[2].rows[0].detail).toBe('blocked; no session');
    expect(g[3].rows[0]).toMatchObject({ text: '#8 Next one', meta: 'todo' });
    expect(g[4].rows[0]).toMatchObject({ text: 'a11 · #5 Late', detail: 'Do it', overdue: true, meta: `due ${stamp(ago(DAY))}` });
    expect(g[4].rows[1]).toMatchObject({ meta: 'no due time', overdue: false });
    expect(g[5].rows[0].detail).toBe('It shipped');
    expect(g[5].rows[1].detail).toBeUndefined();
    expect(g[6].rows[0]).toMatchObject({ text: `${stamp(ago(DAY))} answer a3`, detail: '"ship it"' });
    const keys = g.map((x) => new Set(x.rows.map((r) => r.key)).size === x.rows.length);
    expect(keys.every(Boolean)).toBe(true);
  });

  it('says a step for a backlog of one and the 7 day span with no look on record', () => {
    const b = { ...empty(), backlog: 1 };
    const g = deskGroups(b, NOW);
    expect(g[3].note).toBe('Backlog: 1 step not started and not in the queue');
    expect(g[5].title).toBe('Landed in the last 7 days');
    expect(g[6].title).toBe('Said in your name in the last 7 days');
  });

  it('gives seven groups with no rows for an empty brief', () => {
    const g = deskGroups(empty(), NOW);
    expect(g).toHaveLength(7);
    expect(g.every((x) => x.rows.length === 0 && x.count === 0)).toBe(true);
    expect(g[0].note).toBe('Open asks across all projects: 0 of 5');
  });
});

describe('deskHead', () => {
  it('reads a project with no lead and each goal fallback', () => {
    expect(deskHead(empty(), NOW)).toMatchObject({ lead: null, instructions: LEAD_INSTRUCTIONS_VERSION, goal: 'No intent record yet.', phase: 'none', warning: null });
    const written = { ...empty(), intent: { goal: '', phase: '', updatedAt: ago(DAY) } };
    expect(deskHead(written, NOW).goal).toBe('The intent record has no goal under a Goal heading.');
    expect(deskHead(full(), NOW)).toMatchObject({ lead: 'Progresser', goal: 'Ship it', phase: 'Building' });
  });

  it('shows the relay warning only under its rule: unavailable, and not yet followed by a look', () => {
    const b = empty();
    b.links = { t3: 'unavailable', t3At: ago(2 * HOUR), lastSeenAt: null };
    expect(deskHead(b, NOW).warning).toBe('The last relay may not have reached its session (2h ago).');
    b.links = { t3: 'unavailable', t3At: ago(2 * HOUR), lastSeenAt: ago(HOUR) };
    expect(deskHead(b, NOW).warning).toBeNull();
    b.links = { t3: 'unavailable', t3At: ago(HOUR), lastSeenAt: ago(2 * HOUR) };
    expect(deskHead(b, NOW).warning).not.toBeNull();
    b.links = { t3: 'ok', t3At: ago(HOUR), lastSeenAt: null };
    expect(deskHead(b, NOW).warning).toBeNull();
  });

  it('words the links line', () => {
    const b = empty();
    expect(deskHead(b, NOW).links).toBe("T3 Code not checked · the lead's last look never");
    b.links = { t3: 'ok', t3At: ago(3 * HOUR), lastSeenAt: ago(2 * DAY) };
    expect(deskHead(b, NOW).links).toBe("T3 Code ok, last relay 3h ago · the lead's last look 2d ago");
    b.links = { t3: 'unavailable', t3At: ago(5 * MIN), lastSeenAt: null };
    expect(deskHead(b, NOW).links).toBe("T3 Code unavailable, last relay 5m ago · the lead's last look never");
  });
});

describe('logLines', () => {
  const ev = (o: Partial<LeadEventOut>): LeadEventOut => ({
    id: 1,
    at: ago(HOUR),
    lead: 'Progresser',
    instructions: LEAD_INSTRUCTIONS_VERSION,
    kind: 'answer',
    nodeId: null,
    askId: null,
    sessionId: null,
    text: '',
    aidenWords: null,
    ...o,
  });
  it('reads an ask event with words, a step event, a bare one and relay_unknown', () => {
    const lines = logLines([
      ev({ id: 3, kind: 'answer', askId: 4, nodeId: 9, text: 'said\n  yes', aidenWords: 'go' }),
      ev({ id: 2, kind: 'park', nodeId: 5, text: 'later' }),
      ev({ id: 1, kind: 'relay_unknown' }),
    ]);
    expect(lines.map((l) => l.key)).toEqual([3, 2, 1]);
    expect(lines[0]).toMatchObject({ at: stamp(ago(HOUR)), kind: 'answer', ref: 'a4', text: 'said yes', words: 'go', by: `Progresser · v${LEAD_INSTRUCTIONS_VERSION}`, nodeId: 9 });
    expect(lines[1]).toMatchObject({ kind: 'park', ref: '#5', words: null, nodeId: 5 });
    expect(lines[2]).toMatchObject({ kind: 'relay unknown', ref: '', text: '' });
    expect(lines[2].nodeId).toBeUndefined();
  });
  it('names the intent record instead of printing it, and prints words that are also the reason once', () => {
    const lines = logLines([
      ev({ id: 2, kind: 'intent', text: '# Goal\nShip it' }),
      ev({ id: 1, kind: 'park', nodeId: 5, text: 'Park it,  for now.', aidenWords: 'Park it, for now.' }),
    ]);
    expect(lines[0].text).toBe('the intent record, 14 characters');
    expect(lines[1]).toMatchObject({ text: '', words: 'Park it, for now.' });
  });
});
