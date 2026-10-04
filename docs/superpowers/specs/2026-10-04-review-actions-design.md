# Review actions: what changes after the product review

Date: 2026-10-04. Status: approved by Aiden on 2026-10-04 (all eleven review recommendations approved; "owned
entries, one list" chosen for per-session priorities).

This note extends the InProgress design spec (`2026-09-27-inprogress-design.md`) and the live-work note
(`2026-10-02-live-work-design.md`). Source: the product review, resource r27 on #88
(`~/.inprogress/resources/inprogress/2026-10-04-product-review.md`). Tracked in the `inprogress` project as #90.
The implementation plan is `docs/superpowers/plans/2026-10-04-review-actions.md`.

## North star

InProgress is the window where Aiden watches Claude work. A glance tells him which session and which agent is on
which step and what it is doing this minute. After a gap, the same window shows what happened while he was away and
what is waiting on him. Hooks and Claude keep it true, and he never tends it.

Every section below is judged by one test: it makes the window more true or easier to read at a glance, without adding
work for Aiden or weight to Claude's context.

## 1. Working tasks from sessions that lack the task tools

Desktop-app sessions have no TaskCreate or TaskUpdate, so their task list goes through the scribe and goes stale.

- **CLI.** A new command, run by the main session itself in one tool call:
  ```
  "<node>" "<repo>/dist/cli/main.js" tasks [#id] --session <session id> --done "…" --doing "…" --todo "…"
  ```
  - `--done`, `--doing` and `--todo` map to `completed`, `in_progress` and `pending`. They repeat, and argument order is
    list order. No task flags at all clears the list.
  - `#id` (with or without `#`) is the step. Left out, the server uses the session's focus; with no focus it refuses
    with a hint.
  - It calls the existing `POST /api/sessions/:id/tasks`, which replaces that session's own list on the node. Actor:
    `session:<id>`. That actor does not reset the stale-nudge counter, because the plan may still be behind.
  - It prints one line, `#88: 2 done · 1 in progress · 1 pending`, and exits 1 with the server's message and hint on
    failure.
- **No prompt.** Install adds allow rules so the command never asks for permission, in both the Bash and the PowerShell
  tool.
- **Rules.** The briefing prints the command with the session id, node binary and repo path filled in. The
  `tasks on #N:` brief line goes away, and so does the scribe's `set_tasks` MCP tool. The HTTP route stays.
- **Scope of the exception.** Ruling D6 (every edit goes through the scribe) still holds for the plan. This is an
  exception for the working-task layer only.

## 2. Canvas at 520 px, frontier first

- **Minimap removed**, with the node-size feedback loop it needed (ruling 57) and its Follow-off wiring (ruling 58).
  The breadcrumb, `Home`, `End`, `N` and the Up next jump cover navigation. `onlyRenderVisibleElements` stays off for
  now: fit-view still needs every node measured.
- **Done runs fold.** Under a parent, a run of three or more consecutive children that are `done` or `dropped`, not
  pinned, and finished more than 24 hours ago shows as one row, `✓ n done`. A click opens it; the override key is
  `done:<parentId>`. This applies to the canvas only. The text outline (CLI, MCP, briefing) is unchanged, so the scribe
  still sees every step.
- **Resource count.** In a window under 720 px wide, a card shows one chip inside it, `▤ n`, with the titles in its
  tooltip. A click opens Details. At 720 px and above the chips stay beside the card as today.

## 3. A trail of ended work

Today a session's working tasks leave the window when it ends, and a subagent's badge five minutes after it stops.

- **Kept for 7 days** after the session ends (tasks) or the subagent stops (subagents). Session end no longer deletes
  subagent rows; it marks the ones still running as ended.
- **Shown as the existing `✓ n done` row** on the step. The label grows as needed: `✓ 5 done · 2 unfinished · 2 agents`.
  `unfinished` counts tasks an ended session left pending or in progress. `agents` counts subagents that did real work
  (section 5) and stopped more than five minutes ago.
- **Opened**, the row lists the tasks (unfinished ones hollow and greyed, never pulsing) and the agents with their
  description, model, how long they ran and when they stopped.
- The trail never pins a step open, never pulses, and never counts in plan progress.
- Details lists the same trail with the session's title.

## 4. Session identity, inherited by subagents

Decision: identity belongs to the session, and its subagents inherit it.

- **Slot.** Each tracked session gets the lowest slot no other live session in its project holds, starting at 0. It
  is stored on the session, so the window and the briefing agree. A session that is repointed or revived takes a free
  slot again.
- **Letter.** Slot 0 is `A`, slot 1 is `B`, and so on. It shows on the session chip, the focus badge and the session's
  queue markers.
- **Hue.** Slot 0 keeps today's session clay. Slots 1 to 5 use the five hues that subagent badges use today. Past six
  sessions the hues repeat and the letter tells them apart. They are CSS variables `--family-0` to `--family-5`, so the
  restyle can re-skin them.
- **Subagents** wear the parent's hue and a tag: the parent's letter in lower case plus the subagent's number within
  the session (`a1`, `a2`). The number is given at start and never reused within a session. A subagent's working tasks
  carry the same tag.
- **Removed:** the per-subagent colour slots (`web/src/agentColors.ts`).
- The permission state keeps its red outline; the letter still shows the family.

## 5. What a subagent is for, and quieter readers

- **Purpose.** The pre-tool hook forwards the first sentence of the Agent prompt, clipped to 200 characters. It shows
  as the badge's tooltip, as a second line in Details and in the trail. This amends the live-work note, which said the
  prompt is never forwarded. The text stays in the local database and is pruned with the subagent row.
- **Readers.** Agents of type `Explore`, `Plan` and `claude-code-guide` only read. They get no full badge. Each session
  shows one small row per step, `◇ a · 2 reading`, with their descriptions in its tooltip. Readers leave no greyed
  badge and are not counted in the trail.
- Every other type keeps the full badge: tag, description, model, elapsed time.

## 6. Queue entries owned by sessions

Decision: one list per project whose entries are owned by a session, or by nobody.

- **Shape.** `projects.queue` becomes a JSON array of `{ "node": id, "session": id | null }`. A bare number from the
  old shape reads as an unowned entry. An old build reading the new shape sees an empty queue, which is safe for a
  rollback.
- **Writing.** `queue: #a, #b` in a brief replaces only that session's entries. `later: #c, #d` replaces the unowned
  entries. A node sits in the queue once: claiming it takes it from wherever it was. Owned entries come before unowned
  ones.
- **A session's focus is "now", not "next".** Its focus step is left out of its own numbered list.
- **When a session ends** or goes stale, its entries turn unowned and keep their place ahead of the older unowned ones.
- **Window.** Markers number per owner and wear the family hue: `A①`, `A②`, `B①`. Unowned markers are neutral.
  The Up next area shows one line per live session that has entries, then a `later` line.
- **Text.** The outline prints `Up next: A: #82 → #78 | B: #90 | later: #79`. The briefing prints the reader's own line
  first, as `Up next (you, A): …`.
- **Camera.** With no session working, the frontier is the first owned entry, else the first unowned one.

## 7. Statuses the live layer keeps honest

- **Focus makes a step active.** Setting focus on a `todo` step assigned to Claude sets it `active` in the same write.
- **Paused.** An `active` step assigned to Claude that no live session focuses (directly or through a descendant),
  with no running subagent on it and no task in progress from a live session, draws as paused: a hollow blue marker,
  with "Nobody is on this. Last change <date>" as its tooltip. Display only; the stored status does not change.
- **Age on needs-you.** A `YOU` tag older than 24 hours shows its age (`YOU · 3d`), measured from the step's last
  update. The briefing's needs-you line shows the same age.
- **Old items get checked by Claude.** When a needs-you item is older than 3 days, the briefing adds one line asking the
  session to check with Aiden whether it is already done, and to brief the answer.

## 8. A shorter briefing, and rules that live in one place

- **Rules block:** six lines, at most 1,600 characters with the task command from section 1 written out in full
  (today's block is about 2,400). The full brief template lives in the skill.
- **Line 2** no longer says to follow the skill. It says the rules below are complete and the skill is for opt-in,
  adoption and the full brief format.
- **Labels:** the briefing names the nine labels as words inside the checkpoint line. The glyph list goes.
- **Recently done:** the two steps finished most recently, each with its outcome clipped to 80 characters.
- **Left unfinished:** tasks an ended session left open in the last 7 days, on steps still open, at most three subjects.
- **One "next".** When the queue has any entry, the frontier drops its sibling `Next:` lines.
- **You are session A.** The first line names the reader's letter.
- **Test gates leave the skill.** The label-to-gate table moves into the `inprogress` project's playbook. Labels stay
  as display.
- **Playbooks.** The pasted update rules come out of the `inthink-marathon-v3` playbook.

## 9. Tickets: try the live layer alone first

No code. On the next Versaterm ticket, the project's playbook says the ledger is the plan, the ledger is attached as a
resource on the root, and the session sends no plan briefs. Aiden watches sessions, subagents and working tasks only.
If he misses the plan in the window, a later design reads the ledger's gate table and field lines into read-only
steps. Sigmund and the ledger do not change either way.

## After this plan

- The UI overhaul (#81) resumes with refreshed drafts. The scenario and the character brief are rewritten for
  sections 2 to 7: no minimap, done runs, trail rows, one hue per session family, subagents as smaller kin of their
  session with a tag, readers against workers, per-session Up next lines, and the states working, idle, waiting for
  your OK, ended and paused.
- The taskbar icon (#82) follows.
- The guide (#78) becomes one page, "Reading the window" plus "When something looks wrong", written after the restyle.

## Out of scope

Acting from the window. General direct writes to the plan. A ledger reader. Token or cost figures. Restoring
`onlyRenderVisibleElements`. Cutting or changing the label set. Changing the scribe's model.
