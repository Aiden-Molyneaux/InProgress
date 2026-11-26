import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/smoke/**/*.test.ts'],
    environment: 'node',
    pool: 'forks',
    fileParallelism: false,
    testTimeout: 30_000,
    hookTimeout: 30_000,
    // As vitest.config.ts: the built server a smoke test starts never runs the real t3 CLI or the real claude.
    env: { T3CODE_CLI_PATH: '.test-no-t3/t3', INPROGRESS_LEAD_CLAUDE: '.test-no-claude/claude' },
  },
});
