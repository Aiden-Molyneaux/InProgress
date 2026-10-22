# #515 Sync dashboard: plan

Step #515 (ui, integration). Spec: `docs/superpowers/specs/2026-10-20-library-and-docs-design.md`, Sync at `:212-283`, criteria at `:396-406`. Approved mock: `~/.inprogress/resources/inprogress/2026-10-20-sync-grid-mock.html` (r357; read it, it is the design). Worktree `.claude/worktrees/sync-dashboard`, branch `sync-dashboard` off main 44b1886. #529 built the rail, the routes (`#/lib/sync[/<slug>/<template>]`) and `src/server/sync.ts` (the cached `--check --json` per manifest on `POST /api/ui/library/sync`).

## Criteria (the bar)

- C1 · Open Sync: one row per project with a manifest (today InThink and InProgress), columns in Shipwright's `templates.json` order, grouped under Agents, Skills and Starter kit, each cell drawn as the legend's state (current dot, N behind in orange, pending `!` in alarm, skipped hatched, not adopted dashed, missing/gone/error `!` in alarm).
- C2 · Each row's summary cell reads "N of M", the base and the last sync date. Its action is the open sync step's link, or File sync step; File sync step adds `Sync <project> to Shipwright <sha>` (label docs, at the root) and turns into that step's link.
- C3 · A cell click opens it below the grid with Adaptation (grouped by section heading), Fills (file fills first, marked "this file", then project fills) and Upstream (the commits and their diff); for InThink × skills/sigmund/SKILL.md, Upstream marks a hunk "expect a conflict". The side panel shows base, Shipwright HEAD, behind, last sync, local edits, Read more (the Library page) and Open the project's copy.
- C4 · The No manifest line names InGame, cad-dev-loop and Shipwright (as "is the source").
- C5 · A failing script shows "check failed" on its row with the stderr in the open cell, and the rest of the grid renders.
- C6 · Check now re-runs the check; otherwise a second load within 60 s runs no script.

Depth: a list, walked on a check surface with a copy of the live data.

## Decisions (Sigmund's)

