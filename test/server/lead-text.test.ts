import { describe, expect, it } from 'vitest';
import type { LeadBrief } from '../../src/core/lead';
import { stamp } from '../../src/server/digest';
import { intentHeadlines, renderLeadBrief } from '../../src/server/lead-text';

const AT = '2026-11-14T12:00:00.000Z';
const ago = (ms: number) => new Date(Date.parse(AT) - ms).toISOString();
const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

const empty: LeadBrief = {
  project: { slug: 'ingame', name: 'InGame', lead: 'Progresser' },
  at: AT,
  instructions: { current: 1, yours: 1 },
  intent: { goal: '', phase: '', updatedAt: null },
  inFlight: [],
  waitingOnAiden: [],
  aidenOpenAcrossProjects: 0,
  forTheLead: [],
  nextUp: [],
  stale: [],
  landedSince: [],
  saidInAidensName: [],
  links: { t3: 'not checked', t3At: null, lastSeenAt: null },
};

const full: LeadBrief = {
  ...empty,
  intent: { goal: 'Ship the Play Store build.', phase: 'Signing', updatedAt: ago(DAY) },
  inFlight: [
    { stepId: 12, title: 'Play app signing', sessionId: 's1', app: 't3', state: 'working', lastSeenAt: ago(3 * MIN) },
    { stepId: null, title: 'no step claimed', sessionId: 's2', app: 'cli', state: 'idle', lastSeenAt: ago(2 * HOUR) },
  ],
  waitingOnAiden: [{ askId: 7, kind: 'question', stepId: 12, stepTitle: 'Play app signing', text: 'Which keystore?', raisedAt: ago(3 * DAY) }],
  aidenOpenAcrossProjects: 4,
  forTheLead: [
    { askId: 9, stepId: 14, stepTitle: 'Release notes', text: 'Send Aiden the draft', dueAt: ago(HOUR), overdue: true },
    { askId: 10, stepId: 14, stepTitle: 'Release notes', text: 'Check the store listing', dueAt: new Date(Date.parse(AT) + DAY).toISOString(), overdue: false },
  ],
  nextUp: [{ stepId: 15, title: 'Add the privacy page', status: 'todo' }],
  stale: [{ stepId: 16, title: 'Old spike', marks: ['stale_ask', 'deep'] }],
  landedSince: [{ stepId: 11, title: 'Upload the key', outcome: 'Key uploaded to the vault.', completedAt: ago(DAY) }],
  saidInAidensName: [{ at: ago(5 * HOUR), kind: 'answer', ref: 'a6', words: 'Use the release keystore.' }],
  links: { t3: 'ok', t3At: ago(MIN), lastSeenAt: ago(2 * DAY) },
};

describe('renderLeadBrief', () => {
  it('prints the fixed shape, line for line', () => {
    expect(renderLeadBrief(full).split('\n')).toEqual([
      `Lead brief · InGame · ${stamp(AT)} · instructions v1 (yours: v1)`,
      'Goal: Ship the Play Store build.',
      'Phase: Signing',
      'In flight (2 of 3):',
      '  #12 Play app signing · working · t3 · seen 3m ago',
      '  no step claimed · idle · cli · seen 2h ago',
      'Waiting on Aiden (1 here, 4 of 5 across all projects):',
      '  a7 question on #12 Play app signing: "Which keystore?" · 3d',
      'For the lead (2):',
      `  a9 on #14 Release notes: "Send Aiden the draft" · due ${stamp(ago(HOUR))} · OVERDUE`,
      `  a10 on #14 Release notes: "Check the store listing" · due ${stamp(new Date(Date.parse(AT) + DAY).toISOString())}`,
      'Next up (1):',
      '  #15 Add the privacy page · todo',
      'Stale (1):',
      '  #16 Old spike · stale_ask, deep',
      'Landed since your last look (1):',
      '  #11 Upload the key: "Key uploaded to the vault."',
      "Said in Aiden's name since your last look (1):",
      `  ${stamp(ago(5 * HOUR))} answer a6: "Use the release keystore."`,
      'Links: T3 Code ok · your last look 2d ago',
    ]);
  });

  it('renders the same text twice for the same brief, whatever the clock says', () => {
    const first = renderLeadBrief(full);
    expect(renderLeadBrief(structuredClone(full))).toBe(first);
  });

  it('prints every section with (0) and none for an empty brief', () => {
    const lines = renderLeadBrief(empty).split('\n');
    expect(lines).toEqual([
      `Lead brief · InGame · ${stamp(AT)} · instructions v1 (yours: v1)`,
      'Goal: No intent record yet.',
      'Phase: none',
      'In flight (0 of 3):',
      '  none',
      'Waiting on Aiden (0 here, 0 of 5 across all projects):',
      '  none',
      'For the lead (0):',
      '  none',
      'Next up (0):',
      '  none',
      'Stale (0):',
      '  none',
      'Landed since your last look (0):',
      '  none',
      "Said in Aiden's name since your last look (0):",
      '  none',
      'Links: T3 Code not checked · your last look never',
    ]);
  });

  it('cuts a list of sixty to eight lines and "and 52 more"', () => {
    const stale = Array.from({ length: 60 }, (_, i) => ({ stepId: 100 + i, title: `Step ${i}`, marks: ['deep'] }));
    const lines = renderLeadBrief({ ...empty, stale }).split('\n');
    const at = lines.indexOf('Stale (60):');
    expect(at).toBeGreaterThan(0);
    expect(lines.slice(at + 1, at + 11)).toEqual([...stale.slice(0, 8).map((s) => `  #${s.stepId} ${s.title} · deep`), '  and 52 more', 'Landed since your last look (0):']);
  });

  it('cuts a long ask text to 120 characters', () => {
    const text = 'x'.repeat(300);
    const line = renderLeadBrief({ ...full, waitingOnAiden: [{ ...full.waitingOnAiden[0], text }] })
      .split('\n')
      .find((l) => l.startsWith('  a7'))!;
    expect(line).toContain(`"${'x'.repeat(119)}…"`);
  });

  it('says on the second line when the instructions are out of date, and not otherwise', () => {
    const old = renderLeadBrief({ ...empty, instructions: { current: 2, yours: 1 } }).split('\n');
    expect(old[0]).toContain('instructions v2 (yours: v1)');
    expect(old[1]).toBe('Your instructions are out of date: you can read, you cannot change anything.');
    expect(old[2]).toBe('Goal: No intent record yet.');
    expect(renderLeadBrief(empty)).not.toContain('out of date');
    // The window reads with no instructions of its own: nothing to be out of date.
    const window = renderLeadBrief({ ...empty, instructions: { current: 1, yours: null } }).split('\n');
    expect(window[0]).toContain('(yours: none)');
    expect(window[1]).toBe('Goal: No intent record yet.');
  });
});


