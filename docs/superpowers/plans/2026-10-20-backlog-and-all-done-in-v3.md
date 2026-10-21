# #504 Backlog view and All done in v3: plan

Branch `claude/v3-backlog-b5428f`, worktree `.claude/worktrees/v3-backlog-b5428f`, off main 69a202e. Label ui.
Spec: `docs/superpowers/specs/2026-10-18-window-v3-port-design.md` section 9 (862-919), section 12's #504 row.
Handoff: r351. Runs beside #502 (Board) in `.claude/worktrees/v3-board-aa87e5`.

## Criteria (the bar; depth: a list)

- **C1** Open the Backlog view at 1600: the page head (code block, `BACKLOG`, meta `N OPEN · M PARKED`); row 1 the
  filter Field, then at the right the Phase / ID / Age segmented sort and the reverse button; row 2 the phase segmented
  TabStrip (All, each phase, No phase, each with a count) and the label Chips; under Phase sort, groups headed
  `[+] #id · n` over the parent's title; one-line rows (mono `#id`, title, label Chip, age; the phase in mono dim under
  ID or Age sort; `blocked` and `N open inside` where they apply); Parked at the bottom.
- **C2** Pick a phase in the TabStrip and a label Chip: only rows in that phase with that label show, and the meta reads
  `X OF N SHOWN · M PARKED`. Escape in the field clears its text; a filter with no match says
  `Nothing matches "<text>"` with Clear filter, which clears every filter and focuses the field.
- **C3** Hover a row, or Tab into it: to Next, Park… and Delete… (Delete only without children) show. Park… opens the
  form in the row (Park disabled until a reason); Delete… opens a danger Confirm "Delete #id title? It can't be undone.".
  After to Next, Delete, Park or Unpark the row leaves and focus is on the next row (else the previous, else the page
  title). A refused write shows a Toast and the row comes back.
- **C4** Keys: the rows of both views (Backlog groups and Parked included) are one Tab stop; Up and Down move through
  every row, Home and End go to the ends, Enter opens Details. Tab from a Backlog row reaches its actions.
- **C5** All done: head `ALL DONE`, meta `N DONE`, Time / Phase segmented at the right, kept over a reload. By time:
  sections `TODAY · n`, `YESTERDAY · n`, dates, `UNDATED · n`; rows with `HH:MM` in a mono column, `#id`, title, label
  Chip, the parent in mono dim, the outcome on one line under it (whole text in its title). By phase: a section per
  parent, an Eyebrow `n DONE` over the crumb path (`#26 InProgress › #495 Port the window`), the short date on the
  left. Empty: "Nothing done yet".
- **C6** Both views at 1600, 720 and 400: nothing scrolls sideways, rows stay one line at 720 and up, and under 720 the
  row's label, phase and age drop to a second line under the title.

## Decisions (Sigmund, unattended; each goes in the receipt)

- The page head's title is `BACKLOG` / `ALL DONE`, the code block is the project's code (App's `codes`, as the Project
  view), `decodeKey` the project id.