- Every script run stays a UI-token POST (Aiden, #529): the grid's load, Check now (`force`), the diff, File sync step and Open the copy.
- `templates.json` is read as data from the source's folder (the Shipwright path the manifests share), never run.
- The diff route takes only a template listed in `templates.json`, so no request chooses the script's arguments.
- Fills: the file's own fills, marked "this file", then every project fill, the first five shown and "⋯ N more project fills" to expand (the mock). The JSON does not say which project fills a template uses.
- Last sync and "synced in" use the project's `lastSync` (the JSON has no per-file sync commit).
- Local edits: the adaptation's hunk count.
- The Docs adaptation link waits for #530 and is left out. Read more opens the Library page whose `templates` holds this template, in the viewer.
- A sync step is an open (todo or active) step of that project whose title matches `/\bsync\b/i` and also matches `/shipwright/i` or holds an adopted template's path or file name.
- The open cell follows the route: a cell click sets `#/lib/sync/<slug>/<template>`, so a chip from Pages opens the same cell.

## Task 1: server

Files: new `src/core/sync.ts`, `src/core/types.ts`, `src/server/sync.ts`, `src/server/routes/ui.ts`, `src/server/schemas.ts`, tests `test/core/sync.test.ts` (or where core tests live) and `test/slow/library.test.ts`.

`src/core/sync.ts` (pure, shared with #461's digest later):

- `type CellState = 'current' | 'behind' | 'pending' | 'skipped' | 'not-adopted' | 'missing' | 'gone' | 'error'` and `cellState(check: SyncCheck, template: string): { state: CellState; file: SyncFile | null }`: a file in `files` takes its state; else in `skip` is skipped; else not adopted.
- `templateGroup(t)`: `agents/` Agents, `skills/` Skills, `starter-kit/` Starter kit, anything else Other; `groupTemplates(templates)` keeps `templates.json` order within each group, groups in that order.
- `rowSummary(check)`: `{ behind: files with state behind, adopted: files.length, base: the most common base among files (ties: the first), lastSync: check.lastSync }`.
- `syncSentence(rows: SyncRow[])`: one sentence. None behind: "Every project with a manifest is current with Shipwright <head>." Else "<A and B> are behind Shipwright: <sha> <subject>[, <sha> <subject>]." (the distinct commits across their behind files, newest first, at most three, then "and N more") then, per behind project, "<P> has a sync step, #<id>." or "<P> has none." Failed rows: "<P>'s check failed."
- `isSyncStep(title, adopted: string[])` as in the decision above.

Types (`src/core/types.ts`): `SyncRow` gains `syncStep: { id: number; title: string } | null`; `LibrarySync` gains `templates: string[]` (empty when no source is readable) and `source: { slug: string; name: string; head: string | null } | null`. New `SyncDiff = { ok: true; adaptation: DiffHunk[]; upstream: DiffHunk[]; commits: SyncCommit[] } | { ok: false; error: string }` with `DiffHunk = { header: string; section: string | null; conflict: boolean; added: number; removed: number; lines: { kind: '+' | '-' | ' '; text: string }[] }`.

`src/server/sync.ts`:

- `librarySync(ctx, { force })`: `force` skips the cache (still shares an in-flight run). Adds `templates` (read `<source>/templates.json`, its `templates` array of strings; on any failure `[]`), `source` (the noManifest entry marked source, with `head` from the first ok row's `shipwright.head`), and each row's `syncStep`: the project's open steps (status todo or active, not dropped, not parked) whose title `isSyncStep`, the lowest id.
- `syncDiff(ctx, slug, template)`: the row's manifest (refusals as in `checkRow`, same guards, same order); `template` must be in `templates.json` (else `{ ok: false, error }`); runs `template-sync.mjs --diff <template> --json --project <dir>` with the same `run` (20 s). Parses `adaptation` and `upstream` unified diffs into hunks (`@@ -a,b +c,d @@` headers; `+`, `-`, space lines; `\ No newline` dropped). An adaptation hunk's `section` is the last markdown heading (`#` to `######`) at or above line `c` in the project's local copy (read `dir/<file.local>`; null when unreadable or none). An upstream hunk's `section` is the same over the template at Shipwright HEAD (`git -C <source> show HEAD:<template>`, 5 s; null on failure), and `conflict` is true when its index is in any `conflicts[].hunks`. `commits` come from the cached check's file entry (run the check when not cached). Never throws: a failure is `{ ok: false, error }` with stderr.
- `addSyncStep(ctx, slug)`: the row must be ok and behind; title `Sync <project name> to Shipwright <head short sha>`; `addNodes` at the project root with `label: 'docs'`; answers the node. Refuses (409) when the row already has a sync step, answering that step.
- `openCopy(ctx, slug, template)`: the file's `local` from the cached check (run it when not cached), resolved under the project's bound folder (refuse `..` or an absolute `local`); then `openInEditorOrReveal` from `open-path.ts`.

Routes (`src/server/routes/ui.ts`, all `requireUi`, `cache-control: no-store` on reads): `POST /api/ui/library/sync` takes an optional `{ force: boolean }` (schema in `schemas.ts`, strict); `POST /api/ui/library/sync/diff` `{ slug, template }`; `POST /api/ui/library/sync/step` `{ slug }` (201 with `{ node }`); `POST /api/ui/library/sync/open` `{ slug, template }`. Sizes: slug max 200, template max 300, template matches `^[\w./-]+$`.

Tests:

- core: `cellState` for each state; `groupTemplates` order; `rowSummary` base and counts; `syncSentence` for none behind, two behind with and without sync steps, a failed row, more than three commits; `isSyncStep` matches and near misses.
- slow (`test/slow/library.test.ts`, the existing fake Shipwright): the fake script also answers `--diff` with a fixed JSON (an adaptation with two hunks under different headings, an upstream with two hunks and `conflicts: [{ hunks: [1] }]`); assert sections, `conflict` on hunk 1 only, a template not in `templates.json` refused without a run, `force` running again inside 60 s, `templates` and `source` in the sync answer, File sync step adding a docs-labelled step and the next load's `syncStep` naming it, a second File sync step answering 409 with that step, and `openCopy` refusing a `local` with `..`.

## Task 2: the Sync page

Files: `web/src/library/SyncShelf.tsx` (replace the placeholder), new `web/src/library/SyncGrid.tsx`, `web/src/library/SyncCell.tsx` (the open cell), `web/src/library/useLibrary.ts` (a `checkNow` that posts `force`), `web/src/api.ts` (`librarySync(force?)`, `syncDiff`, `addSyncStep`, `openSyncCopy`), `web/src/App.tsx` (pass `onOpenStep(slug, id)` that goes to a step the way the Go to field does, and `openViewer`), `web/src/styles/library.css`, `test/e2e/ui.spec.ts`.

Follow the mock's layout and classes' intent in the window's own tokens and parts (`PageHead`, `Eyebrow`, `Chip`, `Button`, `TabStrip`, `ErrorLine`, `EmptyState`); the orange is `--behind` and `--behind-wash`, alarm is `--alarm`.

- Head: SYN, SYNC, meta: Shipwright `<head>` and its date, "N of M behind".
- Comms slab: `syncSentence(rows)`, and Check now (`Button`, busy while the forced load runs).
- Legend: the five states as in the mock (missing/gone/error share pending's look).
- Grid: a table. Header row: the group names spanning their columns; second header: each template's short name (file name, or folder for SKILL.md: `sigmund`), `title` the full path. A row per manifest project: its name, one cell button per template (`aria-label` "<project> × <template>, <state>", `aria-pressed` when open), the summary cell ("N of M" large, then "base <sha> · synced <d Mon>"), and the action (`syncStep` as a link `#<id>` that calls `onOpenStep`, else File sync step, which posts, then shows the new step's link; an error shows in an `ErrorLine` under the grid). A failed row: its cells empty and inert, the summary reads "check failed" in alarm, and its name button opens the error in the open cell.
- No manifest line: "No manifest" then each name, Shipwright with "is the source".
- Open cell (`SyncCell`), below the grid, for `route.pick`: eyebrow with the state, title `<project> × <template>`, the path line `template <t> → <project>/<local>`. Tabs (`TabStrip`): Adaptation (`+added −removed` totals), Fills (count), Upstream (commit count), as the state allows (skipped: only "In the skip list: never synced"; current: Adaptation and Fills; not adopted: "Not adopted"). Adaptation: hunks grouped by `section`, each `+`/`-` line coloured, context lines dim, long groups cut at 12 lines with "⋯ N more lines". Upstream: the commits (sha, subject, date), then the hunks with "expect a conflict" on a `conflict` hunk. Fills: a table Placeholder, Scope ("this file" or "project"), value (cut with ellipsis, full in `title`). The diff loads when the cell opens (`syncDiff`), with Loading… and an `ErrorLine` on failure. Side panel: Base, Shipwright, Behind, Synced in, Local edits, then Read more (the Library page whose `templates` holds this template, from `lib.pages`, opened with `onOpenResource`) and Open the project's copy (`openSyncCopy`, an error as a toast via the existing `onStatus` or an `ErrorLine`).
- Escape with focus in the open cell closes it (route back to `#/lib/sync`) and focus returns to the cell button.
- Under 720 px the grid scrolls sideways inside its own box; the open cell stacks the side panel under the tabs.

e2e (one test, beside the Library tests, reusing `libraryRepo` and extending its fake script to answer `--diff`): the Sync page shows the row with its cells in order and a behind cell; the summary reads "1 of 1"; a cell click opens Adaptation with a section heading, Upstream marks "expect a conflict"; File sync step turns into a `#<id>` link; a project whose script exits 2 shows "check failed" while the other row renders. Keep the test's projects few, and do not leave the rail taller than the tab drag tests can bear (#529 learned this: run the whole e2e file before the receipt).

## Checks

`npm run typecheck`, `npm test`, `npm run test:slow -- test/slow/library.test.ts`, and the whole e2e file in file order on a port from 4410 to 4419 (`node scripts/build-to.mjs .build` then `INPROGRESS_E2E_PORT=<port> npx playwright test`), not only the new test.
