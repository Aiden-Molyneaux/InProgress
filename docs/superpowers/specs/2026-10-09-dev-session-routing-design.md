# Dev-session routing for InProgress: design

2026-10-09 · step #290 (under #288) · brought over from InThink's routing pilot (inthink-marathon-v3 #273)

## Goal

Cut the cost of InProgress dev sessions without losing quality, with a setup every session follows without being told. The main session (Opus) keeps the plan and the judgment calls. Work whose output can be checked mechanically goes to cheaper subagents, so their reasoning stays out of the main context. Sessions stay small and hand over to fresh ones.

Success is measured on the pilot (#228) against the baseline:

- average main-session context per request at or below 150k (baseline 480k);
- cold cache re-writes under 10% of cost (baseline 26%);
- subagent cost mostly Sonnet and Haiku (baseline: all Opus);
- $ per 1k lines landed on main below $10.90 (noisy, so read with the other three);
- quality holds: reviewers catch the majors before merge, and Aiden asks for no more changes after review than before.

## Baseline

r105 on #289 (`~/.inprogress/resources/inprogress/2026-10-09-dev-session-cost-baseline.md`). Eight sessions up to 2026-10-09 cost $310.27 at API list rates over 2,775 requests, while 28,470 lines landed on main ($10.90 per 1k). The main session is 63% of cost at 480k average context: Opus 5.5 runs on its native 1M window, and 1541ab7a peaked at 965k. Cache reads and writes are 91% of all cost. Eighteen cold re-writes (a whole context written to cache again after an idle gap past the 1-hour TTL, a model switch or a compaction) cost $79.24, 26%; fourteen were in 1541ab7a. Subagents are 36%, all on Opus, because `general-purpose` inherits the main model.

## Decisions (Aiden, 2026-10-09)

1. Claude cuts sessions and hands over a prompt for the next one, as in InThink. A session may cover a suite of related features; new requests mid-session must not derail it; parallel sessions must not trip over each other's work. Unattended overnight runs still happen.
2. The design-reviewer is retired. The main session reviews its own specs and plans.
3. UI branches get a screen reviewer.
4. The routing rules live in a root `CLAUDE.md`, with a context-size nudge hook (approach A, chosen over a skill each session loads and over rules carried in each handoff).
5. This setup lands as a PR on a new private GitHub repo, `InProgress`, on Aiden's personal account. After that, branches keep merging locally after a green deploy and main is pushed after each merge. A PR happens only when Aiden asks for one.
6. The pilot is #228, Show background work.

## 1. Agents

Files in `.claude/agents/`. Frontmatter pins full model ids; an override at dispatch passes an alias.

| Agent | model | effort | tools | omitClaudeMd |
|---|---|---|---|---|
| `explorer` | `claude-haiku-5-5` | low | Read, Glob, Grep | true |
| `implementer` | `claude-sonnet-5-5` | medium | Read, Write, Edit, Glob, Grep, Bash, PowerShell | false |
| `code-reviewer` | `claude-sonnet-5-5` | high | Read, Glob, Grep, Bash | false |
| `screen-reviewer` | `claude-sonnet-5-5` | medium | Read, Glob, Grep, Bash, PowerShell | true |

**explorer.** Answers one lookup question that means reading across several files: callers, where something is used, an inventory. Every claim carries a `file:line` and, where it helps, a one-line quote. It ends with what it searched and did not find. It never edits, suggests fixes or judges quality. It skips CLAUDE.md because none of the routing rules apply to it.

**implementer.** Builds one branch from a written plan, in the worktree its brief names. It reads the files the plan names and the call sites of anything it changes. It builds what the plan says, and stops to report when the plan is ambiguous, contradicts the code, or needs something it does not mention: a dependency, a migration, a deletion. It runs the checks the plan names and makes two honest attempts at a failure before reporting it with output. It never commits, merges, pushes, deploys, stashes, resets or checks out, never runs `claude:install` or `claude:uninstall`, and never touches `~/.inprogress` or the live server. Its report: status (DONE or BLOCKED), files changed, each check with pass or fail and the last 30 lines of any failure verbatim, deviations from the plan, open questions. Fixes go back to the same implementer with SendMessage.

**code-reviewer.** Reviews a branch's diff before merge. The brief gives the scope (a diff range) and the request the change serves; without them it uses `git diff main...HEAD` in its worktree and says the request was missing. Read-only: Bash runs only read-only git commands and the existing test suites. Bugs come first, checked against InProgress's own risks:

- the hooks and the installer run in every session of every project: a slow or failing hook must never block a session;
- migrations are append-only, and an additive one keeps `min_reader_version` at 1;
- several sessions and the scribe write at once: transactions, ordering, idempotence;
- Windows paths, shells and process spawning;
- errors name their cause and are never swallowed;
- no em dashes in tracked text;
- a test must be able to fail.

On a UI diff it first lists every interactive state the diff adds or changes (menus, popovers, confirms, dialogs, focus return after close, the keyboard-only path) and checks each one in the code. Findings are ranked Blocker, Major or Minor, each with `file:line`, a concrete failure scenario and a fix. When the brief says *proportional*, it reviews only the changed lines and their direct callers.

**screen-reviewer.** Checks a UI branch in a running build. It builds `.build` in the worktree (`node scripts/build-to.mjs .build`), starts `.build/dist/server/main.js` with `INPROGRESS_HOME` in a scratch directory and `INPROGRESS_PORT` in 4400 to 4409, seeds what the change needs through that instance's API or CLI, and drives it with Playwright from a scratch script. Before driving anything it lists, from the diff, every state the change adds: each menu, popover, confirm and dialog, the keyboard-only path, focus after close. Then it opens each one, with screenshots at 520x900 (the e2e viewport) and 1440x900. Each state is reported as checked, with its screenshot path, or as not reached, with the reason. It never touches `~/.inprogress`, the live window's port or the repo's `dist/`, and stops every server it starts.

`.claude/agents/design-reviewer.md` is deleted. `inprogress-scribe` belongs to the product and stays as installed.

## 2. Root CLAUDE.md

About 80 lines, written for the main session; its first line tells subagents that the routing sections are not theirs. It holds:

- **Roles.** The main session clarifies, writes and self-reviews specs and plans, reads diffs, decides fixes, merges, deploys and reports. Lookups go to `explorer`, so file dumps stay out of the main context. Small fixes stay in the main session; a dispatch costs more than it saves.
- **The routing table**, with when to dispatch each agent.
- **Superpowers.** When a superpowers skill (subagent-driven-development, requesting-code-review) dispatches an implementer or a reviewer, it uses these agents, never `general-purpose`, which inherits Opus. Specs and plans get no reviewer subagent.
- **The overrides** (section 3).
- **Evidence.** Subagent claims are not evidence. After an implementer, rerun its checks and read the diff. Open each finding's `file:line` before fixing it. Spot-check explorer references before building on them.
- **Session rhythm, worktrees and handoffs** (section 4).
- **Pointers, not copies.** The test gates by label are in the InProgress playbook. No em dashes (`test/repo/no-em-dash.test.ts`). Deploy and `claude:install` run only from the main checkout.

## 3. Overrides

Pass `model` (and `effort` if needed) on the Agent call only when one of these holds, and record the override and its reason in the handoff's pilot log.

- **code-reviewer to `opus`** when the diff touches:
  - data: `src/server/db/`, or `min_reader_version`;
  - code that runs in every session of every project: `src/hooks/`, `src/cli/claude-config.ts`, `src/mcp/`, `claude/`, `src/server/session-flow.ts`, `src/server/briefing.ts`;
  - several sessions writing at once: `src/server/repo/`, `src/lib/ensure-server.ts`, `web/src/stream.ts`, `scripts/deploy*.mjs`;
  - focus and keyboard: `web/src/useKeyboard.ts`, `web/src/chrome/menu.ts`, `web/src/chrome/GoTo.tsx`, or any diff that adds a menu, popover, confirm or focus move. In InThink's pilot, Sonnet passed a diff in which Opus found keyboard focus dropping to the body.

  Display-only UI (styles, layout, wording, canvas visuals), CLI output, docs, tests and scripts stay on Sonnet.
- **code-reviewer to `haiku`**, with *proportional* in the brief, for the re-check after fixing its findings, when the fix diff is small and adds no code paths.
- **implementer to `opus`**, or the work comes back to the main session, when the code-reviewer returns a blocker or major on the same branch twice, or when the plan centres on hook ordering, transactions and migrations, or races between sessions.
- **explorer is never overridden upward.** A question that needs judgment goes to the main session.
- **screen-reviewer is not overridden.** Its safeguard is listing every state first, not a bigger model.
- **Fable** only when Aiden asks.

## 4. Session rhythm

**Window.** Opus 5.5 runs with a native 1M window, and `opus[1m]` changes nothing, so the cap comes from settings. The committed `.claude/settings.json` sets `"autoCompactWindow": 200000`. The docs show this key in user settings and do not say whether project settings honour it, so the first pilot session checks with `/context`. If project scope does not take, the fallback is `"env": { "CLAUDE_CODE_DISABLE_1M_CONTEXT": "1" }` in the same file, which makes Claude Code treat the model as a 200K one.

**Nudge hook.** `scripts/context-nudge.mjs`, registered in `.claude/settings.json` on `PostToolBatch` (once per batch of tool calls, before the next model call), as `node "$CLAUDE_PROJECT_DIR/scripts/context-nudge.mjs"`. It reads the hook input from stdin and:

- exits silently when the input has `agent_id` (a subagent);
- reads the last 512 KB of `transcript_path` and finds the last two assistant messages with usage, by message id; a message's context is input plus cache read plus cache creation tokens;
- when the newer one crosses 120k or 160k and the older one is below that line, prints `hookSpecificOutput.additionalContext` with one line: at 120k, "Context is about 120k. Finish what you're on; at the next clean point, write the handoff and cut the session."; at 160k, the same with "cut the session now at the next clean point";
- otherwise prints nothing.

It always exits 0, and any error (unreadable transcript, bad JSON) is silence. The transcript is written asynchronously and may lag one request; for a size estimate that does not matter. After a compaction the context drops, and the nudge can fire again when it climbs back.

**One thread per session.** A thread is a feature, or a suite of related features that share code. A clean point is right after a merge, or after a finished plan task with everything committed in the worktree. The session cuts when its thread is done, when the next queued item is unrelated, or when the nudge says so. At a cut it writes the handoff, attaches it through the scribe, offers the next session as a one-click chip (`spawn_task`, whose prompt is the handoff prompt), prints the handoff's path as well, and stops.

**New requests mid-session** become a queued step through the scribe (`later: #id`, or a new step), unless they are a few lines in code that is already open. The InProgress tree is the memory between sessions, and the next session's briefing shows the queue.

**One worktree per session.** A session works only in its own worktree under `.claude/worktrees/`. A session spawned from a chip already starts in one; any other session creates its own (`git worktree add .claude/worktrees/<topic> -b <topic> main`). The main checkout takes only merges and deploys. The v1 ruling about absolute hook paths (rulings 2026-09-27, item 1) concerns only `claude:install` and deploy, which stay in the main checkout. Uncommitted changes outside a session's own worktree belong to another session: it does not stage them, ask about them or mention them. Stage explicit paths only.

**Overnight.** Same rhythm without stopping. At each clean point the session writes the handoff, so a compaction or a crash loses nothing, then takes the next queued item. Compaction at 200k is the reset. Provisional rulings and open questions go to the rulings file, as today.

**Handoff.** InThink's shape, shorter, because the standing rules live in CLAUDE.md:

- goal;
- where things are: branch, commit, worktree;
- decisions;
- waiting on Aiden;
- read now: slices, not whole files;
- the next concrete step;
- the pilot log, while the pilot runs.

It is saved as `~/.inprogress/resources/inprogress/<yyyy-mm-dd>-<kebab-title>.md` and attached to its step as a resource.

## 5. Measurement: `scripts/session-cost.mjs`

Prices InProgress dev work from Claude Code's own transcripts. It is read-only: it scans every `~/.claude/projects/C--personal-InProgress*` directory (the repo, its worktrees, `.live-check`), main transcripts plus their `subagents/` files and meta, and runs read-only git commands.

- **Prices** are API list rates from the claude-api skill (cached 2026-10-06). Cache writes are 1.25x input for 5 minutes and 2x for 1 hour. Cache reads vary by model: Opus 5.5 0.05x, Fable 5.1 0.025x, most others 0.1x. Haiku 5.5 switches to its higher rate card on prompts over 100K. Unknown models are listed as unpriced, never guessed.
- **Requests** are keyed by message id, and the last transcript line for an id carries the final usage.
- **Attribution.** `gitBranch` says `main` for nearly all baseline work, because sessions edit worktrees by path. Walking a transcript in order, the current branch switches when a line's `gitBranch` is a feature branch, when a tool call touches `.claude/worktrees/<name>`, or when a command creates a branch (`checkout -b`, `switch -c`, `worktree add -b`). A `git merge` run in the main checkout ends the branch, so what follows is `(main)` (planning, landing and chat) until the next marker. A worktree name maps to its branch through `git worktree list`, `worktree add` commands seen in transcripts, and subagent meta files (an isolated agent's worktree is labelled with its dispatch description, which starts with the step id). A subagent starts on the branch its dispatcher was on when it issued the Agent call.
- **Cold re-writes**: a main-session request with a prompt of 50k or more that writes at least half of it to cache.
- **Lines landed**: lines added plus deleted by each commit on main's first-parent line against its first parent, lockfiles excluded. A session is credited with what landed while it ran; a branch with its merges; `(main)` with direct commits.
- **Modes**: `--by=branch` (default) or `--by=session`, filtered with `--since=`, `--sessions=` and `--exclude=` (id prefixes). The all-in line is the same in both modes.

