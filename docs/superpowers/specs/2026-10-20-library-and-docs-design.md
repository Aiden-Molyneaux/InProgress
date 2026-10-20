# The Library, a project's Docs view and live-path pages

Step #526, for phase #525. Aiden's use cases are r355 and the handoff is r356. Aiden passed the two mockups as drawn on
2026-10-20: the Sync grid (r357, PNG r358) and a project's Docs entry (r359, PNGs r360 and r361). This spec turns them
into rules and gives each child step its acceptance criteria.

## Intent

Aiden changes an agent or workflow in Shipwright and wants one place that shows whether every project has caught up. He
also wants readable pages on how the roster works, how each project adapts it, and how a project like InGame is wired in
production. These pages must stay true without anyone rewriting them by hand after each change.

There are two homes:

- **The Library**, a rail group of its own, for pages that span projects: Shipwright's lifecycle and agents, the
  roster's responsibilities and the Sync grid (use cases 1, 2 and 5).
- **Docs**, a fifth view under each project's rail entry, for that project's own pages and its adaptations of
  Shipwright's templates (use cases 3 and 4).

## Goals

- A page lives in the repo that owns its subject and is read live from its path. InProgress keeps a pointer to it, never
  a copy of it.
- A page renders as markdown or as interactive HTML.
- A page says which paths it covers. The view counts commits to those paths since someone last confirmed the page, and a
  Sigmund receipt names the pages a change touched.
- The Sync grid shows every project with a manifest against Shipwright's templates, from Shipwright's own
  `template-sync.mjs`.
- A project's adaptation of a template can be read next to the template, by section.

## Non-goals

- Editing pages in the window. A page changes in its repo, through that repo's own gates.
- Running a sync from the window. The grid reports and can file a step, and the sync itself runs in that project's own
  session.
- Multi-file HTML pages with relative assets. A page is a single file in v1.
- Search across pages. Ctrl K stays a step finder.

## Anti-goals

- A second copy of Shipwright's sync logic in InProgress. The grid only reads what `template-sync.mjs` prints.
- A secret value anywhere in a page, a resource row or the window.
- A freshness flag standing in for keeping pages up to date. The receipt is the mechanism and the flag is a backstop.

## Decisions

| # | Decision | By |
|---|---|---|
| 1 | Build it; remove it or iterate if it flops | Aiden, 2026-10-20 |
| 2 | Two homes: the Library on the rail and Docs under each project | Aiden, 2026-10-20 |
| 3 | Pages are markdown or interactive HTML | Aiden, 2026-10-20 |
| 4 | Pages live in the owning repo and are read live from their path | Aiden with the Fable review, 2026-10-20 |
| 5 | Freshness comes from Sigmund's receipt, with a commit count and "Still accurate" as backstop | Aiden with the Fable review, 2026-10-20 |
| 6 | Sync data comes from Shipwright's `template-sync.mjs --check --json` (#532) | Aiden with the Fable review, 2026-10-20 |
| 7 | The mockups' layout, states and design notes, as drawn | Aiden, 2026-10-20 |

Calls this spec makes without asking are listed under "Calls made here", near the end.

## Pages

### Registering a page

A page is a resource of kind `doc` with an absolute `path` and no `content`. Resources already accept a path alone
(`src/server/repo/resources.ts:113-124`), and `snapshot_file` stays off, so nothing is copied in.

Its `purpose` says where it is shown:

- `library`: listed in the Library.
- `page`: listed in its project's Docs view.

`purpose` has no CHECK in the schema, so these two values only join `RESOURCE_PURPOSES` in `src/core/types.ts`.

The resource belongs to the project that owns the repo the file sits in. Registration is refused (a 400 naming the reason)
unless the path:

- is absolute and local (`isLocalAbsolutePath` from `routes/ui.ts`);
- sits under a folder bound to that project (the `bindings` table);
- ends in `.md`, `.markdown`, `.html` or `.htm`;
- is a regular file of 2 MB or less.

Shipwright's pages therefore belong to the Shipwright project, and InGame's map to InGame. A page is attached to the
project root or to any node, like any resource. Where it is attached does not change where it is listed.

A page is registered through the scribe, the same way as any other resource:
`resource on #id: doc "<title>", path <file>, purpose library|page`. The Docs view's "+ Register a page" opens the same
form the window uses for resources, with kind and purpose already set.

### Reading a page live

