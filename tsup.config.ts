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
});
