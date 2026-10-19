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
| D2 | Counts in the rail | Keep the volt ask count on each project row, against InThink's rail rule | §6 | Keep the count, as recommended (Aiden, 2026-10-18) |
| D3 | Step hues | The seven hues become faction colours on each tile's top rule | §2 | The seven factions, as mocked (Aiden, 2026-10-18) |
| D4 | Ctrl K | GoTo becomes a v3 command bar; the Board keeps no shortcuts of its own | §10 | open |
| D5 | What supersedes what | The port reverses Board spec 2.8 and Quiet's palette, fonts, chrome and cards; #506 writes the ruling | §13 | open |
| D6 | Project colour on the rail | A bright grey rule on every row, volt only for the current one | §6 | A faction per project from its id, against the recommendation (Aiden, 2026-10-18) |

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

*Status: approved by Aiden, 2026-10-18.* Built by #497, the first build step. Label refactor: no visual change.

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
- No CSS modules. The window keeps global `ip-*` classes; the parts in #499 are global classes too (§4).
- No dead-rule cleanup. Unused rules go when their surface is ported.

## 4. Shared parts and the lab

*Status: approved by Aiden, 2026-10-18.* Built by #499, after Foundations. Label ui.

### What it improves

Today each surface draws its own versions of the same thing: three chip looks (`.ip-st`, `.ip-chip`, `.ip-mark`), four
field looks (`.ip-answer`, `.ip-quick-add`, `.ip-rename`, `.ip-park-field`), two button looks and a menu row styled per
menu. The parts below are built once, in every state, so each surface step assembles them rather than redrawing them,
and Parvati has one place to check a state against.

### Where they live

- **Components** in `web/src/parts/`, one `<Name>.tsx` each. **Styles** in `web/src/styles/parts.css`, in the `parts`
  layer (§3). Global classes, no CSS modules.
- **Class prefix `p-`** (`.p-chip`, `.p-tile`), so a part never collides with a surface's `ip-*` class while both exist
  (`.ip-chip` and `.ip-btn` already do). Variants are attributes: `.p-chip[data-tone="needs"]`.
- **Keyboard logic is a pure function** beside its part (as `menuStep` is in `web/src/chrome/menu.ts`), so vitest covers
  it without a DOM.
- **Nothing on screen changes in this step.** The parts appear only in the lab until each surface step adopts them.

### The parts

Every interactive part has these states unless its row says otherwise: hover, `:focus-visible` (a 2 px volt outline,
or a volt border plus the `--volt-soft` ring on boxed controls), pressed (a 1 px drop) and disabled (`opacity: .45`, no
hover).

