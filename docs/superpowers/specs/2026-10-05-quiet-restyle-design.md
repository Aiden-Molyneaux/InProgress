# Quiet restyle: the window's new look

Date: 2026-10-05. Status: approved by Aiden on 2026-10-05, section by section.

This note extends the InProgress design spec (`2026-09-27-inprogress-design.md`) and amends the review-actions note
(`2026-10-04-review-actions-design.md`; see "Amendments to the review-actions note"). Tracked in the `inprogress`
project as #81. This spec is step #169.

- **Target look.** The artboard `.superpowers/iter/2026-10-02/mockups/project/Take-quiet.dc.html`, with the hue order
  and kin placement of `Quiet-kin-together.dc.html` beside it. The two differ only in the family hues and the kin's
  run time.
- **Canvas.** https://claude.ai/artifact/4KakEu3amBareLHJyCdB6p, page "New window: takes".
- **Working notes.** `.superpowers/iter/2026-10-05/quiet/approaches.md` (the outline, checked against the code at
  `344cdcd`), with `decisions.md`, `quiet-report.md` and the four maps beside it (`map-chrome.md`, `map-rows.md`,
  `map-layout.md`, `map-tokens.md`).
- **Where these live.** `.superpowers/` is gitignored (`.gitignore:7`), so the artboards, the working notes, the maps
  and `contrast.mjs` exist only in the main checkout, under `C:/personal/InProgress/.superpowers/`. A worktree reads
  them there.

`T<n>` is the test that starts at line n of `test/e2e/ui.spec.ts`, and `l.<n>` an assertion's own line. File line
numbers are at `344cdcd`. "Day" is light mode, "night" is dark mode.

## Goal

Quiet replaces today's look in one deploy, so Aiden can use it and adjust it. In his words: "I think I need to use it
in practice to feel what it is."

Quiet keeps what the window means and draws it with less: ink, muted text and one hairline. Orange marks only the
active path, amber only attention, and family hues only characters, letters and tags. Simple characters are the only
coloured, moving things. A step's agents and tasks draw inside its card. Phases become lanes.

## Non-goals

- No switch between looks. A rollback brings today's look back.
- No dashboard, and nothing else from the Now or Whiteboard takes.
- No characters in Details this round. Details lists agents as text lines.
- No change to the server, the briefing, the hooks or the data model. Only the window changes, and no session
  restarts.
