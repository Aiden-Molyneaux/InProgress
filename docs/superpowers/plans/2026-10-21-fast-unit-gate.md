# #550 Fast unit gate: git-backed suites off the hot path

Goal: `npm test` under 60s on Aiden's machine, no test lost, deploy still runs the slow suites for the files they cover.

## Measured (2026-10-21, worktree off main at 0557ae3)

- Baseline `vitest run`: 1,876 tests, 105 files, 894s summed, 284s wall. offsite 254s, pages 194s, commands 101s, claude-config 70s, restore 55s, db 43s, context-nudge 34s.
- A process spawn costs about 0.7s here (`git --version`, `node -e 0`) with two VMware VMs holding the CPU at 72%. Under a full run every spawn slows further, so the git-backed files take 2 to 4 times their solo time.
- Global hooks (`~/.githooks`: pre-commit, post-commit, pre-push, post-checkout) add spawns per commit, push and clone: solo, commit 14.5s with them against 1.2s without.
- offsite.test.ts alone, hooks off: 238s. Each case needs its own remote (they assert on its commit count), so a shared remote does not apply.

## Approach

1. `vitest.config.ts`: `core.hooksPath` pointed at a missing folder through `GIT_CONFIG_COUNT` env, so no test git runs a hook. Same in the slow config.
2. New `test/slow/` suite, `vitest.slow.config.ts` (files in parallel), `npm run test:slow`. Unit config excludes `test/slow/**`.
3. Moves (pure tests stay in unit):
   - offsite: every case that runs git to `test/slow/offsite.test.ts`, run concurrently (cleanup in afterAll, since afterEach would delete a sibling's folders); `takeLock` and `credentialArgs` stay in `test/server/offsite.test.ts`.
   - pages: the four describes that call `setup()` to `test/slow/pages.test.ts`; front matter, secret scan and `frameHtml` stay.
   - commands: the `Backups doctor check` describe to `test/slow/backups-doctor.test.ts`.
   - restore: `restores a commit of the offsite repo` to `test/slow/restore-commit.test.ts`.
   - context-nudge: whole file to `test/slow/context-nudge.test.ts` (a node spawn per case).
4. Deploy: `suitesFor` gains `slow` (SLOW_PATHS: `src/(core|server|cli|lib)/`, `scripts/`, `test/slow/`, package files, `vitest.slow.config.ts`); `scripts/deploy.mjs` runs `npm run test:slow` when it is set. deploy-lib.test.ts covers the new key. docs/known-issues.md names the slow suite.
5. Re-measure; claude-config and db stay unless the unit run is still over 60s.

## Checks

typecheck, `npm test` (JSON profile before and after in the commit body), `npm run test:slow`, `npm run test:smoke`, test count before = unit after + slow after.
