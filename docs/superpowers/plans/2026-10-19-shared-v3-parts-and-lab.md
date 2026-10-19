# #499 Shared v3 parts and the `#/lab` specimen page: plan

Step #499 of #495 Port the window to InThink v3. Label ui. Spec: `docs/superpowers/specs/2026-10-18-window-v3-port-design.md`
section 4 (the parts and the lab), 2.5 to 2.9 (ramp, space, motion, layers, textures), section 12's #499 row (tests).
Look model: the mock `C:/Users/aiden.molyneaux/.inprogress/resources/inprogress/2026-10-18-board-in-inthink-v3-mock.html`,
lines 65-120 (shared type, buttons, chips, kbd, readout), 139-144 (ruler), 160-172 (live dot, ask count), 199 (tape),
220-257 (tile, frame, answer field), 275-281 (tabs), 292-300 (done tile, since ruler), 379-383 (reduced motion).

Branch `claude/v3-parts-31cae0`, worktree `.claude/worktrees/v3-parts-31cae0`. Nothing outside `#/lab` changes on screen.

## Criteria (the bar)

- C1 · type `#/lab` after the window's URL · the lab opens: every part under its own heading, the tokens, ramp, hues and
  motion; nothing in the window links to it; changing the hash back to `#/p/<slug>` returns to the window.
- C2 · open the Board, Project, Backlog and All done · each looks as it did before this step (no `p-` class is used
  outside the lab).
- C3 · in the lab, Tab to the TabStrip and press Right, Left, Home, End · the selection moves with focus and wraps at
  the ends; a tab scrolled out of view comes back into view when selected.
- C4 · in the lab's ListCursor grid, press the arrows, Enter, then Tab · arrows walk across and down to the nearest
  item, Enter shows the opened item, Tab leaves the grid in one stop.
- C5 · view the lab at 1600 and 400 wide · no sideways page scroll, every specimen readable; Replay replays the tile
  rise and the Count rise; under reduced motion nothing moves or blinks.

## Rules every file follows

- No em dashes (U+2014) anywhere: `test/repo/no-em-dash.test.ts` scans every file.
- Sheets obey `test/web/tokens.test.ts`, which reads every `web/src/styles/*.css`: no literal colour (hex, rgb(a), hsl,
  `black`, `white`) outside `tokens.css`; `font-size` only `var(--t-*)` or an `em` size; `font-weight` only
  `var(--w-*)`; `font-stretch` only 75%, 87.5%, 100%, 112.5%, 125%; no `font:` shorthand but `inherit`; no
  `border-radius` but 0. Use v3 token names only, never Quiet's aliases (`--muted`, `--active`, `--fs-s`...).
- Global classes with the `p-` prefix, variants as `data-*` attributes (`.p-chip[data-tone="needs"]`). No CSS modules.
- All part rules go in `web/src/styles/parts.css` inside `@layer parts { ... }`, imported from `web/src/main.tsx` right
  after `base.css`.
- Comments match the codebase: a short doc comment on each exported part and helper, saying what it is for.
- React 18: parts that callers focus or measure use `forwardRef`. Every part passes through `className` (appended) and
  the rest of its root element's HTML attributes, unless its section says otherwise.
- Every interactive part (Button, TabStrip tab, Field, Menu item, Chip remove, Tile title) has: hover; `:focus-visible`
  (a 2 px volt outline, or on boxed controls a volt border plus `box-shadow: 0 0 0 2px var(--volt-soft)` with
  `outline: none`); pressed `translate: 0 1px` on `:active`; disabled `opacity: .45` with no hover change (write hover
  rules as `:hover:not(:disabled):not([aria-disabled="true"])`).
- Transitions: colour, background-color, border-color on `var(--dur-1) var(--ease-std)`; translate on `--dur-1`.

### Shared type

`.p-eyebrow, .p-chip, .p-btn, .p-key, .p-readout-key, .p-tab, .p-keyhint-label`: `font-family: var(--font-brand);
font-size: var(--t-micro); letter-spacing: 0.08em; line-height: 1; text-transform: uppercase;` (mock 66-72).

### Motion (parts.css)

- `@keyframes p-blink { 0%, 100% { opacity: 1; } 50% { opacity: 0.15; } }`, used as
  `animation: p-blink 1.6s var(--ease-hard) infinite` (live chip, LiveDot core, busy square, pulsing marker).
- `@keyframes p-strobe { 0%, 50%, 100% { opacity: 1; } 25%, 75% { opacity: 0.15; } }`, used once:
  `animation: p-strobe 480ms var(--ease-hard) 1` (Count rise).
