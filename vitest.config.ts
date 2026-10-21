import { defineConfig } from 'vitest/config';

/**
 * Runs git without the user's hooks: core.hooksPath at a folder no repo has, through git's environment config, for the
 * tests' own git and the code under test. Global hooks such as Git LFS cost seconds per commit, push or clone.
 */
export const NO_GIT_HOOKS = { GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'core.hooksPath', GIT_CONFIG_VALUE_0: '.ip-test-no-hooks' };

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    exclude: ['test/smoke/**', 'test/slow/**', 'test/e2e/**', 'node_modules/**'],
    environment: 'node',
    // Threads, not forks: a process spawn costs most of a second on Windows, and forks paid it once per worker.
    pool: 'threads',
    testTimeout: 20_000,
    hookTimeout: 30_000,
    // Keep every test out of the real ~/.inprogress and ~/.claude, and every git it runs away from the user's hooks.
    env: { INPROGRESS_HOME: '.test-home', INPROGRESS_CLAUDE_DIR: '.test-claude', ...NO_GIT_HOOKS },
  },
});
