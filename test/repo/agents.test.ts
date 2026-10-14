// The roster's agents (.claude/skills/sigmund/SKILL.md, Model routing): each pins a full model id so a model change is deliberate, and sets an effort.
// Overrides at dispatch pass aliases; the files never do.
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const dir = fileURLToPath(new URL('../../.claude/agents', import.meta.url));
const files = readdirSync(dir).filter((f) => f.endsWith('.md')).sort();

/** The frontmatter's `key: value` lines, as a map. */
function frontmatter(file: string): Map<string, string> {
  const text = readFileSync(join(dir, file), 'utf8').replace(/\r\n/g, '\n');
  const block = text.match(/^---\n([\s\S]*?)\n---\n/)?.[1] ?? '';
  return new Map(
    block.split('\n')
      .map((l) => l.match(/^(\w+):\s*(.*)$/))
      .filter((m): m is RegExpMatchArray => !!m)
      .map((m) => [m[1], m[2].trim()]),
  );
}

describe('.claude/agents', () => {
  it('holds exactly the routed agents', () => {
    expect(files).toEqual(['moh.md', 'murr.md', 'parvati.md', 'sev.md']);
  });

  for (const file of files) {
    it(`${file} names itself, pins a full model id and sets effort`, () => {
      const fm = frontmatter(file);
      expect(fm.get('name')).toBe(file.replace(/\.md$/, ''));
      expect(fm.get('description')?.length).toBeGreaterThan(40);
      expect(fm.get('model')).toMatch(/^claude-[a-z]+-\d+(-\d+)?$/);
      expect(['low', 'medium', 'high', 'xhigh', 'max']).toContain(fm.get('effort'));
      expect(fm.get('tools')).toBeTruthy();
    });
  }
});
