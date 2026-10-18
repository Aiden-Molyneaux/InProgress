# Parked steps, loose tasks and the Backlog view

Step #482. Brainstormed with Aiden on 2026-10-17, starting from Mip's pre-scope framing (r307). Amends the Board spec
(`2026-10-12-board-and-asks-design.md`, sections 2.2, 2.3 and 2.5) where it describes the Backlog.

## Intent

Aiden had Claude build an InThink feature, then decided not to merge it. He wants to keep the work, may come back to it
at no particular time, and wants it somewhere organised in InProgress that is still easy to pull into Next. He also adds
tasks that belong to no phase, and today they pile into #41 Feedback from daily use, which has become a "No phase"
phase holding about 40 unrelated steps.

A phase keeps one meaning: a finishable stage toward a goal, never a category. Work set aside on purpose gets a status,
not a place. Tasks with no phase sit directly under the project root.

While the Backlog is being reworked, the Board shows a short Backlog preview by default, and a full Backlog view holds
every entry, sortable and filterable.

## Goals

- A **parked** status: set aside on purpose, may come back. It carries why, and optionally where the work lives.
- Parked steps are out of the way (not in Next, the preview or the everyday Backlog list) but one click from Next.
- A **Backlog preview** on the Board: up to 5 entries from a phase Aiden picks, or No phase.
- A **full Backlog view** with every open Backlog entry and a Parked group, filterable by phase, label and text, sortable
  by phase, id or age.
- Root-level tasks read as **No phase**, and #41 is retired.

## Non-goals

- No categories or tags. Labels already say what kind of work a step is, phases say which goal it serves, and parked says
  "not now". Revisit only if Aiden keeps typing the same word into the filter.
