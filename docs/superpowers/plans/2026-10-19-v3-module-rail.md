# #501 Shell: the module rail

Spec: `docs/superpowers/specs/2026-10-18-window-v3-port-design.md` section 6 (approved 2026-10-18), D2 and D6 in section 1,
section 12's #501 row. Mock: `~/.inprogress/resources/inprogress/2026-10-18-board-in-inthink-v3-mock.html`, `.rail`
and `.mod` rules (lines 149-186, 330-365) and the `nav.rail` markup (line 416). Branch `claude/v3-rail-c86ca7`, worktree
`.claude/worktrees/v3-rail-c86ca7`. Label ui.

## Criteria (the bar)

- **C1 Rail at 1600.** A 216 px rail left of the page, the full height between the ruler and the footer: `// PROJECTS`,
  one 36 px row per active project with a 2 px rule in its faction colour (`--hue-(id mod 7)`), the current row volt
  filled; under it Board, Project (`n phases`), Backlog (open count), All done (count). Clicking a row opens that
  project; clicking a view opens it. No tab row, no Board | Project switch.
- **C2 Views are peers.** Backlog and All done open from the rail and from the Board's "N ›" and "All done ›"; neither
  view has "‹ Board"; Board in the rail goes back; the view picked is still there after a reload.
- **C3 Signals.** A row shows a volt ask count while asks or permission waits wait there and a LiveDot while a session
  works (blinking) or is busy (still); its accessible name is `projectLabel` ("InThink, 2 need you, working"). An open
  archived project is one more row at the end with an `ARCHIVED` chip.
- **C4 Keys.** The project rows are one Tab stop: Up and Down move, Enter or Space opens; the views are a second stop
  with the same keys; `[`, `]`, `1` to `9` as today; Alt with Up or Down, or a drag, reorders, and the order survives a
  reload.
- **C5 Menus.** Right-click, Shift F10 or the context-menu key on a row opens a v3 menu: Archive (with its sessions
  line), Rename… (a Field), Delete… (a danger Confirm); Unarchive on the archived row. The rail foot's `Archived · n`
  opens the archived and recently deleted menu.
- **C6 Widths.** 1360 and up: C1. 720 to 1359: a 76 px rail of three-letter codes (clash digit), views as `BRD`, `PRJ`,
  `BKL`, `DON`, the ask count a small volt block at the row's top right, no LiveDot. Under 720: a sideways strip of full
  names with `⋯` at its right end for the foot, and the views as a segmented TabStrip at the top of the page.

Owner check depth: a list. Parvati at 1600, 1360, 1159, 720 and 400 (the handoff names 1600, 720, 400; section 6 adds
the two boundaries).

## Decisions (Sigmund, named in the receipt)

- **Project rows are `<a href="#/p/<slug>">`** with `aria-current="page"` on the current one. A plain left click (no
  modifier) calls `preventDefault` and `onSelect(slug)`, so the existing selection path runs; Ctrl or middle click
  still opens a new tab. **View rows are `<button>`s** with `aria-current="page"` on the current view: a view has no
  address, it lives in `ip.view`.
- **Arrow keys move focus only**, they no longer open what they reach (section 6: "Enter or Space opens"). Up and Down,
  and Left and Right too (for the strip under 720), move between rows; Home and End go to the ends. Alt with Up, Down,
  Left or Right reorders an active row. Space opens a row (a link does not do that natively).
- **The menus keep MenuSurface's machinery and wear the v3 parts.** The roving focus, the confirm and rename modes and
  the outside-press close stay as they are (they are tested); items become `MenuItem` parts where an item is one action,
  the confirm becomes the `Confirm` part (`danger`, action `Delete`), the rename field the `Field` part. Because the
  items swap out for the confirm rather than nesting it, #499's debt "Confirm inside a Menu clashes with its arrow
  keys" does not arise; the receipt says so.
