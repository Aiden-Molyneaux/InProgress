# Plan: Shell, the v3 HUD bar and footer strip (#500)

Spec: `docs/superpowers/specs/2026-10-18-window-v3-port-design.md` section 5 (:471-541), parts table (:409-453).
Mock: `C:/Users/aiden.molyneaux/.inprogress/resources/inprogress/2026-10-18-board-in-inthink-v3-mock.html` (HUD css :125-145,
footer css :303-312, media :340-380, markup :392-413 and :652-663).
Branch `claude/v3-hud-d9b25e`, worktree `.claude/worktrees/v3-hud-d9b25e`. Label ui.

## Boundaries

#503 Project view is built at the same time in another worktree. Touch only: `web/src/chrome/`, `web/src/styles/chrome.css`,
`web/src/App.tsx` (only the render tree, the status line and the HUD handlers described here), new tests in
`test/web/`, a new `test.describe('HUD bar and footer strip')` at the end of `test/e2e/ui.spec.ts`, and the single
existing e2e lines named below. Never touch `project.css`, `web/src/project/`, `web/src/parts/`, `parts.css`, `tokens.css`.
New CSS uses v3 token names (`--canvas-0`, `--line`, `--text-muted`, `--volt`, `--alarm`, `--sp-*`, `--t-*`), never Quiet's
aliases (`--bar`, `--border`, `--muted`, `--text-2`, `--panel-2`, `--float`...). The alias map is in `tokens.css`.

## Criteria (the bar)

- C1 Frame: the window is a column: HUD (60 px, 48 px under 720), the ruler, today's tab row, the page (scrolls inside),
  the footer. HUD and footer never scroll. Nothing in the HUD or footer wraps at 1600, 1160, 720 or 400.
- C2 ASKS: `[ASKS] n` sums `openAsks + permissionWaits` (`waitingOn`, `chrome/tabs.ts:120`) over every active project; volt
  above 0; its title lists each project with asks and its count. Click: when the open project has asks, the Board shows
  and focus moves to the Needs me heading (`.ip-band-needs h3`); otherwise the first active project in tab (rail) order
  with asks opens on its Board. At 0 the click does nothing (`aria-disabled`). The figure blinks once when it rises
  (static under reduced motion).
