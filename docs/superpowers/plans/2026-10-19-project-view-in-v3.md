# Project view in v3 (#503)

Spec: `docs/superpowers/specs/2026-10-18-window-v3-port-design.md` section 8 (`:789-858`), with section 7's page head and
comms slab (`:659-681`) and section 4's parts (`:409-453`). Label ui. Branch `claude/v3-project-view-def5aa`.

## Criteria (the bar)

- C1 · open the Project view at 1600 · expect the page head (code block, name, meta line `n PHASES · n NOW · n NEXT · n DONE`, a zero figure dim), the comms slab with the whole note as Markdown, the rail key, the sections, and the phase index at the right.
- C2 · click a phase index row whose section is folded · expect the section to open, scroll into view, and its head toggle to take focus; the section in view carries a volt `›` in the index.
- C3 · at 1160, 720 and 400 · under a page width of 1160 the index becomes a "Phases · n" jump row under the slab, outline rows put label, marks and sessions on a second line, the rail key wraps; nothing scrolls sideways.
- C4 · Tab into the outline, then Up, Down, Home, End, Enter · expect one Tab stop for every open section's rows together, the arrows walking them in screen order across sections, Enter opening Details (or toggling a done fold).
- C5 · today's behaviour holds: folds and their storage, done folds, finished phases picked open, "+ Add a step", the `▤ n` docs menu (Escape, outside click, focus back), a row opening Details.

Depth: a list (the criteria as guided steps).

## Decisions (Sigmund, made without asking; named in the receipt)

