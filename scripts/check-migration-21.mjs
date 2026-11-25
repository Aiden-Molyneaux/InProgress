// Copies the live database to a scratch file, migrates the copy with the repo's migration code, and compares every
// table's row count before and after. The live file is only ever opened read-only; better-sqlite3's backup() writes the
// copy, WAL included.
// Usage: node scripts/check-migration-21.mjs <scratch dir>
import { existsSync, mkdirSync, realpathSync, rmSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, join, relative, resolve, isAbsolute } from 'node:path';
import { pathToFileURL } from 'node:url';
import Database from 'better-sqlite3';
import { build } from 'esbuild';

const NEW_TABLES = ['desk_items', 'lead_turns', 'lead_decisions', 'lead_sends', 'usage_readings'];

const [dir] = process.argv.slice(2);
if (!dir) throw new Error('Usage: node scripts/check-migration-21.mjs <scratch dir>');
const liveHome = join(homedir(), '.inprogress');
const live = join(liveHome, 'inprogress.db');
if (!existsSync(live)) throw new Error(`No live database at ${live}`);

/** True when `path` is `home` or under it, compared case-insensitively on Windows. */
function inside(path, home) {
  const fold = (p) => (process.platform === 'win32' ? p.toLowerCase() : p);
  const rel = relative(fold(home), fold(path));
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
}
/**
 * `path` in its long, link-resolved form: its nearest existing ancestor through realpathSync.native (which, unlike plain
 * realpathSync, expands 8.3 short names such as AIDEN~1.MOL), with the parts not made yet joined back on.
 */
function longForm(path) {
  let base = resolve(path);
  const rest = [];
  while (!existsSync(base)) {
    const parent = dirname(base);
    if (parent === base) return resolve(path);
    rest.unshift(basename(base));
    base = parent;
  }
  return join(realpathSync.native(base), ...rest);
}
const scratch = resolve(dir);
const realHome = longForm(liveHome);
if (inside(scratch, liveHome) || inside(scratch, realHome) || inside(longForm(scratch), realHome)) {
  throw new Error(`The scratch dir ${scratch} is inside the live home ${liveHome}; give a dir outside it`);
}
mkdirSync(scratch, { recursive: true });
// The made dir resolved through any link: a link that leads into the live home is refused too.
if (inside(realpathSync.native(scratch), realHome)) {
  throw new Error(`The scratch dir ${scratch} resolves inside the live home ${liveHome}; give a dir outside it`);
}
const copy = join(scratch, 'inprogress-copy.db');
rmSync(copy, { force: true });

const src = new Database(live, { readonly: true, fileMustExist: true });
try {
  await src.backup(copy);
} finally {
  src.close();
}

const tablesOf = (db) => db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").pluck().all();
const countsOf = (db) => new Map(tablesOf(db).map((name) => [name, db.prepare(`SELECT COUNT(*) FROM "${name.replace(/"/g, '""')}"`).pluck().get()]));
const versionOf = (db) => db.prepare("SELECT value FROM meta WHERE key = 'schema_version'").pluck().get() ?? '(none)';

const plain = new Database(copy, { fileMustExist: true });
let before;
let versionBefore;
try {
  before = countsOf(plain);
  versionBefore = versionOf(plain);
} finally {
  plain.close();
}

// Bundle the repo's connection module (it imports TypeScript) next to the repo so better-sqlite3 resolves.
const bundle = resolve('.build', 'check-migration-21', 'connection.mjs');
await build({ entryPoints: ['src/server/db/connection.ts'], outfile: bundle, bundle: true, format: 'esm', platform: 'node', target: 'node20', external: ['better-sqlite3'], logLevel: 'error' });
const { openDb, schemaVersion } = await import(pathToFileURL(bundle).href);

const db = openDb(copy); // opens the copy only, and migrates it
let unchanged = true;
try {
  const after = countsOf(db);
  console.log(`schema version before: v${versionBefore}`);
  console.log(`schema version after: v${schemaVersion(db)}`);
  console.log(`min_reader_version: ${db.prepare("SELECT value FROM meta WHERE key = 'min_reader_version'").pluck().get() ?? '(none)'}`);
  for (const [name, count] of before) {
    const now = after.get(name);
    const same = now === count;
    if (!same) unchanged = false;
    console.log(`${name}: ${count} -> ${now ?? '(gone)'} ${same ? 'same' : 'CHANGED'}`);
  }
  for (const name of NEW_TABLES) {
    console.log(`new table ${name}: ${after.has(name) ? `present (${after.get(name)} rows)` : 'MISSING'}`);
  }
} finally {
  db.close();
}
console.log(`counts unchanged: ${unchanged ? 'yes' : 'no'}`);