- C3 LINK: `[LINK] OK`; while the stream reconnects `[LINK] RECONNECTING` in alarm with a blinking square (LiveDot is
  volt, so use a small alarm square in chrome.css with the parts' `p-blink` keyframes), and an alarm Tape takes the
  ruler's place without moving the page. `.ip-banner` is gone.
- C4 Responsive: >=1160 shows everything; 720-1159 hides READY, BACKLOG and the date; <720 shows only the wordmark, ASKS,
  LINK and Find (glyph only). Footer: key hints hidden <1160, server line hidden <720.
- C5 Footer: activity line as today (LiveDot first while a session in this project is working, "No activity yet" when
  none); key hints `Ctrl K` Find always, `[ ]` Projects with two or more tabs, `Esc` Close while Details, the viewer or any
  menu is open; server line `LOCALHOST:4317 · BUILD 8b796d9` (+DIRTY, build time in its title).
- C6 Toasts and empties: the status line is the Toast part (bottom left above the footer, 4 s, an action failure in alarm
  that stays until dismissed); no projects shows an EmptyState; before the first load the HUD shows with the link
  readout over a centred EmptyState ("Loading…", or "Can't reach the InProgress server, retrying…" in alarm).

## Tasks

### 1. Pure HUD logic: `web/src/chrome/hud.ts` + `test/web/hud.test.ts`

- `hudFigures(projects: ProjectSummary[], tabOrder: Pick<ProjectSummary,'slug'>[])`: active projects only
  (`status === 'active'`). Returns `{ asks, asksTitle, live, liveTitle }`. asks = sum of `waitingOn`; live = sum of
  `busySessions`. Titles: one line per project with a non-zero figure, `"<name>: <n>"`, in tab order; when none,
  `"Nothing waits on you"` / `"No sessions working"`.
- `askTarget(tabs, currentSlug)`: `'here'` when the current tab is active and has `waitingOn > 0`; else the slug of the
  first active tab with `waitingOn > 0`; else `null`.
- `boardFigures(board: Board)`: `{ ready: board.next.filter(r => r.ready).length, backlog: <the same total the Backlog
  preview's "N ›" shows> }`. Find that total in `web/src/backlog/` (`PreviewPanel.tsx:48`, `total`) and reuse its source
  function; do not recount differently.
- `clockText(d: Date)`: `{ time: 'HH:MM' (24 h, local), date: 'Oct 19, 2026' }` via `Intl.DateTimeFormat('en-US', ...)`.
- `serverLine(host: string, build: BuildInfo | null)`: `'LOCALHOST:4317 · BUILD 8b796d9'`, `+DIRTY` appended to the sha
  when dirty; with no build, the host alone. Uppercase.
- `footerKeys({ tabs: number, escapable: boolean })`: the list of `{ keys, label }` for the hints (C5).
- Vitest each, including: archived projects ignored, tab order respected, `'here'` wins over an earlier tab, null when
  none, dirty build, null build.

### 2. Clock hook: `web/src/chrome/useMinute.ts`

Returns a `Date` that updates at each local minute boundary (setTimeout to the next minute, then re-arm). Clears on unmount.

### 3. The HUD: `web/src/chrome/Hud.tsx`

`<header className="ip-hud">`, grid `auto minmax(0,1fr) auto`.
- Left: `<button className="ip-hud-mark">InProgress</button>` (brand face, `--t-h3`, volt, uppercase, letter-spacing as the
  mock :128; 1rem under 720). Click: `onBoard()`.
- Centre (`.ip-hud-figs`, `aria-label="Window readout"`): a `<button className="ip-hud-asks">` holding
  `<Readout label="Asks" value={n} tone={n>0?'volt':'text'}/>`, `title=asksTitle`, `aria-disabled` when 0, onClick
  `onAsks()`. A rise (use `countRose` from `parts/countLogic`, ref-after-check as `parts/Count.tsx` does) adds a class
  that runs `p-strobe` once on its value; none under reduced motion. Then `<Readout label="Live" value={live}
  title={liveTitle}/>`, then (`.ip-hud-wide`, hidden <1160) `Ready` and `Backlog` from the open snapshot (omitted with no
  snapshot).
- Right (`.ip-hud-right`): `<Readout className="ip-hud-link" label="Link" value=...>`: `OK` (tone text), or a small alarm
  blinking square plus `RECONNECTING` (tone alarm). Then `.ip-hud-when` (hidden <720): the date (mono, muted, hidden
  <1160) and the time as `<time className="ip-hud-clock" dateTime=ISO>` in `--font-dot`, volt, as the mock's
  `.when .clock`. Then the Find button (task 5).
- Props: `{ loaded, connection, projects, tabs, current, snapshot, now, goTo, onGoTo, onBoard, onAsks }`. With
  `loaded === false`, render only the wordmark and the LINK readout.
- 60 px tall, `--canvas-0`, `--sp-5` side padding, gap `--sp-5`; under 720: 48 px, `--sp-4` padding, gap `--sp-3`,
  `overflow: hidden`. Nothing wraps (`white-space: nowrap`; the centre `min-width:0; overflow:hidden`).

### 4. The HUD edge: ruler or tape

In Hud.tsx export `HudEdge({ connection })`: `<div className="ip-hud-edge">` holding `<Ruler variant="hud"/>` or
`<Tape tone="alarm"/>`. The box has the Ruler's height (read `.p-ruler[data-variant="hud"]` in parts.css and match it,
border included) so the page never moves; `.ip-hud-edge .p-tape { height: 100% }`. Remove `.ip-app::before` (Quiet's
hairline) and `.ip-banner` from chrome.css and App.

### 5. Find moves into the HUD (`web/src/chrome/GoTo.tsx`, `TopBar.tsx`)

- TopBar no longer renders `<GoTo>` and drops its `goTo`/`onGoTo` props; Hud renders `<GoTo ref={goTo} onGo={onGoTo}
  current={current}/>` at the HUD's right end. Do not change GoTo's open/close/focus logic.
- GoTo's button content becomes the glyph, then `<KeyHint keys={['Ctrl K']} label="Find" className="ip-goto-hint"/>`
  (hidden <720, glyph alone). Its `aria-label` becomes `"Find, go to a step"` (the visible "Find" stays in the name; the
  existing tests' `name: 'Go to a step'` still matches as a substring). Style the button as the mock's `.iconbtn`
  (:135-137): 32 px, `--line-bright` border, muted ink, volt ink and border on hover and focus-visible.
- Remove now-dead `.ip-goto` margin rules from the tab row (`.ip-archive ~ .ip-goto` etc.); keep the popover rules
  (`.ip-goto-menu` and friends): #505 restyles them. The popover still opens under its button at the right end.
- Existing e2e `ui.spec.ts:1534-1538` ("under the bar at its right end"): change `.ip-topbar` to `.ip-hud` in that one
  test. Nothing else in the GoTo tests.

### 6. The footer: `web/src/chrome/Footer.tsx` (ActivityStrip folds into it)

`<footer className="ip-footer">`: one line, `--canvas-0`, 1 px `--line` above, padding `--sp-3` `--sp-5` (`--sp-4` sides
<720), mono `--t-detail-sm`, `display:flex; justify-content:space-between; gap: var(--sp-6); white-space:nowrap`.
- Left: the activity line. Keep `ActivityStrip`'s markup and class names (`.ip-activity`, `.ip-act-who`, `.ip-act-when`,
  `.ip-act-what`) so the existing tests (ui.spec.ts:1239-1240, :1288) still pass unchanged; it drops its own bar look
  (height, background, border: the footer has them) and gains a leading `<LiveDot/>` when `working`. Accept a null
  snapshot (no projects) and show "No activity yet". Only the event shrinks.
