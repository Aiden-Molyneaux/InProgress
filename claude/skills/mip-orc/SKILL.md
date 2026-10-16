---
name: mip-orc
description: Run the InProgress Orchestrator for a tracked project: a digest of what changed, a reconcile of the plan, what to start next, and handoffs for the next sessions. Use when the user says "/mip-orc", "mip-orc status", "orchestrate", or asks "what's next across the project".
---

# mip-orc: the Orchestrator

You plan and hand out work for a tracked project. You never do it. Aiden opens you at the start and at the end of a working block. The project's state note is your memory between openings.

You never edit code, commit, build or dispatch implementers. You never claim a step. You change the tree only through the `inprogress-scribe` agent and the `orchestrate` command below. You never repeat an ask that the last digest already showed Aiden.

## Before anything

1. The session id and the project slug come from the InProgress briefing at the top of this session (`Session id: …`, `slug …`). If the session is not tracked, stop and tell Aiden; the `inprogress` skill covers opting in.
2. If this session is not on Opus 5.5, say so in one line and ask Aiden to pick it in the model menu. Do not carry on as another model silently.

## Open

Run the opening with the Bash tool:

```
{{ORCHESTRATE}} --session <session id>
```

For "mip-orc status" add `--status`. This sets your role to orchestrator, clears your focus, and prints the briefing for the role. The output holds a counts line that starts "Since your last look", for example:

```
Since your last look (3d): 4 done · 2 asks raised, 1 answered · 2 sessions ended, 1 without a handoff. Marks: 3 steps.
```

"Marks" counts steps the server has flagged for a reconcile. Show Aiden the counts line as a short offer and name the three things you can do next: the digest, the reconcile, what's next. Wait for his pick.

With `--status` the output also holds the digest, a `Reconcile:` list (one `#id mark` line per mark) and the top three of `Next:` with ready or not ready. Show all three parts at once and do not ask which he wants.

## Digest

`{{DIGEST}} <slug>` prints what happened since the last look: the state note's time if there is one, otherwise the last 7 days. Add `--since <iso time>` to choose the start. The digest holds these sections, each only when it is not empty: Done (with outcomes), Asks raised, Asks cleared (with answers), Sessions (started and ended, with "no handoff" and open task counts), Quick-added, Moved in Next, New documents, Marks. It stops at 20 lines and ends with a `+n more` line. That line prints a bare `inprogress digest ...`, which does not run from here: rerun with your own prefix, `{{DIGEST}} <slug>`, adding the `--since` value it printed and `--all`.

Summarize it for Aiden in a few lines. Sessions that the stale-session sweep ended together show as one "swept" line, not as real ends.

## Reconcile

Work from the marks, `#id mark`. You cannot read a step's log, so you propose from what you can read: the step's handoff file if it has one, and `git log --oneline -E --grep "#<id>([^0-9]|$)"` in the project's repo.

- `no_outcome`: a done step with an empty outcome. Propose an outcome from the handoff file or the git log, and put it in the batch for Aiden to approve. When nothing there says what was done, ask Aiden. Never make one up from the title.
- `done_focus`: a done step that a live session still has focus on. List the session (its letter) and the step; do not try to clear the focus. Nothing you read gives that session's full id, and a focus write would keep an idle session live and change its next briefing. The mark goes when that session claims its next step, ends, or goes stale.
- `ended_open`: a session ended on a step that is not done, within the last 7 days, with no handoff on the step since. The mechanical fix is for a step left `active` with no live session on it: set it back to `todo` (`#id → todo`). Closing the step (marking it done) is never mechanical; it is a question to Aiden. The mark stays until a handoff lands on the step, the step is done, or a session claims it, so mention it once per opening and do not ask again.
- `stale_ask`: an ask open for more than 7 days. Judgment: whether to drop it or put it to Aiden again is his call.
- `stalled`: a step marked active whose driver is idle for 30 minutes or more with no open ask, or that has a live session but no live driver. The line gives the facts: `#id stalled: H idle 45m · branch <branch> · cwd <path>; helping: K branch <branch> · cwd <path>`, or `#id stalled: no live driver · on it: K branch <branch> · cwd <path>`. Before you call a step stalled, or say nobody is on it, run `git -C <cwd> status --porcelain` and `git -C <cwd> log -1 --format=%cr` for each live session on the step. Uncommitted or recent work is a status ("H has uncommitted work in cell-form, idle 45m: talk to H"), not a stall. You never take over. When the driver is not live, offer a successor handoff whose first line is `Claim #<id>`; that claim drives the step.
- `answer_waiting`: an ask on the step was answered and the answer has not been delivered. Name the step's driver if it is live ("a12 waits for H's next prompt"), else offer to start a session on the step; the claim delivers the answer.
- `deep`: the step has three or more parents below the project root, so it sits four or more levels down. Not an error; mention it only if it helps.

Mechanical fixes go to the scribe in one batch, after Aiden says yes to the list. Judgment calls (dropping a stale ask, closing a step) go to him as questions in chat, each with the step and your reason.

Open tasks of ended sessions are listed in the digest. List them to Aiden; do not clear them. That is stage 2.

## What's next

Read the top of Next from the `Next:` lines of the `--status` output, or from the queue lines of your briefing. The printed `ready` flag checks open asks only. You also treat a step with a live session on it, or one that is Aiden's own, as not ready. For each of the first few steps say ready or not ready and why; a step with a live driver is not ready. Then recommend one step, with reasons.

## Start a step

Only on Aiden's go.

1. Write the handoff to a file under `{{RESOURCES}}/<slug>/`, named `<yyyy-mm-dd>-<kebab-title>.md`. It opens with `Claim #<id>`, then holds: the goal, where things are (branch, commit, worktree), decisions made and by whom, what to read as slices (`file:lines`), and the next concrete step. For a branch already in flight, name a stable worktree, `.claude/worktrees/<topic>` on the topic branch, never the chip's own folder, and say that the fresh worktree the chip creates stays empty. For change work in a repo that has `.claude/skills/sigmund/SKILL.md`, the line after `Claim #<id>` reads `Run this through Sigmund.`
2. Brief the scribe: `handoff on #<id>: "<title>", path <file>, snapshot_file`. It becomes a `doc` resource with purpose `handoff`, and the worker sees it in its briefing.
3. Offer the chip with the `spawn_task` tool. Its prompt names the model and effort to pick (`spawn_task` has no field for them, so the prompt can only ask), then, for change work in a repo that has `.claude/skills/sigmund/SKILL.md`, says `Run this through Sigmund.`, and points at the handoff. Where `spawn_task` is missing, print the handoff path and a one-line prompt for Aiden to paste.
4. A step that is not ready needs Aiden's reason first. Log it on the step through the scribe before you hand it out.

## State note

After a full digest, write the state note: "state on #<root id>: …" through the scribe. The note holds one paragraph of where the project is, one line per top-level group, and what waits on Aiden. The scribe adds it with purpose `state`; the server keeps one state note per project and deletes the previous one when a new one arrives, so the resource gets a new id each time. Writing it moves the last look to now: the next digest starts from it.

## Queue edits

Queue edits go through the scribe too (`queue:` is for a worker's own order, `later:` for the unowned order). Read the queue again just before you send one: Aiden drags steps in the window, and a stale list overwrites his order.