`GET /api/resources/:id/body` reads the file at request time and returns `{ format: 'markdown' | 'html', text, front,
sha }`:

- `front` is the page's front matter (below).
- `sha` is the owning repo's HEAD, from `git -C <dir> rev-parse HEAD`.

It re-checks the registration rules on every read, so a moved or deleted file returns a typed 404
(`page-missing`), not a 500. It reads the bound folder, which is the main checkout, so a page shows what has merged, not a
worktree's draft.

`GET /api/resources/:id` stays as it is.

### Front matter

Markdown pages take YAML front matter. HTML pages carry the same keys as `<meta name="inprogress:<key>" content="…">` in
their head, with list values comma-separated.

| Key | Meaning |
|---|---|
| `covers` | Paths or globs, relative to the page's repo root, that the page describes. Optional: a page with none shows no freshness strip. |
| `shelf` | `roster` puts a Library page under Roster rather than Pages. Default `pages`. |
| `templates` | Shipwright template paths the page explains (for example `skills/sigmund/SKILL.md`). It links an adaptation to the page. |

### Freshness

Confirmation is recorded on the resource row and the claim on the page, because confirming must not need a commit in
another repo. A migration adds two nullable columns to `resources`: `confirmed_sha` and `confirmed_at`. It only adds, so
`min_reader_version` stays 1.

- When a page is registered, both are set to the repo's HEAD and the current time.
- The count is `git -C <repo> rev-list --count <confirmed_sha>..HEAD -- <covers…>`, computed with the body read and
  cached by HEAD sha.
- **Still accurate** (`POST /api/resources/:id/confirm`) sets both to the current HEAD and the current time.
- A `confirmed_sha` that is no longer in the repo's history (after a rebase) counts as stale. The strip then says
  "confirm again" instead of a number.

The viewer's strip under the title shows the count, when and how the page was confirmed, the `covers` chips and Still
accurate. When the count is 0, the strip is muted and Still accurate is hidden.

### Sigmund's receipt (#531)

`inprogress pages --touched <base>..<head> --repo <dir>` lists the registered pages in any project whose page sits in
`<dir>`'s repo and whose `covers` match a file changed in the range. It prints one line per page: the resource id, the
title and the matched paths.

Sigmund runs it in phase 7, and the receipt names each page under a new item, **Pages this change touched**:

- If the change updated the page, or Sigmund read it and it still holds, the receipt says so. After the merge, the
  scribe brief carries `confirm r<id>`, which sets `confirmed_sha` to the merge commit.
- If the page is now wrong, the receipt says what is wrong and the scribe brief files a docs step for it.

The receipt item is part of Shipwright's Sigmund template, so it lands in Shipwright first, as an item with a fill
(`{{DOC_PAGES}}`). It then reaches InProgress and InThink through the normal sync. A project that registers no pages
fills it with "none".

### Rendering

- **Markdown** renders through the viewer's existing `Markdown` component.
- **HTML** renders in an `<iframe sandbox="allow-scripts" srcdoc=…>`. Without `allow-same-origin`, the page cannot read
  the window's origin, cookies, storage or API. Before the text goes in, the server prepends a CSP meta tag:
  `default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline' https://fonts.googleapis.com;
  font-src https://fonts.gstatic.com; img-src data:`.

  The page keeps its own scripts, so its parts stay clickable, but it can make no other network call. The frame label
  reads "sandboxed frame · scripts on · no network". Fonts are the one exception: they load only from Google Fonts,
  because the v3 pages use those faces.

  The frame takes the viewer body's width, and its height follows the page through a `postMessage` of
  `document.body.scrollHeight`. That message is the only one the window accepts from a frame, and only as a number.

Open file and Copy path stay as they are today.

### Secrets

A page names a secret and says where it is kept (a Railway variable, a gitignored env file, the password manager). It
never holds the value.

The body route scans each page for secret-shaped text before it returns: known key prefixes (`sk-`, `sk_live_`, `re_`,
`ghp_`, `github_pat_`, `AKIA`, `xox`) and `NAME=value` pairs where NAME ends in KEY, SECRET, TOKEN or PASSWORD and the
value is 16 or more non-space characters. On a hit, it returns a typed 422 (`page-has-secret`) with the line number and
never the text. The viewer shows "This page looks like it holds a secret on line N; fix it in its repo".

## The Library

### Rail

The Library is a second group under the projects, `// Library`, with one row (code `LIB`) and three sub-entries: Pages
(`PGS`), Roster (`RST`) and Sync (`SYN`).