- `@keyframes p-rise { from { opacity: 0.001; translate: 0 8px; } to { opacity: 1; translate: 0 0; } }`, used as
  `animation: p-rise var(--dur-2) var(--ease-out) both; animation-delay: calc(min(var(--p-i, 0), 11) * var(--stagger));`
  (Tile entering; at most 12 staggered).
- A `@media (prefers-reduced-motion: reduce)` block at the end of parts.css sets `animation: none` on every part rule
  that animates and `translate: none` on the pressed rules. Colour transitions stay.

## Task 1: the route and an empty lab

- `web/src/lab/route.ts`: `export const LAB_HASH = '#/lab';` and `export function isLabHash(hash: string): boolean`
  (exact match). Doc comment: read the way `#/p/<slug>` is (`web/src/useInProgress.ts:12`); nothing links to it.
- `web/src/Root.tsx`: `export function Root()`. `useSyncExternalStore` over `hashchange` reading
  `isLabHash(window.location.hash)`. Lab: `<Suspense fallback={<div className="ip-empty">Loading…</div>}><Lab /></Suspense>`
  with `const Lab = lazy(() => import('./lab/Lab'))`; otherwise `<App />`. The App is not mounted while the lab shows,
  so its hash sync (`useInProgress.ts:150-161`) never rewrites `#/lab`; leaving the hash remounts the App.
- `web/src/main.tsx`: render `<Root />` in place of `<App />`; import `./styles/parts.css` after `./styles/base.css`.
  Keep its comments true (the sheet order comment names parts.css).
- `web/src/lab/Lab.tsx`: `export default function Lab()`. On mount it sets `document.title = 'Parts lab · InProgress'`
  and restores the previous title on unmount. It imports `../styles/lab.css` (so the lab's own layout sheet ships in the
  lazy chunk). The page reads nothing from the server.
- `web/src/styles/lab.css`, in `@layer components`: the lab's layout only (below, Task 7).

## Task 2: static parts

One file each in `web/src/parts/`. Props are TypeScript interfaces exported beside the part.

- **Eyebrow** `{ glyph?: '//' | '[+]' | '[!]' | '>>' | '[◈]' | '[✓]'; glyphTone?: 'volt' | 'dim'; as?: 'span' | 'h2' | 'h3' | 'label'; htmlFor?: string; children }`.
  Default `as` span, `glyphTone` volt. Markup `<As class="p-eyebrow"><span class="p-eyebrow-glyph" data-tone aria-hidden="true">{glyph}</span>{children}</As>`
  (glyph span only when given). CSS: inline-flex, align center, gap `--sp-2`, `font-stretch: 112.5%`,
  `font-weight: var(--w-brand)`, colour `--text-muted`, margin 0. Glyph volt or `--text-dim`.
- **Readout** `{ label: string; value: ReactNode; tone?: 'text' | 'volt' | 'alarm'; face?: 'mono' | 'dot'; title?: string }`.
  Root `<span class="p-readout" title>` with `<span class="p-readout-key">` and `<span class="p-readout-value" data-tone data-face>`.
  Mock 117-120. Dot face: `--font-dot`, `font-weight: var(--w-display)`, `font-size: var(--t-title)`, `line-height: 1`.
  Value tabular, slashed-zero. Alarm tone `--alarm`.
- **Count** `{ value: number; size?: 'h1' | 'h3'; tone?: 'muted' | 'text' | 'volt'; title?: string }`. Doto figure
  (mock 213): `--font-dot`, `var(--w-display)`, `font-size: var(--t-h1)` (size h1) or `var(--t-h3)` (size h3);
  `line-height: 0.8`; tabular nums; tone colours `--text-muted`,
  `--text`, `--volt`. Rise: `web/src/parts/count.ts` exports `countRose(previous: number | undefined, next: number): boolean`
  (true only when previous is a number and next > previous). The part keeps the previous value in a ref; in an effect
  on `value`, when `countRose` is true it bumps a `rise` state; it renders `<span key={rise} className={rise > 0 ? 'p-count-figure p-count-rise' : 'p-count-figure'}>{value}</span>`
  inside the root, so each rise restarts `p-strobe`. StrictMode's double effect must not fire a rise (the ref already
  equals the value on the second run).
