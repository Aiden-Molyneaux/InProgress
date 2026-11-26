// The exam's guard on the live home: no path it writes under, and no copy it reads, may lie under the live InProgress home.
import { existsSync, realpathSync } from 'node:fs';
import { dirname, relative, isAbsolute, resolve } from 'node:path';

/** The real path of the nearest ancestor of `p` (itself included) that exists; 8.3 short names and links are resolved. */
export function realOfNearest(p) {
  let here = resolve(p);
  while (!existsSync(here)) {
    const up = dirname(here);
    if (up === here) break;
    here = up;
  }
  return realpathSync.native(here);
}

/** Whether `child` is `parent` or under it, compared case-insensitively as Windows does. */
const under = (child, parent) => {
  const rel = relative(parent.toLowerCase(), child.toLowerCase());
  // Only a real parent step leaves the parent: a name that merely starts with two dots (..x) is under it.
  const leaves = rel === '..' || rel.startsWith('..\\') || rel.startsWith('../');
  return rel === '' || (!leaves && !isAbsolute(rel));
};

/** Throws when any of `paths` is, by real path, the live home or under it. Makes nothing. */
export function refuseLiveHome(paths, liveHome) {
  const live = realOfNearest(liveHome);
  for (const p of paths) {
    const real = realOfNearest(p);
    if (under(real, live)) throw new Error(`${p} is under the live InProgress home (${live}): the exam never touches it`);
  }
}
