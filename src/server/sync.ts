import { execFile } from 'node:child_process';
import { readFile, stat } from 'node:fs/promises';
import { isAbsolute, join, resolve as resolvePath, sep } from 'node:path';
import { sectionAt, sideBySide, unapply } from '../core/sections';
import { isSyncStep } from '../core/sync';
import type { DiffHunk, LibrarySync, SyncAdaptation, SyncCheck, SyncDiff, SyncFile, SyncOutcome, SyncRow, TreeNode } from '../core/types';
import { isLocalAbsolutePath, normalizePath } from '../lib/paths';
import type { Ctx } from './db/tx';
import { ApiError, badRequest, notFound } from './errors';
import { addNodes, listNodes } from './repo/nodes';
import { getProjectById, listBindings } from './repo/projects';

/**
 * The Library's Sync check (spec 2026-10-20-library-and-docs-design.md, "Sync"): for every project with a
 * `.claude/shipwright.json`, Shipwright's `template-sync.mjs --check --json` run once and cached. The script's folder
 * comes from the manifest, so it must be a folder bound to a project: a repo file never chooses what code runs.
 */

const CHECK_TIMEOUT_MS = 20_000;
const HEAD_TIMEOUT_MS = 5_000;
const FRESH_MS = 60_000;
const ERROR_CAP = 4000;

interface ManifestRow {
  projectId: number;
  slug: string;
  name: string;
  dir: string;
  /** The manifest's `shipwright` folder as written; '' when the manifest does not parse. */
  shipwright: string;
  /** The template paths the manifest adopts (the keys of `files`). */
  adopted: string[];
  manifestPath: string;
  mtimeMs: number;
  /** Set when the manifest cannot be used: the row's check fails with it and nothing runs. */
  error?: string;
}

interface Manifests {
  rows: ManifestRow[];
  noManifest: LibrarySync['noManifest'];
}

const same = (a: string, b: string): boolean => normalizePath(a).toLowerCase() === normalizePath(b).toLowerCase();

/** Every active project with a bound folder, first binding by id: its manifest read, or its place in `noManifest`. */
export async function manifests(ctx: Ctx): Promise<Manifests> {
  const projects = ctx.db.prepare("SELECT id, slug, name FROM projects WHERE status = 'active' AND deleted_at IS NULL ORDER BY id").all() as { id: number; slug: string; name: string }[];
  const first = new Map<number, string>();
  for (const b of listBindings(ctx)) if (!first.has(b.projectId)) first.set(b.projectId, b.path);
  const rows: ManifestRow[] = [];
  const missing: { projectId: number; slug: string; name: string; dir: string }[] = [];
  for (const p of projects) {
    const dir = first.get(p.id);
    if (!dir) continue;
    const manifestPath = join(dir, '.claude', 'shipwright.json');
    let text: string;
    let mtimeMs = 0;
    try {
      text = await readFile(manifestPath, 'utf8');
      mtimeMs = (await stat(manifestPath)).mtimeMs;
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === 'ENOENT' || code === 'ENOTDIR') {
        missing.push({ projectId: p.id, slug: p.slug, name: p.name, dir });
        continue;
      }
      rows.push({ projectId: p.id, slug: p.slug, name: p.name, dir, shipwright: '', adopted: [], manifestPath, mtimeMs, error: `Cannot read ${manifestPath}: ${(err as Error).message}` });
      continue;
    }
    const base = { projectId: p.id, slug: p.slug, name: p.name, dir, manifestPath, mtimeMs };
    try {
      const m = JSON.parse(text.replace(/^﻿/, '')) as { shipwright?: unknown; files?: unknown };
      const files = m.files && typeof m.files === 'object' ? Object.keys(m.files) : [];
      // A relative path is the project folder's own: it resolves against it, and the bound-folder check then applies as ever.
      const sw = typeof m.shipwright === 'string' && m.shipwright.trim() ? resolvePath(dir, m.shipwright.trim()) : '';
      rows.push({ ...base, shipwright: sw, adopted: files });
    } catch (err) {
      rows.push({ ...base, shipwright: '', adopted: [], error: `shipwright.json does not parse: ${(err as Error).message}` });
    }
  }
  const sources = rows.map((r) => r.shipwright).filter(Boolean);
  return { rows, noManifest: missing.map((m) => ({ projectId: m.projectId, slug: m.slug, name: m.name, source: sources.some((s) => same(s, m.dir)) })) };
}

