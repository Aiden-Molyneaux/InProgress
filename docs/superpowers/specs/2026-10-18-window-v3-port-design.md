# Porting the window to InThink v3

Step #496, for phase #495 Port the window to InThink v3. Written on 2026-10-18 from the porting strategy (r323) and the
Board mock Aiden approved (r321, screenshot r322). Supersedes Board spec section 2.8 (Look) and the Quiet restyle's
sections 1 to 3 (tokens and fonts, chrome, cards); section 13 says exactly what each loses.

Aiden approves this spec section by section. Each section's head says whether it is approved.

References:

- **v3 itself:** InThink's design system spec, `C:/personal/InThink/docs/superpowers/specs/2026-09-15-marathon-v3-design-system-design.md`,
  sections 2 (principles), 3 (foundations), 4 (primitives), 5 (components), 6 (app shell) and 8 (motion). This spec
  names v3 values by its token names.
- **The Board, the HUD bar, the rail and the footer:** the mock (r321) and its screenshot (r322).
- **List and detail patterns:** InThink's Projects v3 spec, `2026-10-09-projects-v3-design.md` in the same folder.
- **Today's window:** the inventory in r326 (`~/.inprogress/resources/inprogress/2026-10-18-v3-port-window-inventory.md`):
  the sheet's section map, every e2e assertion tied to the look, the hue path, the inline styles.

## 0. Intent, goals, non-goals, anti-goals

*Status: approved by Aiden, 2026-10-18.*

### Intent

The window wears Quiet: a light and a dark slate palette, Inter and DM Mono, 8 px corners, a tab row. Aiden saw the
Board drawn in InThink v3's language (Marathon's: a HUD bar, a module rail, volt for the thing you act on, square
corners, display type in the chrome) and asked for the whole window to be ported as a phase. v3 suits what the window
does. It watches sessions work and flags what needs Aiden, and v3 was built for screens of status readouts, live counters
and one loud colour.

