# #530 Docs entry in each project's rail entry

Spec: `docs/superpowers/specs/2026-10-20-library-and-docs-design.md`, "A project's Docs view" (290-326) and #530's criteria
(408-414). Design: the mock r359 (`~/.inprogress/resources/inprogress/2026-10-20-project-docs-mock.html` and its two PNGs).
Branch `docs-entry`, label ui.

## Criteria (the bar)

- C1 · Pick any project on the rail · its rail entry lists Docs (code `DOC`) after All done, with "pages · N stale" in orange
  when a page is stale, else "pages · adaptations", else (no manifest) the page count alone.
- C2 · Open Docs on InGame · the index lists its pages (format, title, path, freshness) and, under Adaptations, the dashed
  note that InGame keeps no manifest with a Library · Sync link that opens `#/lib/sync`.
- C3 · Open Docs on InThink and pick Sigmund · the side by side: one row per template section, Shipwright's text with its
  placeholders as chips on the left, InThink's on the right tagged fill, file fill, rewritten or added, untouched sections
  folded into one line, and the orange conflict note on the check surface paragraph. Diff shows the raw adaptation diff.
- C4 · Open InGame's services map · it runs in the sandboxed frame with its freshness strip.

Depth: a list.

## Part A: the rail entry, the index and pages (no #515 dependency)

A1. Server, `src/server/library.ts`: split `libraryPages` into a row reader shared by two callers.
- `listPages(ctx, where: { purpose: 'library' } | { purpose: 'page'; projectId: number })` runs the same SELECT with the
  purpose (and project) as parameters and the same per-row mapping (`readPage`, `adaptedIn`, the ApiError catch).
- `libraryPages(ctx)` keeps its output exactly: `listPages(ctx, { purpose: 'library' })` plus `sourceProjectId`.
- New `projectPages(ctx, projectId): Promise<LibraryPage[]>`.
- Route in `src/server/routes/read.ts`: `GET /api/projects/:slug/pages` answers `{ pages: LibraryPage[] }`, `no-store`;
  an unknown slug is the same typed 404 the other `:slug` routes give.
- `web/src/api.ts`: `projectPages(slug)`.
- Tests: `test/slow/library.test.ts` gains a case: a `page` resource is listed for its project, not in the Library, and
  a `library` one the other way round.

A2. View and rail.
- `web/src/views/view.ts`: `'docs'` joins `View` and `VIEWS` after `'done'`.
- `web/src/chrome/railLogic.ts`: `RailView` gains `text?: string` and `warn?: boolean` (a rail figure that is not a single
  count). `railViews(snapshot, now, docs?: DocsCount | null)` appends `{ view: 'docs', label: 'Docs', code: 'DOC', ...docsFigure(docs) }`.
- Pure `docsFigure({ pages, stale, adaptations })` where `adaptations` is null with no manifest:
  stale > 0 gives `{ text: '<pages> · <stale> stale', warn: true }`; else adaptations non-null gives `'<pages> · <adaptations>'`;
  else `{ count: pages }`. No data yet gives nothing (like the other views before their snapshot).
- A page is stale when its `fresh` is a number above 0 or null ("confirm again"); `undefined` (no covers) is not.
- `adaptations` for the current project: its row in `lib.sync.projects` with `check.ok`, `files.length`; a project in
  `noManifest` (or absent while sync is loaded) is null; while sync has not landed, null.
- `web/src/chrome/Rail.tsx`: where a view's count renders, render `text` when present and mark `data-warn` for the orange
  look the Library's Sync sub-entry already uses. `viewTitle` uses `text` too. Narrow rail and the strip unchanged (codes).
- Unit tests in `test/web/railLogic.test.ts` for the three figure rules and the stale rule.

A3. Data: `web/src/docs/useProjectDocs.ts` loads `api.projectPages(slug)` when the slug changes and again each time the
Docs view opens (the same sequence-number guard `useLibrary` uses). App passes its pages to `railViews`.

A4. `web/src/docs/DocsView.tsx`, rendered by App for `view === 'docs'`:
- `PageHead` with code `<project code>-DOC`, name `DOCS`, and meta: `N PAGES`, then `M STALE` (orange) when any, else
  `M ADAPTATIONS` and `K BEHIND` (orange) with a manifest; then "READ LIVE FROM <first binding>" when there are pages.