describe('renderLeadBrief on free text', () => {
  const ESC = String.fromCharCode(27);
  const NEL = String.fromCharCode(0x85);
  it('keeps a project name with a newline and an ask with an escape character on one line each', () => {
    const lines = renderLeadBrief({
      ...full,
      project: { ...full.project, name: 'InGame\nv2' },
      waitingOnAiden: [{ ...full.waitingOnAiden[0], text: `Delete ${ESC}[31mall${ESC}[0m${NEL} now\r\nreally?` }],
      landedSince: [{ ...full.landedSince[0], title: 'Two\nlines', outcome: 'Done\tand\nsaid\u2028so\u2029.' }],
    }).split('\n');
    expect(lines[0]).toBe(`Lead brief · InGame v2 · ${stamp(AT)} · instructions v1 (yours: v1)`);
    expect(lines.find((l) => l.startsWith('  a7'))).toBe('  a7 question on #12 Play app signing: "Delete [31mall [0m now really?" · 3d');
    expect(lines.find((l) => l.startsWith('  #11'))).toBe('  #11 Two lines: "Done and said so ."');
    // Every line of the text is a line of the shape: no control character or line separator survives.
    for (const l of lines) expect(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]/.test(l), l).toBe(false);
    expect(lines).toHaveLength(renderLeadBrief(full).split('\n').length);
  });

  it('says the record has no Goal heading when it is set and has none, and no record yet otherwise', () => {
    expect(renderLeadBrief({ ...empty, intent: { goal: '', phase: 'Signing', updatedAt: ago(DAY) } }).split('\n')[1]).toBe('Goal: The intent record has no Goal heading.');
    expect(renderLeadBrief(empty).split('\n')[1]).toBe('Goal: No intent record yet.');
  });
});

describe('intentHeadlines', () => {
  it('reads the first paragraph under Goal and under Phase', () => {
    const md = '# Intent\n\n## Goal\n\nShip the build\nthis month.\n\nA second paragraph.\n\n## Phase\n\nSigning.\n\n## Risks\n\nNone.\n';
    expect(intentHeadlines(md)).toEqual({ goal: 'Ship the build this month.', phase: 'Signing.' });
  });

  it('finds a heading at any level, with no space, a colon or closing hashes, in any case', () => {
    for (const heading of ['# Goal', '### goal', '##Goal', '## GOAL:', '## Goal ##', '#### Goal :  ']) {
      expect(intentHeadlines(`${heading}\nThe aim.\n`).goal, heading).toBe('The aim.');
    }
    expect(intentHeadlines('## Goals\nNot it.\n').goal).toBe('');
  });

  it('returns an empty string for a missing heading, and cuts to 300 characters', () => {
    expect(intentHeadlines('## Goal\n\nOnly a goal.\n')).toEqual({ goal: 'Only a goal.', phase: '' });
    expect(intentHeadlines('')).toEqual({ goal: '', phase: '' });
    expect(intentHeadlines(`## Phase\n${'y'.repeat(500)}\n`).phase).toHaveLength(300);
  });

  it('ends a paragraph at a heading, however it is written, but not at a line that opens with a step', () => {
    expect(intentHeadlines('## Goal\nOne line\n## Phase\nTwo')).toEqual({ goal: 'One line', phase: 'Two' });
    expect(intentHeadlines('## Goal\nOne line\n#Risks\nTwo')).toEqual({ goal: 'One line', phase: '' });
    expect(intentHeadlines('## Goal\nShip the lead: #725 to\n#729, in order.\n##Phase\nStage 1')).toEqual({ goal: 'Ship the lead: #725 to #729, in order.', phase: 'Stage 1' });
  });
});
