// Copies the live database to a scratch file, migrates the copy with the repo's migration code, and prints the asks.
// The live file is only ever opened read-only; better-sqlite3's backup() writes the copy, WAL included.
// Usage: node scripts/check-migration-10.mjs <scratch dir>
import { existsSync, mkdirSync, rmSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import Database from 'better-sqlite3';
import { build } from 'esbuild';

const [dir] = process.argv.slice(2);
if (!dir) throw new Error('Usage: node scripts/check-migration-10.mjs <scratch dir>');
const live = join(homedir(), '.inprogress', 'inprogress.db');
if (!existsSync(live)) throw new Error(`No live database at ${live}`);
mkdirSync(dir, { recursive: true });
const copy = resolve(dir, 'inprogress-copy.db');
rmSync(copy, { force: true });

const src = new Database(live, { readonly: true, fileMustExist: true });
try {
  await src.backup(copy);
} finally {
  src.close();
}

// Bundle the repo's connection module (it imports TypeScript) next to the repo so better-sqlite3 resolves.
const bundle = resolve('.build', 'check-migration-10', 'connection.mjs');
await build({ entryPoints: ['src/server/db/connection.ts'], outfile: bundle, bundle: true, format: 'esm', platform: 'node', target: 'node20', external: ['better-sqlite3'], logLevel: 'error' });
const { openDb, schemaVersion } = await import(pathToFileURL(bundle).href);

const db = openDb(copy); // opens the copy only, and migrates it
console.log(`copy at schema v${schemaVersion(db)}`);
console.log(db.prepare('SELECT a.node_id, a.kind, a.text, a.raised_at, p.slug FROM asks a JOIN projects p ON p.id = a.project_id ORDER BY a.node_id').all());
db.close();