- No nudges about long-parked steps, from Mip or anywhere else (Aiden, 2026-10-17).
- No change to Shipwright (the scribe's vocabulary, mip-orc's reconcile, the inprogress skill's brief format). The words
  this spec settles are logged on #482 for a Shipwright step.

## Anti-goals

- A phase used as a bucket ("Long-term features", "No phase").
- A preview whose order means nothing (random, or the first five in tree order across the whole project).
- Parked steps leaking back into Next, the briefing's "Ready to claim" or the preview.

## Decisions

Aiden's, 2026-10-17:

1. **Parked is a status**, beside blocked (waits on something named) and dropped (won't be done). The name is parked.
2. **Parking needs a reason.** A parked step shows what it is (title and body), why it was parked, and when.
3. **Where the work lives is optional** (a branch, worktree or commit), shown when given.
4. **It stays where it is in the tree.** It leaves Next, the preview and the everyday Backlog list, and shows in the
   Parked group of the full view.
5. **"to Next" unparks it**: status back to todo, appended to the unowned Next. **Unpark** sends it back to todo in the
   Backlog.
6. **Parking a step with children parks its subtree.** The children keep their own statuses and leave view with the
   parent; one parked card shows. Unparking brings them back as they were.
7. **A phase can be parked**, taking its open steps out of the way together.
8. **No nudges** about long-parked steps.
9. **The preview shows the phase Aiden picks, or No phase**, remembered per project, in tree order. Never random.
10. **The full view is built like All done**: it replaces the Board body, with a back button.
11. **Parked steps are a group at the bottom of the full view's one list** (option A of the mockup), not a tab.
12. **#41 is retired**: its open steps move to the root, #399 Stage 1 window feedback moves to the root as its own phase,
    and #41 closes as done with an outcome.
13. **No categories for now.**

## The parked status

### Data

- `NODE_STATUSES` gains `parked` (`src/core/types.ts`).
- `nodes` gains `parked_reason TEXT NOT NULL DEFAULT ''`, `parked_where TEXT NOT NULL DEFAULT ''` and
  `parked_at TEXT` (null unless parked).
- The `nodes.status` CHECK gains `'parked'`. SQLite cannot change a CHECK in place, so this is the codebase's first
  table rebuild (see "The migration"). The migration follows SQLite's documented procedure: foreign keys off outside
  the transaction, create the new table, copy every row, drop the old, rename, recreate `nodes_project`, `nodes_parent`
  and any other index or trigger on `nodes`, run `PRAGMA foreign_key_check`, commit, foreign keys back on. The migration
  runner (`src/server/db/connection.ts`) needs a way to run one migration with foreign keys off. The database file is
  copied aside before the migration runs.
- `min_reader_version` stays 1 if the previous build reads a `parked` row without throwing (check it on a rollback);
  otherwise bump it and say so in the receipt.

### Rules (server and repo)

A step is **shelved** when it or any ancestor is parked. Only the parked step itself is a row anywhere; shelved
descendants are not.

- **Park** sets status `parked`, `parked_reason` (required, trimmed, non-empty), `parked_where` (optional) and
  `parked_at` (now). Refused for the root, a done or dropped step, and a step already parked. Allowed for any kind,
  phases included, and for a step with children.
- Parking, like dropping, **clears the driver**, **clears the step's open asks**, and takes the step and every shelved
  descendant **out of the Next queue** (stored queue and `liveQueue`). Queue writes refuse a shelved step ("#id is
  parked").
- **Claiming** a shelved step is refused with "#id is parked; unpark it first", as a dropped claim is refused today.
- **Unpark** sets status `todo` and clears the three parked fields. Any write that moves a step's status off `parked`
  clears them too. "to Next" on a parked row unparks and appends to the unowned queue in one transaction.
- **Progress** (`tree.ts` `progress`) leaves parked children out of the total, as it does dropped ones.
- Events: `node.updated` carries the parked fields in `changes`, as any patched column does. The window's event text
  (`web/src/describe.ts`) reads "parked #id: <reason>" and "unparked #id".

### Writes

- MCP `update_node` and the REST node update accept `parked_reason` and `parked_where`. Setting `status: "parked"`
  without a reason is refused with a message naming the field.
- Window: `POST /api/ui/projects/:id/nodes/:node/park` with `{ reason, where? }`, and
  `POST /api/ui/projects/:id/nodes/:node/unpark` with `{ toNext?: boolean }`, under the `guarded` middleware, actor
  `window`, slug-checked like the other window writes.

### Readers

Every reader with an open or closed test decides where parked and shelved fall: `src/core/board.ts` (OPEN),
`src/core/layout.ts`, `src/core/tree.ts`, `src/server/briefing.ts`, `src/server/briefing-scoped.ts`,
`src/server/session-flow.ts`, `src/server/repo/projects.ts` (queue), `src/server/repo/work.ts` (`isClosed`),
`src/server/repo/asks.ts`, `src/server/repo/search.ts`, `src/server/routes/window.ts`, `src/mcp/format.ts` and
`web/src/project/projectOutline.ts` (a second OPEN set). The rule for each: a shelved step is neither open work nor
finished. It is not ready to claim, not queued, not in Now, Next, Needs me or the everyday Backlog, and it does not count
toward progress. Search still finds it.

- **Briefing**: "Ready to claim" and "Up next" leave shelved steps out. A session focused on a parked step is told
  "#id is parked: <reason>".
- **Outline** (`get_outline`, CLI): the line reads `· parked: <reason>`, and a parked step's subtree folds like a
  finished branch unless `full`.
- **Project view and tree canvas**: a parked step shows with a parked marker and its subtree folded.
- **Details**: status "parked", the reason, where (when given) and the date, with Unpark. An open step shows Park….
- **Marker**: a `m-parked` style in `web/src/marker.css`: muted and dashed, no hue, so it reads as neither blocked (red)
  nor dropped.

## The Board's Backlog preview

Replaces the Backlog fold at the foot of the Next column (wide) and the Next band (narrow).

- Header: "Backlog", a phase picker, and "N ›" where N counts every open Backlog entry, parked excluded. "N ›" opens the
  full view.
- Up to 5 Backlog entries whose **phase** is the picked one, in tree order. A step's phase is its nearest ancestor of
  kind `phase`; a step with none has **No phase**. Parked and shelved steps never show.
- The picker lists every phase that has Backlog entries, in tree order, then No phase.
- The choice is kept per project and per browser in localStorage (`ip.backlogPreview.<projectId>`). With no choice, or a
  choice that no longer has entries: the phase of the most recently completed step, if it has entries; else the first
  phase in tree order with entries; else No phase.
- Empty: "Nothing in <phase>" with the picker still there.
- Rows keep today's behaviour: the shared task box, "to Next" on hover, drag into Next.
- The quick-add field stays at the preview's foot and creates the step under the picked phase (the root for No phase).
  This replaces "the Board's Backlog fold (root)" in Board spec 2.5.

## The full Backlog view

Opened from "N ›". Like All done, it replaces the Board body while open, has "‹ Board" to go back, and is a state flag,
not a route.

- Title "Backlog · N".
- **Filter** row: today's text filter (every word in the "#id", title, label or parent title); **Phase** chips, single
  choice: All, each phase with entries, No phase; **Label** chips, any number, a row matches one of them, plus
  "unlabelled". Text, phase and label combine with AND. The filter lasts while the view is open; leaving the view or
  reloading clears it.
- **Sort**: Phase, ID, Age, and the reverse button. Phase and ID are today's (#452). Age orders by `created_at`, oldest
  first. The choice extends `ip.backlogOrder`.
- **Groups** under Phase sort: by immediate parent, as today, with the root's direct children headed "No phase" (today
  they have no heading). Then **Parked · n** at the bottom, holding the parked steps that match the filter, in the same
  order.
- **Rows**: open rows keep "to Next" and "Delete…" (today's rules) and add "Park…", which opens a form inside the row:
  reason (required) and where (optional). Parked rows show "Parked <date>: <reason>" and "where" on a second line, with
  "to Next" and "Unpark". A step with children under it can be parked; the row shows the subtree's open count.
- Quick-add at the foot creates a root step, as the old fold did.
- No drag in the full view (Next is not on screen).

## #41 cleanup

After the build is live, through the scribe (`move_node` and `update_node`, no code):

- Move #41's open steps to the root: #78, #82, #126, #443, #459, #460, #461, #480, and any other open step still there.
- Move #399 Stage 1 window feedback to the root, keeping its children.
- Close #41 as done, outcome: "Retired: it had become the bucket for steps with no phase. Those now sit at the root as
  No phase, and #399 is its own phase." Its done steps stay under it.

## Words for Shipwright

Logged on #482 for a Shipwright step:

- Brief lines: `#id → parked; reason <text>[; where <branch or path>]` and `#id → unparked` (or `#id → todo`).
- The scribe sets `status: "parked"` with `parked_reason` and optional `parked_where` on `update_node`.
- mip-orc's reconcile treats a parked step as neither open nor done: never "ready", never stalled, and never nudged.

## Calls made by Sigmund, not Aiden

- Parked steps are left out of progress totals, as dropped ones are.
- Parking clears open asks and the driver, as dropping does.
- Quick-add in the preview creates under the picked phase.
- The preview's default when nothing is picked (latest completed step's phase).
- Label chips are multi-select; phase chips single-select; no status filter (blocked steps stay in the list as today).
- Age sorts by creation date.
- Grouping stays by immediate parent (the #452 meaning), with the root group named No phase.
- The parked fields are columns on `nodes`, not a resource, so the card and the briefing can read them directly.

## The migration (Aiden, 2026-10-17)

The parked status rebuilds the `nodes` table on the live database, the first rebuild in this codebase. It runs once at
deploy, after a copy of the database file, under the data gates. Aiden approved the rebuild over a `parked_at` flag with
the status left as todo, which would have needed a second check in every reader that treats todo as open.

## Child steps (proposed)

1. ⛁ data: the parked status, its fields and the migration; the repo rules; MCP and REST writes.
2. ⇄ integration: briefing, outline and CLI, claim refusal.
3. ⧉ ui: the Backlog preview, the full Backlog view, Park and Unpark in the view and Details, the parked marker.
4. ¶ docs: the InProgress guide and the Board spec's Backlog sections.
5. ⚒ ops: the #41 cleanup, after the build is live.

1 comes first; 2 and 3 build on it and touch separate files; 4 and 5 come last.
