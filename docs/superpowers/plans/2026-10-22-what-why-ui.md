# #536 ui half: notes on quick-add, the proposed chip, What and Why in the window

Step #536 Backlog notes, origin and What/Why on steps. Branch `what-why` (the data half merged at 1b1f902). Contract:
spec `docs/superpowers/specs/2026-10-20-inprogress-redesign-design.md` section 5, Aiden's phase 0 answers at the end of
`2026-10-22-what-why-data.md`. Label ui: typecheck, unit, one e2e test per user-visible feature in
`test/e2e/ui.spec.ts`; no failing-test-first for styling or wording.

## Criteria (checked as a list on a check surface)

- C5 · quick-add: type a title, Enter · the step is added at once, the field clears and keeps focus. Type a title, Tab
  to Notes, type two lines (Shift+Enter between them), Enter · the step is added with the notes as its body; both
  fields clear and focus returns to the title. Escape in either closes.
- C6 · a `proposed` step · its Backlog view row and its Board tile show a `proposed` chip; `asked` and `me` steps show
  none.
- C7 · open the Backlog inspector on a step with What and Why · both show above the body, labelled. A session's step
  without them reads "No What or Why yet" (muted); one of yours shows nothing for them.
- C8 · open Details · it reads: head; What; Why; the status, label and origin row; asks; marks and outcome; resources,
  the handoff first; steps; then a folded TRAIL holding Claude's body, the log and live work. On a step of yours (`me`),
  the body is your notes and shows unfolded, under the head as NOTES.

## Decisions (Sigmund's, named in the receipt)

- Notes show on every quick-add (Board backlog foot, Backlog view, Preview panel, Details' Add a step, Project
  section): one shared component.
- The `proposed` chip goes in `TileFoot`, so every Board tile of a proposed step shows it, not only Backlog-column ones.
- A step of Aiden's own (`me`) keeps its body (his quick-add notes) unfolded in Details; only a session's body is
  Claude's context and folds.
- What and Why are read-only (editing is #568's).

## Tasks

### U1 Quick-add notes

- `src/server/schemas.ts` `windowNodeBody`: `body: z.string().max(20_000).optional()`. `src/server/routes/window.ts`
  quick-add route passes `nodes: [{ title, ...(body?.trim() ? { body } : {}) }]`.
- `web/src/api.ts` `createStep(projectId, slug, title, parent, band?, body?)`: sends `body` only when it has text.
- `web/src/board/QuickAdd.tsx`: a wrapper holding the title input (keeps `inputRef`, class `ip-quick-add`) and a
  `textarea` (class `ip-quick-notes`, `rows={1}`, grows with content up to about 6 lines, placeholder "Notes
  (optional)", aria-label "Notes for the new step"). Enter (not Shift, not composing) in either adds title plus notes;
  Shift+Enter in the notes is a newline; Escape in either closes as today. On `ok`, clear both and focus the title. The
  one-at-a-time guard stays. An empty title with notes does nothing (as today). Style the textarea to match the
  input in each place `.ip-quick-add` is styled (`web/src/styles/*.css`); the pair stacks, title first.

### U2 The proposed chip

- `web/src/backlog/ViewRow.tsx`: a `proposed?: boolean` prop; when true, `<Chip tone="quiet" dashed>proposed</Chip>`
  after the label chip. Both `ViewRow` callers in `web/src/backlog/Backlog.tsx` pass `node.origin === 'proposed'`.
- `web/src/board/TileFoot.tsx`: the same chip, from `row.node.origin`, after the label chip (also on the Done column's
  tiles, where the label is hidden: keep it simple, show it wherever TileFoot draws). `tileFootHas` returns true for a
  proposed step.

### U3 What and Why

- New `web/src/parts/WhatWhy.tsx`: `WhatWhy({ node, className })` draws, for a step with a what or a why, one row per
  field that has text: an `Eyebrow` (`WHAT`, `WHY`) and the text. A field without text, on a step whose origin is not
  `me`, draws a muted "not written yet" in its row. A step with neither: origin `me` draws nothing; any other origin
  draws one muted line "No What or Why yet". Styles in `web/src/styles/panels.css` (shared by the inspector).
- `web/src/backlog/Inspector.tsx`: `<WhatWhy>` first in `.ip-insp-main`, above the body block.

### U4 Details in the reader's order

`web/src/panels/Details.tsx` body (`.ip-dbody`), top to bottom:

1. `<WhatWhy>` (for a `me` step with a body, a NOTES block with the body's Markdown follows it).
2. The `.ip-meta` row as today, plus the origin as a quiet chip (`me` reads "yours", `asked` "asked", `proposed`
   "proposed").
3. The parked block, as today.
4. `AsksSection`.
5. The marks row (handoff chip and marks) and the outcome, as today, without the body.
6. Resources, sorted with `purpose === 'handoff'` first (newest first among them), then the order they came in.
7. Steps (children).
8. A `<details className="ip-dsec ip-dtrail">` folded by default, its summary an `Eyebrow` `TRAIL` with a muted note of
   what is inside (`body · 5 log · live work`, only the parts present). Inside: the body's Markdown (for a step that is
   not `me`), `LiveWork`, then the log list. Absent entirely when it would hold nothing.

Existing e2e or unit tests that read the body, log or live work in Details without opening the fold get the fold
opened first; change none of their expectations otherwise.

### U5 e2e tests (`test/e2e/ui.spec.ts`), one per feature, in the file's style and surface grouping

- quick-add notes (C5): Enter on the title adds; Tab, two lines with Shift+Enter, Enter adds with the body (check via
  the API or Details' fold).
- proposed chip (C6): seed one proposed and one asked step through the API (as the file seeds steps); the chip shows on
  the proposed one's Backlog row and Board tile only.
- inspector What/Why (C7): a seeded step with both shows them; a session step without them shows "No What or Why yet".
- Details order (C8): headings appear in order; TRAIL is folded and opens to the body and log.

## Checks

From the worktree: `npm run typecheck`, `npm test`, and the four new e2e tests plus any touched existing ones, run the
way `npm run test:e2e` does, narrowed with `-g`, with `INPROGRESS_E2E_PORT` from 4410 to 4419. No em dashes.
