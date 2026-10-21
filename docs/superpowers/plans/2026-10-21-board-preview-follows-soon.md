# #544 Board preview follows Soon: plan

Spec: `docs/superpowers/specs/2026-10-20-ranked-backlog-design.md` section 7 and section 8 item 4. Label ui. Worktree
`.claude/worktrees/board-preview-soon`, branch `board-preview-soon`.

## Criteria

- C1 · open a project's Board · the preview at the foot of Next reads `>> SOON · N` with + Add and Open ›, and no phase
  menu.
- C2 · rank a Soon step to the top · the preview shows Soon's first five in rank order, each tile with its rank number
  (mono, `--text-muted`) before `#id`, the same numbers the Backlog's Ranked view gives (deriveBacklog's).
- C3 · + Add, type a title, Enter · the step is created at the bottom of Soon; the field stays open and focused; Escape
  closes it and focus returns to + Add.
- C4 · Soon holds more than five · the foot reads "N more in Soon" with Open Backlog ›.
- C5 · Soon is empty · "Nothing in Soon", and Triage › when unranked rows exist, which opens the Backlog on Needs Triage.

## Decisions

- Rows: `deriveBacklog(board, snapshot, now).soon`, kept to the steps in the Board's Backlog cell (`queue.backlog`,
  which is pending-aware), so a step with an ask or an unattended active step still shows once. The count is that kept
  list's length. Numbers are deriveBacklog's `number`, so they run on from Next up's unowned count.