- Centre (`.ip-footer-keys`, hidden <1160): `footerKeys(...)` as `KeyHint`s.
- Right (`.ip-footer-server`, hidden <720, muted, `--t-micro`, uppercase as the mock's `.credit`): `serverLine(location.host,
  build)`, `title` = `Built <builtAt>` when known. Fetch `api.health()` once on mount (check first whether the app already
  holds the build, e.g. in `Root.tsx`; reuse it if so). A failed fetch shows the host alone.
- `escapable` = Details open || viewer open || a menu open. A menu: add `web/src/chrome/useMenuOpen.ts`, a hook that
  watches the app root (`MutationObserver`, `childList` + `subtree`) and reports whether it holds `.ip-menu, .p-menu,
  [role="menu"]`, setting state only when the answer changes.

### 7. App.tsx wiring

- Root column: `.ip-app` = `<Hud/>`, `<HudEdge/>`, `<TopBar/>` (tab row), `<main className="ip-main">`, `<Footer/>`.
  `.ip-main` scrolls inside (it is `flex:1; min-height:0` already: confirm the page area, not the window, scrolls).
- Before the first load: return the same `.ip-app` column with `<Hud loaded={false}/>`, `<HudEdge/>` and a `main` holding
  a centred `<EmptyState className="ip-wait" data-alarm={reconnecting || undefined}>` with today's two texts; chrome.css
  colours its text alarm when `data-alarm`. Keep the texts exactly (ui.spec.ts:298 reads one).
- `onBoard = () => pickView('board')`. `onAsks`: `askTarget(tabs, state.slug)`; `'here'` → `pickView('board')` and bump a
  counter state whose effect focuses `.ip-band-needs h3`; a slug → `pickView('board')` and `state.selectProject(slug)`;
  null → nothing.
- No projects: `<EmptyState>` with "No projects yet. A Claude session adds one when it opts in." When deleted projects
  exist keep today's restore text in the same EmptyState. Change ui.spec.ts:954's selector from `.ip-empty` to `.p-empty`
  (text unchanged). "Loading project…" also becomes an EmptyState.
- Status line → Toast: replace `.ip-status/.ip-toast` and the 3 s timer with `<ToastRegion>` holding at most one
  `<Toast key={id} tone onDismiss={() => setStatus(null)}>`. `say(text, tone = 'neutral')`; onAction/onRename pass
  `'alarm'` when the result is not `'ok'`. A new message replaces the old one (new key).
- Remove the `ip-banner` line. `.ip-empty` stays in chrome.css: the Board's columns still use it.

### 8. Tab row in v3 tokens (chrome.css only)

Rewrite the `.ip-topbar`, `.ip-tab*`, `.ip-viewswitch`, `.ip-view-btn`, `.ip-archive*` rules with v3 token names for the
same values (alias map in tokens.css). Keep the 38 px height (ui.spec.ts:212, :612 assert < 50). No other visual change:
#501 replaces the row.

### 9. e2e: `test.describe('HUD bar and footer strip')` at the end of ui.spec.ts

One test: give two projects open asks (use the existing fixtures and `write(api, ...)` helpers as other tests do; find
how a test raises an ask), then: `[ASKS]` shows the sum; with the open project having none, clicking it opens the first
project in tab order with asks (its Board's name shows). Then drop the stream: `page.route('**/api/events/stream**',
r => r.abort())` and force a reconnect (or route the stream before `open` so it fails from the start: check
`useInProgress.ts:48` for when `connection` flips) and expect `.ip-hud-link` to read `RECONNECTING` and `.ip-hud-edge
.p-tape` to be visible; unroute and expect `OK` and the ruler back.

## Checks

From the worktree: `npm run typecheck`; `npm test`; the new e2e and every test that names `.ip-activity`, `.ip-act-`,
`Go to a step`, `.ip-topbar`, `.p-empty`, `Can't reach` with `INPROGRESS_E2E_PORT=4410` the way `npm run test:e2e` runs,
narrowed with `-g`; then the whole e2e file once on 4410 (the toast change can move any test that reads a status message).
`node -e` scan: no U+2014 in changed files (`test/repo/no-em-dash.test.ts` runs in `npm test`).
