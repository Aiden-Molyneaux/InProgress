import { execFile } from 'node:child_process';
import { readFile, stat } from 'node:fs/promises';
import { dirname, extname } from 'node:path';
import { isPagePurpose, type PageBody, type PageFreshness, type PageFront, type Resource } from '../core/types';
import { isLocalAbsolutePath, isUnder, normalizePath } from '../lib/paths';
import type { Ctx } from './db/tx';
import { ApiError, unprocessable } from './errors';

/**
 * Pages (spec 2026-10-20-library-and-docs-design.md, "Pages"): a `doc` resource with purpose `library` or `page` points
 * at a file in a repo bound to its project, and is read live from it on every view. Nothing is copied in.
 */

export const PAGE_MAX_BYTES = 2 * 1024 * 1024;
const MARKDOWN_EXTS = ['.md', '.markdown'];
const HTML_EXTS = ['.html', '.htm'];
const GIT_TIMEOUT_MS = 5_000;

/** The rule a registration broke, sent as `rule` beside `code: 'page-rule'` in the 400. */
export type PageRule = 'kind' | 'content' | 'path' | 'local' | 'binding' | 'extension' | 'file' | 'size' | 'repo';

const ruleError = (rule: PageRule, message: string, hint?: string) => new ApiError(400, message, hint, { code: 'page-rule', rule });

/** A resource registered as a page: its purpose alone says so, and the page rules (kind doc among them) then apply. */
export const isPage = (r: { purpose?: string | null }): boolean => isPagePurpose(r.purpose);

const formatOf = (path: string): 'markdown' | 'html' | null => {
  const ext = extname(path).toLowerCase();
  return MARKDOWN_EXTS.includes(ext) ? 'markdown' : HTML_EXTS.includes(ext) ? 'html' : null;
};

/**
 * The rules a page's row must keep, checked without touching the disk: inside the write that stores it, and again on
 * every read. Returns the first one broken, or null.
 */
function brokenRule(ctx: Ctx, projectId: number, r: { kind: string; content?: string | null; path?: string | null }): ApiError | null {
  if (r.kind !== 'doc') return ruleError('kind', `A page is a doc resource, not ${r.kind}`, 'Use kind doc.');
  if (r.content !== null && r.content !== undefined) {
    return ruleError('content', 'A page is read live from its path and takes no content', 'Leave out content and snapshot_file.');
  }
  const path = r.path?.trim();
  if (!path) return ruleError('path', 'A page needs the path of its file');
  if (!isLocalAbsolutePath(path)) return ruleError('local', `Not a local absolute path: ${path}`, 'Use the full path on a local disk, e.g. C:/personal/InGame/docs/map.html.');
  if (!formatOf(path)) return ruleError('extension', `A page ends in .md, .markdown, .html or .htm: ${path}`);
  const folders = ctx.db.prepare('SELECT path FROM bindings WHERE project_id = ?').pluck().all(projectId) as string[];
  if (!folders.some((folder) => isUnder(path, folder))) {
    return ruleError('binding', `${path} is not under a folder bound to this project`, folders.length ? `Bound folders: ${folders.join(', ')}.` : 'The project has no bound folder.');
  }
  return null;
}

/** Throws the first broken rule as a typed 400. For addResource and updateResource, inside their write. */
export function checkPageRules(ctx: Ctx, projectId: number, r: { kind: string; content?: string | null; path?: string | null }): void {
  const broken = brokenRule(ctx, projectId, r);
  if (broken) throw broken;
}

interface GitResult {
  code: number;
  stdout: string;
}

/** Runs git in `cwd` and answers its exit code and stdout. A git that cannot start answers code -1. */
function git(cwd: string, args: string[]): Promise<GitResult> {
  return new Promise((resolve) => {
    execFile('git', ['-C', cwd, ...args], { windowsHide: true, timeout: GIT_TIMEOUT_MS, maxBuffer: 1024 * 1024, env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } }, (err, stdout) => {
      const code = err ? (typeof (err as { code?: unknown }).code === 'number' ? ((err as { code: number }).code) : -1) : 0;
      resolve({ code, stdout: String(stdout) });
    });
  });
}

interface Repo {
  /** The repo's top level, forward-slashed. */
  top: string;
  head: string;
}