| Part | What it is | Variants and props | Its own states | Used by |
|---|---|---|---|---|
| **Eyebrow** | a glyph and a label above a head: `[!] NEEDS ME` | glyph (`//`, `[+]`, `[!]`, `>>`, `[◈]`, `[✓]`), glyph tone (volt, dim) | | every head |
| **Readout** | `[KEY] value`: a boxed micro key, a mono value | value tone (text, volt, alarm); the dot face for clocks | a title that says what the figure counts | HUD, rail foot, Details meta |
| **Count** | a Doto figure | size (h1, h3), tone (muted, text, volt) | blinks once when it rises, the moment something new arrives; static under reduced motion | column heads, view titles |
| **Chip** | a boxed micro label | tone: `needs` (volt fill), `live` (volt line and a blinking square), `ready` (bright line), `blocked` (alarm), `parked` (dashed, dim), `quiet` (idle, backlog; unattended dashed), `label` (glyph and word, no box), `count` | removable (an × button) when it is a filter | tiles, rows, Details, filters |
| **Button** | a command | `primary` (volt fill), `outline` (the default), `ghost`, `danger` (alarm line, alarm fill on hover); sizes `sm` 26 px and `md` 32 px; an optional glyph after the label (`›`, `↗`) | busy (label kept, a blinking square before it, not clickable) | everywhere |
| **TabStrip** | boxed labels split by hairlines, the active one volt-filled, each with an optional count | `tabs` (`role="tablist"`; arrows move and select; Home, End) or `segmented` (`aria-pressed` buttons, for a sort or a filter) | overflows sideways with no scrollbar and keeps the active tab in view | Backlog preview, Backlog view, All done |
| **Field** | a text input, or a textarea that grows | size `sm`, `md`; a label (an Eyebrow) or an `aria-label`; an inline hint | invalid (alarm border, the reason under it in alarm); busy (read-only, dimmed) | answer, quick-add, rename, park, filter, the command bar |
| **Menu** | a popover list on `--canvas-2` with a `--line-strong` edge | items with an optional glyph and a key hint at the right; a `danger` item in alarm; a separator; an Eyebrow head | the item with focus shows `--canvas-3` and full ink; a current item carries a volt `›`; Up, Down, Home and End move (today's `menuStep`) | rail menus, Project docs, row menus |
| **Confirm** | a question, what it means, then the action and Cancel, inside a menu or a row | the action is `danger` when it deletes | focus starts on Cancel | delete, archive, park |
| **Tile** | the task box | `hue` (0 to 6, or none: the 2 px top rule); tone `default`, `ask` (volt wash, volt-tinted edge, Frame corners), `done` (no fill, compact), `parked` (dashed, no hue); slots: top (id and the chips at the right), title (a link that opens Details), body, foot | hover (`--canvas-3`, a bright edge, the top rule turns volt when it has no hue); keyboard focus inside (Frame corners); selected, while Details shows it (volt edge); dragging (half opacity); a drop line (2 px volt above); pending (half opacity, actions hidden); entering (an 8 px rise, staggered) | Board, Backlog preview, Backlog view |
| **Frame** | corner brackets drawn with gradients, just outside the box | size (12 px), weight (2 px), tone (volt, alarm) | | ask tile, focused tile, command bar |
| **LiveDot** | a 7 px volt square with a blinking core | `still` (no blink: busy only on a worker or a command, as today's `.still`) | | rail, Now, footer |
| **Marker** | a step's status at 9 px | today's statuses on squares: todo (hollow, bright line), active (volt), blocked (alarm), dropped (dim), parked (dashed, dim), done (a muted ✓), question (a `?` in a 13 px square), paused (hollow, muted), you (volt fill) | | Project outline, Details, rows |
| **KeyHint** | a boxed key and its micro label | | | footer, command bar, tooltips |
| **Tape** | a 6 px hazard strip | tone volt, alarm | | comms slab, reconnecting banner |
| **Ruler** | ticks | `hud` (64 px and 8 px), `since` (violet dashes, with the time) | | under the HUD, Done |
| **EmptyState** | a dot-grid panel, one sentence, an optional action | | | every list that can be empty |
| **ErrorLine** | an alarm-washed line with a 2 px alarm bar, the message in reading text, and Retry | | | every failed load or write |
| **Toast** | a status line at the bottom left, above the footer | tone neutral, alarm | leaves after 4 s, or, for an error, stays until dismissed; `role="status"` | archive, delete, write failures |

Rules for every part:

- **Sentence text is never micro or uppercase** (§2.5). A Chip or Button label is a word or two; a longer one means the
  control is wrong.
- **Volt on a part means your move or live** (§2.3). A Button is `primary` only for the one action a view most expects
  next: Answer on an ask, Send in an answer, the chosen row in the command bar.
- **The marker keeps its job.** It still draws the ✓ and the ? in CSS, so a step's name stays the first text.
- **Delete is `danger`.** Quiet kept Delete in ink because red meant blocked. v3 gives destructive actions alarm
  (InThink §5), which reverses today's rule on purpose.

### The lab (`#/lab`)

A specimen page for the parts: Parvati's reference and the builders' check.

- **What it shows:** every part in every variant and static state (resting, disabled, busy, selected, invalid, each
  tone), each under an Eyebrow naming it; the colour tokens as swatches; the type ramp; the seven hues on tiles; the
  motion (a tile rise, the blink, a Count rise) with a button that replays it. Hover, focus and press are left to the
  pointer and the keyboard, not faked with classes.
- **Fixture data** in `web/src/lab/fixtures.ts`. No server reads.
- **Reached only by typing `#/lab`**, read the way `#/p/<slug>` is (`web/src/useInProgress.ts:12`). Nothing links to it.
- **A lazy chunk in every build**, not a dev-only page. Parvati reviews the built branch, not a dev server, so a dev-only
  lab would be out of her reach, and a lazy import costs the live window nothing until the hash is typed. The strategy
  said dev-only; this is the reason to differ.
- **Tests:** vitest for each part's pure helpers (TabStrip's keys, Count's rise check), and one e2e test that opens
  `#/lab`, finds every part's heading and walks a TabStrip with the arrow keys.
- **Review:** Parvati reviews the lab at 1600 and 400 against the mock and §2; Murr reviews the diff.

## 5. Shell: the HUD bar and the footer strip

*Status: approved by Aiden, 2026-10-18.* Built by #500, after the parts. Label ui.

### What it improves

- **One glance answers "does anything need me, anywhere?"** Today a waiting ask in another project shows only as a muted
  numeral on its tab. The HUD's figures count across every project, and the ask figure takes you to the asks in one
  click.
- **A lost connection is impossible to miss.** Today it is an amber line above the canvas. In v3 the HUD's link readout
  turns alarm and a strip of alarm tape replaces the ruler, without pushing the page down.
- **The bottom line explains itself.** The activity line keeps its place, and the keys that work right now sit beside it.

### Frame

The window becomes a column: the HUD bar, the ruler, the shell (the rail and the page, §6), the footer strip. The HUD
and the footer never scroll; the page scrolls inside the shell. Until #501 lands, today's tab row sits between the ruler
and the page, in v3 tokens.

### The HUD bar

60 px on `--canvas-0`, `--sp-5` side padding; 48 px under 720 px.

| Place | What | Source | Notes |
|---|---|---|---|
| left | **INPROGRESS** wordmark: brand face, `--t-h3`, volt | | Clicking it opens the current project's Board. |
| centre | **`[ASKS] n`**: asks and permission waits across every open project | the project list's `openAsks` and `permissionWaits` (`waitingOn`, `web/src/chrome/tabs.ts:120`) | Volt while above 0. A button: when this project has asks, it moves focus to Needs me; otherwise it opens the first project in rail order that has asks, on its Board. Its title lists the projects and their counts. |
| centre | **`[LIVE] n`**: sessions working or busy, across every project | `busySessions` | Its title lists the projects with work going on. |
| centre | **`[READY] n`**, **`[BACKLOG] n`**: this project's | the open project's Board | Shown from 1160 px. |
| right | **`[LINK] OK`**, or **`[LINK] RECONNECTING`** in alarm | the stream's `connection` (`web/src/useInProgress.ts:24`) | Replaces the mock's `[HOOKS] OK`, which has no source. |
| right | **the date and a clock**, local time, `HH:MM` in the dot face, the date in mono | the browser clock | The date hides under 1160 px. No seconds: a figure that changes every second draws the eye for nothing. |
| right | **Find** with the `Ctrl K` KeyHint | | Opens the command bar (§10). Under 720 px, the glyph alone. |

- **Not shown:** the mock's `[SCRIBE] idle` and `[DB] m13`, and "4 sessions today". The window has no source for them,
  and §0 rules out new reads for ornament.
- **Under 720 px:** the wordmark, the link readout, the ask figure and Find. Nothing wraps.
- **Readout figures use the Count's rise rule** (§4): `[ASKS]` blinks once when it rises.

### The ruler and the lost connection

- A Ruler (`hud`) runs under the bar as the page's top edge, replacing Quiet's 3 px gradient hairline.
- **While the stream is reconnecting**, an alarm Tape takes the ruler's place, and the link readout says
  `RECONNECTING` with a blinking square. `.ip-banner` goes. When the stream comes back, the ruler returns and the readout
  reads `OK`.
- **Before the first load** (the window's own loading state, `web/src/App.tsx:299`), the HUD shows with the link readout
  and a centred EmptyState saying "Loading…" or "Can't reach the InProgress server, retrying…" in alarm.

### The footer strip

One line on `--canvas-0` with a hairline above, `--sp-3` by `--sp-5` padding, mono `--t-detail-sm`.

- **Left, the activity line**, as today (`web/src/chrome/ActivityStrip.tsx`): `↳ actor · when · what`, the actor and the
  event in ink, the rest muted; only the event shrinks. A LiveDot leads it while a session in this project is working.
  "No activity yet" when there is none.
- **Centre, the keys that work now**, as KeyHints: `Ctrl K` Find always; `[ ]` Projects when there are two or more;
  `Esc` Close while Details, a menu or the viewer is open. Hidden under 1160 px.
- **Right, the server line:** `LOCALHOST:4317 · BUILD 8b796d9`, from the page's location and `/api/health`'s build
  (`web/src/api.ts:18`), with `+DIRTY` when the build says so and the build time in its title. Hidden under 720 px.

### Toasts and empty windows

- The status line (`.ip-status .ip-toast`, `App.tsx:342`) becomes the Toast part, bottom left, above the footer.
- No projects at all: the page area shows an EmptyState, "No projects yet. A Claude session adds one when it opts in.",
  in place of `.ip-empty`.

### Tests and review (#500)

- One e2e test for the HUD: with the fixture's asks in two projects, `[ASKS]` shows their sum and opens
  the first project in rail order with asks; dropping the stream turns the link readout to `RECONNECTING` and shows the alarm tape.
- The activity strip's existing tests keep passing with their selectors moved to the footer.
- Parvati reviews the HUD and footer at 1600, 1160, 720 and 400, with the stream open and reconnecting.

## 6. Shell: the module rail

*Status: awaiting approval.* Built by #501, after the HUD. Label ui.

### What it improves

- **One place to move around.** Today there are four: the project tabs, the Board | Project switch, the Backlog
  preview's "N ›" and Done's "All done ›". The rail holds them all: projects, and under the current one its four views.
- **Backlog and All done become views you can see from anywhere.** Today they hide behind links at the foot of two
  Board columns. In the rail they sit beside Board and Project with their counts.
- **Names stop being cut at 160 px.** A rail row is 190 px wide, and its full name is in its title and accessible name.
- **Project actions are where the project is.** Rename, Archive and Delete stay on the project's own row; archived and
  recently deleted projects get a rail foot instead of the ⋯ menu at the far right.

### Layout

| Width | Rail |
|---|---|
| 1360 px and up | 216 px column, left of the page, the full height between the ruler and the footer |
| 720 to 1359 px | 76 px column of three-letter codes |
| under 720 px | a strip under the ruler, scrolling sideways, with the current project's views as a TabStrip at the top of the page |

The rail scrolls on its own when the projects outgrow it, keeping the current row in view.

### Project rows

- **Head:** an Eyebrow, `// PROJECTS`.
- **A row** (36 px): a short 2 px rule at its top left in the project's colour, the name in the display face
  (`--t-h3`, uppercase, cut with an ellipsis), then its signals at the right:
  - a **LiveDot** while a session there is working (blinking) or busy on a worker or command (still), as today's tab dot;
  - a **volt ask count** while asks or permission waits wait there (D2, Aiden 2026-10-18: kept against InThink's rail
    rule, since the rail is how Aiden sees that another project needs him). The same figure as today's tab count
    (`waitingOn`).
- **The current row** is volt-filled with volt-ink text; its rule, LiveDot and count turn to ink on volt.
- **Hover:** volt text and a `--line-strong` edge. **Keyboard focus:** a volt edge and the `--volt-soft` ring.
- **Project colour** (Aiden, 2026-10-18): each project's rule takes a faction colour from its id, `--hue-(id mod 7)`.
  It needs no setting and never changes. It is the rule's only use; the page itself keeps volt as its accent.
- **Order** is today's tab order: drag a row, or Alt with Up or Down, to move it; the stored order and its key do not
  change.
- **An archived project that is open** shows as one more row at the end, its name upright with an `ARCHIVED` Chip, as
  today's italic tab does; it leaves the rail when another project is opened.

### The current project's views

Under the current row, indented: **Board**, **Project** (with `n phases`), **Backlog** (with its open count, parked
excluded, as the preview's "N ›"), **All done** (with its count). Mono `--t-detail-sm`, uppercase; the current view in
volt with a `›` before it.

- **Views are peers.** Backlog and All done stop being flags on the Board (`web/src/App.tsx:313-317`) and become views
  like Board and Project. `View` grows to `'board' | 'project' | 'backlog' | 'done'`, kept in `ip.view` as today. Each
  view keeps its own back affordance only where it still helps: the Backlog view's and All done's "‹ Board" go, since
  the rail is always there.
- **The links into them stay.** The Backlog preview's "N ›" and Done's "All done ›" (§7) open the same views.
- **The Board | Project switch goes** (`web/src/chrome/ViewSwitch.tsx`).

### Narrow rail (720 to 1359 px)

- Each row shows a **three-letter code**: the initials of the name's words (camel-case and hyphens split words), filled
  from the name's next consonants to three letters, uppercase; a second project with the same code gets a digit
  (`IN2`). The name is in the title and the accessible name.
- Signals move to the row's top right corner: the ask count as a small volt block; the LiveDot hides.
- The views show as `BRD`, `PRJ`, `BKL`, `DON`, with their counts in their titles.

### Strip (under 720 px)

- The project rows run left to right at their full names, with their signals; the current one volt-filled.
- The rail foot moves into a `⋯` button at the strip's right end.
- The current project's views become a `segmented` TabStrip at the top of the page, above its head.

### Menus

- **A row's menu** opens on right-click, Shift F10 or the context-menu key, as a tab's does today, with today's items:
  Archive (with its line on the live sessions it stops tracking), Rename… and Delete…; Unarchive in place of Archive on
  an archived row. Rename… turns the menu into a Field; Delete… into a Confirm whose action is `danger` (§4).
- **The rail foot** holds one ghost Button, `Archived · n`, when there are archived or recently deleted projects. It
  opens today's ⋯ menu as a Menu: Archived rows to open or unarchive, a separator, Recently deleted rows with Restore and
  their days left.

### Keys and focus

- `[` and `]` step to the previous and next project, `1` to `9` open the nth, as they do for tabs today.
- The project rows are one Tab stop (roving tabindex, today's "one stop" rule); Up and Down move between rows; Enter or
  Space opens. The views are a second stop, with the same keys.
- The rail is a `nav` named "Projects", each row a link with `aria-current="page"` on the current one, its accessible
  name today's `projectLabel` ("InThink, 2 need you, working").

### Tests and review (#501)

- The e2e helper `tabFor` (`test/e2e/ui.spec.ts:378`) becomes a rail-row helper, and its 82 uses check
  `aria-current` in place of `aria-selected`.
- The tab-row tests are rewritten for the rail (§12 lists them): the view switch remembered, a long name, the live
  signal and reduced motion, one Tab stop, the row menu, Delete's note, Rename's field, the menus' look, a menu inside a
  narrow window. The tab strip's sideways wheel test goes with the strip.
- New: one e2e test that opens Backlog and All done from the rail and back to Board.
- Murr runs on Opus for this step (focus and keyboard, the menus: the risk list). Parvati reviews the rail at 1600,
  1360, 1159, 720 and 400, with a long name, ten projects, an open archived project and every signal.
