# Review actions: controller rulings

Decisions the controller took on Aiden's behalf while running `docs/superpowers/plans/2026-10-04-review-actions.md`,
in the order made. Aiden's own decisions are in the design note's "Decisions after the preflight" section. Format:
decision, why, what it costs if wrong. Review these and rework anything ruled wrongly.

1. Keep the node-size feedback in `Canvas.tsx` when the minimap goes (P2): only `MiniMap` and its Follow-off wiring
   are removed. React Flow hides a node until it has `measured` dimensions, and Canvas rebuilds every node object on
   each snapshot and on the 30 s clock, so without the feedback every card flickers and a focused card stops being
   focusable. The design note assumed the loop existed only for the minimap. Cost if wrong: about ten lines kept.
2. P3 starts only after both P1 and P2 have merged. P3 edits `src/server/repo/work.ts`, `src/server/briefing.ts` and
   tests that P1 changes. Cost if wrong: P3 waits for the slower of the two.
3. The no-focus hint reads `Name the step: tasks <id> …`, not `tasks #id …`: an unquoted `#` starts a comment in Bash
   and PowerShell. The CLI still accepts a quoted `#88`. Cost if wrong: none.
4. P1 exports `taskCommand(sessionId, …)` and gives `updateRules` an options object, so that P8 reuses both. Cost if
   wrong: none.
5. Allow rules (P1): `Bash(node <repo>/dist/cli/main.js tasks *)` and `PowerShell(node <repo>/dist/cli/main.js tasks *)`,
   with forward slashes. Uninstall finds them by pattern, and install strips task rules for another repo path before
   adding. When the repo path contains a space, install leaves the task rules out and says why, because an unquoted
   path cannot hold a space and a quoted one never matches in PowerShell. Cost if wrong: a repo with spaces in its
   path gets a permission prompt.
