import { defineConfig } from 'tsup';

export default defineConfig({
  entry: {
    'server/main': 'src/server/main.ts',
    'mcp/main': 'src/mcp/main.ts',
    'cli/main': 'src/cli/main.ts',
    'hooks/hook': 'src/hooks/main.ts',
  },
  format: ['esm'],
  platform: 'node',
  target: 'node20',
  splitting: false,
  sourcemap: true,
  clean: true,
  outDir: 'dist',
  // Bundle the pure-JS dependencies: a cold start then reads a handful of files instead of ~325 from node_modules
  // (#60). better-sqlite3 loads a native binding from its own folder, so it stays outside; noExternal wins over
  // external in tsup, hence the exclusion inside the pattern.
  noExternal: [/^(?!better-sqlite3(\/|$))/],
  // Bundled CommonJS code calls require() and reads __filename/__dirname, which ESM output lacks.
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
