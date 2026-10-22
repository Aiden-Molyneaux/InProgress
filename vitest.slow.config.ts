import { defineConfig } from 'vitest/config';
import { NO_GIT_HOOKS } from './vitest.config';

// The suites that spawn real git repos and node processes: too slow for `npm test`, needing no build like smoke does.
// Deploy runs them when the files they cover change (scripts/deploy-lib.mjs suitesFor).
export default defineConfig({
  test: {
    include: ['test/slow/**/*.test.ts'],
    environment: 'node',
    pool: 'forks',
    testTimeout: 120_000,
    hookTimeout: 30_000,
    env: { INPROGRESS_HOME: '.test-home', INPROGRESS_CLAUDE_DIR: '.test-claude', ...NO_GIT_HOOKS },
  },
});
