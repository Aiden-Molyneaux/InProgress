# #543 Ranked Backlog: the inspector in place

Spec: `docs/superpowers/specs/2026-10-20-ranked-backlog-design.md` section 6 (the inspector, Keys and focus), section 5
(Rows: actions and the click), section 8 item 3. Branch `backlog-inspector`, worktree
`.claude/worktrees/confident-moore-784670` (the session's own: the harness refuses writes to another worktree). Label
ui. Builds on #542's plan (`2026-10-21-backlog-page-views-bands-drag.md`): one row part, `ViewRow.tsx`, with the
inspector in its `children`.

## Criteria

- C1 · click a Backlog row (not its handle or a button) · its inspector opens under it (body, facts line, Phase, Label
  and Band selects, the button column) and the row shows the volt edge; a second click closes it; clicking another row
  moves it there. One at a time, in every view.
- C2 · in Soon, pick Someday in the Band select · the row leaves Soon and sits at the bottom of Someday (after Show).
- C3 · press Park… in the inspector, give a reason, Park; open Parked, press Unpark · the step shows in Needs Triage.
- C4 · Enter on a focused row opens its inspector, focus stays on the row; Escape closes it and focus is on the row.
- C5 · change the Phase or the Label select · it saves with no Save button; the row shows the new phase or label chip.
- C6 · Move to top on the third Soon row · it is first in Soon; To Next on a Soon row · it is last in Next up's
  numbered part; Back to Backlog on a Next up row · it returns to its band.

Depth: a list (C1 to C6 as guided steps). e2e covers C2, C3 and C4 (spec 8 item 3); Parvati covers C1 to C6 with #542.

## Decisions (Sigmund's, for the receipt)

- **The inspector is not a row part.** New `web/src/backlog/Inspector.tsx`, drawn in `ViewRow`'s `children`. Per-view
  logic stays in `Backlog.tsx`; pure helpers in `backlogView.ts`.
- **Row actions after this step:** to Next everywhere but Next up and Parked; Keep in Stale; to Next and Unpark in
  Parked. Park… and Delete… leave the row and live in the inspector only.
- **The inspector follows its step while the step is drawn in the open view.** When the step leaves the view (a band
  picked in Needs Triage, Someday folded, parked, deleted, filtered out, view switched) it closes, and
  `useKeepRowFocus` moves focus as today.
- **Focus after an inspector write that redraws the row elsewhere** (Move to top, a band change within Ranked, To Next,
  Back to Backlog): if focus fell to the body, it goes back to the same control in the step's inspector once it is
  drawn (`data-insp` attribute), as in task 6.
- **Select refusals** show an ErrorLine under the selects, never a Toast. Button refusals (To Next, Move to top, Keep,
  Back to Backlog) keep #542's Toast.
- **Phase options:** steps of kind `phase` that are open (todo, active, blocked) and not shelved (`shelvedIds`), in
  tree order, then "No phase" (the project root). If the step's parent is none of those (a goal, a task group), it is
  listed first as its own title so the select shows the truth.
- **Pending dims the row's line, not its inspector**, so the select's busy state is readable.
- **Own-queue rows** (Next up, queued by a session): Band shows Next up; Back to Backlog removes them from the queue;
  Move to top is hidden (their order is the session's).
- **Parked rows** keep their two lines ("Parked 12 Oct: …", "where …") on the row, as #542 draws them. Their inspector
  has the body and the facts line, no selects, and the buttons Unpark (primary), to Next (outline), Open Details ›.

## Files

Owned: `web/src/backlog/Inspector.tsx` (new), `web/src/backlog/Backlog.tsx`, `web/src/backlog/BacklogList.tsx`,
`web/src/backlog/ViewRow.tsx`, `web/src/backlog/backlogView.ts`, `web/src/backlog/useRankedOrder.ts`,
`web/src/api.ts` (two additions), `web/src/styles/backlog.css`, their unit tests, `test/e2e/ui.spec.ts` (Backlog
tests only: the `#542 ranked Backlog` describe at :4076, and any older Backlog-page test that uses the row's Park… or
Delete… or a row click to open Details).

Do not touch: `src/` (server and core), `web/src/board/*`, `web/src/project/*`, `web/src/panels/*`,
`web/src/parts/*`, `ParkForm.tsx` (use as is), `PreviewPanel.tsx`, `backlogPreview.ts`.

## Tasks

### 1. Client writes (`web/src/api.ts`)

After `rankOp`:

```ts
/** The inspector's Label select: sets the step's label, or clears it with null. */
export const labelStep = (projectId: number, slug: string, nodeId: number, label: NodeLabel | null): Promise<UiResult> =>
  postUi(`/api/ui/projects/${projectId}/nodes/${nodeId}/label`, { slug, label });
/** The inspector's Phase select: moves the step to the end of `parent`'s steps (null: No phase, the root). */
export const moveStep = (projectId: number, slug: string, nodeId: number, parent: number | null): Promise<UiResult> =>
  postUi(`/api/ui/projects/${projectId}/nodes/${nodeId}/move`, { slug, parent });
```

### 2. `useRankedOrder.write` returns its result

`write(op, guess = true, quiet = false): Promise<UiResult>`. Unchanged behaviour, except it returns the result, and
with `quiet` a refusal does not call `onStatus` (it still restores the lists, and `'reload'` still reloads). Existing
callers ignore the return value. Update `RankedOrder`'s doc comment.

### 3. Pure helpers (`backlogView.ts`), unit-tested in its existing test file

- `phaseOptions(nodes: TreeNode[], rootId: number, parentId: number | null): { value: number | null; label: string }[]`
  per the Phase decision. `value` null is "No phase" (label `No phase`). Use `buildIndex`, `dfsOrder`, `shelvedIds`
  from `src/core/tree`. A parent that is the root maps to null.
- `phaseValue(rootId: number, parentId: number | null): number | null`: the select's current value (root or null:
  null).
- `moveTopBefore(nodes: TreeNode[], backlogIds: Set<number>, id: number, band: 'soon' | 'someday'): number | null | undefined`:
  the `before` for Move to top in a band: the first member of `bandOrder(nodes, band)` that is not `id`; `undefined`
  (hide the button) when the first member of `bandOrder` that is in `backlogIds` is `id` itself. `backlogIds` is
  `board.backlog`'s ids (unfiltered).
- `nextTopBefore(unowned: number[], id: number): number | null | undefined`: for an unowned Next up row: `undefined`
  when `id` is first (or not there), else `unowned[0]` (the unfiltered unowned queue: `board.next` rows with no owner).

Tests: each helper's edge cases (empty band, the step alone, a hidden queued member first in the band, a shelved phase,
a goal parent, the root parent).

