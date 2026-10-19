# #505 Details, resource viewer and command bar in v3: plan

Branch `claude/v3-details-74a322`, worktree `.claude/worktrees/v3-details-74a322`, off main 10df75d. Label ui.
Spec: `docs/superpowers/specs/2026-10-18-window-v3-port-design.md` section 10 (and D4 in section 1, section 11 for narrow).

## Criteria (agreed with Aiden 2026-10-19, owner check depth: a list)

- C1 Details at 1600 reads top-down: head (Eyebrow `#id · KIND`, Copy #id, ×, the wrapping title), meta row of Chips,
  Parked, Asks, the step, Live work, Resources, Steps, Log; every section head an Eyebrow with its count.
- C2 On a long step, Park… in the sticky action strip is in view without scrolling, and opens its form in the strip.
- C3 At 400 px Details covers the page between the HUD and the footer; Esc closes it and focus returns to its tile.
- C4 The resource viewer in v3: Eyebrow head, title, outline buttons, Markdown at 68ch with v3 headings, code and links;
  copy and open results in the Toast; Esc returns focus to its opener.
- C5 Ctrl K opens the command bar; with nothing typed it lists the views and projects; "backlog" + Enter opens the
  Backlog view; a project's name + Enter opens that project; `#id` and words find steps as today, with today's messages.
- C6 (Aiden's call on the #503 flag) On the Project view, an open Details reserves its width: the page narrows beside it,
  the phase index stays visible left of Details, and under 1160 px of remaining page the index folds into the jump row.
  The Board keeps the plain overlay.

## File boundaries (#501 runs alongside in `.claude/worktrees/v3-rail-c86ca7`)

Owned here: `web/src/panels/*`, `web/src/styles/panels.css`, new `web/src/styles/commandbar.css`,
`web/src/chrome/GoTo.tsx`, `web/src/chrome/goToText.ts`, `test/web/goTo.test.ts`.
Small, named edits allowed outside: `web/src/App.tsx` (the `goTo` handler and the "No step" toast only),
`web/src/chrome/Hud.tsx` (the props passed to `<GoTo>` and the `onGoTo` type only), `web/src/chrome/chrome.css`
(delete the GoTo panel rules, lines 106-117 today; leave `.ip-goto`, `.ip-goto-btn`, `.ip-goto-hint` alone),
`web/src/main.tsx` (import `commandbar.css` after `panels.css`), `web/src/parts/Eyebrow.tsx` (add `'[⌕]'` to the
glyph union, nothing else). Do not touch TopBar, tabs, the rail, useKeyboard or any other chrome file.
`test/e2e/ui.spec.ts`: rewrite the tests named in task 4, fix any other test whose selector this change breaks (say
which in the report), and add new tests in one `test.describe('v3 Details, viewer and command bar (#505)')` block at
the end of the file.

Write new rules with v3 token names (`--canvas-*`, `--text*`, `--line*`, `--volt*`, `--alarm*`, `--sp-*`, `--t-*`,
`--w-*`, `--z-*`, `--dur-*`, `--ease-*`, `--font-*`), never Quiet's aliases (`--panel`, `--muted`, `--border`, `--fs-*`,
`--w-heavy`, `--link`, `--amber*`, `--faint`, `--text-2`...). No rounded corners. No em dashes anywhere.
Use the parts in `web/src/parts/` (Button, Chip, Eyebrow, ErrorLine, KeyHint, Frame, Toast/ToastRegion); never a
second copy of one.

## Task 1: Details layout and the reserve-room rule (panels.css, Details.tsx)

- On `.ip-main`: `--details-w: 380px` at `min-width: 720px`, `440px` at `min-width: 1360px` (viewport media queries).
- `.ip-details`: `position: absolute; top: 0; right: 0; bottom: 0; width: var(--details-w); z-index: var(--z-sheet);
  display: flex; flex-direction: column; background: var(--canvas-1); border-left: 1px solid var(--line-strong)`; no
  shadow, no scrim. Three children: the head (flex none), `.ip-dbody` (flex 1, `overflow-y: auto`, holds sections 2 to
  9), the action strip (flex none). So the head and strip stay put while the body scrolls.
- Enter: `@keyframes` clip-path `inset(0 0 0 100%)` to `inset(0)`, `var(--dur-3)` if that token is 320 ms (check
  tokens.css; else 320ms literal) with `var(--ease-out)`. Under `prefers-reduced-motion: reduce`, no animation.
- Under 720 px: `left: 0; width: auto;` (covers `.ip-main`, which sits between the HUD and the footer), no left border.
  Delete `.ip-grab` (rule and element) and the old bottom-sheet media block.
- Reserve room (C6): `@media (min-width: 720px) { .ip-main:has(> .ip-details) > .ip-project { margin-right:
  var(--details-w); } }`. ProjectView's `usePageWidth` then sees the narrower page and drops `data-wide` under 1160 px
  on its own; check that it does (it measures `.ip-project`'s clientWidth through a ResizeObserver). The Board, the
  Backlog view and All done get nothing.
- Focus: opening Details moves focus to its title, in a `useEffect` (not a layout effect: App's layout effect records
  the opener first and must still see the tile). The title is `h2.ip-dtitle` with `tabIndex={-1}`. Keep
  `<aside aria-label="Node details">`.

## Task 2: Details sections, top to bottom (Details.tsx, panels.css)

Keep all of today's data logic (LiveWork, AsksSection, trailGroups, the refetch, park/unpark focus handling, QuickAdd).
Change the markup and look only, except where a line below says otherwise.

1. Head: `Eyebrow` with `#482 · STEP` (the node's kind, uppercase), then at the right `Button variant="ghost" size="sm"`
   Copy #id ("Copied" for 1.2 s, as today) and `Button variant="ghost" size="sm" aria-label="Close"` ×. Under it the
   title `h2.ip-dtitle`: `--font-body`, 1.125rem, `--w-strong` (600), `--text-hi`, wrapping (no ellipsis).
2. Meta row (`.ip-meta`, flex wrap, `--sp-2` gaps): the Marker, then the status as a Chip (tone: active `live`,
   blocked `blocked`, parked `parked` dashed, needs-you `needs`, else `quiet`; text the status word), the label as
   `Chip tone="label" glyph={LABEL_GLYPHS[label]}`, who it is for (`Chip tone="needs"` "YOU" when assignee is me, else
   "Claude" in `--text-muted`), and `in #parent title` as today's link button (restyle `.ip-link`: `--text-hi`, dotted
   underline, volt on hover).
3. Parked: `.ip-dparked` with `border: 1px dashed var(--line-bright)`, padding `--sp-3`; an Eyebrow "Parked 12 Oct"
   (today's `shortDate`), the reason in body text, "where …" in `--text-muted`, `Button variant="outline" size="sm"`
   Unpark (keep its ref, busy via `busy={unparkBusy}`).
4. Asks: Eyebrow `// ASKS · n` (n = open + answered shown). Each open ask a panel (`--canvas-2`, `1px solid
   var(--line)`, a 2px volt left rule): Eyebrow line with `a5`, kind mark and kind, age; the raiser in `--text-muted`;
   the text in body; `AskActions` as today. Answered asks follow muted, one line each, ellipsis.
5. The step: the handoff Chip (keep a `<button className="ip-chip-handoff">`, styled as a quiet Chip) and hygiene marks
   as `Chip tone="quiet" dashed`; the body as Markdown with `max-width: 68ch`; the outcome in a panel (`--canvas-2`,
   `--line` edge, `--sp-3` padding) under `Eyebrow glyph="[✓]"` OUTCOME.
6. Live work: one `Eyebrow glyph="[◈]"` `LIVE WORK · n` (n = live tasks + subagents + commands) over the whole block,
   shown when any of the four lists has rows; the four sub-heads (Working tasks, Subagents, Background, Ended work)
   become small Eyebrows without a glyph in `--text-dim`. Background command rows render as a terminal readout: mono,
   `--t-detail-sm`, `--canvas-0` background. Ended work muted. Today's 30 s refresh stands.
7. Resources: `Eyebrow glyph="//"` `RESOURCES · n`; rows: title in body `--text`, summary in mono `--text-dim` at the
   right; hover `--canvas-3`.
8. Steps: `// STEPS · n`; rows: Marker, `#id` mono `--text-dim`, title, `Chip tone="needs"` YOU where today's rule
   shows YOU.
9. Log: `// LOG · n`; time in mono `--text-dim`, the text `--text`, the session `--text-muted`.
10. Action strip `.ip-dstrip` (outside `.ip-dbody`): `border-top: 1px solid var(--line)`, `--canvas-1`, padding
    `--sp-3 --sp-4`, flex wrap. Park… (`Button variant="outline" size="md"`, only when `parkable`) and Add a step
    (`Button variant="ghost" size="md"`, visible text "Add a step", `aria-label` "Add a step under #<id>"), then at the
    right `UPDATED 2M AGO` (the uppercase of today's `relativeTime(node.updatedAt)`) in mono `--text-dim`. Opening Park…
    or Add a step replaces the two buttons with the form (ParkForm / QuickAdd) inside the strip; give the strip a
    `max-height: 50%` with `overflow-y: auto` so a form never pushes the head off. Keep today's focus moves back to the
    buttons. A failed refresh replaces the UPDATED line with `ErrorLine message="Couldn't refresh" onRetry={retry}`;
    the last detail stays on screen.
- Retry: add an `attempt` counter to the refetch effect's deps; `retry = () => setAttempt((n) => n + 1)`.
- Section heads: Eyebrow `as="h3"`. Spacing `--sp-5` between sections inside `.ip-dbody` (padding `--sp-4`).
  Empty sections are left out, as today. Content text is `--font-body` at `--t-body`; no uppercase on content.
- Loading: the head with the Eyebrow `#id` and × only, and "Loading…" in `--text-muted`. A failed first load:
  `ErrorLine` with the message and Retry.
- Delete Details rules that no longer match anything. Keep class names other surfaces share (`.ip-wt`, `.ip-dagent`)
  scoped under `.ip-details`.

## Task 3: the resource viewer (ResourceViewer.tsx, panels.css)

- `.ip-viewer`: `position: fixed; inset: 0; z-index: var(--z-command); background: var(--canvas-1)`; flex column.
- Head (`border-bottom: 1px solid var(--line)`, padding `--sp-3 --sp-4`): left block with an Eyebrow `R324 · HANDOFF`
  (`r` id uppercased and the resource's `kind` uppercased) over the title (body face, 1.125rem, 600, `--text-hi`, one
  line with ellipsis is fine here); at the right Copy, Open file, Copy path, Open link as `Button variant="outline"
  size="sm"` (each only when it applies, as today), then × as `Button variant="ghost" size="sm" aria-label="Close"`.
  Before the resource loads the title reads "Resource".
- Body: the scroller stays `.ip-viewer-body` (focused on open, `tabIndex={0}`, focus ring volt inset); inside it a
  `.ip-viewer-doc` with `max-width: 68ch; margin: 0 auto; padding: var(--sp-8)` (`--sp-4` under 720 px).
- Markdown (`.ip-md`, shared with Details and the slab): headings `--font-body` 600, h1 1.5rem, h2 1.25rem, h3 1rem,
  h4 to h6 `--t-body`, never uppercase; code mono; `pre` on `--canvas-0` with a `--line` border; tables with `--line`
  rules; links `--text-hi` dotted underline, `--volt` on hover. Keep sanitising as is (Markdown.tsx unchanged unless a
  class is needed).
- States as today ("Loading…", the error as `ErrorLine`, "File: <path>", the URL, "No content"), in `--text-muted`.
- The viewer's own toast becomes the Toast part: a `ToastRegion` inside the viewer (the app behind is inert) holding
  `<Toast key={id} onDismiss=…>` for 'Copied', 'Path copied', 'Opened' (neutral), and a failed open as `tone="alarm"`.
  Delete `.ip-toast` from panels.css if nothing else uses it (grep).

## Task 4: the command bar (GoTo.tsx, goToText.ts, commandbar.css, Hud.tsx and App.tsx edits)

Model (goToText.ts, pure, unit-tested in `test/web/goTo.test.ts`):
- `export type GoView = 'board' | 'project' | 'backlog' | 'done'` and
  `export type GoTarget = { kind: 'view'; view: GoView; label: string } | { kind: 'project'; slug: string; label: string; name: string }`.
- `goTargets(projects: { slug: string; name: string }[], current: string | null): GoTarget[]`: the views in order
  Board, Project, Backlog, All done, then "Open <name>" for each project in the order given, leaving out `current`.
- `matchTargets(text: string, targets: GoTarget[]): GoTarget[]`: empty text → all; an id query (`parseGoTo` kind
  `id`) → none; otherwise the typed words, lowercased, with a leading word "open" dropped, must each be a prefix of a
  word of the view label or project name (case-insensitive). "backlog" → Backlog; "all" → All done; "inth" → Open InThink.
- Keep `goToMessage`, `hitLabel`, `pickHit`, `isGoToChord`; add `targetKey(t)` (`view:<v>` / `project:<slug>`).

Behaviour (GoTo.tsx; keep the Find button and the `GoToHandle` exactly as they are):
- Props: `onGo: (pick: GoPick) => void` with `GoPick = { kind: 'step'; hit: StepHit } | GoTarget` (export the type),
  `current`, and new `projects: { slug: string; name: string }[]` (rail order).
- The panel is a `<dialog className="ip-cmd">` opened with `showModal()` in a layout effect when `open` turns true
  (that makes the window behind inert and puts it in the top layer) and closed with `close()`. Handle the dialog's
  `cancel` event with `preventDefault()` (our keydown already closes on Escape and returns focus). A mousedown whose
  target is the dialog element itself (the backdrop) closes without refocus, as today's outside press does. Remove the
  window mousedown listener.
- Rows: one listbox (`aria-label="Results"`), two `role="group"` blocks, each led by an Eyebrow: `// GO TO`
  (`aria-label="Go to"`) first, `// STEPS` (`aria-label="Steps"`) second. Go to shows `matchTargets` synchronously;
  Steps shows today's `api.find` hits (150 ms debounce, newest request wins). Each block is left out when empty.
- Highlight by key, not index: `active` is a string (`targetKey` or `step:<id>`) or null. When the visible rows change
  and the highlighted key is no longer among them, highlight the first row (none when no rows). Up and Down move over
  the concatenated rows (Go to then Steps) with `menuStep`. Typing sets the highlight to the first Go to row when there
  is one, else none until the steps answer lands (then the first step), so Enter never picks a row of an old list.
- Enter: a highlighted Go to row is picked at once; otherwise today's step flow (ask now when the answer is not in,
  `pickHit` by id, "No step #N" for a missing id). With Go to matches and no highlight, the first Go to row.
- Picking: focus goes to the Find button, the bar closes, then `onGo(pick)`, as today's step pick does.
- Tab and Shift+Tab stay in the field (preventDefault): the bar has one focus stop. Ctrl K inside is swallowed, as
  today. Every key still stops propagating.
- Labels: input `aria-label="Find: go to a step, a project or a view"`, placeholder "#id, a step's title, a project or a
  view". The Find button's name stays as today.
- Note line (`.ip-cmd-note`, `aria-live="polite"`): `goToMessage` as today; "No step #N" and "Couldn't search: …" in
  `--alarm` (the #500 debt), counts in mono `--text-dim`.
- Foot: `KeyHint` ↑↓ Move, Enter Open, Esc Close.

Look (commandbar.css, `@layer components`):
- `.ip-cmd`: `position: fixed; top: 15vh; margin: 0 auto; width: 640px; max-width: calc(100vw - 2 * var(--sp-4));
  padding: 0; border: 1px solid var(--line-strong); background: var(--canvas-1); color: var(--text); overflow: visible`
  with a `<Frame />` inside (the dialog `position: fixed` counts as positioned for Frame). `::backdrop { background:
  var(--scrim); }`. Enter: clip-path `inset(0 0 100% 0)` to `inset(0)` over 320 ms `var(--ease-out)`; reduced motion:
  an opacity fade. Under 720 px: `top: 0; width: 100%; max-width: none`, no side borders.
- Field block: `Eyebrow as="label" glyph="[⌕]"` FIND tied to the input; the input `--font-body` 1rem, `--canvas-0`,
  `1px solid var(--line)`, volt focus outline, placeholder `--text-dim`.
- Rows: 32 px min height, `--sp-2 --sp-3` padding; step row `#id` mono `--text-dim`, title `--text` with ellipsis, the
  project at the right in mono `--text-dim` (archived: `· ARCHIVED` after the name), finished steps' titles
  `--text-muted`; Go to rows: the label in `--text`, a mono `--text-dim` tag at the right (`VIEW` / `PROJECT`).
  `[aria-selected='true']`: `background: var(--volt); color: var(--volt-ink)` (and its children inherit the ink).
  The list scrolls inside `max-height: 50vh`.
- Hud.tsx: pass `projects={tabs.map((t) => ({ slug: t.slug, name: t.name }))}` (check the tab type's field names) and
  change `onGoTo`'s type to `(pick: GoPick) => void`. Nothing else in Hud.
- App.tsx `goTo(pick)`: `step` → today's body with `pick.hit`; `view` → `board`/`project`: `pickView(v)`; `backlog`:
  `pickView('board'); openBacklog()`; `done`: `pickView('board'); openDone()`; `project` →
  `state.selectProject(pick.slug)`. And the jump's `drop()` toast becomes `fail(...)` (alarm), the #500 debt.

## Task 5: tests

Unit (`test/web/goTo.test.ts`): `goTargets` order and current left out; `matchTargets` for empty, id, "backlog",
"all", "open inth", "inth", a word that matches nothing, two words narrowing. Existing goToText tests stay.

e2e rewrites in `test/e2e/ui.spec.ts` (find by title):
- "Details lists the node's working tasks with who is on each, and the subagents on it, before its resources, each on its own row"
- "a label is a glyph and its word in muted ink on the row, and Details names it in its meta line; its log entries wear Quiet"
  (Details' half moves to the label Chip and v3 log; leave the row half to #502 if it asserts on the Board row, only
  change what this branch broke)
- "a row opens Details, which copies a reference, wears Quiet, and lists its steps with their markers and YOU tag" (wears v3)
- `test.describe('Go to')`: the helpers move to the bar (`combobox` by its new name, the `Steps` group's options);
  "wears the menus' surface, under the bar at its right end" becomes the bar's surface (640 px, centred, top near 15 %,
  scrim behind); the unknown-id test's note colour becomes `--alarm`; "Tab closes it" becomes "Tab stays in the bar".
- Any other test this change breaks (Add a step's button text, Details header selectors, the 400 px sheet): fix the
  selector, keep the behaviour, and list each in the report.

New e2e in the `#505` describe block:
1. "the command bar lists views and projects, and backlog + Enter opens the Backlog view" (also: a second project's
   name + Enter switches to it).
2. "Details' action strip opens Park without scrolling on a long step" (a step with a long body and many log lines;
   the Park… button's box is inside the viewport and Details' box; click opens the form in the strip).
3. "at 400 px Details covers the page and Escape returns focus to its tile" (Details' box equals `.ip-main`'s box).
4. "on the Project view at 1600 px an open Details leaves the phase index in view beside it" (index box right edge ≤
   Details' left edge; at a viewport where the remaining page is under 1160 px the jump row shows instead).

## Checks (Sev runs, Sigmund reruns)

- `npm run typecheck`, `npm test`.
- e2e narrowed: the rewritten and new tests, plus the `Go to` and `Details` describes, on port 4410-4419:
  `INPROGRESS_E2E_PORT=<port> npx playwright test test/e2e/ui.spec.ts -g "<pattern>"` the way `npm run test:e2e` does
  (read package.json for the exact runner command).
- `test/repo/no-em-dash.test.ts` is part of `npm test`.

## Review

Murr on Opus (focus, a modal, the keyboard). Parvati at 1600, 720 and 400: Details on a step with every section, the
viewer, the bar (empty, typed, no match, error), Details over the Project view at 1600.
