---
name: doctor-nick
description: >-
  Doctor Nick triages a broken environment in this repo (InProgress): the dev server or stack
  won't start or won't answer, a deploy or rollback goes red, a check fails before it reaches the
  code (an install, a lock, a port, a path, a runner that reports nonsense; a check whose own
  definition is wrong is a workflow note instead), the preview is blank,
  or nobody knows what state the stack is in. Use him whenever you START verification against the
  running app (preview, screenshots for Parvati, integration or e2e runs), whenever you are BLOCKED
  by the environment rather than by a product bug, and at the WRAP-UP of any task that hit
  environment friction. Also triggers on "run doctor nick", "doctor", "the server won't start",
  "deploy is red", "why is the preview broken", "is the stack up". Do NOT use him for product bugs
  (that is systematic-debugging's lane), for judging the work (Murr and Parvati own that),
  or for changing the project's code: a new doctor check is a change, and runs through Sigmund.
---

# Doctor Nick: environment triage for InProgress

Environment problems are cheap the second time if the first time was written down. Doctor Nick
keeps three things: a **preflight** that proves the environment is up before anyone uses it, a
**runbook** that maps a symptom to its first probe and its fix, and a **known-issues log** that
grows every time an issue is solved. The ladder that ties them together:

**capture on the first hit, automate on the second, make it law once it is stable.**

- **Capture:** the known-issues log, `docs/known-issues.md`. Any session appends to it, mid-task,
  with no ceremony.
- **Automate:** the doctor, `node C:/personal/InProgress/dist/cli/main.js doctor`, always by
  that absolute path, from any folder. Read-only: it probes the known failure signatures, prints
  the exact fix, and exits non-zero on a blocking red. Its one write: when the live server is
  down it starts it first, and says so. Never run `node dist/cli/main.js` from a worktree: a
  worktree's own `dist/`, if it has one, would check the wrong build and, with the live server
  down, start that unmerged build on 4317 against `~/.inprogress`.
- **Law:** a standing environment invariant becomes a line in the project's working rules, on the
  owner's say-so only.

He runs inline, in the session that hit the problem. That session already holds the error text
and the state, and a dispatch would cost more than it saves, so he has no agent wrapper. A
subagent that hits the environment (Sev's checks, Parvati's build) stops and reports the failing
command and its literal output; only the main session runs the doctor and the triage.

## Preflight [edit]

Before any preview, screenshot, browser, integration or e2e work, bring the environment up and
check it. Green before you start; never hand-build a parallel server.

Two modes, by what the work runs against:

- **The live install** (this session's hooks, the scribe, the window on 4317; the main session
  only): `node C:/personal/InProgress/dist/cli/main.js doctor`. It checks, in order: Server,
  Token, Database, Hooks, Scribe agent, Skill, Allow rules, MCP server, and Edge. No ✗ line, or
  its printed fix applied and the doctor rerun, before going on. A `!` line is a warning (Edge
  missing, the hooks on another Node, MCP skipped): act on it only when it bears on the work.
- **An isolated build** (Parvati, Sev on a UI plan, a hand-driven check of a branch): from the
  worktree, `node scripts/build-to.mjs .build`, then start `.build/dist/server/main.js` the way
  `test/e2e/start-server.mjs` does (`INPROGRESS_HOME` set to a scratch folder,
  `INPROGRESS_PORT` set to the lane port, `INPROGRESS_AGENT_WATCH_MS=500`), and confirm
  `GET http://127.0.0.1:<port>/api/health` answers with `"app":"inprogress"` before driving it.
  Ports 4400 to 4420 only (Parvati 4400 to 4409, Sev's e2e 4410 to 4419, Sigmund's check surface
  4420), never 4317 or 4399, and never `~/.inprogress` (the check surface runs on a copy of its
  database). `npm run test:e2e` does all of this itself on `INPROGRESS_E2E_PORT`.

## The three rules

1. **Preflight.** As above, every time. A red line is fixed or reported before the work starts.
2. **Stuck rule.** Blocked on the environment (servers, ports, installs, locks, paths, the
   runner; not a product bug) for more than about two minutes: run the doctor, then the runbook,
   then search the known-issues log for the error text. Only then investigate from scratch, with
   systematic-debugging. Product bugs are exempt: that is real work, not friction.
3. **Retro rule.** The wrap-up receipt of every task that touched the running app, a deploy or
   the test runner answers **"Environment friction this run?"** Novel friction you solved gets a
   known-issues entry before the turn ends. A re-hit bumps **Hits** and **Verified**.

## Triage

0. **Name the symptom** in one line: the command, the literal error text, and where it ran (which
   checkout or worktree, which port, which shell).
1. **Run the doctor.** A red line prints its fix; apply it and rerun the doctor.
2. **Match the runbook.** Find the symptom's row below and run its first probe. A row that points
   at a known issue sends you to that entry's fix.
3. **Search the log.** Grep `docs/known-issues.md` for the error text and its key words. A hit:
   apply the fix, then go to step 5.
4. **Investigate fresh** only when 1 to 3 found nothing: systematic-debugging, evidence first,
   one change at a time.
5. **Verify.** Rerun the command that failed, then the doctor. Both green before going back to
   the work.
6. **Record** (the retro rule): a new entry, or Hits and Verified on the old one.

## Runbook: triage by symptom [edit]

The project's map from what you see to what you check first. A row names the symptom, the first
probe, and where the fix lives (a doctor check, a known-issues entry, or the fix itself when it
is one line). Rows change only through a session working on the project's own rules, never from
inside a triage.

| Symptom | First probe | Fix |
|---|---|---|
| The doctor prints a ✗ line | The line itself | Its printed fix, then rerun the doctor. A printed `inprogress <cmd>` means `node C:/personal/InProgress/dist/cli/main.js <cmd>`, and when a printed fix says `stop` (some add "the next session starts the new build"), run `start` straight after it yourself |
| The doctor prints a `!` line | Whether it bears on the work (Edge only matters for `open`; another Node only after an nvm switch) | Its printed fix when it does; otherwise note it and go on |
| A session started with no InProgress briefing, or `tasks` says InProgress is not running | `node C:/personal/InProgress/dist/cli/main.js status`, then the tail of `~/.inprogress/hooks.log` and `~/.inprogress/server.log` | Known issue: the server is not running when a hook fires |
| `EPERM`, `EBUSY` or `EACCES` on a rename, a folder move, an install or a deploy | What holds the handle: the live server (files under the main checkout's `node_modules`), an editor, a shell sitting in the folder, antivirus | Known issue: Windows file locks |
| `npm run deploy` or `npm run rollback` ends red | The last `▸` step it printed, and whether it printed "rolling back" | Known issue: a red deploy or rollback |
| `Cannot find module`, or a package missing, in a worktree | Is the missing module the repo's own `dist/...`? Then a command ran a relative path from a worktree, which has no `dist/`: use `node C:/personal/InProgress/dist/cli/main.js`. Otherwise, does the worktree have its own `node_modules`? Each one here keeps its own; without it, Node resolves from the main checkout's, which follows main's `package.json`, not the branch's | The absolute path, or `npm install` in the worktree |
| Hooks behave like an unmerged build, or the doctor's Hooks line says a hook script no longer exists | The hook entries in `~/.claude/settings.json`: each one's `args[0]` (the script; `command` is the Node binary) should start with `C:/personal/InProgress/dist/`, and so should the MCP server path in `~/.claude/agents/inprogress-scribe.md` | Known issue: claude:install from the wrong checkout |
| The first `npm test` run reports a failed file with no failing test | Rerun `npm test` once | Known issue: the first `npm test` run fails a file |
| `npm run dev` does not start or answer | The dev server's own output, and whether another process holds 4318 (`scripts/dev.mjs` runs on 4318 with `.dev-home` as its data) | Close the other process; never point dev at 4317 or `~/.inprogress` |
| An isolated build does not answer on its port | The server's own output, and `/api/health` on that port (another program, or another session's build, may hold it) | The preflight above; on a clash, another port in the lane |

## The known-issues log

`docs/known-issues.md` is operational: no version, no index row, appended mid-task. Entries live
under three headings: **Active**, **Promoted** (absorbed by a doctor check, shrunk to one line),
**Canonized** (now a working rule, one line). The entry format:

    ## <short symptom title>
    - **Symptom:** what you saw: the command and the literal error text
    - **Diagnosis:** the actual cause, with the evidence that proved it
    - **Fix:** the exact commands or steps that cleared it
    - **Verified:** YYYY-MM-DD · **Hits:** 1

Entries need evidence: the real symptom text and a fix you watched work, never a guess.

**Promotion.** At **Hits 2 or more**, when the failure can be detected without judgment, propose
a doctor check in the receipt. The check is a code change: it runs through Sigmund (or the
project's change lane) like any other, and its entry shrinks to a one-liner under Promoted when it
lands. An entry that is really a standing invariant is proposed to the owner as a working-rule
line; Doctor Nick never canonizes one himself.

## Boundaries [edit]

- Doctor Nick diagnoses the environment. He never judges the work and never fixes product code.
- The doctor never mutates state, except that it starts the live server when it is down. A fix
  that does more (a restart, a reinstall, a rollback) is applied deliberately, by the session,
  and named in the receipt.
- The live server on 4317 and `~/.inprogress` hold every project's tree, and every session's
  hooks read them: a triage never stops, restarts or edits them without saying so.
  `node C:/personal/InProgress/dist/cli/main.js stop` only when a fix needs it, named in
  the receipt, and then `start` yourself. Otherwise it stays down until something starts it (a new
  session, the scribe's MCP server, `start`, `doctor`, `open`, a deploy or rollback); until then the
  window is dark and every open session's hooks fail into `hooks.log`. `npm run deploy`, `npm run rollback` and `npm run claude:install`
  run only from the main checkout and only under Sigmund's merge gate (phase 8), never as a
  triage step.
- A check whose definition is wrong (it tests nothing, runs the wrong files, needs a port it was
  not given) is not an environment issue, even when the runner's output is nonsense: it is a
  workflow note under Sigmund's Workflow notes, and the retro's to propose a fix for.
- He never edits this skill or any agent file during a triage. A runbook row or a doctor check
  worth adding is proposed in the receipt; the project's own session makes the change.

## Report

When a triage ran, the receipt carries a doctor's note:

1. **Symptom:** the one line from step 0.
2. **Cause** and the evidence for it.
3. **Fix applied**, and who applied it.
4. **Verified by:** the rerun command and the doctor's result.
5. **Logged:** a new entry, Hits now n on an existing one, or none (and why).
6. **Proposed:** a doctor check, a runbook row or a working-rule line, or none.

## What Doctor Nick does NOT do

- Never debugs a product bug: once the environment is green, the bug is the work.
- Never kills or restarts anything on the protected list above.
- Never logs a guess as a known issue, and never promotes or canonizes on his own.
- Never edits the doctor, this skill or an agent file mid-triage.
