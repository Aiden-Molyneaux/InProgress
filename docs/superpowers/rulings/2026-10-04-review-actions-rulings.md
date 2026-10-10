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

Subagent lifecycle, fix B (2026-10-06, #125: a subagent that dies without a SubagentStop; option 2 of the design, with
Aiden's answers on the usage limit and on silence):

44. Migration 7 carries fix B's two columns beside fix A's, since both ship on one branch: `end_reason` (NULL for a
    clean stop or while running, else `limit`, `error`, `killed`, `silent` or `session`) and `last_active_at` (the last
    sign of life for an end the watcher found). Only nullable columns, so `min_reader_version` stays 1. `ended_at` keeps
    meaning "no longer running", stamped when InProgress noticed, so every dead agent gets the 5-minute ended kin, while
    "ran …" and "… ago" count to `lastActiveAt ?? endedAt`. The server sends a reason only for an ended row, so a row a
    rolled-back build revived reads as running. A session's end or expiry stamps `session` on rows still running. Cost
    if wrong: none for old builds; old rows read as clean stops.
45. The transcript watcher (`src/server/agent-watch.ts`) ticks once at start-up and then every 60 s on an unref'd
    interval. It takes the running rows of every session that is not ended and has a transcript path, readers
    included (a dead reader inflates the chip count as much as a worker), plus the rows it ended itself in the
    session's current life (ruling 52). A stat each,
    a tail read only when the mtime moved. A marker ends a row once the file has been still 60 s; 20 minutes with no
    change to the file ends it as `silent`; no silence end while the session's state is `permission`, and the count
    starts again from the last tick that saw the permission; a gap between ticks over 3 minutes restarts every count;
    a missing or unreadable file never ends anything. All flips go in one write by `system`, with one
    `session.updated` per session (`changed: ['subagents']`, its state, and `ended: [{ agentId, reason }]` when any
    ended). Cost if wrong: a long silent tool call ends early and comes back on its next line.
46. Widens the design's revival: any end the watcher found (`limit`, `error`, `killed`, `silent`) is undone by a newer
    line in the agent's own transcript, not only `silent`. A line written after the end means the agent lives, for
    example after a resume whose SubagentStart POST timed out. A clean stop, a session's end and any end from before
    the session last ended (ruling 52) are not revived by a line; a resumed SubagentStart revives those, as before. A real SubagentStop still overwrites only a `silent` guess.
    Cost if wrong: an agent that writes something after its marker (not seen in any transcript) comes back to running
    until silence ends it.
47. A resumed SubagentStart that revives a row the watcher ended is not undone by the marker it was ended on. The
    watcher remembers, in memory, the line it ended each row on; while the file says nothing newer the marker is
    ignored and the silence count runs from when the watcher first saw the row running again. The prior draft re-ended
    it on the next tick and relied on the next line to bring it back, a minute of a wrong grey kin. After a server
    restart that memory is gone, so such a row can end once more and comes back on its next line. Cost if wrong: none.
48. A usage-limit death waits for Aiden (his answer): the server keeps a `limit` row in its live session's list past
    5 minutes, and the window keeps it as a kin (`agentShown`), pinning and holding its step (`occupiedSteps`, so the
    step does not draw paused), until a newer line revives it or its session ends (and a session that comes back
    leaves it in the trail, ruling 52). It is not running, so it leaves the
    chip's `· n subagents` and its tasks stop pulsing; it never counts in the `n need you` pill or the tab count. The
    kin keeps Quiet's ended character with the `!` mark, its tag and mark in `--amber-ink`. In the chip popover and
    Details its tag and its words are amber too, and the line ends `· resume after the reset`. After its session ends,
    its trail row (canvas and Details) keeps `ran … · hit the usage limit … ago` in `--amber-ink` and is otherwise
    neutral, with no letter. Cost if wrong: a kin that waits too long for a resume Aiden never makes, until the
    session ends.
49. The mark is `!` in DM Mono at the text weight (DM Mono has no 900), `--muted` for every reason but `limit`. It
    draws for any reason, `session` included, though a kin of that reason only shows when a session comes back within
    5 minutes of its end. A clean stop draws none. Cost if wrong: none.
50. The activity strip reads the watcher's event as `<session> · a3 hit the usage limit`, several joined with commas
    (`a3 was stopped, a4 stopped responding`). An agent the snapshot cannot find, or one of a session with no letter,
    reads "a subagent". The actor reads `system`. A revival alone reads as the state line it always had
    (`<session> is working`). Cost if wrong: none.
51. `INPROGRESS_AGENT_WATCH_MS` (a positive whole number of ms) replaces the 60 s interval; the e2e server sets 500.
    The wake gap stays 3 minutes, so an interval of 3 minutes or more would hold every silence end; the override is
    for tests. Cost if wrong: none in use.
52. A session's end closes its subagents, and a session that comes back does not reopen them (review round 1). Migration
    7 also adds `sessions.revived_at`, stamped when a hook event brings an ended session back (a `resume` start, or a
    prompt after stale expiry ended it), outside the Session type like `briefing_due`. `ENDED_THIS_LIFE_SQL` keeps an
    ended row only from the session's current life (ended at or after `revived_at`, or ever when it never came back):
    `listSubagents` keeps a `limit` row on its line only on those terms, and the watcher reads ended rows only on those
    terms. So after `claude --resume` past the reset, the old process's usage-limit agents stay in the trail with their
    amber words, instead of coming back as kin that pin their steps for the session's whole new life, and a line one of
    them writes does not revive it; its SubagentStart does, as for any ended row. Other ended rows keep the 5-minute
    kin whatever the life (ruling 49). The column is nullable, so `min_reader_version` stays 1; a v6 build that revives
    a session leaves it as it was, so after a rollback and back an older life's usage-limit agent can show again until
    its session next ends. Cost if wrong: an agent resumed after its session came back, whose SubagentStart POST was
    lost, stays in the trail while it runs.

## Background work (#228)

Rulings 53 onward come from `docs/superpowers/plans/2026-10-09-background-work.md` (tasks 2 to 6), in the order made.

53. Busy is derived, never stored (Aiden's answer: "Build it as designed"). `sessionActivity` in
    `src/core/activity.ts` reads a stored `idle` as `busy` while a subagent that is not a reader runs, or a command
    counts as work; the server and the window call the same helper. A stored `busy` would need the migration-1 CHECK
    on `state` rebuilt, raising `min_reader_version`, and every path that ends work would have to flip it back. A
    subagent at the usage limit is not running, so it does not make a session busy (ruling 48 holds). Cost if wrong: a
    derived value can lag the rows between events; the 30 s clocks and ruling 78 bound it.
54. The hook posts a command's first words, never the command. (Scope: what is posted to the server.
    `src/hooks/capture.ts`, on by default and off with `INPROGRESS_HOOK_CAPTURE=0` or a file
    `~/.inprogress/capture/off`, keeps the first 80 scrubbed characters of a Bash or PowerShell command locally in
    `~/.inprogress/capture/<day>.jsonl`; none of that is posted.) The head runs through `scrub()`, which redacts
    inline credentials. `command_head` is at most 3 words and 60 characters (leading `cd`, `Set-Location`, assignments
    and `export` segments, flags and `NAME=value` words dropped, cut at the first quote, pipe, redirect or `;`), the
    description at most 200. Every field is clipped in the hook to the server's bound, so a post is never rejected for
    length. A call with no background id posts nothing (a plain Bash call costs one Node start and no request), and so
    does a TaskStop on a `local_workflow`. A SendMessage body sends only its summary and its first sentence. Cost if
    wrong: a response shape Claude Code changes posts nothing, and the command shows from the next Stop instead of
    from its start.
55. Migration 9 only adds (`session_commands`, a nullable `session_subagents.run_started_at`), so `min_reader_version`
    stays 1 and a v8 build still opens and writes the database. Hooks and server ship in one deploy, because the
    strict `hookBody` rejects unknown fields. Accepted: between `promote` and `restart` (seconds) the old server
    answers a Stop carrying `background` with a 400, so a session that stops in that gap stays working until its next
    prompt. Cost if wrong: one session reads working for a few minutes after a deploy.
56. A notice, a TaskStop or a watcher end for a task id the server has no row for is a no-op. This follows the task 2
    review over the design's "insert an ended row": an agent's notice can carry a stale id, and a phantom ended row
    would sit in the list. Cost if wrong: a fast command whose async start lands after its notice shows running until
    the next Stop reconciles it as `unknown`.
57. `startCommand` on an existing row takes the start's `kind`, `persistent` and `node_id` (the tool call knows them;
    a reconcile insert guessed), fills `tool_use_id`, `description`, `command_head` and `agent_id` only when missing
    (`''` counts as missing), keeps the earlier `started_at`, and never touches `ended_at`, `outcome` or `exit_code`.
    So an async start that lands after the Stop or notice that ended a fast command fills it in and leaves it ended.
    Cost if wrong: a command shows the Stop's step instead of its own until the next write.