- **Focus back from a confirm or rename** follows the index of the menu item last focused (an `onFocus` on the surface
  records it), not a `data-item` attribute, so `MenuItem` (a shared part) needs no change.
- **Opening Backlog or All done from the Board's links** puts focus on the rail's current view row, or on the views
  TabStrip's selected tab under 720 (whichever is visible). Picking a view in the rail keeps focus on the row.
- **The foot button's name is its text**, `Archived · n` (n = archived plus recently deleted). Under 720 the text is
  visually hidden and `⋯` shows (`aria-hidden`), so the name stays the same.
- **The rail codes** come from one helper over the rail order, and the Project view's code block uses the same map:
  #503's clash-digit debt.
- **`noteAction('header', 'view')` keeps its area name**: the usage report reads it. Picking Backlog, from the rail or
  the Board, still posts `backlog_open` and notes `('backlog', 'all')`; All done notes `('done', 'all')`.
- **Section 12's line numbers are as of 7933a3f**; find the tests by content.

## Files

Owned: `web/src/chrome/*` except `GoTo.tsx` and `goToText.ts`; new `web/src/chrome/Rail.tsx`, `projectMenus.tsx`,
`railLogic.ts`; delete `TopBar.tsx` and `ViewSwitch.tsx`; `web/src/App.tsx`; `web/src/views/view.ts`;
`web/src/backlog/BacklogList.tsx` and `web/src/done/DoneList.tsx` (the "‹ Board" button only); `web/src/project/ProjectView.tsx`
and `web/src/page/PageHead.tsx` (pass the code through, nothing else); new `web/src/styles/rail.css` (components layer,
imported in `web/src/main.tsx` after `chrome.css`); `web/src/styles/chrome.css` (delete the tab row, view switch and ⋯
rules only); `.ip-donelist-back` rules in `backlog.css` and `done.css`; `test/web/*` for unit tests; in
`test/e2e/ui.spec.ts` the `tabFor` helper and its uses, the tab-row tests, and a new `test.describe('Module rail')` at
the end.

Not touched: `web/src/panels/`, `panels.css`, `GoTo.tsx`, `goToText.ts`, and every `.ip-goto*`, `.ip-menu`, `.ip-mi`,
`.ip-reader-mark`, `.ip-cmd-mark` rule in `chrome.css` that GoTo's markup or a panel still uses (grep `web/src` for each
class before deleting a rule; keep it if anything outside the deleted files uses it). `web/src/parts/*`. The server.

## Tasks

### 1. The rail's structure, and the e2e helper on it (full e2e green before any look)

- `railLogic.ts` (pure, unit-tested in `test/web/railLogic.test.ts`):
  - `railCodes(rows: {id, name}[]): Map<number, string>`: `projectCode(name, names of the rows before it)` in rail order.
  - `railViews(snapshot, now)`: `[{ view: 'board', label: 'Board', code: 'BRD' }, { view: 'project', label: 'Project', code: 'PRJ', count, unit: 'phases' }, { view: 'backlog', label: 'Backlog', code: 'BKL', count }, { view: 'done', label: 'All done', code: 'DON', count }]`.
    The counts reuse what exists: the Project view's phase count, the Board's Backlog preview "N ›" figure (parked
    excluded), the Board's All done count. Find where each is derived; export the function from where it lives if it
    is not exported; write no new counting logic. If one is computed inline in a component, move that expression into an
    exported function beside it, unchanged.
- `views/view.ts`: `View = 'board' | 'project' | 'backlog' | 'done'`; `loadView` returns any of the four stored, else
  `'board'`. Unit test the four and a bad value.