This spec is what the ten build steps (#497 to #506) build to. It is a redesign, not a reskin (Aiden, 2026-10-18: "I
want high-fidelity, improved UI and UX as a result of this Design Language move. The new UI does not have to map
directly from the old UI"). Each surface is designed afresh in v3 for what Aiden does there, and may change its layout,
its controls and how it is reached when that serves him better. What stays fixed is underneath: the data, the server,
the writes and their rules (the Board spec's and the parked-steps spec's meanings of Needs me, Next, Now, Done, Backlog,
parked and the rest).

Where this spec and the mock differ, this spec wins. The mock's project state is a snapshot from 18 October.

### Goals

- **Every surface in v3 at high fidelity:** the shell (HUD bar, module rail, footer strip), the Board, the Project view,
  the Backlog view, All done, Details, the resource viewer and GoTo. Dark canvas, zero radius, Archivo, Martian Mono and
  Doto, volt for "your move", and the states (hover, focus, pressed, empty, loading, error, live) drawn as carefully as
  the resting one.
- **Better to use than today.** Every surface section opens with what it improves over today's window and why: what
  Aiden sees first, how many clicks a common job takes, what was hard to find or easy to misread.
- **Content reads at least as easily as it does today.** Task titles, asks, outcomes, state notes and Details text are Archivo at
  body sizes with v3's reading leading. The ornament lives in the chrome.
- **Fonts ship with the window**, so it works offline and the CSP stays as it is.
- **One look at a time.** From the Foundations step on, main never shows a Quiet view inside a v3 shell.
- **Each step lands on its own**, on main after a green deploy, with its tests moved in the same branch.
- **Reduced motion keeps every surface usable**, and every surface works at 400 px.

### Non-goals

- **No change to the data model or to what a write means.** No migration. Window behaviour can change (layout, controls,
  where a thing is reached, what is shown first); the rules behind it cannot. A section that wants a new read from the
  server (a count, a status for the HUD) names it, and it is small, read-only and Aiden's call at that section's review.
- **No design switch.** No `?ds=v3`, no second sheet kept in step.
- **No library for what CSS already does.** The parts are CSS and the window's own React. A section may propose a library
  where CSS falls short (list reordering with FLIP, say), with its size and what it buys; the default is none. The three
  `@fontsource` font packages are the only packages this spec adds by itself.
- **Not all of InThink's kit by default.** The parts list in §4 is the whole list. A v3 part InProgress has no use for
  (Marquee, CorruptText, StatBar, the scanline texture) stays out.

### Anti-goals

- A straight reskin: today's layout in v3 colours where a better layout exists.
- Change for its own sake: a moved control that makes a common job slower or harder to find.
- Display or uppercase mono type on content: task titles, asks, outcomes, notes, Details text, Markdown.
- A Quiet surface inside the v3 shell on main, or a light view in a dark window.
- Volt on anything but Aiden's move, live work and where he is. Volt spread thin stops meaning "act here".
- A readout with no data behind it, or a figure invented to fill the bar.
- A second copy of a part for one surface: one Chip, one Button, one Tile.
- A rounded corner anywhere.

## 1. Decisions

*Status: approved by Aiden, 2026-10-18.*

### Settled before this spec

The strategy's eight calls (r323), approved with the mock on 2026-10-18. They stand unless a later section finds a
reason to reopen one, and then it goes to Aiden.

1. **No design switch.** InProgress is local, single-user and has one small sheet. Each step lands on main and the look
   changes in visible slices.
2. **Foundations flip the whole window at once.** v3 values go in behind Quiet's token names first, so every surface
   turns dark, square and v3-typed in one step. The grammar (HUD, rail, tiles, chips, column heads) then arrives surface
   by surface.
3. **The sheet is split before it is restyled.** `styles.css` becomes layered per-surface files with no visual change,
   so diffs stay per surface and two sessions can port two surfaces without touching the same file.
4. **The fonts are bundled.** Archivo, Martian Mono and Doto, latin subset, in a budget of about 250 KB.
5. **Shared parts come before surfaces**, with a dev-only `#/lab` specimen view as Parvati's reference.
6. **Content stays readable** (Aiden's ask): Archivo body text; uppercase mono only for ids, chips, counts and labels.
7. **The mock settles the Board, the HUD bar, the rail and the footer.** This spec designs the rest. Read with Aiden's
   redesign ask, the mock is the floor for those four, not a ceiling: a section may improve on it and says where.
8. **Tests move with the look**, in the step that changes the value.

### Aiden's decisions in this spec

Each is raised as an ask on #496 when its section is written, with the strategy's recommendation.

| # | Decision | Recommendation | Section | Answer |
|---|---|---|---|---|
| D1 | Light theme | Drop Quiet's light palette; the window ignores the OS theme | §2 | Dark only, as recommended (Aiden, 2026-10-18) |
| D2 | Counts in the rail | Keep the volt ask count on each project row, against InThink's rail rule | §6 | open |
| D3 | Step hues | The seven hues become faction colours on each tile's top rule | §2 | The seven factions, as mocked (Aiden, 2026-10-18) |
| D4 | Ctrl K | GoTo becomes a v3 command bar; the Board keeps no shortcuts of its own | §10 | open |
| D5 | What supersedes what | The port reverses Board spec 2.8 and Quiet's palette, fonts, chrome and cards; #506 writes the ruling | §13 | open |

### Calls made by Sigmund, not Aiden

Each is argued in its section. Aiden can overturn any of them at that section's review.

- **Fonts go in through `@fontsource`**, as Inter and DM Mono do today (`web/src/main.tsx:4-6`), not as hand-copied
  woff2 files. Vite already emits those files next to the app (§2).
- **The command bar grows out of GoTo.** Ctrl K and `/` already open GoTo (`web/src/useKeyboard.ts:24-32`). The bar
  keeps its step search and adds commands the window already has a button for: switch project, open a view, add a step
  (§10).
- **The tab keys move to the rail.** `[`, `]` and `1` to `9` walk the rail's project rows as they walk tabs today (§6).
- **Project actions move to the rail.** Rename, Archive, Delete and drag-to-reorder live on a rail row, with today's keys
  (right-click, Shift F10, the context-menu key, Alt with an arrow); archived and recently deleted projects sit at the
  rail's foot (§6).
- **Sessions with no claimed step** sit in the comms slab, under the state note (§7). The mock leaves them out.
- **HUD readouts come from data the window already reads** unless §5 makes the case for a small new read.
- **`#/lab` uses the existing hash path** (`#/p/<slug>` in `web/src/useInProgress.ts:12`) and exists only in dev builds
  (§4).

## 2. Foundations

*Status: approved by Aiden, 2026-10-18.* Built by #498, after the sheet split (#497).

### What it improves

- **Real type.** Today Inter ships at two weights (500 and 900) and sentence text runs at 12.5 px with 11 px meta. v3
  gives three faces with clear jobs, and content moves up to 15 px body and 16 px titles, as the mock shows.
- **One meaning per colour.** Quiet spends orange on Working, amber on Needs you and red on blocked, and the hues avoid
  all three. v3 has three: volt for Aiden's move and live work, alarm for blocked and errors, violet for "new since you
  looked". Everything else is grey.
- **Numbers that line up.** Ids, ages, counts and times use tabular figures with a slashed zero.
- **Focus you can see.** Today's 2 px ink ring sits close to the text colour. v3's volt ring stands out on every canvas.

### 2.1 Theme (D1)

Dark only (Aiden, 2026-10-18). `color-scheme: dark` on `:root`, one palette, no `prefers-color-scheme` block anywhere in
`web/src`. The OS theme changes nothing, so scrollbars, form controls and the caret are dark in a light OS too.

### 2.2 Fonts

Installed as `@fontsource` packages and imported in `web/src/main.tsx`, as Inter and DM Mono are today
(`main.tsx:4-6`). Vite emits the files into `web/dist/assets`, `default-src 'self'` covers them, and the CSP
(`src/server/routes/ui.ts:18`) is unchanged.

| Face | Package entry | Axes kept | Role tokens |
|---|---|---|---|
| Archivo | the variable package, latin subset, width and weight | wdth 100 to 125, wght 400 to 800 | `--font-display`, `--font-body` |
| Martian Mono | the variable package, latin subset, width and weight | wdth 75 to 112.5, wght 400 to 700 | `--font-brand`, `--font-mono` |
| Doto | latin subset | wght 800 | `--font-dot` |

- **Budget: 250 KB** of woff2 across the three. The step reports the emitted total in its receipt. If it is over, the
  step names the cut (an axis range, a weight) and Aiden picks.
- **Inter and DM Mono go** in the same step, with their packages.
- **Stacks** keep a symbol face, so label glyphs (⚙ ⚒ ⛁ ¶ ⧉ ⌕ ⇄ ⚑) and marks (◇ ◆ ✓ ▸) draw from the system as text,
  not emoji, as today:
  - `--font-display: 'Archivo', 'Arial Black', sans-serif`
  - `--font-body: 'Archivo', system-ui, 'Segoe UI', 'Segoe UI Symbol', sans-serif`
  - `--font-brand` and `--font-mono: 'Martian Mono', ui-monospace, 'Cascadia Mono', Consolas, 'Segoe UI Symbol', monospace`
  - `--font-dot: 'Doto', 'Martian Mono', monospace`
  - `font-variant-emoji: text` stays on `body`.
- **Each role's settings** (v3 3.1): display at `font-stretch: 125%`, weight 800; brand at 112.5 %, weight 700,
  uppercase, tracking 0.08em; mono at 87.5 % (75 % for chips and ages), weight 400 or 500; body at 100 %, weight 400,
  600 for titles; dot at 800.
- **Numerals:** `font-variant-numeric: slashed-zero tabular-nums` on every mono and dot use, set once in the base layer.

### 2.3 Colour

The mock's values. They lift InThink's canvas one step (`#111` against `#0a0a0a`), which reads better in a desktop
window than on a phone, and Aiden approved them as drawn.

| Token | Value | Job |
|---|---|---|
| `--canvas-0` | `#000000` | HUD bar, footer strip, comms slab, terminal readouts |
| `--canvas-1` | `#111111` | page background, the rail, overlays' body |
| `--canvas-2` | `#161616` | tiles, panels, menus |
| `--canvas-3` | `#1e1e1e` | hover step, inputs |
| `--canvas-4` | `#282828` | pressed step, tracks |
| `--text` | `#f2f2f2` | reading text |
| `--text-hi` | `#ffffff` | titles, headings |
| `--text-muted` | `#8f8f8f` | meta, labels (at least 4.5:1 on `--canvas-1`) |
| `--text-dim` | `#6f6f6f` | decorative meta only, never a sentence |
| `--volt` | `#c0fe04` | Aiden's move, live work, where he is, focus |
| `--volt-ink` | `#000000` | text on volt |
| `--volt-soft` | `rgba(192, 254, 4, 0.22)` | focus ring, a live outline |
| `--volt-wash` | `rgba(192, 254, 4, 0.06)` | the ask tile's tint |
| `--alarm` | `#f24723` | blocked, errors, destructive actions |
| `--alarm-soft` | `rgba(242, 71, 35, 0.22)` | alarm focus ring |
| `--alarm-wash` | `rgba(242, 71, 35, 0.08)` | an error line's tint |
| `--violet` | `#5200ff` | "new since you looked", lab annotations |
| `--violet-ink` | `#9f7bff` | violet text on dark (the mock's since-ruler label) |
| `--line-soft` | `rgba(255, 255, 255, 0.06)` | dividers inside a tile |
| `--line` | `rgba(255, 255, 255, 0.09)` | tile and panel edges |
| `--line-strong` | `rgba(255, 255, 255, 0.13)` | chips, the app frame, overlays' edge |
| `--line-bright` | `rgba(255, 255, 255, 0.2)` | buttons, key caps, hover edges |
| `--scrim` | `rgba(0, 0, 0, 0.65)` | behind the command bar and the viewer |

Rules:

- **Volt fill** means "your move" (a needs chip, a primary button, the current rail row). **Volt line or blink** means
  live (a working chip, a live dot). Volt never fills anything else.
- **Alarm** is blocked and errors only. Destructive buttons are alarm outlines that fill on hover (the mock's "to tidy").
- Panels are opaque. No translucency, no shadows: edges are lines.
- `::selection` is volt with volt-ink. Scrollbars are `scrollbar-color: var(--canvas-4) transparent`, thin.
- No literal colour outside the tokens file. Today's one (`.ip-banner` `#000`) becomes `--volt-ink` or `--canvas-0`.

### 2.4 Step hues (D3)

The seven factions, as mocked (Aiden, 2026-10-18). The stored hue index (0 to 6, `HUES` in `src/core/taskState.ts:15`)
does not change; only the colours behind `--hue-0` to `--hue-6` do. They are ordered so the two that sit near a state
colour come last, since the reconcile hands out the least-held hue and lower indexes are used most:

| Token | Faction | Value |
|---|---|---|
| `--hue-0` | Leela | `#3ad6ff` |
| `--hue-1` | Nucal | `#ff4d9d` |
| `--hue-2` | Mida | `#b66dff` |
| `--hue-3` | CyberAcme | `#59b41d` |
| `--hue-4` | Sekiguchi | `#9ebf9c` |
| `--hue-5` | Traxus (near alarm) | `#ff6b00` |
| `--hue-6` | Mida-alt (near volt) | `#f6e935` |

A hue is only ever a 2 px top rule on a tile and the session diamond beside its session line. It is never a fill, a chip
or text, so it cannot be read as a state.

### 2.5 Type ramp

Content sizes stay the same at every width; the display sizes step down under 720 px.

| Token | Size (under 720 px) | Leading | Tracking | Face | Used for |
|---|---|---|---|---|---|
| `--t-h1` | 2rem (1.625rem) | 0.85 | -0.02em | display, uppercase | page title |
| `--t-h2` | 1.5rem (1.25rem) | 0.85 | -0.01em | display, uppercase | view title (Backlog, All done) |
| `--t-h3` | 1.125rem (1.0625rem) | 0.9 | 0 | display, uppercase | column and section heads |
| `--t-title` | 1rem | 1.35 | 0 | body 600 | task titles, Details title |
| `--t-body` | 0.9375rem | 1.45 | 0 | body 400 | asks, notes, outcomes, Markdown |
| `--t-detail-sm` | 0.75rem | 1.2 | 0.04em | mono | ids, times, meta lines, commands |
| `--t-micro` | 0.625rem | 1 | 0.08em | brand or mono, uppercase | eyebrows, chips, key caps, readout keys |

- **No sentence is set in `--t-micro`** or in uppercase. The smallest sentence text is `--t-detail-sm`.
- **Reading measure** is 68ch for Markdown, state notes and Details text.
- **Weights** are tokens: `--w-body` 400, `--w-strong` 600, `--w-brand` 700, `--w-display` 800.

### 2.6 Space, radius, lines

- **Space:** `--sp-1` to `--sp-8` (4, 8, 12, 16, 20, 24, 32 px; no `--sp-7`), and `--sp-section`: 32 px, 24 px under
  720 px. Foundations defines them; each surface step moves its own literal paddings onto them.
- **Radius: zero.** `*, *::before, *::after { border-radius: 0 }` in the base layer, and every `border-radius` in the
  sheet is deleted, round dots included. Live dots become squares and the session mark becomes a diamond, as in the mock.
- **Edges:** 1 px lines from the line scale. Dashed lines mean "parked" or "a preview of more" (the Backlog preview's
  top edge). Dotted underlines mean "this opens".

### 2.7 Motion

| Token | Value | Use |
|---|---|---|
| `--dur-1` | 120ms | hover, press, colour |
| `--dur-2` | 200ms | reveal, tab, chip, tile rise |
| `--dur-3` | 320ms | panel and command-bar wipe |
| `--ease-std` | `cubic-bezier(.4, 0, .2, 1)` | most transitions |
| `--ease-out` | `cubic-bezier(0, 0, .2, 1)` | entries |
| `--ease-hard` | `steps(1, end)` | blinks |
| `--stagger` | 40ms, at most 12 items | tile rise |

- **One blink** replaces Quiet's pulse: a strobe on `--ease-hard` at 1.6 s, used by the live dot and the working chip.
- **Press** is a 1 px drop. Nothing scales, bounces or floats.
- **Reduced motion:** nothing moves or blinks (no rise, wipe, decode or strobe). Colour and opacity changes stay at
  `--dur-1`, so hover and state changes still read. This replaces today's blanket `animation: none !important`.

### 2.8 Layers

`--z-page` 0, `--z-chrome` 10 (HUD, footer), `--z-rail` 20, `--z-popover` 30 (menus), `--z-sheet` 40 (Details),
`--z-toast` 50, `--z-command` 60 (the command bar and the viewer). Today's literal z-indexes (menus 20, Details 10,
viewer 30, toast 40) move onto these.

### 2.9 Textures

- **Hazard tape:** `repeating-linear-gradient(-45deg, var(--volt) 0 10px, var(--canvas-0) 10px 20px)`, 6 px strips
  only: the comms slab's top edge, and the reconnecting banner in alarm.
- **Ruler:** two tick gradients (64 px majors, 8 px minors) under the HUD bar, and the violet since-ruler in Done.
- **Dot grid:** `radial-gradient(circle, var(--line) 1px, transparent 1px) 0 0 / 8px 8px`, behind empty states.

### 2.10 How the flip lands (#498)

- **v3 names, Quiet aliases.** The tokens file defines every token above under its v3 name, then re-points each Quiet
  name at one, so every surface turns v3 in this one step without touching its rules:

  | Quiet | becomes | Quiet | becomes |
  |---|---|---|---|
  | `--bg` | `--canvas-1` | `--active`, `--active-ink` | `--volt` |
  | `--bar` | `--canvas-0` | `--active-line` | `--volt-soft` |
  | `--card` | `--canvas-2` | `--active-fill` | `--volt-wash` |
  | `--lane` | `--canvas-1` | `--amber`, `--amber-ink` | `--volt` |
  | `--panel` | `--canvas-1` | `--amber-fill` | `--volt-wash` |
  | `--float` | `--canvas-2` | `--red` | `--alarm` |
  | `--panel-2` | `--canvas-3` | `--red-fill` | `--alarm-wash` |
  | `--track` | `--canvas-4` | `--sky`, `--link` | `--text-hi` (links take a dotted underline) |
  | `--track-fill` | `--text-muted` | `--shadow` | `none` |
  | `--text` | `--text` | `--hairline` | `--line-strong` (until §5's Ruler) |
  | `--text-2` | `--text` | `--radius` | `0` |
  | `--muted` | `--text-muted` | `--font-sans` | `--font-body` |
  | `--faint` | `--text-dim` | `--fs-l`, `--fs-m`, `--fs-s` | `--t-title`, `--t-body`, `--t-detail-sm` |
  | `--border` | `--line` | `--w-text`, `--w-heavy` | `--w-body`, `--w-display` |

  `--track-l` is deleted with its two uses. Today's 2 px ink focus outline becomes a 2 px volt outline in the same step.
- **Aliases go surface by surface.** Each surface step writes its rules with v3 names. The step that lands last deletes
  the alias block, and the phase is not done while a Quiet token name is left in `web/src`.
- **Tests in the same step:**
  - `test/web/tokens.test.ts` is rewritten for one palette: `color-scheme: dark` and no `prefers-color-scheme` in any
    file under `web/src`; the v3 values above; the seven hues in order; font sizes only from the ramp tokens (plus
    `em` sizes for glyph scaling); weights only from the weight tokens; `font-stretch` only 75, 87.5, 100, 112.5 or
    125 %; no `border-radius` but 0; no literal colour outside the tokens file. It reads the sheet files the split
    (#497) creates (§3).
  - e2e assertions on Quiet's literal values move to v3's (§12 lists them). The theme test (`ui.spec.ts:1293`) becomes
    "the window is dark whatever the OS theme": an emulated light and an emulated dark scheme give the same colours.

## 3. Sheet split

*Status: awaiting approval.* Built by #497, the first build step. Label refactor: no visual change.

### What it improves

Today the window's look is one 578-line sheet, `web/src/styles.css`, whose regions interleave (the Board's region also
holds the activity strip, the banner and the task box the Backlog uses; Details' asks sit after the reduced-motion
block). Every surface step would edit the same file. After the split each surface has its own file, so a diff reads per
surface and two steps can run side by side without touching the same sheet.

### Files

A new folder, `web/src/styles/`. Each file wraps its rules in its own `@layer` block; `main.tsx` imports them in this
order, after the font packages, in place of `./styles.css`:

| File | Layer | Holds (today's `styles.css` lines) |
|---|---|---|
| `layers.css` | none | the one statement `@layer tokens, base, parts, components;` |
| `tokens.css` | `tokens` | `:root` and the dark block (1-90) |
| `base.css` | `base` | reset, `html`, `body`, `button`, `.muted`, the pulse keyframes (91-98); reduced motion (507-511) |
| `chrome.css` | `components` | chrome (99-200); the activity strip, banner and empty state (400-406) |
| `project.css` | `components` | Project view (201-264) |
| `board.css` | `components` | Board (265-399 and 407-420): bands, header, task box, states, Next, Backlog fold, glyphs, YOU tag |
| `panels.css` | `components` | Details and the viewer (421-506); Details' asks and marks (513-519) |
| `done.css` | `components` | All done (520-545) |
| `backlog.css` | `components` | the preview head, the full view and its chips, the Park form and parked rows (546-578) |
| `marker.css` | `components` | `web/src/marker.css`, moved here, unchanged |

- **`parts` is declared now and stays empty.** #499 fills it with the shared v3 parts. A rule in `components` beats one in
  `parts` whatever its specificity, so a surface can adjust a part without a selector race.
- **`marker.css` joins the `components` layer, last.** Today it loads after the whole sheet (`Marker.tsx:2` imports it)
  and wins ties. Left unlayered it would beat every layered rule, so it moves into the layer at the end, which keeps its
  place. `Marker.tsx` stops importing it.
- **The order inside `components` is today's region order**, and each file keeps its rules in source order, so the
  cascade inside the layer is the same as today's. Three groups change position: the activity strip, banner and empty
  state (to `chrome.css`), Details' asks and marks (to `panels.css`) and the reduced-motion block (to `base.css`, where
  its `!important` still wins, being the sheet's only one). The computed-style diff below proves none of them changes a
  value.
- **Region comments become file heads.** Each file opens with one line on what it styles. Comments inside rules move
  with them.
- **Nothing is renamed and no value changes.** Classes stay `ip-*`; tokens keep Quiet's names until #498.

### Proving no visual change

- `npm run typecheck`, `npm test` and the full e2e suite pass unchanged, with no test edited but the two that name the
  old file: `test/web/tokens.test.ts` reads `web/src/styles/tokens.css` for the tokens and every file in
  `web/src/styles/` for the type checks, and `test/scripts/deploy-lib.test.ts:84` names a file in the new folder.
- **A computed-style diff.** The step builds main and the branch, opens each on the session's port with the e2e
  fixture, and dumps `getComputedStyle` for every element on the Board wide (1600) and narrow (400), the Project view,
  the Backlog view, All done, Details, the resource viewer, a tab menu and GoTo. The two dumps must be identical. The
  script lives in the session's scratchpad, not the repo; its output goes in the receipt.
- Murr reviews the diff as usual; Parvati does not run (nothing to look at).

### Not in this step

- No `@import` chains: Vite's handling of `@import ... layer()` is not relied on, since each file declares its own layer.
- No CSS modules. The window keeps global `ip-*` classes; the parts in #499 follow the same naming.
- No dead-rule cleanup. Unused rules go when their surface is ported.