- Left, the index (`.ip-docs-index`): **Pages** ("<project>'s repo") rows as the Library's `PageList` rows draw them
  (format chip, title button, path, `freshText`), reusing its row markup through a shared `PageRow` component extracted
  from `web/src/library/PagesShelf.tsx` rather than a copy; no Adapted in chips here. Empty: "No pages yet."
  **Adaptations** ("from its manifest"): one row per `check.result.files` entry in the file's order: kind code
  (`agents/` AGT, `skills/` SKL, else KIT), name (the template's folder for skills, file stem for agents, file name else),
  state (`current`, `N behind` in orange, `pending`/`missing`/`gone`/`error` in alarm), and `N file fill(s)` when the
  file has fills. A failed check shows the error line. No manifest: a dashed note
  "<Project> keeps no .claude/shipwright.json yet. Once it adopts Shipwright's templates, each one is listed here with
  <Project>'s changes to it." with a link "Library · Sync ›" to `#/lib/sync`.
- Below the lists, "+ Register a page": opens the window's existing add-resource form at the project root with kind
  `doc` and purpose `page` preset (find the form's entry point; if it cannot take presets, add optional presets to it).
- Right, the viewer: nothing picked shows a muted line "Pick a page or an adaptation." A picked page renders
  `<ResourceViewer key={id} resourceId={id} inline />` (the freshness strip, sandboxed frame and Markdown come with it).
  A picked adaptation renders `AdaptationView` (Part B; until then a placeholder line naming the template).
- The pick is component state, reset when the project changes; the first page is not auto-picked.
- Styles in `web/src/styles/docs.css`, imported where `library.css` is; two columns over 900 px, stacked under. Tokens
  only, as `library.css` does.

A5. e2e in `test/e2e/ui.spec.ts`: "Docs lists a project's pages and opens one": seed a project with a bound folder holding
`page.md` (with `covers`), register it `purpose: page`; the rail shows Docs with its figure; open Docs, the index lists
the page and the no-manifest note with its Sync link; click the page and its text renders in the viewer.

## Part B: the adaptation side by side (after #515 merges into main and main into this branch)

Reuse, never copy: #515's `syncDiff` (the `--diff --json` run, its cache, `localPathOf`, the upstream placement and
conflict flags) and its section reading.

B1. Server, `src/server/sync.ts`:
- `DiffHunk` gains `line: number | null`, the 1-based copy line `sectionAt` was asked about (null when not located).
- `syncDiff` keeps its route output; its body moves into `readDiff(ctx, slug, template)` that also answers the copy's
  text, the file entry and the manifest row, so the adaptation route reads them once.
- New `POST /api/ui/projects/:slug/adaptation` `{ template }` (UI token, `syncTemplateBody`'s template rule):
  `{ ok: true, base, head, behind, commits, project, template, sections: AdaptSection[], adaptation: DiffHunk[] }` or
  `{ ok: false, error }`. The raw template at base comes from `git -C <shipwright> show <base>:<template>` through `run`
  (label `git`, 5 s). The filled template at base is the copy with the adaptation hunks reversed (B2), so InProgress never
  renders fills itself.

B2. Core, `src/core/sections.ts`, the one section reader:
- `sectionStarts(text)`: level 2 and 3 headings and bold paragraph leads (`**Name.**`, `**Name [edit].**`), fences
  ignored; name normalised by dropping ` [edit]`, the trailing period and case. #515's `sectionAt` is rewritten on it
  (its last heading at or above a line), so there is one reader.
- `unapply(local, hunks)`: the old side of a unified diff whose new side is `local`.
- `sideBySide({ raw, filled, local, fileFills, conflictLines })`: rows in template order, each
  `{ name, template, project, tag, conflict }` with tag `same` (filled equals local, no placeholder), `fill` / `file fill`
  (filled equals local and the raw section has a placeholder; file fill when one is in the file's fills), `rewritten`,
  `removed` (template section not in the copy); copy sections with no template match are `added` rows placed after the
  row they follow in the copy. `conflict` when a conflicting located upstream hunk's line falls in the copy section.
- Unit tests over a small template, copy and diff, plus InThink's Sigmund as a fixture case for the conflict.

B3. Web, `web/src/docs/AdaptationView.tsx`: head (eyebrow `ADAPTATION · <template>`, title `<Name> in <Project>`),
tabs Side by side and Diff, links Shipwright page › (the library page whose `templates` holds it, opened in the viewer)
and Sync cell › (`#/lib/sync/<slug>/<template>`). Strip: "computed live from <project>'s copy, its manifest and Shipwright
at base <sha>", plus "Shipwright is N commit(s) ahead: <sha>" in orange when behind. The table: Section, Shipwright ·
template (placeholders as chips), <Project> (tag chip, then text through `Markdown`). Runs of `same` rows fold into one
line "N sections unchanged" that expands on click. A conflict row carries the orange note "Shipwright changed this
section in <sha>. The next sync conflicts here." Diff renders #515's hunk list component from `SyncCell.tsx` (exported,
not copied).

B4. e2e: "Docs opens an adaptation side by side" on #515's fake Shipwright fixture.

## Checks

`npm run typecheck`, `npm test`, the new e2e tests with `-g`, then the whole `test/e2e/ui.spec.ts` in deploy order
(Aiden, 2026-10-21), on a port from 4410 to 4419.
