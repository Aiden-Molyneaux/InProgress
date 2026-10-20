# The ranked Backlog

Step #539. Written on 2026-10-20 from Aiden's pick of mock E (r364,
`~/.inprogress/resources/inprogress/2026-10-20-ranked-backlog-direction.md`) and his answers to this spec's questions the
same day. Builds on the v3 port spec (`2026-10-18-window-v3-port-design.md`): its parts (§4), its tokens (§2), the
Board's Next and Backlog preview (§7) and the Backlog view #504 built (§9).

*Status: written, waiting on Aiden's approval.*

## 0. Intent, goals, non-goals, anti-goals

### Intent

Aiden wants the Backlog to be the most important page in the window: the one place where he decides what gets done and
in what order. Today the Backlog has no order of its own. Its rows sit in tree order, grouped by phase, and the only
order Aiden sets is Next's queue, which holds a handful of steps. Everything behind the queue is a pile.

Mock E answers that with a ranked list in three bands (Next up, Soon, Someday), saved views with counts (Ranked, By
Phase, Needs Triage, Stale, Parked), drag to rank, and an inspector that opens under the row you pick, so you triage and
rank without leaving the list. Aiden picked E with two changes to its spirit: mouse first, not keyboard first (actions
are buttons you can see), and the finish of the Project view, not the mock's.

A rank is new data. This spec says how it is stored, how it moves, and what every view shows.

### Goals

- **One ranked list of upcoming work**, top to bottom: what the next free session pulls, then what comes soon, then
  what can wait.
- **Ranking is a drag or a click.** Drag a row to its place; or open it and use To Next, Move to top or the Band select.
- **Triage in place.** A new step shows up in Needs Triage; you give it a band, a phase and a label from the inspector
  without opening Details.
- **Nothing rots unseen.** Stale lists the ranked steps nobody has touched in 14 days.
- **One idea of "next".** Next up is Next's queue itself, so the Board and the Backlog never disagree.
- **The Project view's finish:** v3 parts, every state drawn (hover, picked, dragging, drop line, pending, empty,
  refused), at 1600, 720 and 400 px.

### Non-goals