- The row's signal is an outlined orange count of projects behind Shipwright. It is never volt, because volt stays
  "your move".
- Sync's sub-entry carries "N behind" in orange.
- The route is `#/lib/pages`, `#/lib/roster` or `#/lib/sync`, next to the existing `#/p/<slug>`.
- The rail's keyboard rules apply unchanged: the Library is one more row in the list.

### Pages

Pages lists every `purpose: library` resource with `shelf` not `roster`, grouped by owning project (Shipwright first,
then the rest in rail order). Each row shows the format (MD or HTML), the title, the path and the freshness count.

Opening a page shows it in the viewer as described above. A page with `templates` also shows **Adapted in** chips: one
per project whose manifest adopts one of those templates, each opening that project's adaptation.

### Roster

Roster lists the `shelf: roster` pages. With exactly one, Roster opens it directly. #527 writes that page: one row per
agent and skill with what it owns, what it never does, and who it reports to. It answers use case 5 ("which agent
updates the scribe") in one look.

### Sync

The page is the Sync grid mock (r357):

- A comms slab with one sentence on where sync stands, and Check now.
- A legend of the five states.
- The grid: one row per project, columns grouped as Agents, Skills and Starter kit, in Shipwright's `templates.json`
  order.
- A summary cell per row: files behind of adopted, base and last sync.
- An action per row: the open sync step, or File sync step.
- A "No manifest" line naming the projects with no manifest.
- The open cell, with its Adaptation, Fills and Upstream tabs, and a side panel with facts and links.

**Rows.** Every project with a bound folder holding `.claude/shipwright.json` gets a row, read from its first binding.
Projects without one are named on the "No manifest" line. Shipwright itself is named there as "is the source".

**Cell states**, from `--check --json`:

| State | When | Drawn |
|---|---|---|
| current | base equals Shipwright HEAD | a quiet dot |
| N behind | N commits touch the template since base | the number in orange |
| pending | the manifest marks the file pending | `!` in alarm |
| skipped | the template is in the manifest's `skip` | hatched |
| not adopted | neither in `files` nor in `skip` | dashed |
| missing, gone, error | as the script reports | `!` in alarm, with the script's detail in the open cell |

**Last sync** is the date of the newest commit that moved any `base` in the manifest. It is not the manifest's last
commit: InProgress's last touch to its manifest was a style refactor, so that date would be wrong. #532 computes it.

**The comms sentence** is built by one formatter, `syncSentence(result)`, which #461 reuses. It names:

- how many projects are behind, and by which Shipwright commits;
- for each behind project, whether it has a sync step.

A project has a sync step when it has an open step whose title matches `/\bsync\b/i` and names Shipwright or a template.

**File sync step** quick-adds `Sync <project> to Shipwright <sha>` with label `docs` to that project's root, through the
existing add-step route, and the button becomes the new step's link.

**Check now** re-runs the check. Otherwise results are cached for 60 seconds per project, keyed by Shipwright HEAD and
the manifest's mtime.

**The open cell.** A click on any cell opens it below the grid.

- **Adaptation**: the project's copy against the template at its base, filled with the project's fills, grouped by
  section heading. What is left is the project's own change. #532's `--diff` provides it.
- **Fills**: the recorded values, file fills first and marked "this file", then the project fills it uses.
- **Upstream**: the Shipwright commits from base to HEAD that touch the template, with their diff. A hunk that would
  conflict with the project's adaptation is marked "expect a conflict", from #532's dry-run merge.
- The side panel shows the base, Shipwright HEAD, how far behind the file is, the commit that last synced it and the
  local edit count, with links to the Shipwright page (through `templates`), the project's Docs adaptation and Open the
  project's copy.

A skipped cell shows only "in the skip list: never synced", and a current cell shows Adaptation and Fills.

### What #532 provides (Shipwright)

`template-sync.mjs --check --json --project <dir>` prints:

```json
{
  "shipwright": { "head": "34ef8b7", "date": "2026-10-19", "subject": "…" },
  "project": "C:/personal/InThink",
  "lastSync": { "sha": "e7ed968", "date": "2026-10-18", "subject": "…" },
  "files": [
    { "template": "skills/sigmund/SKILL.md", "local": ".claude/skills/sigmund/SKILL.md", "base": "ad0a7c1",
      "state": "behind", "behind": 1, "commits": [{ "sha": "ef18c35", "date": "2026-10-19", "subject": "…" }],
      "fills": { "CHECKS": "…" }, "detail": null }
  ],
  "skip": ["agents/parvati-isolated.md"],
  "notAdopted": [],
  "fills": { "PROJECT": "InThink" }
}
```

`template-sync.mjs --diff <template> --json --project <dir>` prints `{ adaptation, upstream, conflicts }`:

- `adaptation` and `upstream` are unified diffs.
- `conflicts` lists hunk ranges from a dry-run merge into a temp folder.

InProgress runs both with `execFile` and a 20 second timeout, through the manifest's `shipwright` path. If the script
fails or its JSON does not parse, the row shows "check failed" in alarm with the script's stderr in the open cell. It is
never a 500 for the page.

### Mip's digest (#461)

`src/server/digest.ts`'s `sections()` gains a **Shipwright** section after Marks. It prints `syncSentence` for the
digest's project only, and prints nothing when the project is current or has no manifest. It reads the same cached
result as the grid, so a digest never runs the script twice in a minute.

## A project's Docs view

The view is the Docs entry mock (r359).

**Rail.** `'docs'` joins the `View` union (`web/src/views/view.ts`) and `railViews` (code `DOC`), after All done. Its
count reads:

- "pages · N stale" when any page is stale, in orange;
- otherwise "pages · adaptations";
- only the page count when the project has no manifest.

**The index**, on the left, has two lists:

- **Pages**: the project's `purpose: page` resources, each with its format, title, path and freshness.
- **Adaptations**: one row per adopted template from the project's `--check --json`, each with its kind (SKL or AGT),
  name, sync state, local edit count and file-fill count. A project without a manifest gets a dashed note saying so,
  with a link to Library · Sync.

Below the lists sits "+ Register a page".

**The viewer**, on the right, is the page viewer described above. For an adaptation it shows the **side by side** (use
case 3):

- one row per section of the template;
- the left column is Shipwright's text, with placeholders as chips;
- the right column is what the project does there, tagged `fill`, `file fill`, `rewritten` or `added`;
- sections the project left alone fold into one line;
- a section the next sync will conflict on carries the orange note.

A Diff tab shows the raw adaptation diff. The head links to the Shipwright page and to the Sync cell. The freshness
strip reads "computed live from <project>'s copy, its manifest and Shipwright at base <sha>", because an adaptation is
derived and needs no confirming.

Sections come from the template's level 2 and 3 headings and its bold `**Name [edit].**` paragraph leads, matched by
name in the project's copy. A project section with no template match is `added`. A template section missing from the
copy shows as "removed in <project>".

## Calls made here

These were made without asking and are open to change:

- Confirmation is stored on the resource row (`confirmed_sha`, `confirmed_at`), and `covers` lives in the page.
- Pages are read from the bound main checkout, not from worktrees.
- HTML pages get no network except Google Fonts.
- The secret scan refuses to render rather than masking the match.
- "Has a sync step" is detected from the step title. A link field can replace it if that misfires.
- The receipt item lands in Shipwright's template first, as `{{DOC_PAGES}}`.
- The Library listing is grouped by owning project. Pages has no tags or categories in v1.

## Child steps and acceptance criteria

Build order: #528, then #527, #532 and #533 in parallel, then #529 with #515, then #530, #531 and #461.

### #528 Doc resources read live from a repo path; viewer renders md/HTML (data, ui)

1. A `doc` resource with `purpose` `library` or `page` registers only for an absolute local path under one of its
   project's bindings, with a page extension and 2 MB or less. Otherwise it gets a typed 400 naming the rule.
2. `GET /api/resources/:id/body` returns the file's current text, its format, its front matter and the repo HEAD. Editing
   the file and reloading shows the edit with no re-registration.
3. A moved file returns a typed 404 `page-missing`, and the viewer says the page is gone and shows its last path.
4. A markdown page renders through `Markdown`. An HTML page renders in a frame with `sandbox="allow-scripts"` and no
   `allow-same-origin`, under the injected CSP. A test page's `fetch` to any host fails, and its own click handlers work.
5. The frame grows to the page's height, and a non-numeric `postMessage` is ignored.
6. The migration adds `confirmed_sha` and `confirmed_at`, with `min_reader_version` still 1. Registration sets both.
7. The freshness strip shows the commit count to `covers` paths since `confirmed_sha`, and Still accurate resets it to 0.
   A page with no `covers` shows no strip.
8. A page with a secret-shaped line returns 422 `page-has-secret` with the line number, and the viewer never shows the
   text.

### #527 First pages: Shipwright lifecycle, sync, roster, session hooks (docs)

1. In Shipwright: a lifecycle page and a template sync page (folding in `2026-10-19-template-sync-process.md`), and one
   page per agent and skill template with `templates` set. All are registered with `purpose: library`.
2. In Shipwright: a roster page with `shelf: roster`, one row per agent and skill: owns, never does, reports to. Reading
   it answers "which agent updates the InProgress scribe" without opening another page.
3. In InProgress: a session hooks and briefing page with `covers: src/hooks/**, src/server/briefing.ts,
   src/server/session-flow.ts`, folding in `docs/guide/inprogress-guide.html` where it still holds.
4. Every page has `covers`, and none holds a secret value.

### #532 `template-sync.mjs --check --json` and `--diff` (Shipwright project)

1. `--check --json` prints the shape above for InProgress and InThink, with the same states as `--check`.
2. `lastSync` is the newest commit that moved a `base`. For InProgress it names the 18 Oct sync, not a later refactor.
3. `--diff <template> --json` returns `adaptation`, `upstream` and `conflicts`. For InThink's Sigmund at 34ef8b7 it
   reports the check surface paragraph as a conflict.
4. Neither mode writes into the project.

### #533 InGame's production services map (InGame project)

1. `docs/ops/services-map.html` in InGame: clients, edge, Railway services and third parties as clickable nodes, each
   with where it runs, health and logs, troubleshooting, and the names and locations of its secrets.
2. It holds no secret value, and the #528 scan passes.
3. Its `covers` names `apps/api/src/app.ts`, `apps/mobile/eas.json`, `apps/api/.env.example` and `infra/backup/**`, and it
   is registered on InGame with `purpose: page`.
4. It works in the sandboxed frame with no network call except fonts.

### #529 Library module on the rail: Pages, Roster, Sync (ui)

1. A `// Library` group under the projects with one Library row and Pages, Roster and Sync sub-entries. Each keeps its
   route on reload (`#/lib/…`).
2. The row's count is the number of projects behind, outlined in orange, and there is no count when none are.
3. Pages lists library pages grouped by owning project, with format, path and freshness. A page with `templates` shows
   Adapted in chips that open the adaptation.
4. Roster opens the single roster page directly.
5. At 76 px and in the strip under 720 px, the group shows as codes like the project rows.

### #515 Sync dashboard: every project's state vs Shipwright, fills, diff (ui, integration)

1. One row per project with a manifest, columns in `templates.json` order, grouped by Agents, Skills and Starter kit,
   with each cell in the state table's look.
2. The summary cell shows "N of M", the base and the last sync date. The action shows the open sync step's link or File
   sync step, and File sync step adds the step and turns into its link.
3. A cell click opens Adaptation, Fills and Upstream as described. Upstream marks the conflicting hunk for InThink ×
   Sigmund.
4. The No manifest line names InGame, cad-dev-loop and Shipwright.
5. A failing script shows "check failed" on its row with stderr in the open cell, and the rest of the grid still renders.
6. Check now re-runs the check. Otherwise a second load within 60 seconds does not run the script.

### #530 Docs entry in each project's rail entry (ui)

1. Docs is a fifth view under every project, with the count rules above.
2. The index lists pages and adaptations. A project with no manifest shows the dashed note and the Sync link.
3. Opening an InThink adaptation shows the side by side with the tags, folded sections and conflict note. Diff shows the
   raw diff.
4. Opening InGame's map shows it working in the sandboxed frame, with its freshness strip.

### #531 Sigmund's receipt names pages whose covered paths a change hit (integration)

1. `inprogress pages --touched <range> --repo <dir>` lists the matching pages with their ids and matched paths, and
   prints nothing when none match.
2. Shipwright's Sigmund template gains the **Pages this change touched** receipt item with `{{DOC_PAGES}}`. InProgress's
   copy gets it through a sync.
3. A scribe brief line `confirm r<id>` confirms the page at the merge commit, and the view's count drops to 0.

### #461 Mip's digest says when InProgress is behind Shipwright

1. The digest's Shipwright section prints `syncSentence` for its project when the project is behind, and nothing
   otherwise.
2. The digest and the Sync slab print the same sentence for the same state.
