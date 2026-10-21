# #529 Library module on the rail: plan

Step #529 (ui). Spec: `docs/superpowers/specs/2026-10-20-library-and-docs-design.md` (Rail, Pages, Roster at `:172-205`; criteria at `:386-394`). Worktree `.claude/worktrees/library-rail`, branch `library-rail` off main bfa2cb4.

## Criteria (the bar)

- C1 · The rail shows a `// Library` group under the projects with one Library row (code LIB). Click it: Pages opens, and Pages, Roster and Sync show under the row. Each keeps its route on reload (`#/lib/pages`, `#/lib/roster`, `#/lib/sync`).
- C2 · The Library row carries the number of projects behind Shipwright, outlined in orange; no count when none are. Sync's sub-entry says "N behind" in orange.
- C3 · Pages lists the library pages grouped by owning project (Shipwright first, then rail order), each with MD or HTML, title, path and freshness. A page with `templates` shows Adapted in chips; a chip opens `#/lib/sync/<slug>/<template>` with that pick named (the Adaptation tab itself is #515's).
- C4 · Roster opens the single roster page directly, in place.
- C5 · From 720 to 1359 px (the 76 px rail) the group shows as codes (LIB, PGS, RST, SYN), and under 720 px the Library row sits in the strip with Pages, Roster and Sync as the page's tabs.

Aiden, 2026-10-21: chips route to Sync with the pick; the server sync check lands here so the count is real; check depth is a list.

## Decisions (Sigmund's)

- Library route state lives in the window, not in `useInProgress`: a hash `#/lib/<shelf>[/<slug>/<encodeURIComponent(template)>]`. The open project's slug stays loaded underneath, so leaving the Library returns to it.
- Any project pick (rail, `[` `]`, 1-9, Go to, ASKS) and any view pick leaves the Library.
- The rail's arrow keys run across project rows and the Library row as one list. The Library row has no menu, no drag and no Alt+arrow move.
- A click on the Library row opens Pages (no-op while the Library is open).
- Roster shows no count. Pages' sub-entry counts the pages shelf.
- Library data loads at mount and again each time the Library opens; nothing polls.
- Check now (a forced re-run) is #515's, as a guarded POST. #529 adds no forced path.
- The orange is a semantic token, `--behind: #ff6b00` (the mock's traxus), with `--behind-wash: rgba(255, 107, 0, 0.08)`; the faction hues stay rules and diamonds only.
- The shipwright path in a manifest must be a folder bound to a non-deleted project, else the row fails without running anything: a repo file never chooses what code runs.

## Task 1: server (types, sync check, pages list, routes)

Files: `src/core/types.ts`, new `src/server/sync.ts`, new `src/server/library.ts`, `src/server/routes/read.ts`, new `test/server/library.test.ts`.

Types (`src/core/types.ts`, after PageBody):

```ts
export type SyncState = 'error' | 'gone' | 'missing' | 'pending' | 'behind' | 'current';
export interface SyncCommit { sha: string; date: string; subject: string }
export interface SyncFile { template: string; local: string; base: string | null; state: SyncState; behind: number; commits: SyncCommit[]; fills: Record<string, string>; detail: string | null }
/** template-sync.mjs --check --json, as Shipwright prints it (#532). */
export interface SyncCheck { shipwright: { head: string; date: string; subject: string }; project: string; lastSync: SyncCommit | null; files: SyncFile[]; skip: string[]; notAdopted: string[]; fills: Record<string, string> }
export type SyncOutcome = { ok: true; result: SyncCheck } | { ok: false; error: string };
export interface SyncRow { projectId: number; slug: string; name: string; dir: string; check: SyncOutcome }
/** GET /api/library/sync. `noManifest`: bound projects with no manifest; `source` marks Shipwright itself. */
export interface LibrarySync { projects: SyncRow[]; noManifest: { projectId: number; slug: string; name: string; source: boolean }[] }
export interface LibraryPage { id: number; title: string; path: string; projectId: number; projectSlug: string; projectName: string; format: 'markdown' | 'html' | null; shelf: 'pages' | 'roster'; templates: string[]; /** Commits to covers since confirmed; null: confirm again; undefined: no covers. */ fresh?: number | null; /** Why the page cannot be read now (gone, refused). */ error: string | null; adaptedIn: { slug: string; name: string; template: string }[] }
/** GET /api/library/pages. */
export interface LibraryPages { pages: LibraryPage[]; sourceProjectId: number | null }
export const projectBehind = (row: SyncRow): boolean => row.check.ok && row.check.result.files.some((f) => f.state === 'behind');
```

`src/server/sync.ts`:

- `manifests(ctx)`: every active, non-deleted project with a binding, first binding by `bindings.id`. Read `<binding>/.claude/shipwright.json` (fs/promises). Missing file: the project goes to `noManifest`. Unparseable JSON: a row whose check is `{ ok: false, error: 'shipwright.json does not parse: …' }`. Answers `{ rows: { projectId, slug, name, dir, shipwright: string, adopted: string[] (keys of files), manifestPath, error? }[], noManifest }`. `source` on a noManifest entry: its first binding equals (normalizePath, case-insensitive) some manifest's `shipwright`.
- `checkRow(ctx, m)`: refuses unless `m.shipwright` passes `isLocalAbsolutePath` and equals (normalized, case-insensitive) the path of a binding of a non-deleted project: error `Shipwright path <p> is not a folder bound to a project`. Runs `execFile(process.execPath, [join(shipwright, 'scripts', 'template-sync.mjs'), '--check', '--json', '--project', dir], { timeout: 20_000, windowsHide: true, maxBuffer: 16 MiB })`. Exit non-zero, timeout or JSON that does not parse (or lacks `files` array): `{ ok: false, error }` where error is stderr trimmed (cap 4000 chars), else `template-sync timed out after 20 s`, else the error message. Never throws.
- Cache: `Map<projectId, { key, at, outcome }>`, key = `JSON.stringify([shipwrightHead, manifestMtimeMs, dir])`, shipwrightHead from `git -C <shipwright> rev-parse HEAD` (5 s timeout; on failure the key uses `''`). Fresh for 60 s. Failures are cached too. In-flight runs are shared per project (a `Map<projectId, Promise>`), so two loads at once run the script once. Export `clearSyncCache()` for tests.
- `librarySync(ctx): Promise<LibrarySync>`: manifests, then every row's check in parallel.
- `adopters(ctx)`: the manifests' rows only, no script: `{ slug, name, adopted }[]`, for Adapted in.

`src/server/library.ts`:

- `libraryPages(ctx): Promise<LibraryPages>`: resources with `purpose = 'library'` whose project is not deleted, joined to project slug and name, ordered by project id then resource id. For each, `readPage` in parallel (from `pages.ts`); on success take `format`, `front.shelf`, `front.templates`, `fresh?.count` (leave `fresh` undefined when `body.fresh` is null); on an `ApiError` keep the row with `error: err.message`, `format` from the extension, `shelf: 'pages'`, `templates: []`. `adaptedIn`: for each template, each adopter whose `adopted` holds it (deduped by slug+template). `sourceProjectId`: the project whose first binding equals a manifest's `shipwright`, else null.

Routes (`src/server/routes/read.ts`, beside the resource routes): `GET /api/library/pages` and `GET /api/library/sync`, both `cache-control: no-store`.

Tests (`test/server/library.test.ts`, the `pages.test.ts` setup style, `GIT_TIMEOUT`): a temp "shipwright" git repo bound to project Shipwright, holding `scripts/template-sync.mjs` that appends a line to a `runs.txt` beside it and prints a fixed JSON (one `behind` file, one `current`); project A bound to a repo with a manifest pointing at it; project B whose manifest points at an unbound folder; project C bound with no manifest. Cases:

1. `/api/library/sync`: A's row ok with the JSON; B's row `ok: false` naming the unbound path and `runs.txt` untouched by it; C and Shipwright in `noManifest`, Shipwright `source: true`.
2. A second GET within 60 s runs the script once (`runs.txt` has one line); two GETs at once run it once.
3. A script that writes to stderr and exits 2 gives `ok: false` with that stderr, and the other rows still answer.
4. `/api/library/pages`: a `library` page with `templates: [agents/sev.md]` (A's manifest adopts it) shows `adaptedIn` [A]; a `shelf: roster` page has shelf roster; a `purpose: page` resource is not listed; a deleted file gives a row with `error`; `sourceProjectId` is Shipwright's.

Checks: `npm run typecheck`, `npx vitest run test/server/library.test.ts`.

## Task 2: window route and rail

Files: new `web/src/library/route.ts`, new `web/src/library/useLibrary.ts`, `web/src/api.ts`, `web/src/useInProgress.ts`, `web/src/chrome/Rail.tsx`, `web/src/chrome/railLogic.ts`, `web/src/App.tsx`, `web/src/styles/tokens.css`, `web/src/styles/rail.css`, new `test/web/libraryRoute.test.ts` (match where web unit tests live: `ls test/web`).

`route.ts`:

```ts
export type Shelf = 'pages' | 'roster' | 'sync';
export interface LibraryRoute { shelf: Shelf; pick: { slug: string; template: string } | null }
export const SHELVES: readonly Shelf[] = ['pages', 'roster', 'sync'];
export function parseLibraryHash(hash: string): LibraryRoute | null; // '#/lib' or '#/lib/' or an unknown shelf: pages. A pick only on sync, both parts present, decodeURIComponent in try/catch (a bad escape: no pick).
export function libraryHash(route: LibraryRoute): string; // '#/lib/sync/<encodeURIComponent(slug)>/<encodeURIComponent(template)>'
```

Unit tests: round trip with a template holding slashes; `#/p/x` is null; unknown shelf is pages; a broken escape drops the pick.

`useInProgress.ts`: the slug effect's hash rewrite (`if (window.location.hash !== `#/p/${slug}`) …`) is skipped while `parseLibraryHash(window.location.hash)` is non-null. Nothing else changes there.

`api.ts`: `libraryPages: () => getJson<LibraryPages>('/api/library/pages')`, `librarySync: () => getJson<LibrarySync>('/api/library/sync')`.

`useLibrary.ts`: `useLibrary(open: boolean)` answers `{ pages: LibraryPages | null; pagesError: string | null; sync: LibrarySync | null; syncError: string | null }`. Loads both at mount and again whenever `open` turns true; a sequence number per kind so an older answer never lands over a newer one; a failed load keeps the last data and sets the error.

`App.tsx`:

- `const [library, setLibrary] = useState(() => parseLibraryHash(window.location.hash))`; a `hashchange` listener sets it from the hash (null for `#/p/…`).
- `openLibrary(route)`: `setLibrary(route)`, `history.replaceState(null, '', libraryHash(route))`.
- `leaveLibrary()`: when `library` is set, `setLibrary(null)` and, with a slug, `replaceState` to `#/p/<slug>`.
- `selectProject = (s) => { leaveLibrary(); state.selectProject(s); }` replaces `state.selectProject` everywhere in App (Rail onSelect, onTab, stepProject, goTo, onAsks). `pickView` calls `leaveLibrary()` first, before its `v === view` early return.
- `const lib = useLibrary(library !== null)`. Rail gets `current={library ? null : state.slug}`, `library={library?.shelf ?? null}`, `onLibrary={(shelf) => openLibrary({ shelf, pick: null })}`, `libraryViews` and `behind` (below).
- In the main pane: when `library` is set, the TabStrip shows the shelves (`label="Library"`, items from `libraryViews`, value the shelf) and the content is `<LibraryView route={library} lib={lib} tabs={tabs} codes={codes} onOpenResource={openViewer} onRoute={openLibrary} />` (Task 3). Details does not render while the Library is open. Projects-empty state unchanged.
- `document.title` reads `InProgress · Library` while the Library is open.

`railLogic.ts`: `export interface LibraryRailView { shelf: Shelf; label: string; code: string; count?: string; warn?: boolean }` and `libraryViews(lib)`: Pages (PGS, count of pages-shelf pages once loaded), Roster (RST, no count), Sync (SYN, `N behind` with `warn` when N > 0, nothing when 0 or not loaded). `libraryBehind(sync)`: count of rows where `projectBehind`, null before the first load. Unit-test both in the existing rail logic test file.

`Rail.tsx`:

- New props: `library: Shelf | null`, `onLibrary: (s: Shelf) => void`, `libraryViews: LibraryRailView[]`, `behind: number | null`.
- After the projects `ul` (and before RowMenu and the foot), a second group: `<Eyebrow glyph="//" className="ip-rail-head"><span className="ip-rail-head-text">Library</span></Eyebrow>` then `<ul className="ip-rail-rows ip-rail-lib" onKeyDown={onRowKey}>` with one `li data-row`: `<a href="#/lib/pages" data-lib className="ip-rail-row" aria-current={library ? 'page' : undefined} style={{ '--rr': 'var(--text-hi)' }} tabIndex=… title="Library" aria-label={behind ? `Library, ${behind} behind Shipwright` : 'Library'} onClick=…>` holding the rule, `ip-rail-name` Library, `ip-rail-code` LIB, and when `behind > 0` `<span className="ip-rail-sig"><span className="ip-rail-behind" title={`${behind} project(s) behind Shipwright`}>{behind}</span></span>`. Click: the browser's own link with a modifier (as `select`), else `preventDefault` and `onLibrary('pages')` unless already open. While open, under it `ul.ip-rail-views aria-label="Library"` with a button per `libraryViews` entry: same markup as the project views (`ip-rail-vlabel`, `ip-rail-vcode`, `ip-rail-n` with `data-warn` when `warn`), `aria-current` on the open shelf, `tabIndex` 0 on the open shelf else -1, `onKeyDown={onViewKey}`, click `onLibrary(shelf)`.
- One list for the keys: `onRowKey` collects `rail.current.querySelectorAll('a[data-tab], a[data-lib]')` (tabs first, then the Library row) and is attached to both `ul`s. For the Library row (`at >= tabs.length`): the menu key does nothing, Alt+arrow is taken and does nothing, Space calls `onLibrary('pages')` unless open, the bare arrows, Home and End move focus as now. Project rows keep every rule they have.
- Roving stop: a key `':lib'` for the Library row. `rowStop` records `{ from: currentKey, slug }` where `currentKey = library ? ':lib' : current`; the stop is the recorded one while `from` matches and it still exists, else `':lib'` when the Library is open, else the current project, else the first row.
- The scroll-into-view effect also runs when `library` changes. Drag and drop ignore the Library list (it has no `data-tab`).

CSS:

- `tokens.css`: `--behind: #ff6b00;` and `--behind-wash: rgba(255, 107, 0, 0.08);` with a comment: the Library's behind-Shipwright signal, never volt.
- `rail.css`: `.ip-rail-behind` (mono, `font-stretch: 75%`, `--t-micro`, `--w-strong`, `padding: 3px 5px`, `line-height: 1`, `border: 1px solid var(--behind)`, `color: var(--behind)`); on the current row border and colour `var(--volt-ink)`; at 76 px `padding: 2px 3px` beside `.ip-rail-ask`. `.ip-rail-n[data-warn] { color: var(--behind); }`. In the strip, the end padding moves from `.ip-rail-rows` to the last list: `.ip-rail-rows { padding-inline-end: 0; } .ip-rail-lib { padding-inline-end: calc(40px + var(--sp-2)); }`, and the strip's rows lists sit side by side (the rail is already a flex row).

## Task 3: the Library's pages

Files: new `web/src/library/LibraryView.tsx`, new `web/src/library/PagesShelf.tsx`, new `web/src/library/RosterShelf.tsx`, new `web/src/library/SyncShelf.tsx`, new `web/src/styles/library.css` (import it where the other sheets are imported, in the same layer), `web/src/panels/ResourceViewer.tsx`.

- `LibraryView`: switches on `route.shelf`. Each shelf is a `div.ip-page` page like `DoneList`, with `PageHead` (`code` PGS, RST or SYN; `name` PAGES, ROSTER or SYNC; `decodeKey` -1, -2, -3) and a load error as `ErrorLine`, loading as `EmptyState` "Loading…".
- `PagesShelf`: the pages with shelf `pages`, grouped by project: the source project first (`sourceProjectId`), then projects in the rail's `tabs` order, then any others by name. A `section` per project with an `Eyebrow as="h3"` of the project's code (`codes`) and name, and a `ul`. A row: a `Chip` MD or HTML (none when `format` is null), the title as a `button.ip-lib-open` that calls `onOpenResource(id)`, the path in mono muted (`title` attribute holds it whole, text cut with ellipsis), the freshness (`fresh === undefined`: nothing; `null`: "confirm again"; 0: "current"; n: "n since confirmed", in alarm tone when n > 0), the `error` line in alarm when set, and when `adaptedIn` is not empty an "Adapted in" label and one link chip per entry (`<a href={libraryHash({ shelf: 'sync', pick: { slug, template } })}>` showing the project's code or name, `title` "<name>'s adaptation of <template>", click: `preventDefault`, `onRoute(...)`). Meta in the head: the page count. Empty: "No library pages yet. Register one with purpose library."
- `RosterShelf`: pages with shelf `roster`. None: `EmptyState` "No roster page yet. A library page with shelf: roster lands here." Exactly one: `<ResourceViewer resourceId={id} inline />`. More: the Pages row list for them.
- `ResourceViewer` gains `inline?: boolean` (and `onClose` becomes optional). Inline it renders `section.ip-viewer[data-inline]` with `aria-label` the title, no `role="dialog"`, no `aria-modal`, no ×, and it does not take focus on mount. `panels.css`: `.ip-viewer[data-inline] { position: static; inset: auto; z-index: auto; flex: 1; min-width: 0; min-height: 0; }`.
- `SyncShelf` (a placeholder until #515): the head's meta shows Shipwright's head sha from the first ok row. One `p` per manifest row: the project's name, then "k of n files behind" (files with state behind of all files) or "check failed" in alarm. When `route.pick` is set, a line "Picked <project name> × <template>: its adaptation opens here with the Sync grid (#515)." Loading and error as above.

## Task 4: e2e

One test in `test/e2e/ui.spec.ts`, after the page tests, reusing `pageRepo`: `the Library group lists pages by project, opens the roster in place, and keeps its route on reload`. Register a library page with `templates: [agents/sev.md]` and a `shelf: roster` page; bind a second temp repo holding `scripts/template-sync.mjs` that prints a JSON with one `behind` file, and give the page repo a `.claude/shipwright.json` naming that folder and adopting `agents/sev.md`. Then: the Library row shows the count 1; open it, Pages lists the page under its project with MD and its path, and Adapted in links to `#/lib/sync/...`; reload keeps `#/lib/pages`; Roster shows the roster page's heading in place with no dialog; Sync's sub-entry reads `1 behind`; a project row click returns to `#/p/<slug>`. Run it as `npm run test:e2e` does, narrowed with `-g`, with `INPROGRESS_E2E_PORT` from 4410 to 4419.

## Checks for the branch

`npm run typecheck`, `npm test`, and the one e2e test narrowed with `-g`.
