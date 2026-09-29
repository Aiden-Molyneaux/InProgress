/**
 * Normalize a filesystem path for storage and comparison: forward slashes, repeated separators
 * collapsed (a UNC path keeps its leading `//`), Git Bash `/c/x` converted to `C:/x`, upper-case
 * drive letter, no trailing slash.
 * Windows-first: a POSIX path whose first segment is one letter (`/x/data`) is read as a drive.
 */
export function normalizePath(input: string): string {
  let p = input.trim().replace(/\\/g, '/');
  const unc = p.startsWith('//');
  p = p.replace(/\/{2,}/g, '/');
  if (unc) p = `/${p}`;
  const gitBash = /^\/([a-zA-Z])(\/.*)?$/.exec(p);
  if (gitBash) p = `${gitBash[1]}:${gitBash[2] ?? '/'}`;
  p = p.replace(/^([a-z]):/, (_m, drive: string) => `${drive.toUpperCase()}:`);
  while (p.length > 1 && p.endsWith('/') && !/^[A-Za-z]:\/$/.test(p)) p = p.slice(0, -1);
  return p;
}

/** True when `child` is `parent` or inside it. Case-insensitive (Windows). */
export function isUnder(child: string, parent: string): boolean {
  const c = normalizePath(child).toLowerCase();
  const p = normalizePath(parent).toLowerCase();
  if (c === p) return true;
  return c.startsWith(p.endsWith('/') ? p : `${p}/`);
}