- The phase TabStrip's counts are open entries in that phase, not narrowed by the text or label filter (they say what the
  project holds, so they do not jump while typing). All counts every open entry. A phase holding only parked entries
  shows with 0 (as today's chips list it).
- The meta's parked count is the project's total, filtered or not.
- The no-phase group is headed `[+] TOP LEVEL · n` over "No phase".
- The open row drops today's task box extras the spec does not list: the docs count and the ended-session line.
- Parked rows keep today's date wording (`Parked Oct 12: <reason>`, the existing `shortDate`), and always show their
  parent (or "No phase") in mono dim, as today's parked box does.
- Focus when a row leaves (#499's open question, settled here for these two views): the next row's item, else the
  previous one, else the page title. A pending (deleting) row is passed over.
- All done's by-phase path includes the project root and every step's id.
- `PageHead` gets two additive, optional props (`titleRef`, which makes the title focusable with tabIndex -1, and
  `children`, drawn after the meta). #502 is told through the shared notes folder.

## Files

Owned: `web/src/backlog/Backlog.tsx`, `BacklogList.tsx`, `ParkForm.tsx`, new `web/src/backlog/ViewRow.tsx`,
new `web/src/backlog/backlogView.ts`, `web/src/done/*`, `web/src/styles/done.css` (except `.ip-done-all`, the Board's
link), the full view's and the Park form's rules in `web/src/styles/backlog.css`.
Touched additively: `web/src/page/PageHead.tsx` (two optional props), `web/src/App.tsx` (pass `codes` to BacklogList
and DoneList only).
Not touched: `web/src/board/*`, `board.css`, `PreviewPanel.tsx`, `backlogPreview.ts`, the preview's rules in
`backlog.css` (`.ip-backlog-head`, `.ip-backlog-name`, `.ip-backlog-phase`, `.ip-backlog-head .ip-add`), the Quiet alias
block in `tokens.css` (until merge time; see Task 6).
New CSS uses v3 token names only (`--canvas-*`, `--line*`, `--text*`, `--volt*`, `--alarm*`, `--sp-*`, `--t-*`,
`--font-*`, `--w-*`), never `--bg`, `--muted`, `--border`, `--fs-*` and the rest of the alias block.

## Task 1: helpers, PageHead, ParkForm (Sev)

1. `web/src/backlog/backlogView.ts`, pure, with `test/web/backlogView.test.ts`:
   - `backlogMeta(open: number, shown: number, parked: number, filtering: boolean): { label: string; value: number }[]`:
     `[{value: open, label: 'OPEN'}, {value: parked, label: 'PARKED'}]`, or while filtering
     `[{value: shown, label: 'OF <open> SHOWN'}, {value: parked, label: 'PARKED'}]`.
   - `phaseTabs(phases: {value: number | 'none'; title: string}[], open: Entry[]): TabItem[]`: `all` (count = open.length),
     then each phase in the order given (`id` = String(value), count = open entries whose `phaseOf` is it, or none).
     Labels longer than 24 characters are cut to 23 and `…` (as ProjectView's jump row).
   - `openInside(nodes: TreeNode[], id: number): number`: open (todo, active, blocked) descendants of `id`, all depths.
   - `cursorAfter(row: HTMLElement | null): HTMLElement | null`: inside the row's `.ip-backlogview` or `.ip-donelist`,
     the next `li[data-cursor]:not(.pending)` after it, else the previous one, else the view's `.ip-page-title`. Null
     when the row has no view. (Unit-test the pure parts; this one may be tested through e2e only.)
2. `web/src/page/PageHead.tsx`: optional `titleRef?: Ref<HTMLHeadingElement>`; when given, the h1 gets it and
   `tabIndex={-1}`. Optional `children?: ReactNode`, drawn inside the header after the meta, in a
   `<div className="ip-page-aside">`. `page.css`: `.ip-page-title:focus { outline: none; }` and
   `.ip-page-aside { flex: none; }`. Nothing else in page/ changes.
3. `web/src/App.tsx`: pass `codes={codes}` to `BacklogList` and `DoneList` (as `ProjectView` gets it); their props become
   `ViewProps & { codes?: Map<number, string> }`. No other line in App changes.
4. `ParkForm.tsx` in v3 parts, behaviour unchanged (the draft, held focus, settle, Enter and Escape rules all stay):
   the two fields become `Field size="sm"` with visible `label` "Why is it set aside?" and
   "Where does the work live? (optional)", keeping `aria-label` "Reason" and "Where" off (the label names them now; make
   sure `getByRole('textbox', { name: 'Reason' })`-style selectors in tests still find them: if not, keep an
   `aria-label` of "Reason" / "Where"). Park is `Button variant="primary" size="sm"`, disabled until a reason;
   Cancel `Button variant="ghost" size="sm"` with `data-cancel`. Keep the root `div.ip-park` with its role, label and
   `data-act`. The `.ip-park*` rules in `backlog.css` move to v3 tokens (the form sits on `--canvas-1` with a `--line`
   edge, `--sp-2` gaps). Details uses the same form: check it still renders there.
5. Checks: `npm run typecheck`, `npx vitest run test/web/backlogView.test.ts`.

## Task 2: the Backlog view (Sev)

`BacklogList.tsx`: the root stays `div.ip-donelist.ip-backlogview` (rename `ip-donelist` usage only if done.css no
longer gives it the frame; the frame is `.ip-page`'s, as ProjectView). Structure:

```
div.ip-backlogview > div.ip-page
  PageHead code=… name="BACKLOG" meta=backlogMeta(…) decodeKey=project.id titleRef=heading
  <Backlog … />            (controls, list, parked)
  QuickAdd (as today; onClose focuses the page title)
```

`backlogMeta` needs the shown count, so the filter state lifts into BacklogList, or Backlog renders the head: Sev's
choice is fixed here: **Backlog renders the PageHead** (it already holds the filter), and BacklogList passes it `code`
and the heading ref.

`Backlog.tsx`:
- Row 1 `div.ip-bl-tools`: `Field size="sm"` (aria-label "Filter the backlog", placeholder "Filter…", today's Escape
  rule) growing to fill; then `div role="group" aria-label="Backlog order"` holding `TabStrip variant="segmented"
  label="Sort"` (phase, id, age; labels Phase, ID, Age) and `Button variant="ghost" size="sm" aria-label="Reverse"
  aria-pressed` showing ↑ or ↓, title "Forward order" / "Reverse order" as today.
- Row 2 `div.ip-bl-filters`: `TabStrip variant="segmented" label="Phase" items=phaseTabs(…)`, value `all` when phase is
  null; then `div role="group" aria-label="Label"` of toggle buttons, each `<button type="button" className="p-chip"
  data-tone="quiet" aria-pressed>` with the label's glyph in `span.p-chip-glyph` and the label, plus `unlabelled`.
  Pressed look in backlog.css: volt edge and volt text. Hide the label group when there is no label and no unlabelled.
- Rows `--sp-4` apart: `.ip-bl-tools`, `.ip-bl-filters` and the list sit in a column with `gap: var(--sp-4)`.
- List: `backlogSections` as today. A grouped section is `section.ip-bl-group` (aria-label as today:
  `Backlog under <title>` / `Backlog with no phase` / `Backlog by <order>`), headed by
  `Eyebrow glyph="[+]"` `#<parent id> · <n>` (or `TOP LEVEL · <n>`) over `h3.ip-bl-gtitle` (the parent title or
  "No phase", body face, weight 600, ellipsis, title attribute). Flat sorts: one section, no head.
- Each open row is `ViewRow` (`web/src/backlog/ViewRow.tsx`): `li.ip-bl-row` with `data-node`, the ListCursor item
  props, `aria-busy` while pending, classes `pending` and `confirming`; click opens Details through
  `rowClick('backlog', …)`. Line 1: `span.ip-bl-id` (`#id`, mono, fixed 6ch column), `span.ip-row-title.ip-bl-title`
  (body size, ellipsis, title attribute), `span.ip-bl-phase` (mono dim parent title, ID and Age sorts only), a
  `Chip tone="blocked"` BLOCKED when `node.status === 'blocked'`, a `Chip tone="quiet"` `N open inside` when
  `openInside > 0`, the label as `Chip tone="label" glyph=LABEL_GLYPHS[label]`, `span.ip-bl-age` (`ageShort`), then
  `span.ip-bl-acts` (`data-act`): `Button variant="ghost" size="sm"` to Next, Park… (`data-park`,
  `aria-haspopup="dialog"`), Delete… (`data-delete`, only without children, `aria-haspopup="dialog"`). The actions show
  on `:hover` and `:focus-within`; hidden while pending or confirming. An open Park form or Confirm is a full-width
  block under line 1 inside the li.
- Delete… opens `Confirm` (parts) with `question` "Delete #id title?", `detail` "It can't be undone.", `action` "Delete",
  `danger`; Escape and Cancel close it and refocus the row's Delete… as today; confirm runs today's `remove`.
  Keep today's mouse-down rules (a press on the confirming or parking row outside its panel keeps focus in the panel).
- Parked: `section.ip-bl-group.ip-bl-parked` aria-label "Parked", `Eyebrow` `PARKED · n`, rows `li.ip-bl-row.ip-bl-parkedrow`
  (dashed edge) on the same ListCursor list: line 1 `#id`, title, `span.ip-bl-phase` with the parent or "No phase",
  label Chip, the parked age, actions to Next and Unpark (ghost sm, disabled while busy); line 2 `p.ip-bl-why`
  `Parked <shortDate>: <reason>` and `p.ip-bl-where` `where <…>` when set; `N open inside` as today.
- One `useListCursor([ids.length], open, [ids])` over every drawn row, open groups then Parked, keys `String(id)`; open is
  `onOpenNode`.
- Focus after a row leaves: replace `focusTargetAfter` with `cursorAfter` everywhere in Backlog.tsx (to Next, Delete,
  Park's afterPark, Unpark), keeping today's "only when focus is still in the row or nowhere" guards. The page title
  replaces `.ip-backlogview-title` as the last resort.
- States: no entries at all: the head, `EmptyState` "Backlog is empty", the quick-add; no control rows. No match:
  `EmptyState` with text `Nothing matches “<text>”` (or `Nothing matches this filter`) and action
  `Button variant="ghost" size="sm"` Clear filter (clears all three filters, focuses the field). Pending rows at half
  opacity. Refusals go to `onStatus` as today.
- `backlog.css`: delete the full view's Quiet rules (`.ip-backlogview-title*`, `.ip-backlogview .ip-quick-add`,
  `.ip-backlog-count`, `.ip-backlogview .ip-backlog-tools`, `.ip-chips*`, `.ip-chip*` (not `.ip-chip-handoff`),
  `.ip-parked-row*`, `.ip-st.parked`, `.ip-parked-why/where`) once nothing uses them (grep `web/src`), and add the
  `.ip-bl-*` rules in v3 tokens. Row: `display: grid; grid-template-columns: 6ch minmax(0, 1fr) auto; column-gap:
  var(--sp-3); align-items: center; min-height: 32px; padding: var(--sp-1) var(--sp-2)`, the extras in one auto cell
  (`display: flex; gap: var(--sp-2)`); hover, focus-within and `:focus` give `--canvas-2`; the cursor item's
  `:focus-visible` a 2px `--volt` inset outline. Under 720 px of view (a container query on `.ip-backlogview`), the
  extras cell moves to a second grid row under the title column. Parked rows: `1px dashed var(--line-strong)` edge.
  Leave the preview's rules and `.ip-dparked` alone.
- Checks: `npm run typecheck`, `npm test`.

## Task 3: the Backlog view's e2e (Sev)

`test/e2e/ui.spec.ts` on 69a202e. Rewrite only these tests' selectors and the steps that read the old look, keeping
their behaviour: 2413 (parked from the full view returns to Next), 2464 (orders), 2519 (filter: the "n of total" count
becomes the head's meta `X OF N SHOWN`; phase and label are picked through the TabStrip and the label buttons), 2623
(Delete asks first), 2691 (focus after to Next, Delete, Park, Unpark: focus is now on the neighbouring row's `li`, not a
title button), 2748 (quick-add Escape focuses the page title), 2784 (No phase last; parked with no phase names it).
Run every test that names `.ip-backlogview`, `ip-backlog-group`, `Filter the backlog` or `Backlog order` and fix only
those whose failure comes from this view's new markup. Tests on the Board's preview (`band(page, 'next')`
`.ip-backlog-row`) belong to #502: leave them, they still pass because the preview is untouched.
New, in `test.describe('#504 Backlog view and All done', …)` at the end of the file: "the phase TabStrip and a label Chip
together narrow the Backlog, and the meta says how many are shown" (pick a phase, then a label: rows are only those; meta
`X OF N SHOWN · M PARKED`; Clear filter restores `N OPEN`). Also one keys test: Tab into the list lands on one row, Down
moves across a group boundary into Parked, Enter opens Details.
Run: `INPROGRESS_E2E_PORT=4412`, build with `node scripts/build-to.mjs .build`, then `npx playwright test -g "<name>"`.

## Task 4: All done (Sev)

- `doneGroups.ts`: `byPhase(rows, root)` takes the project's root node (`snapshot.nodes` with `parentId === null`) and
  builds `path` as `[root, ...crumb].map((n) => `#${n.id} ${n.title}`).join(' › ')` (just the root for a top-level step);
  update `test/web/doneList.test.ts`.
- `DoneList.tsx`: `div.ip-donelist > div.ip-page`, `PageHead` (`code`, name `ALL DONE`, meta `[{value: n, label: 'DONE'}]`,
  `titleRef`, children = `TabStrip variant="segmented" label="Order"` Time / Phase, stored in `ip.doneOrder` as today).
  By time: `section.ip-done-sec` per day, `Eyebrow as="h3"` `<HEADING> · n` (Today, Yesterday, the date, Undated).
  By phase: `section.ip-done-sec`, an `Eyebrow` `n DONE` over `h3.ip-done-path` (body face, 600, wraps). Rows
  `li.ip-done-row` with `data-node`, the cursor props, `rowClick('done_list', …)`: grid `7ch minmax(0,1fr)`; left
  `span.ip-done-when` mono (`HH:MM` by time, `shortDate` by phase); right line 1 `span.ip-done-id` mono `#id`,
  `span.ip-row-title` title, label Chip, `span.ip-done-parent` mono dim (by time only); line 2 `p.ip-done-outcome`,
  muted body, one line with ellipsis, `title` its whole text. One `useListCursor` over all rows, keys the ids, Enter
  opens Details. Empty: `EmptyState` "Nothing done yet".
- `done.css`: replace every rule but `.ip-done-all` (and its focus rule) with v3 `.ip-done-*` rules; `.ip-donelist` keeps
  the view's frame (`flex: 1; min-width: 0; overflow-y: auto`) with `.ip-page` inside. Drop `.ip-quote`, `.ip-done-dot`,
  `.ip-outcome-line` once nothing uses them (grep).
- e2e: rewrite 2170 (All done by time and phase, a row opens Details) to the new selectors, and any test naming
  `.ip-donelist-row` or the old toggle. Add to the `#504` describe: "All done reads as a log by time and by phase" (the
  `TODAY · n` heading, the `HH:MM` column, the crumb path with ids, the order kept over a reload).
- Checks: `npm run typecheck`, `npm test`, the narrowed e2e runs.

## Task 5: review (Sigmund)

Full `npm run typecheck`, `npm test`, `test/e2e/ui.spec.ts` in full on 4412. Murr on the diff (Sonnet, high: the diff adds
a confirm and focus moves, so **Opus** for the main pass per the risk list). Parvati at 1600, 720 and 400 with a long
Backlog (three phases, No phase, parked rows with and without where, a step with open children) and a long All done in
both orders, port 4404.

## Task 6: at merge time (Sigmund)

If #502 has landed first: merge main in, unify `ViewRow` with #502's `BacklogRow.tsx` where they overlap, then move every
remaining Quiet token name in `web/src` to its v3 name (spec 2.10's table), delete the alias block at
`web/src/styles/tokens.css:82`, and make the token test show no Quiet name left. If #504 lands first, leave the block and
tell #502 through the notes folder.
