import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    exclude: ['test/smoke/**', 'test/e2e/**', 'node_modules/**'],
    environment: 'node',
    pool: 'forks',
    testTimeout: 20_000,
    hookTimeout: 30_000,
    // Keep every test out of the real ~/.inprogress and ~/.claude.
    // And run git without the user's hooks (core.hooksPath at a folder no repo has): global ones such as Git LFS cost
    // seconds a commit, and the temp-repo tests (and the offsite code under test) commit often enough to time out.
    env: {
      INPROGRESS_HOME: '.test-home',
      INPROGRESS_CLAUDE_DIR: '.test-claude',
      GIT_CONFIG_COUNT: '1',
      GIT_CONFIG_KEY_0: 'core.hooksPath',
      GIT_CONFIG_VALUE_0: '.ip-test-no-hooks',
    },
  },
});
