// No text in the repo holds an em dash (U+2014) or an HTML entity for one: prose uses a comma, a colon, a period or
// parentheses, and generated text uses " · ". The scan covers every file git tracks, and the untracked ones .gitignore
// lets through, so a new file is caught before it is added. package-lock.json is npm's, not ours. Code that reads text
// from elsewhere may still match the character, spelled as an escape (web/src/live.ts withoutOwnId).
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';

const repo = fileURLToPath(new URL('../..', import.meta.url));
/** Spelled as an escape, so this file passes its own scan. */
const EM_DASH = '\u2014';
/** The HTML entities that render one. */
const EM_DASH_ENTITY = /&(?:mdash|#8212|#x2014);/i;
const hasEmDash = (text: string): boolean => text.includes(EM_DASH) || EM_DASH_ENTITY.test(text);
const SKIP_FILES = new Set(['package-lock.json']);
/** Folders the walk leaves out at any depth when git cannot list the files: .git and the folders .gitignore names. */
const SKIP_DIRS = new Set(['.git', 'node_modules', 'dist', 'coverage', 'test-results', 'playwright-report', '.superpowers', '.dev-home', '.e2e-home', '.test-home', '.test-claude', '.live-check', '.build', '.deploy']);
/** Left out by path: the nested worktrees (.git/info/exclude keeps them out of git's listing). */
const SKIP_PATHS = new Set(['.claude/worktrees']);

/** The files git tracks plus the untracked ones it does not ignore, relative to `root`; null without git. */
function gitFiles(root: string): string[] | null {
  try {
    const out = execFileSync('git', ['ls-files', '-z', '--cached', '--others', '--exclude-standard'], { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
    return [...new Set(out.split('\0').filter(Boolean))].sort();
  } catch {
    return null;
  }
}

/** Every file under `root` outside the skipped folders and logs, relative and with forward slashes. */
function walkFiles(root: string, dir = '', out: string[] = []): string[] {
  for (const entry of readdirSync(join(root, dir), { withFileTypes: true })) {
    const rel = dir ? `${dir}/${entry.name}` : entry.name;
    if (entry.isDirectory()) {
      if (!SKIP_DIRS.has(entry.name) && !SKIP_PATHS.has(rel)) walkFiles(root, rel, out);
    } else if (entry.isFile() && !entry.name.endsWith('.log')) out.push(rel);
  }
  return out.sort();
}

/**
 * `file:line: text` for each line of `files` (under `root`) holding an em dash or its HTML entity. Binary and unreadable
 * files are skipped.
 */
function emDashLines(root: string, files: string[]): string[] {
  const hits: string[] = [];
  for (const file of files) {
    if (SKIP_FILES.has(file)) continue;
    let text: string;
    try {
      text = readFileSync(join(root, file), 'utf8');
    } catch {
      continue; // deleted from the working tree but still in the index, or a nested repo's folder entry
    }
    if (text.includes('\0') || !hasEmDash(text)) continue;
    text.split('\n').forEach((line, i) => {
      if (hasEmDash(line)) hits.push(`${file}:${i + 1}: ${line.trim().slice(0, 160)}`);
    });
  }
  return hits;
}

const temps: string[] = [];
afterAll(() => {
  for (const dir of temps) rmSync(dir, { recursive: true, force: true });
});

describe('no em dashes', () => {
  it('finds none in any text file of the repo', () => {
    const files = gitFiles(repo) ?? walkFiles(repo);
    // A listing that came back empty or partial would pass vacuously.
    expect(files).toContain('test/repo/no-em-dash.test.ts');
    expect(files).toContain('claude/agents/inprogress-scribe.md');
    expect(files.length).toBeGreaterThan(100);
    const hits = emDashLines(repo, files);
    expect(hits, `Em dashes (U+2014) found. Use a comma, a colon, a period or parentheses in prose, " · " in generated text:\n${hits.join('\n')}`).toEqual([]);
  });

  it('names the file and line of each em dash or em dash entity, and passes en dashes, binaries and the lockfile', () => {
    const root = mkdtempSync(join(tmpdir(), 'ip-em-dash-'));
    temps.push(root);
    mkdirSync(join(root, 'docs'));
    writeFileSync(join(root, 'docs', 'a.md'), `one\ntwo ${EM_DASH} three\nfour \u2013 five\n${EM_DASH}six`);
    writeFileSync(join(root, 'b.bin'), `\0${EM_DASH}`);
    writeFileSync(join(root, 'package-lock.json'), `"${EM_DASH}"`);
    // Split, so this file holds no entity either.
    const entities = ['&' + 'mdash;', '&' + '#8212;', '&' + '#X2014;'];
    writeFileSync(join(root, 'c.html'), `<p>a</p>\n${entities.map((e) => `<p>x ${e} y</p>`).join('\n')}\n<p>&amp;mdash</p>`);
    expect(emDashLines(root, ['docs/a.md', 'b.bin', 'package-lock.json', 'gone.md', 'c.html'])).toEqual([
      `docs/a.md:2: two ${EM_DASH} three`,
      `docs/a.md:4: ${EM_DASH}six`,
      ...entities.map((e, i) => `c.html:${i + 2}: <p>x ${e} y</p>`),
    ]);
  });

  it('walks to every file git lists when git is missing', () => {
    const listed = gitFiles(repo);
    if (!listed) return; // no git here: the scan above already used the walk
    const walked = new Set(walkFiles(repo));
    const present = listed.filter((f) => existsSync(join(repo, f)) && statSync(join(repo, f)).isFile());
    expect(present.filter((f) => !walked.has(f))).toEqual([]);
  });
});