For testing, the pure parts move to `scripts/session-cost-lib.mjs`, with types in `scripts/session-cost-lib.d.mts`, following `deploy-lib`. `session-cost.mjs` keeps the file system, git and printing.

## 6. Pilot and calibration

The pilot starts once the setup has merged, because sessions read `CLAUDE.md` and `.claude/` from main. This session's last act is the first pilot handoff, for #228.

Each handoff carries a **pilot log**: session ids and what each did, each session's cost from `node scripts/session-cost.mjs --by=session --sessions=<ids>`, implementer fix rounds, code-reviewer blockers and majors with the model that found them, screen-reviewer flags and the states it could not reach, overrides used and why, and the changes Aiden asks for after review.

**Calibration, once:** on the pilot's first reviewable diff, `code-reviewer` runs twice on the same diff, at its default (Sonnet) and with `model: opus`. Both finding lists go side by side in the pilot log; the union is fixed. The report on #292 compares the pilot with the baseline on the success measures above.

## 7. Landing

1. Before the first push, scan the whole history for secrets: token patterns (GitHub, Anthropic, Slack, AWS), private keys, `.env` files, database files and anything over 5 MB. Anything found stops the push and goes to Aiden.
2. Create the private repo `InProgress` on Aiden's personal account (`GH_TOKEN=$(gh auth token --user Aiden-Molyneaux) gh repo create ...`), add it as `origin`, and push `main` and `dev-routing` only.
3. Open the PR from `dev-routing` to `main`. Its title and body go through the humanizer skill in a subagent first.
4. Stop for Aiden's merge.
5. After the merge: fast-forward the local main from `origin`, run `npm run deploy` from the main checkout, and have the scribe update the playbook: "merged locally after a green `npm run deploy`, then main is pushed; a PR only when Aiden asks."