/** The repo a page's folder sits in and its HEAD, or why it cannot be used: no repo, no commit, or a linked worktree. */
async function repoOf(dir: string): Promise<Repo | string> {
  const out = await git(dir, ['rev-parse', '--path-format=absolute', '--show-toplevel', '--git-dir', '--git-common-dir', 'HEAD']);
  const [top, gitDir, commonDir, head] = out.stdout.split(/\r?\n/);
  if (out.code !== 0 || !top || !head || !/^[0-9a-f]{40,64}$/.test(head)) return `${dir} is not in a git repository with a commit`;
  // A linked worktree has its own git dir under the main one's: pages show what has merged, so they are read from the main checkout.
  if (normalizePath(gitDir).toLowerCase() !== normalizePath(commonDir).toLowerCase()) return `${dir} is in a linked worktree; register the page from the main checkout`;
  return { top: normalizePath(top), head };
}

/** What the disk says about a page's file: a regular file of 2 MB or less, in a usable repo. */
type Inspected = { ok: true; repo: Repo; size: number } | { ok: false; missing: boolean; rule: PageRule; message: string };

async function inspect(path: string): Promise<Inspected> {
  try {
    const info = await stat(path);
    if (!info.isFile()) return { ok: false, missing: true, rule: 'file', message: `Not a file: ${path}` };
    if (info.size > PAGE_MAX_BYTES) return { ok: false, missing: false, rule: 'size', message: `${path} is over 2 MB` };
    const repo = await repoOf(dirname(path));
    if (typeof repo === 'string') return { ok: false, missing: false, rule: 'repo', message: repo };
    return { ok: true, repo, size: info.size };
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    const missing = code === 'ENOENT' || code === 'ENOTDIR';
    return { ok: false, missing, rule: 'file', message: missing ? `File not found: ${path}` : `Cannot read ${path}: ${(err as Error).message}` };
  }
}

/**
 * Before a page is stored: its file passes the disk rules, and the answer is the confirmation registration sets (the
 * repo's HEAD). Async, so a slow disk or git never blocks the event loop; the write then checks the row rules again.
 */
export async function inspectNewPage(path: string): Promise<{ confirmedSha: string }> {
  if (!isLocalAbsolutePath(path)) throw ruleError('local', `Not a local absolute path: ${path}`);
  const found = await inspect(path);
  if (!found.ok) throw ruleError(found.rule, found.message);
  return { confirmedSha: found.repo.head };
}

const EMPTY_FRONT: PageFront = { covers: [], shelf: 'pages', templates: [] };
const MAX_LIST = 50;
const MAX_ITEM = 300;

const unquote = (v: string): string => {
  const t = v.trim();
  return t.length >= 2 && ((t.startsWith('"') && t.endsWith('"')) || (t.startsWith("'") && t.endsWith("'"))) ? t.slice(1, -1) : t;
};
const listOf = (items: string[]): string[] => items.map(unquote).filter((s) => s && s.length <= MAX_ITEM).slice(0, MAX_LIST);

function frontOf(values: Map<string, string[]>): PageFront {
  const shelf = values.get('shelf')?.[0];
  return {
    covers: listOf(values.get('covers') ?? []),
    shelf: shelf === 'roster' ? 'roster' : 'pages',
    templates: listOf(values.get('templates') ?? []),
  };
}

const FRONT_BLOCK = /^---[ \t]*\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/;
const KEYS = new Set(['covers', 'shelf', 'templates']);

/**
 * Markdown front matter: the YAML subset a page needs. `key: value`, `key: [a, b]`, or `key:` then `- item` lines. Other
 * keys and anything else YAML can say are ignored. Answers the front matter and the text after it.
 */