- No taskbar icon (#82). The favicon keeps its clay (`web/index.html:7`).

## Aiden's decisions (2026-10-05)

1. Quiet is the take. It ships all at once, replacing today's look. He lives with it, then adjusts it.
2. The theme follows Windows: Quiet's night in dark mode, Quiet's derived day in light mode.
3. The fonts are Inter and DM Mono, bundled with the app. No network fonts.
4. Waiting for permission is Simple's amber ring, not today's red outline.
5. Family hues are reordered: slot 0 teal, 1 clay, 2 green, 3 rose, 4 brown, 5 indigo.
6. The structure is approach A (approaches.md 1.1). B and C are rejected.
7. Tokens and fonts are as approaches.md 2.1.
8. Chrome is as approaches.md 2.2: letter-only chips with a popover on hover and keyboard focus, chips in letter order,
   the `UP NEXT` head in an 82 px left column, the session row wrapping to a second line only when chips overflow,
   and 2 px ink focus rings (`--text-2`, the artboard's `ink2`, as approaches.md 2.2 has them).
9. Canvas cards and rows are as approaches.md 2.3, with two answers:
   - **Kin with the lead.** An agent line reads `[lead] c10 18m c11 · C · #5 UI Session post-Fable · working`. He
     compared both orders on two drawn frames and picked this one. The line's accessible name still leads with the
     letter.
   - **Running kin show their elapsed time** on the canvas, in muted DM Mono after the tag (`c10 18m`). Ended kin show
     no time.
   - The rest of 2.3 stands. A worker's description, model and purpose are in its kin's tooltip and accessible name.
     Past six kin, a `+n`. The done row sits at the right end of the last agent or readers line. A click anywhere on a
     card opens Details. Resource chips stay beside cards from 720 px.
   - **A crowded line.** When the card's last line is an agent line that holds kin, the done row takes a 20 px line of
     its own instead (his answer on the spec, 2026-10-05). Layout knows this in advance, so heights stay exact.
10. The Simple character is as approaches.md 2.4.
11. Layout and camera are as approaches.md 2.5.
12. Details is as approaches.md 2.6.
13. Tests and rollout are as approaches.md 2.7 and 2.8, with the seven-task plan of its section 5. The branch amends the
    review-actions note for D1, D3, D4, D5, D7, D8, D9 and D16 (D16 added on the spec, 2026-10-05).
14. Departures D1 to D18 ship as listed below, D5 as kin with the lead.

## Architecture

### Approach A: each card renders its own lines

- **Layout stays the only geometry.** `src/core/layout.ts` keeps emitting row items in today's order, each with its
  absolute `y`, so the unit tests keep their kinds, order and counts. It merges `badge` and `agent` into one `line`
  item per (session, card), puts the done row on the last line (or its own line after a line with kin), gives `LayoutNodeItem` an `h` and a `w`, and adds the
  `stack` and `workingFocus` flags and a `LayoutResult.lanes` array.
- **Canvas** turns only `node`, `more` and lane items into React Flow nodes. It groups row items by `nodeId` into
  their card's data and resolves them as `toNode` does today (`Canvas.tsx:150-196`). Cards and lanes get explicit
  `width` and `height` from layout, so React Flow never hides them for want of a measurement.
- **NodeCard** renders the frame `div.ip-card`, the header `div.ip-node[role=button]` with every hook it has today,
  and `div.ip-lines`. The lines sit outside the `role=button`, so the card's accessible name and every `.ip-node`
  `hasText` locator stay as they are.
- **One source for the pitch.** Layout exports the heights. Canvas writes them as CSS custom properties on
  `.ip-canvas`. The CSS heights read the variables, and a unit test fails on a literal height in those rules.

Why A. The camera reads only layout (`useCamera.ts:20, 71, 103`, `sheet.ts:25`, `breadcrumb.ts:7`), so Follow,
`rowInView`, the breadcrumb and the 3 px camera tests keep their meaning. `expectLifted` (`ui.spec.ts:157-165`)
measures the `.ip-node` box, which stays a fixed header centred on `item.y + NODE_H / 2`. A new task row appears inside
a card already on screen, which lowers the blink risk T377 guards. Everything Quiet changes about a card (shared lines,
the frame's state, the edge's start point, clicks over the whole card) is markup inside one node.

### Rejected

- **B: rows stay React Flow nodes over a frame node.** The frame copies the card's state out of `NodeCardData`, and
  shared lines become overlapping nodes with pointer-event tricks. In practice the agent line becomes one node, which
  is A in miniature with more glue.
- **C: the whole outline as one flowed node, with the camera reading the DOM.** It rewrites the camera contract the
  3 px tests rest on and moves those checks from unit to e2e. One huge node re-renders on every snapshot and tick, and
  a height change above the target moves it during a glide.

Not built either: A with the card's DOM height fed back into layout. Layout would lag the DOM by a ResizeObserver
tick, `expectLifted` would flake while heights settle, and a re-layout that replaces node objects risks the blink.

## 1. Tokens and fonts

Files: `web/src/styles.css` (`:root`, the dark block, `body`, the reduced-motion block, every `font-size` and
`font-weight`, and every use of a renamed or removed token), `Canvas.tsx:237` (one token), `web/src/main.tsx`,
`package.json`, `package-lock.json`, `web/vite.config.ts` (only if a font would inline), `web/src/family.ts` (comment
only), `test/web/family.test.ts`.

### Theme

Keep `color-scheme: light dark` and the one `@media (prefers-color-scheme: dark)` block. `:root` takes the day values
and the dark block the night values, about 35 declarations where today has 11. The Edge `--app` window follows Edge's
appearance setting, which defaults to the Windows theme. React Flow keeps `colorMode="system"` (`Canvas.tsx:363`,
T284 l.287).

### Neutrals and surfaces

| Token | Artboard name | Day | Night | Used for |
|---|---|---|---|---|
| `--bg` | `bg` | `#f8fafc` | `#080d1c` | page and canvas ground; character eyes; ink on filled marks |
| `--text` | `ink` | `#0f172a` | `#f1f5f9` | current tab and its underline; the working focus's title; in-progress subjects |
| `--text-2` (new) | `ink2` | `#1e293b` | `#e2e8f0` | card titles, Up next steps, Follow on, activity actor and event, tab dot, focus rings, unowned queue numeral |
| `--muted` | `muted` | `#475569` | `#94a3b8` | secondary text, counts, separators, heads |
| `--faint` | `faint` | `#64748b` | `#64748b` | todo ring, stale `○` |
| `--border` | `line` | `rgba(15,23,42,.11)` | `rgba(255,255,255,.09)` | every 1 px rule and hairline; edges |
| `--bar` (new) | `bar` | `#ffffff` | `rgba(255,255,255,.018)` | tab bar, session row, Up next, activity strip |
| `--card` (new) | `card` | `#ffffff` | `rgba(255,255,255,.035)` | card fill |
| `--active-fill` (new) | `cardOn` | `#fffaf6` | `rgba(249,115,22,.045)` | the working focus's card |
| `--lane` (new) | `lane` | `rgba(15,23,42,.018)` | `rgba(255,255,255,.022)` | phase lanes |
| `--float` (new) | `float` | `rgba(248,250,252,.94)` | `rgba(8,13,28,.92)` | crumb, zoom buttons, chip popover, archived menu |
| `--panel` (kept, overlays) | A's sheet | `#ffffff` | `#0c1227` | Details, the resource viewer and its header |
| `--shadow` | A's sheet | `0 8px 24px rgba(15,23,42,.16)` | `0 8px 24px rgba(0,0,0,.55)` | Details and the viewer only |
| `--panel-2` (kept) | none | open | open | hover fills, code blocks |
| `--track` (new) | `track` | `rgba(15,23,42,.08)` | `rgba(255,255,255,.08)` | a stack head's track |
| `--track-fill` (new) | `trackFill` | `rgba(71,85,105,.5)` | `rgba(148,163,184,.55)` | its filled part |

`--panel-2` has no Quiet value. The implementer sets a faint tint whose alpha stays below `--border`'s; map-tokens.md
decision 9 proposes `rgba(15,23,42,.05)` day and `rgba(255,255,255,.06)` night. `body` keeps painting `--bg`: the
night `--bar` only reads over it.

### Accents and attention

| Token | Artboard name | Day | Night | Used for |
|---|---|---|---|---|
| `--active` (renames `--accent`) | `orangeMark` | `#c2410c` | `#f97316` | the active marker |
| `--active-ink` (new) | `orangeText` | `#c2410c` | `#fb923c` | `◐` |
| `--active-line` (new) | `orangeLine` | `rgba(234,88,12,.55)` | `rgba(249,115,22,.5)` | the working focus's hairline |
| `--sky` (new) | `sky` | `#0284c7` | `#38bdf8` | the paused ring |
| `--link` (new) | none | `#0369a1` | `#38bdf8` | links in Details, the viewer and Markdown |
| `--amber` | `amberMark` | `#d97706` | `#fbbf24` | needs-you dot, need-pill dot, permission ring, flash ring, reconnecting banner |
| `--amber-ink` | `amberText` | `#92400e` | `#fcd34d` | `YOU`, `need you`, `needs permission` |
| `--amber-fill` (new) | `amberFill` | `rgba(251,191,36,.18)` | `rgba(251,191,36,.12)` | the `YOU` tag, the permission ring's fill |
| `--red` | none | `#b91c1c` | `#f87171` | the blocked marker and word only |
| `--gone` (new) | `fam.gone` | `#64748b` | `#94a3b8` | an ended character |

- `--link` exists because day sky is 4.10:1 on white: enough for a ring, not for link text. `#0369a1` is about 5.9:1.
- `--amber-fill` replaces the four inline `color-mix(… 14%)` fills (`styles.css:61, 71, 147, 213`) and the artboard's
  separate ring fill.
- Red: 6.18:1 by day, 7.00:1 by night. Permission no longer uses it.

### Family hues

| Slot | Letter | Hue | Day | Night |
|---|---|---|---|---|
| 0 | A | teal | `#0b6b7d` | `#3cc3d6` |
| 1 | B | clay | `#b4532f` | `#e8956f` |
| 2 | C | green | `#287a3a` | `#7ad68f` |
| 3 | D | rose | `#b0204f` | `#f27aa5` |
| 4 | E | brown | `#85593a` | `#d4a574` |
| 5 | F | indigo | `#4f4dc4` | `#9a98ff` |

- Literals in `:root` (day) and in the dark block (night). Every hue passes 4.5:1 as text in both themes
  (map-tokens.md §7).
- `familyVar` and `FAMILY_COUNT` (6) are unchanged. A null slot now wears teal. Fix the "session clay" comments in
  `family.ts:1, 6`.
- Text on a filled hue uses the ground colour, never white.

### Theme-free tokens

| Token | Value |
|---|---|
| `--radius` | `8px` |
| `--hairline` | `linear-gradient(97deg, #6366f1, #ff6600)` |
| `--font-sans` | `'Inter', system-ui, 'Segoe UI', 'Segoe UI Symbol', sans-serif` |
| `--font-mono` | `'DM Mono', ui-monospace, 'Cascadia Code', Consolas, monospace` |
| `--fs-l`, `--fs-m`, `--fs-s` | `15px`, `12.5px`, `11px` |
| `--w-text`, `--w-heavy` | `500`, `900` |
| `--track-l` | `-0.05em` |

### Removed

- `--accent`. It is renamed to `--active`, so a missed use shows as unset instead of turning silently orange.
- `--edge`, also read inline at `Canvas.tsx:237`. Edges use `--border`.
- `--green`, `--purple` and `--clay`. `var(--fam, var(--clay))` fallbacks become `var(--fam, var(--family-0))`.
- Hard-coded `#fff` ink on markers and pills becomes `var(--bg)`. The reconnecting banner keeps `#000` on amber.
- Task 1 re-points every use of these tokens in wave 0, in every region and at `Canvas.tsx:237`, to the token this
  spec names for that use: `styles.css:138` to `--active`, `:146` to `--sky`, `:169` to `--text-2`, and so on. Where Quiet
  drops the rule (the 2 px active border, a green or purple fill), it points at the nearest of `--active`, `--muted`
  and `--family-0`, and the owning task removes the rule later. So no build on the branch reads a removed token, and
  the colour pins Task 1 moves pass in today's markup.

### Fonts

- `npm i -D @fontsource/inter@^5.3.0 @fontsource/dm-mono@^5.3.0` (both OFL-1.1). They are devDependencies, like
  `react`, because Vite bundles them.
- In `main.tsx`, after the React Flow stylesheet import, import `@fontsource/inter/latin-500.css`,
  `@fontsource/inter/latin-900.css` and `@fontsource/dm-mono/latin-500.css`. Check the file names after install.
- Vite emits hashed `woff2` and `woff` files into `web/dist/assets/`. They are served from the same origin, under the
  CSP `default-src 'self'` (`src/server/routes/ui.ts:18`, pinned at `test/server/app.test.ts:441`).
- Never let a font inline as `data:`. The CSP would block it and the `consoleErrors` fixture would fail every e2e.
  The latin files are over Vite's 4 KB inline limit. If a broader subset is ever imported, add
  `assetsInlineLimit: (f) => (/\.woff2?$/.test(f) ? false : undefined)` to `web/vite.config.ts`. Do not add `data:`
  to the CSP.
- The latin files carry no `unicode-range`, so the Inter face claims every code point. Glyphs Inter lacks (`◐ ○ ✓ ◇
  ◆ ① ⧉ ⚙ ⛁ ▤ ▸ ▾` and the rest) fall through per glyph to the rest of the stack, as today, so the stack keeps its
  fallbacks after `'Inter'`. Adding a `unicode-range` would change nothing here. The `⛁` size tweak stays.

### Type

- `body`: `500 12.5px/1.4 var(--font-sans)` with `font-variant-emoji: text`, as the artboard's root.
- **L**: 15 px, 900, line 20 px, `letter-spacing: var(--track-l)`, `word-spacing: .05em`.
- **M**: 12.5 px, 500, line 18 px.
- **S**: 11 px, 500, line 14 px.
- **Mono**: DM Mono 500 at S, for `#id`s, counts, tags, times, `▤ n`, `n/m` and `+n`.
- Every `font-size` in `styles.css` becomes L, M or S. Every 600, 700 and 800 becomes 500 or 900 (21 rules:
  `:54 :61 :64 :69 :71 :79 :82 :91 :103 :105 :127 :135 :147 :148 :158 :169 :173 :176 :190 :212 :228`). Every `<b>`
  (`Details.tsx:196, 216, 241, 249`, `ResourceViewer.tsx:45`) and Markdown `strong` gets an explicit 500 or 900. With
  only 500 and 900 loaded, any weight above 500 renders as Inter Black.
- No italic face ships. The Details log drops its italic. The archived tab name and Markdown `em` render as Edge's
  synthetic oblique.

### Motion

- `ip-pulse` keeps its name (T824 l.834 and T1086 l.1115 pin it): opacity 1, .35, 1 over 1.6 s ease-in-out (today .3).
  Its keyframes sit in the chrome region (`:116`); Task 1 edits them.
- New keyframes:
  - `ip-bob`: `translateY(0) scale(1.04, .96)` at 0 and 100 %, `translateY(-14%) scale(.98, 1.02)` at 50 %.
  - `ip-blink`: `scaleY(1)` at 0, 91 and 100 %, `scaleY(.1)` at 94.5 %.
  - `ip-ring`: `scale(1)` at opacity .85, to `scale(1.45)` at opacity 0.
- Reduced motion: the selector list (`styles.css:240-244`) becomes one blanket rule,
  `* { animation: none !important; }`. Today's static flash ring (`:243`) moves out of that block into the canvas
  region, next to the flash rule, under its own reduced-motion query. Task 1 makes that move in wave 0, so T284 l.295
  holds on every build; Task 6 later moves the ring onto the frame with the flash. No later task edits the blanket
  block.

Hooks kept: the `ip-pulse` name, `--family-0` to `--family-5`, `familyVar`.

## 2. Chrome

Files: `web/src/chrome/TopBar.tsx`, `SessionRow.tsx`, `UpNext.tsx`, `ActivityStrip.tsx`, the chrome rules in
`styles.css` (`:48-118`). `tabs.ts` and `App.tsx` are unchanged.

Heights: hairline 3, tabs 38, session row 40 on one line, Up next 8 + 20 per line + 8, activity 32. With three
sessions the canvas gains about 45 px, mostly from the one-line session row.

### Top hairline

`.ip-app::before { content: ''; flex: none; height: 3px; background: var(--hairline); }`. `.ip-app` is already a flex
column. The hairline sits outside `.ip-topbar`, so T270 l.280 and T938 l.954 measure the 38 px bar alone.

### Tabs

- `.ip-topbar`: 38 px, `padding: 0 6px 0 0`, `--bar`, a 1 px `--border` bottom rule.
- `.ip-tab`: `padding: 0 12px`, gap 7, M on every tab (the current one drops from 600), `--muted`. Current and hover:
  `--text`.
- Underline: drop the tab's `border-bottom`. Draw `.ip-tab[aria-selected='true']::after` at `left: 12px; right: 12px;
  bottom: -1px; height: 2px; background: var(--text)`. `::before` stays the separator, inset 13 px, `--border`.
- `.ip-tab-count`: DM Mono S, `--muted`. No border, fill, radius, padding or minimum width.
- `.ip-tab-dot`: 6 px, `--text-2`, `ip-pulse`.
- `.ip-tab-name`: the 160 px cap with an ellipsis on every tab, the current one too (T270 l.281).
- The archive button `⋯`: 30 × 26 px, radius 8, `--muted`, L.
- Fix the comment at `TopBar.tsx:15` ("amber count", "clay dot").

### Session row

- `.ip-sessions`: `min-height: 40px`, `padding: 0 12px 0 8px`, gap 4, `--bar`, a 1 px `--border` bottom rule. The
  chips wrap to a second line only when they overflow. The pill and Follow stay at the right end of the first line
  (T1028 l.1041-1043).
- Chip `button.ip-chip-s`: no border and no fill in any state, 30 px tall, `padding: 0 8px`, gap 6, radius 8, M,
  `--muted`. It holds the 18 px character (section 4), then the letter `.ip-tag` at 900 in `var(--fam)`.
- Running workers (Aiden, 2026-10-07: an idle session's working subagent was invisible in the row). After the letter,
  `span.ip-chip-kin[aria-hidden]` draws a 14 px `work` character per worker that still runs, in `var(--fam)`, seeded
  `${sessionId}:${agentId}` so each bobs in its own phase. `chipKin` (`chips.ts`) picks them: running only, readers
  and every stopped worker (the usage limit too) left out, in the session's order, at most three, then a muted
  `.ip-chip-more` `+n` in DM Mono S. No tags or times: those stay in the popover and on the cards. The session's own
  character keeps its state, and the name and the popover do not change.
- A session waiting for permission adds a muted `·` and `needs permission` in `--amber-ink`, and its character wears
  the amber ring. Working and idle add no word: the character carries the state.
- Name: `aria-label={withTag(letter, chipLabel(s))}`. Examples: `A · #4 Implement Fable's Notes · needs permission`,
  `C · #5 UI Session post-Fable · 3 subagents`, `B · #2 InProgress Dev Session · idle`. `chipLabel` is unchanged
  (`live.ts:59-62`). A new helper in `live.ts` builds the name.
- Order: chips sort by slot, so by letter. Where a session with no slot yet sorts is the implementer's call, after
  the lettered chips.
- Removed: the chip's `.ip-pulse` (`SessionRow.tsx:43`), `.ip-chip-label` (l.51), the ` · ` in `.ip-chip-lead`, the
  working fill (`styles.css:111`) and the red permission rules (`:112-114`). The `.ip-badge` half of `:114` goes with
  the canvas task.
- `.ip-tag` goes from 700 to 900. The canvas agent line and readers line share it.

### Chip popover

- `div.ip-chip-pop[role=tooltip]` renders for every chip, not only chips with subagents. It shows on hover of the
  chip's wrap and on keyboard focus of the chip.
- Every chip has `aria-describedby` pointing at it and no native `title`. A native tooltip never shows on keyboard
  focus (T1356 l.1371-1377), and the popover is now the one place in the row that shows a session's title.
- Content unchanged: the head line `withTag(letter, `${label} · ${where}`)`, then one `li` per subagent.
- Look: `--float`, a 1 px `--border`, radius 8, no shadow. Head S `--muted`. Rows M `--text-2`. The tag
  `.ip-agent-tag` in DM Mono S in `var(--fam)`. The reader mark `◇` in `--muted`. Ended rows `--muted`.

### Need pill and Follow

- Both are 26 px tall, `padding: 0 10px`, radius 8, a 1 px `--border`, transparent, M.
- `button.ip-need`: text `--amber-ink`. The literal `●` becomes `<span aria-hidden="true" class="ip-need-dot">`, a
  6 px `--amber` dot, gap 6. The text reads `1 need you`.
- `button.ip-follow`: `<span aria-hidden="true">⌖</span> Follow`, `margin-left: 6px`. Off: `--muted`. On (`.on`,
  `aria-pressed="true"`): `--text-2` with a 1 px ink (`--text`) border.

### Up next

- `div.ip-upnext`: `display: flex; align-items: flex-start; padding: 8px 12px`, `--bar`, a 1 px `--border` bottom
  rule.
- `.ip-upnext-head`: `flex: none; width: 82px; height: 20px`, S at 900, `letter-spacing: .14em`,
  `text-transform: uppercase`, `--muted`. Its DOM text stays `Up next` (T1259 l.1277).
- The lines go in a new `div.ip-upnext-lines` (`flex: 1; min-width: 0`). Each `.ip-upnext-line` is 20 px: a block
  with `white-space: nowrap; overflow: hidden; text-overflow: ellipsis` and inline children. It is not the artboard's
  flex row, which never reports itself cut (T1259 l.1282-1283).
- `.ip-upnext-lead`: `display: inline-block; width: 36px`, M. Owned: 900 in `var(--fam)`. `later`: 500 `--muted`.
- Each `span.ip-upnext-item[role=button]` gets inner spans: the numeral `--muted`, the `#id` in DM Mono `--muted`, the
  title `--text-2`. The ` · ` between items is a `--muted` span, about 8 px each side of the dot as the artboard
  draws it, literal spaces included.
- The literal spaces in `① #82 Title` stay, so line texts and item names do not change.
- Hover is a neutral change of the implementer's choosing, never blue or orange. Focus is the 2 px `--text-2` ring.

### Activity strip

- `.ip-activity`: 32 px, `padding: 0 12px`, a flex row centred with gap 6, `--bar`, a 1 px `--border` top rule, M
  `--muted`.
- `↳` (`aria-hidden`) and the `·` separators `--muted`. The actor `--text-2`. The time DM Mono S `--muted`. The event
  `--text-2`: the one part that shrinks, with an ellipsis.
- The copy is unchanged. The empty state stays one muted line.

### Not in the artboard

- **Archived menu** (`TopBar.tsx:133-152`, `styles.css:66-70`): `--float`, a 1 px `--border`, radius 8, no shadow.
  Rows `.ip-mi` radius 8 with a faint hover fill. Its `Archived` head takes the section-head style (S at 900,
  uppercase, `.14em`, `--muted`).
- **Reconnecting banner** (`App.tsx:109`, `styles.css:119`): keeps its solid `--amber` band with `#000` text. It is
  rare and must be seen.
- **Focus rings**: every blue ring (tabs `:58`, Up next `:109`, the done row `:197`, Details) becomes 2 px `--text-2`.
  The resource viewer's amber outline (`:238`) stays.
- **Empty and loading states**: `--muted` at the new body type.

Hooks kept: `.ip-app`, `.ip-topbar`, `.ip-tab`, `.ip-tab-name`, `.ip-tab-count`, `.ip-tab-dot`, `.ip-sessions`,
`.ip-chip-s`, `.ip-chip-pop`, `.ip-tag`, `.ip-need`, `.ip-follow`, `.ip-upnext`, `.ip-upnext-head`,
`.ip-upnext-line`, `.ip-upnext-lead`, `.ip-upnext-item`, `.ip-activity`, `.ip-mi`, `.ip-label`. Removed:
`.ip-chip-label` and the chip's `.ip-pulse`. New: `.ip-need-dot`, `.ip-upnext-lines`.

## 3. Canvas cards and rows

Files: `web/src/canvas/Canvas.tsx`, `NodeCard.tsx`, new `AgentLine.tsx` (replaces `BadgeNode.tsx` and
`AgentBadge.tsx`), `ReadersRow.tsx`, `WorkRow.tsx`, `WorkDoneRow.tsx`, `TrailAgentRow.tsx`, `MoreNode.tsx`, new
`LaneNode.tsx`, the canvas rules in `styles.css` (`:121-198`). The row components become plain components that take
props instead of `NodeProps`. `nodeTypes` (`Canvas.tsx:39-48`) keeps `ipNode` and `ipMore`, adds `ipLane`, and drops
`ipBadge`, `ipAgent`, `ipReaders`, `ipWork`, `ipWorkDone` and `ipTrailAgent`.

### The card

- DOM: `div.ip-row` stays the node's root and holds the handles. Inside it, the frame `div.ip-card` holds the header
  `div.ip-node[role=button]` and then `div.ip-lines`. From 720 px the resource chips sit beside the frame, outside it.
- Frame: a 1 px `--border`, radius 8, `--card`, its height and width from layout (`h`, `w`). It pads
  `0 12px 0 4px`, plus 8 px (`CARD_PAD`) under the last line on a card that has lines.
- Done cards: no fill. The working focus (`workingFocus`): a 1 px `--active-line` border and `--active-fill`.
- Todo cards draw at full opacity. The `opacity: 0.75` rule (`:130`) goes.
- Needs-you cards lose the 2 px amber border (`:129`). Active cards lose the 2 px blue border (`:128`).
- Dropped cards keep today's strike-through and muted title. Their fill is the implementer's call: done's none, or
  `--card`.
- The frame draws the selected ring (in `--text-2` where today's is blue) and the amber flash ring (`ip-flash`).
- The state classes (`st-*`, `needs-you`, `working`, `paused`, `flash`, `selected`, `root`) stay on `.ip-node`, where
  the e2e finds them. The frame takes its look from them, through `:has()` or classes NodeCard sets on both. The
  mechanism is the implementer's.

### The header

- `.ip-node` is 30 px tall inside the frame's 1 px border, so a one-line card is 32 px (`NODE_H`). Its middle is at
  `item.y + 16`, where the camera aims.
- A 22 px left column holds the marker, right-aligned, then a gap of 8. Every card has the column, so all titles
  align. Tags up to four characters overflow into the 4 px padding.
- `.ip-title`: M `--text-2`, cut with an ellipsis. Done: `--muted`. The working focus: L `--text`.
- After the title, with no boxes:
  - the type glyph `.ip-type`, directly after `.ip-title` (T247 l.258), M `--muted`, `font-variant-emoji: text`;
  - `▤ n` (`.ip-res-count`, below 720 px): DM Mono S `--muted`, no purple;
  - `YOU` or `YOU · 4d` (`.ip-you`): 18 px tall, `padding: 0 6px`, radius 8, `--amber-fill`, `--amber-ink`, S at 900,
    line 18 px, `letter-spacing: .04em`;
  - `blocked` (`.ip-blocked`): `--red`;
  - `n/m` (`.ip-progress`): DM Mono S `--muted`;
  - the chevron `.ip-chevron`: 16 px wide, S `--muted`.

### Markers

The marker moves into the shared `Marker.tsx` (section 4). It keeps `span.ip-marker.m-<status>` (T284 l.289, T465
l.476-477 and l.484).

| Status | Mark |
|---|---|
| todo | 9 px ring, 1.5 px `--faint` |
| active | 8 px `--active` dot. It pulses on every `.working` card, as today |
| paused | 9 px ring, 1.5 px `--sky`, no fill. Its tooltip stays `Nobody is on this. Last change …` |
| needs you | 8 px `--amber` dot |
| done | `✓`, S `--muted`, 9 px wide |
| question | 13 px `--muted` disc, `?` in `var(--bg)`, S at 900. A done question keeps the `?` |
| blocked | `--red` dot |
| dropped | `--faint` dot, as today |

### The agent line

One `div.ip-badge` per session per card, from the layout's `line` item. It is 28 px tall (`AGENT_LINE`) whatever the
lead's size, a single flex row with `white-space: nowrap`, and `padding-left: 6px` inside the frame's 4 px.

Left to right, as `Quiet-kin-together.dc.html` draws #127:

1. **The lead**: the session's character, 20 px, or 24 px while working. It draws inside the 28 px line, so a card
   never changes height when its session flips between working and idle. Its `title` is
   `C · #5 UI Session post-Fable · working · 3 subagents`, the count taken as `BadgeNode.tsx:17` takes it today. The
   lead's box is the implementer's call: fixed at 24 px (the kin and label then never move sideways on a flip), or the
   character's size.
2. **The kin**, each with `margin-left: 8px`, in `agentIds` order.
3. **The label**, `margin-left: 12px`: the letter (`.ip-tag`, 900, `var(--fam)`), ` · `, the session's title
   (`--text-2`, cut), ` · `, the state word (`--muted`; `needs permission` in `--amber-ink`). The separators are
   `--muted`, about 4 px each side of the `·` as the artboard draws them. Literal spaces around each `·` can supply
   that gap, and they keep the label's text as `C · #5 UI Session post-Fable · working`.
4. **The done row**, when this is the card's last line and holds no kin, at the right end (`margin-left: auto`).
   When the card's last line holds kin, the done row takes its own 20 px line below it.

Aiden's shorthand puts a `·` between the last kin and the letter. The frame he picked draws a 12 px gap there and no
dot. Follow the frame.

**Accessible name.** The line is `role="group"` with an `aria-label` that leads with the letter. On a lead's line it
is the label's text, `C · #5 UI Session post-Fable · working`, although the kin draw before it.

**A line without a lead.** A session's workers on a card that is not its focus get a line led by the letter alone
(`.ip-tag`, 900, hue), then their kin, with no label. Its name starts with the letter. The rest of the name is the
implementer's.

### Kin

One `span.ip-agent` per shown worker. Readers never get a kin.

- `role="img"`, `display: inline-flex; align-items: center; gap: 3px`.
- Children: the 16 px character (`work` while the worker runs, `ended` once it stops), then the tag
  (`.ip-agent-tag`, DM Mono S, `var(--fam)`), then, while it runs, its run time (new `.ip-agent-time`, DM Mono S,
  `--muted`).
- An ended kin keeps the class `.ended` (T1142 l.1198). Its colour and tag go `--muted` (T1142 l.1199 reads
  `rgb(71, 85, 105)`), its character `--gone`, and it shows no time.
- `aria-label` and `title`: `withTag(tag, agentLine(agent, now, nodeId))`, then a newline and the purpose when there
  is one. Example: `c10 · Draft the whiteboard take · opus-5-5 · 18 min`, then `You draft the whiteboard take of the
  InProgress window.` A new `kinTitle` helper in `live.ts` builds it.
- A worker with no ordinal yet draws its character and time with no tag.
- Shown kin: the non-reader subagents homed on this card that are running, plus those that stopped less than
  `ENDED_AGENT_MS` (5 min) ago, as today's badges.
- Past six kin, a muted `+n` in DM Mono S follows the sixth. Its tooltip lists the hidden kin, in wording of the
  implementer's choosing.

### Run time

- The form is `18m`: the minutes `elapsed` already computes (`live.ts`), compact. A new helper sits beside `elapsed`
  in `live.ts`, with unit cases. Under a minute and past an hour the implementer picks the form: no spaces, at most
  five characters.
- It updates on the canvas clock (`CLOCK_MS`, 30 s, `Canvas.tsx:37`). The tooltip and name update with it.

### Width, and what cuts on a narrow card

- DM Mono S advances about 6.6 px a character. A kin with a three-character tag is about 47 px (8 margin, 16
  character, 3 gap, 20 tag). A running kin's time adds 3 px of gap and about 20 px for `18m`, or about 30 px for a
  four-character time. When a time gains a digit (`9m` to `10m`), the line gives the title 6.6 px less.
- The line's height never changes: it is one row of fixed height.
- The session's title shrinks first. It cuts with an ellipsis, down to nothing.
- A done row only shares a line that holds no kin (section 3, The agent line), so it rarely runs short of room. As a
  fallback, its label cuts next, with an ellipsis, and only once the title is gone. The label sits in its own span
  inside the button, so the `✓` and the `▸` or `▾` stay. Its text, `title` and name are unchanged. A much larger
  `flex-shrink` on the title is one way to order the two.
- The lead, the kin (character, tag and time), `+n`, the letter, the separators and the state word are `flex: none`.
  None of them cut.
- Room on a line at 520 px: card width less the 2 px border, 4 px and 12 px of padding and the line's 6 px. That is
  426 px at depth 2 (`w` 450) and 398 px at depth 3 (`w` 422). #127's line spends about 24 + 70 + 47 + 12 = 153 px
  before the label.
- A done row needs about 116 px for `✓ 5 done · 2 agents ▸` and 184 px for `✓ 4 done · 1 unfinished · 9 agents ▸`,
  padding included (measured on fallback fonts; Inter runs a little wider). `trailLabel` adds `· n unfinished ·
  n agents`, so long done rows are common. With two running kin, a depth-3 line would need about 434 px against 398.
  That is why the done row takes its own line when the last line holds kin (Aiden, on the spec). The artboard never
  draws kin and a done row on one line either.
- Six running kin with times overflow every line at 520 px. See Risks.

### Readers line and done row

- `.ip-readers` (20 px, `READERS_LINE`): copy and DOM unchanged (`◇ c · 2 reading`); its `title` lists the readers.
  S `--muted`, no box, indented past the lead (the artboard's `padding-left: 38px`). Only the letter
  (`.ip-readers .ip-tag`) is in `var(--fam)`, at 900.
- `button.ip-work-done[aria-expanded]`: on the card's last agent or readers line, at its right end
  (`margin-left: auto; padding-left: 6px`), when that line holds no kin. When the last line holds kin, or there is no
  such line, it takes a 20 px line of its own inside the frame. Layout decides which from the `line` item's
  `agentIds`, gives the done row its `y`, and adds height only for a line of its own.
- The done row is 20 px, S `--muted`, no box. The `✓`, the `trailLabel` text, the `▸` and `▾` from `::after`, the
  `title` and the `work:<nodeId>` fold key are unchanged. It stops click propagation (`WorkDoneRow.tsx:35`). Opened,
  its tasks and trail rows follow inside the frame.
- It counts every session's tasks and the trail, though it sits on one session's line (D13).

### Task rows

- `div.ip-work`: 22 px (`TASK_ROW`), no box, gap 8.
- Children, in order:
  - a new `.ip-work-col`, the 22 px left column, right-aligned. It holds `.ip-work-tag` (DM Mono S, `var(--fam)`) on a
    subagent's row and is empty otherwise.
  - `.ip-work-mark`, 12 px wide, M: `◐` in `--active-ink`, pulsing (`ip-pulse`) when the row pulses; `○` `--muted`; a
    stale `○` `--faint`; `✓` `--muted`.
  - `.ip-work-agent`, the 3 × 12 px hue bar with `margin-left: -3px`, on the session's own rows only. A subagent's row
    has no bar and keeps an empty 3 px slot, so subjects align.
  - the subject, cut with an ellipsis: `--text` in progress, `--text-2` pending. Its `after` text is `--muted`.
- Scope these rules under `.ip-card`. Details' `.ip-wt` rows share `.ip-work-mark`, `-tag` and `-agent`
  (`Details.tsx:93-98`).
- Trail rows `.ip-trail-agent` stay neutral and keep `◆` in `--muted` (T1445 l.1489).

### Fold rows

`.ip-more` (`MoreNode.tsx`): 26 px tall, `padding: 0 12px`, gap 6, transparent, a 1 px dashed `--border`, radius 8, M
`--muted`, a `--muted` `✓`. Its width follows its content. Copy, names and `onExpand` are unchanged. Pitch:
`FOLD_ROW`, 36.

### Queue gutter

- `.ip-queue` stays inside `.ip-node` (T1259 and T1294 find it there). It is positioned absolutely into a fixed column
  at flow x 6 to 48: `left: calc(6px - var(--x))`, adjusted for the frame's border, `width: 42px`, right-aligned,
  centred on the header, L. NodeCard sets `--x` to the card's flow x.
- Owned (`.owned`): the letter and the numeral both in `var(--fam)`, the numeral 1 px after the letter. Unowned:
  `--text-2`.
- The text (`C①`) and the `title` (`Up next for C: 1`) are unchanged.

### Stack heads

- A depth-1 step of kind `phase` draws as `.ip-node.stack`: no frame, no fill. The marker, the title (L `--text`),
  `▤ n`, `n/m` and the chevron, gap 9, are centred in a 32 px box (`NODE_H`) at flow x 22, ending at 506. T571 lifts
  `Milestones`, a phase, with `expectLifted`.
- Its track: 2 px, `--track`, filled with `--track-fill` to done / total (`progress`, `tree.ts:65-69`). It runs from
  flow x 40 to 506, 33 px below the head box's top. A phase with no children has no track.
- The first row under the head starts 43 px below the head box's top. A session's line on the phase and the phase's
  done row sit there at flow x 56, unframed. The phase's children follow.

### Lanes

- `LaneNode` (`ipLane`): one per depth-1 phase, at flow x 8, 504 wide. It runs from 9 px above the head box to 12 px
  below the last row of the phase's subtree, with 18 px between lanes. A folded phase's lane holds only its head.
- `--lane` fill, radius 8, no border.
- `zIndex: -1`, explicit `width` and `height`, `selectable: false`, not focusable, and `style: { pointerEvents:
  'none' }` on the lane's node object. A class rule on `.react-flow__node-ipLane` would never apply: React Flow 12.12
  writes an inline `pointerEvents: 'all'` on every node wrapper while the flow has an `onNodeClick`
  (`@xyflow/react/dist/esm/index.js:2266, 2362`; `Canvas.tsx:353`), and spreads `node.style` after it (`:2364`). A
  lane never blocks a pan, a wheel tick or a click.

### Edges

- Only into the children of a card: a parent at depth 2 or deeper inside a lane, or a non-phase depth-1 step. There
  are none from the root or from a stack head.
- Type `step`, `offset: 10`, stroke `var(--border)`, `strokeWidth: 1`.
- The `out` handle sits at the frame's bottom, 18 px in from its left, so the rail runs at the parent's x + 18 with
  10 px stubs. The `in` handle is pinned at the header's middle (`top: 16px`), not the middle of a tall card.

### Canvas chrome

- `<Background>` (`Canvas.tsx:366`) and its import go. That also removes React Flow's `#141414` night layer, so the
  night ground is `--bg`.
- `<Controls position="top-right" orientation="horizontal" showInteractive={false} …>`, with `manualMove` kept on all
  three. Buttons 24 × 24 px with a 4 px gap, panel margin `8px 12px`, a 1 px `--border`, radius 8, no shadow. Colours
  and shadow through `--xy-controls-button-background-color: var(--float)`,
  `--xy-controls-button-background-color-hover: var(--panel-2)`, `--xy-controls-button-color: var(--muted)`,
  `--xy-controls-button-color-hover: var(--text)`, `--xy-controls-button-border-color: var(--border)` and
  `--xy-controls-box-shadow: none`, set on `.ip-canvas .react-flow`. Without the hover background, a hovered button
  paints React Flow's grey (`#f4f4f4` by day, `#3e3e3e` by night; `@xyflow/react/dist/style.css:43, 89`).
- The crumb: top left (left 10, top 8), 24 px tall, `padding: 0 9px`, gap 6, radius 8, a 1 px `--border`, `--float`,
  S `--muted`, `max-width: calc(100% - 120px)` so it clears the zoom row.

### Clicks and resource chips

- A click anywhere on a card, its lines included, opens Details through `onNodeClick` (`Canvas.tsx:301-306`). Buttons
  inside stop propagation: the done row, the chevron, `▤ n` and the resource chips.
- A drag on a card still pans. `nodesDraggable` is false (`Canvas.tsx:359`), so React Flow adds no `nopan`.
- From 720 px the resource chips `.ip-chip` stay beside the frame, past the lane's edge, in muted DM Mono with no
  purple. T392's last block and the five tests that click `.ip-chip` at 1000 px (T635, T657, T673, T761, T909) keep
  their target.

Hooks kept: `.ip-row`, `.ip-node` (the header, `role=button`, every state class), `.ip-title`, `.ip-marker` and its
`m-*`, `.ip-type`, `.ip-res-count`, `.ip-you`, `.ip-queue` (`.owned`), `.ip-more`, `.ip-more-done`, `.ip-badge` (the
agent line), `.ip-agent` (`.ended`; the kin), `.ip-tag`, `.ip-readers`, `.ip-work-done`, `.ip-work`, `.ip-work-mark`,
`.ip-work-tag`, `.ip-work-agent`, `.ip-trail-agent`, `.ip-chip`, `.react-flow__pane`. New: `.ip-card`, `.ip-lines`,
`.ip-agent-time`, `.ip-work-col`, `.ip-node.stack`, `.react-flow__node-ipLane`.

## 4. The Simple character

Files: new `web/src/Character.tsx`, new `web/src/character.ts` (the pure helpers), new `web/src/character.css`
(imported by the component, outside the shared stylesheet's regions), new `web/src/Marker.tsx`, new
`test/web/character.test.ts`.

### The component

`<Character size state slot seed />` renders `span.ip-char.c-<state>[data-state=<state>]`. For `wait` it adds two
ring spans: `.ip-char-ring`, the solid one, and `.ip-char-ring2`, the one that runs `ip-ring`. Then comes
`span.ip-char-body` holding the artboard's 32 × 32 SVG with `aria-hidden="true"`, so the character never enters an
accessible name. Inside the SVG, the eyes of `work` and `wait` sit in one `g.ip-char-eyes`.

The animated elements, as the artboard has them: `ip-bob` runs on `.ip-char-body`, `ip-blink` on `g.ip-char-eyes`,
and `ip-ring` on `.ip-char-ring2`. Tests read `animation-name` on these three.

- The body path is `M13 5Q16 2 19 5Q24 8 27 13Q30 16 27 19Q24 24 19 27Q16 30 13 27Q8 24 5 19Q2 16 5 13Q8 8 13 5Z`,
  filled `currentColor`.
- The colour is `var(--fam)` through `currentColor`. `ended` uses `--gone`. The eyes are filled `var(--bg)`, which
  follows the ground-colour rule and matches the artboard's dark eyes by night and white eyes by day.
- Copy the SVG as drawn in `Quiet-kin-together.dc.html` (lines 58 to 152 and `pip()`).

| State | Eyes | Body | Motion |
|---|---|---|---|
| `work` | round, r 2.4 at (11.5, 15.5) and (20.5, 15.5); at 24 px, r 2.1 at (12.5, 15) and (19.5, 15) | solid; at 24 px it adds the shade (`#000` at .14) and sheen (`#fff` at .45) paths; a drop-shadow glow in the hue | `ip-bob`, 2.4 s ease-in-out, from the bottom centre; the eyes blink |
| `idle` | lids: 4.6 × 2.2 rects, rx 1.1, at (9.2, 15.4) and (18.2, 15.4) | solid, opacity .85 | none |
| `wait` | wide, r 2.7 at (11.5, 14.8) and (20.5, 14.8) | solid, with a 1.5 px `--amber` ring at 1.36 × the size over `--amber-fill`, and a second ring | the eyes blink; the second ring runs `ip-ring`, 1.8 s ease-out |
| `ended` | lines `M9.4 15.8H13.6M18.4 15.8H22.6`, stroke 2.2, round caps | hollow: fill-opacity .1, stroke 2.6, round joins; opacity .75 by night, .85 by day | none |

- **Glow**: `drop-shadow(0 0 2.5px …)` below 24 px and `4px` at 24 px, in the hue at about 50 % alpha by night and
  30 % by day (the artboard's values). Build it with `color-mix(in srgb, var(--fam) …%, transparent)` and a
  per-theme percentage. Only working characters glow.
- **Blink**: `ip-blink`, ease-in-out, each eye pair scaled from its own centre. The artboard's periods run 3.6 to
  5.6 s.
- **Sizes**: 18 on a chip, 14 for a chip's kin. A lead is 20, or 24 while working, inside the 28 px line. A kin is 16.

### Helpers

- `characterState`: a session's `working`, `idle` and `permission` give `work`, `idle` and `wait`. A running subagent
  gives `work`, a stopped one `ended`.
- `phaseDelay`: a negative `animation-delay` from a hash of the id (`seed`), so chips and kin never bob or blink in
  step.
- Both live in `web/src/character.ts`, which `Character.tsx` imports. Both are pure and get unit cases. Nothing
  renders React in Vitest (`environment: 'node'`), and `character.test.ts` cannot import a `.tsx` module: the root
  `tsconfig.json`, which typechecks `test/`, sets no `jsx` (TS6142). Every web unit test today imports `.ts` helpers
  only.

### Reduced motion

The blanket rule stops the bob (`.ip-char-body`), the blink (`g.ip-char-eyes`) and the outer ring (`.ip-char-ring2`).
The glow and the solid ring stay, so a working character still differs from an idle one and a waiting one keeps its
ring.

### Marker

The status marker moves out of `NodeCard.tsx:59-61` into `Marker.tsx`: dot, ring, `✓`, `?`, the paused sky ring, the
needs-you amber dot and the pulse (values in section 3). The card header and Details' step list both draw it. Details'
empty `span.ip-marker` cannot draw a `✓`, which is why the marker is shared.

## 5. Layout and camera

Files: `src/core/layout.ts`, `web/src/canvas/useCamera.ts`, `web/src/canvas/breadcrumb.ts`, `Canvas.tsx`,
`test/core/layout.test.ts`, `test/web/breadcrumb.test.ts`. `sheet.ts` and `followThrottle.ts` are unchanged.

### Pitch

| Constant | Today | Quiet |
|---|---|---|
| `NODE_H` | 24 | 32: a one-line card, and the header box for cards and stack heads |
| `CARD_GAP` (new) | none | 10 |
| `ROW` | 32 | 42 (`NODE_H` + `CARD_GAP`) |
| `FOLD_ROW` (new) | `ROW` | 36 (26 + 10) |
| `AGENT_LINE` (replaces `BADGE_ROW`) | 26 | 28, whatever the lead's size |
| `READERS_LINE` (was `READERS_ROW`) | 20 | 20 |
| done row | 20 | 0 when it shares a kin-less last line, else 20 |
| `TASK_ROW` (was `WORK_ROW`) | 20 | 22, for task rows and for an opened done row's trail-agent rows (`layout.ts:451-454`) |
| `CARD_PAD` (replaces `WORK_GAP`) | 6 | 8, under the last line |
| `INDENT` | 28 | 28 |
| stack head to its first row | none | 43 |

A card with lines is `NODE_H + lines + CARD_PAD`. #81 (one agent line) is 32 + 28 + 8 = 68. #127 (an agent line, the
readers line with the done row, three task rows) is 32 + 28 + 20 + 3 × 22 + 8 = 154. The artboard draws 66 and 160:
its 66 overflows its own content, and its 160 uses a 34 px line for C.

### Pitch in CSS

- `layout.ts` exports the constants. Canvas writes each as a custom property on `.ip-canvas`, named after it (exact
  names are the implementer's).
- The canvas rules read them for every fixed height: `.ip-node`, `.ip-badge`, `.ip-readers`, the done row's own line,
  `.ip-work`, `.ip-trail-agent` (`TASK_ROW`; today a literal 18 px at `styles.css:173` against the 20 layout
  advances), `.ip-more` and the frame's bottom padding.
- A new unit test reads `styles.css` as `family.test.ts` does and fails on a literal height in those rules.

### Width and x

- Cards end at flow x 506: `w = 506 - x`, with a floor of 240. That is 450 at depth 2 and 422 at depth 3.
- The root is a card at x 8.
- Stack heads are at 22. A stack's children are at 56 and theirs at 84 (`depth × 28` from depth 2).
- A depth-1 step that is not a phase draws at 56, outside any lane, with its subtree one indent further. There is none
  in the live tree; the e2e seed has `Queued first` (T1259) and `Hotfix` (T716). This keeps the gutter column free.
- This spec reads the root's own fold rows the same way: x 56, outside any lane.

### Items

- `line` `{ kind: 'line', sessionId, nodeId, lead, agentIds, y }` replaces `badge` and `agent`. There is one per
  (session, card). `lead` is true where the session's focus anchors. `agentIds` lists the shown non-reader subagents
  homed here, in session order.
- `readers` keeps its own item, after its session's line.
- The order under a card stays: per session, its line, then its readers; then the done row; then task rows; then,
  opened, trail rows.
- `workDone` takes the `y` of the card's last agent or readers line and advances nothing, when that line is a readers
  line or a `line` with empty `agentIds`. When the last line is a `line` with kin, or there is no such line, it takes
  the next `y` and advances 20.
- `LayoutNodeItem` gains `h`, `w`, `stack` and `workingFocus`. `workingFocus` marks a working session's focus only,
  not its ancestors. `working` still marks the chain and drives the marker's pulse.
- Row items keep their absolute `y`. Canvas ignores their `x`.
- Edges are emitted only when the parent is a card at depth 2 or deeper inside a lane, or a non-phase depth-1 step;
  never the root or a stack head (section 3, Edges). The root-edge cases in `layout.test.ts` (l.40, l.103, l.121)
  change with it.
- `LayoutResult.lanes` holds `{ x, y, w, h }` per phase, so `items` keeps its shape. A lane closes at the next row at
  depth 0 or 1 that is not a stack, and at the end. The gap from a lane to a row outside any lane is the implementer's,
  from 10 to 18 px.
- The gap after a stack head's own lines, before its first child, is the implementer's, from 6 px (the artboard) to
  10 px (`CARD_GAP`).

### Camera

- Vertical is unchanged: `item.y + NODE_H / 2`.
- Horizontal: flow x 0 sits at the canvas's left edge. In `moveTo`, centre x = canvas width / 2 / zoom.
  `CARD_CENTER_X` (`useCamera.ts:20`) goes. Full-width cards are never cut, and on a wide window the lanes stay left of
  the Details side panel.
- Keyboard focus outside the view (`Canvas.tsx:311-328`) centres on y only.
- Follow and fit view are unchanged. With lanes as nodes, fit view fits them. Ruling 1's size feedback
  (`Canvas.tsx:98-106`) stays, for fold rows.
- `rowInView` (`sheet.ts:25`) keeps `NODE_H`: a step is in view when its header is.
- Breadcrumb (`breadcrumb.ts:7`): `i.y + i.h > top`, so a tall card whose header has scrolled off still names the
  crumb.
- First paint: hold `onInit`'s first camera move until `document.fonts.ready`, as approaches.md 2.5 has it. The move
  reads only layout and the canvas's size, and text reaches that size only through the session row's wrap, so the
  hold buys little and must cost nothing. Keep a mounted flag, and skip the move when the canvas has unmounted or the
  camera has already moved: the cleanup at `Canvas.tsx:334-342` cannot cancel a frame a late promise schedules, and a
  first move that lands after a Home would undo it. No e2e pins the first move to 3 px. T167 checks
  `Play app signing` is in view after open, and T192 and T317 press Home right after that check.

### Seed check

At the e2e size (520 × 900, chrome 41 + 40 + 32, no Up next in the demo, so a 787 px canvas), T571's margin above
`2 Android signing` is about 19 px with the 28 px line. Do not add height above `Play app signing` in the demo seed.

## 6. Details

Files: `web/src/panels/Details.tsx`, `ResourceViewer.tsx`, the Details and viewer rules in `styles.css`
(`:199-239`).

The geometry is unchanged: the 380 px side panel from 720 px, and the bottom sheet over the lower 60 % below it
(`SHEET_TOP` 0.4, `sheet.ts:6`). T301 and T510 to T630 depend on it.

- **Frame**: opaque `--panel`, a 1 px `--border` rule (left on the side panel, top on the sheet), `--shadow` kept,
  padding 12, body M. The sheet's top radius becomes 8. The grab handle `.ip-grab` becomes `--muted`; it used
  `--border` as a fill, which is now a faint smear.
- **Header**: the title at L `--text`, cut on one line. `Copy #id` and `×` are 24 px hairline buttons (`.ip-btn`:
  radius 8, a 1 px `--border`, S `--muted`, hover `--text-2`), shared with the viewer header
  (`ResourceViewer.tsx:46-50`).
- **Status**: the shared `Marker`, then the status word in `--muted`, in place of the filled `.ip-pill`. `NEEDS YOU`
  takes the `YOU` tag's look. The word stays the first text in `.ip-meta` (T247 l.264-267). `.ip-glyph` keeps
  `font-variant-emoji: text`.
- **Meta** `.ip-meta`: S `--muted`, the glyph unboxed.
- **Section heads** `.ip-label`: S at 900, uppercase, `letter-spacing: .14em`, `--muted`, the Up next head's style.
  The archived menu uses it too.
- **Parent link** `.ip-link`: `--link`. It stays a `button` (T571 l.576, l.589).
- **Resources** `.ip-res`: muted rows, no purple. `▤` `--muted`. The title in its `<b>`, set to 500 `--text-2`
  (T392 l.453 reads `.ip-res b`). The summary `.sub` in DM Mono S `--muted`. A faint tint on hover.
- **Working tasks** `.ip-wt` and **subagents** `.ip-dagent`: as the canvas rows. The tag in DM Mono S in the hue,
  `◐` `--active-ink` (static here), `○` and `✓` `--muted`, the hue bar on the session's own tasks, `◇` `--muted`. Text
  lines, no characters this round. Texts unchanged (T1203 l.1238-1243, T1429 l.1439-1441).
- **Ended work** `.ip-dtrail`: `◆` in `--muted` (T1445 l.1501).
- **Steps** `.ip-kids`: the shared `Marker`.
- **Log** `.ip-log`: the time in DM Mono S `--muted`, the text `--text-2`, the session `--muted` and not italic.
- **Weights**: `<b>Outcome:</b>` (`Details.tsx:239-243`) and every other `<b>` take 500 or 900, never 700.
- **Markdown** `.ip-md`, in Details and the viewer: h1, h2 and h3 at 15, 12.5 and 11 px, weight 900. Code in DM Mono.
  `pre` on `--panel-2` with a 1 px `--border`, radius 8. Table rules `--border`. Links `--link`.

Hooks kept: `.ip-details`, `.ip-meta`, `.ip-meta-label`, `.ip-label`, `.ip-glyph`, `.ip-link`, `.ip-res`, `.ip-wt`,
`.ip-dagent`, `.ip-dpurpose`, `.ip-dtrail`, `.ip-trail`, `.ip-trail-head`, `.ip-kids`, `.ip-log`, `.ip-md`,
`.ip-btn`, `.ip-grab`, `.ip-viewer-body`. Removed: `.ip-pill` (no e2e locates it).

## Smaller decisions this design takes

The maps raised these questions. approaches.md resolved them, and Aiden approved them with their sections.

- `--accent` is renamed `--active`, so a missed use shows as unset. The paused ring moves to `--sky`, links to
  `--link`.
- Rings and the selected card use `--text-2` (the artboard's `ink2`), not blue. Follow is `--muted` off and
  `--text-2` on.
- Only a working session's focus gets the orange hairline, the orange fill and the 15/900 title. Other active cards
  are plain, with a still orange dot. Needs-you cards lose the amber border and keep the dot and `YOU`.
- Blocked keeps a red pair, for the marker and the word only.
- `--green`, `--purple` and `--clay` go. Done is a muted `✓`. Resources are muted mono on the card, beside it and in
  Details.
- Details and the viewer sit on an opaque `--panel` with the shadow. The chip popover and the archived menu sit on
  `--float` with no shadow, as approaches.md 2.2 has them (its 2.1 lists "menus" under `--panel`; this spec follows
  2.2).
- Character eyes are `var(--bg)`. The glow mixes `--fam`. `--gone` is `--muted` by night and `--faint` by day.
- Weights normalise to 500 and 900. No Inter 700 and no italic face ship.
- Markdown code uses DM Mono. Markdown headings map to 15, 12.5 and 11 px.
- Hue checks in the e2e read the `color` of a letter, tag, kin or character.
- T982 l.997 relaxes to `<= 40`. The row stays 40.
- The chip popover stays, for every chip, on hover and on keyboard focus.
- The current tab keeps the 160 px cap.
- The Up next line stays one inline run with an ellipsis.
- The reconnecting banner keeps its solid amber band.
- Each step is one React Flow node with its lines inside. `.ip-node` stays the header inside the `.ip-card` frame.
- Cards share a right edge at flow x 506, with a floor of 240, and the camera holds x.
- One 28 px agent line. A lead is 20 px, 24 while working.
- Workers away from their session's focus get a line led by the letter, then their kin, with no label.
- Two sessions on one step get a line each. The done row joins the card's last agent or readers line, unless that
  line holds kin; then it takes its own line (Aiden, on the spec).
- Six kin, then `+n`. A kin's tooltip is its line plus the purpose. Kin are `role="img"` with that name.
- Trail rows keep `◆` in `--muted`, on the canvas and in Details.
- Every card has the 22 px left column.
- The queue gutter is a fixed column at flow x 6 to 48.
- A click anywhere on a card opens Details.
- Stacks are depth-1 steps of kind `phase`. A stack head sits centred in a 32 px box for the camera. A session's line
  on a phase sits under the track at x 56.
- Edges run only inside a card's subtree.
- The selected and flash rings draw on the frame.
- Resource chips stay beside cards from 720 px.
- Details lists subagents as text lines, and its status is the canvas marker and word.
- Under reduced motion the bob, the blink and the outer ring stop. The glow and the solid ring stay.

### Left to the implementer, within bounds

The inputs leave these open. Each is small.

- `--panel-2`: a faint tint whose alpha stays below `--border`'s. map-tokens.md decision 9 proposes values.
- The run time under a minute and past an hour: no spaces, at most five characters.
- The lead's box: fixed at 24 px, or the character's size.
- A lead-less line's accessible name after its leading letter.
- The `+n` tooltip's wording. It lists the hidden kin.
- Up next hover: a neutral change, never blue or orange.
- Dropped cards' fill: none, as done, or `--card`. The strike-through stays.
- Where a session with no slot sorts: after the lettered chips.
- How the frame reads the header's state: `:has()` or classes set on both.
- The pitch variables' names: one per exported constant.
- The gap from a lane to a row outside any lane: 10 to 18 px.
- The gap after a stack head's own lines: 6 to 10 px.
- Each `<b>` and Markdown `strong`: 500 or 900.
- The selected ring's width. Its colour is `--text-2`.

One reading this spec takes where approaches.md is silent: the root's own fold rows sit at x 56, outside any lane,
as non-phase depth-1 steps do. The crowded agent line was the other open reading; Aiden ruled on it when he approved
the spec (the done row takes its own line when the last line holds kin).

## Departures from today's window

All ship. "Note" names the review-actions section each one amends (next section).

| # | Today | Quiet | Note |
|---|---|---|---|
| D1 | Chip shows `A · #4 Implement Fable's Notes · 1 subagent · idle` | Character and letter only. Title, subagent count and `idle` move to the popover and the name. `needs permission` stays visible | §4 "where the tag sits" |
| D2 | Chips in last-seen order | Chips in letter order | none |
| D3 | Worker badge `a1 · description · model · 12 min` on its own row | A 16 px character, `a1` and, while running, `12m` on the session's line. Description, model, elapsed time and purpose in its tooltip and name. Details still lists them | §4 example, §5 |
| D4 | One row per worker under the card | One agent line per session per step, workers as kin on it | follows D3 |
| D5 | `◆ C · #5 UI Session post-Fable · working · 3 subagents` | `[C] c10 18m c11 · C · #5 UI Session post-Fable · working`: kin with the lead, before the label. The name still leads with the letter | §4 "where the tag sits" |
| D6 | Badge ends `· 3 subagents`; `◆` glyph; pulse dot | The count moves to the lead's tooltip. The character replaces `◆` and the dot | none |
| D7 | Permission: red outline on chip and badge | Amber ring on the character, `needs permission` in amber | §4 |
| D8 | Slot 0 clay: A clay, B indigo, C teal | A teal, B clay, C green | §4 |
| D9 | `Up next` on its own line above the lines | `UP NEXT` in an 82 px left column beside them | §6, preflight |
| D10 | Tab count an amber pill; working dot clay | A muted mono numeral; an ink dot | none |
| D11 | `● 1 need you` | `1 need you` with a drawn dot | none |
| D12 | Queue marker at the card's right end; unowned `①` blue | Left gutter, 15/900; unowned `①` ink | none (matches §6) |
| D13 | Done row on its own row under the card | At the right end of the last agent or readers line, or on its own line when that line holds kin | none (§3 holds) |
| D14 | Subagent task row `a1 ◐ ▍subject` with the hue bar | Tag in the left column, no bar. The session's own rows keep it | none (§4 holds) |
| D15 | Phases are cards joined by edges | Lanes opened by a stack head with a progress track; edges only inside a card's subtree | none |
| D16 | Paused: hollow blue marker | Hollow sky ring | §7 (wording; Aiden added it on the spec) |
| D17 | Clicks on under-card rows do nothing | A click anywhere on a card opens Details | none |
| D18 | Look only | Todo at full opacity; done cards unfilled with a muted `✓`; needs-you and active cards lose their 2 px borders; only the working focus gets the orange hairline and 15/900 title; zoom buttons top right; no dot grid; one 8 px radius; readers' `◇` muted | none |

Where this design departs from the artboard: one 28 px agent line (the artboard draws C's at 34), so cards never jump
when a session flips between working and idle; every card has the left column; the current tab keeps the 160 px cap;
the Up next line stays an inline run with an ellipsis; the chip popover stays in place of a native `title`; resource
chips stay beside cards from 720 px; the hues follow `Quiet-kin-together.dc.html`, not `Take-quiet.dc.html`.

## Amendments to the review-actions note

The branch adds a section to `docs/superpowers/specs/2026-10-04-review-actions-design.md`, after "Decisions after the
preflight" and in the same form: "Amended by the Quiet restyle (Aiden, 2026-10-05)", linking this spec. The lines it
names stay as written. The section says:

- **§4, the session chip (D1).** The chip shows the session's character and letter only. Its accessible name and its
  popover lead with the letter and carry the title: `A · Review actions controller`. A session waiting for permission
  adds `needs permission`. The letter shows on the chip, the agent line and the session's queue markers.
- **§4 and §5, subagents (D3, D4).** A worker is a kin on its session's agent line for that step: a small character,
  its tag and, while it runs, its elapsed time (`a1 12m`). Its description, model, elapsed time and purpose are in its
  tooltip and accessible name (`a1 · P2 canvas implementer · opus · 12 min`, then the purpose), and in Details. This
  replaces "Every other type keeps the full badge". The purpose is the kin's tooltip's second line. Task rows keep
  `a1 ◐ Write the tests`.
- **§4, the order on an agent line (D5).** The line draws the lead character, then the kin, then the label
  `A · Review actions controller · working`. Its accessible name still leads with the letter.
- **§4, permission (D7).** In place of "keeps its red outline": the session's character wears an amber ring, and
  `needs permission` shows in amber. The letter still shows the family.
- **§4, hues (D8).** In place of "Slot 0 keeps today's session clay. Slots 1 to 5 use the five hues that subagent
  badges use today": slot 0 teal, 1 clay, 2 green, 3 rose, 4 brown, 5 indigo, each with a night and a day value. They
  stay `--family-0` to `--family-5`.
- **§6, the Up next strip (D9).** In place of "`Up next` heads the strip once. Below it, …": `UP NEXT` sits once in a
  left column. Beside it, one line per live session that has entries, led by its letter in its hue, then a neutral
  `later` line. Each line is cut short at the window's edge.
- **§7, paused (D16).** In place of "a hollow blue marker": a hollow sky ring, with the same tooltip.

## Amended by background work (#228, 2026-10-10)

Plan: `docs/superpowers/plans/2026-10-09-background-work.md`. Rulings 53 to 80: `docs/superpowers/rulings/2026-10-04-review-actions-rulings.md`. The lines named stay as written.

- **§4, the `busy` character.** A fifth state beside `work`, `idle`, `wait` and `ended`: a session whose stored state
  is `idle` while a worker or a command that counts as work runs. Eyes as `work`'s (round, blinking), body solid at full
  opacity with no glow, motion `ip-breathe`, 3.6 s ease-in-out from the bottom centre, `scale(1, 1)` to
  `scale(1.03, .97)` and back. Under reduced motion the blanket rule stops the breathe and the blink, and the open eyes
  still tell it from idle's lids. `characterState` maps a session by its activity and takes the clock. A lead is 24 px
  while working and 20 px otherwise, busy included.
- **§3, live steps.** A card with running work anchored to it gets `.ip-card.live`: the `.focus` frame (orange
  hairline, active fill) and its title at `--text`, size M. The large 15/900 title stays on a working session's focus
  only. A busy lead alone does not light its card. Markers pulse up the chain of every live card, not only the working
  foci's.
- **§3, the commands line.** One `.ip-commands` line per session and card, 20 px, after the agent line and readers
  line: S, `--muted`, DM Mono for the tag, head and time. `▸ a3 · npm run test:e2e +4 · 12m`. A serving command reads
  `◦ a3 · npm run dev · serving 3h` in `--faint`. When every command has ended it reads `✓` or a muted `!` for 5
  minutes, then goes. The done toggle sits at its right end, as on the readers line.
- **§2, the session chip.** After the kin, a muted `▸n` in DM Mono S for the commands that count as work (aria-hidden).
  The accessible name and popover head add `· n commands` and `· busy`. The popover lists one line per shown command
  after the subagents; ended and serving ones are faint.
- **§2, the tab dot.** It shows for a project with a busy session, as before, but pulses only while a session of the
  project works; with sessions only busy it is still (`.ip-tab-dot.still`). The tab's accessible name says `working`,
  else `busy`.
- **§6, Details.** A `Background` section after Subagents lists the step's shown commands.

## Testing

Gates for the `ui` label: typecheck and unit; no failing-test-first for styling or wording; one e2e per user-visible
feature.

### Unit

- `test/web/family.test.ts:39-43`: the six day literals in `:root` and the six night literals in the dark block,
  teal first. `:32-37` (`familyVar`) holds.
- `test/core/layout.test.ts`: positions from the new pitch; `badge` and `agent` become `line`; the edge rule (the
  cases at L32, L92, L106). New cases: lanes (one per phase, closing at the root's fold rows, a folded phase holding
  only its head), the non-phase depth-1 column, the done row's shared `y` on a kin-less last line and its own line after a
  line with kin, `h` and `w` on node items, `workingFocus`
  on the focus only.
- `test/web/breadcrumb.test.ts`: the `ROW` multiples, plus a tall-card case.
- `test/web/live.test.ts`: `chipLabel` (l.97-108) holds. New cases for the chip-name, lead-title, kin-title and
  run-time helpers.
- New `test/web/character.test.ts`: `characterState` and `phaseDelay`, imported from `web/src/character.ts`.
- New pitch test: the canvas height rules read the pitch variables. A literal height fails it.
- New token-parity test: every colour token in `:root` has a value in the dark block. The theme-free tokens are named
  in the test as exempt.
- `test/server/app.test.ts:441` (the CSP literal) holds.

### e2e: changes on purpose

Colour pins move to Quiet values. They are day values except T284's, which emulates dark.

| Test | Element | Today | Quiet |
|---|---|---|---|
| T247 l.259 | `.ip-type` | `rgb(110, 110, 115)` | `rgb(71, 85, 105)` |
| T284 l.291 (dark) | `.ip-you` | `rgb(255, 179, 64)` | `rgb(252, 211, 77)` |
| T284 l.298 (dark) | `.ip-label` | `rgb(161, 161, 166)` | `rgb(148, 163, 184)` |
| T465 l.477 | paused ring | `rgb(0, 113, 227)` | `rgb(2, 132, 199)` |
| T465 l.484 | active markers | `rgb(0, 113, 227)` | `rgb(194, 65, 12)` |
| T1142 l.1199 | ended kin | `rgb(110, 110, 115)` | `rgb(71, 85, 105)` |
| T1203 l.1225 | readers | row `rgb(217, 119, 87)` | `.ip-readers .ip-tag` `rgb(11, 107, 125)` |
| T1294 l.1329 | Up next lead A | `rgb(217, 119, 87)` | `rgb(11, 107, 125)` |
| T1294 l.1345 | unowned `①` | `rgb(0, 113, 227)` | `rgb(30, 41, 59)` |
| T1380 l.1422 | chip A | background `rgb(217, 119, 87)` | the letter's colour `rgb(11, 107, 125)` |
| T1445 l.1477 | stale `○` | `rgb(174, 174, 178)` | `rgb(100, 116, 139)` |
| T1445 l.1490 | trail agent | `rgb(110, 110, 115)` | `rgb(71, 85, 105)` |

Task 1 moves these values in wave 0, in today's markup. For T1203 l.1225 and T1380 l.1422 it moves the value only,
on today's element and property. Task 6 later moves the first reading to `.ip-readers .ip-tag`, and Task 4 moves the
second to the letter's `color`. Task 1 cannot move the second itself: while `.ip-chip-s.s-working { color: #fff }`
(`styles.css:111`) stands, a working chip's letter reads white.

- **Hue equality** read from `backgroundColor` now reads `color` on the letter, tag, kin and character: T1142
  l.1180-1195, T1294 l.1315-1333, T1380 l.1408-1426. T1142 l.1175 inverts: a subagent's task row has no bar.
- **Copy and locators.**
  - T982 l.990: `1 need you`.
  - T1142 l.1153-1154 and l.1197, T1380 l.1398: a kin's text is its tag and, while it runs, its time. Find kin with
    `getByRole('img', { name })` and check `toHaveAccessibleName`. The locators that find kin by their description
    break the same way and move to role and name: T1142 l.1151-1152, T1203 l.1211, T1380 l.1397.
  - T1203 l.1213: the kin's `title` is its line plus the purpose.
  - T1203 l.1228, T1356 l.1362, T1380 l.1391-1393: a chip's text is its letter. Check `toHaveAccessibleName` and
    locate chips by role and name (`.ip-chip-label` is gone). T1380 l.1389-1390 find the chips by their title text
    and move to role and name too.
  - T392 l.416: anchor on the title, `page.locator('.ip-node .ip-title', { hasText: /^Milestone 1$/ })`. A done
    card's header text becomes `✓Milestone 1`, so today's locator would never match and the check would pass even if
    the milestones failed to fold.
  - T1380 l.1394-1395: `A · E2E session · working` and `B · Second session · working`, with no `◆` and no count.
    Where kin sit on a line, read its accessible name, since its text starts with the kin.
  - T1294 l.1319-1321: find the chip by its name and compare the letter's `color`.
  - T284 l.288: the working chip's `.ip-char-body` and its `g.ip-char-eyes` have `animation-name: none`.
- **Geometry.**
  - T982 l.997: `<= 40`.
  - T1086 l.1113: `<= 22`.
  - The `x > card.x + 20` checks (T1086 l.1112, T1142 l.1169, T1380 l.1406, T1445 l.1470) become "inside the frame".
  - T1142 l.1171: `a2` is a kin on A's line, at the line's `y`.
  - T284 l.295: the flash ring is read on the frame.
  - Every "below the card" check holds, because `.ip-node` stays the header.

### e2e: two new tests

1. **The canvas**, new, in the `Live work` block: "a step's agents and tasks sit inside its card: one line per session
   with its character and kin, the done row at the line's end, a lane per phase". It checks:
   - `Play app signing`'s frame holds its agent line, kin, readers line and task rows, and `Run signing tests`' frame
     starts at least 10 px below it;
   - the done row shares the readers line's `y` and ends at the frame's right padding; on a card whose last line is
     an agent line with kin, it sits on its own line below;
   - kin with the lead: the first kin's box is left of the line's letter, and the line's accessible name starts with
     the letter (`A · E2E session · working`);
   - a running kin shows `.ip-agent-time` in DM Mono after its tag; a stopped kin shows none, its `data-state` is
     `ended` and its tag is grey;
   - the lead's `data-state` is `work`;
   - `Road to market`'s lane holds its children and is apart from `Milestones`';
   - the computed `pointer-events` of `.react-flow__node-ipLane` is `none`;
   - a stack head's track follows done / total;
   - the zoom buttons sit in one row at the canvas's top right;
   - motion: the working lead's `.ip-char-body` has `animation-name: ip-bob` and its `g.ip-char-eyes` `ip-blink`;
     then, under reduced motion, both read `none`.
2. **The session row**, T1028 rewritten: the chip's visible text is its letter and its name carries the title; a
   `{ event: 'permission' }` hook shows `needs permission` and `data-state="wait"`, with `.ip-char-ring2` on
   `ip-ring`, and under reduced motion `.ip-char-ring2` reads `none` while `.ip-char-ring` stays visible; the pill
   and Follow stay on the first line; the popover opens on keyboard focus.

Small additions:

- T1294: the numeral's box ends left of the card's box.
- T284: the night ground, read as `.react-flow`'s `background-color`, is `rgb(8, 13, 28)`;
  `.react-flow__background` has count 0; after `document.fonts.ready`, `document.fonts` holds an `Inter` and a
  `DM Mono` face with `status === 'loaded'`; every request of type `font` went to 127.0.0.1. Do not use
  `document.fonts.check()`: it can return true for a family that matches no face. A face loads only once a rule uses
  it, so the `DM Mono` check waits for the mono rules (tasks 4 and 6) and the count check for `<Background>`'s
  removal (Task 6). The task plan splits these checks accordingly.

### e2e: held

T301, T317, T356, T377, T510 to T630, T716 and T736 pass without edits. They guard the camera, Follow, the keyboard
and the blink.

## Rollout and revert

- **One branch**, `quiet-restyle`, in a worktree. Tasks merge into it in the plan's order. Each runs typecheck, unit
  and the e2e tests it touches.
- **Before merging into main**: the full `npm run test:e2e` on the branch; a look at the real window at 520 × 1000,
  night and day; a re-check of the three ellipsis spots the critic measured (tab names at 160 px, the end of C's Up
  next line, #86's title) with the bundled faces; and a contrast check of the worktree's `styles.css`.
- **The contrast check.** Today's `contrast.mjs` (main checkout, `.superpowers/iter/2026-10-05/refresh/`) cannot run
  on Quiet as it is. It reads main's stylesheet by a fixed relative path, throws when a family slot differs between
  themes, reads `--accent`, `--green` and `--purple`, and accepts only 6-digit hex. Task 7 updates it: it takes the
  stylesheet's path, reads each slot's day and night literal, uses the new token names, composites `rgba` tokens
  over `--bg`, and drops React Flow's `#141414` ground. Then Task 7 runs it on the worktree's `styles.css` and checks
  the ratios this spec states: every hue as text at 4.5:1 in both themes, `--link` and `--red`.
- **Merge** locally into main with `--no-ff`, naming #81. Then run `npm run deploy -- --full` from the main checkout,
  not the worktree: deploy promotes into the checkout it runs in. It runs typecheck, unit, smoke and e2e against
  `.build`, promotes `dist/` and `web/dist/`, and restarts the server. The window reloads itself on the new build
  (`useInProgress.ts:47-52`). No kit change and no session restarts.
- **Revert**: `npm run rollback` swaps `dist/` and `web/dist/` with the previous build at once, fonts included.
  Running it again returns to Quiet. To revert for good: `git revert -m 1 <merge>`, then `npm run deploy`. Rollback
  keeps one previous build only, so after a later deploy Quiet is the build it returns to.

### Task plan

| # | Task | Size | Owns | Wave | After |
|---|---|---|---|---|---|
| 1 | Tokens and fonts | M | The `styles.css` token block, every weight and size declaration, every use of a renamed or removed token and `Canvas.tsx:237` (section 1, Removed), the `ip-pulse` keyframes, the reduced-motion block, the static flash ring's move into the canvas region, the moves of misplaced rules into their regions (see "`styles.css` regions"); `main.tsx`; `package*.json`; `vite.config.ts`; `family.ts`; `family.test.ts`; the token-parity test; the e2e colour literals (T247 l.259, T284 l.291 and l.298, T465 l.477 and l.484, T1142 l.1199, T1203 l.1225, T1294 l.1329 and l.1345, T1380 l.1422, T1445 l.1477 and l.1490), moved to Quiet values in today's markup (the value only for l.1225 and l.1422); T284's ground, `Inter` and font-request checks | 0 | none |
| 2 | Shared glyphs | M | `Character.tsx`, `character.ts`, `character.css`, `Marker.tsx`, `character.test.ts` | 1 | 1 |
| 3 | Layout and copy helpers | M to L | `src/core/layout.ts`, `web/src/live.ts` (chip name, lead title, kin title, run time; `WORDS` moved in from `BadgeNode.tsx`), `breadcrumb.ts`, and their unit tests. The `live.ts` part merges in wave 1; the layout and breadcrumb part merges with Task 6 | 1 | 1 |
| 4 | Chrome | M | `web/src/chrome/*`, the chrome rules, T284 l.288, T982, T1028 (rewrite), T1356, and the chip lines of T1203, T1294 and T1380 | 2 | 2, 3 |
| 5 | Details | M | `web/src/panels/*`, the Details and viewer rules, T204 to T247, T392 l.453, and the Details lines of T1203, T1429 and T1445 | 2 | 2 |
| 6 | Canvas | L | `web/src/canvas/*` (new `AgentLine`, `LaneNode`), `useCamera.ts`, the canvas rules, the pitch test, the canvas lines of T167, T392, T465, T1086, T1142, T1203, T1259, T1294, T1380 and T1445, T284 l.295, T284's `DM Mono` and `.react-flow__background` checks, and the new canvas e2e | 2 | 2, 3 |
| 7 | Integrate and deploy | S | Merge 4, 5, then 6 with Task 3's layout part; full suites; both themes in the real window; the contrast check; the review-actions amendment; `deploy --full` | 3 | all |

- Wave 1 runs tasks 2 and 3 together: they share no files. Wave 2 runs 4, 5 and 6 together.
- Task 3 merges in two parts. Its `live.ts` helpers merge in wave 1, since Task 4 needs them. Its `layout.ts` and
  `breadcrumb.ts` changes and their tests never merge alone. `Canvas.tsx` still switches on `badge` and `agent` and
  reads `item.agentId` (`:150-158`), so the `line` item alone fails `npm run typecheck` (`tsc -p web/tsconfig.json`
  includes `../src/core`). And today's 24 px `.ip-node` would sit 4 px off the camera's new `NODE_H / 2`, past
  `expectLifted`'s 3 px. Task 6 builds on Task 3's layout commits, and the two merge into the branch together. Tasks
  4 and 5 run on today's layout. Task 3's own gate for the layout part is the root typecheck (`tsc -p tsconfig.json`,
  which reaches `breadcrumb.ts` and `sheet.ts` through the unit tests but no `.tsx`) and the unit tests. The web
  typecheck and the e2e pass once Task 6 builds on it.
- `live.ts` belongs to task 3 alone. The tests that mix chip, canvas and Details lines (T1203, T284, T1294, T1380,
  T1445) are edited only on each task's own lines.
- Merge chrome and Details before canvas, and rerun the canvas e2e after.
- The critical path is 1, 3, 6, 7. Task 6 is the long one; start it as soon as 2 and 3 are done. It may split into two
  tasks run in sequence, for review size only: first cards owning their lines, lanes, stack heads, gutter, edges and
  camera; then the agent line with characters and kin.

### `styles.css` regions

| Region | Lines at `344cdcd` | Owner |
|---|---|---|
| Tokens: `:root`, the dark block, `body` | `:1-47` | Task 1 |
| The reduced-motion block | `:240-244` | Task 1 |
| Every `font-size` and `font-weight`, every use of a renamed or removed token, and the `ip-pulse` keyframes (`:116`), in any region; `Canvas.tsx:237` | throughout | Task 1, in wave 0, before anyone else branches |
| Chrome | `:48-118`, less what Task 1 moves out | Task 4 |
| Canvas, plus what Task 1 moves in | `:121-198` | Task 6 |
| Details and the viewer, less what Task 1 moves out | `:199-239` | Task 5 |
| `web/src/character.css` (new file) | none | Task 2 |

Task 1's weight edits shift every line number. It heads each region with a one-line comment so later tasks find their
region by name. Nobody else edits the token or reduced-motion blocks.

Two ranges hold rules of another region. In wave 0, Task 1 moves them to their owner's region, splitting selector
lists, so no two wave-2 tasks edit the same lines:

- From the chrome range `:90-99`: `.ip-agent-tag` (`:91`, the kin's tag, which the popover and Details share) goes
  to the canvas region. `.ip-dagent.ended .ip-agent-tag` (`:92`), `.ip-agent-dot` (`:94`, Details' trail `◆`),
  `.ip-dagent.ended` and `.ip-dtrail` (`:95`) and `.ip-dpurpose` (`:99`) go to Details. The popover's halves of `:92`
  and `:95` and `.ip-reader-mark` (`:97`, shared with Details, which wants the same `--muted`) stay in chrome.
- From the Details range: `.ip-row > .ip-chip { display: none; }` and `.ip-res-count { display: inline-block; }`
  (`:205-206`), the canvas's narrow-window chip toggle, go to the canvas region under their own `max-width: 719px`
  query, after the `.ip-chip` and `.ip-res-count` rules.
- The static flash ring (`:243`) goes to the canvas region, next to the flash rule (section 1, Motion).

## Risks

- **The DOM height drifts from layout's `h`.** Cards would overlap or leave gaps, and the camera would aim off.
  Guard: the node's `height` comes from layout; every in-card line has a fixed height, `nowrap` and an ellipsis; the
  pitch is written once (layout exports it, Canvas writes the variables, CSS reads them); the pitch unit test fails on
  a literal height; the new canvas e2e checks the next card starts at least 10 px below the frame. The run time never
  wraps. Never measure the DOM back into layout.
- **Font metrics on first paint.** Fontsource uses `font-display: swap`. React Flow measures fold rows at mount and
  again after the swap, and T377 guards the blink. Card heights do not depend on text metrics, so only widths and
  ellipses move. The first camera move reads layout and the canvas's size only; text reaches that size only through
  the session row's wrap. Its hold until `document.fonts.ready` is guarded against an unmount and an earlier move
  (section 5, Camera). A wrong family name fails silently; T284's font checks catch it.
- **The T571 margin.** About 19 px above `2 Android signing` at 520 × 900. A 34 px agent line would leave 13 px. A
  readers line on `Play app signing` in the demo seed would push it out. If Aiden asks for a taller pitch later,
  re-measure T571 first.
- **A crowded agent line.** Six running kin with times take about 420 px. The lead, the letter, the separators and
  the state word, which never cut either, need over 100 px more. A framed line holds 398 to 426 px at 520 px. Once the
  title has cut to nothing, the rest overflows the frame's right edge. The done row no longer competes: it takes its
  own line when the last line holds kin (Aiden, on the spec). The cap stays six as approved. Whether it drops is for
  Aiden after he lives with it.
- **A missed weight renders Inter Black.** Any 600, 700 or 800 left in `styles.css`, and any `<b>` or Markdown
  `strong` without an explicit weight. Task 1 sets them all, and review searches for leftovers.
- **A font inlined as `data:`.** The CSP blocks it, and `consoleErrors` fails every e2e before promotion. Import the
  latin files only, or set `assetsInlineLimit` for fonts.
- **The hues differ from the artboard Aiden picked.** `Take-quiet.dc.html` paints A clay, B indigo and C teal. The
  window shows A teal, B clay and C green, as `Quiet-kin-together.dc.html` does. B's clay now sits near the active
  orange.
- **Some signals read weaker.** Another project's needs-you count is a muted numeral, not an amber pill. A session's
  title needs a hover or focus on its chip. Under reduced motion a working character differs from an idle one only by
  its glow, eyes and opacity.
- **Zoom buttons under the Details side panel.** From 720 px with Details open, the zoom row sits under the panel.
  approaches.md does not move it.
- **A queued phase.** The gutter column (flow x 6 to 48) overlaps a stack head at x 22. No phase is queued in the live
  tree.
- **Rollback depth.** One previous build only.