/** Whether `path` is a folder bound to a project that is not deleted. */
const boundSomewhere = (ctx: Ctx, path: string): boolean => listBindings(ctx).some((b) => same(b.path, path));

const capped = (text: string): string => text.trim().slice(0, ERROR_CAP);

/** Runs a command and answers its outcome; a timeout is reported under `label` and `timeout`. Never rejects. */
function run(file: string, args: string[], timeout: number, label = 'template-sync'): Promise<{ ok: true; stdout: string } | { ok: false; error: string }> {
  return new Promise((resolve) => {
    execFile(file, args, { timeout, windowsHide: true, maxBuffer: 16 * 1024 * 1024, env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } }, (err, stdout, stderr) => {
      if (!err) return resolve({ ok: true, stdout: String(stdout) });
      const e = err as NodeJS.ErrnoException & { killed?: boolean; signal?: string | null };
      const text = capped(String(stderr));
      // A kill at the timeout is said first, with whatever the script printed after it.
      // Over maxBuffer the child is killed too, but that is not a timeout.
      if (e.code !== 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER' && (e.killed || e.signal)) return resolve({ ok: false, error: `${label} timed out after ${timeout / 1000} s${text ? `\n${text}` : ''}` });
      resolve({ ok: false, error: text || e.message });
    });
  });
}

export const parseCheck = (stdout: string): SyncOutcome => {
  try {
    const result = JSON.parse(stdout) as SyncCheck;
    const sound = result && typeof result.shipwright?.head === 'string' && Array.isArray(result.files) && result.files.every((f) => f && typeof f === 'object' && typeof f.state === 'string' && typeof f.template === 'string');
    if (!sound) return { ok: false, error: 'template-sync printed JSON that is not a sync check (shipwright.head, or a file with a template and state, is missing)' };
    // The script's word is not trusted for shape: a file's local, fills and commits are put right, so nothing downstream throws on them.
    for (const f of result.files as (Omit<SyncFile, 'local' | 'fills' | 'commits'> & { local: unknown; fills: unknown; commits: unknown })[]) {
      if (typeof f.local !== 'string') f.local = null;
      if (!f.fills || typeof f.fills !== 'object' || Array.isArray(f.fills)) f.fills = {};
      if (!Array.isArray(f.commits)) f.commits = [];
    }
    if (!result.fills || typeof result.fills !== 'object' || Array.isArray(result.fills)) result.fills = {};
    if (!Array.isArray(result.skip)) result.skip = [];
    return { ok: true, result };
  } catch (err) {
    return { ok: false, error: `template-sync printed output that does not parse: ${(err as Error).message}` };
  }
};

interface Cached {
  key: string;
  at: number;
  outcome: SyncOutcome;
}
const cache = new Map<number, Cached>();
const inFlight = new Map<string, Promise<SyncOutcome>>();
/** A good diff for 60 s, keyed by the check it was read after (its cache key and time) and the template: Check now makes a new one. */
const diffCache = new Map<string, { at: number; diff: SyncDiff }>();

/** For tests: forget cached checks and shared runs. */
export const clearSyncCache = (): void => {
  cache.clear();
  inFlight.clear();
  diffCache.clear();
};

// The script compares against Shipwright's main by default, so main's sha is what a cached answer depends on.
const headOf = async (shipwright: string): Promise<string> => {
  const out = await run('git', ['-C', shipwright, 'rev-parse', 'main'], HEAD_TIMEOUT_MS, 'git');
  return out.ok ? out.stdout.trim() : '';
};

