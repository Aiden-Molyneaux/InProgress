# #542 Backlog page: views, ranked bands and drag

Spec: `docs/superpowers/specs/2026-10-20-ranked-backlog-design.md` sections 3, 5 and 6 (Drag, Keys and focus; not the
inspector), section 8 item 2. Branch `ranked-backlog-page`, worktree `.claude/worktrees/agitated-nash-74b9c6` (the
session's own: the harness refuses writes to another worktree). Label ui.

## Criteria

- C1 · open the Backlog · it opens on Ranked: `[!] NEXT UP` (numbered, volt), `>> SOON`, `// SOMEDAY` folded with
  **Show N**; the views strip reads RANKED, BY PHASE, NEEDS TRIAGE, STALE, PARKED with counts.
- C2 · drag a Soon row by its handle into Next up · it shows there at once, stays after the snapshot, and the Board's
  Next lists it.
- C3 · drag a Soon row to another place in Soon, reload · the new order holds.
- C4 · a session adds a step (API) · it shows in Needs Triage and Ranked shows "1 new step to rank" with **Triage ›**,
  which opens Needs Triage.
- C5 · type in Filter · every view's count follows; the meta reads `N OF M SHOWN`; Escape clears it.
- C6 · Alt+Down on a focused Soon row · it moves one place down and keeps focus.

## Decisions (Sigmund's, for the receipt)

- **One row part.** `ViewRow.tsx` stays the only row. It grows optional slots: `handle` (drag props for a `⋮⋮` span),
  `number` (`{ value, volt }`), `band` (the By Phase chip), `picked` (class only, for #543) and `children` (a
  full-width block under the line, already there: #543 renders the inspector there). All per-view logic lives in
  `Backlog.tsx` and a new `useRankedOrder.ts`; pure helpers in `backlogView.ts`.
- **Until #543 lands**, a row click and Enter still open Details, and Park… and Delete… stay in the row actions (no
  regression on main between the two steps). #543 replaces both with the inspector.
- Next up rows carry Park… and Delete… only (no to Next). Stale rows add **Keep**. Parked rows: to Next, Unpark.
- The page-foot QuickAdd in `BacklogList.tsx` goes; Ranked's foot and By Phase's group foots replace it.
- 720 px is the viewport (`@media (max-width: 719px)` hides the handle; no handle, no drag).
- The Someday fold lives in `ip.folds.<projectId>` under key `someday`: `web/src/project/projectFolds.ts`'s
  `KEY_PATTERN` widens to `/^((section|done):\d+|someday)$/` so the Project view keeps it.

## Files

Owned: `web/src/backlog/Backlog.tsx`, `BacklogList.tsx`, `ViewRow.tsx`, `backlogView.ts`, `useKeepRowFocus.ts`,
new `web/src/backlog/useRankedOrder.ts`, `web/src/styles/backlog.css`, `web/src/project/projectFolds.ts` (the one
pattern), `web/src/api.ts` (two additions below), `web/src/board/QuickAdd.tsx` (a `band` prop), their unit tests,
`test/e2e/ui.spec.ts` (Backlog view tests only).

Do not touch: `web/src/backlog/PreviewPanel.tsx`, `web/src/backlog/backlogPreview.ts`, `web/src/board/NextColumn.tsx`,
`web/src/styles/board.css`, `web/src/board/backlogOrder.ts` (import its helpers freely; change and delete nothing),
anything under `src/`. #544 is editing those in parallel.

## Tasks

### 1. Client writes (`web/src/api.ts`, `web/src/board/QuickAdd.tsx`)

Exactly this (sent to #544, so the merge is clean):

```ts
/** Quick-add: a todo step under `parent`, or under the root when null; with band 'soon', at the bottom of Soon. */
export const createStep = (projectId: number, slug: string, title: string, parent: number | null, band?: 'soon'): Promise<UiResult> =>
  postUi(`/api/ui/projects/${projectId}/nodes`, { slug, title, parent, ...(band ? { band } : {}) });
```

and right after `queueOp`:

```ts
/** One rank change (ranked Backlog spec section 2): to Next, or into Soon or Someday before a step of that band. */
export const rankOp = (projectId: number, slug: string, op: RankOp): Promise<UiResult> => postUi(`/api/ui/projects/${projectId}/rank`, { slug, op });
```

`RankOp` joins the type import from `../../src/core/types`. `QuickAdd` gains `band?: 'soon'`, passed as the fifth
argument.

### 2. Pure helpers (`web/src/backlog/backlogView.ts`), unit-tested

Remove `phaseTabs` and `PhaseTab` (check nothing else uses them). Add:

- `viewKey(projectId) = 'ip.backlogView.<id>'`; `parseView(raw): BacklogView` (unknown or null → 'ranked');
  `BacklogView` comes from `src/core/backlog.ts`.
- `viewTabs(counts)`: TabItems in order ranked, phase, triage, stale, parked, labelled `Ranked`, `By Phase`,
  `Needs Triage`, `Stale`, `Parked`, `count: counts[v].shown` (if the segmented TabStrip does not uppercase, use
  uppercase labels).
- `backlogMatch(query): BacklogMatch | undefined`: undefined for a blank query; else #504's words-AND rule (every
  word, case-folded, found in `#<id>`, the title, the label, or any crumb entry's title, which covers parent and phase).
  Read `filterEntries` in `web/src/board/backlogOrder.ts` for the word rule; do not change it.
- `backlogMeta`: unchanged.
- `type RankLists = { next: number[]; soon: number[]; someday: number[] }` (next = the unowned queue only) and
  `optimisticRank(lists, op: RankOp): RankLists`: take `op.node` out of all three, insert it into `lists[op.to]`
  before `op.before` (at the end when `before` is null or not found).
- `altMove(list: number[], id, dir: 'up' | 'down'): number | null | undefined`: the `before` for a one-place move
  (up: `list[at-1]`; down: `list[at+2] ?? null`); undefined at an end or when absent (no move).

`dropSlot` in `web/src/board/dragQueue.ts` is already list-generic: use it for every band.

### 3. `web/src/backlog/useRankedOrder.ts` (new)

Shaped like `web/src/board/useNextQueue.ts`'s pending logic, over a `Backlog` from `deriveBacklog` (`src/core/backlog.ts`):

- input `{ backlog, snapshot, projectId, slug, onStatus }`; state `pending: RankLists | null`, a ref counting writes in
  flight and a state set of in-flight ids.
- `lists` = pending ?? the server lists (unowned `next` ids = rows with `row.owner === null`, soon, someday).
- On each new snapshot, clear `pending` when the server lists equal it.
- `write(op)`: set pending to `optimisticRank(lists, op)`, mark `op.node` in flight, `await rankOp`, unmark; on 'ok'
  start the 2 s fallback timer that clears pending (as useNextQueue); on a refusal clear pending and `onStatus(result)`;
  on 'reload' reload. `writing()` says any is in flight.
- Returns `order(band)` (the band's `BacklogRow`s in `lists` order; a row the op moved in from another band is taken
  from wherever it was, drawn with that band's look), `write`, `writing`, `isPending(id)`.

### 4. `ViewRow.tsx`

Add the slots of Decisions. Grid becomes `[handle 2ch] [number 3ch] [#id 6ch] [title 1fr] [extras auto]`; handle and
number columns collapse when the list has neither (a modifier class on the list, e.g. `ip-bl-list ranked`). Handle:
`<span className="ip-bl-handle" draggable aria-hidden="true">⋮⋮</span>` with the drag props; its `onDragStart` calls
`e.dataTransfer.setDragImage(li, 16, 18)` so the whole row is the ghost. Band chip: `<Chip tone="quiet">NEXT|SOON|
SOMEDAY|UNRANKED</Chip>` before the label. `dragging` → class `dragging`, `dropBefore` → `drop-before`, `picked` →
`picked`. Age arrives worded.

### 5. `Backlog.tsx` (rewrite) and `BacklogList.tsx`

`Backlog` keeps the query, derives `board` (as BacklogList does now) and `deriveBacklog(board, snapshot, now,
backlogMatch(query))`; `taskBoxes` goes. `BacklogList` loses its QuickAdd.

Page: head (meta: open = `counts.phase.all`, shown = `counts.phase.shown`, parked = `counts.parked.all`), then the
controls row: views `TabStrip variant="segmented" label="Backlog view"` at left, Filter Field at right (keep #504's
Escape). The view persists via `save(viewKey(projectId), view)`. Switching view closes an open Delete or Park panel.

Rows of the open view are one ListCursor list as today (`rowIds` in draw order); Enter opens Details;
`useKeepRowFocus` as today.

- **Ranked:** triage notice when `counts.triage.all > 0` (`1 new step to rank` / `N new steps to rank` + `Triage ›`
  ghost sm, which switches to Needs Triage), then `<section aria-label="Next up|Soon|Someday">` bands: head = Eyebrow
  glyph (`[!]`, `>>`, `//`) + `<h3>` band name + `Count size="h3"` right (volt for Next up), hint line under ("The next
  free session pulls #1", "Drag to rank", "Folded"). Next up: unowned rows numbered (volt), draggable; then each own
  queue under `Eyebrow glyph="//"` `QUEUED BY <sessionDisplayTitle(owner)>`, unnumbered, not draggable. Empty Next
  up: "Nothing is queued. Drag a step here, or open one and press To Next." Soon and Someday rows numbered
  (`--text-muted`). Someday folded unless `loadFolds(projectId).someday === true`: head shows **Show N**; open, **Hide**.
  Foot: dashed box button "+ Add a step to Soon…" that swaps to `<QuickAdd band="soon" label="Add a step to Soon">`;
  Escape puts focus back on the box. No ranked rows at all: EmptyState "Nothing is ranked yet" (+ Triage › when
  unranked exist), foot still shown.
- **Drag (Ranked, handle only):** state `dragging`, `over: { band, before } | undefined`, `overFold`. Over a row of
  unowned Next up / Soon / Someday: `dropSlot(bandIds, rowId, upperHalf, dragging)` gives `before`; over a band's empty
  area or below its last row: `before: null`; over the folded Someday head: `before` = first id of
  `bandOrder(snapshot.nodes, 'someday')` (null when empty), with a dashed volt edge. Drop: op `{ node, to: band,
  before }`; skip when `optimisticRank` leaves the lists unchanged; else `write(op)`. Own-queue rows are no target.
  Drop line: `drop-before` on the row `before` names, `drop-end` on the band list when null.
- **Alt+Up/Down** on a focused unowned Next up, Soon or Someday row: `altMove` over that band's shown ids, `to` its
  own band; repeat guard as NextColumn's `moveKey`. Focus stays on the row.
- **By Phase:** `groupByParent` over `backlog.phase`'s rows (check it keeps input order within a group; if it sorts,
  group here instead), #504's group head, rows with the band chip and no number, no drag; group foot "+ Add a step" →
  `QuickAdd parent={group parent id, or null for No phase} band="soon"`.
- **Needs Triage:** `backlog.triage`, no number, no drag. Empty: "Nothing to triage".
- **Stale:** `backlog.stale`, age `untouched <ageShort(touchedAt, now)>`, actions to Next + **Keep** (`rankOp({ node,
  to: band, before: keepBefore(snapshot.nodes, id) })` through `write`) + Park… + Delete…. Empty: "Nothing has gone
  quiet".
- **Parked:** today's parked rows with to Next / Unpark, from `backlog.parked`. Empty: "Nothing is parked".
- A filter that empties the open view: today's "Nothing matches …" EmptyState with Clear filter, in place of the
  view's own empty line.
- Pending rows (`isPending`, deletes, unparks): half opacity, actions hidden (the existing `pending`).
- Phase column: `parentTitle` in every view but By Phase. Age: `ageShort(createdAt, now)`.

### 6. CSS (`web/src/styles/backlog.css`)

Remove the sort, phase-strip and label-chip rules. Add: rows 36 px with a `--line-soft` rule between, hover
`--canvas-3`; handle (`--text-dim`, `--text` on row hover, `cursor: grab`); number column (mono `--t-detail-sm`, volt
modifier); band head (h3 `--t-h3` display face, Count right, hairline, hint mono `--t-detail-sm` `--text-dim`), bands
`--sp-section` apart; triage notice (`--canvas-2`, `--line` edge); foot (dashed `--line-strong`); `.dragging` opacity
.5; `.drop-before` / `.drop-end` 2 px volt line (copy the Tile's rule); folded head drop: dashed volt edge; `.picked`
2 px volt left edge + `--canvas-2`. `@media (max-width: 719px)`: handle hidden. Use only tokens defined in
`web/src/styles/` (grep each before use).

### 7. Tests

Unit: the `backlogView` helpers (match words-AND incl. a phase title; optimisticRank across bands and with a missing
`before`; altMove at the ends; parseView; viewTabs counts), beside the existing `backlogView` tests.

e2e in `test/e2e/ui.spec.ts`, a new `test.describe('#542 ranked Backlog', ...)`. Seeded steps are unranked, so each
test ranks what it needs through `POST /api/ui/projects/:id/rank` (with the window token, as other window writes in
the file do) or through the window's quick-add to Soon:

1. `dragging a Soon row into Next up queues it, and the Board's Next shows it` (C2): the handle `dragTo` Next up.
2. `dragging within Soon persists across a reload` (C3).
3. `a step a session adds shows in Needs Triage and the Ranked notice` (C4).

Existing tests: the sort test ("the Backlog orders by phase, id or age…") and "the phase TabStrip and a label Chip…"
go. Tests of #504 behaviours that remain (filter, Delete, Park, focus keeping, No phase last, one Tab stop, quick-add
Escape) open **By Phase** first (seeded rows are unranked), or **Parked** where they test parked rows; their quick-add
uses By Phase's group foot. The preview tests ("Backlog preview …", the phase menu) are #544's: change them only where
they assert the full view's default regions.

Run: `npm run typecheck`, `npm test`, and the e2e narrowed with `-g "Backlog"` on a port from 4410 to 4419
(`INPROGRESS_E2E_PORT`).
