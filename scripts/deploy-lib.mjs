// Directory moves for `npm run deploy` / `npm run rollback`. Each live tree (dist/, web/dist/) is swapped by renames on
// one volume, so hooks firing during a deploy see the old or the new build, never a half-written one. Also the check
// that the restarted server runs the live build, and which test suites a deploy runs.
import { existsSync, mkdirSync, renameSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';

/** The trees a deploy swaps, relative to the repo (and to the build and prev roots, which mirror its layout). */
export const TREES = ['dist', join('web', 'dist')];

const sleep = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

/** Windows can hold a moved-from folder briefly (an antivirus scan, a closing handle): retry for about 3 s. */
export function renameWithRetry(from, to, rename = renameSync) {
  for (let attempt = 0; ; attempt++) {
    try {
      mkdirSync(dirname(to), { recursive: true });
      rename(from, to);
      return;
    } catch (err) {
      if (attempt >= 30 || !['EPERM', 'EBUSY', 'EACCES'].includes(err.code)) throw err;
      sleep(100);
    }
  }
}

/** Runs moves in order; if one fails, moves the earlier ones back and rethrows, leaving things as they were. */
function moveAll(moves, rename) {
  const done = [];
  try {
    for (const [from, to] of moves) {
      renameWithRetry(from, to, rename);
      done.push([from, to]);
    }
  } catch (err) {
    for (const [from, to] of done.reverse()) renameWithRetry(to, from, rename);
    throw err;
  }
}

/**
 * Makes the build in `from` live: the current live trees move to `prev` (replacing what was there), then the new
 * ones move in. Checks every new tree exists before moving anything.
 */
export function promote({ repo, from, prev, rename = renameSync }) {
  for (const tree of TREES) if (!existsSync(join(from, tree))) throw new Error(`deploy: ${join(from, tree)} is missing; build first`);
  rmSync(prev, { recursive: true, force: true });
  const moves = [];
  for (const tree of TREES) if (existsSync(join(repo, tree))) moves.push([join(repo, tree), join(prev, tree)]);
  for (const tree of TREES) moves.push([join(from, tree), join(repo, tree)]);
  moveAll(moves, rename);
}

/** Swaps the live trees with the ones in `prev`, so a second rollback rolls forward again. */
export function swapWithPrev({ repo, prev, rename = renameSync }) {
  for (const tree of TREES) if (!existsSync(join(prev, tree))) throw new Error(`rollback: no previous build at ${join(prev, tree)}`);
  const parked = `${prev}.swap`;
  rmSync(parked, { recursive: true, force: true });
  const moves = [];
  for (const tree of TREES) moves.push([join(repo, tree), join(parked, tree)], [join(prev, tree), join(repo, tree)], [join(parked, tree), join(prev, tree)]);
  moveAll(moves, rename);
  rmSync(parked, { recursive: true, force: true });
}

// Which test suites a change needs. Typecheck and unit tests always run; these decide the slower two.
const SMOKE_PATHS = [/^src\/(hooks|cli|mcp|server|lib)\//, /^claude\//, /^scripts\//, /^test\/smoke\//, /^(package\.json|package-lock\.json|tsup\.config\.ts|tsconfig\.json|vitest\.smoke\.config\.ts)$/];
const E2E_PATHS = [/^web\//, /^src\/(core|server|lib)\//, /^test\/e2e\//, /^(package\.json|package-lock\.json|tsconfig\.json|playwright\.config\.ts)$/];

/** `changed` is the paths changed since the deployed build, or null when that build is unknown (then run everything). */
export function suitesFor(changed) {
  if (changed === null) return { smoke: true, e2e: true };
  const paths = changed.map((p) => p.replace(/\\/g, '/'));
  const any = (patterns) => paths.some((p) => patterns.some((re) => re.test(p)));
  return { smoke: any(SMOKE_PATHS), e2e: any(E2E_PATHS) };
}

/** A build.json as one line: `8b796d9+dirty (2026-10-16T19:31:58.000Z)`. Twin of src/core/build.ts buildLabel, which scripts/ can't import before a build. */
export const buildLabel = (b) => (b ? `${b.sha}${b.dirty ? '+dirty' : ''} (${b.builtAt})` : 'unknown build');

const BODY_MAX = 500;

/**
 * Whether the restarted server runs the live build. `live` is dist/build.json (null when unreadable); `seen` is what
 * GET /api/health gave: `{ status, text }` when it answered, `{ error }` when it did not. Null when the builds match
 * (same sha and builtAt), else one line saying what health returned against what was expected (#442's red deploy).
 */
export function restartCheck(live, seen) {
  if (seen.error) {
    const { name, message, cause } = seen.error;
    let said = '';
    try {
      said = cause && (cause.message || (Array.isArray(cause.errors) ? cause.errors.map((e) => e?.message).filter(Boolean).join('; ') : '') || String(cause));
    } catch {
      // A cause that can't be printed must not stop the rollback that follows.
    }
    const why = cause ? ` (${cause.code ? `${cause.code}: ` : ''}${said})` : '';
    return `/api/health did not answer: ${name}: ${message}${why}`;
  }
  let running = null;
  try {
    running = JSON.parse(seen.text)?.build ?? null;
  } catch {
    // Not JSON: the body below says what it was.
  }
  if (live && running && running.sha === live.sha && running.builtAt === live.builtAt) return null;
  const body = !seen.text ? '(empty)' : seen.text.length > BODY_MAX ? `${seen.text.slice(0, BODY_MAX)}... (${seen.text.length} chars)` : seen.text;
  const expected = live ? `expected ${buildLabel(live)}` : 'dist/build.json is missing or unreadable';
  return `${expected}; /api/health answered ${seen.status} with ${running ? buildLabel(running) : 'no build'}. Body: ${body}`;
}
