import { describe, expect, it } from 'vitest';
import { findSecretLine, frameHtml, PAGE_CSP, parseHtmlFront, parseMarkdownFront } from '../../src/server/pages';

// The cases that need a git repo (registration, the live body, freshness, the served frame) are in test/slow/pages.test.ts.
describe('pages: the HTML frame', () => {
  it('frameHtml puts the meta first in the head, after a doctype, or at the start', () => {
    const meta = `<meta http-equiv="Content-Security-Policy" content="${PAGE_CSP}">`;
    expect(frameHtml('<html><head lang="en"><title>x</title></head></html>').startsWith(`<html><head lang="en">${meta}<title>`)).toBe(true);
    expect(frameHtml('<!DOCTYPE html>\n<p>x</p>').startsWith(`<!DOCTYPE html>${meta}\n<p>`)).toBe(true);
    expect(frameHtml('<header>x</header>').startsWith(meta)).toBe(true);
  });
});

describe('pages: front matter', () => {
  it('reads the markdown YAML subset: inline lists, block lists, scalars, quotes', () => {
    const { front, body } = parseMarkdownFront('---\ntitle: ignored\ncovers:\n  - "src/**"\n  - docs/a.md # the doc\ntemplates: [skills/sigmund/SKILL.md, \'agents/murr.md\']\nshelf: pages\n---\nBody');
    expect(front).toEqual({ covers: ['src/**', 'docs/a.md'], shelf: 'pages', templates: ['skills/sigmund/SKILL.md', 'agents/murr.md'] });
    expect(body).toBe('Body');
    expect(parseMarkdownFront('# No front matter\n---\n').front).toEqual({ covers: [], shelf: 'pages', templates: [] });
    // Covers are repo-relative: backslashes become slashes; a drive or a climb out of the repo is dropped.
    expect(parseMarkdownFront('---\ncovers: [src\\app.ts, ../other/**, C:/repo/x.ts, ./docs/a.md]\n---\n').front.covers).toEqual(['src/app.ts', './docs/a.md']);
  });

  it('reads HTML meta tags in any attribute order, comma-separated', () => {
    const front = parseHtmlFront(`<head><meta content="a/**, b.ts" name="inprogress:covers"><meta name='InProgress:shelf' content='roster'><meta name="description" content="x"></head>`);
    expect(front).toEqual({ covers: ['a/**', 'b.ts'], shelf: 'roster', templates: [] });
  });
});

describe('pages: the secret scan', () => {
  it('finds key prefixes with a key body, and NAME=value pairs, by line', () => {
    expect(findSecretLine('a\nOPENAI_API_KEY=sk-proj-4fJx9Lq2Wv8Tz1Rn5Yb')).toBe(2);
    expect(findSecretLine('token ghp_A1b2C3d4E5f6G7h8I9j0K1l2M3n4')).toBe(1);
    expect(findSecretLine('aws AKIAIOSFODNN7EXAMPLE here')).toBe(1);
    expect(findSecretLine('x\ny\nslack xoxb-1234567890-abcdefghij')).toBe(3);
    expect(findSecretLine('DB_PASSWORD = "hunter2hunter2hunter2"')).toBe(1);
    expect(findSecretLine('stripe sk_live_51HxQ2bL9aZ3kP0mN7')).toBe(1);
  });

  it('passes pages that only name a secret, its prefix or where it lives', () => {
    for (const text of [
      'Keys start with `sk-`, `sk_live_`, `re_`, `ghp_`, `github_pat_`, `AKIA` or `xox`.',
      'RESEND_API_KEY is a Railway variable; set it there.',
      'INPROGRESS_TOKEN=$(gh auth token --user Aiden-Molyneaux)',
      'API_KEY=<from the password manager>',
      'call re_render_the_whole_board_now() to repaint',
      'the sk-learn-preprocessing-pipeline package',
      'const apiKey = process.env.RESEND_API_KEY;',
      'hotkey=ctrl+shift+alt+k+x+y+z+w',
      'API_TOKEN=${{ secrets.API_TOKEN_2026 }}',
    ]) expect(findSecretLine(text), text).toBeNull();
  });
});
