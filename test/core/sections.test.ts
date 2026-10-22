import { describe, expect, it } from 'vitest';
import { sectionAt, sectionKey, sectionStarts, sideBySide, unapply } from '../../src/core/sections';

describe('sectionStarts', () => {
  it('finds headings and bold paragraph leads, never inside a fence', () => {
    const text = ['# Title', '', '**The law [edit].** Text.', '', '```', '## Not a heading', '**Nor a lead.** x', '```', '### Sub', '**bold** not a lead'].join('\n');
    expect(sectionStarts(text)).toEqual([
      { line: 0, title: 'Title', level: 1 },
      { line: 2, title: 'The law [edit].', level: 0 },
      { line: 8, title: 'Sub', level: 3 },
    ]);
  });
});

describe('sectionAt', () => {
  it('names the last heading at or above a line, and skips leads', () => {
    const text = ['intro', '## One', '**Lead.** x', 'y', '## Two #', 'z'].join('\r\n');
    expect(sectionAt(text, 1)).toBeNull();
    expect(sectionAt(text, 3)).toBe('One');
    expect(sectionAt(text, 6)).toBe('Two');
  });
});

describe('sectionKey', () => {
  it('drops the edit mark, the closing period and case', () => {
    expect(sectionKey('The prime law [edit].')).toBe('the prime law');
    expect(sectionKey('Phase 1: branch [edit]')).toBe('phase 1: branch');
  });
});

describe('unapply', () => {
  it('puts the old side of each hunk back into the new text', () => {
    const now = ['a', 'B', 'c', 'd', 'new', 'e'].join('\n');
    const hunks = [
      { header: '@@ -1,3 +1,3 @@', lines: [{ kind: ' ' as const, text: 'a' }, { kind: '-' as const, text: 'b' }, { kind: '+' as const, text: 'B' }, { kind: ' ' as const, text: 'c' }] },
      { header: '@@ -4,2 +4,3 @@', lines: [{ kind: ' ' as const, text: 'd' }, { kind: '+' as const, text: 'new' }, { kind: ' ' as const, text: 'e' }] },
    ];
    expect(unapply(now, hunks)).toBe(['a', 'b', 'c', 'd', 'e'].join('\n'));
  });

  it('takes a hunk with no new lines at the line before its place', () => {
    expect(unapply(['a', 'c'].join('\n'), [{ header: '@@ -2 +1,0 @@', lines: [{ kind: '-', text: 'b' }] }])).toBe(['a', 'b', 'c'].join('\n'));
  });

  it('answers null when a hunk does not fit the text', () => {
    expect(unapply('x\ny', [{ header: '@@ -1 +1 @@', lines: [{ kind: '+', text: 'z' }] }])).toBeNull();
  });
});

describe('sideBySide', () => {
  const raw = ['---', 'name: {{PROJECT}}', '---', '', '**The law [edit].** {{RISK}} Every phase bends.', '', 'Plain text under the opening.', '', '## Routing', 'Same here.', '', '## Checks [edit]', '{{CHECKS}}', '', '## Ship', 'Ship it.', '', '## Gone', 'Bye.'].join('\n');
  const filled = raw.replace('{{PROJECT}}', 'Demo').replace('{{RISK}}', 'Data is precious.').replace('{{CHECKS}}', 'npm test');
  const local = filled
    .replace('Plain text under the opening.', '**Added rule.** Ours.\n\nPlain text under the opening.')
    .replace('Ship it.', 'Ship it on staging.')
    .replace('\n\n## Gone\nBye.', '');
  const rows = sideBySide({ raw, filled, local, fileFills: ['CHECKS'], conflictLines: [local.split('\n').indexOf('Ship it on staging.') + 1] });

  it('tags each template section by what the copy did with it', () => {
    expect(rows.map((r) => [r.title, r.tag])).toEqual([
      ['Opening', 'fill'],
      ['The law [edit].', 'fill'],
      ['Added rule.', 'added'],
      ['Opening', 'same'],
      ['Routing', 'same'],
      ['Checks [edit]', 'file fill'],
      ['Ship', 'rewritten'],
      ['Gone', 'removed'],
    ]);
  });

  it('keeps the placeholders on the left and the copy on the right', () => {
    const checks = rows.find((r) => r.title === 'Checks [edit]')!;
    expect(checks.template).toBe('{{CHECKS}}');
    expect(checks.placeholders).toEqual(['CHECKS']);
    expect(checks.project).toBe('npm test');
    expect(rows.find((r) => r.tag === 'added')!.template).toBeNull();
    expect(rows.find((r) => r.tag === 'removed')!.project).toBeNull();
  });

  it('marks the copy section a conflicting line falls in', () => {
    expect(rows.filter((r) => r.conflict).map((r) => r.title)).toEqual(['Ship']);
  });
});