### 4. `Inspector.tsx`

```ts
export function Inspector(props: {
  id: number;
  node: TreeNode;
  /** Open steps under it (openInsideIndex). */
  inside: number;
  /** The row's band as drawn: 'next' for a queued row, a band, or null (Needs Triage). */
  band: BacklogBand | null;
  /** A parked row: no selects. */
  parked?: boolean;
  /** From the Board row: its handoff resource, or null. */
  handoff: ResourceMeta | null;
  /** The step's resources (snapshot.resources with nodeId === id). */
  docs: ResourceMeta[];
  /** When a session last had it as focus, or null. */
  lastSession: string | null;
  phases: { value: number | null; label: string }[];
  /** The current parent as phaseValue maps it (null: No phase). */
  phase: number | null;
  /** Which buttons show (the caller works these out). */
  can: { toNext: boolean; backToBacklog: boolean; moveTop: boolean; keep: boolean; park: boolean; remove: boolean; unpark: boolean };
  /** The Park form or the Delete confirm, when one is open: drawn in place of the button column. */
  panel: ReactNode;
  now: string;
  /** The select writes; each resolves to the UiResult. */
  onBand: (band: 'next' | 'soon' | 'someday') => Promise<UiResult>;
  onPhase: (parent: number | null) => Promise<UiResult>;
  onLabel: (label: NodeLabel | null) => Promise<UiResult>;
  /** The buttons; each gets the element pressed. */
  onToNext, onBackToBacklog, onMoveTop, onKeep, onPark, onDelete, onOpenDetails: (from: HTMLElement) => void;
  onUnpark: (toNext: boolean, from: HTMLElement) => void;
  onOpenResource: (id: number) => void;
  /** Focus the Band select on mount (Needs Triage). */
  focusBand?: boolean;
})
```