58. `endCommand` ends a running row, or replaces an `unknown` end with the real outcome, time and exit code; a
    `session` end is final. The Stop's `background` list is session-wide, subagents' shells included, so the reconcile
    ends a running shell or monitor of any agent that is missing from it as `unknown`, inserts a listed one it lacks
    with `agent_id ''`, the Stop's focus and `started_at` = the Stop, never re-opens an ended row, and ends nothing
    when the body says it was truncated (over 50 entries). A Stop does not end a missing command that started within
    `RECONCILE_GRACE_MS` (10 s) of it, because the async start can land after the Stop. An `unknown` end is not final:
    the watcher still reads the transcript of a session with a command ended `unknown` in the last 5 minutes, and a
    real end line replaces it (ruling 63). Cost if wrong: a command is marked `unknown` for a while before its notice
    or transcript line gives the real end.
59. A prompt's `tasks` end every listed id with no id-prefix test. Agent ids never have a `session_commands` row, so
    the design's "agents are left to the watcher" holds by construction. `command-started`, `command-ended`,
    `agent-ended` and `agent-messaged` come from PostToolUse, so like `subagent-start` they turn `permission` into
    `working`. Cost if wrong: none.
60. TaskStop on an agent ends its row as `killed` (`endAgent`), and the watcher revives a `killed` row only when the
    transcript's last line is more than `MARKER_QUIET_MS` (60 s) newer than `last_active_at ?? ended_at`, so the
    interrupt line the stopped agent writes just after the async post does not undo the end. A real resume is caught
    by `messageAgent` and SubagentStart. Whether the race happens was checked against transcripts, not proven; the
    ruling stands either way. Other end reasons keep the old rule. Cost if wrong: a live agent that writes within 60 s
    of a TaskStop reads ended until its next line past the grace or a SendMessage.
