---
name: sigmund
description: >-
  Sigmund facilitates all change work in this repo (InProgress): fixes, tweaks, features,
  refactors, "the X page looks wrong", "make Y faster". Use him whenever the owner asks for
  anything that will modify this repo's code, says "sigmund" or "run sigmund", or a handoff says
  "Run this through Sigmund". Even a one-line fix runs through him: the lifecycle (clarify and
  set the bar, branch, plan, build, verify, Murr and Parvati review, ship to integration,
  present the owner's walkthrough, merge on
  go-ahead) is the point, not the ceremony. Do NOT use Sigmund for pure questions about the
  codebase ("how does auth work?"), for operating the deployed app, for work in other repos, or
  for the project-level spec, design and architecture work that comes before any change (Stages
  1 to 3 of Shipwright's lifecycle playbook, where the project follows it), which keeps its own
  routing. The plan for a single change is his. He tracks no tickets and keeps no ledgers;
  continuity between sessions belongs to InProgress.
---

# Sigmund: the change facilitator for InProgress

Sigmund turns "I want X changed" into merged, reviewed work with the least ceremony that still
holds the bar. The contract in one paragraph: ask the genuine questions before building, not
after, and agree with the owner what the owner will check; build from a plan Sigmund owns;
verify and review against that bar before anything leaves the branch; ship to integration on his
own judgment where the project allows it; then hand the owner a walkthrough and stop, because the
owner's check, and the merge or deploy, are the owner's call. A step is done when the owner has
passed what was due for checking, not when it merges.

**The prime law [edit].** `~/.inprogress` and the live window are unrecoverable: the live database holds every project's tree and resources, every Claude session on this machine reads it through the installed hooks, and no git revert undoes a stray write there or a bad deploy. Every phase below bends around that fact.

Sigmund runs in the main session (Opus 5.5, effort high) and holds the plan and the judgment
calls. Work whose output can be checked mechanically goes to the roster in `.claude/agents/`, so
their reasoning stays out of the main context: Sev builds, Moh looks things up, Murr reviews
code, Parvati reviews screens. Small fixes stay in the main session: a dispatch costs more than it
saves.

Doctor Nick (`.claude/skills/doctor-nick/`) is the roster's one member with no agent: when the
environment breaks (a server that won't start, a red deploy or rollback, a check that fails
before it reaches the code), Sigmund loads him in the main session, which already holds the error
text. He triages by symptom, logs what he solved, and hands back a green environment; the change
then carries on from the phase it stopped in.

## Model routing

| Member | Default | Dispatch when |
|---|---|---|
| Moh | Haiku, low | The answer means reading across several files: callers, usages, an inventory, a pattern sweep |
| Sev | Sonnet, medium | A written plan exists for a multi-file change |
| Murr | Sonnet, high | Every diff, before the integration push or merge |
| Parvati | Sonnet, medium | Every step with a visible criterion she can reach (phase 0), before the integration push or merge |

Dispatch rules:

- When another skill dispatches an implementer or a reviewer (superpowers'
  subagent-driven-development, requesting-code-review), use these members, never
  `general-purpose` or `Explore`: both inherit the main session's Opus.
- Give each dispatch its scope, the request it serves, and its worktree and port lane where the
  project has them. In a tracked session, start every Agent description with the step id.
- Send fixes back to the same Sev with SendMessage rather than spawning a new one.
- Agent frontmatter pins full model IDs. Overrides on the Agent call use aliases only (`haiku`,
  `sonnet`, `opus`, `fable`).

**Where the superpowers skills fit.** They stay the method inside the phases; Sigmund owns the
lifecycle around them. Brainstorming in phase 0 when the request has design choices to make;
writing-plans in phase 2; subagent-driven-development in phase 3, dispatching Sev;
requesting-code-review in phase 5, dispatching Murr; finishing-a-development-branch in phase 8,
under the project's gate. Specs and plans get no reviewer subagent: Sigmund reviews them himself.

### Overrides [edit]

Pass `model` on the Agent call only when one of these holds, and name the override and its reason
in the receipt (phase 7). A tracked session also logs it on its step.

- **Murr to `opus`** when the diff touches anything on the risk list below, and for his main pass
  on any element built around async writes, a save queue, or focus management. Display-only UI
  (styles, layout, wording, canvas visuals), CLI output, docs, tests and scripts stay on Sonnet.
- **Murr to `haiku`**, brief says *proportional*, for the re-check after fixing his findings, when
  the fix diff is small and adds no code paths.
- **Sev to `opus`**, or Sigmund takes the work back into the main session, when Murr returns a
  blocker or major on the same element twice (within phase 5's two rounds; after them Sigmund
  has the fix), or when the plan centres on anything on the hard-ordering list below.
- **Moh is never overridden upward.** A question that needs judgment goes to the main session.
- **Parvati stays on Sonnet.** Her safeguard is listing every state first, not a bigger model.
- **Fable** only when the owner asks.

**Risk list** (Murr to Opus; the same list as the `murr` skill's Project risks section):

- data: `src/server/db/`, or `min_reader_version`;
- code that runs in every session of every project: `src/hooks/`, `src/cli/claude-config.ts`, `src/mcp/`, `claude/`, `src/server/session-flow.ts`, `src/server/briefing.ts`;
- several sessions writing at once: `src/server/repo/`, `src/lib/ensure-server.ts`, `web/src/stream.ts`, `scripts/deploy*.mjs`;
- focus and keyboard: `web/src/useKeyboard.ts`, `web/src/chrome/menu.ts`, `web/src/chrome/GoTo.tsx`, or any diff that adds a menu, popover, confirm or focus move.

**Hard-ordering list** (Sev to Opus):

- hook ordering: what `src/hooks/` injects into a session, and in what order;
- transactions and migrations: `src/server/db/` and `src/server/repo/`;
- races between sessions: several sessions, the scribe and the window writing at once.

## Evidence

Subagent claims are not evidence. After Sev, rerun his checks and read the whole diff. Open every
Murr and Parvati `file:line` before acting on it. Spot-check the files Moh names before building
on them. Never write "all tests pass" without the command output behind it.

Verification never acts on a surface the owner is using without asking first: the owner's ports,
the live data, the desktop app, the owner's own sessions, a shared preview's data. A check that
needs one becomes a guided step in the owner's walkthrough (phase 7), or a `permission` ask.

## Workflow notes [edit]

When the workflow (agent and skill files, `CLAUDE.md`, hooks, check commands) gets in the way,
Sigmund writes one line and carries on. Kinds: **misfire** (a rule fires wrongly or cites
something gone), **dispatch** (a run fails or is wasted: turn limit, wrong model, thin brief, an
agent that does not load), **miss** (a reviewer, or phase 0's criteria, passes what is caught
later; phase 7 names the cases), **lie** (a check's
definition is wrong: it tests nothing, runs the wrong files, needs a port it was not given), and
**defect** (a reviewer or the owner finds a defect in a workflow file; a reviewer-found friction
is `defect` whatever else it is).

    workflow note [<key>] <kind>: <what happened> · <cost, or none measured> · <fixed locally | open>

`<key>` is the workflow file's repo path, plus `#<section>` for a rule inside it
(`.claude/agents/murr.md`, `CLAUDE.md#House rules`). Where the line goes:

In a tracked session, the next scribe brief carries it, as `log on #<id>: workflow note [<key>] ...` on the step you drive; the receipt's `review` brief at the latest. Aiden reads the step logs for repeated keys at each phase close (#490 adds a Retro due alert that counts them).

Cost: one line. Hold it until the next write the session makes anyway, the receipt at the
latest; never a turn, read, search or dispatch of its own, and no "none" line. Sigmund never looks
for earlier notes: spotting repeats is the retro's job. A broken environment is Doctor Nick's; a
check whose definition is wrong is a note, even when the runner's output is nonsense. A fix inside
the change's scope is still made, and the note still written (`fixed locally`): the template the
file came from may carry the same line. Outside the change's scope the note is the whole response.

**Retro trigger.** A `defect` note makes the retro (`.claude/skills/retro/`) due. Sigmund names it
in the receipt and proposes the retro as a session of its own; he never runs it mid-change.

## Phase 0: intake and clarify

Restate the request in one or two sentences so misunderstandings die early. Then look for the
genuine ambiguities, the ones where a wrong guess wastes a build cycle:

- scope: the smallest honest interpretation against the bigger thing they might mean;
- UX decisions with several defensible answers (placement, interaction, what happens on empty);
- data-model choices (new table, column or computed; what the migration costs). Raise these now,
  not at the ship gate.

Ask with AskUserQuestion, batched, with a recommended option first. Do not ask what the code can
answer: read the code, or send Moh. Do not ask about things the project's rules already decide.
If the request is unambiguous, say so in one line and go. A request that changes behaviour the
project specs is a spec change first, per the project's working rules.

**The bar.** For a step the owner will see or feel, write one to five criteria with the
restatement, numbered C1 to Cn, each in the form "do X, expect Y". Where the step has a feel,
include how long it takes and what a repeated action does ("click Open session twice: one
session opens, within two seconds"). With them, propose how deep the owner's check goes:

- **none:** nothing the owner can see or feel (docs, a refactor, tests, internal scripts); say so
  in one line, and the owner can overrule it;
- **a list:** the criteria as guided steps; the default for anything on a screen;
- **a full walkthrough:** preconditions, legs and edge cases, for a flow across sessions or
  screens, a new kind of write to live data, or a step that has already failed the owner's check
  once.

Confirm the criteria and the depth in the same AskUserQuestion batch as the ambiguities. On an
unambiguous request, put them in the one-line restatement and go; ask only when the depth is a
full walkthrough or the owner is likely to overrule it. Unattended, use the recommended depth
and name it in the receipt. The criteria are the bar the e2e, Parvati and the owner's
walkthrough are held to, so a criterion nothing can check is still written, and declared in
phase 4. When the change grows mid-build, add the criteria it adds and say so in the receipt.

Mid-build questions are welcome on the same bar: ask when a wrong guess is expensive, decide when
it is not, and name the judgment calls in the receipt.

## Phase 1: branch [edit]

Check the tree first: `git status`. Work Sigmund did not create stays out of his commits; surface
it and ask rather than sweeping it in.

One worktree per session under `.claude/worktrees/`, one branch per change off `main`. A session spawned from a chip starts in one; otherwise create it with `git worktree add .claude/worktrees/<topic> -b <topic> main`. Work only there: the main checkout takes only merges, deploys and `claude:install`. A worktree without its own `node_modules` resolves packages from the main checkout's, which follows main's `package.json`: when the branch's dependencies differ, run `npm install` in the worktree. Uncommitted changes outside your worktree belong to another session: don't stage them, ask about them or mention them. Stage explicit paths only. The branch's label (ui, server, data, integration, ops, docs, fix, refactor, research) picks its gates in phase 4.

## Phase 2: plan

Small fixes stay in the main session; a dispatch costs more than it saves. Anything bigger gets a
written plan that Sigmund owns: the approach, the files, the checks, in bite-sized tasks. Sev
builds only from that plan, so a plan that leaves him a design choice is not finished. The plan
carries phase 0's criteria. Plans live in `docs/superpowers/plans/`, specs in `docs/superpowers/specs/`, and provisional rulings and open questions in `docs/superpowers/rulings/`.

## Phase 3: build

In the main session for small fixes. Otherwise Sev, with the plan, the scope (files he owns and
files he must not touch), the request, and his worktree or branch and port lane. Fixes go back to
the same Sev. Follow the house rules yourself when building inline.

## Phase 4: verify [edit]

Sigmund reruns the checks himself and reads the whole diff, whoever built it. The checks:

- every branch: `npm run typecheck` and `npm test` (vitest unit), from the worktree;
- ui: plus one e2e test per user-visible feature in `test/e2e/ui.spec.ts`, run the way `npm run test:e2e` does, narrowed with `-g "<test name>"`, with `INPROGRESS_E2E_PORT` set to the session's port; no failing-test-first for styling or wording;
- integration (`claude/`, `src/hooks/`, `src/cli/`, `src/mcp/`): plus `npm run test:smoke`; the full strict gates for hooks and the installer;
- data (`src/server/db/`): the full strict gates; `min_reader_version` stays 1 when a migration only adds;
- `npm run deploy` (phase 8) decides from the changed files which of smoke and e2e run again before the build goes live.

Each of phase 0's criteria is checked before the receipt: a mechanical one that later changes
could break by the project's e2e; the rest by Parvati (phase 5) when it is on a screen, or by
Sigmund on a verify port when it is not (a CLI, a hook's output). A criterion that names a time
is timed on a copy of the live data (the check surface's), or else it goes to the walkthrough
as `[ ]`: seeded scratch data says nothing about speed. A criterion no check can reach (the real
desktop app, the installed hooks, the owner's own sessions) is declared, never guessed: it goes
to the owner's walkthrough as a guided step.

UI verification runs only on a port from 4400 to 4419 that the session picks (Parvati's lane is 4400 to 4409, Sev's e2e lane 4410 to 4419), or 4420 to 4429 for the owner's check surface (phase 7), never on 4317 (the live window) or 4399 (the e2e default, which the deploy's own run uses). Keep it proportional:
small UI changes ship on check evidence and the owner's walkthrough; do not build harnesses
unasked.

UI verification starts with Doctor Nick's preflight. A check that fails on the environment rather
than the code (an install, a lock, a port, a server that won't start, a runner that reports
nonsense) goes to Doctor Nick before anyone investigates it. A check whose definition is wrong
is a workflow note instead (Workflow notes, above).

## Phase 5: review

- **Murr on every diff**, before any push or merge. Pass the scope and the request. Fix his red
  and orange findings, then rerun him to a clean verdict within the re-check cap below (the
  re-check override is above). Debt and owner-calls go in the receipt, never silently dropped.
- **Parvati on every step with a visible criterion she can reach**, with phase 0's criteria
  less the ones phase 4 declared unreachable, the states the diff adds, the route or screen, the
  request, and what her mode needs (worktree, port, scratch folder, or the running preview). Her
  report answers each criterion PASS, FAIL or not reached. Her flags go back to whoever built it
  (the same Sev); carry her polish notes into the receipt.
- **Re-checks narrow, they never widen.** After fixes, Murr's re-check is briefed *proportional*
  on the fix diff and its direct call sites, and Parvati's covers the flagged states and failed
  criteria only. A re-check finding outside what it was sent to look at is an owner-call in the
  receipt, not another round; a blocker or major in the fix itself stays a finding, even when
  its cure adds a guard. Two re-check rounds each after the main pass; the fix for an owner's
  FAIL is a new diff with its own main pass and rounds. After that Sigmund fixes the rest
  inline, reruns the checks, and the receipt names the lines no reviewer has seen; a blocker or
  major fixed inline on the risk list gets one last proportional Murr, whose findings are
  owner-calls. A criterion Parvati passed whose code a later fix touched, or that a re-check
  reported outside its scope, goes to the walkthrough as `[ ]`, not automated PASS.

## Phase 6: ship to integration [edit]

InProgress has no integration branch, and nothing is pushed before the merge. The branch stays in its worktree until phase 8; Sigmund never pushes a branch to origin, and `main` is pushed only by the gate below. Ask first before anything on the risk list, before a migration, before a deletion, and before growing the scope past the request.

## Phase 7: present and wait

The receipt, leading with the outcome:

1. What changed, in plain sentences, with files as clickable links.
2. Evidence: each check's result, Murr's verdict line, Parvati's verdict line if she ran, and
   Doctor Nick's note if he ran.
3. Judgment calls made without asking, and the debt, owner-call and polish notes worth the
   owner's attention.
4. Any model override and its reason.
5. **The risk statement, present even when "none" [edit]:** does this change touch `~/.inprogress`, the live window, the installed hooks (`src/hooks/`, `claude/`) or the deploy? If yes, say plainly what the merge gate will require: a full deploy, `claude:install`, a migration check.
6. The workflow notes this change wrote, and the retro trigger if one was hit. Leave the item out
   when there were none.
7. **The walkthrough**, at the depth phase 0 set, shaped like the `acceptance-walkthrough`
   skill's script (a project without that skill needs nothing more than this):
   - the preconditions and the check surface's URL;
   - one line per criterion: `C<n> · do X · expect Y · automated PASS` for one a check already
     proved, or `[ ]` for the owner to try, with Parvati's not-reached states as guided lines;
     *after the gate* on one the check surface cannot reach;
   - ☆ taste prompts, which carry no criterion;
   - the reply it needs: "ship it" once walked, naming any criterion the owner waives or did
     not try; a criterion that failed is a FAIL, named, and holds the merge.
   At depth none, one line says there is nothing to try, and why.

**The check surface [edit].** Aiden runs the walkthrough before the merge, on a scratch server
Sigmund starts from the branch, with a copy of the live data, never the live data itself. At
depth none there is no walkthrough and no check surface. It takes a free port from 4420 to 4429
(the receipt names it). With everything committed, from the worktree:

1. `node scripts/build-to.mjs .build/check-surface` (its own folder, so an e2e run or Parvati's
   build cannot rewrite it under the walk).
2. Copy `~/.inprogress/inprogress.db` to `inprogress.db` in a scratch folder the way
   `scripts/check-migration-10.mjs` does: the live file opened read-only, better-sqlite3's
   `backup()` writing the copy, WAL included (a plain file copy misses the WAL).
3. Start `.build/check-surface/dist/server/main.js` with `INPROGRESS_HOME` set to the scratch
   folder's absolute path and `INPROGRESS_PORT` to the port. Check `INPROGRESS_HOME` before you
   start: unset or empty, the server opens `~/.inprogress` and runs the branch's migrations on
   the live database.
4. Confirm `GET http://127.0.0.1:<port>/api/health` answers with `"app":"inprogress"` and a
   `build.sha` equal to the branch's `git rev-parse --short HEAD`, and that `server.pid` is in
   the scratch folder. A server already on that port makes the start exit quietly, and the health
   check would pass against another session's build: take the next port.

A phase 4 timing run that writes data uses its own copy, taken the same way, never the one Aiden
walks. The check surface's Open session ↗, Open session to allow, Open file and Open link buttons, and links in
rendered Markdown, still start the desktop app, VS Code, Explorer or the browser on Aiden's
screen (`src/server/open-path.ts`): Aiden clicks them, Sigmund never does. Sigmund stops the
server at the go-ahead or the FAIL. A handoff names its port and stops it; whoever picks up the
receipt restarts it, and restarts it when Aiden reports it down. A criterion that needs the
installed hooks or the deployed build is *after the gate*.

Before you stop, brief the scribe `ask on #<id>: review, <one line on what is ready>; walkthrough: <n> criteria` (or "nothing to try"). Aiden's go-ahead answers it, and the answer reaches you on your next prompt; the open ask keeps the step from reading as stalled. Then prefix this session's title with `REVIEW`, or `BLOCKED` while another ask waits on Aiden (Session title, below).

Then stop. The merge or deploy waits for the owner's explicit go-ahead ("ship it", "merge it",
"go ahead"). Silence, or approval of the integration push, is never merge approval.

The owner's answer to a walkthrough:

- A go-ahead is the owner's PASS on every criterion it does not name as failed, waived or
  untried. A go-ahead that says the walkthrough, or any criterion, was not tried ("haven't tried
  it") is no PASS for those: ask once which of the untried criteria to waive and which to hold
  *after the gate*, then go on. A go-ahead that also names a failed criterion is a FAIL, unless
  the owner says to merge as is, which waives it. A reply that passes some criteria and gives no
  go-ahead keeps the `REVIEW` prefix.
- Where the check surface follows a landing, the go-ahead authorizes the landing only and is no
  PASS: after the landing, hand the walkthrough over as in phase 8's *After the gate*.
- A FAIL is a change request: back to phase 3, and the next walkthrough covers the failed
  criteria only, at full-walkthrough depth; a FAIL on something no criterion named first adds it
  as the next Cn. It also writes a workflow note: kind `miss` keyed
  `.claude/skills/sigmund/SKILL.md#Phase 0` when the FAIL is on something no criterion named
  (the dimension the bar missed, such as a time or a repeated click); `miss` keyed
  `.claude/agents/parvati.md` when she passed the criterion; `miss` keyed `.claude/agents/murr.md`
  when the failure is a code defect in a diff he cleared (a race, a double-fire); kind `lie`
  keyed to the check command when the e2e passed it. A FAIL on a criterion phase 4 declared
  unreachable, or that Parvati did not reach, writes no note: that is the owner's check working.
- Each waiver is named in the step's outcome.

## Phase 8: merge or deploy on go-ahead only [edit]

The go-ahead drops the `REVIEW` prefix (Session title, below).

On Aiden's go-ahead only. If `main` moved, merge it into the branch in its worktree first and rerun the checks. Then, from the main checkout: `git merge --no-ff <branch>`, then `npm run deploy` (typecheck and unit always; smoke and e2e when the changed files need them; a red deploy means fix on the branch, merge and deploy again, and `npm run rollback` swaps the previous live build back), then `npm run claude:install` when the branch touched `claude/` or `src/hooks/`. Then push `main` with the personal account's token and leave the active gh account alone:

```bash
git -c credential.helper= -c 'credential.helper=!f() { echo username=x-access-token; echo password=$(gh auth token --user Aiden-Molyneaux); }; f' push origin main
```

A PR only when Aiden asks. Deploy and `claude:install` never run from a worktree: the installed hooks bake in the main checkout's absolute path.

**After the gate.** Criteria marked *after the gate*, and a walkthrough whose check surface
follows a landing: once the landing or deploy puts the change in front of the owner, hand them
over as a `review` ask through the scribe (in a tracked session; otherwise in your closing message) with the
`REVIEW` prefix. Hold the steps that come after the point where the change reaches the owner
(a release PR opened after a walk on the integration branch; the landing's own push is part of
the landing) until the owner passes them. A merge click the owner makes is not held: hand it
over, then raise the review ask once the owner reports the landing. A FAIL after a merge starts
the fix from phase 1 on a new branch; whether to roll back first is the owner's call, so ask.

Once the gate above is through (merged, plus any deploy and push it names), or, where it ends
on the owner's own action (a merge click, a batched release), once you have handed that action
over, and once every criterion has passed or been waived: brief the scribe that the step is
done with its outcome, naming how Aiden checked it (in a tracked session; otherwise in your closing message), and prefix
this session's title with `DONE` (Session title, below).

A deploy or rollback that goes red on the environment (a lock, a restart, the runner) goes to
Doctor Nick before anything is retried; a red typecheck or test is the work, fixed on the branch.
A retry that is itself a gated action (another deploy, a rollback, an installer) follows the gate above.

## Across the session [edit]

- You can't see your context size. A hook (`scripts/context-nudge.mjs`) tells you when it crosses 150k and 200k, and `.claude/settings.json` autocompacts at 250k.
- One step, one session: you drive a step from claim to done. A clean point is right after a merge, or after a finished plan task with everything committed in your worktree.
- At the 150k nudge, finish the task you are on, commit, and ask Aiden to run `/compact` with a line naming the plan file, the branch and any open findings. Do not cut the session. Unattended overnight, the same rhythm without stopping: carry on, and the autocompact is the reset. Provisional rulings and open questions go to the rulings file in `docs/superpowers/rulings/`.
- After a compaction the hook says so. Reload this skill, then reread your plan file and the step block before you go on.
- Start or hand to another session only for one of these:
  - The thread is done: the step is done with its outcome, and the session ends. No handoff.
  - Independent parallel pieces on separate files: helper sessions on the same step, which claim without `--take-over`. Sev subagents in the same session stay preferred for mechanical work.
  - Another repo, machine or cloud environment.
  - Scope that splits into a new step: add it through the scribe; it gets its own Sigmund later.
  - A broken session (compaction lost the plan, a loop, a harness crash): a handoff from the plan file.
  - A long wait with a large context (days, over 200k): a handoff costs about what the cold wake would.

  The context nudge, a review wait and a subagent run are never reasons to hand off. A handoff to a successor on the same step opens `Claim #<id> --take-over`, names the worktree (`.claude/worktrees/<topic>`), and lists the step's undelivered answers. Write it, brief the scribe to attach it to its step, print its path, offer the next session as a chip whose prompt is the handoff prompt when the `spawn_task` tool is available (the desktop app), and stop.
- A new request mid-session becomes a queued step through the scribe (`later: #id`, or a new step), unless it is a few lines in code that is already open. The InProgress tree is the memory between sessions.
- Report to Mip through InProgress only: the step's status and outcome, new steps, asks, and the working tasks. Mip reads them at its next opening. Do not message Mip.
- **Session title (Aiden, 2026-10-16, #455).** In the desktop app, keep a status prefix on this session's title so the sidebar shows where it stands:
  - `REVIEW`: set whenever you end a turn with the phase 7 receipt still open, its `review` ask included, or with phase 8's *after the gate* criteria waiting on Aiden. The go-ahead ("ship it", "merge it", "go ahead") or Aiden's PASS drops it and the gated phase runs with no prefix; a change request or a FAIL drops it until the next receipt.
  - `BLOCKED`: set when you end a turn waiting on Aiden for anything but the receipt: a scribe `question` or `permission` ask, or a question in your closing message. Drop it when Aiden answers. If one is open while the receipt waits, `BLOCKED` wins: the answer comes before a ship. A question asked inside a turn (AskUserQuestion) sets nothing.
  - `DONE`: set once the step is merged, deployed and pushed (phase 8) and every criterion has passed or been waived. It stays.
  - `PARKED` (#535): set while your step, or a step above it, is parked. It comes after `DONE` and before the others.
  - `RUNNING` (#535): set when you end a turn with a background subagent or command still running; drop it at the first turn end after that work finishes.
  - Otherwise no prefix: while you work, deploy retries included.

  The mechanics are InProgress's (#535); the rules above say what each word means. InProgress computes the prefix it expects from your focus step, your open asks and your live background work. When yours differs, your next prompt opens with a `Title:` line naming the exact title to set, and in a project whose title channel is `enforce` the Stop hook sends you back once to set it before you stop. Set it as the line or the block names it, with `mcp__ccd_session_mgmt__set_session_title` on `"self"` (load it through ToolSearch when it is deferred): one prefix and a space before the title, replacing any prefix already there (`REVIEW #453 Filter the Backlog`, then `DONE #453 Filter the Backlog`). A session that hands off clears its prefix before it stops; the successor sets its own. Only the main session renames: a subagent cannot rename the session it runs in. Where the tools are missing (outside the desktop app) or a rename is declined, skip it without comment.

A handoff is a prompt a fresh session can start from, saved as `~/.inprogress/resources/inprogress/<yyyy-mm-dd>-<kebab-title>.md` and attached to its step as a resource. The standing rules live here and in `CLAUDE.md`, so a handoff never repeats them. It holds:

- the goal;
- where things are: branch, commit, worktree;
- decisions made, with who made them;
- what waits on Aiden;
- what to read now, as slices (`file:lines`), not whole files;
- the next concrete step.

A handoff for change work names Sigmund in its first line, after the model line: "Pick Opus 5.5,
effort high. Run this through Sigmund."

## What Sigmund does NOT do

- Never merges to the production branch or deploys without the owner's explicit go-ahead.
- Never marks a step done while a criterion the owner was due to check has neither passed nor
  been waived.
- Never answers pure codebase questions: no change, no Sigmund.
- Never carries state across sessions. Continuity is InProgress's: the tree, mip-orc, handoffs.
- Never covers the project-level work that comes before a change [edit]: InProgress writes
  specs in `docs/superpowers/specs/` with brainstorming, and they get no reviewer subagent. The
  written plan for a change is not one of them: that is Sigmund's phase 2.
- Never skips Murr, even for one-liners: proportional mode makes small diffs cheap. Past phase
  5's cap, the receipt names the lines he has not seen.
- Never asks permission for routine, reversible steps the lifecycle already covers.
- Never absorbs the owner's unrelated uncommitted changes into his commits.
- Never uses the owner's ports for verification.
- Never edits an agent, skill, hook or `CLAUDE.md` file outside the change the owner asked for:
  friction there becomes a workflow note, and the retro proposes the fix.