Markup (root `div.ip-insp`, `data-act` so `rowClick` ignores clicks in it, `role="group"`,
`aria-label={`Inspector for #${id}`}`):

- `div.ip-insp-main`:
  - Body: `node.body` trimmed non-empty: `div.ip-insp-body` with `<Markdown text={node.body} />`
    (`web/src/panels/Markdown.tsx`), clamped to six lines by CSS (`.clamped`), plus **Show all** (Button ghost sm,
    `aria-expanded`) that removes the clamp; show the button only when the body overflows (measure
    `scrollHeight > clientHeight` in a layout effect, on mount and when the body changes). Empty: `p.ip-insp-nobody`
    "No description".
  - Facts line `p.ip-insp-facts`, items joined by ` · ` separators (`span.sep`, `aria-hidden`): `CREATED 12 OCT`
    (`shortDate(node.createdAt, now)` from `../done/doneGroups`, upper-cased); `LAST SESSION 3D AGO`
    (`ageShort(lastSession, now)` from `../board/text`, upper-cased, plus ` AGO`) or `NO SESSION YET`; `<DocsMenu>`
    when `docs.length > 0` (`web/src/project/DocsMenu.tsx`, label `#${id}`); the handoff chip as
    `button.ip-chip-handoff` drawn as `web/src/board/Marks.tsx:42-55` draws it (text `handoff · <age>`, calls
    `onOpenResource(handoff.id)`), when `handoff`; `${inside} OPEN INSIDE` when `inside > 0`.
  - Unless `parked`: `div.ip-insp-selects`, three labelled native `<select>`s, each
    `<label className="ip-insp-sel"><Eyebrow …>PHASE</Eyebrow><select …></label>` (read `web/src/parts/Field.tsx` and
    `web/src/parts/Eyebrow.tsx`; reuse the classes Field puts on its box at `sm`, so the select looks like a Field sm;
    if those classes do not suit a select, add `.ip-insp-sel select` rules in backlog.css with the same tokens). Each
    has `data-insp="phase" | "label" | "band"` and an accessible name equal to its label (`Phase`, `Label`, `Band`).
    - Phase: options from `phases`; option values are `String(value ?? 'none')`.
    - Label: `NODE_LABELS` as `${LABEL_GLYPHS[l]} ${l}`, then `Unlabelled` (value `none`).
    - Band: `Next up` (next), `Soon`, `Someday`; when `band === null` a first `<option value="" disabled>Choose a band</option>`.
    - Each select is controlled: `value = pending[sel] ?? current`. On change, if that select is busy, ignore it. Else
      set `pending[sel]` to the new value, mark it busy (class `busy`, `aria-busy="true"`, never `disabled`: a
      disabled select drops focus), clear the error, call the write. `'ok'`: clear busy; clear `pending[sel]` when the
      prop value equals it (an effect on the props) or 2 s after the answer, whichever is first. Refused: clear busy and
      `pending[sel]` (the old value is back) and set the error text, shown as `<ErrorLine message={error} />` under
      the selects (`web/src/parts/ErrorLine.tsx`). `'reload'`: the caller's write reloads.
    - `focusBand`: focus the Band select once, on mount.
- `div.ip-insp-acts` (the button column), or `panel` in its place when given:
  - `can.toNext`: **To Next** (`primary`, `md`, `data-insp="tonext"`).
  - `can.backToBacklog`: **Back to Backlog** (`outline`, `data-insp="back"`).
  - `can.moveTop`: **Move to top** (`outline`, `data-insp="top"`).
  - `can.keep`: **Keep** (`outline`, `data-insp="keep"`).
  - `can.unpark`: **Unpark** (`primary`, `data-insp="unpark"`), then **to Next** (`outline`, `data-insp="unpark-next"`).
  - `can.park`: **Park…** (`outline`, `data-park`, `aria-haspopup="dialog"`).
  - **Open Details ›** (`ghost`, `data-insp="details"`).
  - `can.remove`: **Delete…** (`danger`, `sm`, `data-delete`, `aria-haspopup="dialog"`) at the column's foot.
  - Every button guards a double click's second press: `e.detail <= 1 &&`.

Check `web/src/parts/Button.tsx` for the variant and size names and use what exists; if `outline` or `danger` is named
differently, use the existing name and say so in the report.

### 5. `ViewRow.tsx`

- `picked` already adds the class. Add `aria-expanded={picked ?? false}` on the `li`.
- The handle span gets `data-act` so a click on it opens nothing.
- Keys from inside the inspector do not reach the cursor (`ListCursor` already ignores `target !== currentTarget`;
  keep it so).
- Update the doc comment: `children` holds the inspector, an open row's Park form or Confirm sits inside it, a parked
  row's two lines stay.

### 6. `Backlog.tsx`

State: `const [picked, setPicked] = useState<number | null>(null)`, with a `pickedRef` mirror.

- **Opening.** Row click (`onOpen`) toggles: `setPicked((p) => (p === id ? null : id))`, with
  `noteAction('backlog', 'inspect')` (check `noteAction`'s action type accepts it; add it where the type lives if it
  is a union in `web/src/measure.ts`, which you may touch for that one line). The ListCursor open callback (Enter)
  toggles the same way instead of `onOpenNode`. Space on a focused row (`e.target === e.currentTarget`, no modifiers)
  toggles too and `preventDefault`s. Opening keeps focus where it was.
- **Closing.** Escape on the row or anywhere in its inspector, when no Park form or Confirm handled it first (they
  stop propagation already), closes it: `setPicked(null)`, `e.preventDefault()`, `e.stopPropagation()` (so App's
  Escape does not also close Details), and focus the row `li`. With no inspector open on that row, Escape keeps today's
  meaning (do not stop it). Closing also closes that row's Park form or Confirm (`setPanel(null)` when
  `panel?.id === id`).