61. The server's work rule is the controller's reading of Aiden's answer on long-running servers ("Show with a
    different label/indicator", design.md); the 30-minute and head-word thresholds are the controller's, not his. The
    server uses it now, so its `activity` matches the window from the start. A command does not count as work when it
    has ended, is a persistent Monitor, is 30 minutes old or more, or has a head word (or a `:`-separated part, as in
    `test:watch`) equal to `dev`, `serve`, `preview`, `start` or `watch`. The rule is one SQL fragment built from
    `SERVER_WORDS` (`countsAsWorkSql`), checked against `looksLikeServer` by a parity test, and `busySessions` uses
    it. Cost if wrong: a real job headed `start` or longer than 30 minutes (p99 is 76 min) stops counting early.
62. `activity` rides on the `session.updated` events that report a state or commands change (the hook events, the
    expiry's) and on the subagent watcher's and the command watcher's events, so the strip can say "is busy" on the
    Stop that leaves a session busy, or on a revival alone. The project move and focus events (`session-flow.ts`)
    carry none. A `session.updated` for a hook event carries `command: { label, outcome? }` only when the event
    started or ended exactly one command; the label is the head, else the description without a leading `#id`, else `a
    background command`. Cost if wrong: a strip line reads generically.
63. The transcript watcher is the exact source for subagent commands. On its tick it reads, for sessions with a
    running command (or one a Stop ended as `unknown` in the last 5 minutes, which a real end line repairs), the bytes
    the main transcript gained (offsets in memory; the last 8 MB on first sight or after the file shrank) and ends a
    command from each `queue-operation` `enqueue` line holding its task id, at the line's time with its status and
    exit code. One write, one `session.updated` per touched session. A missing or unreadable file changes nothing.
    Cost if wrong: a subagent's command shows running up to 60 s after it ended, and ends with its session if Claude
    Code changes that undocumented line.
64. A message to a resumed agent re-homes it. `messageAgent` acts on a known row only. The step is a leading `#id` (in
    the project) of the summary, else of the purpose, else the session's current focus; with none of these it stays.
    `description` becomes the summary, else the purpose; `purpose` the new one when sent; `run_started_at` becomes now
    and an ended row is revived whatever its end reason, a clean stop and `session` included. Guard: the revive and
    the restart happen only when the run did not start (or restart) within `MARKER_QUIET_MS` (60 s). The SendMessage
    post is async and SubagentStart is not, so a message right after the run's own start finds it already handled (the
    agent may even have stopped again) and only re-homes. `startSubagent`'s revival also sets `run_started_at`. Only
    the main thread's SendMessage counts: one from inside a subagent posts nothing (`handlers.ts`), since it would
    move the target under the main session's focus. Cost if wrong: a resumed agent sits on its old step, as it did
    before this.
