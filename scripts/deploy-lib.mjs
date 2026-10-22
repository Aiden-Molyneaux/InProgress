// Directory moves for `npm run deploy` / `npm run rollback`. Each live tree (dist/, web/dist/) is swapped by renames on
// one volume, so hooks firing during a deploy see the old or the new build, never a half-written one. Also the check
// that the restarted server runs the live build, which test suites a deploy runs, and the lock that keeps two deploys
// from running at once.
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
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

// Which test suites a change needs. Typecheck and unit tests always run; these decide the slower three.
const SMOKE_PATHS = [/^src\/(hooks|cli|mcp|server|lib)\//, /^claude\//, /^scripts\//, /^test\/smoke\//, /^(package\.json|package-lock\.json|tsup\.config\.ts|tsconfig\.json|vitest\.smoke\.config\.ts)$/];
// The suites in test/slow spawn real git and node: they cover the backup, restore, pages and doctor code, and the context-nudge script.
const SLOW_PATHS = [/^src\/(core|server|cli|lib)\//, /^scripts\//, /^test\/slow\//, /^test\/helpers\.ts$/, /^(package\.json|package-lock\.json|tsconfig\.json|vitest\.config\.ts|vitest\.slow\.config\.ts)$/];
const E2E_PATHS = [/^web\//, /^src\/(core|server|lib)\//, /^test\/e2e\//, /^(package\.json|package-lock\.json|tsconfig\.json|playwright\.config\.ts)$/];

/** `changed` is the paths changed since the deployed build, or null when that build is unknown (then run everything). */
export function suitesFor(changed) {
  if (changed === null) return { smoke: true, slow: true, e2e: true };
  const paths = changed.map((p) => p.replace(/\\/g, '/'));
  const any = (patterns) => paths.some((p) => patterns.some((re) => re.test(p)));
  return { smoke: any(SMOKE_PATHS), slow: any(SLOW_PATHS), e2e: any(E2E_PATHS) };
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
    // An error that can't be printed must not stop the rollback that follows.
    try {
      const { name, message, cause } = seen.error;
      const said = cause && (cause.message || (Array.isArray(cause.errors) ? cause.errors.map((e) => e?.message).filter(Boolean).join('; ') : '') || String(cause));
      const why = cause ? ` (${cause.code ? `${cause.code}: ` : ''}${said})` : '';
      return `/api/health did not answer: ${name}: ${message}${why}`;
    } catch {
      return '/api/health did not answer, with an error that could not be printed';
    }
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

// One deploy or rollback at a time. Two at once share .build, e2e port 4399 and the live trees (#454: the #447 and
// #452 deploys of 2026-10-16), so the second refuses and names the first.

/** Whether a process is still running: signal 0 checks without sending anything; EPERM means it runs as another user. */
export function pidAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err.code === 'EPERM';
  }
}

/** The lock's contents: null when there is no lock, `{}` when it can't be read (being written, or corrupt). */
function readLock(file) {
  try {
    const held = JSON.parse(readFileSync(file, 'utf8'));
    return held && typeof held === 'object' ? held : {};
  } catch (err) {
    return err.code === 'ENOENT' ? null : {};
  }
}

/**
 * Takes the deploy lock at `file` (created only if absent, so two deploys can't both take it), recording `info` and
 * this process's pid. Returns `{ release, tookOver }` when taken, else `{ holder }`: what the running deploy recorded.
 * A lock whose pid has exited (a deploy killed mid-run) is taken over and returned as `tookOver`, so the deploy can say
 * so: killing a deploy's node alone can leave its tests running. A lock holding our own pid is a dead deploy's whose
 * pid Windows reused. Two deploys taking over the same dead lock in the same instant could both get it; that needs a
 * crash and then a tie, so it is left.
 */
export function acquireLock({ file, info, pid = process.pid, isAlive = pidAlive }) {
  const mine = JSON.stringify({ ...info, pid });
  mkdirSync(dirname(file), { recursive: true });
  let tookOver = null;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      writeFileSync(file, mine, { flag: 'wx' });
      const release = () => {
        // Only our own lock is removed: a deploy that took over a lock it thought dead keeps its own.
        try {
          if (readFileSync(file, 'utf8') === mine) rmSync(file, { force: true });
        } catch {
          // Gone, or could not be removed: the next deploy takes over a lock whose pid has exited.
        }
      };
      return { release, tookOver };
    } catch (err) {
      if (err.code !== 'EEXIST') throw err;
    }
    let holder = readLock(file);
    if (holder && !Number.isInteger(holder.pid)) {
      // Caught between the holder's create and its write: look again before calling it unreadable.
      sleep(100);
      holder = readLock(file);
    }
    if (holder === null) continue; // released between the two calls
    if (!Number.isInteger(holder.pid) || (holder.pid !== pid && isAlive(holder.pid))) return { holder };
    rmSync(file, { force: true });
    tookOver = holder;
  }
  return { holder: readLock(file) ?? {} };
}

/** A lock's deploy as words: `a deploy of 31e6b56 (main), pid 101`. */
const lockedDeploy = (holder) =>
  `${holder.kind === 'rollback' ? 'a rollback' : 'a deploy'}${holder.sha ? ` of ${holder.sha}` : ''}${holder.branch ? ` (${holder.branch})` : ''}, pid ${holder.pid}`;

/** What a deploy prints when it took over a dead one's lock. */
export const lockTakenOverMessage = (holder) =>
  `Took over the lock of ${lockedDeploy(holder)}, started ${holder.startedAt ?? 'at an unknown time'}, which has exited. If its tests are still running, .build and port 4399 are in use.`;

/** What a refused deploy prints: which deploy holds the lock, since when, and what to do. */
export function lockHeldMessage(holder, file, now = Date.now()) {
  if (!Number.isInteger(holder.pid)) {
    return `Another deploy holds ${file}, but its lock could not be read. If no deploy or rollback is running, delete it and run again.`;
  }
  const started = Date.parse(holder.startedAt);
  const mins = Math.floor((now - started) / 60000);
  const when = Number.isNaN(started) ? '' : `, started ${holder.startedAt} (${mins < 1 ? 'under a minute' : `${mins} min`} ago)`;
  return [
    `Another deploy is running: ${lockedDeploy(holder)}${when}.`,
    'Wait for it to finish, then run this again. Two at once share .build and port 4399, so this one stops here and changes nothing.',
    `If pid ${holder.pid} is not a deploy, delete ${file} and run again.`,
  ].join('\n');
}