- **Chip** `{ tone?: 'needs' | 'live' | 'ready' | 'blocked' | 'parked' | 'quiet' | 'label' | 'count'; dashed?: boolean; glyph?: string; onRemove?: () => void; removeLabel?: string; children }`.
  Default tone `quiet`. Root `<span class="p-chip" data-tone data-dashed?>`. `label` tone: glyph in
  `<span class="p-chip-glyph" aria-hidden="true">`, no box. Removable when `onRemove`: a trailing
  `<button type="button" class="p-chip-remove" aria-label={'Remove ' + (removeLabel ?? text of children)}>×</button>`.
  Look (mock 100-111): inline-flex, gap 6px, padding 5px 7px, 1px `--line-strong`, `--canvas-2`, `--font-mono` at
  `font-stretch: 75%`, `--text-muted`, nowrap. needs: volt fill, `--volt-ink`, `var(--w-strong)`. live: volt line and
  text, `::before` 6 px volt square blinking (`p-blink`). ready: `--line-bright` line, `--text`. blocked: alarm line and
  text. parked: dashed `--line-strong`, `--text-dim`. quiet: the base look; `dashed` makes its border dashed. label:
  transparent border and background, padding-inline 0, glyph `--text-dim` at `font-size: 1.2em`, `letter-spacing: 0`.
  count: `--text`, tabular. Remove button: `--text-muted`, hover `--volt`, focus-visible 2 px volt outline.
- **KeyHint** `{ keys: string[]; label: string }`. `<span class="p-keyhint">{keys.map(k => <kbd class="p-key">)}<span class="p-keyhint-label">{label}</span></span>`.
  kbd per mock 114 (padding 3px 5px, 1px `--line-bright`, `--text`, `font-stretch: 112.5%`, `var(--w-brand)`); label
  `--text-muted`; gap 6px.
- **Tape** `{ tone?: 'volt' | 'alarm' }`. `<div class="p-tape" data-tone aria-hidden="true">`, height 6px,
  `repeating-linear-gradient(-45deg, var(--volt) 0 10px, var(--canvas-0) 10px 20px)`; alarm swaps `--alarm`.
- **Ruler** `{ variant?: 'hud' | 'since'; label?: string }`. hud: mock 139-144, `aria-hidden`. since:
  `<div class="p-ruler" data-variant="since"><span class="p-ruler-label">{label}</span></div>`, grid
  `auto minmax(0, 1fr)`, gap `--sp-3`, label in the Eyebrow type (brand micro uppercase) at `--violet-ink`, `::after`
  7px tall `repeating-linear-gradient(90deg, var(--violet) 0 1px, transparent 1px 6px)`.
- **LiveDot** `{ still?: boolean; title?: string }`. `<span class="p-livedot" data-still? title aria-hidden={title ? undefined : 'true'}>`.
  Mock 168-169: 7 px, 1px volt border, `::after` inset 1px volt core blinking; `still` stops the blink.
- **Marker**: the same props as today's `web/src/Marker.tsx` (`status`, `question`, `paused`, `needsYou`, `pulse`,
  `title`). `<span class="p-marker" data-status data-question? data-paused? data-you? data-pulse? title>`, no text. 9 px
  squares, `flex: none`, inline-flex centred: todo hollow 1.5px `--line-bright`; active volt fill; blocked alarm fill;
  dropped `--text-dim` fill; parked dashed 1.5px `--text-dim`; done no box, `::before { content: '✓'; content: '✓' / ''; }`
  in `--text-muted` at `font-size: var(--t-detail-sm)`; question 13 px `--text-muted` square with
  `::before { content: '?'; content: '?' / ''; }` in `--canvas-1`, `var(--w-display)`, `font-size: var(--t-micro)`;
  paused hollow 1.5px `--text-muted` (a paused question: hollow `--text-muted` border, `?` in `--text-muted`); you volt
  fill (a question that is yours: volt square, `?` in `--volt-ink`). Active with `pulse` blinks (`p-blink`). Keep the
  same precedence as today's `web/src/styles/marker.css` (question's `?` beats done's `✓`; you and paused override the
  status fill).
- **Frame** `{ tone?: 'volt' | 'alarm' }`. `<span class="p-frame" data-tone aria-hidden="true">`: mock 242-248 with
  `inset: -6px`, `--p-frame-s: 12px`, `--p-frame-w: 2px`, colour from tone. The parent must be `position: relative`.
- **EmptyState** `{ children: ReactNode; action?: ReactNode }`. `<div class="p-empty"><p class="p-empty-text">{children}</p>{action}</div>`:
  grid, justify-items start, gap `--sp-3`, padding `--sp-8` `--sp-6`, 1px `--line-soft`, dot grid
  `radial-gradient(circle, var(--line) 1px, transparent 1px) 0 0 / 8px 8px`; text `--t-body`, `--text-muted`,
  `max-width: 68ch`, margin 0.
