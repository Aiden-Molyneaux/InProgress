import { execFile } from 'node:child_process';
import { readFile, stat } from 'node:fs/promises';
import { join, resolve as resolvePath } from 'node:path';
import type { LibrarySync, SyncCheck, SyncOutcome, SyncRow } from '../core/types';
import { isLocalAbsolutePath, normalizePath } from '../lib/paths';
import type { Ctx } from './db/tx';
import { listBindings } from './repo/projects';

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

/** Runs a command and answers its outcome. Never rejects. */
function run(file: string, args: string[], timeout: number): Promise<{ ok: true; stdout: string } | { ok: false; error: string }> {
  return new Promise((resolve) => {
    execFile(file, args, { timeout, windowsHide: true, maxBuffer: 16 * 1024 * 1024, env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } }, (err, stdout, stderr) => {
      if (!err) return resolve({ ok: true, stdout: String(stdout) });
      const e = err as NodeJS.ErrnoException & { killed?: boolean; signal?: string | null };
      const text = capped(String(stderr));
      // A kill at the timeout is said first, with whatever the script printed after it.
      // Over maxBuffer the child is killed too, but that is not a timeout.
      if (e.code !== 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER' && (e.killed || e.signal)) return resolve({ ok: false, error: `template-sync timed out after 20 s${text ? `\n${text}` : ''}` });
      resolve({ ok: false, error: text || e.message });
    });
  });
}

export const parseCheck = (stdout: string): SyncOutcome => {
  try {
    const result = JSON.parse(stdout) as SyncCheck;
    const sound = result && typeof result.shipwright?.head === 'string' && Array.isArray(result.files) && result.files.every((f) => f && typeof f === 'object' && typeof f.state === 'string' && typeof f.template === 'string');
    if (!sound) return { ok: false, error: 'template-sync printed JSON that is not a sync check (shipwright.head, or a file with a template and state, is missing)' };
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

/** For tests: forget cached checks and shared runs. */
export const clearSyncCache = (): void => {
  cache.clear();
  inFlight.clear();
};

// The script compares against Shipwright's main by default, so main's sha is what a cached answer depends on.
const headOf = async (shipwright: string): Promise<string> => {
  const out = await run('git', ['-C', shipwright, 'rev-parse', 'main'], HEAD_TIMEOUT_MS);
  return out.ok ? out.stdout.trim() : '';
};

/** One manifest's check. Refuses a Shipwright folder that no project binds, without running anything. */
async function checkRow(ctx: Ctx, m: ManifestRow, manifestDirs: string[]): Promise<SyncOutcome> {
  if (m.error) return { ok: false, error: m.error };
  if (!m.shipwright || !isLocalAbsolutePath(m.shipwright) || !boundSomewhere(ctx, m.shipwright)) {
    return { ok: false, error: `Shipwright path ${m.shipwright || '(none)'} is not a folder bound to a project` };
  }
  // The source keeps no manifest of its own: a project that does (this one included) cannot be where the script comes from.
  if (manifestDirs.some((d) => same(d, m.shipwright))) {
    return { ok: false, error: `Shipwright path ${m.shipwright} is a project that keeps its own .claude/shipwright.json, not Shipwright` };
  }
  const key = JSON.stringify([await headOf(m.shipwright), m.mtimeMs, m.dir]);
  const hit = cache.get(m.projectId);
  if (hit && hit.key === key && Date.now() - hit.at < FRESH_MS) return hit.outcome;
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

/** POST /api/ui/library/sync: every manifest's check, in parallel. */
export async function librarySync(ctx: Ctx): Promise<LibrarySync> {
  const { rows, noManifest } = await manifests(ctx);
  const projects: SyncRow[] = await Promise.all(rows.map(async (m) => ({ projectId: m.projectId, slug: m.slug, name: m.name, dir: m.dir, check: await checkRow(ctx, m, rows.map((r) => r.dir)) })));
  return { projects, noManifest };
}

/** The manifests' rows with what each adopts and the Shipwright folder it names, no script run: for a page's Adapted in. */
export async function adopters(ctx: Ctx): Promise<{ slug: string; name: string; adopted: string[]; shipwright: string }[]> {
  return (await manifests(ctx)).rows.map((m) => ({ slug: m.slug, name: m.name, adopted: m.adopted, shipwright: m.shipwright }));
}
