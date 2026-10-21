Known environment issues for InProgress: Doctor Nick's log (`.claude/skills/doctor-nick/SKILL.md`).
Any session appends here mid-task, with evidence: the real symptom text and a fix you watched
work. A re-hit bumps **Hits** and **Verified**. Entries seeded from the code and not yet hit say so.

# Active

## The server is not running when a hook fires
- **Symptom:** a session starts with no InProgress briefing, the window shows nothing new, or
  `node C:/personal/InProgress/dist/cli/main.js tasks ...` prints "InProgress is not running. A brief to the
  inprogress-scribe starts it; run this command again after that." No hook ever prints an error.
- **Diagnosis:** only the session-start hook starts the server (src/hooks/handlers.ts:400), and it
  waits up to 5 s for it (src/hooks/budget.ts:28-30). Every other hook makes one 500 ms POST and
  gives up after 750 ms. Hooks always exit 0; their errors and timeouts go to
  `~/.inprogress/hooks.log` (src/hooks/main.ts:57-61), and a server that failed to start writes
  its output to `~/.inprogress/server.log` (src/lib/ensure-server.ts:30). The scribe's MCP server
  also starts it, when it launches and on a refused call (src/mcp/main.ts:13-17,
  src/mcp/server.ts:71-72); so do the CLI's `doctor` and `open` (src/cli/commands.ts:65, 112). So a server that stops mid-session
  stays down until a new session starts, a scribe brief goes out, or someone starts it.
- **Fix:** `node C:/personal/InProgress/dist/cli/main.js start`, or the doctor (it starts the
  server first), or a brief to the scribe. If it will not start, read the tail of
  `~/.inprogress/server.log`.
- **Verified:** 2026-10-14, seeded from the code, not yet hit · **Hits:** 0

## Windows file locks on a rename, a deploy or an install
- **Symptom:** `EPERM`, `EBUSY` or `EACCES` when a folder is renamed, moved or deleted: the
  deploy's promote or rollback swap, `npm ci` in the main checkout, removing a worktree.
- **Diagnosis:** Windows will not move or delete a folder while a process holds a handle in it,
  including its working directory. The deploy retries each rename 30 times at 100 ms for an
  antivirus scan or a closing handle (scripts/deploy-lib.mjs:11-22), so a red after that is a
  handle that did not let go. The live server runs from `~/.inprogress` so it never pins a
  project folder (src/lib/ensure-server.ts:30-35), but it holds files open under the main
  checkout's `node_modules`, and `npm ci` deletes that folder first
  (docs/superpowers/plans/2026-10-05-quiet-restyle.md:8213).
- **Fix:** close what holds the handle (a shell or process whose working directory is inside the
  folder, a scan) and rerun. In the main checkout use `npm install`, not `npm ci`. Stop the
  server only when the fix needs it, and say so in the receipt.
- **Verified:** 2026-10-14, seeded from the code and the quiet-restyle plan · **Hits:** 0

## The hook-wait smoke test reads "timed out after 750 ms" under a busy deploy
- **Symptom:** `npm run deploy` goes red at "▸ Smoke tests" on `test/smoke/hook-wait.test.ts >
  other hooks still give their POST only 500 ms`: `expected '… prompt-submit: timed out after 750
  ms' to match /prompt-submit: InProgress server unreachable at .+ \(The operation was aborted due
  to timeout\)/`.
