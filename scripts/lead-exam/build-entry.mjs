// Bundles harness-entry.ts into <build dir>/dist/exam/harness.js, with the options of tsup.config.ts. Run it after
// `node scripts/build-to.mjs <build dir>`, which makes the build's dist/lead/tools.js that the runner's tool server runs.
// usage: node scripts/lead-exam/build-entry.mjs <build dir>
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'tsup';

const here = fileURLToPath(new URL('.', import.meta.url));
const repo = resolve(here, '..', '..');
const root = resolve(process.argv[2] ?? '');
if (!process.argv[2] || root === repo) throw new Error('usage: build-entry.mjs <build dir> (not the repo itself)');
await build({
  config: false,
  entry: { 'exam/harness': resolve(here, 'harness-entry.ts') },
  format: ['esm'],
  platform: 'node',
  target: 'node20',
  splitting: false,
  sourcemap: true,
  clean: false,
  outDir: resolve(root, 'dist'),
  noExternal: [/^(?!(better-sqlite3|electron)(\/|$))/],
  external: ['electron'],
  banner: {
    js: [
      "import { createRequire as __ipCreateRequire } from 'node:module';",
      "import { fileURLToPath as __ipFileURLToPath } from 'node:url';",
      "import { dirname as __ipDirname } from 'node:path';",
      'const require = __ipCreateRequire(import.meta.url);',
      'const __filename = __ipFileURLToPath(import.meta.url);',
      'const __dirname = __ipDirname(__filename);',
    ].join(' '),
  },
});
