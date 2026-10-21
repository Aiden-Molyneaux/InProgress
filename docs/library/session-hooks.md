---
covers:
  - src/hooks/**
  - src/server/briefing.ts
  - src/server/session-flow.ts
  - src/server/briefing-scoped.ts
  - src/server/title-channel.ts
  - src/cli/claude-config.ts
---

# Session hooks and the briefing

How a Claude session on this machine comes to know about InProgress: the hooks Claude Code runs,
what the server does with each one, and what it injects back into the session. Most of it is in
three places: the hook process (`src/hooks/`), the server's handling of hook events
(`src/server/session-flow.ts`) and the text it renders (`src/server/briefing.ts`).

## The shape of it

1. `npm run claude:install` writes hook entries into Claude Code's user settings. Each entry runs
   `node <repo>/dist/hooks/hook.js <hook-name>` in exec form, so every session of every project
   on the machine runs them.
2. The hook reads Claude Code's JSON on stdin, keeps a redacted copy for the activity work
   (`capture.ts`), and posts a small body to the local server at
   `POST /api/sessions/:id/hook`.
3. The server records the event against the session, and for a tracked session may answer with
   text: a briefing, a status line, ask reminders, a title line.
4. The hook prints that text as `additionalContext` (session start and prompts only), or, on a
   stop, a block reason that sends the session back once to set its title.

A hook never fails a session: it exits 0 on any error, logs to `~/.inprogress/hooks.log`, and
gives up on its own budget.

## The hooks

Ten entries over nine Claude Code events (`HOOK_DEFS` in `src/cli/claude-config.ts`):

| Claude Code event | Hook | Matcher | What it posts |
|---|---|---|---|
| SessionStart | `session-start` | | `start`, with the folder, branch, title and source (startup, resume, clear, compact). Starts the server if it is not running. |
| UserPromptSubmit | `prompt-submit` | | `prompt`, with the folder and branch, whether the prompt says "InProgress", whether it asks for status, and whether it is a background-task notice rather than a typed prompt |
| Stop | `stop` | | `stop`, with the title and the session's running background tasks |
| Notification | `notification` | `permission_prompt` | `permission`: the session is waiting on Aiden to allow something |
| SubagentStart, SubagentStop | `subagent-start`, `subagent-stop` | every agent but `inprogress-scribe` | the subagent's id and type |
| SessionEnd | `session-end` | | `end` |
| PreToolUse | `pre-tool` | `Agent`, `Task` | a dispatch: the agent type and the first sentence of its prompt |
| PostToolUse | `post-tool` | `Agent`, `Task`, `TaskCreate`, `TaskUpdate` | a launch, and working-task changes |
| PostToolUse (async) | `post-tool` | `Bash`, `PowerShell`, `Monitor`, `SendMessage`, `TaskStop` | a background command starting or stopping, a message to an agent, a stopped task |

What leaves the machine's Claude process is deliberately small: flags rather than prompt text,
the first sentence of an agent prompt or message, a command's first few words. The scribe is
left out of the subagent hooks so its briefs never show as live work.

**Budgets** (`src/hooks/budget.ts`): `session-start` waits up to 5 s for a server it had to start,
then 2 s for its post, so 7.25 s at most inside Claude Code's 10 s timeout. Every other hook makes
one 500 ms post and never starts a server. The async `post-tool` entry never holds up a tool call.

## Who is tracked

A session is created the first time the server sees a `start` or a `prompt` that carries a
folder. It is tracked when that folder sits under a folder bound to an active project (the
`bindings` table, with optional branch patterns), or when it was enrolled through the scribe or
the CLI. An archived or deleted project tracks nothing.

Because prompts carry the folder too, a session whose start the server missed (the server was
down, or the hook timed out) is picked up on its next prompt and briefed then.

An untracked session gets nothing, except one hint when a prompt mentions InProgress: how to opt
in.

## What each event does

All of it runs in one write per event (`handleHookEvent`):

- **start**: the session goes `idle` (a `compact` start leaves its state alone); a `clear`
  resets its role to worker; a `resume` ends the background commands left over from before.
- **prompt**: the session goes `working`. A background-task notice ends the commands it reports
  and is not counted as a prompt; a typed prompt counts toward the status nudge.
- **stop**: the session goes `idle`, and the running-task list reconciles the session's commands
  (ending the ones that are gone, unless the list was cut short).
- **permission**: the session shows as waiting on Aiden.
- **subagents, dispatches, commands, messages, working tasks**: the live-work rows the window
  shows under a session.
- **end**: the session, its subagents and its commands end, and any queue it held is released.

## What the server sends back

On **session start**, and on the first typed prompt after the server marked the briefing due, the
session gets the **full briefing**. It arrives once: rendering it clears the marker, and a
background-task notice leaves it for the next typed prompt. A compaction re-sends it, so a
compacted session keeps the rules.

The full briefing, in order:

1. The header: the project the session is tracked in, and the session id.
2. How plan edits go: through the `inprogress-scribe` agent, in the background.
3. The project's playbook, its first 15 lines.
4. **Keeping InProgress current**: when to brief the scribe and in what words, how working
   tasks mirror, how to name a step to Aiden. This is the rule set every tracked session follows,
   and it is where "who updates the scribe" is decided: the main session, at most once per turn.
5. Where things stand: the frontier of the plan, what is up next, a parked focus, what needs
   Aiden, a check on stale asks, what finished recently, what was left unfinished, recent
   resources, and the other sessions in the project.

An orchestrator session gets its own briefing in any project. In a project that uses claimed
steps, a worker gets a briefing built around the step it drives, or, with no step claimed, one that
lists the steps ready to claim and the command to claim one (`briefing-scoped.ts`).

Every **typed prompt** can carry short lines, in this order:

1. a **Title:** line, when the session's title prefix differs from the one InProgress expects
   (desktop sessions only); it is added last in the code so that it leads;
2. `Answered: aN "…"` or `Cleared: aN, no answer` for each ask Aiden cleared since the last
   prompt, delivered once: the session's own asks, and asks on a step it drives whose asker no
   longer holds them;
3. a reminder for each of the three newest open asks on the same two routes, then
   `+N more open asks: …` naming up to ten of the rest and counting the older ones;
4. then the full briefing when one is owed, or else the answer to a status question, or a
   one-line status nudge once two prompts have passed without an update.

A background-task notice gets none of these.

## The title channel

In the desktop app, InProgress works out the title prefix a session should carry (`REVIEW`,
`BLOCKED`, `DONE`, `PARKED`, `RUNNING`, or none) from its focus step, its open asks and its live
background work (`src/server/title-channel.ts`). The prompt-time `Title:` line names it. In a
project whose channel is `enforce`, a **stop** with the wrong title is blocked once with the exact
title to set; the extra pass that block causes is never blocked again. The default channel is
`nudge`: the line only.

## Changing it

- Anything in `src/hooks/` runs in every session on the machine: Murr reviews it on Opus, it
  takes the integration gates, and it reaches sessions only after `npm run deploy` and
  `npm run claude:install` from the main checkout.
- The briefing's wording is the rule set every tracked session follows. A change to
  `updateRules` changes how every session briefs the scribe.
- The guide (`docs/guide/inprogress-guide.html`) tells the longer story of why the hooks exist.
  Where it gives hook counts or timeouts, this page is the current one.