/** Why a manifest's script may not run, or null: the guards every run goes through, in their order. */
function refusal(ctx: Ctx, m: ManifestRow, manifestDirs: string[]): string | null {
  if (m.error) return m.error;
  if (!m.shipwright || !isLocalAbsolutePath(m.shipwright) || !boundSomewhere(ctx, m.shipwright)) {
    return `Shipwright path ${m.shipwright || '(none)'} is not a folder bound to a project`;
  }
  // The source keeps no manifest of its own: a project that does (this one included) cannot be where the script comes from.
  if (manifestDirs.some((d) => same(d, m.shipwright))) {
    return `Shipwright path ${m.shipwright} is a project that keeps its own .claude/shipwright.json, not Shipwright`;
  }
  return null;
}

/** One manifest's check. Refuses a Shipwright folder that no project binds, without running anything. `force` skips the cache but still shares a run in flight. */
async function checkRow(ctx: Ctx, m: ManifestRow, manifestDirs: string[], force = false): Promise<SyncOutcome> {
  const refused = refusal(ctx, m, manifestDirs);
  if (refused) return { ok: false, error: refused };
  const key = JSON.stringify([await headOf(m.shipwright), m.mtimeMs, m.dir]);
  const hit = cache.get(m.projectId);
  if (!force && hit && hit.key === key && Date.now() - hit.at < FRESH_MS) return hit.outcome;
  const flight = `${m.projectId}|${key}`;
  const running = inFlight.get(flight);
  if (running) return running;
  const started = (async (): Promise<SyncOutcome> => {
    const out = await run(process.execPath, [join(m.shipwright, 'scripts', 'template-sync.mjs'), '--check', '--json', '--project', m.dir], CHECK_TIMEOUT_MS);
    const outcome: SyncOutcome = out.ok ? parseCheck(out.stdout) : out;
    // A failure is not kept: the next load tries again.
    if (outcome.ok) cache.set(m.projectId, { key, at: Date.now(), outcome });
    return outcome;
  })();
  inFlight.set(flight, started);
  try {
    return await started;
  } finally {
    inFlight.delete(flight);
  }
}

/** Shipwright's `templates.json` list as data, never run; empty on any failure. */
async function readTemplates(shipwright: string): Promise<string[]> {
  try {
    const parsed = JSON.parse((await readFile(join(shipwright, 'templates.json'), 'utf8')).replace(/^﻿/, '')) as { templates?: unknown };
    return Array.isArray(parsed.templates) ? parsed.templates.filter((t): t is string => typeof t === 'string') : [];
  } catch {
    // No readable list (no file, or not JSON): the page draws no columns, and each row's own check says what is wrong.
    return [];
  }
}

/** The project's open sync step (the lowest id), or null. */
function openSyncStep(nodes: TreeNode[]): { id: number; title: string } | null {
  const step = nodes
    .filter((n) => n.parentId !== null && (n.status === 'todo' || n.status === 'active') && isSyncStep(n.title))
    .sort((a, b) => a.id - b.id)[0];
  return step ? { id: step.id, title: step.title } : null;
}

/** POST /api/ui/library/sync: every manifest's check, in parallel. `force` runs them again whatever the cache holds. */
export async function librarySync(ctx: Ctx, { force = false }: { force?: boolean } = {}): Promise<LibrarySync> {
  const { rows, noManifest } = await manifests(ctx);
  const dirs = rows.map((r) => r.dir);
  const projects: SyncRow[] = await Promise.all(
    rows.map(async (m) => ({ projectId: m.projectId, slug: m.slug, name: m.name, dir: m.dir, check: await checkRow(ctx, m, dirs, force), syncStep: openSyncStep(listNodes(ctx, m.projectId)) })),
  );
  const usable = rows.find((m) => !refusal(ctx, m, dirs));
  const templates = usable ? await readTemplates(usable.shipwright) : [];
  const head = projects.map((p) => (p.check.ok ? p.check.result.shipwright.head : null)).find((h) => h !== null) ?? null;
  const src = noManifest.find((n) => n.source);
  return { projects, noManifest, templates, source: src ? { slug: src.slug, name: src.name, head } : null };
}