## Platform facts relied on

| Fact | Source |
|---|---|
| Opus 4.7 and later run a native 1M window; `opus[1m]` has no effect on them; they compact at about 967K by default | code.claude.com/docs/en/model-config |
| `"autoCompactWindow": 200000` sets the compaction window for every model, in a settings file | code.claude.com/docs/en/model-config |
| `CLAUDE_CODE_DISABLE_1M_CONTEXT=1`, in the shell or a settings file, holds 1M models to a 200K window | code.claude.com/docs/en/model-config |
| `PostToolBatch` fires after a batch of parallel tool calls resolves, before the next model call, and supports `additionalContext` | code.claude.com/docs/en/hooks |
| Hook input carries `transcript_path` and `session_id`; `agent_id` is present only inside a subagent; settings hooks also fire inside subagents | code.claude.com/docs/en/hooks |
| Subagent frontmatter accepts full model ids, `effort` and `omitClaudeMd`; subagents load CLAUDE.md by default | code.claude.com/docs/en/sub-agents |
| The main session caches for 1 hour on a subscription; subagents for 5 minutes | code.claude.com/docs/en/prompt-caching |
| List prices and cache multipliers per model | claude-api skill, `shared/models.md:79,85,87`, `shared/prompt-caching.md:144` |

## Testing