65. A message to an agent that is still running moves it only when a leading `#id` of the summary, else of the
    purpose, names a different step in the project; `description` and `purpose` then change as for a resume. Otherwise
    nothing changes, `run_started_at` included, and an ended row is not revived (the watcher and SubagentStart cover a
    wrong end). `started_at` and `start_focus_id` are never touched, so ruling 33's first start and ruling 42's merge
    order hold: `node_id` wins once written. Cost if wrong: a running agent told to look at another step without a
    `#id` stays where it is.
66. A re-homed agent keeps one trail row, which moves with the agent (Aiden's answer). When it stops, its row is on
    the step it ended on, and `ran …` still spans its first start to its last stop. The earlier steps keep their tasks
    but no agent row. Cost if wrong: the earlier steps show no record that the agent worked on them.
67. A command shows on the canvas while it runs and for `ENDED_AGENT_MS` (5 minutes) after its end, judged by the
    layout's `now` (`commandShown`), so the 30 s clock drops an ended line. Its home is its `nodeId` while that is in
    the tree, else the session's focus, anchored like an agent so a fold never hides it. Running commands pin their
    home, serving ones too; ended ones do not. Cost if wrong: an ended line stays or goes a tick early.
68. The `commands` item is one 20 px line per (session, card), after that session's agent line and readers line,
    ordered running by start then ended by start. The done row shares it as it shares a readers line. A command that
    counts as work occupies its step and its ancestors, so the step does not draw paused; a serving one, a persistent
    Monitor and an ended one do not, so a dev server never holds a step open. Cost if wrong: a step draws paused while
    a long job runs, or stays held by a server.
69. Every step holding running work is live: the orange hairline and active fill, not the large title (Aiden's
    answer). `LayoutNodeItem.live` is set when a running worker or reader of a live session, a command that counts as
    work, a pulsing task, or the lead of a working session is anchored to the card (anchors, not homes, so a folded
    subtree lights the visible card). A busy lead alone does not light a card. The `working` chain, which pulses
    markers, grows to every live card and its ancestors, plus the working foci's own chains. `findFrontier` prefers
    the working focus seen last, then the focus of the busy session seen last, then the queue. Cost if wrong: more
    orange frames than Quiet had before; the picture is honest but louder.
70. `listCommands` orders running first, then commands that count as work, then newest start, at most 30, so with more
    than 30 running (persistent Monitors started after one real build) a counting command is always listed and core's
    `sessionActivity` agrees with the server's `EXISTS`. Accepted: the window's `+n` can undercount past 30. The
    briefing's other-sessions line prints `sessionActivity`, so it reads `B "InThink session" (busy, on #223)`. Cost
    if wrong: a `+n` that is too small on a session with over 30 running commands.
71. Busy is a fifth Simple character state: `work`'s round, blinking eyes, a solid body at full opacity, no glow, and
    `ip-breathe` (3.6 s ease-in-out from the bottom centre, `scale(1, 1)` to `scale(1.03, .97)`). The reduced-motion
    blanket rule stops the breathe and the blink, and the open eyes still tell it from idle's lids. A lead is 24 px
    while working and 20 px otherwise, busy included, so a lead never grows for background work. `characterState`
    takes a required `now`. Cost if wrong: none.
72. The words follow the activity: `WORDS.busy` is `busy`, and the chip label, accessible name and lead title add ` ·
    n commands` for the session's running commands that count as work, its agents' included. That is the same n as the
    chip's `▸n` (muted, DM Mono S, hidden from the accessible name). Serving commands are not counted or named. Cost
    if wrong: a session with only a server reads idle and shows no `▸n`.
73. A command that has run 30 minutes or more, or whose head reads like a server, draws as serving (Aiden's answer was
    "Show with a different label/indicator"; the thresholds and the glyph are the controller's):`◦ a3 · npm run dev ·
    serving 3h`, faint, a still hollow mark in place of `▸`. It is never busy or live, not in `▸n`, and in the chip
    popover and Details it goes faint too. The code draws any running command that does not count as work this way, so
    a persistent Monitor reads `◦ … serving` as well. Cost if wrong: a Monitor reads as serving, which is close to
    what it is.
74. The commands line reads `▸ a3 · npm run test:e2e +4 · 12m`: the lead is the oldest running command that counts,
    else the oldest running one, with `+n` for the other running ones and the lead's run time. The tag is the
    subagent's when it still exists, else the session's letter. When every command has ended the line reads `✓` (all
    completed) or a muted `!` (any failed, stopped, ended with its session or `unknown`) with no time, for 5 minutes,
    then goes. No trail entry. The tooltip and accessible name list one command per line. Details gets a `Background`
    section after Subagents with one line per shown command on the step. Cost if wrong: none.
75. A running subagent's run time (the agent line, the chip popover, the kin tooltip and Details) counts from
    `runStartedAt`, which the server sends as `run_started_at ?? started_at`; the trail's `ran …` keeps `startedAt`.
    This amends ruling 33 for the running line; the trail keeps it. Cost if wrong: a resumed agent reads a long run
    time again, as the 21 h case that started this.
76. The activity strip reads a `session.updated` in this order: `ended`; a state change with the command appended (`·
    <label> <outcome>`), saying `is busy` for a Stop that leaves the session busy; the command alone (`started
    <label>` or `<label> <outcome words>`); then a commands-only change with no `command` (the transcript watcher),
    which reads `<who>: a background command ended`. Cost if wrong: a wording change.
77. The tab dot pulses only while a session of the project works and stays still while sessions are only busy (a
    `still` class). `busySessions` also counts sessions busy by commands alone, under the work rule of ruling 61.
    `projectLabel` says `working`, else `busy`. Cost if wrong: none.
78. The project summaries refetch every 30 s while any project has `busySessions > 0`, skipping the tick while
    `document.hidden`, so a command crossing 30 minutes clears the dot without an event. The interval has no test
    (accepted). Cost if wrong: a dot that lingers up to 30 s.
79. The window's four 30 s clocks (`Canvas`, `SessionRow`, `Details`, `ActivityStrip`) tick at their own phases, so at
    a command's 30-minute edge the chip and the card can disagree for up to 30 s (accepted). Cost if wrong: a chip
    says busy for half a minute after the card shows the line faint.
80. The re-home e2e test waits 61 s for real, because `MARKER_QUIET_MS` has no clock injection (accepted). Cost if
    wrong: one slow test.

Follow-ups:

- An environment override for the server's `MARKER_QUIET_MS`, so the re-home e2e test need not sleep 61 s (not built).