- **ErrorLine** `{ message: ReactNode; onRetry?: () => void }`. `<div class="p-error"><p class="p-error-text">{message}</p>{onRetry && <Button size="sm" onClick={onRetry}>Retry</Button>}</div>`:
  flex, align center, gap `--sp-3`, padding `--sp-2` `--sp-3`, `background: var(--alarm-wash)`,
  `border-left: 2px solid var(--alarm)`, text `--t-body` `--text`, margin 0, `flex: 1`.

## Task 3: Button and Toast

- **Button** (forwardRef to `HTMLButtonElement`) `{ variant?: 'primary' | 'outline' | 'ghost' | 'danger'; size?: 'sm' | 'md'; glyph?: '›' | '↗'; busy?: boolean } & ButtonHTMLAttributes`.
  Defaults outline, md, `type="button"`. Markup `<button class="p-btn" data-variant data-size aria-busy={busy || undefined} aria-disabled={busy || undefined}>{busy && <span class="p-btn-busy" aria-hidden="true" />}{children}{glyph && <span class="p-btn-glyph" aria-hidden="true">{glyph}</span>}</button>`;
  while busy the click handler is not called. Look mock 83-97: sizes `min-height` 26px (sm) and 32px (md), padding 0
  `--sp-3`, 1px `--line-bright`, transparent, `--text`, `font-stretch: 112.5%`, `var(--w-brand)`, nowrap. outline hover
  volt border and text. primary volt fill, `--volt-ink`, hover `--text-hi` fill. ghost transparent border,
  `--text-muted`, padding `--sp-2`, hover volt text and `--line-strong` border. danger alarm border and text, hover alarm
  fill with `--text-hi`. Focus-visible: `outline: none; border-color: var(--volt); box-shadow: 0 0 0 2px var(--volt-soft)`.
  Busy square: 6 px, `currentColor` fill, `p-blink`; busy keeps full opacity and has no hover change. Disabled `.45`.
- **Toast** `{ tone?: 'neutral' | 'alarm'; children; onDismiss?: () => void }`. `<div class="p-toast" data-tone>`
  with `<p class="p-toast-text">` and, for alarm with `onDismiss`, a ghost sm Button `aria-label="Dismiss"` showing ×.
  A neutral toast with `onDismiss` calls it after 4000 ms (cleared on unmount or when the message changes); an alarm
  one stays until dismissed. **ToastRegion** in the same file: `<div role="status" class="p-toasts">{children}</div>`,
  meant to stay mounted so a screen reader hears each new toast; `position: fixed; left: var(--sp-5); bottom: 56px; z-index: var(--z-toast)`;
  grid gap `--sp-2`; `max-width: min(480px, calc(100vw - 2 * var(--sp-5)))`. Toast look: `--canvas-2`, 1px
  `--line-strong`, `border-left: 2px solid var(--line-bright)` (alarm: `--alarm`, `--alarm-wash` over `--canvas-2`),
  padding `--sp-2` `--sp-3`, text `--t-body`.

## Task 4: TabStrip

- `web/src/parts/tabStrip.ts`, pure:
  - `tabStep(key: string, at: number, count: number): number | null`: ArrowRight next and ArrowLeft previous, both
    wrapping; Home 0; End `count - 1`; null for other keys or `count <= 0`; `at < 0` treated as ArrowRight to 0 and
    ArrowLeft to `count - 1`.
  - `scrollToShow(itemLeft: number, itemWidth: number, scrollLeft: number, viewWidth: number): number`: the
    `scrollLeft` that brings the item fully into view with the least move (unchanged when already in view; the item's
    left edge wins when it is wider than the view).
- `web/src/parts/TabStrip.tsx` `{ variant?: 'tabs' | 'segmented'; label: string; items: { id: string; label: string; count?: number; controls?: string }[]; value: string; onChange: (id: string) => void }`.
  - Root `<div class="p-tabstrip" data-variant>`; tabs: `role="tablist" aria-label={label}`; each
    `<button type="button" class="p-tab" role="tab" id aria-selected aria-controls={controls} tabIndex={selected ? 0 : -1}>`.
    onKeyDown on the root: `tabStep(key, index of the focused tab, n)`; when not null `preventDefault`, call
    `onChange(items[next].id)` and focus that button. Ignore keys with Alt, Ctrl, Meta.
  - segmented: `role="group" aria-label={label}`; each `<button type="button" class="p-tab" aria-pressed>`, every
    button in the Tab order, no arrow handling.
  - Count: `<span class="p-tab-count">{count}</span>` after the label.
  - Keep the active one in view: a `useLayoutEffect` on `value` sets the strip's `scrollLeft` from `scrollToShow`
    using the active button's `offsetLeft` and `offsetWidth` (the strip is the buttons' offsetParent: give it
    `position: relative`). Never `scrollIntoView` (it scrolls the page).
  - Look mock 275-281: flex, `max-width: 100%`, `overflow-x: auto`, `scrollbar-width: none`, 1px `--line-strong`,
    `--canvas-2`; tab padding 8px 10px, right hairline, `font-stretch: 112.5%`, `var(--w-brand)`, `--text-muted`, hover
    volt, focus-visible `outline: none; box-shadow: inset 0 0 0 2px var(--volt-soft)`; selected or pressed volt fill
    with `--volt-ink`; count mono at `font-stretch: 75%`, `var(--w-body)`, `opacity: .8`, tabular.