- **Shared pieces for #502 live in `web/src/page/`**, not `web/src/parts/` (section 4's parts table is closed): `PageHead.tsx`, `CommsSlab.tsx`, `projectCode.ts`, `usePageWidth.ts`, styles in a new `web/src/styles/page.css` in the `components` layer, imported in `web/src/main.tsx` after `parts.css`.
- **The code block** uses `projectCode(name, others = [])`: section 6's three-letter rule. The digit for a clash needs the project list, which only `App.tsx` holds; the Project view passes no others, and #501 wires them when it builds the rail. No `App.tsx` change in this step.
- **The comms slab is a shell**: Tape, the first row (Eyebrow and the note's age), a body slot, an actions slot, and a second-row slot. The Project view fills the body with the whole note as Markdown. #502 adds the first-sentence body with More/Less, the step-reference links and "N to tidy".
- **Page width, not window width**: `usePageWidth(ref)` measures the view's own root with a ResizeObserver; `wide` is `>= 1160`.
- **The outline's column header row** ("Step Label Marks Sessions Docs") goes: the rail key explains the marks and section 8 does not keep it.
- **ListCursor debt from #499** (it tracks a position, so a live update that adds a row moves the cursor to another step): `useListCursor` takes optional `keys` (one array per column) and remembers the key of the item last focused, falling back to the clamped position when the key is gone. Existing callers pass none and keep today's behaviour.
- **Menu debt from #499** (no shared click-outside): `DocsMenu` renders the `Menu` part inside its own popover and keeps its own outside-press close, now moved into a small shared hook `web/src/parts/usePressOutside.ts` that #502's "N to tidy" can use.
- **Class names the other describe blocks rely on stay**: `.ip-orow`, `.ip-osess`, the `role="img"` names on the position marks (`now, a session is on it`, `now, no session`, `next, number n`, `next, in the own queue of "<title>"`, `backlog`), and the region `Sections`. `.ip-view-name` stays in `project.css` for the Board until #502.

## Files

Owned: `web/src/project/*`, `web/src/page/*` (new), `web/src/styles/project.css`, `web/src/styles/page.css` (new),
`web/src/main.tsx` (one import line), `web/src/parts/ListCursor.tsx`, `web/src/parts/usePressOutside.ts` (new),
`test/web/*` for new unit tests, the `Project view` describe block in `test/e2e/ui.spec.ts` (`:2855` to its end).

Not touched: `chrome.css`, `web/src/chrome/`, the activity strip, `App.tsx`, `board/*`, any other describe block.

## Tasks

### 1. Shared pieces in `web/src/page/`

- `projectCode.ts`: `projectCode(name: string, others: readonly string[] = []): string`. Words split on spaces,
  hyphens, underscores and camel-case humps; take each word's first letter (up to three), then fill from the name's next
  consonants (after the first letter of the first word, in order, skipping letters already taken positionally) until
  three letters; pad with the next letters if still short; uppercase. If `others` (the names of projects before this one
  in rail order) contains a name with the same code, replace the third letter with the clash count plus one (`IN2`,
  `IN3`). Vitest: `InProgress` → `IPR`, `InThink` → `ITH`, `my-api` → `MAP`, `Shipwright` → `SHP`, a clash → `IP2`.
- `usePageWidth.ts`: `usePageWidth<T extends HTMLElement>(): [RefObject<T>, number]`, a ResizeObserver on the element,
  width from `contentRect.width`; first value read in a layout effect so the first paint is right.
- `PageHead.tsx`: props `code`, `name`, `meta: { label: string; value: number }[]`, `decodeKey` (the project id).
  Renders `<header class="ip-page-head">`: the code in a volt block (`--font-brand`, `--volt` fill, `--volt-ink` text);
  `<h1 class="ip-page-title">` with the name at `--t-h1`, `--font-display`, uppercase, `--text-hi`, ellipsis on one line,
  its `title` the full name; the meta line right-aligned, mono `--t-detail-sm`, volt, figures joined by ` · `, a zero
  figure's span `data-zero` and `--text-dim`. The decode: on mount, if `decodeKey` differs from a module-level
  `lastDecoded` and reduced motion is off, the visible text scrambles left to right to the name over at most 520 ms
  (requestAnimationFrame, random capitals for unsettled letters, spaces kept); the h1 carries `aria-label={name}` and
  the scrambled text is `aria-hidden`. Then set `lastDecoded`. Under 720 px page width the meta line wraps under the title.
- `CommsSlab.tsx`: props `age: string | null` (e.g. `2D`), `children` (the body), `actions?`, `below?`. Renders
  `<section class="ip-comms" aria-label="Orchestrator note">`: a `Tape` (volt) along the top; the first row: `Eyebrow`
  glyph `[◈]` text `COMMS // ORCHESTRATOR`, then `LOOKED <age> AGO` (mono, `--text-dim`) when `age` is set, then
  `actions` at the right; the body (max 68ch, `--text-hi`); `below` when given. `--canvas-0`, a `--line` edge.
- `web/src/styles/page.css`, `@layer components { ... }`, v3 tokens only. Import it in `main.tsx` after `parts.css`.

### 2. ListCursor keys and the outside press

- `useListCursor(counts, onOpen, keys?)`: `keys?: readonly (readonly string[])[]`. Store `{ col, row, key? }` on focus.
  At render, when `keys` is given and the stored key is found, the cursor is that position; otherwise today's
  `clampCursor`. Vitest in `test/web/listCursor.test.ts` for the pure resolve (move it into `listCursorLogic.ts` as
  `resolveCursor(last, counts, keys?)`).
- `usePressOutside(open, refs, onPress)`: a `mousedown` listener while `open`, calling `onPress` when the target is
  outside every ref. Move DocsMenu's listener onto it, keeping the "focus back to the opener when focus fell to body" rule.

### 3. The page and the phase index (`ProjectView.tsx`)

- Root `<div class="ip-project" data-wide>` with `usePageWidth`; `wide = width >= 1160`.
- Head: `PageHead` with `projectCode(snapshot.project.name)`, meta `PHASES` (sections that have a group, open and
  finished), `NOW` (`board` rows in now), `NEXT` (rows in next), `DONE` (done steps in the project, as the Board's Done
  count). Use the existing derive helpers; do not add a server read.
- `CommsSlab` with `age = ageShort(note.updatedAt, now).toUpperCase()` and the body `<Markdown text={note.content} />`; no
  note: body `<p class="ip-quiet">No state note yet</p>` and no age.
- Wide: a grid, `minmax(0, 1040px) 240px`, `--sp-6` gap: left column the rail key and sections, right column the index,
  `position: sticky; top: 0` inside the scrolling root. Narrow: the jump row under the slab, then the key, the sections,
  then the finished phases block.
- `PhaseIndex` (new file `PhaseIndex.tsx`): `<nav aria-label="Phases">`, an `Eyebrow` `// PHASES`, one button per open
  or folded (not finished) section, in order: title (body 600, one line, ellipsis), a 2 px bar (`--canvas-4` track,
  done `--text-muted`, now `--volt`, widths by count over total), `done/total` mono; `aria-current="location"` and a volt
  `›` on the section in view. Then `// FINISHED · n` as a fold button (`aria-expanded`, key `done:0`), and when open one
  row per finished section; picking one sets `section:<id>` true (as today's pick) and then jumps to it.
- **Jump** (`jumpTo(key)`): set the fold to open when folded, then after the render scroll the section into view
  (`block: 'start'`, `behavior` smooth unless reduced motion) and focus its head toggle. Use a ref map of section
  elements and a pending-jump ref consumed in a layout effect.
- **In view**: on the root's `scroll` (and on resize), the section in view is the last whose top is at or above the
  root's top plus 24 px, else the first.
- Narrow jump row: an `Eyebrow` `Phases · n` and a `TabStrip` `segmented`, label `Phases`, items the same sections
  (`id` = fold key, `label` = title cut to 24 chars with `…`), `value` = the section in view, `onChange` = jump.
- Rail key (`RailKey`): `role="group" aria-label="Key to the marks"`, one line, each mark drawn by the same component
  the rows use, with its word: `now, a session is on it`, `now, no session`, `next, in queue order`, `next, in a
  session's own queue`, `backlog`, `parked, set aside`. Wraps under 720 px.
- Empty: `EmptyState` "No steps yet".

### 4. Sections (`Section.tsx`)

- Panel `--canvas-2`, a `--line` edge, `--sp-4` apart.
- Head (`.ip-sec-head`, a click anywhere on it outside its controls toggles): the toggle button (`aria-expanded`,
  accessible name the title) holding an `Eyebrow` `[+]` with `#id` (none for Top level) and the title at `--t-title`
  in `--font-body`; then `Readout label="DONE" value="22/30"`; then the DocsMenu; then the caret (`▾`/`▸`, aria-hidden).
- Bar `.ip-sbar` under the head: 4 px, segments `seg-done` `--text-muted`, `seg-now` `--volt`, `seg-next` `--text`,
  `seg-backlog` a 1 px `--line-bright` inset outline; keep `role="img"`, `aria-label` and `title` = `legendText`.
  Folded: only head and bar.
- Rows (`.ip-orow`, an `li` carrying the cursor props): position mark column 28 px; mono `#id`; the title button
  `.ip-row-title` at `--t-body`; wide: then cells for the LabelChip, StepMarks, sessions (`.ip-osess`, one line each,
  ellipsis), `▤ n`; narrow: label, marks and sessions on a second line. Indent per depth 16 px wide, 12 px narrow. A
  click opens Details (`rowClick` as today). Focus look: a volt inset edge.
- Position marks (`PositionMark`, also used by the key): now with a session, a `LiveDot` inside `span role="img"`; now
  without, a 9 px `--text-muted` square; next, the queue number in mono volt digits (not circled numerals); own queue,
  `◆` `--text-muted` with the session title as `title`; backlog, a 9 px hollow square (`--line-bright` 1.5 px); parked,
  the `Marker` part `parked`; done, a muted `✓`. Keep today's `aria-label`s.
- Done fold row: one muted mono button `✓ 8 done · latest #412 Fix export · 2D` (no colon), `aria-expanded`.
- Foot: `+ Add a step` as `Button variant="ghost" size="sm"`; QuickAdd as today.
- DocsMenu: the opener as today (`aria-label`, `aria-expanded`, `▤ n`), the popover `.ip-docs-pop` absolutely placed,
  holding the `Menu` part (`label="Resources in <title>"`, `autoFocus`, `onClose` = close and focus the opener) with a
  `MenuItem` per resource (title, then the summary muted). Keep Tab and Shift+Tab closing it.

### 5. The cursor across sections

- In `ProjectView`, flatten the open shown sections' lines in screen order into `cursorKeys: string[]` (`s<id>` step,
  `d<parentId>` done fold, `o<id>` opened done child) and an `onOpen` per key (step and child: `onOpenNode`; fold:
  toggle it). One `useListCursor([n], open, [cursorKeys])`; pass `cursorFor(key)` down to `Section` and its rows.

### 6. Styles (`project.css`)

- Rewrite with v3 tokens only (no `--border`, `--lane`, `--panel*`, `--card`, `--fs-*`, `--muted`, `--text-2`, `--faint`,
  `--active`, `--track-fill`): keep the `.ip-view-name` rule as it is for the Board. Narrow rules under the `data-wide`
  attribute, not media queries. Nothing scrolls sideways at 400.

### 7. Tests

- `test/web/`: `projectCode.test.ts`; `listCursor.test.ts` adds `resolveCursor` cases; a test for the meta figures if
  they get a helper.
- `test/e2e/ui.spec.ts`, the `Project view` block only: replace `.ip-view-name` with the page head
  (`page.locator('.ip-page-title')`); `'The rail'` with `'Key to the marks'`; the done fold regex without the colon;
  "Done groups · 1" with the index's `Finished · 1` button and the pick from the index. New test: "a phase index row
  opens a folded section and focuses its head": at 1600 the `Parked` phase from the first test's setup is folded; click
  its index row; expect its toggle `aria-expanded=true` and focused. Then at 720 the jump row (`group` named `Phases`)
  shows and picking `Road to market` focuses that head.
- Checks: `npm run typecheck`, `npm test`, and the Project view block with
  `INPROGRESS_E2E_PORT=<4410-4419> npx playwright test test/e2e/ui.spec.ts -g "Project view"`; also the test at
  `ui.spec.ts:1900` ("retired" tags) and `:150` (view switch), which reach the Project view.
