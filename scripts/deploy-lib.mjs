// Directory moves for `npm run deploy` / `npm run rollback`. Each live tree (dist/, web/dist/) is swapped by renames on
// one volume, so hooks firing during a deploy see the old or the new build, never a half-written one.
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
