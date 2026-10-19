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

*Status: awaiting approval.*

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

*Status: awaiting approval.*

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
| D1 | Light theme | Drop Quiet's light palette; the window ignores the OS theme | §2 | open |
| D2 | Counts in the rail | Keep the volt ask count on each project row, against InThink's rail rule | §6 | open |
| D3 | Step hues | The seven hues become faction colours on each tile's top rule | §2 | open |
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