const requireRow = async (ctx: Ctx, slug: string): Promise<{ m: ManifestRow; dirs: string[] }> => {
  const { rows } = await manifests(ctx);
  const m = rows.find((r) => r.slug === slug);
  if (!m) throw notFound(`No project ${slug} with a .claude/shipwright.json`);
  return { m, dirs: rows.map((r) => r.dir) };
};

const HUNK = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/;

/**
 * A unified diff's hunks; the file headers before the first `@@` and `\ No newline` lines are dropped. `at` is the new-side line
 * (1-based) whose heading names the hunk: that of its first `+` or `-` line, past the leading context the script adds.
 */
function parseHunks(diff: string): { hunk: DiffHunk; at: number }[] {
  const out: { hunk: DiffHunk; start: number; count: number; leading: number; first: '+' | '-' | null }[] = [];
  const lines = diff.split('\n');
  if (lines[lines.length - 1] === '') lines.pop();
  for (const line of lines) {
    const h = HUNK.exec(line);
    if (h) {
      out.push({ hunk: { header: line, section: null, located: false, conflict: false, line: null, added: 0, removed: 0, lines: [] }, start: Number(h[1]), count: h[2] === undefined ? 1 : Number(h[2]), leading: 0, first: null });
      continue;
    }
    const cur = out[out.length - 1];
    if (!cur || line.startsWith('\\')) continue;
    const kind = line[0] === '+' || line[0] === '-' ? line[0] : ' ';
    if (kind === '+') cur.hunk.added++;
    if (kind === '-') cur.hunk.removed++;
    if (cur.first === null) {
      if (kind === ' ') cur.leading++;
      else cur.first = kind;
    }
    cur.hunk.lines.push({ kind, text: line.slice(1) });
  }
  // A new side of no lines names the line before it; else a `-` line sits just before the line that follows it.
  return out.map((o) => ({ hunk: o.hunk, at: o.count === 0 ? o.start : o.start + o.leading - (o.first === '-' ? 1 : 0) }));
}

/** A hunk's lines before its first added line that are not added: the old side's text the copy should still hold, trimmed at the end. */
function leadingRun(hunk: DiffHunk): string[] {
  const run: string[] = [];
  for (const l of hunk.lines) {
    if (l.kind === '+') break;
    run.push(l.text.trimEnd());
  }
  return run.some((t) => t.trim() !== '') ? run : [];
}

/** The 0-based line in `lines` where `run` starts, when it appears there exactly once; -1 when it is empty, absent or repeated. */
function uniqueRun(lines: string[], run: string[]): number {
  if (run.length === 0) return -1;
  let found = -1;
  for (let i = 0; i + run.length <= lines.length; i++) {
    if (run.every((t, j) => lines[i + j] === t)) {
      if (found >= 0) return -1;
      found = i;
    }
  }
  return found;
}

/**
 * Where `rel` (a file's `local`) is inside the project's folder, or why it is refused. Shipwright names it, so a missing one,
 * an absolute path and a `..` are all refused.
 */
function localPathOf(m: ManifestRow, file: SyncFile): { ok: true; path: string } | { ok: false; error: string } {
  const rel = file.local;
  if (rel === null) return { ok: false, error: `${file.template} has no local file in ${m.name}` };
  const target = resolvePath(m.dir, rel);
  if (isAbsolute(rel) || rel.split(/[\\/]/).includes('..') || !target.startsWith(resolvePath(m.dir) + sep)) {
    return { ok: false, error: `Refusing ${rel}: it is not inside ${m.name}'s folder` };
  }
  return { ok: true, path: target };
}

