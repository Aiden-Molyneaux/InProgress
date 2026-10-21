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
| D4 | Ctrl K | GoTo becomes a v3 command bar; the Board keeps no shortcuts of its own | §4, §10 | Two parts (Aiden, 2026-10-18): the command bar finds steps and moves you (projects, views), and writes nothing; lists get an arrow cursor with no letter keys |
| D5 | What supersedes what | The port reverses Board spec 2.8 and Quiet's palette, fonts, chrome and cards; #506 writes the ruling | §13 | As recommended: not a UI call, so recorded without asking under Aiden's standing approval (2026-10-18); his to overturn |
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
| **ListCursor** | the arrow cursor (D4, added 2026-10-18 after this section's approval) | a list, or a grid of lists (the Board's columns) | see below | Board, Backlog view, All done, Project outline |

**The list cursor (D4).** A list is one Tab stop: the item last focused (else the first) holds `tabIndex` 0, the rest
-1. Up and Down move between items; in a grid, Left and Right move to the item nearest the same height in the next
column; Home and End go to the ends. Enter opens the item's Details. Tab goes into the focused item's own controls,
then out of the list. Typing in a field never moves it, and there are no letter keys. Esc keeps today's meaning (it
closes Details). The step logic is a pure function beside the part (`cursorStep`), tested with vitest like `menuStep`.

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
- **At narrow widths while reconnecting** (approved by Aiden at #500's review, 2026-10-19): under 720 px the word
  `RECONNECTING` is hidden visually, still read by a screen reader, so the alarm square and the tape carry it and `[ASKS]`
  keeps its room; under 1160 px `[LIVE]` gives way while the link is down.
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

*Status: approved by Aiden, 2026-10-18.* Built by #501, after the HUD. Label ui.

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

## 7. Board

*Status: written under Aiden's standing approval (2026-10-18).* Built by #502, after the parts. Label ui. The mock is
the reference; this section says where it improves on it.

### What it improves

- **The page says where it stands before you read a tile:** a head with the project's counts and the Orchestrator's
  note in a slab, its step references clickable, the full note one click away.
- **"N to tidy" does something.** Today it is a static count whose tooltip lists the marked steps. It becomes a button
  that lists them in a Menu, each opening its Details.
- **Two asks on one step read apart**, each in its own panel with its own Answer and Clear, its text expandable rather
  than cut.
- **The Now column shows progress, not just presence:** "Task 3 of 4" and the newest command in a terminal readout.
- **Next can be reordered from the keyboard**, not only by dragging.
- **The Backlog preview takes a third of the height:** one-line rows and a phase TabStrip in place of full boxes and a
  native select.
- **The tile you have open in Details stays marked**, so you can see where you are on the Board.

### Page head

- **Code block:** the project's three-letter rail code (§6) in a volt block, brand face. It matches what the narrow rail
  shows.
- **Title:** the project name at `--t-h2` (Aiden, 2026-10-20, #502: `--t-h1` read too big; the Project view's head
  follows), display, uppercase, `--text-hi`. On first paint after a project switch it
  decodes once (the mock's scramble, at most 520 ms); static under reduced motion.
- **No meta line on the Board** (Aiden, 2026-10-20, #502): the HUD and the rail already carry the asks, live, ready and
  done figures. The Project view keeps its own meta line.

### The comms slab

`--canvas-0`, a `--line` edge. No Tape (Aiden, 2026-10-20, #502: the hazard strip went, on the Project view's slab too).

- **First row:** an Eyebrow `[◈] COMMS // ORCHESTRATOR` and the note's age (`LOOKED 2D AGO`, mono, dim).
- **The message:** the state note's first sentence at 1.0625rem, `--text-hi`, at most 68ch. Step references (`#399`)
  are mono volt links that open that step's Details. When the note has more than one sentence, **More** (ghost `sm`)
  opens the whole note in place as Markdown, and **Less** folds it. No note: "No state note yet", muted.
- **Actions at the right:** **N to tidy** (`danger`, `sm`) when steps carry hygiene marks; it opens a Menu, one item per
  marked step (`#id` and its marks, as `hygieneTitle` writes them in `web/src/board/text.ts:23`), each opening Details.
  The mock's "Project view ›" goes: the rail has it.
- **Second row, "No claimed step":** when live sessions are not on a Now row (`headerSessions`, today's rule), an Eyebrow
  `// NO CLAIMED STEP` and one session line each: a neutral diamond, the title, an `ORCHESTRATOR` Chip where it is one,
  its activity word, Open ↗. Absent when there are none.

### Columns

| Width | Layout |
|---|---|
| 1160 px and up (of the page, not the window) | four columns: Needs me, Next, Now, Done, widths 1.12 : 1 : 1.12 : 0.94, `--sp-6` apart |
| 720 to 1159 px | two by two: Needs me and Now on top, Next and Done below, `--sp-section` between rows |
| under 720 px | one column: Needs me, Now, Next, Done |

The four-column switch moves from today's 960 px (`web/src/board/useWide.ts:3`) to a page width of 1160 px, since v3's
type is larger; `useWide` measures the page column, not the window, so the rail's width counts.

**Column head:** the column's glyph (`[!]`, `>>`, `[◈]`, `[✓]`), its name in the display face at `--t-h3`, a Doto Count
at the right, and under the name a short hint in mono `--t-detail-sm`, sentence case: "Oldest wait first", "Queue
order, drag or Alt+arrows", "Live sessions, working first", "Latest of 113". A hairline under the head; volt for Needs
me, whose glyph and Count are volt too, and whose Count blinks once when it rises (§4). The others stay muted.

### Needs me

- **An ask tile** (Tile `ask`: volt wash, volt-tinted edge, Frame corners, the step's hue on its top rule):
  - top: `#id`, a `needs` Chip naming the kind (`REVIEW`, `QUESTION`, `PERMISSION`), the age;
  - the title;
  - the session line: the hue diamond, the session's title, its state word, **Open ↗**;
  - **each ask in its own panel** (`--canvas-1`, a `--line` edge): an Eyebrow `01 REVIEW` and its age; the text at
    `--t-body`, cut at four lines with **Show all** when longer; **Answer…** (`primary`, `sm`) and **Clear** (`ghost`,
    `sm`). Answer… turns the row into a Field ("Your answer, then Enter") and a **Send** button; Enter sends, Escape
    returns focus to Answer…. A sent or cleared ask strikes through at half opacity until the snapshot drops it. A
    refusal shows as an ErrorLine in the panel;
  - the foot: the handoff Chip (opens the viewer), `▤ n` for documents, the label Chip, hygiene words as `quiet` Chips.
- **A permission wait** is an ask tile whose panel reads "Allow a shell command" with the newest running command in a
  terminal readout (`--canvas-0`, mono), or "Waiting for permission", and one **Open session to allow ↗** (`primary`).
- **Order:** oldest wait first, as today. **Empty:** an EmptyState, "Nothing needs you", at its smallest (one line on
  the dot grid).

### Next

- **Tiles** for the unowned queue: hue, a `ready` Chip, the age, the title, the foot. **back to Backlog** (ghost `sm`)
  shows on hover and whenever focus is inside the tile, as today.
- **Drag to reorder**, today's rules (`web/src/board/dragQueue.ts`), with the Tile's drop line in volt. **New: Alt+Up
  and Alt+Down** on a focused Next tile move it one place, through the same queue write as a drop; focus stays on it.
- **Own queues:** an Eyebrow `// QUEUED BY <session title>` over each session's own queue, as today's "Queued by".
- **Empty:** "Nothing is queued".

### The Backlog preview (foot of Next)

A dashed `--line-strong` edge above it.

- **Head:** an Eyebrow `[+] BACKLOG · N` (N as today's "N ›": open entries, parked excluded), then **+ Add** (ghost
  `sm`) and **Open ›** (ghost `sm`, opens the Backlog view).
- **Phase menu button** (Aiden, 2026-10-20, #502, in place of the mock's TabStrip): ghost `sm` reading
  `<phase> · <count> ▾`, opening a Menu of the phases with entries in tree order, then No phase, each with its count,
  the picked one current. The choice, its storage key (`ip.backlogPreview.<projectId>`) and its default rule do not
  change.
- **Boxes**, up to five, one per entry (Aiden, 2026-10-20, #502, in place of the mock's one-line rows): the Board's
  tile with no hue and compact padding; top `#id`, a `blocked` Chip when blocked, the age, and **to Next** (ghost `sm`)
  on hover or focus; the title; the foot as other tiles. Boxes drag into Next, as today. A box opens Details.
- **Foot:** "4 more in No phase · Open Backlog ›" when the phase has more than five; **+ Add** opens the quick-add Field
  here, which creates under the picked phase (today's rule).
- **Empty:** "Nothing in <phase>", with the phase menu button still there.

### Now

- **Tiles** for steps with live sessions, working first. Top: hue, a Chip (`live` WORKING, `quiet` IDLE, `quiet` dashed
  UNATTENDED, `blocked`), the age (`NOW` while working).
- **Per session:** the session line (hue diamond, title, `drives` or `helping` when there is a driver, Open ↗), then a
  terminal readout when there is anything to show:
  - `Task 3 of 4 · <the in-progress task>`, counted from the session's working tasks (the focus step's first, today's
    rule);
  - `▸ <newest command> · 2M`, muted while serving, as today's commands line;
  - `2 subagents` with their purposes in its title, as today's kin count.
- **No session:** "No session is on it", muted.
- **Done…** (ghost `sm`, in the foot) opens a Confirm in the tile: "Mark #id done?", the driver note, an outcome Field
  ("Outcome (optional), then Enter"), **Mark done** (`primary`; "Marking done…" while in flight) and Cancel. Today's
  keys and rules stand (`web/src/board/NowColumn.tsx:176-221`).
- **Open ↗** failing shows the copyable `claude --resume` command, as today.
- **Empty:** "Nothing is in flight".

### Done

- **Tiles** (Tile `done`): no fill, compact; top: `#id`, the label Chip, the age; the title at 0.9375rem, 600; the
  outcome in muted body text, cut at two lines. No hue and no "Done" Chip.
- **Since you looked:** a violet Ruler (`since`) with `SINCE YOU LOOKED · 09:14` (the time of the last look, from
  `ip.look.<projectId>`) where today's divider falls: the tiles above it are new.
- **Under 720 px** older tiles fold to "✓ N earlier", as today's narrow fold.
- **Foot:** **All done · 113 ›** (ghost `sm`), opening the All done view.
- **Empty:** "Nothing done yet".

### Every tile

- **A click anywhere on a tile opens Details**, except on its controls, as today (`web/src/board/Marks.tsx:65-71`).
- **The tile Details shows stays selected** (volt edge) until Details closes.
- **Hue:** coloured states only (Needs me, Next, Now), as today's rule; Done and the preview have none.
- **YOU** (a step Aiden does himself) is a `needs` Chip, since it is his move.
- **Keyboard (D4):** the four columns are one ListCursor grid (§4): arrows walk the tiles across and down, Enter opens
  Details, Tab reaches a tile's own buttons. The Backlog preview's rows are a list of their own inside the Next column.
  Alt+Up and Alt+Down reorder a focused Next tile (above).
- **Motion:** on first paint of a project's Board the tiles rise in a stagger (§2.7). A tile that arrives later by a
  live update rises alone. Nothing re-animates on an ordinary snapshot.

### Tests and review (#502)

- Rewritten (§12 lists them): the band position tests for the new widths, the preview test for rows in place of boxes,
  the permission-wait colour, the YOU tag, the hover actions' visibility.
- New e2e tests: "N to tidy" lists the marked steps and opens one; Alt+Down moves a Next tile; More opens the whole
  state note; a reference in the note opens its Details.
- Parvati reviews the Board at 1600, 1160, 720 and 400 against the mock, with every tile state the fixture can reach (two
  asks on one step, a permission wait, an unattended step, a blocked step, own queues, an empty column, the since-ruler).

## 8. Project view

*Status: written under Aiden's standing approval (2026-10-18).* Built by #503, after the parts. Label ui. The mock does
not show it; this section designs it.

### What it improves

- **The whole plan at a glance.** Today the wide layout spends a 320 px side column on the name, the note, a rail key
  and the done groups. v3 gives that column to a **phase index**: every phase with its progress, one click from its
  section.
- **Progress reads as one figure and one bar** per phase, not a legend sentence, a fraction and a bar side by side.
- **The rail marks explain themselves** in a one-line key above the sections, where today's key sits in the side
  column only at 960 px and up.
- **The note reads in full** in the same comms slab as the Board's, so the two views share a voice.

### Layout

| Page width | Layout |
|---|---|
| 1160 px and up | the sections (max 1040 px) and, at the right, the phase index (240 px, sticky under the page head) |
| under 1160 px | one column; the phase index folds into a "Phases · 7" TabStrip-style jump row under the slab |

Top to bottom: the page head (as the Board's: code, name, meta line `7 PHASES · 2 NOW · 3 NEXT · 113 DONE`), the comms
slab with the whole note open as Markdown (no More), the rail key, the sections, then the finished phases.

### The phase index

- An Eyebrow `// PHASES`, then one row per section in tree order: the phase title (body 600, one line, ellipsis), a thin
  progress bar (`--canvas-4` track, done in `--text-muted`, now in volt), and `22/30` in mono.
- A row scrolls its section into view, opens it if folded, and moves focus to its head. The section in view carries a
  volt `›`.
- **Finished phases** (today's "Done groups") sit at the index's foot under `// FINISHED · n`, folded; a row opens that
  section below the open ones, as today's pick does. The fold keeps today's key (`done:0` in `ip.folds.<projectId>`).

### Sections

A panel per section (`--canvas-2`, a `--line` edge), in today's order and with today's open rule
(`web/src/project/projectOutline.ts:82`) and fold storage (`ip.folds.<projectId>`).

- **Head:** an Eyebrow `[+] #399` (the group's id), the title at `--t-title` in the body face (a phase title is content,
  not chrome), then at the right: `22/30` as a Readout (`[DONE] 22/30`), `▤ n` (the docs Menu, today's DocsMenu as a
  Menu part), and the fold caret. The whole head toggles the fold.
- **Progress bar** under the head: one 4 px bar in four segments, done (`--text-muted`), now (volt), next (`--text`),
  backlog (a `--line-bright` outline), with today's legend ("22 done · 2 now · 2 next · 2 backlog", zeros left out) in
  its title and as hidden text. A folded section shows only its head and bar.
- **Outline rows** (open sections): the position mark, mono `#id`, the title at `--t-body`, then at 1160 px and up in
  columns: the label Chip, the marks, the sessions on it (one line each, title only, ellipsis), `▤ n`. Under 1160 px the
  label, marks and sessions wrap onto a second line. Indent per depth: 16 px, 12 px under 1160 px. A row opens Details.
- **Position marks**, the rail key's legend: Now with a session, a volt LiveDot; Now without one, a muted square; Next,
  its queue number in mono volt; an own-queue entry, a muted ◆ with its session's title in the title; Backlog, a hollow
  square; parked, a dashed square. The one-line key above the sections draws each with its word.
- **Done folds:** "✓ 8 done · latest #412 Fix export · 2D" as one muted mono row; a click expands it, as today.
- **Foot:** **+ Add a step** (ghost `sm`) opens the quick-add Field, creating under the section's group, as today.
- **Top level** comes last among the open sections, as today.

### States and keys

- No steps: an EmptyState, "No steps yet".
- The outline rows of the open sections are one ListCursor list (D4), in screen order across sections; Enter opens
  Details. The section heads and the index rows are ordinary buttons in the Tab order.
- Narrow (under 720 px): the slab, the jump row, the sections; outline rows on two lines; the rail key wraps.

### Tests and review (#503)

- The Project view tests keep their behaviour, with selectors on the new head (`.ip-view-name` gives way to the page
  head) (§12).
- New e2e test: a phase index row opens a folded section and focuses its head.
- Parvati reviews the Project view at 1600, 1160, 720 and 400 with a long plan (seven phases, one folded, one finished,
  a parked step, an own-queue entry).

## 9. Backlog view and All done

*Status: written under Aiden's standing approval (2026-10-18).* Built by #504, after the parts. Label ui.

Both are now rail views (§6). Both use the page head, then their controls in rows `--sp-4` apart, then the list:
InThink's module-head rule (Projects v3 spec, "Standing rules").

### What it improves

- **Rows instead of boxes.** Today the full Backlog repeats the Board's task box for every entry. A one-line row (the
  preview's) shows three times as many entries in the same height, with the same actions.
- **Filters you can see at once:** the phase filter is a TabStrip with counts, the labels are Chips, and the count of
  what is shown sits in the head's meta line.
- **All done reads as a log:** a time column, the title and outcome, grouped by day or phase, with the day's count in
  each heading.

### The Backlog view

- **Head:** code block, title `BACKLOG`, meta line `24 OPEN · 3 PARKED`, which reads `9 OF 24 SHOWN · 3 PARKED` while
  a filter is on.
- **Row 1:** the filter Field ("Filter…", today's words-AND rule over `#id`, title, label and parent title; Escape
  clears it), then at the right the sort as a `segmented` TabStrip (Phase, ID, Age) and the reverse Button (↑ ↓), kept in
  `ip.backlogOrder` as today.
- **Row 2:** the phase filter as a `segmented` TabStrip: All, each phase with entries, No phase, each with its count;
  then the label Chips (multi-select, plus "unlabelled"). The filter lasts while the view is open, as today.
- **List:** under Phase sort, groups by immediate parent, each headed by an Eyebrow with the parent's id and count
  (`[+] #399 · 3`) over the parent's title in the body face at 600 ("No phase" for the root's children); ID and Age sorts are one flat list. Each row: mono `#id`, the title
  at `--t-body`, the label Chip, the age, and, under ID or Age sort, the phase in mono dim. A `blocked` Chip where it
  applies. A step with open children shows `N open inside`.
- **Row actions**, on hover and whenever focus is inside the row: **to Next**, **Park…**, **Delete…** (only without
  children), as today. Park… opens the Park form in the row (Fields: "Why is it set aside?" required, "Where does the
  work live? (optional)"; **Park** `primary`, disabled until there is a reason). Delete… opens a Confirm whose action is
  `danger`: "Delete #id title? It can't be undone."
- **Parked**, at the bottom: an Eyebrow `PARKED · 3`, dashed rows with "Parked 12 Oct: <reason>" and "where <…>" on a
  second line, and **to Next** and **Unpark**.
- **Foot:** the quick-add Field, creating a root step, as today.
- **States:** empty, an EmptyState "Backlog is empty"; no match, "Nothing matches "<filter>"" with **Clear filter**,
  which focuses the field. A pending row is half opacity with its actions hidden; a refused write shows a Toast and
  restores the row, as today.
- **Keys:** the rows (groups and Parked included) are one ListCursor list; Enter opens Details. No drag, as today.

### All done

- **Head:** code block, title `ALL DONE`, meta `113 DONE`, and at the right the order as a `segmented` TabStrip (Time,
  Phase), kept in `ip.doneOrder`.
- **By time:** sections Today, Yesterday, then dates, then Undated, each headed by an Eyebrow with its count
  (`TODAY · 6`). Rows: the time (`HH:MM`) in a fixed mono column, then `#id`, the title, the label Chip and the parent
  in mono dim; the outcome under it in muted body text, one line, its whole text in the title.
- **By phase:** sections per immediate parent, headed by the crumb path in the body face at 600
  ("#26 InProgress › #495 Port the window") with the count in an Eyebrow above it; the left column shows the short date.
- **Rows** open Details. The rows are one ListCursor list.
- **Empty:** "Nothing done yet".

### Tests and review (#504)

- The Backlog view's and All done's tests keep their behaviour; their selectors move to the new rows and heads, and
  "‹ Board" assertions go (§12).
- New e2e test: the phase TabStrip and a label Chip together narrow the list, and the meta line says how many are shown.
- Parvati reviews both at 1600, 720 and 400 with a long Backlog (three phases, No phase, parked rows with and without
  where, a step with open children) and a long All done in both orders.

## 10. Details, the resource viewer and the command bar

*Status: written under Aiden's standing approval (2026-10-18).* Built by #505, after the parts. Label ui.

### What it improves

- **Details reads top-down by urgency:** what waits on you, what the step is, what is happening on it, what it links
  to, what happened. Today's order mixes them.
- **Park and Add a step stay in reach** in a strip at the foot of Details, where today they sit at the end of a long
  scroll.
- **At 400 px Details takes the page**, not 60 % of it with the Board showing through above.
- **The command bar moves you, not just to steps:** projects and views by name, in the same box that finds a step
  (D4, Aiden 2026-10-18).

### Details

A side panel over the page's right side: `--canvas-1`, a `--line-strong` left edge, `--z-sheet`, no scrim (the Board stays
usable beside it). 440 px wide from 1360 px, 380 px from 720 px. Under 720 px it covers the whole page area between the
HUD and the footer. It enters with a 320 ms clip-path wipe from the right; under reduced motion it appears.

Top to bottom:

1. **Head** (sticky): an Eyebrow `#482 · STEP` (the kind), **Copy #id** (ghost `sm`, "Copied" for 1.2 s), **×**
   (Close). The title under it in the body face at 1.125rem, 600, `--text-hi`, wrapping (today it cuts to one line).
2. **Meta row:** the Marker and the status as a Chip, the label Chip, who it is for (`YOU` as a `needs` Chip, or
   "Claude"), and "in #parent" as a link that opens the parent's Details.
3. **Parked** (when parked): a dashed panel, "Parked 12 Oct" in an Eyebrow, the reason, where, and **Unpark** (outline).
4. **Asks** (when any): each open ask in the Board's ask panel (§7): Eyebrow with kind and age, the raiser, the text,
   Answer… and Clear. Answered asks follow, muted, one line each: the text, "answered …", the age.
5. **The step:** the handoff Chip and hygiene Chips; the body as Markdown at 68ch; the outcome in a panel under an
   Eyebrow `[✓] OUTCOME`.
6. **Live work** (when any), under an Eyebrow `[◈] LIVE WORK`: working tasks with their marks, subagents (◇ for
   readers, the purpose under each), background commands in a terminal readout, then ended work, muted, per session.
   Today's 30 s refresh stands.
7. **Resources:** rows of title and mono summary, each opening the viewer.
8. **Steps:** the children, each a row with its Marker, `#id`, title and `YOU` where it applies, opening that child's
   Details.
9. **Log:** time in mono, the text, the session muted.
10. **Action strip** (sticky at the foot): **Park…** (outline, when today's rule allows it) and **Add a step** (ghost),
    each opening its form in the strip, and at the right `UPDATED 2M AGO` in mono dim. A failed refresh turns that line
    into an ErrorLine, "Couldn't refresh", with Retry; the last detail stays on screen, as today.

Every section head is an Eyebrow with its count (`// RESOURCES · 3`). Empty sections are left out, as today. Loading
shows the head with `#id` and a "Loading…" line; a failed load shows an ErrorLine with Retry.

**Keys and focus:** Esc closes Details (today's rule: not from a field), and focus returns to the tile or row that opened
it. Opening Details moves focus to its title. Tab stays in the page order: Details is not modal.

### The resource viewer

The whole window, `--canvas-1`, `--z-command`, modal (the window behind it is inert, as today).

- **Head:** an Eyebrow `R324 · HANDOFF` (id and kind), the title in the body face at 1.125rem, 600; at the right Copy,
  Open file, Copy path and Open link (outline `sm`, each only when it applies, as today), then ×.
- **Body:** Markdown at 68ch, centred, `--sp-8` padding, focused on open. Code blocks on `--canvas-0` in mono; tables
  with `--line` rules; headings in the body face at 600 (`h1` 1.5rem, `h2` 1.25rem, `h3` 1rem), never display or
  uppercase; links in `--text-hi` with a dotted underline that turns volt on hover. Today's sanitising rules stand.
- **States:** "Loading…", an ErrorLine, "File: <path>", the URL, "No content", as today. Copy and open results show in
  the Toast.
- Esc closes it and focus returns to its opener.

### The command bar

Opened by Ctrl K or `/` (outside a field), or by the HUD's Find. A panel 640 px wide at 15 % from the top, over a
`--scrim`, `--z-command`, with volt Frame corners; it enters with a 320 ms clip-path wipe from the top (a fade under
reduced motion). Under 720 px it spans the page width at the top. The window behind is inert while it is open.

- **Field:** an Eyebrow `[⌕] FIND`, the input at 1rem in the body face, placeholder "#id, a step's title, a project or a
  view".
- **Results**, grouped under Eyebrows:
  - **Steps:** today's search (`api.find`, 150 ms debounce, the newest request wins). A row: `#id`, the title, the
    project at the right in mono dim (archived marked), finished steps muted. Choosing one opens its Details, switching
    project first when needed, as today.
  - **Go to:** projects ("Open InThink") and the current project's views ("Board", "Project", "Backlog", "All done"),
    matched on the words typed. With nothing typed, Go to lists the views and the projects in rail order.
- **The highlighted row** is volt-filled with ink text, the same mark as the current rail row.
- **Keys:** Up and Down move across both groups, Enter opens the highlighted row (or the first), Esc closes and returns
  focus to where it was, Tab stays inside the bar. Ctrl K inside the field is swallowed, as today.
- **Messages,** as today: "No step #N", "Couldn't search: …", "No step titles match", the count.
- **Foot:** KeyHints `↑↓` Move, `Enter` Open, `Esc` Close.
- Nothing in it writes (D4).

### Tests and review (#505)

- Rewritten (§12): the Details look tests (working tasks, the label chip and log, "wears Quiet"), GoTo's surface and note
  colour; GoTo's behaviour tests keep their keys and messages with the bar's selectors.
- New e2e tests: typing "backlog" in the command bar and Enter opens the Backlog view; Details' action strip opens Park
  without scrolling on a long step; at 400 px Details covers the page and Esc returns focus to its tile.
- Murr runs on Opus (focus, a modal, the keyboard: the risk list). Parvati reviews Details, the viewer and the bar at
  1600, 720 and 400, Details on a step with every section.

## 11. Narrow (400 px)

*Status: written under Aiden's standing approval (2026-10-18).* Each surface section says what it does under 720 px; this
section only gathers the rules they share, so Parvati's 400 px pass has one list.

- **Shell:** the HUD at 48 px (wordmark, link, asks, Find); the rail as a strip under the ruler; the current project's
  views as a `segmented` TabStrip at the top of the page; the footer with the activity line only.
- **Side padding** `--sp-4`; `--sp-section` 24 px; display sizes step down (§2.5); content sizes do not.
- **One column everywhere.** Board order: Needs me, Now, Next, Done. Project view: no phase index, a jump row instead.
- **Overlays take the page:** Details and the viewer cover the page area; the command bar spans the top.
- **Hover actions show on focus too** (already the rule), and every row action stays reachable by Tab.
- **Nothing scrolls sideways** except the rail strip and a TabStrip that overflows.
- **Targets:** buttons stay at their `sm` 26 px height in rows and grow to 32 px (`md`) in the action strip and forms.

## 12. Tests and review per step

*Status: written under Aiden's standing approval (2026-10-18).*

The rule is the strategy's: the step that changes a value or a selector rewrites the assertion on it in the same branch.
Each ui step keeps the label's gates (typecheck, unit, one e2e test per user-visible feature), Murr on every diff, and
Parvati on every surface step at the widths its section names. Line numbers are `test/e2e/ui.spec.ts` on main at
7933a3f.

| Step | Rewrites | Adds |
|---|---|---|
| #497 split | `test/web/tokens.test.ts` (reads `web/src/styles/`), `test/scripts/deploy-lib.test.ts:84` (path) | none; the computed-style diff in the receipt |
| #498 Foundations | `tokens.test.ts` for one palette (§2.10); literal values in :1059, :1175, :1293 (becomes "dark whatever the OS theme"), :1433, :1526, :1910, :2236, :2245, :2273 | none |
| #499 parts | none | vitest for TabStrip keys, `cursorStep` and the Count rise; one e2e for the lab |
| #500 HUD | the activity strip's selectors | one e2e: ASKS sums and jumps, LINK shows reconnecting |
| #501 rail | `tabFor` (:378) and its 82 uses (`aria-current`); :151, :202, :481, :640, :681, :1059, :1175, :1293, :1345, :1854; :596 (tab-strip wheel) is deleted | one e2e: Backlog and All done from the rail |
| #502 Board | :1716, :1806 (positions at the new widths), :1778 (preview rows), :1910, :2236, :2555, :2584 | e2e: to tidy, Alt+Down in Next, More on the note, a note reference |
| #503 Project | the Project view's head selectors (`.ip-view-name`, :300, :410) | e2e: the phase index opens a section |
| #504 Backlog, All done | the Backlog view's and All done's selectors and their "‹ Board" steps | e2e: phase TabStrip and label Chip narrow the list |
| #505 Details, viewer, bar | :1433, :2245, :2273 (Details' look), :1526, :1573 (GoTo's look); GoTo's behaviour tests move to the bar | e2e: the bar opens a view, Details' action strip, Details at 400 |
| #506 docs | none | the final Parvati pass over every surface at 1600 and 400 |

Parallel steps (§13's waves) both touch `ui.spec.ts`. Each adds its tests in its own `test.describe` block near the end
of the file and rewrites only the tests in its row, so a merge conflict stays inside one block.

## 13. What supersedes what, and the build order

*Status: written under Aiden's standing approval (2026-10-18).*

### What the port supersedes (D5)

As the strategy recommends, recorded here and written as a ruling by #506 in `docs/superpowers/rulings/`:

- **Board spec section 2.8 Look** (`docs/superpowers/specs/2026-10-12-board-and-asks-design.md`): "InThink's look is not
  adopted" is reversed. Draft C's artboards stop being the reference for spacing and type; this spec and the mock are.
  The rest of 2.8 (who and when first, the task box as the Board's one skeleton, sessions wearing no character or hue)
  stands, restated in §7. The Next column's "Backlog · n ▸" and the header's "Project view ›" give way to §6 and §7.
- **Quiet restyle sections 1 to 3** (`docs/superpowers/specs/2026-10-05-quiet-restyle-design.md`): its tokens, both
  themes, its fonts and type, its chrome (tabs, hairline, activity strip) and its card styling are replaced by §2 to §7.
  Its behaviour rules that are not about the look stand.
- **The parked-steps spec's Board preview and full view** (`2026-10-17-parked-steps-and-loose-tasks-design.md`) keep
  their rules; their look, the phase select and the full view's "‹ Board" give way to §7 and §9.
- #506 also adds a pointer at the head of each of those sections to this spec, updates the guide's screenshots and
  text, and checks that no Quiet token name is left (§2.10).

### Build order

The strategy's plan, with this spec's sections:

| Step | Builds | Spec | Needs |
|---|---|---|---|
| #497 | the sheet split | §3 | this spec |
| #498 | Foundations | §2 | #497 |
| #499 | shared parts and the lab | §4 | #498 |
| #500 | HUD bar and footer | §5 | #499 |
| #501 | module rail | §6 | #500 |
| #502 | Board | §7 | #499; #501 for the views' new links |
| #503 | Project view | §8 | #499 |
| #504 | Backlog view and All done | §9 | #499; #501, which makes them views |
| #505 | Details, viewer, command bar | §10 | #499 |
| #506 | docs, the ruling, guide screenshots, the final pass | §13 | #500 to #505 |

#497 to #499 run one after another. Then in waves of two, each in its own worktree: #500 with #503, then #501 with
#505, then #502 with #504 (both need the rail's views), then #506. The step that lands last among #500 to #505 deletes
the Quiet aliases (§2.10).

**Done for the phase:** every surface in v3 on main; no Quiet token value or name left; the fonts bundled and served
offline; reduced motion keeps every surface usable; every surface works at 400 px; the guide shows the new window.
