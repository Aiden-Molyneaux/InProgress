# InProgress: working rules

The Roles, Routing, Overrides, Evidence, Session rhythm and Handoff sections are for the main session. A subagent follows its own agent file; the house rules at the end apply to every subagent that loads this file (`explorer` and `screen-reviewer` skip it and carry their own). Design: `docs/superpowers/specs/2026-10-09-dev-session-routing-design.md`.

## Roles

The main session (Opus 5.5, effort high) holds the plan and the judgment calls. It clarifies, writes specs and plans and reviews them itself, reads diffs, decides what to fix, merges, deploys and reports. Work whose output can be checked mechanically goes to the agents in `.claude/agents/`, so their reasoning stays out of the main context. Small fixes stay in the main session: a dispatch costs more than it saves.

## Routing

| Agent | Default | Dispatch when |
|---|---|---|
| `explorer` | Haiku, low | The answer means reading across several files: callers, where something is used, an inventory |
| `implementer` | Sonnet, medium | A written plan exists for a branch or a plan task |
| `code-reviewer` | Sonnet, high | Every branch, before merge |
| `screen-reviewer` | Sonnet, medium | Every branch that changes the window, before merge |

- When a superpowers skill (subagent-driven-development, requesting-code-review) dispatches an implementer or a reviewer, use these agents, never `general-purpose`: it inherits Opus. Specs and plans get no reviewer subagent.
- Give each implementer and reviewer its worktree, its scope and the request. Give each screen-reviewer a port from 4400 to 4409 and a scratch folder, and each implementer on a UI plan an `INPROGRESS_E2E_PORT` from 4410 to 4419, so parallel sessions never share the e2e default (4399).
- Start every Agent description with its step's `#id`.

## Overrides

Pass `model` (an alias: `haiku`, `sonnet`, `opus`, `fable`) on the Agent call only when one of these holds, and record the override and its reason in the handoff's pilot log.

- `code-reviewer` to `opus` when the diff touches:
  - data: `src/server/db/`, or `min_reader_version`;
  - code that runs in every session of every project: `src/hooks/`, `src/cli/claude-config.ts`, `src/mcp/`, `claude/`, `src/server/session-flow.ts`, `src/server/briefing.ts`;
  - several sessions writing at once: `src/server/repo/`, `src/lib/ensure-server.ts`, `web/src/stream.ts`, `scripts/deploy*.mjs`;
  - focus and keyboard: `web/src/useKeyboard.ts`, `web/src/chrome/menu.ts`, `web/src/chrome/GoTo.tsx`, or any diff that adds a menu, popover, confirm or focus move.

  Display-only UI (styles, layout, wording, canvas visuals), CLI output, docs, tests and scripts stay on Sonnet.
- `code-reviewer` to `haiku`, with "proportional" in the brief, for the re-check after fixing its findings, when the fix diff is small and adds no code paths.
- `implementer` to `opus`, or take the work back into the main session, when the code-reviewer returns a blocker or major on the same branch twice, or when the plan centres on hook ordering, transactions and migrations, or races between sessions.
- Never override `explorer` upward: a question that needs judgment comes to the main session. `screen-reviewer` stays on Sonnet: its safeguard is listing every state first. Fable only when Aiden asks.

## Evidence

Subagent claims are not evidence. After an implementer, rerun its checks and read the diff. Open each finding's `file:line` before fixing it. Spot-check the files an explorer names before building on them.

## Session rhythm

- You can't see your context size. A hook (`scripts/context-nudge.mjs`) tells you when it crosses 150k and 160k, and `.claude/settings.json` compacts at 300k.
- One thread per session: a feature, or a suite of related features that share code. A clean point is right after a merge, or after a finished plan task with everything committed in your worktree.
- Cut the session when the thread is done, when the next queued item is unrelated, or when the nudge says so. At a cut: write the handoff, brief the scribe to attach it to its step, print the handoff's path, offer the next session as a chip whose prompt is the handoff prompt when the `spawn_task` tool is available (the desktop app), and stop.
- A new request mid-session becomes a queued step through the scribe (`later: #id`, or a new step), unless it is a few lines in code that is already open. The InProgress tree is the memory between sessions.
- Work only in your own worktree under `.claude/worktrees/`. A session spawned from a chip starts in one; otherwise create it with `git worktree add .claude/worktrees/<topic> -b <topic> main`. The main checkout takes only merges, deploys and `claude:install`.
- Uncommitted changes outside your worktree belong to another session: don't stage them, ask about them or mention them. Stage explicit paths only.
- Unattended overnight run: the same rhythm without stopping. At each clean point write the handoff, then take the next queued item; compaction is the reset. Provisional rulings and open questions go to the rulings file in `docs/superpowers/rulings/`.

## Handoff

A prompt a fresh session can start from, saved as `~/.inprogress/resources/inprogress/<yyyy-mm-dd>-<kebab-title>.md` and attached to its step as a resource. The standing rules live here, so a handoff never repeats them. It holds:

- the goal;
- where things are: branch, commit, worktree;
- decisions made, with who made them;
- what waits on Aiden;
- what to read now, as slices (`file:lines`), not whole files;
- the next concrete step;
- while the routing pilot runs (#291), the pilot log: session ids and what each did, each session's cost, implementer fix rounds, reviewer blockers and majors with the model that found them, screen-reviewer flags and unreached states, overrides and why, and the changes Aiden asked for after review.

## House rules

- Test gates by label, branch and landing rules are in the InProgress playbook, which the session briefing shows.
- No em dashes (U+2014) or their HTML entities in any file: `test/repo/no-em-dash.test.ts` scans every file.
- Deploy and `claude:install` run only from the main checkout: the installed hooks bake in its absolute path.
- `node scripts/session-cost.mjs --by=session --sessions=<id prefixes>` prices sessions from their transcripts at list rates. The baseline is r105 on #289.