- **Diagnosis:** the hook's 750 ms process cap fired before its own 500 ms POST timeout could log,
  because the machine was loaded (the deploy's unit run had just finished, and other sessions were
  running suites). The same smoke suite passed 26/26 straight after, run alone from the worktree,
  and the diff that hit it (#528) touched no hook code.
- **Fix:** rerun `npm run deploy` once the machine is quieter.
- **Verified:** 2026-10-20 · **Hits:** 1

## A red deploy or rollback
- **Symptom:** `npm run deploy` exits non-zero. Before the "▸ Making ... live" step, the last
  thing printed is the failing step's own npm output. After it: "The new build did not start
  cleanly: rolling back." and a "Restart check:" line. A red `npm run rollback` prints "The
  previous build did not start cleanly: run `npm run rollback` again to return to the newer
  one." and the same line.
- **Diagnosis:** the deploy runs type checks, unit tests, smoke when hook, CLI, MCP, server or kit
  files changed, the slow suites in `test/slow` (real git and node processes) when core, server,
  CLI, lib or script files changed, e2e (or only the build) when UI, core or server files changed,
  then promotes the new build (the old one moves to `.deploy/prev`), reinstalls the Claude kit
  when `claude-check` asks for it, and restarts the server (scripts/deploy.mjs:75-122). A red before the promote
  leaves the live build untouched. A red restart swaps the previous build back and restarts it.
  The restart check passes when `/api/health` reports the sha and builtAt in `dist/build.json`
  (scripts/deploy-lib.mjs:81-108). Its "Restart check:" line gives the build expected, the status,
  build and body health answered, or the error when it did not answer, or the exit of `start`.
- **Fix:** red before the promote: fix on the branch, merge, and deploy again (Sigmund, phase 8).
  Red restart: read the "Restart check:" line first. The deploy swaps the old build back and
  prints a second line if that one did not start either (scripts/deploy.mjs:108-117); then run
  `node C:/personal/InProgress/dist/cli/main.js status`, and `start` if it is down, and read
  `~/.inprogress/server.log` for why the new one did not. Red rollback: run `npm run rollback`
  once more to return to the newer build, then read `server.log`. All of these run from the main
  checkout, under the merge gate.
- **Hit 2026-10-16 (#442, 8b796d9):** red restart after every gate passed. The new server logged
  Ready and was still answering, and health came back inside its 2 s timeout, but the check
  failed; the deploy then printed nothing on why. That build ran fine on a scratch copy, and
  `npm run rollback` swapped it back in and passed the check. Cause not proven; the "Restart
  check:" line was added so the next one says what health returned.
- **Verified:** 2026-10-16 · **Hits:** 1

## A deploy refused: another deploy is running
- **Symptom:** `npm run deploy` or `npm run rollback` exits 1 at once with "Another deploy is
  running: a deploy of <sha> (<branch>), pid <pid>, started <time>".
- **Diagnosis:** two deploys at once share `.build`, e2e port 4399 and the live trees. On
  2026-10-16 the #447 and #452 sessions deployed together and one went red on a port clash. Each
  deploy or rollback now takes `.deploy/lock` first and releases it on exit; a second one refuses
  before it touches anything. A lock whose pid has exited (a deploy killed mid-run) is taken over,
  and the deploy prints "Took over the lock of ..." (scripts/deploy-lib.mjs acquireLock). Killing a
  deploy's node alone can leave its npm, Playwright and e2e server running, so a red e2e on port
  4399 right after that line means the old run's tests are still going.
- **Fix:** wait for the named deploy to finish, then run again: it deploys whatever main holds
  then. Merging into main while a deploy runs changes the files under it, so wait to merge too.
  If the pid named is not a deploy (Windows reuses pids), delete `.deploy/lock` and run again.
- **Verified:** 2026-10-16, #454 · **Hits:** 0

## claude:install from the wrong checkout
- **Symptom:** every session's hooks run a worktree's build (unmerged behaviour everywhere), or,
  once that worktree is removed, the doctor prints `✗ Hooks: hook script <path> no longer exists`
  and the hooks stop working in every session.
- **Diagnosis:** install writes the absolute path of the checkout it ran from, and the Node binary
  that ran it, into each hook entry in `~/.claude/settings.json` (src/cli/claude-config.ts:58-72;
  the script is the entry's `args[0]`, `command` is the Node binary), and the same path into the
  scribe's MCP server in `~/.claude/agents/inprogress-scribe.md`.
  The doctor's Hooks check fails only once the script is gone (src/cli/doctor.ts:135-137), so a
  hook pointing at a live worktree passes.
- **Fix:** `npm run claude:install` from C:/personal/InProgress. It also stops the server: start it
  again with `node C:/personal/InProgress/dist/cli/main.js start`, which runs the main build. Candidate doctor check (proposed, not built): Hooks
  warns when a hook script sits outside the checkout the doctor runs from.
- **Verified:** 2026-10-14, seeded from the code, not yet hit · **Hits:** 0

## The first `npm test` run fails a file
- **Symptom:** the first `npm test` in a session reports 1 test file failed and 0 tests failing;
  an immediate rerun is clean (Aiden's report on #431).
- **Diagnosis:** not yet known. Vitest counts a file as failed with no failing test when it errors
  outside a test (an import, a setup file, a `beforeAll`). Nothing in the config or the docs
  records this; the nearest records are load flakes that failed once under the full suite and
  passed alone (`~/.inprogress/resources/inprogress/2026-10-13-stage1-window-landed.md:40`).
- **Fix:** rerun `npm test` once. A file that fails twice is a real failure. On the next hit,
  record the file name and its error text here.
- **Second hit (2026-10-20, #502, inside `npm run deploy`):** `test/server/open-desktop.test.ts` failed at teardown with
  `ENOTEMPTY: directory not empty, rmdir '...\Temp\ip-open-desktop-<id>\sessions-8\account-uuid\org-uuid'`; all 1760
  tests passed, 1 of 96 files failed. A rerun of the deploy was green. So at least one cause is a Windows temp-folder
  removal racing a handle still open on it during a file's cleanup.
- **Verified:** 2026-10-20 · **Hits:** 2

# Promoted

# Canonized