- Triage ›: shown only on an empty Soon when the Backlog cell holds an unranked step. It saves
  `ip.backlogView.<projectId>` = `triage` (#542's key, spec section 5 Controls row) through `web/src/storage.ts` `save`,
  then opens the Backlog. #542 reads the key when the page mounts.
- Quick-add: `parent` null (the root), `band: 'soon'`, label "Add a step to Soon".
- `ip.backlogPreview.<projectId>` is no longer read or written. The old value is left in localStorage.
- The e2e seed ranks '3 RevenueCat' to '7 Launch' into Soon in tree order, so tests that use preview tiles keep working.

## Files

Yours: `web/src/backlog/PreviewPanel.tsx`, `web/src/backlog/backlogPreview.ts`, `web/src/board/NextColumn.tsx`,
`web/src/styles/board.css` (preview rules only), `web/src/board/BoardTile.tsx` (one optional prop), `web/src/api.ts`
(`createStep` only), `web/src/board/QuickAdd.tsx`, `test/web/backlogPreview.test.ts`, `test/e2e/ui.spec.ts`.

Not yours: `web/src/backlog/Backlog.tsx`, `BacklogList.tsx`, `ViewRow.tsx`, `backlogView.ts`, `useKeepRowFocus.ts`,
`web/src/styles/backlog.css`, `web/src/board/backlogOrder.ts` (do not change its exports), anything under `src/`.

## Tasks

1. `web/src/api.ts`: `createStep(projectId, slug, title, parent, band?: 'soon')` posts
   `{ slug, title, parent, ...(band ? { band } : {}) }`. `QuickAdd` gains `band?: 'soon'` (destructured after `label`),
   passed as createStep's fifth argument.
2. `web/src/backlog/backlogPreview.ts`: delete `previewKey`, `formatPreview`, `parsePreview`, `previewPhase`,
   `previewState`, `previewRows`, `phaseCounts`. Keep `PREVIEW_SIZE`, `PreviewPhase`, `PhaseChoice`, `phaseValue`,
   `backlogPhases` (Backlog.tsx imports the last two). Add:
   - `backlogViewKey = (projectId: number) => \`ip.backlogView.${projectId}\``;
   - `soonPreview(backlog: Pick<Backlog, 'soon' | 'triage'>, boxes: TaskBox[])` returning
     `{ rows: { box: TaskBox; number: number | null }[]; count: number; more: number; triage: boolean }`: `soon` kept to
     ids present in `boxes` (box taken from `boxes`), first PREVIEW_SIZE as rows, `count` the kept length,
     `more = count - rows.length`, `triage` true when any `backlog.triage` row's id is in `boxes`.
   Rewrite `test/web/backlogPreview.test.ts`: keep the `backlogPhases` tests, drop the rest, add `soonPreview` tests
   (rank order and numbers kept, at most five, a Soon row not in `boxes` left out of rows and count, `more`, `triage`
   true and false).
3. `web/src/board/BoardTile.tsx`: optional `number?: number | null`; when it is a number the Tile `id` becomes
   `<><span className="ip-tile-num">{number}</span>{`#${node.id}`}</>`.
4. `web/src/backlog/PreviewPanel.tsx`: props drop `entries`, `choices`, `phase`, `onPick`; add `rows`, `count`, `more`,
   `triage: boolean`, `onTriage: () => void`. Head: `<Eyebrow glyph=">>" className="ip-backlog-name">{`Soon · ${count}`}</Eyebrow>`,
   + Add and Open › as today. No MenuButton. List `aria-label="Soon"`, each BoardTile gets `number`. Empty:
   `<EmptyState>Nothing in Soon</EmptyState>` and, when `triage`, a ghost sm Button glyph › "Triage" calling onTriage.
   Foot: `{more} more in Soon` and Open Backlog ›. QuickAdd: `parent={null} band="soon" label="Add a step to Soon"`.
   Update the doc comment.
5. `web/src/board/NextColumn.tsx`: drop `stored`, `pickPhase` and the `previewState` call and imports. Compute
   `const preview = soonPreview(deriveBacklog(board, snapshot, now), backlog)`. `onTriage`:
   `noteAction('backlog', 'triage'); save(backlogViewKey(project.id), 'triage'); onOpenBacklog?.()`.
6. `web/src/styles/board.css`: `.ip-tile-num` (mono, `--text-muted`, a `--sp-2` gap before `#id`); a rule for the empty
   state's Triage button if it needs one. Remove rules only the phase menu used.
7. `test/e2e/ui.spec.ts`:
   - `seed()`: after the project is built, rank '3 RevenueCat' to '7 Launch' into Soon in that order with
     `POST /api/ui/projects/<project id>/rank` `{ slug, op: { node, to: 'soon', before: null } }`. The route needs
     Origin `http://127.0.0.1:<port>`, `content-type: application/json` and `x-ip-ui-token`, read from the
     `meta[name="ip-ui-token"]` content of `GET /` (a `uiHeaders(api)` helper, cached per api context).
   - Remove `phasePicker`, `phaseMenu`, `pickedPhase`, `showPhase` and every use (lines near 495, 2590-2643, 2860,
     4112-4180): delete the two phase-menu tests ("the Backlog phase menu picks a phase..." and "the Backlog preview
     falls back when its remembered phase has no entries"); where another test only used a phase pick to reach rows,
     reach them through Soon instead.
   - Replace "the Backlog preview shows the picked phase and opens the full view" with
     **"the Backlog preview shows Soon's first five in rank order and + Add creates at the bottom of Soon"**:
     rank '7 Launch' before '3 RevenueCat' (windowPost); expect titles 7,3,4,5,6, `.ip-tile-num` 1..5, head
     `Soon · 5`, no "more" line; + Add, type "Quick soon step", Enter: head `Soon · 6`, "1 more in Soon", field focused
     and empty; Escape: field gone, + Add focused; "to Next" on '3 RevenueCat': titles 7,4,5,6,"Quick soon step",
     numbers 2..6, head `Soon · 5`; Open › opens `.ip-backlogview` and posts `backlog_open`.
   - New **"an empty Soon says so and Triage › opens the Backlog on Needs Triage"**: rank the five and 'Milestones' to
     someday; expect "Nothing in Soon" and no Triage button; add an unranked step through the session API; Triage ›
     appears; click it: `.ip-backlogview` visible and `localStorage['ip.backlogView.<id>']` is `triage`.
   - Fix other assertions on the old head or list name (`Backlog: Road to market` becomes `Soon`; the preview tile's
     `.p-tile-id` now holds the number too).

## Checks

From the worktree: `npm run typecheck`, `npm test`, then the e2e as `npm run test:e2e` runs it, with
`INPROGRESS_E2E_PORT=4411`: first the new and changed tests with `-g`, then the whole `test/e2e/ui.spec.ts` once.