/** POST /api/ui/library/sync/diff: one adopted template's adaptation and upstream change. A script failure is `{ ok: false, error }`, never a throw. */
export async function syncDiff(ctx: Ctx, slug: string, template: string): Promise<SyncDiff> {
  const { m, dirs } = await requireRow(ctx, slug);
  const refused = refusal(ctx, m, dirs);
  if (refused) return { ok: false, error: refused };
  if (!(await readTemplates(m.shipwright)).includes(template)) return { ok: false, error: `${template} is not a template in Shipwright's templates.json` };
  const check = await checkRow(ctx, m, dirs);
  if (!check.ok) return check;
  const stamp = cache.get(m.projectId);
  const kept = stamp ? `${stamp.key}|${stamp.at}|${template}` : null;
  const hit = kept ? diffCache.get(kept) : undefined;
  if (hit && Date.now() - hit.at < FRESH_MS) return hit.diff;
  const file = check.result.files.find((f) => f.template === template);
  const out = await run(process.execPath, [join(m.shipwright, 'scripts', 'template-sync.mjs'), '--diff', template, '--json', '--project', m.dir], CHECK_TIMEOUT_MS);
  if (!out.ok) return out;
  let parsed: { adaptation?: unknown; upstream?: unknown; conflicts?: unknown };
  try {
    parsed = JSON.parse(out.stdout);
  } catch (err) {
    return { ok: false, error: `template-sync printed a diff that does not parse: ${(err as Error).message}` };
  }
  if (typeof parsed?.adaptation !== 'string' || typeof parsed.upstream !== 'string') return { ok: false, error: 'template-sync printed JSON that is not a diff (adaptation or upstream is not text)' };
  const conflicting = new Set<number>(
    Array.isArray(parsed.conflicts) ? (parsed.conflicts as { hunks?: unknown }[]).flatMap((c) => (Array.isArray(c?.hunks) ? c.hunks.filter((n): n is number => typeof n === 'number') : [])) : [],
  );
  let local: string | null = null;
  const where = file ? localPathOf(m, file) : null;
  if (where?.ok) {
    try {
      local = await readFile(where.path, 'utf8');
    } catch {
      // The project's copy is unreadable (gone, or a folder): the hunks still show, with no section headings.
    }
  }
  const localLines = local === null ? null : local.replace(/^﻿/, '').split('\n').map((l) => l.trimEnd());
  // The adaptation's new side is the project's copy, so its line numbers read straight into it.
  const adaptation = parseHunks(parsed.adaptation).map(({ hunk, at }) => (local === null ? hunk : { ...hunk, section: sectionAt(local, at), located: true, line: at }));
  // The upstream's new side is Shipwright's template, filled, so its numbers do not read into the copy: a hunk is found there by
  // its leading run of context and removed lines instead. Markdown repeats lines (fences, rules, table rows), so the run must
  // be found once and only once; a hunk with no run, or one found twice or not at all, is left unlocated.
  const upstream = parseHunks(parsed.upstream).map(({ hunk }, i) => {
    const row = localLines ? uniqueRun(localLines, leadingRun(hunk)) : -1;
    return { ...hunk, conflict: conflicting.has(i), ...(row >= 0 && local !== null ? { section: sectionAt(local, row + 1), located: true, line: row + 1 } : {}) };
  });
  const diff: SyncDiff = { ok: true, adaptation, upstream, commits: file?.commits ?? [] };
  // A copy that could not be read this once (an editor's save holding it) is not kept: the next open reads it again.
  if (kept && !(where?.ok && local === null)) {
    const now = Date.now();
    for (const [k, v] of diffCache) if (now - v.at >= FRESH_MS) diffCache.delete(k);
    diffCache.set(kept, { at: now, diff });
  }
  return diff;
}

/**
 * POST /api/ui/library/sync/adaptation: one adopted template side by side with the project's copy, for its Docs view. Built on
 * `syncDiff` (its run, cache, placement and conflicts): the filled template at base is the copy with the adaptation's hunks
 * put back, and Shipwright's raw text at base, placeholders kept, is `git show`n. A failure is `{ ok: false, error }`.
 */