## Task 5: Field, Menu, Confirm

- **Field** (forwardRef to `HTMLInputElement | HTMLTextAreaElement`)
  `{ size?: 'sm' | 'md'; label?: string; 'aria-label'?: string; hint?: ReactNode; invalid?: string; busy?: boolean; multiline?: boolean; rows?: number } & the input's attributes`.
  Ids from `useId`. Markup:
  `<div class="p-field" data-size data-invalid? data-busy?>{label && <Eyebrow as="label" htmlFor={id}>{label}</Eyebrow>}<div class="p-field-box"><input|textarea id class="p-field-input" aria-invalid={!!invalid || undefined} aria-describedby={hint/reason ids} readOnly={busy || readOnly} rows={multiline ? rows ?? 2 : undefined} />{hint && <span id class="p-field-hint">{hint}</span>}</div>{invalid && <span id class="p-field-reason">{invalid}</span>}</div>`.
  Box: flex, align center, gap `--sp-2`, `--canvas-3`, 1px `--line-strong`, padding 0 `--sp-2`, `min-height` 26px (sm)
  or 32px (md); `:focus-within` volt border plus `0 0 0 2px var(--volt-soft)`; invalid alarm border (focus ring
  `--alarm-soft`); busy `opacity: .6`. Input: flex 1, `min-width: 0`, no border, transparent, `--text-hi`,
  `font-family: var(--font-body)`, `font-size: var(--t-body)`, `outline: none` (the box shows focus). Textarea:
  `field-sizing: content`, `resize: none`, padding-block 6px, `max-height: 240px`, `overflow-y: auto`. Hint `--text-dim`
  in `--font-mono` `--t-detail-sm`. Reason: `--alarm`, `--t-detail-sm` in `--font-body` (a sentence, never micro).
  Root: grid, gap `--sp-2`.
- **Menu** `{ label?: string; head?: ReactNode; autoFocus?: boolean; onClose?: () => void; children }`,
  `MenuItem` (forwardRef) `{ glyph?: string; keyHint?: string; danger?: boolean; current?: boolean; disabled?: boolean; onSelect: () => void; children }`,
  `MenuSeparator`. All three in `web/src/parts/Menu.tsx`.
  - Markup `<div class="p-menu">{head && <div class="p-menu-head" id={headId}>{head}</div>}<div role="menu" aria-label={label} aria-labelledby={head ? headId : undefined} onKeyDown>{children}</div></div>`.
  - Item `<button type="button" role="menuitem" class="p-menu-item" tabIndex={-1} data-danger? aria-current={current ? 'true' : undefined} disabled onClick={onSelect}>`
    with `<span class="p-menu-cur" aria-hidden="true">{current ? '›' : ''}</span>`, glyph span (`aria-hidden`), label
    span, and `keyHint` as `<kbd class="p-key">` pushed right. Separator `<div role="separator" class="p-menu-sep" />`.
  - Keys: onKeyDown on the role=menu element: items are its `[role="menuitem"]:not(:disabled)`; `menuStep` from
    `web/src/chrome/menu.ts` on the focused one's index; not null: `preventDefault` and focus. Escape: `preventDefault`,
    `stopPropagation`, `onClose?.()`. `autoFocus`: focus the first enabled item on mount.
  - Look: `--canvas-2`, 1px `--line-strong`, padding `--sp-1` 0, `min-width: 220px`, `max-width: 100%`. Head padding
    `--sp-2` `--sp-3`, bottom hairline `--line`. Item: flex, gap `--sp-2`, width 100%, text-align left, padding
    `--sp-2` `--sp-3`, `--t-body`, `--text`; `:hover, :focus` `--canvas-3` and `--text-hi`, `outline: none`;
    `:focus-visible` adds `box-shadow: inset 2px 0 0 var(--volt)`; danger `--alarm` (hover keeps alarm text);
    disabled `.45`; current marker volt, fixed 1ch column. Separator 1px `--line` with margin `--sp-1` 0. Glyph
    `--text-dim`. The menu does not position itself: a popover is the caller's (`z-index: var(--z-popover)`).