The label is ops: typecheck and unit.

- **`test/scripts/session-cost-lib.test.ts`:**
  - price math, including both cache-write durations and Haiku 5.5's long-prompt card;
  - last-line-wins usage per message id;
  - attribution:
    - `gitBranch`, a worktree path and a created branch each switch it;
    - a merge in the main checkout resets it, and a merge inside a worktree does not;
    - it carries forward between markers;
    - a subagent inherits its dispatcher's branch;
    - an isolated agent's worktree takes its description;
    - a trailing dot and a glob prefix resolve;
  - cold re-write detection;
  - lines credited by session window and by branch.
- **`test/scripts/context-nudge.test.ts`**, running the script as a child process on fixture transcripts:
  - each threshold fires once, on the crossing;
  - silence below the thresholds, after a drop, inside a subagent, with no usage, or with a partial last line;
  - exit 0 on unreadable input.
- **`test/repo/agents.test.ts`:** every `.claude/agents/*.md` has a name and a description, pins a full model id (`claude-...`, never an alias), and sets `effort`.
- The existing em-dash guard covers every new file.
- **Manual:**
  - run the cost script against the baseline and match r105;
  - feed the nudge hook a real transcript past 120k and read its output;
  - the first pilot session confirms the 200k window with `/context`.

## Out of scope

- The scribe's model and the size of the briefing the hooks inject. Both apply to every project, so they are product decisions; notes for Aiden are on #292.
- Starting sessions automatically overnight.
- A per-step cost rollup.

## Risks

- **Compaction at 200k drops detail mid-thread.** The nudge asks for a cut well before it, and the handoff written at each clean point survives it.
- **A Sonnet reviewer misses a major.** The Opus overrides cover the risky areas, and the calibration run measures the gap on a real diff.
- **The screen reviewer misses a state.** It lists states from the diff before it drives anything, and reports the ones it could not reach.
- **`autoCompactWindow` may not apply at project scope.** The first pilot session checks it, and the env fallback is written down.