6. The `tasks` command never starts the server. When the server is unreachable it says a brief to the scribe starts
   it (the scribe's MCP server does), then to run the command again; after a timeout it says a rerun is safe, since the
   list is replaced whole. Bare `node` may not be the Node that better-sqlite3 was built for (ruling 71 of the v1
   rulings), so the server is only ever started by hooks, the scribe, deploy or `start`. Corrected after P1's review:
   the first wording said the next prompt starts it, which the prompt hook does not. Cost if wrong: a rare retry.
7. Sessions enrolled through the skill learn the command from the skill: P1 writes the full command into the skill,
   its prefix rendered by the same helper as the briefing and the allow rules (`{{TASKS}}`), with a `<session id>`
   placeholder. Cost if wrong: none.
8. P3 owns filtering the briefing's open tasks to live sessions (`endedAt === null`), so ended sessions' tasks never
   print as live work. Cost if wrong: none.
9. Trail rows (stale tasks and ended agents) stay neutral grey with no letter (P4), since an ended session's slot can be
   reused by a live one. Cost if wrong: a trail row can't be traced to its session by colour.
10. New P3 and P4 tests use a worker agent type such as `general-purpose`, never `Explore`, which P6 makes a reader.
    Cost if wrong: none.
11. E2E tests that need old timestamps move the browser clock with `page.clock.install({ time: Date.now() + offset })`
    before navigating, never `setFixedTime`, which stalls Follow's throttle. Cost if wrong: none.
12. Unowned queue markers (P5) use a neutral token, never `familyVar(null)`, which is session clay. The readers row
    (P6) uses `sessionTag(slot).toLowerCase()` with a fallback for a null slot. Cost if wrong: none.
13. P8 drops the sibling `Next:` lines only when an Up next line with at least one step is printed. Cost if wrong:
    none.
14. Migrations: P4 is 4, P6 is 5, and P8's "not yet briefed" marker is 6. All only add nullable columns, so
    `min_reader_version` stays 1. Cost if wrong: renumbering if the order changes.
15. Restarts: open sessions restart after P1 and P8, whose changes arrive with the briefing at session start. P6
    changes only what the hook script does, and hooks run the built script afresh on every event, so P6 needs no
    restart. Cost if wrong: one extra restart request.
16. An ended session's subagents join the trail at once (P3), not five minutes after they stop. An ended session
    leaves the snapshot, so its greyed badges go with it, and a literal five-minute wait would show its agents
    nowhere. Cost if wrong: none.
17. A trail agent whose step is set but no longer in the project's tree is left out (P3); it falls back to its
    session's focus only when it has no step. A session repointed to another project would otherwise show its old
    project's agents in the new one. Cost if wrong: a repointed session's old agents leave both trails.
18. `assignSlot` treats a session idle past the stale limit as not live (P4), as the note says "no other live
    session". Cost if wrong: none.
19. A live session whose slot is still empty (it predates migration 4) shows no letter where the text allows it
    (`Up next (you): …`) and `?` where an owner needs a label (P5, P6). It lasts until the session's next hook event
    fills the slot. Cost if wrong: a brief `?`.
20. A `queue:` write from a session that has ended or gone stale stores its steps as unowned, at the head of the
    unowned part, as `releaseQueue` would (P5). Cost if wrong: none.
21. P5 leaves `later:` out of the current rules line; P8's block carries it, and the skill teaches it meanwhile. Cost
    if wrong: a session briefed between P5 and P8 learns `later:` only from the skill.
22. P5 amends the live-work note's `projects.queue` line to the owned-entry shape, pointing at §6, as P3 and P6 amend
    their lines. Cost if wrong: none.
23. A reader's own working tasks (P6) keep the plan's behaviour: readers leave no trail, so their tasks lose the tag
    five minutes after the reader stops. Readers rarely create tasks. Cost if wrong: an untagged task row.
24. The "check with Aiden" line names every needs-you item older than three days, up to eight, then `+n more` (P7).
    Cost if wrong: none.
25. The check line is left out only after a compaction (P7). A session first tracked by a prompt after its start was
    missed, or a start with any other source, counts as a new session. Cost if wrong: none.
26. The check line reads `Check with Aiden whether these are already done, then brief the answer (a "not yet" goes in
    "log on #id: …"): #14, #45.` (P7). Cost if wrong: none.
27. A background-task notice is not the first tracked prompt after an enroll (P8): the briefing comes with the next
    real prompt, as the status answer and the nudge already skip notices. The skill's copy of the task command covers
    the gap. Cost if wrong: an opted-in session waits one prompt for its rules.
28. The skill keeps the full task command after P8 (ruling 7 stands). Cost if wrong: one line of skill text.
29. P8's "briefing due" marker is set for a new session, a repoint, or an enroll of an ended session, not for a
    same-project re-enroll of a live session that already had its briefing. Cost if wrong: none.
30. `listSubagents` and `listTrailAgents` share one row mapper (P3), so P4's `ordinal` and P6's `purpose` are each
    added once. Cost if wrong: none.
31. Task subjects leave out double quotes, and the skill says so (P1, P8): Windows PowerShell 5.1 drops or splits a
    `"` inside a quoted argument, so a subject like 'Retry "step 88"' can arrive as two arguments and send the write
    to step 88. Single quotes still protect `$` and backticks in both shells. Cost if wrong: none.
32. The briefing and the skill tell sessions to prefer the Bash tool for the tasks command; the PowerShell rule stays
    installed (P8). Found at P1's live check: Claude Code decides a PowerShell permission by spawning a PowerShell
    parser, which took 4.7 to 6.8 s here, and under heavy load it timed out and fell back to asking (about fifteen
    checks in a row were denied in don't-ask mode, and the same checks later passed eight times in a row). Bash rules
    match in-process, at once, every time. Cost if wrong: none.
33. A resumed subagent keeps its first start time, so the trail's "ran …" spans its first start to its last stop
    (P3). A true run time needs a new column, which P3 has no migration for. Cost if wrong: an overstated run time for
    an agent that was resumed.
34. When a step is deleted, its trail agents fall back to their session's focus (P3): `ON DELETE SET NULL` leaves no
    way to tell a deleted step from no step. Cost if wrong: a rare trail agent shown on the wrong step.
35. A revival that gives a session a different slot also marks it "briefing due" (P8), so its next prompt brings the
    full briefing with the new letter. Without it, a session revived by a prompt keeps "You are session A." in its
    context after it became B. Cost if wrong: one extra briefing on such a revival.
36. A `later:` write may take a step out of a session's list (P5): a node sits in the queue once, so placing it in the
    unowned order claims it from wherever it was, as a `queue:` write does. Cost if wrong: one session can move
    another's step to `later`.
37. Correction to ruling 15: P5 also needs open sessions restarted. It changed the scribe's `set_queue` tool and the
    scribe prompt, and a session keeps the MCP server process and agent definitions it started with. Until a session
    restarts, its `queue:` briefs set the unowned order, as before P5. One restart after P8 covers P1, P5 and P8. Cost
    if wrong: none.
38. The readers row's tooltip lists each reader as `a2 · description`, one per line (P6), following Aiden's
    tags-first decision. The brief asked only for descriptions. Cost if wrong: none.
39. The briefing's rules header drops "(Aiden watches it live)" (P8), which pays for "flags repeat in list order" in
    the working-tasks bullet. The aside carried no instruction, and the block stays under 1,600 characters. Cost if
    wrong: none.
40. Amends ruling 35: a session is marked "briefing due" on any return into a different slot that is not a start,
    whether from `ended` or from stale, and when a session from before migration 4 gets its first slot (P8). Its
    next real prompt then brings the full briefing with its letter. Cost if wrong: one extra briefing per such
    session.
41. Amends ruling 29: a same-project re-enroll of a live session is marked "briefing due" when it gives the session
    a different slot, and so is a `set_focus` that does, matching ruling 40 (final review fix wave). A re-enroll that
    keeps the slot still leaves the marker alone. Cost if wrong: one extra briefing.

Aiden's answers to the overnight questions (2026-10-05): ruling 32 is confirmed. A subagent that dies without a stop
should be represented in the window, and workflow agents should carry a representative label. Both are new
research steps under "Feedback from daily use".

Subagent lifecycle (2026-10-06, fix A of the subagent design approved in chat; it ships with #125):

42. A subagent with no step of its own stays on the focus its session had when it started, not on the session's current
    focus. Migration 7 records that focus in `session_subagents.start_focus_id`, apart from `node_id`, which every
    pairing change rewrites, and the server merges the two: the dispatch's `#id`, then the focus at dispatch, then the
    focus at start, and only with none of those the session's current focus. The badge, the trail row and the
    subagent's own tasks read the same merge, so they share one step, which amends the live-work note's attribution
    rule. Amends 17: a start focus no longer in the tree (the session was repointed) drops the trail agent like any
    step, so a repointed session's no-step agents stop landing on the new project's focus. Amends 34: a deleted
    dispatch step now falls back to the start focus first; a deleted start focus goes NULL and the agent follows its
    session's focus as before. Rows from before migration 7 keep the old behaviour until they leave the trail. Cost if
    wrong: a no-step agent stays on a step its session has left, which is what Aiden asked for.
43. A subagent that started while its session had no focus takes the first focus the session then sets, and keeps it:
    `setFocus` fills `start_focus_id` for the session's running rows that have neither a step nor a start focus.
    Without it such an agent would follow every later focus. An agent that stopped before any focus was set keeps none
    and follows its session's focus in the trail. Cost if wrong: a rare agent pinned to a step it never worked on.