- **Confirm** `{ question: string; detail?: ReactNode; action: string; danger?: boolean; focusOnMount?: boolean; onConfirm: () => void; onCancel: () => void }`.
  `<div class="p-confirm" role="group" aria-labelledby={qId} aria-describedby={detail ? dId : undefined} onKeyDown>`
  with `<p id={qId} class="p-confirm-q">`, optional `<p id={dId} class="p-confirm-detail">`, then
  `<div class="p-confirm-acts">` holding the action Button (`danger` when `danger`, else `outline`, size sm) and a
  Cancel Button (outline, sm) with a ref. `focusOnMount` (default true) focuses Cancel on mount. Escape calls
  `onCancel` (`preventDefault`, `stopPropagation`). Look: grid gap `--sp-2`, padding `--sp-3`, `--canvas-1`, 1px
  `--line-strong`; question `--t-body` `var(--w-strong)` `--text-hi`; detail `--t-body` `--text-muted`; acts flex gap `--sp-2`.

## Task 6: Tile and ListCursor

- **Tile** (forwardRef to `HTMLElement`, root `<article>`)
  `{ hue?: number | null; tone?: 'default' | 'ask' | 'done' | 'parked'; id?: ReactNode; chips?: ReactNode; title: string; onOpen?: () => void; body?: ReactNode; foot?: ReactNode; actions?: ReactNode; selected?: boolean; dragging?: boolean; dropBefore?: boolean; pending?: boolean; rise?: number } & HTMLAttributes<HTMLElement>`.
  - `<article class="p-tile" data-tone data-hue={hue ?? undefined} data-selected? data-dragging? data-drop? data-pending? data-entering={rise !== undefined || undefined} style={{ '--p-hue': hue == null ? undefined : 'var(--hue-' + hue + ')', '--p-i': rise }}>`
    (merge a caller `style`). Children: `<Frame />`; `<div class="p-tile-top"><span class="p-tile-id">{id}</span><span class="p-tile-chips">{chips}</span></div>`
    (when either given); `<h3 class="p-tile-title"><button type="button" onClick={onOpen}>{title}</button></h3>` (a
    button, not an anchor: an `href="#"` would change the window's hash); body in `<div class="p-tile-body">`; foot in
    `<div class="p-tile-foot">` with `actions` in `<span class="p-tile-actions">` at its end (foot rendered when foot
    or actions given).
  - Look mock 220-241 and 292-297: grid gap `--sp-3`, padding `--sp-4`, `--canvas-2`, 1px `--line`,
    `border-top: 2px solid var(--p-hue, var(--line-strong))`, `position: relative`. Hover `--canvas-3`,
    `--line-bright` border, top rule `var(--p-hue, var(--volt))`. Title `--font-body`, `var(--w-strong)`,
    `--t-title`, line-height 1.35, `--text-hi`, margin 0; its button inherits, text-align left; hover a dotted volt
    underline (offset 3px); focus-visible `outline: none; box-shadow: 0 0 0 2px var(--volt-soft)`. Id `--font-mono`
    `--t-detail-sm` `--text-muted`. Chips at the right (`margin-left: auto`, gap `--sp-2`). Foot: flex wrap, gap
    `--sp-2` `--sp-3`, padding-top `--sp-3`, top hairline `--line-soft`; actions `margin-left: auto`.
  - Tones: ask `background: linear-gradient(var(--volt-wash), var(--volt-wash)), var(--canvas-2)`,
    `border-color: var(--volt-soft)` (top rule stays the hue), Frame shown. done: transparent, `--line-soft` border,
    `border-top: 1px solid var(--line)`, gap `--sp-2`, padding-block `--sp-3`, title `--t-body`; hover `--canvas-2`; no
    hue (ignore `--p-hue`). parked: dashed `--line-strong` border all round (top 2px dashed too), no hue, title
    `--text`.
  - States: the Frame (`.p-tile > .p-frame`) is `display: none` except on ask and on
    `.p-tile:is(:focus-visible, :has(:focus-visible))`; the tile itself shows no outline (`outline: none` on
    `.p-tile:focus-visible`), its Frame does. selected: `border-color: var(--volt)` on all sides but the top, which keeps
    the hue (else volt). dragging `opacity: .5`. dropBefore: `::before` 2 px volt bar at `top: calc(-1 * var(--sp-2) - 1px)`,
    left/right `-1px`. pending `opacity: .5` and `.p-tile[data-pending] .p-tile-actions { visibility: hidden; }`.
    entering: `p-rise` with the stagger above.
- `web/src/parts/listCursor.ts`, pure:
  - `export interface Cursor { col: number; row: number }`.
  - `clampCursor(at: Cursor | null, counts: readonly number[]): Cursor | null`: null when every column is empty; null
    `at` gives the first item of the first non-empty column; an empty `at.col` (or one past the end) moves to the
    nearest non-empty column (right first, then left); the row is clamped to the column's last item.
  - `cursorStep(key: string, at: Cursor, middles: readonly (readonly number[])[]): Cursor | null`. `middles[c][r]` is
    item r's vertical middle in column c (a list passes one column). ArrowDown and ArrowUp move one row, staying put at
    the ends (return `at`); Home and End go to the column's first and last row; with one column ArrowLeft and
    ArrowRight return null; with more, they go to the nearest non-empty column in that direction (staying put when
    there is none), at the row whose middle is nearest `middles[at.col][at.row]` (the upper row on a tie). Any other key:
    null.
- `web/src/parts/ListCursor.tsx`: `useListCursor(counts: readonly number[], onOpen: (at: Cursor) => void)` returns
  `itemProps(col: number, row: number)` = `{ ref, tabIndex, onFocus, onKeyDown, 'data-cursor': '' }`.
  - Holds the last focused cursor in state; `clampCursor` of it decides which item has `tabIndex` 0 (all others -1).
  - `ref` keeps each element in a `Map` keyed `col:row`.
  - `onFocus` (only when `event.target === event.currentTarget`) records the cursor.
  - `onKeyDown` acts only when `event.target === event.currentTarget` (keys inside an item's own fields and buttons
    are theirs, so typing never moves it) and no Alt, Ctrl, Meta or Shift is held (Alt with an arrow is the Board's
    reorder). Enter: `preventDefault`, `onOpen`. Otherwise `cursorStep` with middles measured now from
    `getBoundingClientRect()` (top plus half the height); not null: `preventDefault`, focus that item. No letter keys,
    no Escape handling.
  - No CSS of its own: the item's focus look is the item's (a Tile shows its Frame).

## Task 7: the lab page

`web/src/lab/fixtures.ts` holds all the data: the colour token names grouped (canvas, text, volt, alarm, violet, lines,
scrim), the ramp rows (token, size, use, sample text), seven hue tiles, chip and button sets, readouts, tab items (eight
phase tabs with counts, long enough to overflow at 400), menu items, list-cursor columns (three columns of 4, 2 and 5
short tiles of varied title length), toast and error messages. Plain sentences in sentence case. No server reads.

`web/src/lab/Lab.tsx` (split into more files under `web/src/lab/` if it passes ~300 lines):

- Page head: `<Eyebrow glyph="[◈]">Dev only</Eyebrow>`, `<h1 class="lab-title">Parts lab</h1>`, and one sentence in
  `--t-detail-sm` mono: "Every v3 part in every state, from fixtures. Reached only by typing #/lab."
- A `Replay` Button (outline, sm, glyph none) in the head that replays the Motion section (remounts the rising tiles
  with a new key and raises the demo Count by one).
- Sections in this order, each `<section class="lab-part" aria-labelledby>` headed by
  `<Eyebrow as="h2" glyph="//" id>{name}</Eyebrow>`: Tokens, Type ramp, Hues, Motion, then the parts in the spec
  table's order: Eyebrow, Readout, Count, Chip, Button, TabStrip, Field, Menu, Confirm, Tile, Frame, LiveDot, Marker,
  KeyHint, Tape, Ruler, EmptyState, ErrorLine, Toast, ListCursor. Inside each, specimens in `.lab-row` cells, each with
  a caption (`.lab-cap`, mono `--t-detail-sm` `--text-muted`, sentence case) naming the variant or state.
- What each shows (static states as props; hover, focus and press left to the pointer and keyboard):
  - Tokens: a swatch per colour token (`style={{ background: 'var(--name)' }}`, 1px `--line` edge) captioned with its
    name. Type ramp: a row per ramp token, the sample set in that token with its face, weight and case per spec 2.5.
    Hues: seven Tiles, hue 0 to 6, plus one with none.
  - Motion: four Tiles with `rise` 0..3, a live Chip and a LiveDot (the blink), a Count h1 that Replay raises.
  - Eyebrow: every glyph, both glyph tones. Readout: each tone, the dot face, a long value. Count: both sizes, each tone.
  - Chip: every tone, quiet dashed, a removable one (its × removes it from the row; a "Reset" ghost Button restores).
  - Button: every variant at both sizes, with glyph, busy, disabled.
  - TabStrip: a tabs strip (label "Lab tabs", the eight phase tabs, state held in the Lab) above a panel line
    "Showing <tab>"; a segmented one (label "Sort", three items); a narrow box (`max-width: 260px`) holding the tabs
    strip again so the overflow and keep-in-view show at every width.
  - Field: sm and md, with an Eyebrow label, with only an aria-label, with a hint, invalid with a reason, busy,
    disabled, a growing textarea.
  - Menu: a static menu (head, glyphs, key hints, a current item, a separator, a danger item, a disabled item), and a
    "Open menu" Button that opens one below it (`autoFocus`, Escape or choosing an item closes it and returns focus to
    the button; position absolute in a `position: relative` wrapper, `z-index: var(--z-popover)`).
  - Confirm: a danger and a plain one with `focusOnMount={false}`, and a "Delete step" danger Button that swaps itself
    for a live Confirm (focus goes to Cancel; Cancel or confirm swaps back and returns focus to the button).
  - Tile: default with hue, ask (with an answer Field and a primary "Send" Button in its body), done, parked,
    selected, dragging, drop line, pending (with actions), id and chips and foot filled.
  - Frame: volt and alarm around a plain box. LiveDot: blinking and still. Marker: every status, question, paused,
    you, question with paused and with you, active with pulse; each beside its caption as a step line.
  - KeyHint: `Ctrl` `K` "Go to", `Esc` "Close", `↑` `↓` "Move". Tape: volt and alarm. Ruler: hud and since
    ("Since 09:14"). EmptyState: with and without an action. ErrorLine: with and without Retry.
  - Toast: neutral and alarm as static specimens (no `onDismiss`), and a "Show toast" Button that shows a real neutral
    toast in a mounted `ToastRegion` (it leaves after 4 s).
  - ListCursor: a three-column grid of plain Tiles (ids and titles from fixtures) wired with `useListCursor`
    (`itemProps` spread on each Tile), and a Readout `OPENED` whose value is the last item Enter opened ("none" until
    then).
- `web/src/styles/lab.css` (`@layer components`): `.lab` max-width 1680px, margin auto, padding `--sp-6` `--sp-8`
  (`--sp-4` under 720px), grid gap `--sp-section`; `.lab-title` display face, `font-stretch: 125%`,
  `var(--w-display)`, `--t-h1`, line-height 0.85, uppercase, `--text-hi`, margin 0; `.lab-part` grid gap `--sp-4`,
  padding-top `--sp-4`, top hairline `--line`; `.lab-row` flex wrap, gap `--sp-4`, align start; `.lab-cell` grid gap
  `--sp-2`, `min-width: 0`, `max-width: 100%`; `.lab-cap`; `.lab-tiles` grid
  `repeat(auto-fill, minmax(min(100%, 280px), 1fr))` gap `--sp-3`; `.lab-swatch` 96px by 48px; `.lab-grid` (the
  cursor grid) `repeat(3, minmax(0, 1fr))` gap `--sp-6`, one column under 720px. Nothing may make the page wider than
  the viewport at 400px.

## Task 8: tests

- `test/web/tabStrip.test.ts`: `tabStep` (right and left wrap, Home, End, `at` -1, count 0, other keys null) and
  `scrollToShow` (in view unchanged, off left, off right, wider than the view).
- `test/web/listCursor.test.ts`: `cursorStep` on a list (down, up, stays at the ends, Home, End, left and right null)
  and on a grid (right to the nearest middle, tie goes up, skips an empty column, stays at the last column, left
  likewise) and `clampCursor` (null, empty grid, row past the end, empty column moves right then left).
- `test/web/count.test.ts`: `countRose` (undefined previous false, rise true, same false, fall false).
- `test/e2e/ui.spec.ts`, one test at the end: `test('the parts lab opens on #/lab and walks a TabStrip with the arrow keys', ...)`:
  `page.goto('/#/lab')`; for each of the 24 section names expect `page.getByRole('heading', { level: 2, name: new RegExp('^' + name + '$', 'i') })`
  visible; on the "Lab tabs" tablist click the first tab, press ArrowRight (second tab `aria-selected="true"` and
  focused), End (last), Home (first), ArrowLeft (last, wrapped). Then `page.goto('/')` and expect
  `page.locator('[class^="p-"], [class*=" p-"]')` to have count 0 once the window has loaded (wait for `.ip-app`).
- Run: `npm run typecheck`, `npm test`, and the e2e narrowed: build with `node scripts/build-to.mjs .build`, then
  `INPROGRESS_E2E_PORT=4410 npx playwright test -g "parts lab"`.

## Not in this step

- No surface adopts a part; no `ip-*` rule changes; `web/src/Marker.tsx` and `chrome/menu.ts` stay as they are.
- No change to base.css's reduced-motion rule (a surface step's job).