- **Sessions do not rank.** The MCP and the CLI cannot set a band or a rank. Claude's new steps land unranked; Aiden
  ranks. (A later step may let Mip read Soon's order when the queue runs dry; not here.)
- **No title or body editing.** The inspector shows the body; it does not edit it. Step notes and What/Why are #536's.
- **No keyboard-first design.** Keys exist where they cost little (§6), but every action is a visible button.
- **No change to Next's rules.** The queue, own queues, `dragQueue.ts` and the Board's Next column work as today.

### Anti-goals

- Two orders that can disagree (a "Next up" band beside a Next queue).
- A rank that silently resets: a step dragged to #4 must still be #4 tomorrow unless something above it moved.
- Volt on rows that are not Aiden's move: volt stays on the picked row's edge, the primary button and Next up's
  numbers.
- A second row part for this page. The rows are #504's rows, grown, not a new copy.

## 1. Decisions

### Aiden's (2026-10-20)

| # | Question | Answer |
|---|---|---|
| R1 | What is Next up? | Next's queue itself: same steps, same order as the Board's Next column. |
| R2 | Where does a new step land? | Unranked, in Needs Triage, until Aiden gives it a band. |
| R3 | What counts as Needs Triage? | No band, nothing else. A missing label or phase does not count. |
| R4 | When is a step Stale? | A Soon or Someday step untouched for 14 days (§4). |
| R5 | Park and Unpark against the rank | Parking drops its band and rank; Unpark puts it back unranked, in Needs Triage. |
| R6 | By Phase | #504's groups, rows in rank order. The ID/Age sort, the phase strip and the label chips go. |
| R7 | The Board's Backlog preview | Shows the top five of Soon by rank; the phase menu goes. |
| R8 | The steps already open when this ships | All into Soon, in today's tree order. |

### Calls made in this spec, not Aiden's

Each is argued where it sits. Aiden can overturn any at review.

- **Storage is two nullable columns on `nodes`** (`rank_band`, `rank`), not a JSON list on the project (§2).
- **A step Aiden adds in the window lands at the bottom of Soon**; one added by a session (MCP, API) lands unranked
  (§3).
- **Band changes from the inspector put the step at the bottom of the band chosen**; Move to top puts it first in its
  own band (§3).
- **Rank numbers run on across bands**: Next up 1 to 3, Soon 4 to 14, Someday 15 on (§5).
- **Stale rows get a Keep button** that marks them touched without changing anything else (§4).
- **Enter on a row opens its inspector, not Details** (§6). This departs from D4's "Enter opens Details" for this one
  list, because the inspector is this page's detail.
- **Under 720 px there is no drag**; the inspector's buttons do the ranking (§6).
- **The build steps sit under phase #534** (Redesign: a mirror, a backlog, project memory), not #495: #495's non-goals
  rule out a migration (§8).

## 2. Data

### Columns

Migration 15 (or the next free number when it lands; #536 may add one first), only additions:

```sql
ALTER TABLE nodes ADD COLUMN rank_band TEXT CHECK (rank_band IS NULL OR rank_band IN ('soon','someday'));
ALTER TABLE nodes ADD COLUMN rank REAL;
UPDATE nodes SET rank_band = 'soon'
  WHERE parent_id IS NOT NULL AND status IN ('todo','active','blocked') AND kind IN ('task','question');
-- Only nullable columns: v1 to v14 builds can still read and write this schema, so a rollback across it works.
INSERT INTO meta (key, value) VALUES ('min_reader_version', '1') ON CONFLICT(key) DO UPDATE SET value = excluded.value;
```

- **`rank_band`**: `soon`, `someday` or NULL. NULL is unranked (Needs Triage). There is no `next` value: Next up is the
  queue (R1), so queue membership wins over the band. A queued step keeps its band, and when it leaves the queue it goes
  back to where it was.
- **`rank`**: a fractional position within the project, read only within a band. NULL inside a band means "after the
  ranked ones, in tree order". The backfill (R8) sets the band and leaves `rank` NULL, so day one shows today's tree
  order with no recursive SQL. The first rank write in a band gives every NULL-ranked row there a rank in its shown
  order, in the same transaction, before placing the moved step.
- **Placing:** between two neighbours, the midpoint; at the end, the band's highest plus 1; at the top, its lowest minus
  1. When a gap falls under 1e-6 the band renormalises to 1..n, as `insertPositions` and `renormalize` do for
  `nodes.position` (`src/server/repo/nodes.ts:90-115`). A fractional rank changes only the moved row, so its
  `updated_at` alone moves (Stale depends on that).
- **Naming.** `rank_band`, not `band`: the Board already calls its columns bands (`web/src/board/ColumnHead.tsx:3`).
  `TreeNode` gains `rankBand: 'soon' | 'someday' | null` and `rank: number | null`, carried in the snapshot.
- **Why columns and not a JSON list like `projects.queue`:** the rank belongs to the step. Columns travel with it into
  the snapshot and Details, a deleted step takes its rank with it, a backfill is one UPDATE, and a move rewrites one row
  rather than the project's whole list. The queue stays JSON because it also carries an owner per entry.
- **Done, dropped and deleted steps** keep whatever they had; nothing reads it. No cleanup.

### Writes

One new window route, `POST /api/ui/projects/:id/rank`, body `{ slug, op }`:

```ts
type RankOp = { node: number; to: 'next' | 'soon' | 'someday'; before: number | null };
```

- `to: 'next'` is today's queue move (`applyQueueOp`, `src/server/repo/projects.ts:399`) with `before` in the unowned
  queue; the band is untouched.
- `to: 'soon' | 'someday'` takes the step out of the queue if it is there, sets `rank_band`, and places it before
  `before` in that band (null: at the end). One transaction, one `node.updated` event (plus `project.updated` when the
  queue changed), `updated_at` set.
- Refused (409, the window restores the row and shows a Toast, as #504 does): a step that is not open, is shelved, has
  open children, or belongs to another project; a `before` that is not in the band named.

Two window routes the window lacks today; the API already has the writes (`PATCH /api/nodes/:id`, `POST
/api/nodes/:id/move`, `src/server/routes/write.ts:32-33`):

- `POST /api/ui/projects/:id/nodes/:node/label`, body `{ slug, label }` (`null` clears it), through `updateNode`.
- `POST /api/ui/projects/:id/nodes/:node/move`, body `{ slug, parent }` (the phase id, or null for No phase), through
  `moveNode`, placing the step last among the new parent's children. Refused for a parked or shelved parent and for a
  parent that is the step itself or under it (the repo's own checks).

Changes to existing writes:

- **Park** (`parkNode`, and `update_node` with status parked) clears `rank_band` and `rank` on the parked step (R5), in
  the same write that drops it from the queue. Its shelved children keep theirs.
- **Unpark** sets status todo and leaves the band NULL, so the step shows in Needs Triage. Unpark with `toNext` still
  appends it to the queue.
- **Window quick-add** (`POST /api/ui/projects/:id/nodes`) gains an optional `band: 'soon'`; when given, the new step
  goes to the bottom of Soon. The Backlog page, the Board preview and the Project view's "+ Add a step" send it.
  Details' "Add a step under #id" does not (a child of a step is the parent's business). `POST /api/nodes` (MCP
  `add_nodes`) never sets a band (R2).

### Reading it: `deriveBacklog`

A pure function in `src/core/backlog.ts`, beside `deriveBoard`, from the Board and the snapshot, unit-tested like it:

- **Rows** are the Board's Backlog rows (`board.backlog`) and its Next rows. Groups (steps with open children) are not
  rows, as on the Board; their children are.
- **Next up**: `board.next`, in its order. Unowned entries are numbered 1..k; own-queue entries follow under their
  session, unnumbered.
- **Soon** and **Someday**: Backlog rows with that band, by `rank` (NULLs last, in tree order), numbered on from k.
- **Needs Triage**: Backlog rows with no band, newest first (`createdAt`, ties by id).
- **Stale**: §4.
- **Parked**: `board.parked`, newest `parkedAt` first.
- **Counts** for each view, before and after the filter.

## 3. Where steps land and how they move

| Event | Rank after it |
|---|---|
| A session adds a step (MCP, API) | Unranked: Needs Triage |
| Aiden adds a step in the window (Backlog, Board preview, Project view) | Bottom of Soon |
| To Next (inspector), drag into Next up, Board preview drop into Next | End of the unowned queue, or where dropped; band kept |
| Back to Backlog (Board), Band select Soon or Someday on a Next up row, drag out of Next up | Out of the queue; to the band and place chosen, or for back to Backlog its own band and rank (unranked if none) |
| Band select (inspector) | Bottom of the band chosen |
| Move to top (inspector) | First in its own band; first in the queue for a Next up row |
| Drag within or across Soon and Someday | Before the row dropped on |
| Park | Band and rank cleared |
| Unpark | Unranked: Needs Triage (`toNext`: end of the queue) |
| Claimed by a session | Leaves the list for Now; band kept, so it returns to its place if it comes back to the Backlog |
| Done, dropped, deleted | Leaves the list |
| Gains open children (becomes a group) | Leaves the list; its children are ranked or unranked on their own |

Bottom, not top, for a band change: promoting from Someday lands a step just above the Someday line, where Aiden can
see it and drag it higher, and it never jumps ahead of steps he ranked on purpose.

## 4. Stale

A row is Stale when it is in Soon or Someday (not Next up, not unranked) and for 14 days (`STALE_STEP_MS`, beside
`TRAIL_MS` in `src/core/types.ts`):

- its `updatedAt` has not moved (any edit: title, body, label, parent, band, rank, status), and
- no session has had it as focus (its newest `pastSessions` end, or a live session now), and
- no ask was raised on it.

The newest of those three times is the step's "last touched"; Stale shows it as the row's age. On the day this ships
the backfill does not touch `updated_at`, so Stale lists every long-quiet step at once: that is the first clean-up.

**Keep** (ghost `sm`, Stale rows only, in the row's actions and the inspector) sets `updated_at` and nothing else,
through the rank route with the step's current band and place (a no-op move). The row leaves Stale.

## 5. The page

The Backlog view keeps its place on the rail and its route. Top to bottom: the page head, the controls row, the view.

### Page head

As #504's: code block, `BACKLOG` at `--t-h2`, meta `31 OPEN · 4 PARKED`, or `9 OF 31 SHOWN · 4 PARKED` while the
filter is on. Open counts Next up, Soon, Someday and unranked rows.

### Controls row

- **Views** as a `segmented` TabStrip with counts: `RANKED 28`, `BY PHASE 31`, `NEEDS TRIAGE 3`, `STALE 6`,
  `PARKED 4`. The counts follow the filter, so a filter shows where its matches are. The choice is kept per project in
  `ip.backlogView.<projectId>`; Ranked by default.
- **Filter** Field at the right, "Filter…": #504's words-AND rule over `#id`, title, label and parent title, plus the
  phase title. Escape clears it. It applies to whichever view is open.
- #504's sort TabStrip, reverse Button, phase TabStrip and label Chips go (R6), with `ip.backlogOrder`.

### Rows (every view)

#504's one-line row, grown:

| Slot | What | Look |
|---|---|---|
| handle | `⋮⋮`, Ranked view only, 720 px and up | `--text-dim`, `--text` on row hover, `grab` cursor |
| number | the rank, Ranked view only | mono `--t-detail-sm`, a 3ch column; volt for Next up's unowned rows (the Project view's Next mark), `--text-muted` otherwise |
| `#id` | | mono `--t-detail-sm`, `--text-muted` |
| title | | body `--t-body`, `--text`, one line, ellipsis |
| chips | `blocked` where it applies; the label Chip | |
| phase | the phase title, in views that are not By Phase | mono `--t-detail-sm`, `--text-dim`, ellipsis at 18ch |
| age | created, or last touched in Stale | mono `--t-detail-sm`, `--text-dim`, right-aligned |
| actions | on hover and focus within: **to Next** (ghost `sm`) everywhere but Next up and Parked; **Keep** in Stale; **to Next** and **Unpark** in Parked | |

- 36 px tall, a `--line-soft` rule between rows. Hover: `--canvas-3`. Picked (its inspector open): a 2 px volt left
  edge and `--canvas-2`, joined to the inspector below with no rule between.
- Pending (a write in flight): half opacity, actions hidden. Refused: the row goes back, a Toast says why (#504's rule).
- A click anywhere but the handle and the buttons opens the row's inspector; a second click, or picking another row,
  closes it. One inspector at a time.

### Ranked

Three bands, each a head and its rows, `--sp-section` apart:

- **Head:** an Eyebrow glyph and the band's name at `--t-h3` in the display face, a Doto Count at the right, a hairline
  under it, and a mono `--t-detail-sm` hint under the name:
  - `[!] NEXT UP`, hint "The next free session pulls #1". Glyph and Count volt (it is the queue: Aiden's move).
  - `>> SOON`, hint "Drag to rank".
  - `// SOMEDAY`, hint "Folded". **Folded by default**: the head shows **Show 17** (ghost `sm`) in place of rows; the
    fold is kept in `ip.folds.<projectId>` under `someday`.
- **Next up** lists the unowned queue, numbered; then each own queue under an Eyebrow `// QUEUED BY <session title>`,
  unnumbered and not draggable, as the Board's Next does. Empty: "Nothing is queued. Drag a step here, or open one and
  press To Next."
- **Triage notice:** when unranked rows exist, a one-line strip above Next up: `3 new steps to rank` and **Triage ›**
  (ghost `sm`), which switches to Needs Triage. `--canvas-2`, a `--line` edge; no volt.
- **Foot:** a dashed `--line-strong` box, "+ Add a step to Soon…", which opens the quick-add Field in place and creates
  at the bottom of Soon.
- **Empty (no ranked rows at all):** EmptyState "Nothing is ranked yet", with **Triage ›** when unranked rows exist.

### By Phase

#504's groups by immediate parent (`groupByParent`, `web/src/board/backlogOrder.ts:40`), parents in tree order, No
phase last, each under #504's head (`[+] #399 · 3` over the parent's title). Inside a group, rows go in rank order:
Next up rows first (by queue), then Soon, then Someday, then unranked (newest first). Each row shows its band as a
`quiet` Chip (`NEXT`, `SOON`, `SOMEDAY`, `UNRANKED`) in place of the rank number. No drag here: rank in Ranked. Group
foot: "+ Add a step" creating under that parent, at the bottom of Soon.

### Needs Triage

Unranked Backlog rows, newest first. No numbers, no drag. The inspector opens with its Band select focused and empty
("Choose a band"); picking one ranks the step and the row leaves the view. Empty: "Nothing to triage".

### Stale

Stale rows, oldest last touched first, with "untouched 23d" as the age and **Keep** in the row actions. Empty: "Nothing
has gone quiet".

### Parked

#504's parked rows moved into a view: dashed rows (Tile `parked`), "Parked 12 Oct: <reason>" and "where <…>" on a
second line, **to Next** and **Unpark** in the actions. Newest parked first. The inspector here shows the reason and
where in place of the selects, and offers Unpark, to Next and Open Details. Empty: "Nothing is parked".

## 6. The inspector in place

A panel that grows under the picked row, inside the list: `--canvas-2`, the 2 px volt left edge continued from the
row, a `--line` edge on the other sides, `--sp-4` padding. It opens with a 200 ms height reveal (`--dur-2`,
`--ease-out`); under reduced motion it appears. Two columns at 720 px and up (content 1fr, buttons 200 px); one column
below.

**Content column:**

- **Body:** the step's body as Markdown in muted body text (`--t-body`, `--text-muted`), 68ch, cut at six lines with
  **Show all**. No body: "No description", dim.
- **Facts line,** mono `--t-detail-sm`, `--text-dim`, items split by ` · `: `CREATED 12 OCT`, `LAST SESSION 3D AGO`
  (or `NO SESSION YET`), `▤ 2` (opens the docs Menu, as the Project view's), the handoff Chip when it has one (opens the
  viewer), `3 OPEN INSIDE` when it applies.
- **Selects,** in a row, each a native `<select>` styled as a Field `sm` with an Eyebrow label, saving on change (no
  Save button):
  - **Phase:** the project's open, unparked phases in tree order, then No phase. Moves the step (§2).
  - **Label:** the nine labels with their glyphs, then Unlabelled.
  - **Band:** Next up, Soon, Someday (Needs Triage: an empty "Choose a band" first). Next up queues it; the others place
    it at the bottom of that band (§3).
  - While a select's write is in flight it is busy (the Field's busy state); a refusal shows an ErrorLine under the
    selects and puts the old value back.

**Button column,** stacked, full width, `md` (32 px):

- **To Next** (`primary`): hidden on a Next up row, where **Back to Backlog** (outline) takes its place.
- **Move to top** (outline): first in its band; hidden when it already is.
- **Keep** (outline): Stale only.
- **Park…** (outline): opens #504's Park form inside the inspector, replacing the button column (reason required, where
  optional, **Park** `primary`, Cancel).
- **Delete…** (`danger`, `sm`, at the column's foot): only for a step with no children, #504's Confirm.
- **Open Details ›** (ghost): opens Details beside the page; the inspector stays open.

What stays in Details: asks, the outcome, live work, resources beyond the docs Menu, children, the log, adding a child
step. Nothing in the inspector edits title or body (§0).

### Drag

- **Ranked view only, 720 px and up, from the handle only**, so a click or a text selection on the row never starts
  one. HTML5 drag and drop, as the Board's Next (`web/src/board/NextColumn.tsx:153`).
- **Drop targets:** any row in Next up's unowned part, Soon or Someday; the empty Next up band; the folded Someday head
  (drops at the top of Someday). Over a row, the top half drops before it and the bottom half after it (`dropSlot`,
  `web/src/board/dragQueue.ts:35`, generalised to any band).
- **Look:** the dragged row at half opacity; a 2 px volt drop line between rows (the Tile's); a hovered empty band or
  folded head gets a dashed volt edge.
- **Optimistic order:** the list shows the drop at once (as `optimisticNext` does for the queue) and settles on the
  snapshot; a refusal restores it with a Toast.
- **Keys** (cheap, not the design): Alt+Up and Alt+Down on a focused row move it one place within its band, through the
  same route, as the Board's Next does.
- **Under 720 px:** no handle and no drag. To Next, Move to top and the Band select do the ranking.

### Keys and focus

- The rows of the open view are one ListCursor list (§4 of the port spec). Enter or Space on a row opens or closes its
  inspector (a call made here: the inspector is this page's detail; Open Details is one Tab away). Esc closes the
  inspector and returns focus to its row (Esc with no inspector keeps today's meaning).
- Tab from an open row goes into the inspector's selects and buttons, then on to the next row.
- Opening the inspector keeps focus on the row; it does not jump.

## 7. The Board's Backlog preview (R7)

The preview at the foot of Next (port spec §7) follows the rank:

- **Head:** Eyebrow `>> SOON · 11`, then **+ Add** and **Open ›** as today.
- **Boxes:** the first five rows of Soon in rank order, the same compact tiles, each with its rank number in mono
  `--text-muted` in the top slot before `#id`. They drag into Next and open Details, as today.
- **Foot:** "6 more in Soon · Open Backlog ›" when Soon has more than five; "+ Add" creates at the bottom of Soon.
- **The phase menu goes**, with `ip.backlogPreview.<projectId>`.
- **Empty Soon:** "Nothing in Soon", and **Triage ›** when unranked rows exist, which opens the Backlog on Needs Triage.

## 8. Build steps

Under phase #534 (Redesign: a mirror, a backlog, project memory). #495's port spec rules out migrations; this is the
"backlog" of #534's three. They wait on #504 merging, since By Phase and the rows grow out of its code.

1. **⛁ Rank data and writes** (label data): migration 15 with the backfill; `rankBand` and `rank` on `TreeNode`; the
   rank route and its repo function with the queue interplay; the label and move window routes; Park clearing the rank;
   window quick-add's `band`; `STALE_STEP_MS`; `deriveBacklog` in `src/core/backlog.ts`. Gates: data (full strict;
   `min_reader_version` stays 1). Tests: the migration (backfill, rollback reader), every row of §3's table as a repo
   test, `deriveBacklog` units (numbering across bands, NULL ranks in tree order, Stale's three times, triage order).
   Murr on Opus.
2. **⧉ Backlog page: views, ranked bands and drag** (label ui), after 1: the controls row, the five views, the rows,
   Ranked's bands with the triage notice and the Someday fold, drag and Alt+arrows, the quick-add to Soon. #504's sort
   and phase strip go. e2e: dragging a Soon row into Next up queues it (the Board's Next shows it); dragging within
   Soon persists across a reload; a session-added step shows in Needs Triage and the Ranked notice.
3. **⧉ The inspector in place** (label ui), after 2: the panel, the facts line, the three selects, the button column,
   Park and Delete inside it, Keep. e2e: picking Someday in the Band select moves the row to Someday; Park then Unpark
   lands the step in Needs Triage; Esc closes the inspector and focuses its row.
4. **⧉ Board preview follows Soon** (label ui), after 1: §7. e2e: the preview shows Soon's first five in rank order
   and "+ Add" creates at the bottom of Soon.

Parvati reviews 2 and 3 together at 1600, 720 and 400 against this spec and the Project view's finish, with a fixture
holding three queued steps and an own queue, eleven Soon, seventeen Someday, three unranked, two stale, two parked, a
blocked row and a step with open children; every state of §5 and §6 (picked, dragging, drop line on a folded head,
pending, refused, each empty view).

## 9. Left to the builder

- The exact SQL of the "materialise NULL ranks" pass and where it lives in the repo.
- Whether `deriveBacklog` takes the Board or derives it itself.
- The row component's split between #504's `ViewRow.tsx` and a new file, as long as there is one row part.
- How many `pastSessions` the snapshot carries; if it does not reach 14 days back, Stale's session test reads the
  newest session that focused the step from the server instead, and the builder says which in the receipt.