- **One at a time.** Picking another row closes any open panel that is not its own.
- **Leaving.** In the effect that closes a panel whose row is no longer drawn, also `setPicked(null)` when `picked`
  is not in `rowIds`.
- **Row actions** (`acts`): drop Park… and Delete… from open rows. Parked rows keep to Next and Unpark. Move the
  ParkForm and the Confirm from the row's children into the Inspector's `panel` prop (same props and callbacks).
- **Inspector props per open row:** `band` = `r.band`; `handoff` = `row.handoff`; `docs` from `snapshot.resources`;
  `lastSession`: the newer of `snapshot.stepTouches`' `sessionAt` for the id and the newest `lastSeenAt` among
  `snapshot.sessions` whose `focusNodeId === id` (stepTouches lists banded steps only), else null; `phases` =
  `phaseOptions(snapshot.nodes, snapshot.project.rootNodeId, node.parentId)`; `phase` = `phaseValue(...)`; `can`:
  - `toNext`: `band !== 'next'`; `backToBacklog`: `band === 'next'`;
  - `moveTop`: unowned Next up row: `nextTopBefore(...) !== undefined`; band soon or someday:
    `moveTopBefore(...) !== undefined`; else false;
  - `keep`: `look.stale`; `park`: true; `remove`: `!hasKids(id)`; `unpark`: false.
  Parked rows: `parked`, `band` null, `phases` empty, `can` = `{ unpark: true }` and the rest false.
- **Writes:**
  - `onBand(b)`: `ranked.write({ node: id, to: b, before: null }, true, true)`.
  - `onPhase(parent)`: `moveStep(...)`; `onLabel(l)`: `labelStep(...)`. For both, `'reload'` reloads.
  - To Next: `ranked.write({ node: id, to: 'next', before: null })`. Back to Backlog: `queueOp(projectId, slug,
    { kind: 'remove', node: id })`, a refusal to `onStatus`, `'reload'` reloads. Move to top: unowned Next up
    `ranked.write({ node: id, to: 'next', before })`, Soon or Someday `ranked.write({ node: id, to: band, before })`.
    Keep: the existing `keep` (a no-op move with no guess). Park…: `openPark(id, from)`. Delete…: `askDelete(id)`.
    Unpark and to Next on a parked row: the existing `unpark`. Open Details ›: `onOpenNode(id)`; the inspector stays.
- **Focus follows the step** (`want = useRef<{ id: number; ctl: string } | null>(null)`): before an inspector write
  that can redraw the row elsewhere (band select, To Next, Back to Backlog, Move to top), set
  `want.current = { id, ctl }` with `ctl` the `data-insp` of the control used. An effect with no dependency list: if
  `want.current` is set and `document.activeElement` is `null` or `body`, focus
  `li[data-node="${id}"] [data-insp="${ctl}"]` (else that `li`) when it exists, and clear `want`; if focus is
  elsewhere, clear `want`; clear it when the step is no longer in `rowIds`, and 3 s after it was set (a timer).
- **Needs Triage** passes `focusBand` (view === 'triage').
- **Refocus after a Park or Delete cancel** stays as is: `refocus(id, 'data-park' | 'data-delete')` finds the buttons
  in the inspector (same attributes, still inside the `li`).
- `useListCursor`'s open callback still skips a row whose Park form or Confirm is open (as today).
- Update the component's doc comment.

`BacklogList.tsx`: pass `onOpenResource` through to `Backlog` (add the prop; `BandProps` has its type).