export async function syncAdaptation(ctx: Ctx, slug: string, template: string): Promise<SyncAdaptation> {
  const diff = await syncDiff(ctx, slug, template);
  if (!diff.ok) return diff;
  const { m, dirs } = await requireRow(ctx, slug);
  const check = await checkRow(ctx, m, dirs);
  if (!check.ok) return check;
  const file = check.result.files.find((f) => f.template === template);
  if (!file) return { ok: false, error: `${m.name} does not adopt ${template}` };
  if (!file.base) return { ok: false, error: `${template} has no base in ${m.name}'s manifest` };
  const where = localPathOf(m, file);
  if (!where.ok) return where;
  let local: string;
  try {
    // Line ends need no care here: the section reader reads CRLF as LF.
    local = await readFile(where.path, 'utf8');
  } catch (err) {
    return { ok: false, error: `Cannot read ${m.name}'s copy ${file.local}: ${(err as Error).message}` };
  }
  const raw = await run('git', ['-C', m.shipwright, 'show', `${file.base}:${template}`], HEAD_TIMEOUT_MS, 'git');
  if (!raw.ok) return { ok: false, error: `Cannot read ${template} at ${file.base}: ${raw.error}` };
  const filled = unapply(local, diff.adaptation);
  if (filled === null) return { ok: false, error: `${m.name}'s copy changed while it was read; open it again` };
  const conflictLines = diff.upstream.flatMap((h) => (h.conflict && h.line !== null ? [h.line] : []));
  const rows = sideBySide({ raw: raw.stdout, filled, local, fileFills: Object.keys(file.fills), conflictLines });
  return { ok: true, project: m.name, template, base: file.base, head: check.result.shipwright.head, state: file.state, behind: file.behind, commits: file.commits, rows, adaptation: diff.adaptation };
}

/** POST /api/ui/library/sync/step: files the project's sync step at its root. A project that already has one is refused with 409, answering that step. */
export async function addSyncStep(ctx: Ctx, slug: string): Promise<TreeNode> {
  const { m, dirs } = await requireRow(ctx, slug);
  const check = await checkRow(ctx, m, dirs);
  if (!check.ok) throw badRequest(`${m.name} has no sync to file: ${check.error}`);
  if (!check.result.files.some((f) => f.state === 'behind')) throw badRequest(`${m.name} is not behind Shipwright`);
  const project = getProjectById(ctx, m.projectId);
  if (!project) throw notFound(`Project ${slug} not found`);
  const [node] = addNodes(ctx, 'window', {
    parentId: project.rootNodeId,
    nodes: [{ title: `Sync ${m.name} to Shipwright ${check.result.shipwright.head.slice(0, 7)}`, label: 'docs' }],
    // Inside the write, so two clicks cannot both pass.
    check: () => {
      const existing = openSyncStep(listNodes(ctx, m.projectId));
      if (existing) throw new ApiError(409, `${m.name} already has a sync step, #${existing.id}`, undefined, { step: existing });
    },
  });
  return node;
}

/** POST /api/ui/library/sync/open: the project's copy of a template, in the editor. */
export async function openCopy(ctx: Ctx, slug: string, template: string, open: (path: string) => Promise<void>): Promise<void> {
  const { m, dirs } = await requireRow(ctx, slug);
  const check = await checkRow(ctx, m, dirs);
  if (!check.ok) throw badRequest(check.error);
  const file = check.result.files.find((f) => f.template === template);
  if (!file) throw badRequest(`${m.name} does not adopt ${template}`);
  const where = localPathOf(m, file);
  if (!where.ok) throw badRequest(where.error);
  await open(where.path);
}

/** The manifests' rows with what each adopts and the Shipwright folder it names, no script run: for a page's Adapted in. */
export async function adopters(ctx: Ctx): Promise<{ slug: string; name: string; adopted: string[]; shipwright: string }[]> {
  return (await manifests(ctx)).rows.map((m) => ({ slug: m.slug, name: m.name, adopted: m.adopted, shipwright: m.shipwright }));
}