export function parseMarkdownFront(text: string): { front: PageFront; body: string } {
  const block = FRONT_BLOCK.exec(text);
  if (!block) return { front: EMPTY_FRONT, body: text };
  const values = new Map<string, string[]>();
  let listKey: string | null = null;
  for (const raw of block[1].split(/\r?\n/)) {
    const line = raw.replace(/\s+#.*$/, '');
    const item = /^\s*-\s+(.*)$/.exec(line);
    if (item && listKey) {
      values.get(listKey)!.push(item[1]);
      continue;
    }
    const pair = /^([A-Za-z_][\w-]*)\s*:\s*(.*)$/.exec(line);
    listKey = null;
    if (!pair || !KEYS.has(pair[1])) continue;
    const [, key, value] = pair;
    const inline = /^\[(.*)\]$/.exec(value.trim());
    if (inline) values.set(key, inline[1].split(','));
    else if (value.trim()) values.set(key, [value]);
    else {
      values.set(key, []);
      listKey = key;
    }
  }
  return { front: frontOf(values), body: text.slice(block[0].length) };
}

const ENTITIES: Record<string, string> = { amp: '&', quot: '"', apos: "'", lt: '<', gt: '>' };
const decode = (s: string) => s.replace(/&(amp|quot|apos|lt|gt|#39);/g, (_m, e: string) => (e === '#39' ? "'" : ENTITIES[e]));
const attr = (tag: string, name: string): string | null => {
  const m = new RegExp(`\\s${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s"'>]+))`, 'i').exec(tag);
  return m ? decode(m[1] ?? m[2] ?? m[3] ?? '') : null;
};

/** HTML front matter: `<meta name="inprogress:<key>" content="…">`, list values comma-separated. */
export function parseHtmlFront(text: string): PageFront {
  const values = new Map<string, string[]>();
  for (const [tag] of text.matchAll(/<meta\b[^>]*>/gi)) {
    const key = /^inprogress:(.+)$/i.exec(attr(tag, 'name') ?? '')?.[1]?.toLowerCase();
    const content = attr(tag, 'content');
    if (key && KEYS.has(key) && content !== null) values.set(key, content.split(','));
  }
  return frontOf(values);
}

/**
 * Secret-shaped text. A known key prefix counts only with a key's body after it (letters and digits both), so a page that
 * names the prefix (`sk-`) is not refused. `NAME=value` counts when NAME ends in KEY, SECRET, TOKEN or PASSWORD and the
 * value is 16 or more non-space characters.
 */
const KEY_SHAPES = [
  /(?<![\w-])sk-[A-Za-z0-9_-]{16,}/g,
  /(?<!\w)sk_live_[A-Za-z0-9]{16,}/g,
  /(?<!\w)re_[A-Za-z0-9_]{16,}/g,
  /(?<!\w)ghp_[A-Za-z0-9]{20,}/g,
  /(?<!\w)github_pat_[A-Za-z0-9_]{20,}/g,
  /(?<![A-Za-z0-9])AKIA[A-Z0-9]{16}(?![A-Za-z0-9])/g,
  /(?<!\w)xox[abposr]-[A-Za-z0-9-]{10,}/g,
];
const NAMED_SECRET = /(?<![\w-])[A-Za-z0-9_]*(?:KEY|SECRET|TOKEN|PASSWORD)\s*=\s*["'`]?[^\s"'`]{16,}/i;
const looksRandom = (s: string) => /[A-Za-z]/.test(s) && /\d/.test(s);

/** The 1-based line of the first secret-shaped text, or null. Never answers the text itself. */
export function findSecretLine(text: string): number | null {
  const lines = text.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (NAMED_SECRET.test(line)) return i + 1;
    for (const shape of KEY_SHAPES) {
      for (const [hit] of line.matchAll(shape)) if (looksRandom(hit.replace(/^(sk-|sk_live_|re_|ghp_|github_pat_|AKIA|xox[abposr]-)/, ''))) return i + 1;
    }
  }
  return null;
}

/** Freshness counts, by repo, confirmed sha, HEAD and covers: a count only changes when HEAD or the claim does. */
const freshCache = new Map<string, number | null>();
const FRESH_CACHE_MAX = 500;

/** A cover as a git pathspec: relative to the repo root (`top`) and read as a glob, whatever magic it tried to name. */
const pathspec = (cover: string) => `:(top,glob)${cover.replace(/^(\.\/|\/)+/, '')}`;

async function freshness(repo: Repo, confirmedSha: string | null, confirmedAt: string | null, covers: string[]): Promise<PageFreshness> {
  if (!confirmedSha || !/^[0-9a-f]{7,64}$/.test(confirmedSha)) return { count: null, confirmedSha, confirmedAt };
  const key = JSON.stringify([repo.top, confirmedSha, repo.head, covers]);
  if (freshCache.has(key)) return { count: freshCache.get(key)!, confirmedSha, confirmedAt };
  let count: number | null = null;
  // A confirmed sha that left HEAD's history (a rebase) counts as stale: the strip says "confirm again".
  if ((await git(repo.top, ['merge-base', '--is-ancestor', confirmedSha, repo.head])).code === 0) {
    const out = await git(repo.top, ['rev-list', '--count', `${confirmedSha}..${repo.head}`, '--', ...covers.map(pathspec)]);
    if (out.code === 0 && /^\d+\s*$/.test(out.stdout)) count = Number(out.stdout.trim());
  }
  if (freshCache.size >= FRESH_CACHE_MAX) freshCache.clear();
  freshCache.set(key, count);
  return { count, confirmedSha, confirmedAt };
}

/** A page row the body routes can read, or the 400 when the resource is not a page. */
function requirePage(r: Resource): string {
  if (!isPage(r) || !r.path) throw new ApiError(400, `r${r.id} is not a page`, 'A page is a doc resource with purpose library or page and a path.', { code: 'not-a-page' });
  return r.path;
}

/** The 404 for a page whose file is gone; `path` is where it was. */
const pageMissing = (r: Resource, message: string) => new ApiError(404, `This page is gone: ${message}`, `It was at ${r.path}.`, { code: 'page-missing', path: r.path ?? '' });

/**
 * A page as its file stands now. Re-checks the registration rules on every read: a moved or deleted file is a 404
 * `page-missing`, any other broken rule a 422 `page-refused`, and secret-shaped text a 422 `page-has-secret` with the line.
 */
export async function readPage(ctx: Ctx, r: Resource): Promise<PageBody> {
  const path = requirePage(r);
  const broken = brokenRule(ctx, r.projectId, r);
  if (broken) throw unprocessable(broken.message, broken.hint, { code: 'page-refused', rule: String(broken.extra?.rule ?? '') });
  const found = await inspect(path);
  if (!found.ok) {
    if (found.missing) throw pageMissing(r, found.message);
    throw unprocessable(found.message, undefined, { code: 'page-refused', rule: found.rule });
  }
  let raw: string;
  try {
    raw = (await readFile(path, 'utf8')).replace(/^\uFEFF/, '');
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'ENOENT' || code === 'ENOTDIR') throw pageMissing(r, `File not found: ${path}`);
    throw unprocessable(`Cannot read ${path}: ${(err as Error).message}`, undefined, { code: 'page-refused', rule: 'file' });
  }
  const line = findSecretLine(raw);
  if (line !== null) throw unprocessable(`This page looks like it holds a secret on line ${line}; fix it in its repo`, undefined, { code: 'page-has-secret', line });
  const format = formatOf(path)!;
  const { front, body: text } = format === 'markdown' ? parseMarkdownFront(raw) : { front: parseHtmlFront(raw), body: raw };
  const fresh = front.covers.length ? await freshness(found.repo, r.confirmedSha, r.confirmedAt, front.covers) : null;
  return { format, text, front, sha: found.repo.head, fresh };
}

/** The repo HEAD a page's Still accurate records. A gone file is a 404 `page-missing`, as on a read. */
export async function pageHead(r: Resource): Promise<string> {
  const path = requirePage(r);
  const found = await inspect(path);
  if (!found.ok) {
    if (found.missing) throw pageMissing(r, found.message);
    throw unprocessable(found.message, undefined, { code: 'page-refused', rule: found.rule });
  }
  return found.repo.head;
}

/** The policy an HTML page runs under: its own inline scripts and styles, Google Fonts, data: images, and no other network. */
export const PAGE_CSP = "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline' https://fonts.googleapis.com; font-src https://fonts.gstatic.com; img-src data:";

/**
 * The frame route's header policy. `sandbox` keeps the page at an opaque origin even when it is opened as a tab of its
 * own, and `frame-ancestors 'self'` lets only the window frame it.
 */
export const PAGE_FRAME_HEADER_CSP = `${PAGE_CSP}; base-uri 'none'; form-action 'none'; frame-ancestors 'self'; sandbox allow-scripts`;

/** Posts the page's height to the window, as a number, whenever it changes. */
const HEIGHT_SCRIPT =
  '<script>(()=>{const b=document.body;if(!b)return;let last=-1;const post=()=>{const s=getComputedStyle(b);' +
  'const h=Math.ceil(b.scrollHeight+parseFloat(s.marginTop)+parseFloat(s.marginBottom));' +
  'if(h!==last){last=h;parent.postMessage(h,"*");}};addEventListener("load",post);new ResizeObserver(post).observe(b);post();})()</script>';

/**
 * The HTML the frame route serves: the spec's CSP meta tag first in the head (after a doctype, so the page keeps its
 * rendering mode), then the page as written, then the height reporter.
 */
export function frameHtml(text: string): string {
  const meta = `<meta http-equiv="Content-Security-Policy" content="${PAGE_CSP}">`;
  const head = /<head\b[^>]*>/i.exec(text);
  const doctype = /^\s*<!doctype[^>]*>/i.exec(text);
  const at = head ? head.index + head[0].length : doctype ? doctype[0].length : 0;
  return `${text.slice(0, at)}${meta}${text.slice(at)}${HEIGHT_SCRIPT}`;
}

/** For tests: forget cached freshness counts. */
export const clearFreshCache = () => freshCache.clear();