### 7. CSS (`backlog.css`)

- `.ip-bl-row.pending { opacity: .5; }` becomes `.ip-bl-row.pending > :not(.ip-insp) { opacity: .5; }`.
- `.ip-bl-row > .ip-insp`: `grid-column: 1 / -1`; margin `var(--sp-1) calc(-1 * var(--sp-2)) calc(-1 * var(--sp-1))`
  so it meets the row's edges; `background: var(--canvas-2)`; `box-shadow: inset 2px 0 0 var(--volt)`;
  `border: 1px solid var(--line); border-left: 0`; `padding: var(--sp-4)`; `display: grid;
  grid-template-columns: minmax(0, 1fr) 200px; gap: var(--sp-4)`; `cursor: default`. Under
  `@media (max-width: 719px)`: one column.
- `.ip-bl-row.picked { border-bottom-color: transparent; }` so row and panel join.
- Reveal: `@keyframes ip-insp-in { from { clip-path: inset(0 0 100% 0); } to { clip-path: inset(0); } }`,
  `animation: ip-insp-in var(--dur-2) var(--ease-out)`; `animation: none` under
  `@media (prefers-reduced-motion: reduce)`.
- `.ip-insp-main { display: grid; gap: var(--sp-3); min-width: 0; align-content: start; }`.
- `.ip-insp-body`: `max-width: 68ch; font-size: var(--t-body); color: var(--text-muted)`; `.clamped`:
  `display: -webkit-box; -webkit-line-clamp: 6; -webkit-box-orient: vertical; overflow: hidden`.
- `.ip-insp-nobody`: `margin: 0; color: var(--text-dim)`.
- `.ip-insp-facts`: `margin: 0`; mono `--t-detail-sm`, `--text-dim`; `display: flex; flex-wrap: wrap;
  align-items: center; gap: var(--sp-1)`.
- `.ip-insp-selects`: `display: flex; flex-wrap: wrap; gap: var(--sp-3)`; `.ip-insp-sel`: `display: grid;
  gap: var(--sp-1); min-width: 140px`; `select.busy` dimmed as Field's busy box is.
- `.ip-insp-acts`: `display: flex; flex-direction: column; gap: var(--sp-2)`; buttons `width: 100%`;
  `[data-delete]` `margin-top: auto`.
- The rule placing `.ip-park` and `.ip-bl-panel` on a row (`.ip-bl-row > :is(.ip-park, .ip-bl-panel)`) no longer
  applies to open rows; the form and the confirm sit in the button column's place, full width of that column.

### 8. Tests

Unit: task 3's helpers; `useRankedOrder` if it has a test file (the `quiet` flag: no `onStatus` on refusal).

e2e, inside `test.describe('#542 ranked Backlog'` (`test/e2e/ui.spec.ts:4076`), using `openRankedWith`, `rank`,
`blRow`, `soonTitles`:

1. `picking Someday in the inspector's Band select moves the row to the bottom of Someday`: rank three into Soon and
   one into Someday; click the second Soon row's title; the inspector (`group` named `Inspector for #<id>`) is
   visible; `selectOption('someday')` on the inspector's `Band` select; `expect.poll` the Soon titles no longer to
   contain it; press Show; the Someday region's last `.ip-bl-title` is it.
2. `Park then Unpark from the inspector lands the step in Needs Triage`: rank one into Soon; click its row; press
   Park… in the inspector; fill the reason; press Park; the row leaves Soon; open the Parked view; click the row and
   press the inspector's Unpark; open Needs Triage; the step's row is there.
3. `Enter opens the inspector and Escape closes it, with focus on its row`: rank one into Soon; focus its row
   (`row.focus()`); press Enter; the inspector shows and the row is focused; press Tab: focus is inside the inspector;
   press Escape; the inspector is gone and the row is focused.

Fix any existing e2e test the change breaks (a row click now opens the inspector, not Details; Park… and Delete… are
in the inspector): search `ui.spec.ts` for Backlog-page tests that press the row's `Park…` or `Delete…` or click a row
expecting Details, and change their steps to open the inspector first (or press its Open Details ›). Do not change what
they assert.

### 9. Checks Sev runs

From the worktree: `npm run typecheck`, `npm test`, and the Backlog e2e run the way `npm run test:e2e` runs it (read its
script in package.json for the build step and config), with `INPROGRESS_E2E_PORT=4412`, narrowed with
`-g "ranked Backlog"`, plus every other e2e test he changed, by name. Report the raw output.
