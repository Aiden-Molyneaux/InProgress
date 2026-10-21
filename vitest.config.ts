import { resolve } from 'node:path';
import { defineConfig } from 'vitest/config';

/** Points core.hooksPath at a folder that does not exist, through git's environment config, so no hook runs. */
export const NO_GIT_HOOKS = { GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'core.hooksPath', GIT_CONFIG_VALUE_0: resolve('.test-home', 'no-git-hooks') };

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    exclude: ['test/smoke/**', 'test/slow/**', 'test/e2e/**', 'node_modules/**'],
    environment: 'node',
    // Threads, not forks: a process spawn costs most of a second on Windows, and forks paid it once per worker.
    pool: 'threads',
    testTimeout: 20_000,
    hookTimeout: 30_000,
    // Keep every test out of the real ~/.inprogress and ~/.claude, and every git a test spawns away from the machine's
    // global hooks: a hook costs seconds per commit, push or clone on Windows, and no test is about the hooks.
    env: { INPROGRESS_HOME: '.test-home', INPROGRESS_CLAUDE_DIR: '.test-claude', ...NO_GIT_HOOKS },
  },
});
