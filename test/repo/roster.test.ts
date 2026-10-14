// The roster (CLAUDE.md's one Sigmund line; Shipwright docs/roster-spec.md): the copied templates are filled, every
// wrapper's skill exists, Sigmund exists, and CLAUDE.md no longer carries the routing sections that moved into him.
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const repo = fileURLToPath(new URL('../..', import.meta.url));
const agentsDir = join(repo, '.claude', 'agents');
const skillsDir = join(repo, '.claude', 'skills');

/** Every file under `dir`, recursively, as absolute paths; none when `dir` is missing. */
function filesUnder(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? filesUnder(join(dir, e.name)) : [join(dir, e.name)]));
}

const read = (file: string): string => readFileSync(file, 'utf8').replace(/\r\n/g, '\n');

describe('the roster', () => {
  it('leaves no edit point unfilled under .claude/agents and .claude/skills', () => {
    const unfilled = [...filesUnder(agentsDir), ...filesUnder(skillsDir)].filter((f) => read(f).includes('{{'));
    expect(unfilled).toEqual([]);
  });

  it('preloads only skills that exist', () => {
    const wrappers = filesUnder(agentsDir).filter((f) => /^skills:/m.test(read(f)));
    expect(wrappers.length, 'murr and parvati preload their skills').toBe(2);
    for (const file of wrappers) {
      const name = read(file).match(/^skills:\s*(\S+)\s*$/m)?.[1] ?? '';
      expect(existsSync(join(skillsDir, name, 'SKILL.md')), `${file} preloads ${name}`).toBe(true);
    }
  });

  it('has Sigmund', () => {
    expect(existsSync(join(skillsDir, 'sigmund', 'SKILL.md'))).toBe(true);
  });

  it('keeps one Sigmund line in CLAUDE.md and no routing sections', () => {
    const text = read(join(repo, 'CLAUDE.md'));
    expect(text).toContain('Change work runs through Sigmund');
    for (const heading of ['## Routing', '## Overrides', '## Session rhythm', '## Handoff']) expect(text).not.toContain(heading);
  });
});