- `projectMenus.tsx`: move `MenuSurface`, `RenameField`, `TabMenu` (rename `RowMenu`) and `ArchiveMenu` (rename
  `FootMenu`) out of `TopBar.tsx` unchanged in this task, except: `RowMenu` takes the row element, and positions itself
  right of the row (`left = r.right + 4`, `top = r.top`) when the rail is a column, under it (`top = r.bottom + 4`,
  `left = r.left`) when the rail is the strip (the rail element's `data-layout`, below), clamped inside the window both
  ways; it closes when the rail scrolls on either axis or the window resizes. `FootMenu`'s surface is `position: fixed`
  too (the rail's overflow would clip an absolute one): above the foot button, left aligned, in the column; under the
  `⋯`, right aligned, in the strip; clamped.
- `Rail.tsx`: `<nav className="ip-rail" aria-label="Projects" data-layout="column|strip">` (`data-layout` from a
  `matchMedia('(max-width: 719px)')` listener), holding:
  - `Eyebrow glyph="//"`: `PROJECTS`.
  - The rows (a `ul`, one `li` each) from `tabs` (projectTabs order). Each row: the `a` above, `data-tab={id}`,
    `title` and `aria-label` exactly as today's tab (`projectLabel`, with `, archived` on the archived row), the drag
    and drop logic, the reorder keys and the menu keys moved from `TabStrip` (vertical: `clientY` against the row's
    middle for the drop slot; in the strip, `clientX` as today; the drop line `drop-before` / `drop-after` classes as
    today). Roving tabindex as today's `stop`. Children: `span.ip-rail-rule` (style `--rr: var(--hue-<id % 7>)`),
    `span.ip-rail-name` (the name), `span.ip-rail-code` (the code), `span.ip-rail-sig` holding the ask count
    (`span.ip-rail-ask`, `waitingOn(p)`, only while above 0) and the `LiveDot` part (`still` while busy but not working,
    only while `busySessions > 0`); the archived row adds a `Chip` reading `ARCHIVED` after the name.
  - Under the current row, inside its `li`: `ul.ip-rail-views`, one `button.ip-rail-view` per `railViews` entry with
    `aria-current="page"` on the current view, `title` = label plus its count (`Backlog, 12`), children
    `span.ip-rail-vlabel` (label), `span.ip-rail-vcode` (code), `span.ip-rail-n` (count, when it has one, with `phases`
    for Project). Roving tabindex (the current view is the stop); Up, Down, Left, Right, Home, End move; Enter and Space
    are the button's own.
  - The foot, when there are archived or recently deleted projects: `div.ip-rail-foot` with the `Button` part
    (`variant="ghost"`, `size="sm"`, `aria-haspopup="menu"`, `aria-expanded`) holding
    `span.ip-rail-foot-full` (`Archived · n`) and `span.ip-rail-foot-short` (`⋯`, `aria-hidden`), and `FootMenu`.
  - Scroll the current row into view (`scrollIntoView({ block: 'nearest', inline: 'nearest' })`) when `current` or the
    row ids change, and on a ResizeObserver of the rail.
  - Props: TopBar's, minus nothing (tabs, archived, deleted, current, onSelect, onMove, onAction, onRename, view,
    onView), plus `views` (from `railViews`) and `codes` (from `railCodes`). The refocus-after-action effect moves over:
    its fallback is the current row (`a[aria-current="page"]`), else the foot button.
- `App.tsx`: render `<div className="ip-shell"><Rail …/><main className="ip-main">…</main></div>` between the HUD edge
  and the footer, in place of `<TopBar>`. Delete `TopBar.tsx` and `ViewSwitch.tsx`.
- `ui.spec.ts`: `tabFor` becomes
  `const railRow = (page: Page, name: string | RegExp) => page.getByRole('navigation', { name: 'Projects' }).getByRole('link', { name });`
  and all 82 uses switch to it; `toHaveAttribute('aria-selected', 'true')` becomes
  `toHaveAttribute('aria-current', 'page')`, and `'false'` becomes `not.toHaveAttribute('aria-current')`. `tabTitles`
  becomes `railTitles` over the same links. `STRIP` points at `.ip-rail`. Any `getByRole('tab')` or
  `getByRole('tablist')` that meant the project tabs moves to the rail. Fix what this alone breaks; the behaviour
  rewrites come in task 4.
- Check: typecheck, unit, then the **whole** `ui.spec.ts` on your port. Tests that fail only because they assert the
  old behaviour task 4 rewrites (arrow keys opening a tab, the wheel, the view switch, "‹ Board", ⋯'s name) are listed
  in your report by name, not fixed here. Everything else green. Commit nothing; report.

### 2. Views as peers

- `App.tsx`: drop `doneOpen`, `backlogOpen` and their focus effects. `pickView(v)` sets and saves the view and posts
  `view`; for `backlog` also `noteAction('backlog', 'all')` and `postEvent('backlog_open', …)`; for `done`
  `noteAction('done', 'all')`. The main area renders by `view`: `board` → Board, `project` → ProjectView, `backlog` →
  BacklogList, `done` → DoneList. Board's `onOpenBacklog` and `onOpenDone` call `pickView` and then move focus as the
  Decisions say (a counter state and an effect, as `needsFocus` does). The HUD's `onBoard` and `onAsks` keep calling
  `pickView('board')`.
- `BacklogList.tsx`, `DoneList.tsx`: remove the "‹ Board" button and the `onBack` prop. Remove the
  `.ip-donelist-back` / `.ip-backlogview-back` rules in `backlog.css` and `done.css` if nothing else uses them.
- Under 720: render the views as `<TabStrip variant="segmented" label="Views" items={…} value={view} onChange={pickView} className="ip-viewtabs" />`
  as the first child of `.ip-main`'s view area (before the view), items from `railViews` (label, count).
  `rail.css` hides `.ip-viewtabs` at 720 and up.
- The empty-window text: `Restore one from Archived` in place of `Restore one from ⋯`.
- `ProjectView`: pass `code={codes.get(snapshot.project.id)}` through to where it calls `projectCode`, which uses it
  when given.

### 3. The look: `rail.css`

v3 token names only. Follow the mock's `.rail`, `.mod`, `.sub`, `.askcount`, `.dot-live` rules for values, with these
class names: `.ip-shell` (flex row, `flex: 1`, `min-height: 0`), `.ip-main` keeps `flex: 1; min-width: 0`.

- `.ip-rail`: `flex: none; width: 216px; display: flex; flex-direction: column; gap: var(--sp-4); padding: var(--sp-6) var(--sp-3); border-right: 1px solid var(--line); background: var(--canvas-0)` (match the HUD), `overflow-y: auto; scrollbar-width: thin`.
- Rows (`.ip-rail a`): the mock's `.mod`: 36 px min height, `--font-display` at `--t-h3`, uppercase, ellipsis on
  `.ip-rail-name`; `.ip-rail-rule` the mock's `.rule` with `--rr`; hover volt text and a `--line-strong` edge; focus
  a volt edge and the `--volt-soft` ring; current (`[aria-current='page']`) volt fill, `--volt-ink` text, and the rule,
  the LiveDot and the count in ink on volt. `.ip-rail-ask` the mock's `.askcount`. `.ip-rail-code` hidden.
- Views: the mock's `.sub a` for `.ip-rail-view` (30 px, indented, mono `--t-detail-sm`, uppercase, muted; current volt
  with `›` before it; count in `--text-dim`). `.ip-rail-vcode` hidden.
- Drag: `.dragging` at half opacity; `.drop-before` / `.drop-after` a 2 px ink line on the row's top or bottom edge in
  the column, left or right edge in the strip.
- The foot: `margin-top: auto`, a `--line-soft` rule above, as the mock's `.sys`; `.ip-rail-foot-short` hidden.
- The menus: the row menu and foot menu surfaces take the `Menu` part's surface look (`.p-menu` values) with
  `position: fixed`, `z-index: 20`, `min-width: 200px`, `max-width: min(300px, calc(100vw - 16px))`, `max-height:
  calc(100vh - 16px)`, `overflow-y: auto`. Archived and deleted rows lay out as today's `.ip-mi-row`, restyled in v3
  (names in `--text`, the days left in mono `--t-micro` muted, actions as ghost text buttons). The row whose menu is
  open gets `.menu-open`: the hover look held.
- **720 to 1359** (`@media (max-width: 1359px)`): rail `width: 76px; padding-inline: var(--sp-2)`; the Eyebrow's text
  hidden (the `//` stays, centred); `.ip-rail-name`, `.ip-rail-vlabel`, `.ip-rail-n`, the archived Chip and the LiveDot
  hidden; `.ip-rail-code` and `.ip-rail-vcode` shown, centred; `.ip-rail-sig` absolute at the row's top right with the
  ask count at `--t-micro`; views not indented.
- **Under 720** (`@media (max-width: 719px)`): `.ip-shell` a column; the rail a row: `width: auto; flex-direction: row;
  align-items: center; gap: var(--sp-2); padding: var(--sp-2) var(--sp-3); border-right: 0; border-bottom: 1px solid
  var(--line); overflow-x: auto; overflow-y: hidden; scrollbar-width: none`; the rows `ul` a flex row; full names and
  the signals back (undo the 1359 hides for the name, the LiveDot and the chip), codes hidden; the Eyebrow and
  `.ip-rail-views` hidden; the foot `margin: 0 0 0 auto; border: 0; padding: 0`, `.ip-rail-foot-full` visually hidden
  (the clip pattern `.ip-hud-linkword` uses), `.ip-rail-foot-short` shown. `.ip-viewtabs` shown with `--sp-4` side
  padding at the top of the page.
- `prefers-reduced-motion`: the LiveDot part already stops; add nothing unless something here animates.
- `chrome.css`: delete the `.ip-topbar`, `.ip-tab*`, `.ip-viewswitch`, `.ip-view-btn`, `.ip-archive*` rules, and the
  menu rules only the deleted markup used (see Files). Update the file's head comment.

### 4. Tests

- Rewrite for the rail, by content (section 12): the view switch remembered (now: pick Backlog in the rail, reload,
  Backlog is still shown); the long name (full name in the row's title and name, the visible name cut with an
  ellipsis at 216 px); the live signal and reduced motion (the LiveDot part); one Tab stop with Up and Down moving
  focus without opening, Enter and Space opening, and the views as a second stop; the row menu (right-click opens
  without switching, Archive); Delete's sessions note; Rename's field; the menus' look (the v3 surface, the danger
  Confirm); a menu inside a narrow window (open a row menu at 400 px in the strip: it stays inside the window, and a
  strip scroll closes it). The tab strip's wheel test is deleted. "A tab dragged near the edge of a narrow strip
  scrolls it" is rewritten for the strip under 720. Tests that name ⋯ by `Archived and deleted projects` use
  `/^Archived · /`.
- New, in `test.describe('Module rail')` at the end of the file:
  1. From the Board: pick Backlog in the rail (its view shows, no "‹ Board"), pick All done (its view shows), pick
     Board (the Board shows). Then the Board's "N ›" opens Backlog with focus on the rail's Backlog row.
  2. At 1000 px: the rows show their codes (two projects whose names clash show the digit) and the views show `BRD`,
     `PRJ`, `BKL`, `DON`; at 400 px the rail is one row high with full names, the views are a tablist named `Views`
     above the page, and its Backlog tab opens Backlog.
- Unit: `railLogic` (codes with a clash; views with counts), `loadView`.

## Checks

From the worktree: `npm run typecheck`; `npm test`; the whole `test/e2e/ui.spec.ts` with `INPROGRESS_E2E_PORT=4415`, the
way `npm run test:e2e` runs it. No U+2014 in any changed file (`test/repo/no-em-dash.test.ts`).
