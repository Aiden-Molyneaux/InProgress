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
  // The merge's range covers the line the copy rewrote: the copy's own text, which no upstream context could find.
  const rows = sideBySide({ raw, filled, local, fills: ['PROJECT', 'RISK', 'CHECKS'], fileFills: ['CHECKS'], conflictRanges: [{ start: local.split('\n').indexOf('Ship it on staging.') + 1, lines: 1 }] });

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

  it('marks every section a conflict range spans, and a range of no lines at its place', () => {
    const text = ['## A', 'a1', '', '## B', 'b1', '', '## C', 'c1'].join('\n');
    const spans = sideBySide({ raw: text, filled: text, local: text, fills: [], fileFills: [], conflictRanges: [{ start: 2, lines: 4 }] });
    expect(spans.filter((r) => r.conflict).map((r) => r.title)).toEqual(['A', 'B']);
    // A range of no copy lines without a base range points nowhere: it marks nothing rather than the section after it.
    const point = sideBySide({ raw: text, filled: text, local: text, fills: [], fileFills: [], conflictRanges: [{ start: 8, lines: 0 }] });
    expect(point.filter((r) => r.conflict)).toEqual([]);
  });

  it('puts a conflict on a section the copy deleted by its base range, not on the section after it', () => {
    const text = ['## A', 'a1', '', '## B', 'b1', '', '## C', 'c1'].join('\n');
    const local = ['## A', 'a1', '', '## C', 'c1'].join('\n');
    // The script's answer when the copy dropped B and Shipwright edited b1: no copy lines, at the line after the deletion.
    const rows = sideBySide({ raw: text, filled: text, local, fills: [], fileFills: [], conflictRanges: [{ start: 4, lines: 0, base: { start: 4, lines: 3 } }] });
    expect(rows.map((r) => [r.title, r.tag, r.conflict])).toEqual([
      ['Opening', 'same', false],
      ['A', 'same', false],
      ['B', 'removed', true],
      ['C', 'same', false],
    ]);
  });

  it('calls a placeholder nobody filled the template\'s own text, not a fill', () => {
    const text = '## A\n{{UNSET}}\n';
    expect(sideBySide({ raw: text, filled: text, local: text, fills: [], fileFills: [], conflictRanges: [] }).map((r) => r.tag)).toEqual(['same', 'same']);
  });
});

describe('unapply, at the edges', () => {
  const add = (header: string, ...lines: [' ' | '+' | '-', string][]) => ({ header, lines: lines.map(([kind, text]) => ({ kind, text })) });

  it('reads a CRLF copy with a BOM as the script does, LF and no BOM', () => {
    expect(unapply('﻿a\r\nB\r\n', [add('@@ -1,2 +1,2 @@', [' ', 'a'], ['-', 'b'], ['+', 'B'])])).toBe('a\nb\n');
  });

  it('takes a hunk at the very end, and one at the very start with no new lines', () => {
    expect(unapply('a\nb\nc', [add('@@ -3 +3 @@', ['-', 'x'], ['+', 'c'])])).toBe('a\nb\nx');
    expect(unapply('b', [add('@@ -1 +0,0 @@', ['-', 'a'])])).toBe('a\nb');
  });

  it('answers the text as it is with no hunks', () => {
    expect(unapply('a\nb\n', [])).toBe('a\nb\n');
  });
});
