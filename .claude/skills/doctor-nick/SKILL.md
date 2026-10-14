---
name: doctor-nick
description: >-
  Doctor Nick triages a broken environment in this repo (InProgress): the dev server or stack
  won't start or won't answer, a deploy or rollback goes red, a check fails before it reaches the
  code (an install, a lock, a port, a path, a runner that reports nonsense), the preview is blank,
  or nobody knows what state the stack is in. Use him whenever you START verification against the
  running app (preview, screenshots for Parvati, integration or e2e runs), whenever you are BLOCKED
  by the environment rather than by a product bug, and at the WRAP-UP of any task that hit
  environment friction. Also triggers on "run doctor nick", "doctor", "the server won't start",
  "deploy is red", "why is the preview broken", "is the stack up". Do NOT use him for product bugs
  (that is systematic-debugging's lane), for judging the work (Murr, Parvati and Burt own that),
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
- **Automate:** the doctor, `node dist/cli/main.js doctor`, run from the main checkout
  (C:/personal/InProgress: from a worktree it checks that worktree's build and allow rules, not
  the installed ones). Read-only: it probes the known failure signatures, prints the exact fix,
  and exits non-zero on a blocking red. Its one write: when the live server is down it starts it
  first, and says so.
- **Law:** a standing environment invariant becomes a line in the project's working rules, on the
  owner's say-so only.

He runs inline, in the session that hit the problem. That session already holds the error text
and the state, and a dispatch would cost more than it saves, so he has no agent wrapper. A
subagent that hits the environment (Sev's checks, Parvati's build) stops and reports the doctor's
output; the main session runs the triage.

## Preflight [edit]

Before any preview, screenshot, browser, integration or e2e work, bring the environment up and
check it. Green before you start; never hand-build a parallel server.

Two modes, by what the work runs against:

- **The live install** (this session's hooks, the scribe, the window on 4317): from the main
  checkout, `node dist/cli/main.js doctor`. It checks, in order: Server, Token, Database, Hooks,
  Scribe agent, Skill, Allow rules, MCP server, and Edge (a warning only). Every line green, or
  its printed fix applied and the doctor rerun, before going on.
- **An isolated build** (Parvati, Sev on a UI plan, a hand-driven check of a branch): from the
  worktree, `node scripts/build-to.mjs .build`, then start `.build/dist/server/main.js` the way
  `test/e2e/start-server.mjs` does (`INPROGRESS_HOME` set to a scratch folder,
  `INPROGRESS_PORT` set to the lane port, `INPROGRESS_AGENT_WATCH_MS=500`), and confirm
  `GET http://127.0.0.1:<port>/api/health` answers with `"app":"inprogress"` before driving it.
  Ports 4400 to 4419 only (Parvati 4400 to 4409, Sev's e2e 4410 to 4419), never 4317 or 4399,
  and never `~/.inprogress`. `npm run test:e2e` does all of this itself on
  `INPROGRESS_E2E_PORT`.

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
| The doctor prints a ✗ line | The line itself | Its printed fix, then rerun the doctor |
| A session started with no InProgress briefing, or `tasks` says InProgress is not running | `node dist/cli/main.js status` from the main checkout, then the tail of `~/.inprogress/hooks.log` and `~/.inprogress/server.log` | Known issue: the server is not running when a hook fires |
| `EPERM`, `EBUSY` or `EACCES` on a rename, a folder move, an install or a deploy | What holds the handle: the live server (files under the main checkout's `node_modules`), an editor, a shell sitting in the folder, antivirus | Known issue: Windows file locks |
| `npm run deploy` or `npm run rollback` ends red | The last `▸` step it printed, and whether it printed "rolling back" | Known issue: a red deploy or rollback |
| `Cannot find module`, or a package missing, in a worktree | Does the worktree have its own `node_modules`? Each one here keeps its own; without it, Node resolves from the main checkout's, which follows main's `package.json`, not the branch's | `npm install` in the worktree |
| Hooks behave like an unmerged build, or the doctor's Hooks line says a hook script no longer exists | The hook paths in `~/.claude/settings.json`: each should start with `C:/personal/InProgress/dist/` | Known issue: claude:install from the wrong checkout |
| The first `npm test` run reports a failed file with no failing test | Rerun `npm test` once | Known issue: the first `npm test` run fails a file |
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
  `node dist/cli/main.js stop` only when a fix needs it, named in the receipt; the next hook or
  the doctor starts it again. `npm run deploy`, `npm run rollback` and `npm run claude:install`
  run only from the main checkout and only under Sigmund's merge gate (phase 8), never as a
  triage step.
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
