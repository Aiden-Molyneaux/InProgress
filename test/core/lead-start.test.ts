import { describe, expect, it } from 'vitest';
import { startHandoff, startTitle, type StartHandoff } from '../../src/core/lead-start';

const H: StartHandoff = {
  lead: 'Progresser',
  projectName: 'InGame',
  stepId: 42,
  stepTitle: 'Play app signing',
  what: 'Sign the release build.',
  why: 'The store refuses unsigned builds.',
  goal: 'Ship the game.',
  phase: 'Store release.',
  onAidensWord: true,
};

describe('startHandoff', () => {
  it("is exactly the plan's lines when Aiden said so", () => {
    expect(startHandoff(H).split('\n')).toEqual([
      'Claim #42 Play app signing. Run this through Sigmund.',
      '',
      "Started by Progresser, the lead for InGame, on Aiden's word. This is not Aiden, and it is not a go-ahead to merge, deploy or push.",
      '',
      'What: Sign the release build.',
      'Why: The store refuses unsigned builds.',
      '',
      'Project goal: Ship the game.',
      'Current phase: Store release.',
      '',
      'First claim the step as your session briefing says, then follow the briefing.',
    ]);
  });

  it("names the lead's own judgment, under his mandate, when no words came with the start", () => {
    expect(startHandoff({ ...H, onAidensWord: false }).split('\n')[2]).toBe(
      "Started by Progresser, the lead for InGame, on the lead's own judgment, under his mandate. This is not Aiden, and it is not a go-ahead to merge, deploy or push.",
    );
  });

  it('puts every value on one line', () => {
    const lines = startHandoff({ ...H, lead: ' Pro\ngresser ', stepTitle: 'A\n\nB', what: 'one\r\ntwo\tthree', why: 'x y', goal: 'g\n## h', phase: 'p\u0000q' }).split('\n');
    expect(lines).toHaveLength(11);
    expect(lines[0]).toBe('Claim #42 A B. Run this through Sigmund.');
    expect(lines[2]).toContain('Started by Pro gresser, the lead');
    expect(lines[4]).toBe('What: one two three');
    expect(lines[5]).toBe('Why: x y');
    expect(lines[7]).toBe('Project goal: g ## h');
    expect(lines[8]).toBe('Current phase: p q');
  });
});

describe('startTitle', () => {
  it('is `#<id> <title>`, on one line, cut to 100 characters', () => {
    expect(startTitle(42, 'Play app signing')).toBe('#42 Play app signing');
    expect(startTitle(7, 'a\nb')).toBe('#7 a b');
    const long = startTitle(42, 'x'.repeat(300));
    expect(long).toHaveLength(100);
    expect(long.startsWith('#42 xxx')).toBe(true);
  });
});
