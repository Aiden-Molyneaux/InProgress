# Quiet restyle Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the InProgress window's look with Quiet in one deploy: Inter and DM Mono, ink and one hairline,
Simple characters for sessions and subagents, a step's agents and tasks drawn inside its card, and phases as lanes.

**Architecture:** Approach A. `src/core/layout.ts` stays the only geometry: it computes every card's height and
width and the phase lanes, and nothing ever measures the DOM back into it. Each card's React Flow node draws its own
lines (agent line, readers line, done row, task rows) inside a frame, and Canvas writes layout's pitch as CSS custom
properties that the stylesheet reads. Tokens and fonts land first, then the shared glyphs and copy helpers, then
chrome, Details and canvas in parallel on one integration branch, merged and deployed once.

**Tech Stack:** TypeScript 5.9, React 18, `@xyflow/react` 12.12, Vite 6, Vitest 2 (`environment: 'node'`), Playwright
1.63 on Edge (`channel: 'msedge'`), `@fontsource/inter` and `@fontsource/dm-mono` 5.3. The Fastify server does not
change. Windows; every command below is Git Bash.

**Spec:** `docs/superpowers/specs/2026-10-05-quiet-restyle-design.md` (approved by Aiden on 2026-10-05). It is the
source of truth for behaviour and look; this plan adds files, names, tests and order. Working notes, the maps and the
artboards are in the main checkout only (`.superpowers/` is gitignored): `C:/personal/InProgress/.superpowers/iter/2026-10-05/quiet/`
and `C:/personal/InProgress/.superpowers/iter/2026-10-02/mockups/project/Quiet-kin-together.dc.html`.

## Global Constraints

Every task's requirements include this section. Values are copied from the spec.

**Scope**

- No switch between looks. Quiet replaces today's look; a rollback brings today's look back.
- Only the window changes. No change to the server, the briefing, the hooks, the CLI, the kit or the data model, and
  no session restarts. `src/server/`, `src/hooks/`, `src/cli/`, `src/mcp/`, `src/lib/`, `claude/` and `scripts/` stay
  untouched. `test/server/app.test.ts:441` (the CSP literal) holds.
- Not this round: a dashboard, anything else from the Now or Whiteboard takes, characters in Details (Details lists
  agents as text lines), the taskbar icon (#82). The favicon keeps its clay (`web/index.html:7`).
- A need the spec does not answer, beyond its list "Left to the implementer, within bounds", is a design question.
  Stop and ask Aiden through the controller.

**Theme**

- The theme follows Windows. Keep `color-scheme: light dark` and the one `@media (prefers-color-scheme: dark)` block:
  `:root` takes the day values and the dark block the night values. React Flow keeps `colorMode="system"`
  (`Canvas.tsx:363`). `body` keeps painting `--bg`.

**Neutrals and surfaces** (day, night)

| Token | Day | Night | Used for |
|---|---|---|---|
| `--bg` | `#f8fafc` | `#080d1c` | page and canvas ground; character eyes; ink on filled marks |
| `--text` | `#0f172a` | `#f1f5f9` | current tab and its underline; the working focus's title; in-progress subjects |
| `--text-2` (new) | `#1e293b` | `#e2e8f0` | card titles, Up next steps, Follow on, activity actor and event, tab dot, focus rings, unowned queue numeral |
| `--muted` | `#475569` | `#94a3b8` | secondary text, counts, separators, heads |
| `--faint` | `#64748b` | `#64748b` | todo ring, stale `○` |
| `--border` | `rgba(15,23,42,.11)` | `rgba(255,255,255,.09)` | every 1 px rule and hairline; edges |
| `--bar` (new) | `#ffffff` | `rgba(255,255,255,.018)` | tab bar, session row, Up next, activity strip |
| `--card` (new) | `#ffffff` | `rgba(255,255,255,.035)` | card fill |
| `--active-fill` (new) | `#fffaf6` | `rgba(249,115,22,.045)` | the working focus's card |
| `--lane` (new) | `rgba(15,23,42,.018)` | `rgba(255,255,255,.022)` | phase lanes |
| `--float` (new) | `rgba(248,250,252,.94)` | `rgba(8,13,28,.92)` | crumb, zoom buttons, chip popover, archived menu |
| `--panel` (kept, overlays) | `#ffffff` | `#0c1227` | Details, the resource viewer and its header |
| `--shadow` | `0 8px 24px rgba(15,23,42,.16)` | `0 8px 24px rgba(0,0,0,.55)` | Details and the viewer only |
| `--panel-2` (kept) | `rgba(15,23,42,.05)` | `rgba(255,255,255,.06)` | hover fills, code blocks (alpha stays below `--border`'s) |
| `--track` (new) | `rgba(15,23,42,.08)` | `rgba(255,255,255,.08)` | a stack head's track |
| `--track-fill` (new) | `rgba(71,85,105,.5)` | `rgba(148,163,184,.55)` | its filled part |

**Accents and attention** (day, night)

| Token | Day | Night | Used for |
|---|---|---|---|
| `--active` (renames `--accent`) | `#c2410c` | `#f97316` | the active marker |
| `--active-ink` (new) | `#c2410c` | `#fb923c` | `◐` |
| `--active-line` (new) | `rgba(234,88,12,.55)` | `rgba(249,115,22,.5)` | the working focus's hairline |
| `--sky` (new) | `#0284c7` | `#38bdf8` | the paused ring |
| `--link` (new) | `#0369a1` | `#38bdf8` | links in Details, the viewer and Markdown |
| `--amber` | `#d97706` | `#fbbf24` | needs-you dot, need-pill dot, permission ring, flash ring, reconnecting banner |
| `--amber-ink` | `#92400e` | `#fcd34d` | `YOU`, `need you`, `needs permission` |
| `--amber-fill` (new) | `rgba(251,191,36,.18)` | `rgba(251,191,36,.12)` | the `YOU` tag, the permission ring's fill |
| `--red` | `#b91c1c` | `#f87171` | the blocked marker and word only |
| `--gone` (new) | `#64748b` | `#94a3b8` | an ended character |

**Family hues.** Literals in `:root` (day) and in the dark block (night). `familyVar` and `FAMILY_COUNT` (6) do not
change; a null slot wears teal.

| Slot | Letter | Hue | Day | Night |
|---|---|---|---|---|
| 0 | A | teal | `#0b6b7d` | `#3cc3d6` |
| 1 | B | clay | `#b4532f` | `#e8956f` |
| 2 | C | green | `#287a3a` | `#7ad68f` |
| 3 | D | rose | `#b0204f` | `#f27aa5` |
| 4 | E | brown | `#85593a` | `#d4a574` |
| 5 | F | indigo | `#4f4dc4` | `#9a98ff` |

**Theme-free tokens**

| Token | Value |
|---|---|
| `--radius` | `8px` |
| `--hairline` | `linear-gradient(97deg, #6366f1, #ff6600)` |
| `--font-sans` | `'Inter', system-ui, 'Segoe UI', 'Segoe UI Symbol', sans-serif` |
| `--font-mono` | `'DM Mono', ui-monospace, 'Cascadia Code', Consolas, monospace` |
| `--fs-l`, `--fs-m`, `--fs-s` | `15px`, `12.5px`, `11px` |
| `--w-text`, `--w-heavy` | `500`, `900` |
| `--track-l` | `-0.05em` |

**Removed tokens.** `--accent` (renamed `--active`), `--edge` (edges use `--border`), `--green`, `--purple`, `--clay`.
`var(--fam, var(--clay))` fallbacks become `var(--fam, var(--family-0))`. No build on any branch reads a removed
token.

**Colour roles**

- Orange marks only the active path. Amber marks only attention. Family hues colour only characters, letters and
  tags. Red is only the blocked marker and its word.
- Text on a filled hue uses the ground colour (`var(--bg)`), never white. Hard-coded `#fff` ink on markers and pills
  becomes `var(--bg)`. The reconnecting banner keeps its solid `--amber` band with `#000` text.
- Focus rings and the selected card's ring are 2 px `--text-2`, never blue. The resource viewer's amber outline stays.

**Fonts and the CSP**

- Inter and DM Mono, bundled with the app. No network fonts.
- `npm i -D @fontsource/inter@^5.3.0 @fontsource/dm-mono@^5.3.0` (both OFL-1.1, devDependencies).
- In `web/src/main.tsx`, after `import '@xyflow/react/dist/style.css';`, import `@fontsource/inter/latin-500.css`,
  `@fontsource/inter/latin-900.css` and `@fontsource/dm-mono/latin-500.css`.
- The CSP stays `default-src 'self'` (`src/server/routes/ui.ts:18`). Never let a font inline as `data:`, and never add
  `data:` to the CSP. If a broader subset is ever imported, add
  `assetsInlineLimit: (f) => (/\.woff2?$/.test(f) ? false : undefined)` to `web/vite.config.ts`.
- The font stacks keep their fallbacks after `'Inter'`, so glyphs Inter lacks (`◐ ○ ✓ ◇ ◆ ① ⧉ ⚙ ⛁ ▤ ▸ ▾`) fall
  through per glyph. The `⛁` size tweak stays.

**Type**

- Weights: only 500 and 900. Every 600, 700 and 800 becomes 500 or 900. Every `<b>` and Markdown `strong` gets an
  explicit 500 or 900. No italic face ships; the Details log drops its italic.
- `body`: `500 12.5px/1.4 var(--font-sans)` with `font-variant-emoji: text`.
- L: 15 px, 900, line 20 px, `letter-spacing: var(--track-l)`, `word-spacing: .05em`.
- M: 12.5 px, 500, line 18 px.
- S: 11 px, 500, line 14 px.
- Mono: DM Mono 500 at S, for `#id`s, counts, tags, times, `▤ n`, `n/m` and `+n`.
- Every `font-size` in `styles.css` is L, M or S. One radius: 8 px.

**Canvas rules that cross tasks**

- Kin with the lead. An agent line reads, left to right: the lead character (20 px, 24 px while working, inside the
  28 px line), the kin (each `margin-left: 8px`), then the label `C · #5 UI Session post-Fable · working` at
  `margin-left: 12px` (no dot between the last kin and the letter). The line is `role="group"`; its `aria-label` leads
  with the letter: `C · #5 UI Session post-Fable · working`.
- Run time. A running kin shows its elapsed time after its tag, in muted DM Mono S (`c10 18m`), from `runTime`. Ended
  kin show no time. It updates on the canvas clock (`CLOCK_MS`, 30 s, `Canvas.tsx:37`), and so do the tooltip and the
  name.
- Six kin, then a muted `+n` in DM Mono S. Readers never get a kin.
- The done row. It sits at the right end of the card's last agent or readers line when that line holds no kin. When
  the last line holds kin, or the card has no such line, it takes a 20 px line of its own. Layout decides from the
  `line` item's `agentIds` and gives the done row its `y` (Interface contract, layout.ts).
- A click anywhere on a card opens Details. Buttons inside stop propagation: the done row, the chevron, `▤ n` and the
  resource chips. From 720 px the resource chips stay beside the frame.
- Never measure the DOM back into layout. Every in-card line has a fixed height, `white-space: nowrap` and an
  ellipsis. The pitch is written once: layout exports it, Canvas writes it as CSS custom properties, CSS reads them.

**Motion**

- `ip-pulse` keeps its name: opacity 1, .35, 1 over 1.6 s ease-in-out. Task 1 moves its keyframes from the chrome
  range (`:116`) to the end of the tokens region, so only Task 1 edits them. Tasks 2, 4 and 6 use it
  (`ip-pulse 1.6s ease-in-out infinite`) and never redefine it.
- New keyframes: `ip-bob` (`translateY(0) scale(1.04, .96)` at 0 and 100 %, `translateY(-14%) scale(.98, 1.02)` at
  50 %), `ip-blink` (`scaleY(1)` at 0, 91 and 100 %, `scaleY(.1)` at 94.5 %), `ip-ring` (`scale(1)` at opacity .85
  to `scale(1.45)` at opacity 0).
- Reduced motion: one blanket rule, `* { animation: none !important; }`. The glow and the character's solid ring stay.

**Process**

- Test gates for the `ui` label: `npm run typecheck` and `npm test`; one e2e test per user-visible feature; no
  failing-test-first for styling or wording. Logic is test-first: `layout.ts`, the `live.ts` helpers, the
  `characterState.ts` helpers (the spec's `character.ts`; see the Interface contract for the rename), Task 4's
  `chipOrder`, the token test and the pitch test.
- Every command block starts with `cd` into its worktree, or uses `git -C`. A shell that does not keep its directory
  between calls must never run a step's command in the main checkout.
- Commands (`package.json`): `npm run typecheck` (`tsc -p tsconfig.json && tsc -p web/tsconfig.json`), `npm test`
  (Vitest), `npm run test:smoke`, `npm run test:e2e` (builds `.build`, then Playwright). One e2e test: `npm run build`,
  then `INPROGRESS_E2E_PORT=<port> npx playwright test -g "<name>"`. Every e2e run sets the worktree's own
  `INPROGRESS_E2E_PORT` (table in Branches and worktrees): `INPROGRESS_E2E_PORT=<port> npm run test:e2e`.
- Never touch the live setup. Only Task 7 deploys, and only from the main checkout. Implementers never run
  `npm run deploy`, `npm run rollback` or `npm run claude:install`, never use port 4317, and never write `dist/`,
  `web/dist/`, `~/.claude` or `~/.inprogress`. Never push. Never run `npx playwright install`.
- Commit often. A subject in plain words ending `(#81)`, and the message's last line
  `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`:
  `git commit -m "<what changed> (#81)" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"`.
- `styles.css` regions belong to one task each (table in Branches and worktrees). Nobody but Task 1 edits the token
  block or the reduced-motion block. `live.ts` belongs to Task 3 alone. The e2e tests that mix chip, canvas and
  Details lines (T1203, T284, T1294, T1380, T1445) are edited only on each task's own lines.
- `T<n>` is the test that starts at line n of `test/e2e/ui.spec.ts` at `0b786b8`; `l.<n>` is an assertion's own line.
  Code line numbers are the same at `344cdcd` and `0b786b8`.

---

## File structure

Every file the plan creates, modifies or deletes. Line ranges are at `0b786b8`.

| File | Change | Responsibility | Task |
|---|---|---|---|
| `docs/superpowers/plans/2026-10-05-quiet-restyle.md` | Create | This plan, committed to `main` before any branch | controller |
| `web/src/styles.css`: tokens `:1-47`, reduced motion `:240-244`, every `font-size` and `font-weight`, every use of a renamed or removed token, the `ip-pulse` keyframes (`:116`, moved to the end of the tokens region), the region head comments, the moves of misplaced rules (the split of `:114` among them), explicit weights for every `<b>` and `strong` | Modify | Quiet's tokens, type and motion base | 1 |
| `web/src/canvas/Canvas.tsx:237` | Modify | Edge stroke `var(--edge)` to `var(--border)`, nothing else | 1 |
| `web/src/main.tsx:4-5` | Modify | The three font imports after the React Flow stylesheet | 1 |
| `package.json`, `package-lock.json` | Modify | The two `@fontsource` devDependencies | 1 |
| `web/vite.config.ts` | Modify only if a font would inline | `assetsInlineLimit` for fonts | 1 |
| `web/src/family.ts:1, 6` | Modify | Comments only: slot 0 is teal | 1 |
| `test/web/family.test.ts:39-43` | Modify | Six day literals in `:root`, six night literals in the dark block, teal first | 1 |
| `test/web/tokens.test.ts` | Create | Token parity, Quiet's token values, no removed token, and only the shipped weights and the three sizes (Interface contract, Tokens) | 1 |
| `test/e2e/ui.spec.ts`: T247 l.259, T284 l.284-299 (l.291, l.298, and the ground, `Inter` and font-request checks), T465 l.477 and l.484, T1142 l.1199, T1203 l.1225 (value only), T1294 l.1314 (comment), l.1329, l.1339 (comment) and l.1345, T1380 l.1407 (comment) and l.1422 (value only), T1445 l.1477 and l.1490 | Modify | Colour pins at Quiet values in today's markup | 1 |
| `web/src/characterState.ts` | Create | `characterState`, `phaseDelay` and their types: pure, no DOM. The spec names it `character.ts`; the Interface contract says why it is renamed | 2 |
| `web/src/Character.tsx` | Create | The Simple character | 2 |
| `web/src/character.css` | Create | The character's look and motion, the `ip-bob`, `ip-blink` and `ip-ring` keyframes, and the Marker's look | 2 |
| `web/src/Marker.tsx` | Create | The status marker, shared by the card header and Details | 2 |
| `test/web/character.test.ts` | Create | Unit cases for `characterState` and `phaseDelay` | 2 |
| `web/src/live.ts` | Modify (append) | `WORDS`, `chipName`, `leadTitle`, `kinTitle`, `runTime` | 3 (part A) |
| `test/web/live.test.ts` | Modify (append) | Cases for the five new exports; `chipLabel` cases (l.97-108) hold | 3 (part A) |
| `src/core/layout.ts:4-13, 15-39, 57-78, 110-161, 294-459` | Modify | The Quiet pitch, `line` items, `h`, `w`, `stack`, `workingFocus`, lanes, the edge rule | 3 (part B) |
| `web/src/canvas/breadcrumb.ts:7` | Modify | `i.y + i.h > top` | 3 (part B) |
| `test/core/layout.test.ts` | Modify | Positions from the new pitch, `line` items, lanes, the edge rule, the done row's `y` | 3 (part B) |
| `test/web/breadcrumb.test.ts` | Modify | `ROW` multiples, plus a tall-card case | 3 (part B) |
| `web/src/chrome/SessionRow.tsx` (whole file), `UpNext.tsx:17-71`, `ActivityStrip.tsx:6-14`, `TopBar.tsx:15` (comment only) | Modify | Session row with characters, need pill and Follow, Up next column, activity strip | 4 |
| `web/src/chrome/chips.ts` | Create | `chipOrder`: the session row's letter order | 4 |
| `test/web/chips.test.ts` | Create | Unit cases for `chipOrder` | 4 |
| `web/src/styles.css`, chrome region | Modify | The chrome rules: the hairline, tabs, chips, popover, pill, Follow, Up next, activity strip | 4 |
| `test/e2e/ui.spec.ts`: T284 l.288, T982 l.990 and l.997, T1028 (rewrite), T1203 l.1228, T1294 l.1319 and l.1321, T1356 l.1362, T1380 l.1388-1393, l.1413 and l.1415 | Modify | Chrome e2e | 4 |
| `web/src/panels/Details.tsx:8, 90, 98, 221, 260-267, 275-280` | Modify | Details in the Quiet vocabulary, with the shared `Marker` | 5 |
| `web/src/panels/ResourceViewer.tsx`, `Markdown.tsx` | Owned, unchanged | Their look comes from the Details and viewer region | 5 |
| `web/src/styles.css`, Details and viewer region | Modify | The Details and viewer rules | 5 |
| `test/e2e/ui.spec.ts`: insertions only, after T204 l.214, T247 l.267, T392 l.453, T1203 l.1241, T1429 l.1442 and T1445 l.1501 | Modify | Details e2e | 5 |
| `web/src/canvas/Canvas.tsx` | Modify | Lanes, cards with explicit size, row items grouped into their card, pitch variables, the canvas chrome (no `<Background>`, zoom row top right), the first camera move held until `document.fonts.ready` | 6 |
| `web/src/canvas/NodeCard.tsx` | Modify | Frame, header, lines, stack head, gutter, handles | 6 |
| `web/src/canvas/AgentLine.tsx` | Create | One session's line on a card: lead, kin, label, done row slot | 6 |
| `web/src/canvas/LaneNode.tsx` | Create | A phase's lane | 6 |
| `web/src/canvas/pitch.ts` | Create | `PITCH`: layout's pitch as CSS custom properties, in a `.ts` module the pitch test can import | 6 |
| `web/src/canvas/BadgeNode.tsx`, `AgentBadge.tsx` | Delete | Replaced by `AgentLine.tsx` | 6 |
| `web/src/canvas/ReadersRow.tsx`, `WorkRow.tsx`, `WorkDoneRow.tsx`, `TrailAgentRow.tsx` | Modify | Plain components taking props (not `NodeProps`) | 6 |
| `web/src/canvas/MoreNode.tsx` | Owned, unchanged | Stays a node; its look is all CSS | 6 |
| `web/src/canvas/useCamera.ts` | Modify | Left-anchored x: `CARD_CENTER_X` goes, centre x is canvas width / 2 / zoom in `moveTo` | 6 |
| `web/src/styles.css`, canvas region | Modify | The canvas rules; removes the old `.ip-marker` rules | 6 |
| `test/web/pitch.test.ts` | Create | Fails on a literal height in the canvas height rules | 6 |
| `test/e2e/ui.spec.ts`: the helpers after `RUNNING` (l.1083); T284 l.294-295 with the `.react-flow__background` check, and a `DM Mono` check after Task 1's `Inter` check; T392 l.416; T1086 l.1106 and l.1112-1113; T1142 l.1151-1200; T1203 l.1211-1213 and l.1225; T1294 after l.1313; T1380 l.1394-1406, l.1414, l.1416-1418 and l.1426; T1445 l.1470; the new canvas test. T167, T465 and T1259 hold without edits | Modify | Canvas e2e | 6 |
| `docs/superpowers/specs/2026-10-04-review-actions-design.md:177` | Modify (insert) | The amendment section | 7 |
| `C:/personal/InProgress/.superpowers/iter/2026-10-05/refresh/contrast.mjs` | Modify (gitignored, main checkout) | Contrast check for Quiet's tokens | 7 |
| `C:/personal/InProgress/.superpowers/iter/2026-10-05/quiet/preview.mjs` | Create (gitignored, main checkout) | Night and day screenshots of a preview, and the cut-text table | 7 |

Unchanged on purpose: `web/src/chrome/tabs.ts`, `web/src/App.tsx`, `web/src/canvas/sheet.ts`,
`web/src/canvas/followThrottle.ts`, `web/tsconfig.json`, `src/core/tree.ts`, `src/core/types.ts`, everything under
`src/server/`.

## Interface contract

Exact and final. Task writers copy these names, types and values. Where a block shows code, that code is the
contract. The task writers' additions are folded in here, and where two of them named the same thing differently,
the name below is the one every task uses.

Two places where this plan departs from the spec's wording, both on purpose:

- The character helpers live in `web/src/characterState.ts`, not the spec's `web/src/character.ts`. On Windows the
  file system ignores case, and TypeScript and Vite both try `.ts` before `.tsx`, so with a `character.ts` beside
  `Character.tsx` an import of `'./Character'` loads `character.ts`. Checked on a scratch copy: `tsc -p
  web/tsconfig.json` gives `TS2305` (no exported member `Character`) and `TS1261`/`TS1149` (names differ only in
  casing), and `vite-node` loads the wrong file too. The export names do not change. No task adds
  `allowImportingTsExtensions` or imports with a `.tsx` or `.jsx` extension.
- The `ip-pulse` keyframes move from the chrome range into the tokens region (spec section 1 has them in the chrome
  region, edited by Task 1). Only Task 1 edits them, wherever they sit, and this keeps Task 4's region replacement
  from touching them.

### `src/core/layout.ts` (Task 3 part B produces; Tasks 6 and 3's breadcrumb consume)

**Pitch, exported.** Each one gets a CSS custom property (below). `BADGE_ROW`, `WORK_ROW`, `WORK_GAP` and
`READERS_ROW` are removed.

```ts
/** A card's header box and a one-line card: a 30 px header inside the frame's 1 px border. The camera aims at y + NODE_H / 2. */
export const NODE_H = 32;
/** Between a card's frame and the next row. */
export const CARD_GAP = 10;
/** A one-line card's pitch. */
export const ROW = NODE_H + CARD_GAP; // 42
/** A fold row's pitch: the row is 26 px tall, then CARD_GAP. */
export const FOLD_ROW = 36;
/** A session's agent line in a card, whatever its lead's size. */
export const AGENT_LINE = 28;
/** A session's readers line (`◇ c · 2 reading`). */
export const READERS_LINE = 20;
/** The done row on a line of its own. It adds nothing when it shares a kin-less last line. */
export const DONE_LINE = 20;
/** A working task's row, and an opened done row's trail-agent row. */
export const TASK_ROW = 22;
/** Under the last line of a card that has lines. */
export const CARD_PAD = 8;
export const INDENT = 28;
/** From a stack head's box top to the first row under it. */
export const STACK_HEAD = 43;
```

**Placement, module-private** (not exported; tests use the literal numbers):

```ts
const ROOT_X = 8;           // the root card
const STACK_X = 22;         // a stack head
const CARD_RIGHT = 506;     // every card ends here: w = Math.max(CARD_MIN_W, CARD_RIGHT - x)
const CARD_MIN_W = 240;
const LANE_X = 8;
const LANE_W = 504;
const LANE_PAD_TOP = 9;     // a lane's top, above its head box
const LANE_PAD_BOTTOM = 12; // below the last row of the phase's subtree
const LANE_GAP = 18;        // clear space between a lane and the next lane, or any row outside lanes
```

**Types.** `LayoutBadgeItem` and `LayoutAgentItem` are removed. `LayoutMoreItem`, `LayoutReadersItem`,
`LayoutWorkItem`, `LayoutTrailAgentItem`, `LayoutEdge` and `LayoutInput` keep their fields. `agentShown`,
`agentVisible`, `agentHome`, `homedTrailAgents`, `queueView`, `formatUpNext`, `MAX_UP_NEXT`, `findFrontier`,
`eventTarget` and `layoutOutline`'s signature do not change.

```ts
export interface LayoutNodeItem {
  // ...every field it has today (kind 'node', id, nodeId, x, y, depth, folded, doneCount, progress, resourceIds,
  // needsYou, hasChildren, working, queue, paused), plus:
  /** A card: its frame's height. A stack head: its box, from the head's top to the end of its own lines. */
  h: number;
  /** Math.max(240, 506 - x): 498 for the root, 484 for a stack head, 450 at x 56, 422 at x 84. */
  w: number;
  /** A depth-1 step of kind 'phase': drawn as an unframed stack head that opens a lane. */
  stack: boolean;
  /** The focus of a live session whose state is 'working'. Never its ancestors: `working` still marks the chain. */
  workingFocus: boolean;
}

/** One session's line on one card (one per session per card), in place of today's badge and agent items. */
export interface LayoutLineItem {
  kind: 'line';
  /** `l<sessionId>:<nodeId>` */
  id: string;
  sessionId: string;
  nodeId: number;
  /** The session's focus anchors on this card: the line draws the session's character and label. */
  lead: boolean;
  /**
   * The session's shown non-reader subagents homed on this card (agentVisible: running, or stopped less than
   * ENDED_AGENT_MS ago), in the session's `subagents` order. Each is one kin.
   */
  agentIds: string[];
  x: number;
  y: number;
}

export interface LayoutWorkDoneItem {
  // ...every field it has today (kind 'workDone', id, nodeId, count, unfinished, agents, open, x, y), plus:
  /** True: it sits at the right end of the card's last line and has that line's y. False: a DONE_LINE of its own. */
  shared: boolean;
}

/** A depth-1 phase's lane, drawn behind its subtree. */
export interface LayoutLane {
  /** `lane<nodeId>`: the React Flow node id. */
  id: string;
  /** The phase. */
  nodeId: number;
  x: number;
  y: number;
  w: number;
  h: number;
}

export type LayoutItem =
  | LayoutNodeItem
  | LayoutMoreItem
  | LayoutLineItem
  | LayoutReadersItem
  | LayoutWorkItem
  | LayoutWorkDoneItem
  | LayoutTrailAgentItem;

export interface LayoutResult {
  items: LayoutItem[];
  edges: LayoutEdge[];
  nodeItems: Map<number, LayoutNodeItem>;
  /** One per depth-1 phase, in outline order. Kept out of `items`, so `items` keeps its shape. */
  lanes: LayoutLane[];
  /** The bottom of the last row or lane. */
  height: number;
}
```

**Rules.** One pass over `computeVisible`'s rows, as today.

1. **Item order** stays: a card, then per session (in `live` order) its `line` and then its `readers`, then the
   `workDone`, then the `work` rows, then, opened, the `trailAgent` rows. A session gets a `line` only when
   `lead || agentIds.length > 0`; a session with only readers on a card gets only a `readers` item.
2. **x.** The root: 8. A stack head: 22. Any other row: `(depth + (underStack ? 0 : 1)) * INDENT`, where `underStack`
   is true when the row's depth-1 ancestor is a stack. So a stack's children sit at 56 and theirs at 84; a non-phase
   depth-1 step and the root's own fold rows sit at 56, and a non-phase depth-1 step's children at 84. Row items
   (`line`, `readers`, `workDone`, `work`, `trailAgent`) take their card's `x`; Canvas ignores it.
3. **Lines inside a card.** The first line starts at `y + NODE_H` on a card and `y + STACK_HEAD` on a stack head.
   Each `line` advances `AGENT_LINE`, each `readers` `READERS_LINE`, each `work` and `trailAgent` `TASK_ROW`.
4. **The done row's y.** Take the card's last `line` or `readers` item. If it is a `readers` item, or a `line` with
   empty `agentIds`, the `workDone` takes that item's `y`, `shared: true`, and advances nothing. If it is a `line`
   with kin, or the card has no such item, the `workDone` takes the next `y`, `shared: false`, and advances
   `DONE_LINE`.
5. **Heights.** With `lines` the sum of the advances in rule 3 and 4: a card is `lines ? NODE_H + lines + CARD_PAD :
   NODE_H`; a stack head is `lines ? STACK_HEAD + lines : STACK_HEAD - CARD_GAP` (33).
6. **Next y.** After a card or stack head: `y + h + CARD_GAP`. After a fold row: `y + FOLD_ROW`. A row's bottom is
   `y + h` (card, stack head) or `y + FOLD_ROW - CARD_GAP` (fold row).
7. **Lanes.** Every row at depth 0 or 1 first closes the open lane: its bottom is the last row's bottom plus 12, and
   the next `y` becomes that bottom plus 18. A stack head then opens a lane whose top is the previous bottom (a row's
   or a lane's) plus 18, and sits at `top + 9`. The last lane closes at the end. `height` is the final bottom.
8. **Edges** (ids and endpoints as today). Emit one only when the row's parent is a card at depth 2 or deeper, or a
   non-phase depth-1 step: `depth >= 3 || (depth === 2 && parent.kind !== 'phase')`. Never from the root or a stack
   head.

The walk, as a reference implementation of rules 2, 4, 5, 6, 7 and 8 (Task 3 owns the final code):

```ts
let y = 0;
let bottom = 0;
let lane: { nodeId: number; top: number } | null = null;
let underStack = false;
const closeLane = () => {
  if (!lane) return;
  const laneBottom = bottom + LANE_PAD_BOTTOM;
  lanes.push({ id: `lane${lane.nodeId}`, nodeId: lane.nodeId, x: LANE_X, y: lane.top, w: LANE_W, h: laneBottom - lane.top });
  bottom = laneBottom;
  y = laneBottom + LANE_GAP;
  lane = null;
};
for (const v of visible) {
  const stack = v.type === 'node' && v.depth === 1 && v.node.kind === 'phase';
  if (v.depth <= 1) {
    closeLane();
    underStack = stack;
  }
  if (stack) {
    const top = items.length ? bottom + LANE_GAP : 0;
    lane = { nodeId: v.node.id, top };
    y = top + LANE_PAD_TOP;
  }
  const x = v.depth === 0 ? ROOT_X : stack ? STACK_X : (v.depth + (underStack ? 0 : 1)) * INDENT;
  const parentId = v.type === 'more' ? v.parentId : v.node.parentId;
  const parent = parentId === null ? undefined : index.byId.get(parentId);
  const edge = v.depth >= 3 || (v.depth === 2 && parent?.kind !== 'phase');
  // A fold row: push it (and its edge when `edge`), then bottom = y + FOLD_ROW - CARD_GAP; y += FOLD_ROW; continue.
  // A card or stack head: push it (and its edge), then its lines from y + (stack ? STACK_HEAD : NODE_H):
  //   last = the last line/readers pushed, as { y, kin: agentIds.length > 0 } (readers: kin false);
  //   done row: shared = last !== null && !last.kin; y = shared ? last.y : ly; if (!shared) ly += DONE_LINE;
  //   item.h = stack ? (lines ? STACK_HEAD + lines : STACK_HEAD - CARD_GAP) : lines ? NODE_H + lines + CARD_PAD : NODE_H;
  //   bottom = item.y + item.h; y = bottom + CARD_GAP.
}
closeLane();
// height = bottom
```

**Worked examples.** Checked against a prototype of these rules. The fixture is `sample()` in
`test/core/layout.test.ts:19-29` (root, A with A1 and A2, then B, C, D, E; D and E fold into `more<root>-0`).

1. No sessions, no phases. `[id, x, y, h, w]`: root `[n1, 8, 0, 32, 498]`, A `[n2, 56, 42, 32, 450]`, A1
   `[n3, 84, 84, 32, 422]`, A2 `[n4, 84, 126, 32, 422]`, B `[n5, 56, 168, 32, 450]`, C `[n6, 56, 210, 32, 450]`,
   `more1-0` at `(56, 252)`. Edges `e-n3`, `e-n4` only. `lanes` is empty. `height` 278.
2. The same with A and B of kind `'phase'`. Root `[n1, 8, 0, 32, 498]`, A `[n2, 22, 59, 33, 484]` with `stack: true`,
   A1 `[n3, 56, 102, 32, 450]`, A2 `[n4, 56, 144, 32, 450]`, B `[n5, 22, 215, 33, 484]` with `stack: true`, C
   `[n6, 56, 278, 32, 450]`, `more1-0` at `(56, 320)`. No edges. Lanes `{ id: 'lane2', nodeId: 2, x: 8, y: 50, w: 504,
   h: 138 }` and `{ id: 'lane5', nodeId: 5, x: 8, y: 206, w: 504, h: 54 }`. `height` 346.
3. Example 1 with session `s1` working on A1, holding a running non-reader subagent `x` and two running readers on
   A1, and four tasks on A1 (one completed, three pending). A1 is `[n3, 84, 84, h 154]` with `workingFocus: true`;
   `line` `ls1:3` at y 116 (`lead: true`, `agentIds: ['x']`); `readers` `rs1:3` at y 144; `workDone` `wd3` at y 144,
   `shared: true`; `work` rows at 164, 186 and 208. A2 moves to y 248. `height` 400.
4. Example 3 without the readers: the `line` at 116 holds kin, so `wd3` is at y 144 with `shared: false`, and the
   work rows stay at 164, 186 and 208 (h 154 again: 28 + 20 + 66).
5. Example 2 with an idle session `s1` focused on A: A is `[n2, 22, 59, h 71]`, its `line` `ls1:2` at y 102
   (`lead: true`, `agentIds: []`); A1 at y 140, A2 at 182; lane2 is `y 50, h 176`; B at y 253; lane5 `y 244, h 54`.
   `height` 384.

The spec's two cards: #81 (one agent line) is 32 + 28 + 8 = 68. #127 (an agent line with kin, the readers line with
the done row, three task rows) is 32 + 28 + 20 + 3 × 22 + 8 = 154.

**Breadcrumb** (`web/src/canvas/breadcrumb.ts:7`, Task 3 part B):

```ts
const first = layout.items.find((i): i is LayoutNodeItem => i.kind === 'node' && i.y + i.h > top);
```

**Camera** (Task 6) reads only `item.y + NODE_H / 2` vertically, unchanged. `rowInView` (`sheet.ts:25`) keeps
`NODE_H`.

**Two consequences for Task 6** (Task 3 adds no names, types or files beyond the above):

- When a manual fold hides a working session's focus, the session's lead line moves to the nearest visible ancestor
  (as its badge does today), and that card's `workingFocus` stays `false` ("never its ancestors"). Its `working` is
  `true` and its lead character still reads `work`; only the orange frame and the 15/900 title stay off there.
- Row items (`line`, `readers`, `workDone`, `work`, `trailAgent`) take their card's `x`, so on a stack head they
  carry x 22 (rule 2). Canvas ignores it: a stack head's lines draw at flow x 56 through the canvas region's
  `.ip-card.stack .ip-lines` padding, and its agent line drops its own 6 px there (`.ip-card.stack .ip-badge`), so the
  line and a done row on its own line both start at 56.

### `web/src/live.ts` (Task 3 part A produces; Tasks 4 and 6 consume)

Appended to `live.ts`. The import from `../../src/core/types` gains `sessionTag` and `type SessionState`.
`BadgeNode.tsx` keeps its own local `WORDS` until Task 6 deletes the file; Task 3 does not edit it.

```ts
/** A session's state as a word: on its agent line and in its lead's tooltip. */
export const WORDS: Record<SessionState, string> = { working: 'working', idle: 'idle', permission: 'needs permission', ended: 'ended' };

/** A session chip's accessible name: its letter, then chipLabel. */
export function chipName(s: Session): string;

/** The lead character's tooltip: letter, title, state word, and how many subagents still run (readers included). */
export function leadTitle(s: Session): string;

/** A kin's tooltip and accessible name: `withTag(tag, agentLine(...))`, then a newline and the purpose when known. */
export function kinTitle(a: SubagentInfo, slot: number | null, now: number, underNode: number | null = null): string;

/** A running kin's elapsed time, compact: no spaces, at most five characters. The minutes are elapsed's. */
export function runTime(fromIso: string, now: number): string;
```

Bodies (checked against today's `live.ts`):

```ts
export function chipName(s: Session): string {
  return withTag(sessionTag(s.slot), chipLabel(s));
}

export function leadTitle(s: Session): string {
  const running = s.subagents.filter((a) => a.endedAt === null).length;
  const count = running ? ` · ${running} subagent${running > 1 ? 's' : ''}` : '';
  return withTag(sessionTag(s.slot), `${sessionDisplayTitle(s)} · ${WORDS[s.state]}${count}`);
}

export function kinTitle(a: SubagentInfo, slot: number | null, now: number, underNode: number | null = null): string {
  const line = withTag(agentTag(slot, a.ordinal), agentLine(a, now, underNode));
  return a.purpose ? `${line}\n${a.purpose}` : line;
}

export function runTime(fromIso: string, now: number): string {
  const minutes = Math.floor(Math.max(0, now - Date.parse(fromIso)) / 60_000);
  if (minutes < 1) return '<1m';
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return hours < 10 && rest ? `${hours}h${rest}m` : `${hours}h`;
}
```

Return examples (all checked):

| Call | Returns |
|---|---|
| `chipName` slot 0, title `#4 Implement Fable's Notes`, `permission`, no subagents | `A · #4 Implement Fable's Notes · needs permission` |
| `chipName` slot 2, `#5 UI Session post-Fable`, `working`, 3 running | `C · #5 UI Session post-Fable · 3 subagents` |
| `chipName` slot 1, `#2 InProgress Dev Session`, `idle` | `B · #2 InProgress Dev Session · idle` |
| `chipName` slot null, same | `#2 InProgress Dev Session · idle` |
| `leadTitle` slot 2, `#5 UI Session post-Fable`, `working`, 3 running | `C · #5 UI Session post-Fable · working · 3 subagents` |
| `leadTitle` slot 0, `E2E session`, `idle` | `A · E2E session · idle` |
| `leadTitle` slot 1, `Second session`, `working`, 1 running and 1 ended | `B · Second session · working · 1 subagent` |
| `leadTitle` slot null, `E2E session`, `working` | `E2E session · working` |
| `kinTitle` ordinal 10, `Draft the whiteboard take`, `opus-5-5`, 18 min, purpose, slot 2 | `c10 · Draft the whiteboard take · opus-5-5 · 18 min\nYou draft the whiteboard take of the InProgress window.` |
| `kinTitle` ordinal 11, `Draft the quiet take`, ended 3 min ago, no purpose, slot 2 | `c11 · Draft the quiet take · opus-5-5 · done 3 min ago` |
| `kinTitle` ordinal null, slot 2 | `Draft the whiteboard take · opus-5-5 · 18 min` |
| `kinTitle` ordinal 1, `#57 Wire up RevenueCat`, `sonnet`, 12 min, slot 0, underNode 57 | `a1 · Wire up RevenueCat · sonnet · 12 min` |
| `runTime` at 30 s, 18, 59, 60, 65, 165, 599, 600, 725 min | `<1m`, `18m`, `59m`, `1h`, `1h5m`, `2h45m`, `9h59m`, `10h`, `12h` |

The agent line's label text and its `aria-label` (Task 6, in `AgentLine.tsx`) are this, for example
`A · E2E session · working`:

```ts
withTag(sessionTag(s.slot), `${sessionDisplayTitle(s)} · ${WORDS[s.state]}`)
```

Existing exports (`chipLabel`, `agentLine`, `withTag`, `elapsed`, `trailLabel`, `taskFamily`, `taskOwner`,
`waitsFor`, `workMark`, `queueMark`) do not change.

### `web/src/characterState.ts`, `Character.tsx`, `Marker.tsx` (Task 2 produces; Tasks 4, 5 and 6 consume)

`characterState.ts` is pure and imports only types, so `test/web/character.test.ts` can import it (the root
`tsconfig.json` sets no `jsx` and no DOM lib). The test file and `web/src/character.css` keep their names: no
import resolves to `character.css` without its extension.

Every consumer imports the three modules exactly like this, with no file extension:

```ts
import { Character } from '../Character';           // web/src/Character.tsx
import { characterState } from '../characterState'; // web/src/characterState.ts
import { Marker } from '../Marker';                 // web/src/Marker.tsx
```

```ts
// web/src/characterState.ts
import type { Session, SessionState, SubagentInfo } from '../../src/core/types';

export type CharacterState = 'work' | 'idle' | 'wait' | 'ended';
export type CharacterSize = 16 | 18 | 20 | 24;

const BY_SESSION: Record<SessionState, CharacterState> = { working: 'work', idle: 'idle', permission: 'wait', ended: 'ended' };

/** A session's state as its character's (working, idle, permission give work, idle, wait); a subagent works until it stops. */
export function characterState(who: Pick<Session, 'state'> | Pick<SubagentInfo, 'endedAt'>): CharacterState {
  return 'state' in who ? BY_SESSION[who.state] : who.endedAt === null ? 'work' : 'ended';
}

/** A negative animation-delay in ms, in (-periodMs, 0], from a 32-bit FNV-1a hash of the seed: stable per seed. */
export function phaseDelay(seed: string, periodMs: number): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < seed.length; i++) {
    h ^= seed.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return -(h % periodMs) || 0;
}
```

Examples: `characterState({ state: 'permission' })` is `'wait'`; `characterState({ endedAt: null })` is `'work'`;
`characterState({ endedAt: '2026-10-05T11:57:00Z' })` is `'ended'`. `phaseDelay('s1', 2400)` is `-1449`,
`phaseDelay('s2', 2400)` is `-1392`, `phaseDelay('s1abcdef:a1', 2400)` is `-1210`, `phaseDelay('s1abcdef', 4600)` is
`-3270`.

```ts
// web/src/Character.tsx
export interface CharacterProps {
  size: CharacterSize;
  state: CharacterState;
  /** The family it wears: the root span sets `--fam: familyVar(slot)`. `ended` wears `--gone` whatever the slot. */
  slot: number | null;
  /** Stable per character: phaseDelay hashes it. A session's id for a chip or a lead; `${sessionId}:${agentId}` for a kin. */
  seed: string;
  /** A tooltip on the root span (the lead's: leadTitle). The SVG stays aria-hidden. */
  title?: string;
}
export function Character(props: CharacterProps): JSX.Element;
```

Its DOM, which the e2e reads:

```html
<span class="ip-char c-work" data-state="work" data-size="24" title="…" style="width: 24px; height: 24px; --fam: var(--family-2)">
  <!-- only for state wait: -->
  <span class="ip-char-ring"></span><span class="ip-char-ring2" style="animation-duration: …; animation-delay: …"></span>
  <span class="ip-char-body" style="animation-duration: …; animation-delay: …">  <!-- the style only for work -->
    <svg viewBox="0 0 32 32" aria-hidden="true">
      <!-- body path; for work and wait the eyes sit in: --><g class="ip-char-eyes" style="transform-origin: …; animation-duration: …; animation-delay: …">…</g>
    </svg>
  </span>
</span>
```

`ip-bob` runs on `.ip-char-body` (work only), `ip-blink` on `g.ip-char-eyes` (work and wait), `ip-ring` on
`.ip-char-ring2` (wait only).

- **`data-size`.** The root span carries `data-size="16|18|20|24"` and an inline `style` with `width`, `height` and
  `--fam`. `character.css` reads `[data-size='24']` for the 4 px glow. Nothing else reads it.
- **Motion timing is inline.** `Character.tsx` writes `animation-duration` and `animation-delay` (from `phaseDelay`)
  on `.ip-char-body` (work), `g.ip-char-eyes` (work and wait) and `.ip-char-ring2` (wait), plus the eyes'
  `transform-origin`. Periods: bob 2400 ms, ring 1800 ms, blink 5200 ms while working and 3600 ms while waiting.
  `character.css` names the keyframes, the easing and `infinite`. The blanket reduced-motion rule still stops all
  three, since it sets `animation: none !important`.
- **Character-local properties.** `character.css` declares `--ip-glow-r`, `--ip-glow-mix` and `--ip-ended-opacity` on
  `.ip-char`, with night values in its own `@media (prefers-color-scheme: dark)` block. They are not tokens: the token
  block and the token test stay in `styles.css` alone.

The three uses:

```tsx
// A chip (Task 4), inside .ip-chip-s:
<Character size={18} state={characterState(s)} slot={s.slot} seed={s.id} />
// A lead (Task 6), a direct child of .ip-badge:
<Character size={s.state === 'working' ? 24 : 20} state={characterState(s)} slot={s.slot} seed={s.id} title={leadTitle(s)} />
// A kin (Task 6), inside .ip-agent:
<Character size={16} state={characterState(a)} slot={s.slot} seed={`${s.id}:${a.agentId}`} />
```

```ts
// web/src/Marker.tsx
export interface MarkerProps {
  status: NodeStatus;
  /** node.kind === 'question': the ? disc. A done question keeps the ?. */
  question: boolean;
  /** LayoutNodeItem.paused: the hollow sky ring. */
  paused: boolean;
  /** isNeedsYou(node): the amber dot. */
  needsYou: boolean;
  /** LayoutNodeItem.working: an active marker pulses (ip-pulse). Details passes false. */
  pulse: boolean;
  /** The card passes `Nobody is on this. Last change ${lastChange}` when paused. */
  title?: string;
}
export function Marker(props: MarkerProps): JSX.Element;
```

Its DOM, exactly:

```tsx
<span
  className={['ip-marker', `m-${status}`, question && 'q', paused && 'm-paused', needsYou && 'm-you', pulse && 'm-pulse'].filter(Boolean).join(' ')}
  title={title}
>
  {question ? '?' : status === 'done' ? '✓' : ''}
</span>
```

- The Marker's look lives in `web/src/character.css` (Task 2), which `Marker.tsx` imports. Every Marker rule has at
  least two classes (`.ip-marker.m-active`), so it wins over the old canvas rules until Task 6 deletes them:
  `character.css` loads after `styles.css` in the bundle.
- It keeps the e2e reads: a paused marker has `background-color: rgba(0, 0, 0, 0)` and `border-top-color` of
  `--sky` (day `rgb(2, 132, 199)`); an active one has `background-color` of `--active` (day `rgb(194, 65, 12)`);
  `.ip-node.working .ip-marker.m-active` exists on a working card (T284 l.289).
- Task 6 deletes the old marker rules from the canvas region (`styles.css:135-146` at `0b786b8`, including
  `.ip-node.needs-you .ip-marker`, `.ip-node.working .ip-marker.m-active` and `.ip-node.paused .ip-marker`). Task 5
  adds no marker rules.
- **Precedence**, where the spec's marker table leaves a combination open. Needs-you draws the amber dot over any
  status, a blocked one included (as today). Paused draws the sky ring over the active dot. A question keeps its
  13 px disc whatever its status: paused makes it a hollow sky ring with a sky `?`, and needs-you turns the disc amber
  with its `?` in `var(--bg)`. Paused and needs-you never meet: paused needs `assignee: 'claude'` (`layout.ts:411`),
  needs-you `assignee: 'me'` (`tree.ts:31-33`).
- **Details' props.** Details passes `paused={false}`, `pulse={false}` and no `title`, for its status and for every
  step. It has no layout item, so a paused step shows its plain status marker there, as today's pill and step list do.
- The `ip-bob`, `ip-blink` and `ip-ring` keyframes live in `character.css`. `ip-pulse` (end of the tokens region) and
  `ip-flash` (canvas region) stay in `styles.css`.

### `web/src/chrome/chips.ts` (Task 4 produces and alone consumes)

```ts
/**
 * The session row's order: by slot, so by letter (A, B, C…), whatever order the server lists them in. Sessions with
 * no slot yet go after every lettered one, in the order they were given. Returns a new array.
 */
export function chipOrder<T extends Pick<Session, 'slot'>>(sessions: readonly T[]): T[];
```

Unit cases in `test/web/chips.test.ts` (Task 4). The chip's popover id becomes `ip-chip-pop-<sessionId>`.

### Canvas components (Task 6 produces and alone consumes)

- **`web/src/canvas/pitch.ts`** exports `PITCH: Record<string, string>`, the eleven pitch properties below. It is a
  `.ts` module so `test/web/pitch.test.ts` can import it: the root `tsconfig.json` has no `jsx` and cannot load
  `Canvas.tsx`. Canvas writes `style={PITCH as CSSProperties}` on `div.ip-canvas`.
- **Props**, all in `web/src/canvas/`: `AgentLineProps` (`AgentLine.tsx`), `ReadersRowProps`, `WorkRowProps`,
  `WorkDoneRowProps`, `TrailAgentRowProps`, and `CardRow` (`NodeCard.tsx`), the union of one line inside a card.
  `NodeCardData` gains `x`, `w`, `h`, `stack`, `workingFocus` and `rows: CardRow[]`. A done row that shares a line
  rides on that line's `done` prop (`WorkDoneRowProps | null` on `AgentLineProps` and `ReadersRowProps`).
- **Camera** (`useCamera.ts`): `centerOnPoint(x, y)` becomes `centerOnY(y)`; new `hasMoved(): boolean`, which guards
  the first move held for `document.fonts.ready`.
- **Wording the spec leaves open, settled.** A lead-less line's accessible name is
  `withTag(letter, 'subagents of ' + title)`, for example `A · subagents of E2E session`. The `+n` tooltip is one
  `withTag(tag, agentLine(agent, now, nodeId))` line per hidden kin.
- **The implementer's calls, taken** (spec "Left to the implementer"): the lead keeps a fixed 24 px slot (a 20 px lead
  gets 2 px of margin each side); dropped cards have no fill, like done; the selected ring is 2 px `--text-2` outside
  the frame; the frame reads the header's state from classes NodeCard sets on both, not `:has()`; a framed card's
  own-line done row starts under the title (30 px in), a stack's at flow x 56; the root's title stays heavy (900, at
  M); a lane's gap to a row outside lanes is 18 px; the gap after a stack head's own lines is `CARD_GAP` (10).
- **e2e helpers** in `test/e2e/ui.spec.ts`, right after `RUNNING` (l.1083): `RUN_TIME = '(<1m|\\d+m)'`,
  `frameOf(header: Locator)` (the header's parent, `xpath=..`) and `expectInside(box, frame, what?)`.
- `web/src/canvas/MoreNode.tsx` does not change: its look is all CSS.

### CSS custom properties

**Pitch** (Task 6 defines them in `web/src/canvas/pitch.ts`, Canvas writes them as the `style` of
`div.ip-canvas`, and the canvas region reads them).

| Constant | Property | The canvas rule that reads it |
|---|---|---|
| `NODE_H` | `--node-h` | `.ip-card > .ip-node` (the framed header): `height: calc(var(--node-h) - 2px)`; `.ip-node.stack`: `height: var(--node-h)` |
| `CARD_GAP` | `--card-gap` | `.ip-more`: `height: calc(var(--fold-row) - var(--card-gap))` |
| `ROW` | `--row` | none yet |
| `FOLD_ROW` | `--fold-row` | `.ip-more` |
| `AGENT_LINE` | `--agent-line` | `.ip-badge` |
| `READERS_LINE` | `--readers-line` | `.ip-readers` |
| `DONE_LINE` | `--done-line` | `.ip-lines > .ip-work-done` (the done row on its own line) |
| `TASK_ROW` | `--task-row` | `.ip-card .ip-work`, `.ip-trail-agent` |
| `CARD_PAD` | `--card-pad` | `.ip-card .ip-lines`: `padding-bottom` |
| `INDENT` | `--indent` | none yet |
| `STACK_HEAD` | `--stack-head` | `.ip-card.stack .ip-lines`: `margin-top: calc(var(--stack-head) - var(--node-h))` |

```ts
// web/src/canvas/pitch.ts (Task 6)
export const PITCH: Record<string, string> = {
  '--node-h': `${NODE_H}px`, '--card-gap': `${CARD_GAP}px`, '--row': `${ROW}px`, '--fold-row': `${FOLD_ROW}px`,
  '--agent-line': `${AGENT_LINE}px`, '--readers-line': `${READERS_LINE}px`, '--done-line': `${DONE_LINE}px`,
  '--task-row': `${TASK_ROW}px`, '--card-pad': `${CARD_PAD}px`, '--indent': `${INDENT}px`, '--stack-head': `${STACK_HEAD}px`,
};
// Canvas.tsx: <div className="ip-canvas" ref={root} onFocus={onFocus} style={PITCH as CSSProperties}>
```

The pitch test (`test/web/pitch.test.ts`) reads the canvas region of `styles.css` and checks the ten rules of the
table: `.ip-card > .ip-node`, `.ip-node.stack`, `.ip-badge`, `.ip-readers`, `.ip-lines > .ip-work-done`,
`.ip-card .ip-work`, `.ip-trail-agent` and `.ip-more` by their `height`, `.ip-card .ip-lines` by its
`padding-bottom` and `.ip-card.stack .ip-lines` by its `margin-top`. It fails when one is missing or is a literal
length. A value passes when it is `var(--<pitch>)` or a `calc()` that starts from one; the `- 2px` for the frame's two
1 px borders is the only other number allowed.

NodeCard renders `div.ip-lines` only on a card that has lines, so a one-line card is 32 px. The frame `div.ip-card`
takes `height: h` and `width: w` inline, and the React Flow node gets `width: w, height: h` (lanes: their `w`, `h`).

**Tokens** (Task 1 produces). The names and values in the Global Constraints tables. Inline per-element
properties: `--fam` (a family hue, `familyVar(slot)`) and `--x` (a card's flow x, set by NodeCard for the queue
gutter). The token test (`test/web/tokens.test.ts`) reads `styles.css` with its comments stripped and fails when:

- a colour token in `:root` has no value in the dark block, or the dark block declares a token `:root` lacks;
- a theme-free token (`--radius`, `--hairline`, `--font-sans`, `--font-mono`, `--fs-l`, `--fs-m`, `--fs-s`,
  `--w-text`, `--w-heavy`, `--track-l`) appears in the dark block, or differs from its Global Constraints value;
- a colour token's day or night value differs from the Global Constraints tables, or `:root` declares a token that is
  in neither table and is not `--family-0` to `--family-5` (the hues stay pinned in `family.test.ts`);
- the stylesheet declares or reads `--accent`, `--edge`, `--green`, `--purple` or `--clay`;
- a `font-weight` is anything but `500`, `900`, `var(--w-text)`, `var(--w-heavy)` or `inherit`;
- a `font-size` is anything but `15px`, `12.5px`, `11px`, `var(--fs-l)`, `var(--fs-m)`, `var(--fs-s)`, `inherit` or
  an `em` size (the `⛁` tweak is `1.33em`). A `font` shorthand is not checked.

Tasks 4, 5 and 6 keep their regions to these weights and sizes. `character.css` follows the same rule, though the
test does not read it (Task 7's leftover search does).

### Class hooks

| Kind | Hooks | Owner |
|---|---|---|
| New, chrome | `.ip-need-dot`, `.ip-upnext-lines` | 4 |
| New, chrome only (no other task reads them) | `.ip-chip-word` (the chip's `needs permission`), `.ip-upnext-id`, `.ip-upnext-title`, `.ip-upnext-sep` (inside an Up next line), `.ip-act-who`, `.ip-act-when`, `.ip-act-what` (the activity strip's parts) | 4 |
| New, canvas | `.ip-card`, `.ip-lines`, `.ip-agent-time`, `.ip-work-col`, `.ip-node.stack`, `.react-flow__node-ipLane`, and the stack head's track `.ip-track` holding `.ip-track-fill` | 6 |
| New, canvas, Task 6's own | `.ip-node-col` (a framed header's 22 px marker column), `.ip-badge-label` (`display: contents`), `.ip-badge-title`, `.ip-badge-sep`, `.ip-badge-word` (the agent line's label), `.ip-agent-more` (`+n`), `.ip-readers-text` (the readers' own words inside `.ip-readers`), `.ip-work-done-label` (the done row's label). The frame `div.ip-card` carries `st-<status>`, `stack`, `focus` (the working focus), `flash` and `selected`, set by NodeCard beside the same states on `.ip-node` | 6 |
| New, Details | `.ip-kid-mark` (the steps list's 13 px marker column), `.ip-log-time`, `.ip-log-text` | 5 |
| New, character | `span.ip-char`, `.c-work`, `.c-idle`, `.c-wait`, `.c-ended`, `[data-state]`, `[data-size]`, `.ip-char-ring`, `.ip-char-ring2`, `.ip-char-body`, `g.ip-char-eyes` | 2 |
| New, marker | `.m-paused`, `.m-you`, `.m-pulse` on `span.ip-marker` (beside `m-<status>` and `q`) | 2 |
| Node type | `ipLane` added; `ipNode`, `ipMore` kept; `ipBadge`, `ipAgent`, `ipReaders`, `ipWork`, `ipWorkDone`, `ipTrailAgent` dropped | 6 |
| Removed | `.ip-chip-label`, `.ip-chip-lead`, the chip's `.ip-pulse` and the `.ip-pulse` rule (4); `.ip-pill` (5); `BadgeNode.tsx`'s `.ip-pulse` dot, with the file (6) | 4, 5, 6 |
| Shared, each region styling its own use | `.ip-label` is one unscoped base rule in the Details and viewer region (Task 5); the archived menu (Task 4) keeps only its own `.ip-menu .ip-label` margin. Details scopes the row classes it shares with the canvas and the chrome under its own parents (`.ip-wt .ip-work-mark`, `.ip-wt .ip-work-tag`, `.ip-wt .ip-work-agent`, `.ip-dagent .ip-agent-tag`, `.ip-dagent .ip-reader-mark`, `.ip-meta .ip-glyph`, `.ip-details .ip-you`), so Task 6 may scope its row rules under `.ip-card` and Task 4 may restyle `.ip-reader-mark` without changing Details | 4, 5, 6 |
| Kept, with their role | every hook the spec lists under "Hooks kept" in sections 2, 3 and 6. `.ip-badge` is the agent line (`role="group"`), `.ip-agent` is a kin (`role="img"`, keeps `.ended`), `.ip-node` is the header (`role="button"`, every state class) | all |

### e2e titles and new unit test files

- New, Task 6, in the `Live work` block: `a step's agents and tasks sit inside its card: one line per session with its character and kin, the done row at the line's end, a lane per phase`. Run alone with `-g "a step's agents and tasks sit inside its card"`.
- Rewritten T1028, Task 4: `a session chip is its character and letter: its name carries the title, and waiting for permission rings it in amber`. Run alone with `-g "a session chip is its character and letter"`.
- New unit test files: `test/web/tokens.test.ts` (Task 1), `test/web/character.test.ts` (Task 2),
  `test/web/chips.test.ts` (Task 4), `test/web/pitch.test.ts` (Task 6).
- The e2e suite has 50 tests at `0b786b8` and 51 after Task 6. Tasks 1, 4 and 5 add none (Task 4 rewrites T1028 in
  place).

### Who consumes what

| Task | Consumes | Produces |
|---|---|---|
| 1 | the spec's token tables | every token name; the fonts; the region comments; the `ip-pulse` keyframes in the tokens region; `test/web/tokens.test.ts` |
| 2 | tokens (1) | `characterState`, `phaseDelay`, `CharacterState`, `CharacterSize` (`characterState.ts`); `Character`, `CharacterProps`; `Marker`, `MarkerProps`; `character.css` |
| 3 A | `chipLabel`, `agentLine`, `withTag` (today's `live.ts`) | `WORDS`, `chipName`, `leadTitle`, `kinTitle`, `runTime` |
| 3 B | today's `layout.ts` | the pitch constants, `LayoutLineItem`, `LayoutLane`, the new `LayoutNodeItem` and `LayoutWorkDoneItem` fields, `LayoutResult.lanes`, the breadcrumb rule |
| 4 | `Character`, `characterState` (2); `chipName`, `WORDS` (3 A); tokens (1) | the chrome; `chipOrder`; T1028's new title |
| 5 | `Marker` (2); tokens (1) | Details and the viewer; the `.ip-label` base rule |
| 6 | everything from 1, 2, 3 A and 3 B | the canvas; `PITCH` and the pitch properties; the canvas components and props; `centerOnY`, `hasMoved`; the e2e helpers; the new canvas test |
| 7 | every branch; the e2e titles; the token names | the merge into `main`, the deploy, the amended review-actions note |

## Branches and worktrees

**Before Task 1 (controller).** Commit this plan to `main`, so every worktree holds it.

```bash
git -C /c/personal/InProgress add docs/superpowers/plans/2026-10-05-quiet-restyle.md
git -C /c/personal/InProgress commit -m "Plan: the Quiet restyle (#81)" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

**The integration branch** is `quiet-restyle`, in its own worktree. `.claude/worktrees/` is excluded in
`.git/info/exclude`.

```bash
git -C /c/personal/InProgress worktree add /c/personal/InProgress/.claude/worktrees/quiet-restyle -b quiet-restyle main
cd /c/personal/InProgress/.claude/worktrees/quiet-restyle && npm ci --prefer-offline --no-audit --no-fund
```

**One branch and worktree per task**, each cut from `quiet-restyle` when its wave starts:

| Task | Worktree under `/c/personal/InProgress/.claude/worktrees/` | Branch | Cut from | `INPROGRESS_E2E_PORT` |
|---|---|---|---|---|
| integration | `quiet-restyle` | `quiet-restyle` | `main` | 4397 |
| 1 | `quiet-t1` | `quiet/t1-tokens` | `quiet-restyle` (wave 0) | 4391 |
| 2 | `quiet-t2` | `quiet/t2-glyphs` | `quiet-restyle` after Task 1 merges | 4392 |
| 3, part A | `quiet-t3-live` | `quiet/t3-live` | `quiet-restyle` after Task 1 merges | 4393 |
| 3, part B | `quiet-t3-layout` | `quiet/t3-layout` | `quiet-restyle` after Task 1 merges | 4393 |
| 4 | `quiet-t4` | `quiet/t4-chrome` | `quiet-restyle` after wave 1 merges | 4394 |
| 5 | `quiet-t5` | `quiet/t5-details` | `quiet-restyle` after wave 1 merges | 4395 |
| 6 | `quiet-t6` | `quiet/t6-canvas` | `quiet-restyle` after wave 1 merges, then `quiet/t3-layout` merged in | 4396 |
| 7 preview server | none | none | none | server on 4398 |

Create a task worktree (Task 2 shown; the others swap the name, branch and wave):

```bash
git -C /c/personal/InProgress worktree add /c/personal/InProgress/.claude/worktrees/quiet-t2 -b quiet/t2-glyphs quiet-restyle
cd /c/personal/InProgress/.claude/worktrees/quiet-t2 && npm ci --prefer-offline --no-audit --no-fund
```

Expected: `Preparing worktree (new branch 'quiet/t2-glyphs')`, then npm reports the packages it added. If `npm ci`
fails offline, run `npm ci --no-audit --no-fund` (Task 1's new `@fontsource` packages may not be in the cache yet).

**Task 6's start.** Task 6 builds on Task 3's layout commits, so its first action merges them:

```bash
git -C /c/personal/InProgress worktree add /c/personal/InProgress/.claude/worktrees/quiet-t6 -b quiet/t6-canvas quiet-restyle
git -C /c/personal/InProgress/.claude/worktrees/quiet-t6 merge --no-ff quiet/t3-layout -m "Merge Task 3's layout into the canvas branch (#81)" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
cd /c/personal/InProgress/.claude/worktrees/quiet-t6 && npm ci --prefer-offline --no-audit --no-fund
```

Expected: a merge with no conflicts. `npm run typecheck` fails right after it (`Canvas.tsx` still reads `badge` and
`agent` items); Task 6's own steps make it pass.

**Waves and merge order.**

| Wave | Runs in parallel | Merged into `quiet-restyle` at the end of the wave |
|---|---|---|
| 0 | Task 1 | `quiet/t1-tokens` |
| 1 | Task 2, Task 3 part A, Task 3 part B | `quiet/t2-glyphs`, then `quiet/t3-live`. Never `quiet/t3-layout` on its own. |
| 2 | Tasks 4, 5 and 6 | nothing; Task 7 merges them |
| 3 | Task 7 | `quiet/t4-chrome`, then `quiet/t5-details`, then `quiet/t6-canvas` (which carries `quiet/t3-layout`); then `quiet-restyle` into `main` |

- Wave 1 shares no files: Task 2 owns the new glyph files, part A `live.ts`, part B `layout.ts` and `breadcrumb.ts`.
- Part B never merges alone. `Canvas.tsx` still switches on `badge` and `agent` and reads `item.agentId`
  (`Canvas.tsx:150-158`), so the `line` item alone fails `npm run typecheck` (`tsc -p web/tsconfig.json` includes
  `../src/core`), and today's 24 px `.ip-node` would sit 4 px off the camera's new `NODE_H / 2`, past
  `expectLifted`'s 3 px. Part B's own gate is `npx tsc -p tsconfig.json` and `npm test`.
- Tasks 4 and 5 run on today's layout. Merge chrome and Details before canvas, and rerun the canvas e2e after.
- The critical path is 1, 3 B, 6, 7. Start Task 6 as soon as Task 2 and Task 3 are done.

A wave merge (the controller, in the integration worktree; Task 1 shown):

```bash
git -C /c/personal/InProgress/.claude/worktrees/quiet-restyle merge --no-ff quiet/t1-tokens -m "Merge Quiet Task 1: tokens and fonts (#81)" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
cd /c/personal/InProgress/.claude/worktrees/quiet-restyle && npm ci --prefer-offline --no-audit --no-fund && npm run typecheck && npm test
```

Expected: `Merge made by the 'ort' strategy.`, a clean typecheck and every unit test passing. Subjects for the other
wave merges: `Merge Quiet Task 2: shared glyphs (#81)` and `Merge Quiet Task 3: copy helpers (#81)`.

**`styles.css` regions.** Task 1 heads each region with the comment shown, so later tasks find their region by
name (`grep -n "Region:" web/src/styles.css`).

| Region | Lines at `0b786b8` | Owner | Head comment |
|---|---|---|---|
| Tokens: `:root`, the dark block, `*`, `html, body, #root`, `body`, `button`, `.muted`, and last `@keyframes ip-pulse` (moved in from `:116`) | `:1-47` | Task 1 only | `/* Region: tokens. Task 1 only. */` |
| Chrome, including `.ip-banner` and `.ip-empty` (`:119-120`), less what Task 1 moves out | `:48-120` | Task 4 | `/* Region: chrome. Task 4. */` |
| Canvas, plus what Task 1 moves in | `:121-198` | Task 6 | `/* Region: canvas. Task 6. */` |
| Details and the viewer, less what Task 1 moves out | `:199-239` | Task 5 | `/* Region: Details and viewer. Task 5. */` |
| Reduced motion | `:240-244` | Task 1 only | `/* Region: reduced motion. Task 1 only. */` |
| `web/src/character.css` (new file) | none | Task 2 | none |

In wave 0, Task 1 also re-points every use of a renamed or removed token in every region and at `Canvas.tsx:237`,
sets every weight and size, and moves these rules to their owner's region, splitting selector lists:

- From the chrome range `:90-99`: `.ip-agent-tag` (`:91`) to the canvas region. `.ip-dagent.ended .ip-agent-tag`
  (`:92`), `.ip-agent-dot` (`:94`), `.ip-dagent.ended` and `.ip-dtrail` (`:95`) and `.ip-dpurpose` (`:99`) to the
  Details region. The popover's halves of `:92` and `:95`, and `.ip-reader-mark` (`:97`), stay in chrome.
- From the Details range: `.ip-row > .ip-chip { display: none; }` and `.ip-res-count { display: inline-block; }`
  (`:205-206`) to the canvas region, under their own `@media (max-width: 719px)`, after the `.ip-chip` and
  `.ip-res-count` rules.
- The static flash ring (`:243`) to the canvas region, next to the flash rule, under its own
  `@media (prefers-reduced-motion: reduce)`.
- `:114` splits. `.ip-chip-s.s-permission .ip-tag` stays in the chrome region. `.ip-badge.s-permission .ip-tag`
  moves to the canvas region, right after `.ip-badge.s-permission`. Task 4 removes the chip half with its region, and
  Task 6 the badge half with its region, so the two never edit the same line.
- `@keyframes ip-pulse` (`:116`) to the end of the tokens region.

**Where things sit after Task 1.** The region heads are at lines 1, 98, 166, 258 and 307 of `web/src/styles.css`.
`.ip-agent-tag` is in the canvas region, after `.ip-agent.ended, .ip-trail-agent`. `.ip-dagent.ended .ip-agent-tag`,
`.ip-agent-dot`, `.ip-dagent.ended, .ip-dtrail` and `.ip-dpurpose` are in the Details region, after
`.ip-wt .ip-work-agent`. The narrow-window chip toggle has its own `@media (max-width: 719px)` block in the canvas
region, right after `.ip-res-count`. The static flash ring has its own `@media (prefers-reduced-motion: reduce)` block
in the canvas region, right after `@keyframes ip-flash`.

**What Task 1 leaves to the region owners.** Outside the tokens and reduced-motion regions, Task 1 changes only sizes
(`var(--fs-*)`), weights (`var(--w-*)`), uses of the removed tokens, `#fff` ink on filled marks (now `var(--bg)`) and
the four amber `color-mix` fills (now `var(--amber-fill)`), plus explicit weights for `<b>` and Markdown `strong`. The
owners handle the rest: surfaces (`--bar`, `--card`, `--float`, `--lane`), line heights, tracking, DM Mono, radii,
borders, `.ip-chip-s.s-working`'s `#fff` (Task 4), the Details log's italic, Markdown headings and `th` (Task 5).

**Rules that leave the chrome region in wave 2.** Task 4 replaces its whole region, which deletes the chip half of
`:114` and `.ip-pulse` (`:115`). The last user of `.ip-pulse` after Task 4 is `BadgeNode.tsx:26`, which Task 6
deletes. Until Task 6 lands, today's focus badge has no pulse dot; no test reads it. Its letter keeps the family hue
while it waits for permission, since the badge half of `:114` sits in the canvas region. Task 6 edits nothing in the
chrome region.

---

## Tasks

### Task 1: Tokens and fonts

Size M, wave 0. Task 1 runs alone, before any other branch is cut, so it may touch every region of `styles.css`.
Branch `quiet/t1-tokens` in the worktree `/c/personal/InProgress/.claude/worktrees/quiet-t1`, cut from
`quiet-restyle`. Its e2e port is `4391`. Line numbers below are at `0b786b8` unless a step says otherwise.

**What this task changes, and what it leaves.**

- Outside the tokens and reduced-motion regions, Task 1 makes the rule moves listed under "`styles.css` regions"
  (Branches and worktrees: the chrome and Details moves, the split of `:114`, the static flash ring, and
  `@keyframes ip-pulse` to the end of the tokens region), and changes only these four things:
  - each `font-size` becomes `var(--fs-l)`, `var(--fs-m)` or `var(--fs-s)` (the `⛁` tweak stays `1.33em`);
  - each `font-weight` becomes `var(--w-text)` (500) or `var(--w-heavy)` (900);
  - each use of a removed token points at the token the spec names for that use (table below);
  - hard-coded `#fff` ink on a filled mark becomes `var(--bg)` (the markers, the focus badge, agent badges and the
    Details pill), and the four inline `color-mix(in srgb, var(--amber) 14%, transparent)` fills become
    `var(--amber-fill)`.
- It also gives every `<b>` and Markdown `strong` an explicit weight, in the Details region: `.ip-res b` 500; the
  header titles (`Details.tsx:196, 216`, `ResourceViewer.tsx:45`), `.ip-outcome b` (`Details.tsx:241`) and Markdown
  `strong` and `b` 900.
- 900 goes to: the archive button, `.ip-tag`, the Up next head and lead, the root card, the marker's `?`, `YOU`, the
  queue numeral, the Details pill and the header titles. Every other 600, 700 and 800 becomes 500. L goes to the
  queue numeral and the Details and viewer headers, as sections 3 and 6 of the spec have them.
- Left to the region owners: surfaces (`--bar`, `--card`, `--float`, `--lane`), borders, radii, line heights,
  letter-spacing and word-spacing, DM Mono on any rule, layout, the hairline rule `.ip-app::before` (Task 4),
  `.ip-chip-s.s-working`'s `#fff` (Task 4 removes the rule; the spec relies on it until then), the Details log's
  italic, Markdown headings and `th` (Task 5), and the `ip-bob`, `ip-blink` and `ip-ring` keyframes (Task 2, in
  `character.css`, as the Interface contract has them, though spec section 1 lists them with the tokens).
- The window looks transitional after this task: active cards keep a 2 px border, now orange; resource chips are
  muted boxes; the tab count is still an amber pill. That is expected. The owners restyle those rules in wave 2.

Re-pointed uses of removed tokens:

| Line | Rule | Was | Now |
|---|---|---|---|
| `:57` | `.ip-tab[aria-selected='true']` underline | `--accent` | `--text` |
| `:58`, `:109`, `:197` | focus rings (tab, Up next item, done row) | `--accent` | `--text-2` |
| `:62` | `.ip-tab-dot` | `--clay` | `--text-2` |
| `:73` | `.ip-follow.on` | `--accent` border and text | `--text` border, `--text-2` text |
| `:79`, `:106`, `:111`, `:114`, `:158`, `:159`, `:170` | `var(--fam, var(--clay))` fallbacks | `--clay` | `var(--fam, var(--family-0))` |
| `:108` | `.ip-upnext-item:hover` | `--accent` | `--muted` (a neutral change; Task 4 picks the final one) |
| `:128` | `.ip-node.st-active` 2 px border | `--accent` | `--active` (Quiet drops it; Task 6 removes the rule) |
| `:132` | `.ip-node.selected` ring | `--accent` | `--text-2` |
| `:137`, `:156`, `:182`, `:214` | done dot, `✓ n done` mark, completed task mark, done pill | `--green` | `--muted` |
| `:138`, `:215` | active marker, active pill | `--accent` | `--active` |
| `:146` | paused ring and its `?` | `--accent` | `--sky` |
| `:151`, `:153`, `:219` | resource chip, `▤ n`, Details resource | `--purple` | `--muted` |
| `:169` | unowned queue numeral | `--accent` | `--text-2` |
| `:181` | in-progress `◐` | `--accent` | `--active-ink` |
| `:217` | `.ip-link` | `--accent` | `--link` |
| `Canvas.tsx:237` | edge stroke | `--edge` | `--border` (width stays 1.2; Task 6 sets 1) |

**Files:**
- Create: `test/web/tokens.test.ts`
- Modify: `web/src/styles.css`, every region, in five range replacements: `:240-244`, `:199-239`, `:121-198`,
  `:48-120`, `:1-47`
- Modify: `web/src/canvas/Canvas.tsx:237` (the token only)
- Modify: `web/src/family.ts:1, 6` (comments only)
- Modify: `web/src/main.tsx:4-5` (three font imports between them)
- Modify: `package.json`, `package-lock.json` (by `npm i`)
- Modify: `test/web/family.test.ts:39-43`
- Modify: `test/e2e/ui.spec.ts`: T247 l.259, T284 l.284-299 (l.291, l.298 and the ground, `Inter` and font-request
  checks), T465 l.477 and l.484, T1142 l.1199, T1203 l.1225, T1294 l.1314, l.1329, l.1339 and l.1345, T1380 l.1407
  and l.1422, T1445 l.1477 and l.1490. Lines 1314, 1339 and 1407 are comments that name the old hues.
- Unchanged, checked in Step 19: `web/vite.config.ts` (the latin font files are over Vite's 4 KB inline limit)
- Test: `test/web/tokens.test.ts`, `test/web/family.test.ts`; e2e T247, T284, T465, T1142, T1203, T1294, T1380, T1445,
  then the whole suite

**Interfaces:**
- Consumes: `web/src/styles.css`, `test/web/family.test.ts` and `test/e2e/ui.spec.ts` at `0b786b8`; the token tables
  and theme-free values of the Global Constraints.
- Produces:
  - In `:root` (day) and the dark block (night): `--bg`, `--text`, `--text-2`, `--muted`, `--faint`, `--border`,
    `--bar`, `--card`, `--active-fill`, `--lane`, `--float`, `--panel`, `--shadow`, `--panel-2`, `--track`,
    `--track-fill`, `--active`, `--active-ink`, `--active-line`, `--sky`, `--link`, `--amber`, `--amber-ink`,
    `--amber-fill`, `--red`, `--gone`, `--family-0` to `--family-5`.
  - In `:root` only: `--radius`, `--hairline`, `--font-sans`, `--font-mono`, `--fs-l`, `--fs-m`, `--fs-s`,
    `--w-text`, `--w-heavy`, `--track-l`.
  - Gone: `--accent`, `--edge`, `--green`, `--purple`, `--clay`.
  - `@keyframes ip-pulse` (opacity 1, .35, 1) in the tokens region; `@keyframes ip-flash` stays in the canvas region.
  - The reduced-motion region: `* { animation: none !important; }` and nothing else.
  - The five region heads: `/* Region: tokens. Task 1 only. */`, `/* Region: chrome. Task 4. */`,
    `/* Region: canvas. Task 6. */`, `/* Region: Details and viewer. Task 5. */`,
    `/* Region: reduced motion. Task 1 only. */`.
  - The faces `'Inter'` 500 and 900 and `'DM Mono'` 500, imported in `web/src/main.tsx` and emitted by Vite as hashed
    `.woff2` and `.woff` files. No rule uses `--font-mono` yet, so DM Mono loads only once Tasks 4 to 6 use it.
  - `test/web/tokens.test.ts`, as the Interface contract's "Tokens" paragraph lists its checks.

- [ ] **Step 1: Create the worktree**

```bash
git -C /c/personal/InProgress worktree add /c/personal/InProgress/.claude/worktrees/quiet-t1 -b quiet/t1-tokens quiet-restyle
cd /c/personal/InProgress/.claude/worktrees/quiet-t1 && npm ci --prefer-offline --no-audit --no-fund
git -C /c/personal/InProgress/.claude/worktrees/quiet-t1 log --oneline -1
```

Expected: `Preparing worktree (new branch 'quiet/t1-tokens')`, then npm reports the packages it added, then the log
line `<sha> Plan: the Quiet restyle (#81)`.

- [ ] **Step 2: Write the token test**

Create `test/web/tokens.test.ts`:

```ts
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

/** The stylesheet with its comments taken out, so a comment can never pass for a rule. */
const css = readFileSync('web/src/styles.css', 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');

/** The custom properties a block declares: name (without the --) to value. */
function tokens(body: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  for (const m of (body ?? '').matchAll(/--([\w-]+)\s*:\s*([^;]+);/g)) out[m[1]] = m[2].trim();
  return out;
}

/** The first :root block holds the day; the one inside the dark media query holds the night. */
const day = tokens(/:root\s*\{([^}]*)\}/.exec(css)?.[1]);
const night = tokens(/@media \(prefers-color-scheme: dark\)\s*\{\s*:root\s*\{([^}]*)\}/.exec(css)?.[1]);

/** One value for day and night: these live in :root only. */
const THEME_FREE: Record<string, string> = {
  radius: '8px',
  hairline: 'linear-gradient(97deg, #6366f1, #ff6600)',
  'font-sans': "'Inter', system-ui, 'Segoe UI', 'Segoe UI Symbol', sans-serif",
  'font-mono': "'DM Mono', ui-monospace, 'Cascadia Code', Consolas, monospace",
  'fs-l': '15px',
  'fs-m': '12.5px',
  'fs-s': '11px',
  'w-text': '500',
  'w-heavy': '900',
  'track-l': '-0.05em',
};

/** Quiet's colour tokens as [day, night]. The family hues are pinned in family.test.ts. */
const QUIET: Record<string, [string, string]> = {
  bg: ['#f8fafc', '#080d1c'],
  text: ['#0f172a', '#f1f5f9'],
  'text-2': ['#1e293b', '#e2e8f0'],
  muted: ['#475569', '#94a3b8'],
  faint: ['#64748b', '#64748b'],
  border: ['rgba(15,23,42,.11)', 'rgba(255,255,255,.09)'],
  bar: ['#ffffff', 'rgba(255,255,255,.018)'],
  card: ['#ffffff', 'rgba(255,255,255,.035)'],
  'active-fill': ['#fffaf6', 'rgba(249,115,22,.045)'],
  lane: ['rgba(15,23,42,.018)', 'rgba(255,255,255,.022)'],
  float: ['rgba(248,250,252,.94)', 'rgba(8,13,28,.92)'],
  panel: ['#ffffff', '#0c1227'],
  shadow: ['0 8px 24px rgba(15,23,42,.16)', '0 8px 24px rgba(0,0,0,.55)'],
  'panel-2': ['rgba(15,23,42,.05)', 'rgba(255,255,255,.06)'],
  track: ['rgba(15,23,42,.08)', 'rgba(255,255,255,.08)'],
  'track-fill': ['rgba(71,85,105,.5)', 'rgba(148,163,184,.55)'],
  active: ['#c2410c', '#f97316'],
  'active-ink': ['#c2410c', '#fb923c'],
  'active-line': ['rgba(234,88,12,.55)', 'rgba(249,115,22,.5)'],
  sky: ['#0284c7', '#38bdf8'],
  link: ['#0369a1', '#38bdf8'],
  amber: ['#d97706', '#fbbf24'],
  'amber-ink': ['#92400e', '#fcd34d'],
  'amber-fill': ['rgba(251,191,36,.18)', 'rgba(251,191,36,.12)'],
  red: ['#b91c1c', '#f87171'],
  gone: ['#64748b', '#94a3b8'],
};

const isFamily = (name: string) => /^family-\d$/.test(name);

describe('theme tokens', () => {
  it('follows the system theme: day in :root, night in the one dark block', () => {
    expect(css).toMatch(/:root\s*\{[^}]*color-scheme:\s*light dark;/);
    expect(css.match(/@media \(prefers-color-scheme: dark\)/g)).toHaveLength(1);
    expect(Object.keys(day).length).toBeGreaterThan(0);
    expect(Object.keys(night).length).toBeGreaterThan(0);
  });

  it('gives every colour token in :root a night value in the dark block', () => {
    const colour = Object.keys(day).filter((name) => !(name in THEME_FREE));
    expect(colour.filter((name) => !(name in night))).toEqual([]);
  });

  it('declares nothing at night that the day lacks, and leaves the theme-free tokens to :root', () => {
    expect(Object.keys(night).filter((name) => !(name in day))).toEqual([]);
    expect(Object.keys(THEME_FREE).filter((name) => name in night)).toEqual([]);
  });

  it("holds Quiet's values, and no colour token beyond them and the six family hues", () => {
    for (const [name, [d, n]] of Object.entries(QUIET)) {
      expect(day[name], `--${name} by day`).toBe(d);
      expect(night[name], `--${name} by night`).toBe(n);
    }
    const unknown = Object.keys(day).filter((name) => !(name in QUIET) && !(name in THEME_FREE) && !isFamily(name));
    expect(unknown).toEqual([]);
  });

  it('holds the theme-free values in :root', () => {
    for (const [name, value] of Object.entries(THEME_FREE)) expect(day[name], `--${name}`).toBe(value);
  });

  it('neither declares nor reads a removed token', () => {
    for (const name of ['accent', 'edge', 'green', 'purple', 'clay']) expect(css, `--${name}`).not.toMatch(new RegExp(`--${name}\\b`));
  });
});

describe('type', () => {
  it('asks only for the two weights that ship, 500 and 900', () => {
    const weights = [...css.matchAll(/font-weight:\s*([^;}]+)/g)].map((m) => m[1].trim());
    const allowed = ['500', '900', 'var(--w-text)', 'var(--w-heavy)', 'inherit'];
    expect(weights.filter((w) => !allowed.includes(w))).toEqual([]);
  });

  it('sizes text L, M or S, or relative to its parent', () => {
    const sizes = [...css.matchAll(/font-size:\s*([^;}]+)/g)].map((m) => m[1].trim());
    const allowed = ['15px', '12.5px', '11px', 'var(--fs-l)', 'var(--fs-m)', 'var(--fs-s)', 'inherit'];
    expect(sizes.filter((s) => !allowed.includes(s) && !/^[\d.]+em$/.test(s))).toEqual([]);
  });
});
```

- [ ] **Step 3: Run it to see it fail**

```bash
cd /c/personal/InProgress/.claude/worktrees/quiet-t1 && npx vitest run test/web/tokens.test.ts
```

Expected: `Tests  6 failed | 2 passed (8)`. The failures are `gives every colour token in :root a night value in the
dark block` (`--green`, `--amber`, `--red` and more have no night value), `holds Quiet's values …` (`--bg by day:
expected '#f5f5f7' to be '#f8fafc'`), `holds the theme-free values in :root`, `neither declares nor reads a removed
token`, `asks only for the two weights that ship, 500 and 900` (`'600', '700'` …) and `sizes text L, M or S …`
(`'10px', '12px'` …).

- [ ] **Step 4: Rewrite the family hue test**

In `test/web/family.test.ts`, replace lines 39-43:

```ts
  it('has each hue defined in the stylesheet: session clay first, then the five old subagent colours', () => {
    const css = readFileSync('web/src/styles.css', 'utf8');
    const hues = ['var(--clay)', '#5856d6', '#0b7285', '#c2255c', '#8c6239', '#5c7a00'];
    hues.forEach((hue, slot) => expect(css).toContain(`--family-${slot}: ${hue};`));
  });
```

with:

```ts
  it('has each hue in the stylesheet, day in :root and night in the dark block: teal, clay, green, rose, brown, indigo', () => {
    const css = readFileSync('web/src/styles.css', 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
    const day = /:root\s*\{([^}]*)\}/.exec(css)?.[1] ?? '';
    const night = /@media \(prefers-color-scheme: dark\)\s*\{\s*:root\s*\{([^}]*)\}/.exec(css)?.[1] ?? '';
    const hues = [
      ['#0b6b7d', '#3cc3d6'],
      ['#b4532f', '#e8956f'],
      ['#287a3a', '#7ad68f'],
      ['#b0204f', '#f27aa5'],
      ['#85593a', '#d4a574'],
      ['#4f4dc4', '#9a98ff'],
    ];
    hues.forEach(([dayHue, nightHue], slot) => {
      expect(day, `slot ${slot} by day`).toContain(`--family-${slot}: ${dayHue};`);
      expect(night, `slot ${slot} by night`).toContain(`--family-${slot}: ${nightHue};`);
    });
  });
```

Lines 32-37 (`familyVar`) stay as they are.

- [ ] **Step 5: Run it to see it fail**

```bash
cd /c/personal/InProgress/.claude/worktrees/quiet-t1 && npx vitest run test/web/family.test.ts
```

Expected: `Tests  1 failed | 5 passed (6)`, the failure `slot 0 by day: expected '…' to contain '--family-0: #0b6b7d;'`.

Steps 6 to 10 rewrite `web/src/styles.css` one region at a time, from the bottom of the file up, so the line numbers
each step names stay those of `0b786b8`.

- [ ] **Step 6: The reduced-motion region**

In `web/src/styles.css`, replace lines 240-244 (from `@media (prefers-reduced-motion: reduce) {` through the file's
last line, `}`) with:

```css
/* Region: reduced motion. Task 1 only. */
@media (prefers-reduced-motion: reduce) {
  /* Nothing moves: no pulse, no flash, no bob, blink or ring. The flash's static ring is in the canvas region. */
  * { animation: none !important; }
}
```

The static flash ring that sat in this block moves to the canvas region in Step 8.

- [ ] **Step 7: The Details and viewer region**

Replace lines 199-239 (from `.ip-details { position: absolute; …` through `.ip-toast { … }`) with:

```css
/* Region: Details and viewer. Task 5. */
.ip-details { position: absolute; right: 0; top: 0; bottom: 0; width: 380px; background: var(--panel); border-left: 1px solid var(--border); box-shadow: var(--shadow); padding: 12px 14px; overflow-y: auto; z-index: 10; font-size: var(--fs-m); }
.ip-grab { display: none; width: 36px; height: 4px; border-radius: 2px; background: var(--border); margin: 0 auto 8px; }
@media (max-width: 719px) {
  .ip-details { top: auto; left: 0; width: auto; height: 60%; border-left: 0; border-top: 1px solid var(--border); border-radius: 14px 14px 0 0; }
  .ip-grab { display: block; }
}
.ip-details header, .ip-viewer header { display: flex; align-items: center; gap: 6px; font-size: var(--fs-l); }
.ip-details header b, .ip-viewer header b { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-weight: var(--w-heavy); }
.ip-btn { border: 1px solid var(--border); border-radius: 6px; padding: 0 7px; font-size: var(--fs-s); color: var(--muted); white-space: nowrap; }
.ip-meta { display: flex; flex-wrap: wrap; gap: 6px; align-items: center; color: var(--muted); font-size: var(--fs-s); margin: 6px 0 10px; }
.ip-pill { border-radius: 8px; padding: 0 6px; font-weight: var(--w-heavy); font-size: var(--fs-s); color: var(--bg); background: var(--faint); }
.ip-pill.you { color: var(--amber-ink); background: var(--amber-fill); }
.ip-pill.st-done { background: var(--muted); }
.ip-pill.st-active { background: var(--active); }
.ip-pill.st-blocked { background: var(--red); }
.ip-link { color: var(--link); text-decoration: underline; }
.ip-label { font-size: var(--fs-s); text-transform: uppercase; letter-spacing: 0.05em; color: var(--muted); margin: 12px 0 4px; }
.ip-res { display: flex; align-items: center; gap: 6px; width: 100%; text-align: left; border: 1px solid var(--muted); background: color-mix(in srgb, var(--muted) 8%, transparent); color: var(--muted); border-radius: 6px; padding: 4px 8px; margin-bottom: 4px; }
/* The browser draws <b> at 700, which only Inter 900 can serve: a resource's title names its weight. */
.ip-res b { font-weight: var(--w-text); }
.ip-res .sub { color: var(--muted); font-size: var(--fs-s); margin-left: auto; }
.ip-kids { list-style: none; margin: 0; padding: 0; }
.ip-kids li button { width: 100%; text-align: left; padding: 2px 0; display: flex; gap: 6px; align-items: center; }
.ip-log { list-style: none; margin: 0; padding: 0; color: var(--muted); font-size: var(--fs-s); line-height: 1.7; }
.ip-wts, .ip-dagents { list-style: none; margin: 0; padding: 0; line-height: 1.7; }
.ip-wt .ip-work-agent { margin-right: 4px; }
/* An ended subagent's line goes grey, its tag with it. The trail's ◆ is neutral, as a trail row wears no family. */
.ip-dagent.ended .ip-agent-tag { color: inherit; }
.ip-agent-dot { color: var(--faint); }
.ip-dagent.ended, .ip-dtrail { color: var(--muted); }
/* A subagent's purpose, under its line in Details. */
.ip-dpurpose { padding-left: 12px; font-size: var(--fs-s); line-height: 1.4; color: var(--muted); }
/* Details' ended work: one group per session, under its title. */
.ip-trail + .ip-trail { margin-top: 4px; }
.ip-trail-head { font-size: var(--fs-s); color: var(--muted); font-weight: var(--w-text); }
.ip-outcome { margin: 8px 0; }
/* Outcome's label and Markdown's bold name their weight too. */
.ip-outcome b, .ip-md strong, .ip-md b { font-weight: var(--w-heavy); }
.ip-md { font-size: var(--fs-m); line-height: 1.55; overflow-wrap: anywhere; }
.ip-md pre { background: var(--panel-2); padding: 8px; border-radius: 6px; overflow: auto; }
.ip-md code { font-family: ui-monospace, 'Cascadia Code', Consolas, monospace; font-size: var(--fs-m); }
.ip-md table { border-collapse: collapse; }
.ip-md td, .ip-md th { border: 1px solid var(--border); padding: 2px 6px; }
.ip-viewer { position: fixed; inset: 0; background: var(--bg); z-index: 30; display: flex; flex-direction: column; }
.ip-viewer header { padding: 8px 12px; background: var(--panel); border-bottom: 1px solid var(--border); }
.ip-viewer-body { flex: 1; overflow: auto; padding: 16px 20px; max-width: 900px; width: 100%; margin: 0 auto; outline: none; }
.ip-viewer-body:focus-visible { outline: 2px solid var(--amber); outline-offset: -2px; }
.ip-toast { position: fixed; bottom: 16px; left: 50%; transform: translateX(-50%); background: var(--text); color: var(--bg); padding: 4px 12px; border-radius: 8px; font-size: var(--fs-m); z-index: 40; }
```

This drops the narrow-window chip toggle from the Details media block (it moves to the canvas region in Step 8),
takes in `.ip-dagent.ended .ip-agent-tag`, `.ip-agent-dot`, `.ip-dagent.ended, .ip-dtrail` and `.ip-dpurpose` from the
chrome range, and names the weight of every `<b>` and Markdown `strong`.

- [ ] **Step 8: The canvas region**

Replace lines 121-198 (from `.ip-canvas { flex: 1; …` through `.ip-handle { … }`) with:

```css
/* Region: canvas. Task 6. */
.ip-canvas { flex: 1; position: relative; min-width: 0; }
.ip-canvas .react-flow { background: var(--bg); }
.ip-crumb { position: absolute; top: 8px; left: 10px; z-index: 5; font-size: var(--fs-s); color: var(--muted); background: var(--panel); border: 1px solid var(--border); border-radius: 6px; padding: 0 8px; max-width: calc(100% - 20px); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.ip-row { display: flex; align-items: center; gap: 8px; }
.ip-node { display: flex; align-items: center; gap: 6px; height: 24px; padding: 0 8px; background: var(--panel); border: 1px solid var(--border); border-radius: 6px; font-size: var(--fs-m); white-space: nowrap; max-width: 360px; cursor: pointer; color: var(--text); }
.ip-node .ip-title { overflow: hidden; text-overflow: ellipsis; }
.ip-node.root { font-weight: var(--w-heavy); }
.ip-node.st-active { border: 2px solid var(--active); }
.ip-node.needs-you { border: 2px solid var(--amber); }
.ip-node.st-todo:not(.needs-you) { opacity: 0.75; }
.ip-node.st-dropped .ip-title { text-decoration: line-through; color: var(--muted); }
.ip-node.selected { box-shadow: 0 0 0 3px color-mix(in srgb, var(--text-2) 35%, transparent); }
.ip-node.flash { animation: ip-flash 1.2s ease-out; }
@keyframes ip-flash { 0% { box-shadow: 0 0 0 7px color-mix(in srgb, var(--amber) 60%, transparent); } 100% { box-shadow: 0 0 0 0 transparent; } }
/* Under reduced motion the flash holds a static ring instead of fading one out. */
@media (prefers-reduced-motion: reduce) {
  .ip-node.flash { box-shadow: 0 0 0 3px color-mix(in srgb, var(--amber) 60%, transparent); }
}
.ip-marker { width: 8px; height: 8px; border-radius: 50%; flex: none; display: inline-flex; align-items: center; justify-content: center; font-size: var(--fs-s); font-weight: var(--w-heavy); color: var(--bg); }
.ip-marker.q { width: 12px; height: 12px; }
.ip-marker.m-done { background: var(--muted); }
.ip-marker.m-active { background: var(--active); }
.ip-marker.m-todo { border: 1.5px solid var(--faint); color: var(--muted); }
.ip-marker.m-blocked { background: var(--red); }
.ip-marker.m-dropped { background: var(--faint); }
.ip-node.needs-you .ip-marker { background: var(--amber); border: 0; color: var(--bg); }
.ip-node.working .ip-marker.m-active { animation: ip-pulse 1.6s ease-in-out infinite; }
/* Paused: an active step nobody is on. Its marker draws hollow in sky, and a question's ? takes the sky too (a filled
   marker's ink is the ground). */
.ip-node.paused .ip-marker { background: transparent; border: 1.5px solid var(--sky); color: var(--sky); }
.ip-you { color: var(--amber-ink); background: var(--amber-fill); border-radius: 3px; font-size: var(--fs-s); font-weight: var(--w-heavy); padding: 0 4px; }
.ip-blocked { color: var(--red); font-size: var(--fs-s); font-weight: var(--w-text); }
.ip-progress { color: var(--muted); font-size: var(--fs-s); }
.ip-chevron { color: var(--muted); font-size: var(--fs-s); padding: 0 2px; }
.ip-chip { font-size: var(--fs-s); color: var(--muted); background: color-mix(in srgb, var(--muted) 12%, transparent); border: 1px solid var(--muted); border-radius: 4px; padding: 0 6px; white-space: nowrap; max-width: 180px; overflow: hidden; text-overflow: ellipsis; }
/* A narrow window's single resource count, inside the card (shown by the max-width: 719px block below). */
.ip-res-count { display: none; flex: none; font-size: var(--fs-s); line-height: 14px; color: var(--muted); background: color-mix(in srgb, var(--muted) 12%, transparent); border: 1px solid var(--muted); border-radius: 3px; padding: 0 4px; white-space: nowrap; }
@media (max-width: 719px) {
  /* One resource count inside the card instead of the chips beside it. */
  .ip-row > .ip-chip { display: none; }
  .ip-res-count { display: inline-block; }
}
.ip-more { height: 24px; display: flex; align-items: center; gap: 4px; padding: 0 8px; border: 1px dashed var(--border); border-radius: 6px; font-size: var(--fs-m); color: var(--muted); background: var(--panel); cursor: pointer; }
/* "✓ n done": a run of old finished steps. Its mark is muted, like every done mark. */
.ip-more-mark { color: var(--muted); }
/* A session's focus badge, in its family's hue (--fam). */
.ip-badge { display: inline-flex; align-items: center; gap: 6px; height: 18px; padding: 0 8px; border-radius: 4px; font-size: var(--fs-s); font-weight: var(--w-text); color: var(--bg); background: var(--fam, var(--family-0)); white-space: nowrap; }
.ip-badge.s-idle { background: transparent; color: var(--fam, var(--family-0)); border: 1px solid var(--fam, var(--family-0)); }
.ip-badge.s-permission { background: transparent; color: var(--red); border: 1px solid var(--red); }
/* Waiting for an OK, the outline goes red and the letter still shows the family. */
.ip-badge.s-permission .ip-tag { color: var(--fam, var(--family-0)); }
/* A step's type label on its card: the glyph only, in text ink. A hue would read as a status or an agent. */
.ip-type { flex: none; color: var(--muted); border: 1px solid var(--border); border-radius: 3px; padding: 0 3px; font-size: var(--fs-m); line-height: 14px; }
/* Text presentation, so ⚙ and ⚒ never turn into emoji. */
.ip-type, .ip-glyph { font-variant-emoji: text; }
/* ⛁ draws faint at text size. The chip keeps its height: its line height is fixed. */
.ip-type.l-data, .ip-glyph.l-data { font-size: 1.33em; }
/* Up next place on a card, numbered per owner: an unowned one stays a neutral ①, an owned one wears its session's
   letter and hue (--fam): A①. */
.ip-queue { flex: none; color: var(--text-2); font-size: var(--fs-l); font-weight: var(--w-heavy); line-height: 1; white-space: nowrap; }
.ip-queue.owned { color: var(--fam, var(--family-0)); }
/* A subagent's badge, in its session's hue (--fam) and led by its tag; greyed once it has ended, keeping the tag. A
   subagent in the trail wears the ended look, with no family of its own. */
.ip-agent, .ip-trail-agent { height: 18px; line-height: 18px; max-width: 360px; padding: 0 8px; border-radius: 4px; font-size: var(--fs-s); font-weight: var(--w-text); color: var(--bg); background: var(--fam, var(--faint)); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.ip-agent.ended, .ip-trail-agent { line-height: 16px; background: transparent; color: var(--muted); border: 1px solid var(--faint); }
/* A subagent's tag, in its session's hue: the chip's list and Details show it. */
.ip-agent-tag { font-weight: var(--w-text); color: var(--fam, var(--faint)); }
/* A session's readers on a step: one small unfilled row in its hue, quieter than a worker's badge. */
.ip-readers { height: 18px; line-height: 18px; max-width: 360px; padding: 0 6px; border-radius: 4px; font-size: var(--fs-s); font-weight: var(--w-text); color: var(--fam, var(--faint)); background: var(--bg); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
/* Working tasks: a compact checklist under their node. */
.ip-work, .ip-work-done { display: flex; align-items: center; gap: 5px; height: 18px; max-width: 360px; padding: 0 6px; border-radius: 4px; font-size: var(--fs-s); white-space: nowrap; background: var(--bg); }
.ip-work { color: var(--text); }
.ip-work-mark { flex: none; width: 11px; text-align: center; color: var(--muted); }
.w-in_progress .ip-work-mark { color: var(--active-ink); }
.w-completed .ip-work-mark, .ip-work-done .ip-work-mark { color: var(--muted); }
.ip-work.w-completed .ip-work-subject { color: var(--muted); }
.ip-work.pulse .ip-work-mark { animation: ip-pulse 1.6s ease-in-out infinite; }
/* The trail: a task an ended session left open is a hollow grey ○ that never pulses; one it completed keeps its ✓. */
.ip-work.stale .ip-work-subject, .ip-wt.stale { color: var(--muted); }
.ip-work.stale:not(.w-completed) .ip-work-mark, .ip-wt.stale:not(.w-completed) .ip-work-mark { color: var(--faint); animation: none; }
/* A live task's marker, in its session's hue (--fam), and a subagent's task's tag ahead of its mark. Trail rows have neither. */
.ip-work-agent { flex: none; display: inline-block; width: 3px; height: 11px; border-radius: 2px; vertical-align: -1px; background: var(--fam); }
.ip-work-tag { flex: none; font-weight: var(--w-text); color: var(--fam); }
.ip-work-subject { min-width: 0; overflow: hidden; text-overflow: ellipsis; }
.ip-work-after { flex: none; max-width: 150px; overflow: hidden; text-overflow: ellipsis; color: var(--muted); }
.ip-work-done { color: var(--muted); }
.ip-work-done::after { content: '▸'; font-size: var(--fs-s); }
.ip-work-done[aria-expanded='true']::after { content: '▾'; }
.ip-work-done:hover { color: var(--text); }
.ip-work-done:focus-visible { outline: 2px solid var(--text-2); outline-offset: 1px; }
.ip-handle { opacity: 0; width: 1px; height: 1px; min-width: 0; min-height: 0; border: 0; }
```

This takes in the static flash ring (under its own reduced-motion query, after `@keyframes ip-flash`), the
narrow-window chip toggle (under its own `max-width: 719px` query, after `.ip-res-count`), `.ip-agent-tag` from the
chrome range, and the badge half of `:114`.

- [ ] **Step 9: The chrome region**

Replace lines 48-120 (from `.ip-app { display: flex; …` through `.ip-empty { … }`) with:

```css
/* Region: chrome. Task 4. */
.ip-app { display: flex; flex-direction: column; height: 100%; }
.ip-topbar { display: flex; align-items: stretch; min-height: 36px; padding: 0 6px 0 2px; background: var(--panel); border-bottom: 1px solid var(--border); }
/* One tab per project. When they overflow, the strip scrolls sideways (the wheel too: see TopBar). */
.ip-tabs { display: flex; flex: 0 1 auto; min-width: 0; overflow-x: auto; overflow-y: hidden; scrollbar-width: none; }
/* Room after the last tab: the browser rounds how far the strip scrolls to whole pixels, which would cut a sliver off it. */
.ip-tabs::after { content: ''; flex: none; width: 2px; }
.ip-tab { position: relative; flex: none; display: flex; align-items: center; gap: 6px; padding: 2px 10px 0; border-bottom: 2px solid transparent; color: var(--muted); font-weight: var(--w-text); white-space: nowrap; }
.ip-tab + .ip-tab::before { content: ''; position: absolute; left: 0; top: 11px; bottom: 11px; width: 1px; background: var(--border); }
.ip-tab:hover { color: var(--text); }
.ip-tab[aria-selected='true'] { color: var(--text); border-bottom-color: var(--text); }
.ip-tab:focus-visible { outline: 2px solid var(--text-2); outline-offset: -2px; border-radius: 4px; }
.ip-tab.archived .ip-tab-name { font-style: italic; }
.ip-tab-name { max-width: 160px; overflow: hidden; text-overflow: ellipsis; }
.ip-tab-count { flex: none; min-width: 16px; padding: 0 4px; border: 1px solid var(--amber); border-radius: 8px; background: var(--amber-fill); color: var(--amber-ink); font-size: var(--fs-s); font-weight: var(--w-text); line-height: 14px; text-align: center; }
.ip-tab-dot { flex: none; width: 8px; height: 8px; border-radius: 50%; background: var(--text-2); animation: ip-pulse 1.6s ease-in-out infinite; }
.ip-archive { position: relative; flex: none; margin-left: auto; display: flex; align-items: center; padding-left: 6px; }
.ip-archive-btn { height: 24px; padding: 0 8px; border-radius: 6px; color: var(--muted); font-weight: var(--w-heavy); }
.ip-archive-btn:hover, .ip-archive-btn[aria-expanded='true'] { background: var(--panel-2); color: var(--text); }
.ip-menu { position: absolute; top: calc(100% + 4px); right: 0; width: 280px; max-width: calc(100vw - 20px); background: var(--panel); border: 1px solid var(--border); border-radius: 10px; box-shadow: var(--shadow); padding: 6px; z-index: 20; }
.ip-mi { display: flex; align-items: center; gap: 8px; width: 100%; padding: 7px 8px; border-radius: 7px; text-align: left; }
.ip-mi:hover, .ip-mi.cur { background: var(--panel-2); }
.ip-mi .nm { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-weight: var(--w-text); }
.ip-menu .ip-label { margin: 2px 8px 4px; }
.ip-need { height: 22px; border: 1px solid var(--amber); color: var(--amber-ink); background: var(--amber-fill); border-radius: 10px; padding: 0 8px; font-weight: var(--w-text); font-size: var(--fs-m); white-space: nowrap; flex: none; }
.ip-follow { height: 22px; border: 1px solid var(--border); border-radius: 6px; padding: 0 7px; font-size: var(--fs-m); color: var(--muted); white-space: nowrap; flex: none; }
.ip-follow.on { border-color: var(--text); color: var(--text-2); }
/* Session chips on the left, wrapping; the needs-you pill and Follow at the right end. */
.ip-sessions { position: relative; display: flex; align-items: flex-start; gap: 8px; padding: 6px 10px; background: var(--panel); border-bottom: 1px solid var(--border); }
.ip-chips { display: flex; flex-wrap: wrap; gap: 6px; flex: 1; min-width: 0; }
.ip-chip-wrap { display: flex; min-width: 0; max-width: 100%; }
/* A session chip wears its family's hue (--fam, set inline from its slot) and leads with its letter. */
.ip-chip-s { display: inline-flex; align-items: center; gap: 6px; min-width: 0; max-width: 100%; height: 22px; border-radius: 10px; padding: 0 9px; font-size: var(--fs-m); font-weight: var(--w-text); border: 1px solid var(--fam, var(--family-0)); color: var(--fam, var(--family-0)); }
.ip-chip-lead { flex: none; white-space: nowrap; }
/* A session's letter, or a subagent's tag on its badge, in the ink around it. */
.ip-tag { font-weight: var(--w-heavy); }
/* A chip's subagents, listed under the row (so the list never runs off a narrow window) while the chip is hovered or
   focused from the keyboard. */
.ip-chip-pop { display: none; position: absolute; top: calc(100% + 2px); left: 10px; z-index: 25; max-width: min(400px, calc(100% - 20px)); padding: 6px 10px; background: var(--panel); border: 1px solid var(--border); border-radius: 8px; box-shadow: var(--shadow); font-size: var(--fs-m); }
.ip-chip-wrap:hover .ip-chip-pop, .ip-chip-s:focus-visible + .ip-chip-pop { display: block; }
.ip-chip-pop-head { color: var(--muted); font-size: var(--fs-s); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.ip-chip-pop ul { list-style: none; margin: 4px 0 0; padding: 0; }
.ip-chip-pop li { white-space: nowrap; overflow: hidden; text-overflow: ellipsis; line-height: 1.7; }
/* An ended subagent's line in the chip's list goes grey, its tag with it. */
.ip-chip-pop li.ended .ip-agent-tag { color: inherit; }
.ip-chip-pop li.ended { color: var(--muted); }
/* A reader's ◇ in a list, in its session's hue like its tag. */
.ip-reader-mark { color: var(--fam, var(--faint)); }
/* Up next, under the session row: its heading, then one line per live session that has steps, led by its letter in
   its family's hue (--fam), then a neutral "later" line. Each line is cut short at the window's edge. */
.ip-upnext { padding: 3px 10px; font-size: var(--fs-m); color: var(--muted); background: var(--panel); border-bottom: 1px solid var(--border); }
.ip-upnext-head { font-weight: var(--w-heavy); }
.ip-upnext-line { white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.ip-upnext-lead { font-weight: var(--w-heavy); margin-right: 4px; }
.ip-upnext-line.owned .ip-upnext-lead { color: var(--fam, var(--family-0)); }
.ip-upnext-item { color: var(--text); cursor: pointer; border-radius: 3px; }
.ip-upnext-item:hover { color: var(--muted); }
.ip-upnext-item:focus-visible { outline: 2px solid var(--text-2); outline-offset: 1px; }
.ip-chip-label { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.ip-chip-s.s-working { background: var(--fam, var(--family-0)); color: #fff; }
.ip-chip-s.s-permission { border-color: var(--red); color: var(--red); }
/* Waiting for an OK, the outline goes red and the letter still shows the family. */
.ip-chip-s.s-permission .ip-tag { color: var(--fam, var(--family-0)); }
.ip-pulse { width: 6px; height: 6px; border-radius: 50%; background: currentColor; animation: ip-pulse 1.6s ease-in-out infinite; }
.ip-main { flex: 1; position: relative; min-height: 0; display: flex; }
.ip-activity { font-size: var(--fs-m); color: var(--muted); padding: 6px 10px; border-top: 1px solid var(--border); background: var(--panel); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.ip-banner { background: var(--amber); color: #000; font-size: var(--fs-m); padding: 3px 10px; }
.ip-empty { margin: auto; color: var(--muted); text-align: center; padding: 24px; max-width: 420px; }
```

This moves `.ip-agent-tag`, the Details halves of `:92` and `:95`, `.ip-agent-dot` and `.ip-dpurpose` out (Steps 7
and 8 took them in), keeps the badge half of `:114` out, and moves `@keyframes ip-pulse` to the tokens region
(Step 10).

- [ ] **Step 10: The tokens region**

Replace lines 1-47 (from `:root {` through `.muted { color: var(--muted); }`) with:

```css
/* Region: tokens. Task 1 only. */
:root {
  color-scheme: light dark;
  /* Quiet's day values. The dark block below holds the night value of every token here but the theme-free ones. */
  --bg: #f8fafc;
  --text: #0f172a;
  --text-2: #1e293b;
  --muted: #475569;
  --faint: #64748b;
  --border: rgba(15,23,42,.11);
  --bar: #ffffff;
  --card: #ffffff;
  --active-fill: #fffaf6;
  --lane: rgba(15,23,42,.018);
  --float: rgba(248,250,252,.94);
  /* Overlays only (Details, the resource viewer and its header): opaque, so no card shows through. */
  --panel: #ffffff;
  --shadow: 0 8px 24px rgba(15,23,42,.16);
  /* Hover fills and code blocks: a tint fainter than --border. */
  --panel-2: rgba(15,23,42,.05);
  --track: rgba(15,23,42,.08);
  --track-fill: rgba(71,85,105,.5);
  /* Orange marks only the active path, amber only attention, red only a blocked step. */
  --active: #c2410c;
  --active-ink: #c2410c;
  --active-line: rgba(234,88,12,.55);
  --sky: #0284c7;
  --link: #0369a1;
  --amber: #d97706;
  --amber-ink: #92400e;
  --amber-fill: rgba(251,191,36,.18);
  --red: #b91c1c;
  --gone: #64748b;
  /* Session families, by slot (familyVar in family.ts). Slot 0 is teal, and a session with no slot wears it too. Past
     six they repeat and the letter tells them apart. */
  --family-0: #0b6b7d;
  --family-1: #b4532f;
  --family-2: #287a3a;
  --family-3: #b0204f;
  --family-4: #85593a;
  --family-5: #4f4dc4;
  /* Theme-free: one value for day and night. Only Inter 500 and 900 ship, so every weight is one of the two. */
  --radius: 8px;
  --hairline: linear-gradient(97deg, #6366f1, #ff6600);
  --font-sans: 'Inter', system-ui, 'Segoe UI', 'Segoe UI Symbol', sans-serif;
  --font-mono: 'DM Mono', ui-monospace, 'Cascadia Code', Consolas, monospace;
  --fs-l: 15px;
  --fs-m: 12.5px;
  --fs-s: 11px;
  --w-text: 500;
  --w-heavy: 900;
  --track-l: -0.05em;
}
@media (prefers-color-scheme: dark) {
  :root {
    --bg: #080d1c;
    --text: #f1f5f9;
    --text-2: #e2e8f0;
    --muted: #94a3b8;
    --faint: #64748b;
    --border: rgba(255,255,255,.09);
    --bar: rgba(255,255,255,.018);
    --card: rgba(255,255,255,.035);
    --active-fill: rgba(249,115,22,.045);
    --lane: rgba(255,255,255,.022);
    --float: rgba(8,13,28,.92);
    --panel: #0c1227;
    --shadow: 0 8px 24px rgba(0,0,0,.55);
    --panel-2: rgba(255,255,255,.06);
    --track: rgba(255,255,255,.08);
    --track-fill: rgba(148,163,184,.55);
    --active: #f97316;
    --active-ink: #fb923c;
    --active-line: rgba(249,115,22,.5);
    --sky: #38bdf8;
    --link: #38bdf8;
    --amber: #fbbf24;
    --amber-ink: #fcd34d;
    --amber-fill: rgba(251,191,36,.12);
    --red: #f87171;
    --gone: #94a3b8;
    --family-0: #3cc3d6;
    --family-1: #e8956f;
    --family-2: #7ad68f;
    --family-3: #f27aa5;
    --family-4: #d4a574;
    --family-5: #9a98ff;
  }
}
* { box-sizing: border-box; }
html, body, #root { height: 100%; margin: 0; }
/* body keeps painting --bg: the night --bar only reads over it. */
body { font: 500 12.5px/1.4 var(--font-sans); font-variant-emoji: text; background: var(--bg); color: var(--text); }
button { font: inherit; color: inherit; background: none; border: 0; cursor: pointer; padding: 0; }
.muted { color: var(--muted); }
/* The one pulse: the tab dot, an active marker on a working card and an in-progress task's mark. */
@keyframes ip-pulse { 0%, 100% { opacity: 1; } 50% { opacity: 0.35; } }
```

- [ ] **Step 11: Point the edges at the hairline token**

In `web/src/canvas/Canvas.tsx`, line 237, replace:

```tsx
        style: { stroke: 'var(--edge)', strokeWidth: 1.2 },
```

with:

```tsx
        style: { stroke: 'var(--border)', strokeWidth: 1.2 },
```

- [ ] **Step 12: Fix the "clay" comments in `family.ts`**

In `web/src/family.ts`, replace line 1:

```ts
/** How many hues a session family can wear: `--family-0` (session clay) to `--family-5`. Past six, the letter tells them apart. */
```

with:

```ts
/** How many hues a session family can wear: `--family-0` (teal) to `--family-5`. Past six, the letter tells them apart. */
```

and line 6:

```ts
 * A null slot gives slot 0's clay; a reader that needs a neutral look for "no slot" brings its own.
```

with:

```ts
 * A null slot gives slot 0's teal; a reader that needs a neutral look for "no slot" brings its own.
```

- [ ] **Step 13: Search for leftovers**

```bash
cd /c/personal/InProgress/.claude/worktrees/quiet-t1
grep -n "Region:" web/src/styles.css
grep -nE "font-weight:\s*(600|700|800|bold)" web/src/styles.css
grep -rnE -e "--(accent|edge|green|purple|clay)\b" web/src
grep -nE "color:\s*#(fff|000)\b" web/src/styles.css
grep -c "var(--amber) 14%" web/src/styles.css
```

Expected:
- five region heads, at lines 1, 98, 166, 258 and 307;
- nothing from the second and third commands;
- two lines: `157:.ip-chip-s.s-working { background: var(--fam, var(--family-0)); color: #fff; }` (Task 4 removes
  it) and `164:.ip-banner { background: var(--amber); color: #000; font-size: var(--fs-m); padding: 3px 10px; }` (kept on
  purpose);
- `0`.

A different line number means a region was pasted short or long: compare it with the block in its step.

- [ ] **Step 14: Run the unit tests and the typecheck**

```bash
cd /c/personal/InProgress/.claude/worktrees/quiet-t1 && npx vitest run test/web/tokens.test.ts test/web/family.test.ts
cd /c/personal/InProgress/.claude/worktrees/quiet-t1 && npm run typecheck && npm test
```

Expected: `Tests  14 passed (14)`; then both `tsc` runs print nothing, and Vitest reports `Test Files  42 passed (42)`
and 0 failed.

- [ ] **Step 15: Commit the stylesheet**

```bash
git -C /c/personal/InProgress/.claude/worktrees/quiet-t1 add web/src/styles.css web/src/canvas/Canvas.tsx web/src/family.ts test/web/family.test.ts test/web/tokens.test.ts
git -C /c/personal/InProgress/.claude/worktrees/quiet-t1 commit -m "Quiet tokens, type and motion in the stylesheet (#81)" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

Expected: `5 files changed`, one of them `create mode 100644 test/web/tokens.test.ts`.

- [ ] **Step 16: Install the two font packages**

```bash
cd /c/personal/InProgress/.claude/worktrees/quiet-t1 && npm i -D @fontsource/inter@^5.3.0 @fontsource/dm-mono@^5.3.0 --no-audit --no-fund && git diff package.json
```

Expected: `added 2 packages`, and a diff that adds two lines at the top of `devDependencies`:

```diff
   "devDependencies": {
+    "@fontsource/dm-mono": "^5.3.0",
+    "@fontsource/inter": "^5.3.0",
     "@playwright/test": "^1.63.0",
```

Both packages are OFL-1.1. If npm answers `notarget` for either range, stop and report to the controller. Do not pick
another version.

- [ ] **Step 17: Check the font files**

```bash
cd /c/personal/InProgress/.claude/worktrees/quiet-t1
grep -hE "font-family|font-weight|src:" node_modules/@fontsource/inter/latin-500.css node_modules/@fontsource/inter/latin-900.css node_modules/@fontsource/dm-mono/latin-500.css
wc -c node_modules/@fontsource/inter/files/inter-latin-500-normal.woff2 node_modules/@fontsource/inter/files/inter-latin-900-normal.woff2 node_modules/@fontsource/dm-mono/files/dm-mono-latin-500-normal.woff2
```

Expected: three `@font-face` blocks, in this shape:

```
  font-family: 'Inter';
  font-weight: 500;
  src: url(./files/inter-latin-500-normal.woff2) format('woff2'), url(./files/inter-latin-500-normal.woff) format('woff');
  font-family: 'Inter';
  font-weight: 900;
  src: url(./files/inter-latin-900-normal.woff2) format('woff2'), url(./files/inter-latin-900-normal.woff) format('woff');
  font-family: 'DM Mono';
  font-weight: 500;
  src: url(./files/dm-mono-latin-500-normal.woff2) format('woff2'), url(./files/dm-mono-latin-500-normal.woff) format('woff');
```

then three byte counts, each well over 4096. The family names must be exactly `Inter` and `DM Mono`, the names
`--font-sans` and `--font-mono` ask for. If one of the three CSS files is missing, run
`ls node_modules/@fontsource/inter node_modules/@fontsource/dm-mono` and stop and report: never import the
all-subset `500.css` in its place.

- [ ] **Step 18: Import the faces**

In `web/src/main.tsx`, replace lines 4-5:

```tsx
import '@xyflow/react/dist/style.css';
import './styles.css';
```

with:

```tsx
import '@xyflow/react/dist/style.css';
// Bundled faces: Vite emits the font files next to the app, so the window never fetches a font from the network.
import '@fontsource/inter/latin-500.css';
import '@fontsource/inter/latin-900.css';
import '@fontsource/dm-mono/latin-500.css';
import './styles.css';
```

- [ ] **Step 19: Build, and check the fonts ship as files**

```bash
cd /c/personal/InProgress/.claude/worktrees/quiet-t1 && npm run typecheck && npm run build
ls /c/personal/InProgress/.claude/worktrees/quiet-t1/.build/web/dist/assets | grep -E "\.woff2?$"
cat /c/personal/InProgress/.claude/worktrees/quiet-t1/.build/web/dist/assets/*.css | grep -cE "data:(font|application/(x-)?font)"
```

Expected: a clean typecheck and `Built into …\quiet-t1\.build`; then six files, each with a hash in its name:
`inter-latin-500-normal-<hash>.woff2` and `.woff`, `inter-latin-900-normal-<hash>.woff2` and `.woff`,
`dm-mono-latin-500-normal-<hash>.woff2` and `.woff`; then `0`. `web/vite.config.ts` stays unchanged.

If the count is not `0`, a font was inlined as `data:`, which the CSP (`default-src 'self'`) blocks. Then, in
`web/vite.config.ts`, replace:

```ts
  build: { outDir: 'dist', emptyOutDir: true },
```

with:

```ts
  build: { outDir: 'dist', emptyOutDir: true, assetsInlineLimit: (f) => (/\.woff2?$/.test(f) ? false : undefined) },
```

rerun this step until the count is `0`, and add `web/vite.config.ts` to Step 20's `git add`. Never add `data:` to the
CSP.

- [ ] **Step 20: Commit the fonts**

```bash
git -C /c/personal/InProgress/.claude/worktrees/quiet-t1 add package.json package-lock.json web/src/main.tsx
git -C /c/personal/InProgress/.claude/worktrees/quiet-t1 commit -m "Bundle Inter and DM Mono with the window (#81)" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

Expected: `3 files changed`.

- [ ] **Step 21: Move the e2e colour pins to Quiet's day values**

The e2e runs by day, so these are the day values (T284's two, in dark, come in Step 22). Each moves on today's
element and property; for l.1225 and l.1422 only the value moves (Tasks 6 and 4 move the element later).

| Line | Test | Element | Was | Now |
|---|---|---|---|---|
| 259 | T247 | `.ip-type` colour | `rgb(110, 110, 115)` | `rgb(71, 85, 105)` (`--muted`) |
| 477 | T465 | paused marker `border-top-color` | `rgb(0, 113, 227)` | `rgb(2, 132, 199)` (`--sky`) |
| 484 | T465 | active markers `background-color` | `rgb(0, 113, 227)` | `rgb(194, 65, 12)` (`--active`) |
| 1199 | T1142 | ended agent colour | `rgb(110, 110, 115)` | `rgb(71, 85, 105)` (`--muted`) |
| 1225 | T1203 | readers row colour | `rgb(217, 119, 87)` | `rgb(11, 107, 125)` (`--family-0`) |
| 1314 | T1294 | comment | `A session clay` | `A teal` |
| 1329 | T1294 | Up next lead A | `rgb(217, 119, 87)` | `rgb(11, 107, 125)` (`--family-0`) |
| 1339 | T1294 | comment | `in the neutral accent` | `in ink` |
| 1345 | T1294 | unowned `①` | `rgb(0, 113, 227)` | `rgb(30, 41, 59)` (`--text-2`) |
| 1407 | T1380 | comment | `A wears session clay` | `A wears teal` |
| 1422 | T1380 | chip A background | `rgb(217, 119, 87)` | `rgb(11, 107, 125)` (`--family-0`) |
| 1477 | T1445 | stale `○` | `rgb(174, 174, 178)` | `rgb(100, 116, 139)` (`--faint`) |
| 1490 | T1445 | trail agent colour | `rgb(110, 110, 115)` | `rgb(71, 85, 105)` (`--muted`) |

```bash
cd /c/personal/InProgress/.claude/worktrees/quiet-t1 && sed -i \
  -e '259s/rgb(110, 110, 115)/rgb(71, 85, 105)/' \
  -e '477s/rgb(0, 113, 227)/rgb(2, 132, 199)/' \
  -e '484s/rgb(0, 113, 227)/rgb(194, 65, 12)/' \
  -e '1199s/rgb(110, 110, 115)/rgb(71, 85, 105)/' \
  -e '1225s/rgb(217, 119, 87)/rgb(11, 107, 125)/' \
  -e '1314s/A session clay/A teal/' \
  -e '1329s/rgb(217, 119, 87)/rgb(11, 107, 125)/' \
  -e '1339s/in the neutral accent/in ink/' \
  -e '1345s/rgb(0, 113, 227)/rgb(30, 41, 59)/' \
  -e '1407s/A wears session clay/A wears teal/' \
  -e '1422s/rgb(217, 119, 87)/rgb(11, 107, 125)/' \
  -e '1477s/rgb(174, 174, 178)/rgb(100, 116, 139)/' \
  -e '1490s/rgb(110, 110, 115)/rgb(71, 85, 105)/' \
  test/e2e/ui.spec.ts && git diff --numstat test/e2e/ui.spec.ts
```

Expected: `13	13	test/e2e/ui.spec.ts`. Any other count means a line did not match: compare it with the table.

- [ ] **Step 22: T284 checks the night values, the night ground and the bundled fonts**

Replace lines 284-299 of `test/e2e/ui.spec.ts` (the whole test `dark mode reaches the canvas controls; reduced motion
stops the pulse and flash`, from its `test(` line through its closing `});`) with:

```ts
test('dark mode reaches the canvas controls; reduced motion stops the pulse and flash', async ({ page, demo }) => {
  // Every font comes from the app's own server: the faces are bundled, never fetched from the network.
  const fontHosts: string[] = [];
  page.on('request', (request) => {
    if (request.resourceType() === 'font') fontHosts.push(new URL(request.url()).hostname);
  });
  await page.emulateMedia({ colorScheme: 'dark', reducedMotion: 'reduce' });
  await open(page, demo);
  await expect(page.locator('.react-flow')).toHaveClass(/\bdark\b/);
  // The night ground is Quiet's navy.
  await expect(page.locator('.react-flow')).toHaveCSS('background-color', 'rgb(8, 13, 28)');
  await expect(page.locator('.ip-chip-s .ip-pulse')).toHaveCSS('animation-name', 'none');
  await expect(page.locator('.ip-node.working .ip-marker.m-active').first()).toHaveCSS('animation-name', 'none');
  // Amber ink on an amber tint, like the needs-you pill.
  await expect(page.locator('.ip-node .ip-you')).toHaveCSS('color', 'rgb(252, 211, 77)');
  await page.keyboard.press('n');
  const flashed = page.locator('.ip-node.flash', { hasText: 'Run signing tests' });
  await expect(flashed).toHaveCSS('animation-name', 'none');
  await expect(flashed).not.toHaveCSS('box-shadow', 'none');
  // Section labels in Details are readable on the dark panel.
  await flashed.click();
  await expect(page.getByRole('complementary').locator('.ip-label').first()).toHaveCSS('color', 'rgb(148, 163, 184)');
  // Inter is in use: a face that loaded, not only a family name that matched nothing (document.fonts.check() can't tell).
  const loadedFaces = `(async () => {
    await document.fonts.ready;
    return [...document.fonts].filter((face) => face.status === 'loaded').map((face) => face.family.replace(/["']/g, ''));
  })()`;
  await expect.poll(() => page.evaluate<string[]>(loadedFaces)).toContain('Inter');
  expect(fontHosts.length, 'the faces were requested').toBeGreaterThan(0);
  expect(fontHosts.filter((host) => host !== '127.0.0.1'), 'font requests that left the app').toEqual([]);
});
```

What changed: l.291 reads `rgb(252, 211, 77)` (night `--amber-ink`) and l.298 `rgb(148, 163, 184)` (night `--muted`);
a request listener before `open` collects every font request's host; `.react-flow`'s ground is night `--bg`; and at
the end an `Inter` face has loaded and no font request left `127.0.0.1`. Task 4 later edits l.288 here, and Task 6
l.295 and the `DM Mono` and `.react-flow__background` checks.

```bash
cd /c/personal/InProgress/.claude/worktrees/quiet-t1 && git diff --numstat test/e2e/ui.spec.ts && npm run typecheck
```

Expected: `30	15	test/e2e/ui.spec.ts`, then both `tsc` runs print nothing (the root `tsconfig.json` typechecks
`test/e2e`). The count is against `HEAD`, so it holds Step 21's 13 and 13 as well. This step alone adds 15 lines and
rewrites 2 (l.291 and l.298), which `numstat` counts as 17 and 2; the other 14 lines of the old test stay as they were.

- [ ] **Step 23: Run the eight e2e tests this task touches**

```bash
cd /c/personal/InProgress/.claude/worktrees/quiet-t1 && npm run build && INPROGRESS_E2E_PORT=4391 npx playwright test -g "a labelled step shows its glyph|dark mode reaches the canvas controls|an active step nobody is on|each subagent has a badge under its node|a worker's badge says what it was asked|two sessions keep their own Up next order|two sessions in a project show A and B|an ended session's tasks and subagents stay"
```

Expected: `Built into …\quiet-t1\.build`, then `8 passed`. One test alone: `INPROGRESS_E2E_PORT=4391 npx playwright
test -g "dark mode reaches the canvas controls"`.

- [ ] **Step 24: Commit the e2e changes**

```bash
git -C /c/personal/InProgress/.claude/worktrees/quiet-t1 add test/e2e/ui.spec.ts
git -C /c/personal/InProgress/.claude/worktrees/quiet-t1 commit -m "Move the e2e colour pins to Quiet, and check the night ground and the bundled fonts (#81)" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

Expected: `1 file changed, 30 insertions(+), 15 deletions(-)`: Steps 21 and 22 together, as in Step 22's count.

- [ ] **Step 25: Run the whole e2e suite**

New faces and sizes reach every test, and every later task branches from this one, so the whole suite runs here.

```bash
cd /c/personal/InProgress/.claude/worktrees/quiet-t1 && INPROGRESS_E2E_PORT=4391 npm run test:e2e
```

Expected: `50 passed`, 0 failed, 0 flaky. If a test outside Step 23's eight fails, it fails on Task 1's type or
colours: find the failing assertion, and report it to the controller with the expected and received values before
changing any line another task owns.

- [ ] **Step 26: Check the branch**

```bash
git -C /c/personal/InProgress/.claude/worktrees/quiet-t1 status --short
git -C /c/personal/InProgress/.claude/worktrees/quiet-t1 log --oneline quiet-restyle..quiet/t1-tokens
```

Expected: no status output (`.build`, `.e2e-home` and `test-results` are gitignored), then the three commits:

```
<sha> Move the e2e colour pins to Quiet, and check the night ground and the bundled fonts (#81)
<sha> Bundle Inter and DM Mono with the window (#81)
<sha> Quiet tokens, type and motion in the stylesheet (#81)
```

**How Task 1 is verified.** `npm run typecheck` is clean. `npm test` passes all 42 files, with
`test/web/tokens.test.ts` (8 tests) and `test/web/family.test.ts` (6 tests) among them. The eight e2e tests in Step 23
pass, and so does the whole suite (50). The leftover search in Step 13 prints only the two `#fff`/`#000` lines it
names. The build ships six font files and no `data:` font.

**How it merges into `quiet-restyle`.** After review, the controller merges it in the integration worktree. Wave 0
runs alone, so the merge has no conflicts:

```bash
git -C /c/personal/InProgress/.claude/worktrees/quiet-restyle merge --no-ff quiet/t1-tokens -m "Merge Quiet Task 1: tokens and fonts (#81)" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
cd /c/personal/InProgress/.claude/worktrees/quiet-restyle && npm ci --prefer-offline --no-audit --no-fund && npm run typecheck && npm test
```

Expected: `Merge made by the 'ort' strategy.`, npm installs the two `@fontsource` packages from the cache Step 16
filled, a clean typecheck and `Test Files  42 passed (42)`. Wave 1 (Task 2 and both parts of Task 3) then cuts its
branches from `quiet-restyle`.

### Task 2: Shared glyphs: Character, characterState.ts, Marker

Size M, wave 1, after Task 1 merges. Runs beside Task 3 parts A and B; they share no files. It adds four new web
files and one unit test, and edits nothing that exists. Nothing imports the new files until Tasks 4, 5 and 6, so the
built window does not change in this task.

**Files:**
- Create: `web/src/characterState.ts` (the spec's `character.ts`, renamed; the Interface contract says why)
- Create: `web/src/Character.tsx`
- Create: `web/src/character.css`
- Create: `web/src/Marker.tsx`
- Test: `test/web/character.test.ts` (create)
- Scratch, gitignored, never committed: `.live-check/glyphs.ts`, `.live-check/glyphs.html` and three PNGs

**Interfaces:**
- Consumes:
  - From Task 1, in `web/src/styles.css`: the tokens `--bg`, `--muted`, `--faint`, `--active`, `--sky`, `--amber`,
    `--amber-fill`, `--red`, `--gone`, `--family-0` to `--family-5`, `--fs-s`, `--w-text`, `--w-heavy`; the
    `ip-pulse` keyframes; the blanket rule `@media (prefers-reduced-motion: reduce) { * { animation: none !important; } }`.
  - `familyVar(slot: number | null): string` from `web/src/family.ts`.
  - The types `Session`, `SessionState`, `SubagentInfo` and `NodeStatus` from `src/core/types.ts`.
- Produces (exact; Tasks 4, 5 and 6 consume):
  - `web/src/characterState.ts`: `type CharacterState = 'work' | 'idle' | 'wait' | 'ended'`,
    `type CharacterSize = 16 | 18 | 20 | 24`,
    `characterState(who: Pick<Session, 'state'> | Pick<SubagentInfo, 'endedAt'>): CharacterState`,
    `phaseDelay(seed: string, periodMs: number): number`.
  - `web/src/Character.tsx`: `interface CharacterProps { size: CharacterSize; state: CharacterState; slot: number | null;
    seed: string; title?: string }` and `Character(props: CharacterProps): JSX.Element`, rendering
    `span.ip-char.c-<state>[data-state][data-size]`, then for `wait` `span.ip-char-ring` and `span.ip-char-ring2`, then
    `span.ip-char-body` holding `svg[viewBox="0 0 32 32"][aria-hidden="true"]`, with the eyes of `work` and `wait` in
    `g.ip-char-eyes`.
  - `web/src/Marker.tsx`: `interface MarkerProps { status: NodeStatus; question: boolean; paused: boolean;
    needsYou: boolean; pulse: boolean; title?: string }` and `Marker(props: MarkerProps): JSX.Element`, rendering
    `span.ip-marker.m-<status>` with `q`, `m-paused`, `m-you` and `m-pulse` as the props say, and the text `?`, `✓` or
    nothing.
  - `web/src/character.css`: the character's look, the `ip-bob`, `ip-blink` and `ip-ring` keyframes, and the
    marker's look. Both components import it, so it loads after `styles.css`.
  - Computed values the e2e of Tasks 4 and 6 read: `.ip-char` `color` is the family hue (`ended`: `--gone`);
    `.ip-char-body` `animation-name` is `ip-bob` while working; `g.ip-char-eyes` is `ip-blink`; `.ip-char-ring2` is
    `ip-ring`; all three read `none` under reduced motion, while `.ip-char-ring` keeps its amber border. A paused
    marker has `background-color: rgba(0, 0, 0, 0)` and `border-top-color: rgb(2, 132, 199)` by day; an active one
    `background-color: rgb(194, 65, 12)`.

- [ ] **Step 1: Create the worktree**

```bash
git -C /c/personal/InProgress worktree add /c/personal/InProgress/.claude/worktrees/quiet-t2 -b quiet/t2-glyphs quiet-restyle
cd /c/personal/InProgress/.claude/worktrees/quiet-t2 && npm ci --prefer-offline --no-audit --no-fund
```

Expected: `Preparing worktree (new branch 'quiet/t2-glyphs')` and `HEAD is now at <sha> Merge Quiet Task 1: tokens and
fonts (#81)`, then npm reports the packages it added. If `npm ci` fails offline, run `npm ci --no-audit --no-fund`.

- [ ] **Step 2: Check that Task 1's tokens and reduced-motion rule are on the branch**

```bash
cd /c/personal/InProgress/.claude/worktrees/quiet-t2
grep -oE -- "--(bg|muted|faint|active|sky|amber|amber-fill|red|gone|family-0|fs-s|w-text|w-heavy):" web/src/styles.css | sort | uniq -c
grep -n "animation: none !important" web/src/styles.css
grep -n "@keyframes ip-pulse" web/src/styles.css
```

Expected: the first command prints a count of `2` (day and night) for `--active:`, `--amber-fill:`, `--amber:`,
`--bg:`, `--faint:`, `--family-0:`, `--gone:`, `--muted:`, `--red:` and `--sky:`, and `1` for `--fs-s:`, `--w-heavy:`
and `--w-text:`. The second and third print one line each. If any is missing, Task 1 has not merged into
`quiet-restyle`: stop and tell the controller.

- [ ] **Step 3: Write the failing unit test**

Create `test/web/character.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import type { Session, SubagentInfo } from '../../src/core/types';
import { characterState, phaseDelay } from '../../web/src/characterState';

const session = (extra: Partial<Session> = {}): Session => ({
  id: 's1abcdef', projectId: 1, title: '#5 UI Session post-Fable', cwd: null, branch: null, transcriptPath: null, state: 'working',
  focusNodeId: 127, promptsSinceUpdate: 0, startedAt: 't', lastSeenAt: 't', endedAt: null, slot: 2, subagents: [], ...extra,
});
const agent = (extra: Partial<SubagentInfo> = {}): SubagentInfo => ({
  agentId: 'a1', agentType: 'general-purpose', startedAt: 't', description: 'Draft the whiteboard take', model: 'opus-5-5', nodeId: 127,
  endedAt: null, ordinal: 10, purpose: null, ...extra,
});

describe('characterState', () => {
  it("gives a session's working, idle and permission as work, idle and wait, and an ended session ended", () => {
    expect(characterState(session({ state: 'working' }))).toBe('work');
    expect(characterState(session({ state: 'idle' }))).toBe('idle');
    expect(characterState(session({ state: 'permission' }))).toBe('wait');
    expect(characterState(session({ state: 'ended', endedAt: '2026-10-05T11:57:00Z' }))).toBe('ended');
  });

  it('reads a session by its state alone: a live session has no endedAt yet, and that never makes it a worker', () => {
    expect(characterState(session({ state: 'idle', endedAt: null }))).toBe('idle');
    expect(characterState({ state: 'permission' })).toBe('wait');
  });

  it('gives a running subagent work and a stopped one ended', () => {
    expect(characterState(agent())).toBe('work');
    expect(characterState(agent({ endedAt: '2026-10-05T11:57:00Z' }))).toBe('ended');
    expect(characterState({ endedAt: null })).toBe('work');
    expect(characterState({ endedAt: '2026-10-05T11:57:00Z' })).toBe('ended');
  });
});

describe('phaseDelay', () => {
  it('hashes the seed to a fixed negative delay', () => {
    expect(phaseDelay('s1', 2400)).toBe(-1449);
    expect(phaseDelay('s2', 2400)).toBe(-1392);
    expect(phaseDelay('s1abcdef:a1', 2400)).toBe(-1210);
    expect(phaseDelay('s1abcdef', 4600)).toBe(-3270);
  });

  it('is stable: the same seed and period give the same delay every time', () => {
    expect(phaseDelay('s1abcdef', 2400)).toBe(phaseDelay('s1abcdef', 2400));
  });

  it('starts every seed at a whole millisecond inside one period, never at or past its length', () => {
    const seeds = ['', 'a', 's1', 's1abcdef', 's1abcdef:a1', 's1abcdef:a2', 'b7f0c2d9-0000-4e1a-9f3b-77aa00cc11ee'];
    for (const period of [1800, 2400, 3600, 5200]) {
      for (const seed of seeds) {
        const delay = phaseDelay(seed, period);
        expect(Number.isInteger(delay), `${seed} at ${period}`).toBe(true);
        expect(delay, `${seed} at ${period}`).toBeLessThanOrEqual(0);
        expect(delay, `${seed} at ${period}`).toBeGreaterThan(-period);
      }
    }
  });

  it('returns 0, not -0, when the hash is a whole number of periods', () => {
    // Every hash is a whole number of 1 ms periods, so -(h % 1) is -0 before the guard.
    expect(Object.is(phaseDelay('s1', 1), 0)).toBe(true);
  });

  it('puts a chip and its kin out of step', () => {
    const delays = ['s1abcdef', 's1abcdef:a1', 's1abcdef:a2', 's2'].map((seed) => phaseDelay(seed, 2400));
    expect(new Set(delays).size).toBe(delays.length);
  });
});
```

- [ ] **Step 4: Run it and watch it fail**

```bash
cd /c/personal/InProgress/.claude/worktrees/quiet-t2 && npx vitest run test/web/character.test.ts
```

Expected: `FAIL  test/web/character.test.ts`, with `Error: Failed to load url ../../web/src/characterState (resolved
id: ../../web/src/characterState) in …/test/web/character.test.ts. Does the file exist?`, and `Test Files  1 failed
(1)`.

- [ ] **Step 5: Write the helpers**

Create `web/src/characterState.ts`:

```ts
// The Simple character's pure helpers. No DOM and no React, so test/web/character.test.ts can import this file.
import type { Session, SessionState, SubagentInfo } from '../../src/core/types';

export type CharacterState = 'work' | 'idle' | 'wait' | 'ended';
export type CharacterSize = 16 | 18 | 20 | 24;

const BY_SESSION: Record<SessionState, CharacterState> = { working: 'work', idle: 'idle', permission: 'wait', ended: 'ended' };

/** A session's state as its character's (working, idle, permission give work, idle, wait); a subagent works until it stops. */
export function characterState(who: Pick<Session, 'state'> | Pick<SubagentInfo, 'endedAt'>): CharacterState {
  return 'state' in who ? BY_SESSION[who.state] : who.endedAt === null ? 'work' : 'ended';
}

/** A negative animation-delay in ms, in (-periodMs, 0], from a 32-bit FNV-1a hash of the seed: stable per seed. */
export function phaseDelay(seed: string, periodMs: number): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < seed.length; i++) {
    h ^= seed.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return -(h % periodMs) || 0;
}
```

- [ ] **Step 6: Run the test and the root typecheck**

```bash
cd /c/personal/InProgress/.claude/worktrees/quiet-t2 && npx vitest run test/web/character.test.ts && npx tsc -p tsconfig.json
```

Expected: `✓ test/web/character.test.ts (8 tests)`, `Test Files  1 passed (1)`, `Tests  8 passed (8)`. Then `tsc`
prints nothing. The root project typechecks `test/`, and the test imports only a `.ts` file, so no TS6142.

The four literals in `hashes the seed to a fixed negative delay` (-1449, -1392, -1210, -3270) were taken by running
Step 5's `phaseDelay` in Node. If one fails here, the helper differs from Step 5: compare the two line by line and fix
the helper. Change neither a literal nor the hash to make the case pass.

- [ ] **Step 7: Commit the helpers**

```bash
git -C /c/personal/InProgress/.claude/worktrees/quiet-t2 add web/src/characterState.ts test/web/character.test.ts
git -C /c/personal/InProgress/.claude/worktrees/quiet-t2 commit -m "Add the character helpers: characterState and phaseDelay, with their unit tests (#81)" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

Expected: `2 files changed`, both `create mode`.

- [ ] **Step 8: Write the stylesheet**

Create `web/src/character.css`. No failing test first: this is styling. Step 14 checks it in Edge.

```css
/* The Simple character (Character.tsx) and the status marker (Marker.tsx). Both components import this file, so it
   loads after styles.css. Tokens come from styles.css; the keyframes ip-pulse and ip-flash stay there. Reduced motion is
   styles.css's blanket rule: it stops the bob, the blink and the outer ring, and leaves the glow and the solid ring. */

/* The character. Its hue is --fam (Character.tsx sets it from the slot); ended wears --gone. The body path fills with
   currentColor and the eyes inherit fill: var(--bg), the ground colour. Durations and delays are inline. */
.ip-char {
  --ip-glow-r: 2.5px;
  --ip-glow-mix: 30%;
  --ip-ended-opacity: 0.85;
  position: relative;
  display: inline-block;
  flex: none;
  vertical-align: middle;
  color: var(--fam, var(--family-0));
}
.ip-char[data-size='24'] { --ip-glow-r: 4px; }
@media (prefers-color-scheme: dark) {
  .ip-char { --ip-glow-mix: 50%; --ip-ended-opacity: 0.75; }
}
.ip-char.c-ended { color: var(--gone); }
.ip-char-body { position: relative; display: block; width: 100%; height: 100%; fill: var(--bg); }
.ip-char-body svg { display: block; width: 100%; height: 100%; overflow: visible; }
/* Working: it bobs from its bottom centre and glows in its hue. Only working characters glow. */
.ip-char.c-work .ip-char-body {
  transform-origin: 50% 100%;
  filter: drop-shadow(0 0 var(--ip-glow-r) color-mix(in srgb, var(--fam, var(--family-0)) var(--ip-glow-mix), transparent));
  animation-name: ip-bob;
  animation-timing-function: ease-in-out;
  animation-iteration-count: infinite;
}
.ip-char.c-idle .ip-char-body { opacity: 0.85; }
.ip-char.c-ended .ip-char-body { opacity: var(--ip-ended-opacity); }
/* Working and waiting eyes blink, each pair scaled from its own centre (transform-origin is inline). */
.ip-char-eyes {
  animation-name: ip-blink;
  animation-timing-function: ease-in-out;
  animation-iteration-count: infinite;
}
/* Waiting for permission: a solid amber ring at 1.36 x the size over --amber-fill, and a second ring that grows and
   fades. The body comes after them and is positioned, so it paints on top. */
.ip-char-ring, .ip-char-ring2 {
  position: absolute;
  inset: -18%;
  box-sizing: border-box;
  border: 1.5px solid var(--amber);
  border-radius: 50%;
}
.ip-char-ring { background: var(--amber-fill); }
.ip-char-ring2 {
  animation-name: ip-ring;
  animation-timing-function: ease-out;
  animation-iteration-count: infinite;
}
@keyframes ip-bob {
  0%, 100% { transform: translateY(0) scale(1.04, 0.96); }
  50% { transform: translateY(-14%) scale(0.98, 1.02); }
}
@keyframes ip-blink {
  0%, 91%, 100% { transform: scaleY(1); }
  94.5% { transform: scaleY(0.1); }
}
@keyframes ip-ring {
  0% { transform: scale(1); opacity: 0.85; }
  100% { transform: scale(1.45); opacity: 0; }
}

/* The status marker (Marker.tsx). Every rule names two classes or more (the base lists every status to get there), so
   it outranks any .ip-marker rule of one class in styles.css, and wins a tie of two because this file loads later. */
.ip-marker.m-todo, .ip-marker.m-active, .ip-marker.m-done, .ip-marker.m-blocked, .ip-marker.m-dropped {
  flex: none;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  box-sizing: border-box;
  width: 8px;
  height: 8px;
  border: 0;
  border-radius: 50%;
  background: transparent;
  color: var(--muted);
  font-size: var(--fs-s);
  font-weight: var(--w-text);
  line-height: 14px;
}
.ip-marker.m-todo { width: 9px; height: 9px; border: 1.5px solid var(--faint); }
.ip-marker.m-active { background: var(--active); }
.ip-marker.m-blocked { background: var(--red); }
.ip-marker.m-dropped { background: var(--faint); }
/* Done: a muted ✓, no dot. */
.ip-marker.m-done { width: 9px; height: auto; }
/* A question: a 13 px muted disc with its ? in the ground colour, whatever its status. A done question keeps the ?. */
.ip-marker.q {
  width: 13px;
  height: 13px;
  border: 0;
  background: var(--muted);
  color: var(--bg);
  font-weight: var(--w-heavy);
  line-height: 13px;
}
/* Paused: an active step nobody is on. A hollow sky ring; a question's ? takes the sky. */
.ip-marker.m-paused { width: 9px; height: 9px; border: 1.5px solid var(--sky); background: transparent; color: var(--sky); }
/* Needs you: an amber dot, whatever the status; a question's disc turns amber and keeps its ? in the ground colour. */
.ip-marker.m-you { width: 8px; height: 8px; border: 0; background: var(--amber); }
.ip-marker.q.m-paused, .ip-marker.q.m-you { width: 13px; height: 13px; }
/* On a working card an active marker pulses. */
.ip-marker.m-active.m-pulse { animation: ip-pulse 1.6s ease-in-out infinite; }
```

The values come from the spec (section 3, Markers; section 4) and `Quiet-kin-together.dc.html`'s `pip()`, `ringMark`,
`dot`, `mDone` and `mQ`. The ring's `inset: -18%` gives a box 136 % of the size, the artboard's 1.36 ×.

- [ ] **Step 9: Write the character**

Create `web/src/Character.tsx`. The SVG is copied from `Quiet-kin-together.dc.html` (lines 58 to 152 and `pip()`),
in the main checkout under `C:/personal/InProgress/.superpowers/iter/2026-10-02/mockups/project/`.

```tsx
import type { CSSProperties } from 'react';
import { phaseDelay, type CharacterSize, type CharacterState } from './characterState';
import { familyVar } from './family';
import './character.css';

export interface CharacterProps {
  size: CharacterSize;
  state: CharacterState;
  /** The family it wears: the root span sets `--fam: familyVar(slot)`. `ended` wears `--gone` whatever the slot. */
  slot: number | null;
  /** Stable per character: phaseDelay hashes it. A session's id for a chip or a lead; `${sessionId}:${agentId}` for a kin. */
  seed: string;
  /** A tooltip on the root span (the lead's: leadTitle). The SVG stays aria-hidden. */
  title?: string;
}

// Simple, as Quiet-kin-together.dc.html draws it on a 32 x 32 grid.
const BODY = 'M13 5Q16 2 19 5Q24 8 27 13Q30 16 27 19Q24 24 19 27Q16 30 13 27Q8 24 5 19Q2 16 5 13Q8 8 13 5Z';
/** A 24 px worker's shade, over the lower body. */
const SHADE = 'M5 19Q8 24 13 27Q16 30 19 27Q24 24 27 19Q16 25.5 5 19Z';
/** A 24 px worker's sheen, at the upper left. */
const SHEEN = 'M8 11.8Q9.4 9.4 11.8 8';
/** An ended character's eyes: two short lines. */
const ENDED_EYES = 'M9.4 15.8H13.6M18.4 15.8H22.6';

// Motion periods in ms. Each animated element gets its period as animation-duration and a phaseDelay as
// animation-delay, so the period lives here once; character.css names the keyframes.
const BOB_MS = 2400;
const RING_MS = 1800;

/** The eyes that blink, in g.ip-char-eyes: round, with their centres, radius and blink period. Idle and ended have none. */
function blinkingEyes(state: CharacterState, size: CharacterSize) {
  if (state === 'wait') return { xs: [11.5, 20.5], cy: 14.8, r: 2.7, blinkMs: 3600 };
  if (state !== 'work') return null;
  return size === 24 ? { xs: [12.5, 19.5], cy: 15, r: 2.1, blinkMs: 5200 } : { xs: [11.5, 20.5], cy: 15.5, r: 2.4, blinkMs: 5200 };
}

/** One animation's period, and where in it this character starts. */
const timing = (seed: string, periodMs: number): CSSProperties => ({
  animationDuration: `${periodMs}ms`,
  animationDelay: `${phaseDelay(seed, periodMs)}ms`,
});

/** A session or a subagent as a small creature in its family's hue: working, idle, waiting for permission, or ended. */
export function Character({ size, state, slot, seed, title }: CharacterProps) {
  const eyes = blinkingEyes(state, size);
  return (
    <span
      className={`ip-char c-${state}`}
      data-state={state}
      data-size={size}
      title={title}
      style={{ width: size, height: size, '--fam': familyVar(slot) } as CSSProperties}
    >
      {state === 'wait' && (
        <>
          <span className="ip-char-ring" />
          <span className="ip-char-ring2" style={timing(seed, RING_MS)} />
        </>
      )}
      <span className="ip-char-body" style={state === 'work' ? timing(seed, BOB_MS) : undefined}>
        <svg viewBox="0 0 32 32" aria-hidden="true">
          {state === 'ended' ? (
            <>
              <path d={BODY} fill="currentColor" fillOpacity={0.1} stroke="currentColor" strokeWidth={2.6} strokeLinejoin="round" />
              <path d={ENDED_EYES} fill="none" stroke="currentColor" strokeWidth={2.2} strokeLinecap="round" />
            </>
          ) : (
            <path d={BODY} fill="currentColor" />
          )}
          {state === 'work' && size === 24 && (
            <>
              <path d={SHADE} fill="#000" fillOpacity={0.14} />
              <path d={SHEEN} fill="none" stroke="#fff" strokeOpacity={0.45} strokeWidth={1.4} strokeLinecap="round" />
            </>
          )}
          {state === 'idle' && (
            <>
              <rect x={9.2} y={15.4} width={4.6} height={2.2} rx={1.1} />
              <rect x={18.2} y={15.4} width={4.6} height={2.2} rx={1.1} />
            </>
          )}
          {eyes && (
            <g className="ip-char-eyes" style={{ transformOrigin: `16px ${eyes.cy}px`, ...timing(seed, eyes.blinkMs) }}>
              {eyes.xs.map((cx) => (
                <circle key={cx} cx={cx} cy={eyes.cy} r={eyes.r} />
              ))}
            </g>
          )}
        </svg>
      </span>
    </span>
  );
}
```

- [ ] **Step 10: Write the marker**

Create `web/src/Marker.tsx`. Its DOM is the contract's, exactly. NodeCard (Task 6) and Details (Task 5) render it;
this task does not touch either file.

```tsx
import type { NodeStatus } from '../../src/core/types';
import './character.css';

export interface MarkerProps {
  status: NodeStatus;
  /** node.kind === 'question': the ? disc. A done question keeps the ?. */
  question: boolean;
  /** LayoutNodeItem.paused: the hollow sky ring. */
  paused: boolean;
  /** isNeedsYou(node): the amber dot. */
  needsYou: boolean;
  /** LayoutNodeItem.working: an active marker pulses (ip-pulse). Details passes false. */
  pulse: boolean;
  /** The card passes `Nobody is on this. Last change ${lastChange}` when paused. */
  title?: string;
}

/** A step's status marker, on a card's header and in Details' step list. Its look is in character.css. */
export function Marker({ status, question, paused, needsYou, pulse, title }: MarkerProps) {
  return (
    <span
      className={['ip-marker', `m-${status}`, question && 'q', paused && 'm-paused', needsYou && 'm-you', pulse && 'm-pulse'].filter(Boolean).join(' ')}
      title={title}
    >
      {question ? '?' : status === 'done' ? '✓' : ''}
    </span>
  );
}
```

- [ ] **Step 11: Typecheck both projects**

```bash
cd /c/personal/InProgress/.claude/worktrees/quiet-t2 && npm run typecheck
```

Expected: npm echoes `tsc -p tsconfig.json && tsc -p web/tsconfig.json`, and neither prints an error. Exit code 0.
`web/tsconfig.json` includes `src`, so it checks the three new web files although nothing imports them yet.

- [ ] **Step 12: Commit the components and their stylesheet**

```bash
git -C /c/personal/InProgress/.claude/worktrees/quiet-t2 add web/src/Character.tsx web/src/Marker.tsx web/src/character.css
git -C /c/personal/InProgress/.claude/worktrees/quiet-t2 commit -m "Add the Simple character and the shared status marker, with their stylesheet (#81)" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

Expected: `3 files changed`, all `create mode`.

- [ ] **Step 13: Write the look check (scratch, not committed)**

Nothing renders the glyphs until wave 2, so check them once in Edge now. Vitest cannot do it: it runs in Node and
cannot import a `.tsx` file under the root typecheck. `vite-node` (installed with Vitest) can, and Playwright drives
Edge as the e2e does. `.live-check/` is gitignored and outside both typecheck projects.

Make the folder, then create `.live-check/glyphs.ts` in the worktree:

```bash
mkdir -p /c/personal/InProgress/.claude/worktrees/quiet-t2/.live-check
```

```ts
// Task 2's look check: renders every character state and the marker cases into glyphs.html beside this file, opens it
// in Edge by day, by night and under reduced motion, compares computed styles with the spec, and saves screenshots.
// Run from the worktree: npx vite-node .live-check/glyphs.ts
import { writeFileSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { chromium } from '@playwright/test';
import { createElement as h, type ReactElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { Character } from '../web/src/Character';
import { Marker } from '../web/src/Marker';

const cases: [string, ReactElement][] = [
  ['chip-wait', h(Character, { size: 18, state: 'wait', slot: 0, seed: 's1abcdef' })],
  ['lead-work', h(Character, { size: 24, state: 'work', slot: 2, seed: 's2', title: 'C · #5 UI Session post-Fable · working · 3 subagents' })],
  ['lead-idle', h(Character, { size: 20, state: 'idle', slot: 1, seed: 's3' })],
  ['kin-work', h(Character, { size: 16, state: 'work', slot: 2, seed: 's2:a10' })],
  ['kin-ended', h(Character, { size: 16, state: 'ended', slot: 2, seed: 's2:a11' })],
  ['m-todo', h(Marker, { status: 'todo', question: false, paused: false, needsYou: false, pulse: false })],
  ['m-working', h(Marker, { status: 'active', question: false, paused: false, needsYou: false, pulse: true })],
  ['m-paused', h(Marker, { status: 'active', question: false, paused: true, needsYou: false, pulse: false, title: 'Nobody is on this. Last change 4 d ago' })],
  ['m-you', h(Marker, { status: 'todo', question: false, paused: false, needsYou: true, pulse: false })],
  ['m-done', h(Marker, { status: 'done', question: false, paused: false, needsYou: false, pulse: false })],
  ['m-question', h(Marker, { status: 'done', question: true, paused: false, needsYou: false, pulse: false })],
  ['m-blocked', h(Marker, { status: 'blocked', question: false, paused: false, needsYou: false, pulse: false })],
];
const rows = cases.map(([id, el]) => `<p id="${id}" style="display:flex;align-items:center;gap:8px;margin:8px">${renderToStaticMarkup(el)} ${id}</p>`);
const html = fileURLToPath(new URL('glyphs.html', import.meta.url));
writeFileSync(
  html,
  `<!doctype html><html><head><meta charset="utf-8">
<link rel="stylesheet" href="../web/src/styles.css"><link rel="stylesheet" href="../web/src/character.css">
</head><body style="padding:12px">${rows.join('\n')}</body></html>`,
);

/** [case id, selector inside it, CSS property, expected computed value]. A RegExp where Edge's serialization varies. */
type Check = [string, string, string, string | RegExp];
/** A working glow: Edge writes color-mix() as color(srgb r g b / alpha), so match the alpha and the radius. */
const glow = (alpha: string, radius: string) => new RegExp(String.raw`^drop-shadow\(color\(srgb [\d. ]+ / ${alpha}\) 0px 0px ${radius}\)$`);
const day: Check[] = [
  ['chip-wait', '.ip-char', 'color', 'rgb(11, 107, 125)'],
  ['chip-wait', '.ip-char-ring', 'border-top-color', 'rgb(217, 119, 6)'],
  ['chip-wait', '.ip-char-ring', 'background-color', 'rgba(251, 191, 36, 0.18)'],
  ['chip-wait', '.ip-char-ring', 'width', /^24\.4\d*px$/],
  ['chip-wait', '.ip-char-ring2', 'animation-name', 'ip-ring'],
  ['chip-wait', 'g.ip-char-eyes', 'animation-name', 'ip-blink'],
  ['lead-work', '.ip-char-body', 'animation-name', 'ip-bob'],
  ['lead-work', '.ip-char-body', 'filter', glow('0.3', '4px')],
  ['kin-work', '.ip-char-body', 'filter', glow('0.3', '2.5px')],
  ['lead-work', 'circle', 'fill', 'rgb(248, 250, 252)'],
  ['lead-idle', '.ip-char-body', 'opacity', '0.85'],
  ['kin-ended', '.ip-char', 'color', 'rgb(100, 116, 139)'],
  ['kin-ended', '.ip-char-body', 'opacity', '0.85'],
  ['m-todo', '.ip-marker', 'border-top-color', 'rgb(100, 116, 139)'],
  ['m-todo', '.ip-marker', 'width', '9px'],
  ['m-working', '.ip-marker', 'background-color', 'rgb(194, 65, 12)'],
  ['m-working', '.ip-marker', 'animation-name', 'ip-pulse'],
  ['m-paused', '.ip-marker', 'background-color', 'rgba(0, 0, 0, 0)'],
  ['m-paused', '.ip-marker', 'border-top-color', 'rgb(2, 132, 199)'],
  ['m-you', '.ip-marker', 'background-color', 'rgb(217, 119, 6)'],
  ['m-you', '.ip-marker', 'border-top-width', '0px'],
  ['m-done', '.ip-marker', 'color', 'rgb(71, 85, 105)'],
  ['m-done', '.ip-marker', 'background-color', 'rgba(0, 0, 0, 0)'],
  ['m-question', '.ip-marker', 'background-color', 'rgb(71, 85, 105)'],
  ['m-question', '.ip-marker', 'color', 'rgb(248, 250, 252)'],
  ['m-question', '.ip-marker', 'width', '13px'],
  ['m-blocked', '.ip-marker', 'background-color', 'rgb(185, 28, 28)'],
];
const night: Check[] = [
  ['lead-work', '.ip-char', 'color', 'rgb(122, 214, 143)'],
  ['lead-work', '.ip-char-body', 'filter', glow('0.5', '4px')],
  ['lead-work', 'circle', 'fill', 'rgb(8, 13, 28)'],
  ['kin-ended', '.ip-char', 'color', 'rgb(148, 163, 184)'],
  ['kin-ended', '.ip-char-body', 'opacity', '0.75'],
];
const still: Check[] = [
  ['lead-work', '.ip-char-body', 'animation-name', 'none'],
  ['lead-work', 'g.ip-char-eyes', 'animation-name', 'none'],
  ['chip-wait', '.ip-char-ring2', 'animation-name', 'none'],
  ['m-working', '.ip-marker', 'animation-name', 'none'],
  ['chip-wait', '.ip-char-ring', 'border-top-color', 'rgb(217, 119, 6)'],
  ['lead-work', '.ip-char-body', 'filter', glow('0.3', '4px')],
];

const out = fileURLToPath(new URL('.', import.meta.url));
const browser = await chromium.launch({ channel: 'msedge' });
let checks = 0;
let misses = 0;
try {
  for (const [name, colorScheme, reducedMotion, list] of [
    ['day', 'light', 'no-preference', day],
    ['night', 'dark', 'no-preference', night],
    ['still', 'light', 'reduce', still],
  ] as const) {
    const tab = await browser.newPage({ viewport: { width: 360, height: 560 }, colorScheme, reducedMotion });
    await tab.goto(pathToFileURL(html).href);
    for (const [id, selector, property, expected] of list) {
      const actual = await tab.locator(`#${id} ${selector}`).first().evaluate((el, p) => getComputedStyle(el).getPropertyValue(p), property);
      checks++;
      if (typeof expected === 'string' ? actual !== expected : !expected.test(actual)) {
        misses++;
        console.log(`MISMATCH ${name} #${id} ${selector} ${property}: ${actual} (expected ${expected})`);
      }
    }
    await tab.screenshot({ path: `${out}glyphs-${name}.png` });
    await tab.close();
  }
} finally {
  await browser.close();
}
console.log(`${checks} checks, ${misses} mismatches. Screenshots: glyphs-day.png, glyphs-night.png, glyphs-still.png in ${out}`);
process.exitCode = misses ? 1 : 0;
```

The expected values are the contract's day and night tokens: `--family-0` day `#0b6b7d`, `--family-2` `#287a3a` and
`#7ad68f`, `--amber` `#d97706`, `--amber-fill` `rgba(251,191,36,.18)`, `--bg` `#f8fafc` and `#080d1c`, `--gone` and
`--faint` `#64748b` by day, `--gone` `#94a3b8` by night, `--active` `#c2410c`, `--sky` `#0284c7`, `--muted` `#475569`,
`--red` `#b91c1c`. The page loads the branch's whole `styles.css`, old `.ip-marker` rules included, so the check also
proves the marker rules win over them.

- [ ] **Step 14: Run the look check and look at it**

```bash
cd /c/personal/InProgress/.claude/worktrees/quiet-t2 && npx vite-node .live-check/glyphs.ts
```

Expected: `38 checks, 0 mismatches. Screenshots: glyphs-day.png, glyphs-night.png, glyphs-still.png in
…\quiet-t2\.live-check\`, exit code 0. A `MISMATCH` line names the case, selector, property, the actual value and the
expected one. Fix the rule in `character.css` (or the markup in `Character.tsx` or `Marker.tsx`), amend nothing,
commit the fix as a new commit with a subject ending `(#81)`, and run the check again.

Then open the three PNGs beside the script. By day: a teal character on a light amber ring (`chip-wait`), a larger
green one with a soft glow, shade and sheen (`lead-work`), a clay one with lid eyes (`lead-idle`), a small green one
(`kin-work`), a hollow grey one with line eyes (`kin-ended`); then the markers: a grey ring, an orange dot, a sky ring,
an amber dot, a grey `✓`, a grey disc holding a light `?`, a red dot. By night the characters' eyes go dark. Compare
them with `Quiet-kin-together.dc.html`'s chip and #127 lines.

- [ ] **Step 15: Remove the look check**

```bash
cd /c/personal/InProgress/.claude/worktrees/quiet-t2 && rm -f .live-check/glyphs.ts .live-check/glyphs.html .live-check/glyphs-day.png .live-check/glyphs-night.png .live-check/glyphs-still.png && git status --short
```

Expected: no output from `git status --short`.

- [ ] **Step 16: Run the task's gate**

```bash
cd /c/personal/InProgress/.claude/worktrees/quiet-t2 && npm run typecheck && npm test
git -C /c/personal/InProgress/.claude/worktrees/quiet-t2 diff --stat quiet-restyle...HEAD
git -C /c/personal/InProgress/.claude/worktrees/quiet-t2 log --oneline quiet-restyle..HEAD
```

Expected: typecheck clean; Vitest reports every test file passed and 0 failed, with
`test/web/character.test.ts (8 tests)` among them. The diff stat lists exactly five files, all new:
`test/web/character.test.ts`, `web/src/Character.tsx`, `web/src/Marker.tsx`, `web/src/character.css` and
`web/src/characterState.ts`. The log shows the two commits of Steps 7 and 12 (and any fix from Step 14).

No e2e runs in this task. It changes no existing file, so no module imports the new ones and the built window is the
same as `quiet-restyle`'s. The e2e that cover these glyphs belong to the tasks that render them: Task 4's T284 l.288
(the chip's `.ip-char-body` and `g.ip-char-eyes` read `none` under reduced motion) and the rewritten T1028
(`data-state="wait"`, `.ip-char-ring2` on `ip-ring`, then `none` while `.ip-char-ring` stays visible); Task 6's T284
l.289 (`.ip-node.working .ip-marker.m-active`), T465 l.476-477 and l.484 (the paused and active markers), and the new
canvas test (the lead's `data-state` is `work`, `ip-bob` and `ip-blink`, an ended kin's `data-state` is `ended`).
This worktree's `INPROGRESS_E2E_PORT`, 4392, stays unused.

- [ ] **Step 17: Merge into `quiet-restyle` (the controller, at the end of wave 1)**

Task 2 merges first in wave 1, before `quiet/t3-live`. In the integration worktree:

```bash
git -C /c/personal/InProgress/.claude/worktrees/quiet-restyle merge --no-ff quiet/t2-glyphs -m "Merge Quiet Task 2: shared glyphs (#81)" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
cd /c/personal/InProgress/.claude/worktrees/quiet-restyle && npm ci --prefer-offline --no-audit --no-fund && npm run typecheck && npm test
```

Expected: `Merge made by the 'ort' strategy.` with `5 files changed` and five `create mode` lines, then a clean
typecheck and every unit test passing. The merge cannot conflict: Task 2 only adds files, and no other task adds
these paths. Then merge `quiet/t3-live` as the contract's wave merge says. Tasks 4, 5 and 6 cut their branches from
`quiet-restyle` after both merges and import the glyphs as the Interface contract shows, with no file extension.

**How Task 2 is verified:** `npm run typecheck` (both projects, the new `.tsx` files included), `npm test` with the
eight new cases in `test/web/character.test.ts` (written first and seen failing), and the one-off look check in Edge
(38 computed-style checks by day, by night and under reduced motion, plus three screenshots). It touches no e2e test.

### Task 3: Layout and copy helpers (live.ts part merges in wave 1; layout and breadcrumb part merges with Task 6)

Size M to L, wave 1, after Task 1. Two parts on two branches, run in parallel with Task 2. Part A adds four copy
helpers and `WORDS` to `web/src/live.ts`; it merges into `quiet-restyle` at the end of wave 1, because Task 4 needs
them. Part B gives `src/core/layout.ts` the Quiet geometry and fixes the breadcrumb for tall cards; it never merges
alone, because `Canvas.tsx` still reads the `badge` and `agent` items it removes. Task 6 merges Part B into its own
branch first, and the two reach `quiet-restyle` together in Task 7.

**Files:** line numbers are at `0b786b8`. Task 1 changes none of these files, so they hold at the cut point.

Part A (branch `quiet/t3-live`, worktree `/c/personal/InProgress/.claude/worktrees/quiet-t3-live`):
- Modify: `web/src/live.ts:1` (the import), then append after `:118`
- Test: `test/web/live.test.ts:3` (the import), then append after `:222`. The `chipLabel` cases (`:97-108`) do not change.

Part B (branch `quiet/t3-layout`, worktree `/c/personal/InProgress/.claude/worktrees/quiet-t3-layout`):
- Modify: `src/core/layout.ts:4-13` (pitch), `:38-39` (`LayoutNodeItem`), `:57-83` (badge and agent items),
  `:124-127` (`LayoutWorkDoneItem`), `:140-161` (`LayoutItem`, `LayoutResult`), `:294-459` (`layoutOutline`)
- Modify: `web/src/canvas/breadcrumb.ts:1, 7`
- Test: `test/core/layout.test.ts:2, 31-129, 149-339, 353-356, 544-556, 585-587`
- Test: `test/web/breadcrumb.test.ts:2-4, 22-24`

Not touched by either part: `web/src/canvas/BadgeNode.tsx` keeps its own local `WORDS` until Task 6 deletes the file.
`Canvas.tsx`, `useCamera.ts`, `sheet.ts`, `test/web/sheet.test.ts` (it reads `NODE_H` by name and holds at 32), every
`.tsx`, `styles.css` and `test/e2e/ui.spec.ts` stay as they are. Task 3 runs no e2e, so its port 4393 stays unused.

**Interfaces:**
- Consumes (Part A), unchanged: from `web/src/live.ts`, `chipLabel(s: Session): string`,
  `agentLine(a: SubagentInfo, now: number, underNode: number | null = null): string` and
  `withTag(tag: string, text: string): string`; from `src/core/types.ts`, `sessionTag(slot: number | null): string`,
  `agentTag(slot: number | null, ordinal: number | null): string`,
  `sessionDisplayTitle(s: Pick<Session, 'id' | 'title'>): string`, `type Session`, `type SessionState` and
  `type SubagentInfo`.
- Consumes (Part B), unchanged: `computeVisible` and its `VisibleItem` rows (`src/core/tree.ts:116-119`), with
  `TreeNode.kind` (`'phase'`); and layout's own `agentVisible`, `agentHome`, `homedTrailAgents` and `queueView`.
- Produces (Part A), for Tasks 4 and 6:
  - `WORDS: Record<SessionState, string>`
  - `chipName(s: Session): string`
  - `leadTitle(s: Session): string`
  - `kinTitle(a: SubagentInfo, slot: number | null, now: number, underNode: number | null = null): string`
  - `runTime(fromIso: string, now: number): string`
- Produces (Part B), for Task 6:
  - Exported pitch: `NODE_H` 32, `CARD_GAP` 10, `ROW` 42, `FOLD_ROW` 36, `AGENT_LINE` 28, `READERS_LINE` 20,
    `DONE_LINE` 20, `TASK_ROW` 22, `CARD_PAD` 8, `INDENT` 28, `STACK_HEAD` 43. Removed: `BADGE_ROW`, `WORK_ROW`,
    `WORK_GAP`, `READERS_ROW`.
  - `LayoutLineItem` and `LayoutLane` (new); `LayoutNodeItem` gains `h`, `w`, `stack` and `workingFocus`;
    `LayoutWorkDoneItem` gains `shared`; `LayoutResult` gains `lanes`; `LayoutBadgeItem` and `LayoutAgentItem` are
    removed from `LayoutItem`.
  - `breadcrumbFor` reads `i.y + i.h > top`.

#### Part A: the copy helpers

These are pure string helpers. Nothing renders them yet: Task 4's chips read `chipName` and `WORDS`, and Task 6's
agent line reads `WORDS`, `leadTitle`, `kinTitle` and `runTime`. They are test-first, in two red-green rounds.

- [ ] **Step 1: Check that Task 1 has merged, then make Part A's worktree**

```bash
git -C /c/personal/InProgress log --merges --oneline -1 quiet-restyle
git -C /c/personal/InProgress worktree add /c/personal/InProgress/.claude/worktrees/quiet-t3-live -b quiet/t3-live quiet-restyle
cd /c/personal/InProgress/.claude/worktrees/quiet-t3-live && npm ci --prefer-offline --no-audit --no-fund
```

Expected: the log line ends `Merge Quiet Task 1: tokens and fonts (#81)`. If it does not, stop: wave 1 starts after
that merge. Then `Preparing worktree (new branch 'quiet/t3-live')`, and npm reports the packages it added. If `npm ci`
fails offline, run `npm ci --no-audit --no-fund`. Every Part A command below runs in this worktree.

- [ ] **Step 2: Write the failing tests for the chip name and the lead title**

In `test/web/live.test.ts`, replace line 3:

```ts
import { agentLine, chipLabel, circled, elapsed, queueMark, taskFamily, taskOwner, trailAgentLine, trailLabel, waitsFor, withTag, withoutOwnId, workMark } from '../../web/src/live';
```

with:

```ts
import { WORDS, agentLine, chipLabel, chipName, circled, elapsed, leadTitle, queueMark, taskFamily, taskOwner, trailAgentLine, trailLabel, waitsFor, withTag, withoutOwnId, workMark } from '../../web/src/live';
```

Then append to the end of the file (after the `waitsFor` block, line 222):

```ts
describe('chipName', () => {
  it('leads the chip label with the session letter', () => {
    expect(chipName(session({ title: "#4 Implement Fable's Notes", state: 'permission' }))).toBe("A · #4 Implement Fable's Notes · needs permission");
    const three = [agent(), agent({ agentId: 'a2' }), agent({ agentId: 'a3' })];
    expect(chipName(session({ slot: 2, title: '#5 UI Session post-Fable', subagents: three }))).toBe('C · #5 UI Session post-Fable · 3 subagents');
    expect(chipName(session({ slot: 1, title: '#2 InProgress Dev Session', state: 'idle' }))).toBe('B · #2 InProgress Dev Session · idle');
  });

  it('is the bare chip label while the slot is empty', () => {
    expect(chipName(session({ slot: null, title: '#2 InProgress Dev Session', state: 'idle' }))).toBe('#2 InProgress Dev Session · idle');
  });
});

describe('leadTitle', () => {
  it('names the letter, the title and the state word, then the running subagents, readers included', () => {
    const three = [agent(), agent({ agentId: 'a2', agentType: 'general-purpose' }), agent({ agentId: 'a3', agentType: 'general-purpose' })];
    expect(leadTitle(session({ slot: 2, title: '#5 UI Session post-Fable', subagents: three }))).toBe('C · #5 UI Session post-Fable · working · 3 subagents');
    expect(leadTitle(session({ state: 'idle' }))).toBe('A · E2E session · idle');
    expect(leadTitle(session({ state: 'permission' }))).toBe('A · E2E session · needs permission');
  });

  it('counts only the subagents still running, and drops the letter while the slot is empty', () => {
    const subagents = [agent(), agent({ agentId: 'a2', endedAt: ago(MIN) })];
    expect(leadTitle(session({ slot: 1, title: 'Second session', subagents }))).toBe('B · Second session · working · 1 subagent');
    expect(leadTitle(session({ slot: null }))).toBe('E2E session · working');
  });

  it('takes its state words from WORDS', () => {
    expect(WORDS).toEqual({ working: 'working', idle: 'idle', permission: 'needs permission', ended: 'ended' });
  });
});
```

The `session()` helper (`:12-15`) is `E2E session`, slot 0, working. The `agent()` helper (`:9-11`) is an `Explore`
reader, running for 12 minutes, so the first `leadTitle` case shows that readers count.

- [ ] **Step 3: Run the tests to see them fail**

```bash
cd /c/personal/InProgress/.claude/worktrees/quiet-t3-live && npm test -- test/web/live.test.ts
```

Expected: `Tests  5 failed | 28 passed (33)`. Four fail with `TypeError: chipName is not a function` or
`TypeError: leadTitle is not a function`; the `WORDS` case fails its `toEqual` on `undefined`.

- [ ] **Step 4: Add `WORDS`, `chipName` and `leadTitle`**

In `web/src/live.ts`, replace line 1:

```ts
import { agentTag, ownerTag, sessionDisplayTitle, type PastSession, type Session, type SubagentInfo, type TrailAgent, type WorkItem, type WorkStatus } from '../../src/core/types';
```

with:

```ts
import { agentTag, ownerTag, sessionDisplayTitle, sessionTag, type PastSession, type Session, type SessionState, type SubagentInfo, type TrailAgent, type WorkItem, type WorkStatus } from '../../src/core/types';
```

Then append to the end of the file (after `waitsFor`, line 118):

```ts
/** A session's state as a word: on its agent line and in its lead's tooltip. */
export const WORDS: Record<SessionState, string> = { working: 'working', idle: 'idle', permission: 'needs permission', ended: 'ended' };

/** A session chip's accessible name: its letter, then chipLabel. */
export function chipName(s: Session): string {
  return withTag(sessionTag(s.slot), chipLabel(s));
}

/** The lead character's tooltip: letter, title, state word, and how many subagents still run (readers included). */
export function leadTitle(s: Session): string {
  const running = s.subagents.filter((a) => a.endedAt === null).length;
  const count = running ? ` · ${running} subagent${running > 1 ? 's' : ''}` : '';
  return withTag(sessionTag(s.slot), `${sessionDisplayTitle(s)} · ${WORDS[s.state]}${count}`);
}
```

- [ ] **Step 5: Run the tests to see them pass**

```bash
cd /c/personal/InProgress/.claude/worktrees/quiet-t3-live && npm test -- test/web/live.test.ts
```

Expected: `Tests  33 passed (33)`.

- [ ] **Step 6: Commit**

```bash
git -C /c/personal/InProgress/.claude/worktrees/quiet-t3-live add web/src/live.ts test/web/live.test.ts
git -C /c/personal/InProgress/.claude/worktrees/quiet-t3-live commit -m "Add the chip name and the lead title to the copy helpers (#81)" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

Expected: `2 files changed`.

- [ ] **Step 7: Write the failing tests for the kin title and the run time**

In `test/web/live.test.ts`, replace line 3 again:

```ts
import { WORDS, agentLine, chipLabel, chipName, circled, elapsed, leadTitle, queueMark, taskFamily, taskOwner, trailAgentLine, trailLabel, waitsFor, withTag, withoutOwnId, workMark } from '../../web/src/live';
```

with:

```ts
import { WORDS, agentLine, chipLabel, chipName, circled, elapsed, kinTitle, leadTitle, queueMark, runTime, taskFamily, taskOwner, trailAgentLine, trailLabel, waitsFor, withTag, withoutOwnId, workMark } from '../../web/src/live';
```

Then append to the end of the file:

```ts
describe('kinTitle', () => {
  const kin = (extra: Partial<SubagentInfo> = {}) =>
    agent({ agentType: 'general-purpose', ordinal: 10, description: 'Draft the whiteboard take', model: 'opus-5-5', startedAt: ago(18 * MIN), nodeId: null, ...extra });

  it('is the tagged agent line, then the purpose on a second line', () => {
    const purpose = 'You draft the whiteboard take of the InProgress window.';
    expect(kinTitle(kin({ purpose }), 2, NOW)).toBe(`c10 · Draft the whiteboard take · opus-5-5 · 18 min\n${purpose}`);
  });

  it('says when an ended kin finished, and leaves out a purpose it does not know', () => {
    expect(kinTitle(kin({ ordinal: 11, description: 'Draft the quiet take', endedAt: ago(3 * MIN) }), 2, NOW)).toBe('c11 · Draft the quiet take · opus-5-5 · done 3 min ago');
  });

  it('has no tag while the number is unknown, and drops the #id of the step it sits on', () => {
    expect(kinTitle(kin({ ordinal: null }), 2, NOW)).toBe('Draft the whiteboard take · opus-5-5 · 18 min');
    expect(kinTitle(agent({ description: '#57 Wire up RevenueCat' }), 0, NOW, 57)).toBe('a1 · Wire up RevenueCat · sonnet · 12 min');
  });
});

describe('runTime', () => {
  it('writes the minutes elapsed counts, compact: no spaces, at most five characters', () => {
    const at = [0.5, 18, 59, 60, 65, 165, 599, 600, 725].map((m) => runTime(ago(m * MIN), NOW));
    expect(at).toEqual(['<1m', '18m', '59m', '1h', '1h5m', '2h45m', '9h59m', '10h', '12h']);
    expect(at.every((s) => s.length <= 5 && !s.includes(' '))).toBe(true);
  });

  it('reads a start in the future (clock skew) as just started', () => {
    expect(runTime(ago(-5_000), NOW)).toBe('<1m');
  });
});
```

`NOW` is `2026-10-02T12:00:00Z` and `ago(ms)` is an ISO time that long before it (`:5-7`). The `kin()` helper is
the spec's `c10` worker on slot 2 (C).

- [ ] **Step 8: Run the tests to see them fail**

```bash
cd /c/personal/InProgress/.claude/worktrees/quiet-t3-live && npm test -- test/web/live.test.ts
```

Expected: `Tests  5 failed | 33 passed (38)`, each with `TypeError: kinTitle is not a function` or
`TypeError: runTime is not a function`.

- [ ] **Step 9: Add `kinTitle` and `runTime`**

Append to the end of `web/src/live.ts`:

```ts
/** A kin's tooltip and accessible name: `withTag(tag, agentLine(...))`, then a newline and the purpose when known. */
export function kinTitle(a: SubagentInfo, slot: number | null, now: number, underNode: number | null = null): string {
  const line = withTag(agentTag(slot, a.ordinal), agentLine(a, now, underNode));
  return a.purpose ? `${line}\n${a.purpose}` : line;
}

/** A running kin's elapsed time, compact: no spaces, at most five characters. The minutes are elapsed's. */
export function runTime(fromIso: string, now: number): string {
  const minutes = Math.floor(Math.max(0, now - Date.parse(fromIso)) / 60_000);
  if (minutes < 1) return '<1m';
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return hours < 10 && rest ? `${hours}h${rest}m` : `${hours}h`;
}
```

`runTime` takes its minutes the way `elapsed` (`:29-35`) does, so a kin's `18m` and its tooltip's `18 min` always
agree.

- [ ] **Step 10: Run the tests to see them pass**

```bash
cd /c/personal/InProgress/.claude/worktrees/quiet-t3-live && npm test -- test/web/live.test.ts
```

Expected: `Tests  38 passed (38)`.

- [ ] **Step 11: Typecheck and run the whole unit suite**

```bash
cd /c/personal/InProgress/.claude/worktrees/quiet-t3-live && npm run typecheck && npm test
```

Expected: both `tsc` runs print nothing. Vitest reports every test file passed and 0 failed, with
`test/web/live.test.ts (38 tests)`.

- [ ] **Step 12: Commit**

```bash
git -C /c/personal/InProgress/.claude/worktrees/quiet-t3-live add web/src/live.ts test/web/live.test.ts
git -C /c/personal/InProgress/.claude/worktrees/quiet-t3-live commit -m "Add the kin title and the run time to the copy helpers (#81)" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

Expected: `2 files changed`. Part A is done. Tell the controller `quiet/t3-live` is ready for the wave 1 merge.

#### Part B: the layout and the breadcrumb

Layout turns the visible outline into rows with absolute positions. Today a card is 24 px, and each session's badge,
each subagent, each readers row, the done row and each task are rows of their own under it, every card at
`depth × 28`. After this part, each row item still has its own absolute `y`, but the `y` falls inside its card: a
card gets a height `h` that holds its lines, a width `w` to a shared right edge at flow x 506, and the next card
starts `CARD_GAP` below it. A session's badge and its subagents merge into one `line` item per session per card.
Depth-1 phases become stack heads that open a lane, returned in `lanes`. Edges run only inside a card's subtree.

The contract's worked examples are in the tests as literal numbers (x 8, 22, 56 and 84; the `y`, `h` and lane
values), since the placement constants are module-private. The layout part is one function, so it is one red-green
round: all the test edits, then the code.

- [ ] **Step 13: Make Part B's worktree**

```bash
git -C /c/personal/InProgress log --merges --oneline -1 quiet-restyle
git -C /c/personal/InProgress worktree add /c/personal/InProgress/.claude/worktrees/quiet-t3-layout -b quiet/t3-layout quiet-restyle
cd /c/personal/InProgress/.claude/worktrees/quiet-t3-layout && npm ci --prefer-offline --no-audit --no-fund
```

Expected: as in Step 1, the log line ends `Merge Quiet Task 1: tokens and fonts (#81)` (Part B may run before, after
or beside Part A; it needs only Task 1). Then `Preparing worktree (new branch 'quiet/t3-layout')`, and npm reports the
packages it added. Every Part B command below runs in this worktree.

Steps 14 to 18 edit `test/core/layout.test.ts` from the bottom up, so each step's line numbers are the file's own
lines before any edit. Match on the text shown.

- [ ] **Step 14: Move the two trail tests to the new pitch**

At lines 585-587 (in `shows a live session's stopped subagent as its greyed badge …`), replace:

```ts
    expect(rowsOf(l, 'agent', 'workDone', 'trailAgent').map(([kind, id]) => [kind, id])).toEqual([
      ['agent', 'as1:x'], ['workDone', `wd${t.a1.id}`], ['trailAgent', 'ts1:y'], ['trailAgent', 'ts0:z'],
    ]);
```

with:

```ts
    expect(rowsOf(l, 'line', 'workDone', 'trailAgent').map(([kind, id]) => [kind, id])).toEqual([
      ['line', `ls1:${t.a1.id}`], ['workDone', `wd${t.a1.id}`], ['trailAgent', 'ts1:y'], ['trailAgent', 'ts0:z'],
    ]);
    expect(l.items.find((i) => i.kind === 'line')).toMatchObject({ lead: true, agentIds: ['x'] });
```

At lines 544-556 (in `counts the trail agents on a step …`), replace:

```ts
    const y = 3 * ROW;
    const shut = layoutOutline(input);
    expect(shut.items.find((i) => i.kind === 'workDone')).toMatchObject({ count: 1, unfinished: 0, agents: 2, open: false });
    expect(rowsOf(shut, 'work', 'workDone', 'trailAgent').map(([kind]) => kind)).toEqual(['workDone']);
    const open = layoutOutline({ ...input, overrides: { [`work:${t.a1.id}`]: 'open' } });
    expect(rowsOf(open, 'work', 'workDone', 'trailAgent')).toEqual([
      ['workDone', `wd${t.a1.id}`, t.a1.id, 3 * INDENT, y],
      ['work', `w${task.id}`, t.a1.id, 3 * INDENT, y + WORK_ROW],
      ['trailAgent', 'ts0:x', t.a1.id, 3 * INDENT, y + 2 * WORK_ROW],
      ['trailAgent', 'ts0:y', t.a1.id, 3 * INDENT, y + 3 * WORK_ROW],
    ]);
    expect(open.items.find((i) => i.id === 'ts0:x')).toEqual({ kind: 'trailAgent', id: 'ts0:x', sessionId: 's0', agentId: 'x', nodeId: t.a1.id, x: 3 * INDENT, y: y + 2 * WORK_ROW });
    expect(open.nodeItems.get(t.a2.id)?.y).toBe(y + 4 * WORK_ROW + WORK_GAP);
```

with:

```ts
    const y = 2 * ROW + NODE_H;
    const shut = layoutOutline(input);
    expect(shut.items.find((i) => i.kind === 'workDone')).toMatchObject({ count: 1, unfinished: 0, agents: 2, open: false, shared: false });
    expect(rowsOf(shut, 'work', 'workDone', 'trailAgent').map(([kind]) => kind)).toEqual(['workDone']);
    const open = layoutOutline({ ...input, overrides: { [`work:${t.a1.id}`]: 'open' } });
    expect(rowsOf(open, 'work', 'workDone', 'trailAgent')).toEqual([
      ['workDone', `wd${t.a1.id}`, t.a1.id, 84, y],
      ['work', `w${task.id}`, t.a1.id, 84, y + DONE_LINE],
      ['trailAgent', 'ts0:x', t.a1.id, 84, y + DONE_LINE + TASK_ROW],
      ['trailAgent', 'ts0:y', t.a1.id, 84, y + DONE_LINE + 2 * TASK_ROW],
    ]);
    expect(open.items.find((i) => i.id === 'ts0:x')).toEqual({ kind: 'trailAgent', id: 'ts0:x', sessionId: 's0', agentId: 'x', nodeId: t.a1.id, x: 84, y: y + DONE_LINE + TASK_ROW });
    expect(open.nodeItems.get(t.a2.id)?.y).toBe(y + DONE_LINE + 3 * TASK_ROW + CARD_PAD + CARD_GAP);
```

A1 has no session here, so its done row takes a line of its own (`shared: false`) right under the header, at
`2 * ROW + NODE_H` (116).

- [ ] **Step 15: Move the live-work test to `line` items**

At lines 353-356 (in `keep a subagent's node and a node with a task in progress in view …`), replace:

```ts
    expect(rowsOf(l, 'agent', 'work').map(([kind, id, nodeId]) => [kind, id, nodeId])).toEqual([
      ['agent', 'as1:x', t.e.id],
      ['work', `w${onG.id}`, g.id],
    ]);
```

with:

```ts
    expect(rowsOf(l, 'line', 'work').map(([kind, id, nodeId]) => [kind, id, nodeId])).toEqual([
      ['line', `ls1:${t.a1.id}`, t.a1.id],
      ['line', `ls1:${t.e.id}`, t.e.id],
      ['work', `w${onG.id}`, g.id],
    ]);
```

The working session's lead line on A1 is now a `line` item too, so it joins the list.

- [ ] **Step 16: Replace the working-task, badge and readers blocks**

Replace lines 149-339: from `describe('working tasks', () => {` through the `});` that closes `describe('readers', …)`,
just above `describe('live work and the fold rules', () => {`. The new text keeps `working tasks` and `readers` with
the new pitch, turns `subagent badges` into `agent lines`, and adds `the done row in a card` (the contract's worked
examples 3 and 4):

```ts
describe('working tasks', () => {
  it('sit in TASK_ROW rows inside their card, in position order, with CARD_PAD under the last', () => {
    const t = sample();
    const first = work(t.a1.id, 'in_progress', { position: 1 });
    const second = work(t.a1.id, 'pending', { position: 2 });
    const l = layoutOutline({ nodes: t.nodes, resources: [], sessions: [], workItems: [second, first], now: T0 });
    const top = 2 * ROW + NODE_H;
    expect(rowsOf(l, 'work', 'workDone')).toEqual([
      ['work', `w${first.id}`, t.a1.id, 84, top],
      ['work', `w${second.id}`, t.a1.id, 84, top + TASK_ROW],
    ]);
    expect(l.items.find((i) => i.kind === 'work')).toMatchObject({ workId: first.id });
    expect(l.nodeItems.get(t.a1.id)?.h).toBe(NODE_H + 2 * TASK_ROW + CARD_PAD);
    expect(l.nodeItems.get(t.a2.id)?.y).toBe(top + 2 * TASK_ROW + CARD_PAD + CARD_GAP);
    expect(l.height).toBe(6 * ROW + FOLD_ROW - CARD_GAP + 2 * TASK_ROW + CARD_PAD);
  });

  it('come after the lines in their card', () => {
    const t = sample();
    const task = work(t.a1.id, 'pending');
    const l = layoutOutline({ nodes: t.nodes, resources: [], sessions: [session('s1', t.a1.id, 'working')], workItems: [task], now: T0 });
    expect(rowsOf(l, 'line', 'work')).toEqual([
      ['line', `ls1:${t.a1.id}`, t.a1.id, 84, 2 * ROW + NODE_H],
      ['work', `w${task.id}`, t.a1.id, 84, 2 * ROW + NODE_H + AGENT_LINE],
    ]);
  });

  it('fold completed tasks into one "✓ n done" row first, which a work:<id> override opens', () => {
    const t = sample();
    const c1 = work(t.a1.id, 'completed', { position: 1 });
    const p = work(t.a1.id, 'pending', { position: 2 });
    const c2 = work(t.a1.id, 'completed', { position: 3 });
    const input = { nodes: t.nodes, resources: [], sessions: [], workItems: [c1, p, c2], now: T0 };
    const y = 2 * ROW + NODE_H;
    const shut = layoutOutline(input);
    // With no agent or readers line on the card, the done row takes a line of its own.
    expect(rowsOf(shut, 'work', 'workDone')).toEqual([
      ['workDone', `wd${t.a1.id}`, t.a1.id, 84, y],
      ['work', `w${p.id}`, t.a1.id, 84, y + DONE_LINE],
    ]);
    expect(shut.items.find((i) => i.kind === 'workDone')).toMatchObject({ count: 2, open: false, shared: false });
    const open = layoutOutline({ ...input, overrides: { [`work:${t.a1.id}`]: 'open' } });
    expect(rowsOf(open, 'work', 'workDone').map(([kind, id, , , rowY]) => [kind, id, rowY])).toEqual([
      ['workDone', `wd${t.a1.id}`, y],
      ['work', `w${c1.id}`, y + DONE_LINE],
      ['work', `w${p.id}`, y + DONE_LINE + TASK_ROW],
      ['work', `w${c2.id}`, y + DONE_LINE + 2 * TASK_ROW],
    ]);
    expect(open.items.find((i) => i.kind === 'workDone')).toMatchObject({ count: 2, open: true });
    // All done: the one row.
    const allDone = layoutOutline({ ...input, workItems: [c1, c2] });
    expect(rowsOf(allDone, 'work', 'workDone').map(([kind]) => kind)).toEqual(['workDone']);
    expect(allDone.nodeItems.get(t.a2.id)?.y).toBe(y + DONE_LINE + CARD_PAD + CARD_GAP);
  });

  it('fold with their node, and stay hidden with it under a folded ancestor or in a "+n more" run', () => {
    const t = sample();
    const onA = work(t.a.id, 'pending');
    const onA1 = work(t.a1.id, 'pending');
    const onD = work(t.d.id, 'pending');
    const input = { nodes: t.nodes, resources: [], sessions: [], workItems: [onA, onA1, onD], now: T0 };
    const open = layoutOutline(input);
    expect(rowsOf(open, 'work').map(([, id]) => id)).toEqual([`w${onA.id}`, `w${onA1.id}`]);
    expect(open.items.find((i) => i.kind === 'more')).toMatchObject({ hiddenIds: [t.d.id, t.e.id] });
    const folded = layoutOutline({ ...input, overrides: { ['n:' + t.a.id]: 'closed' } });
    expect(rowsOf(folded, 'work')).toEqual([]);
    // Root, A (folded), B, C and "+2 more".
    expect(folded.height).toBe(4 * ROW + FOLD_ROW - CARD_GAP);
  });

  it('never count in plan progress', () => {
    const t = sample();
    const l = layoutOutline({ nodes: t.nodes, resources: [], sessions: [], workItems: [work(t.a.id, 'completed'), work(t.a.id, 'pending'), work(t.a2.id, 'completed')], now: T0 });
    expect(l.nodeItems.get(t.a.id)?.progress).toEqual({ done: 0, total: 2 });
    expect(l.nodeItems.get(t.a2.id)?.progress).toBeNull();
  });

  it('pulse while in progress and their session works, or their subagent runs', () => {
    const t = sample();
    const items = [
      work(t.a1.id, 'in_progress'),
      work(t.a1.id, 'pending'),
      work(t.a1.id, 'in_progress', { agentId: 'x' }),
      work(t.a1.id, 'in_progress', { agentId: 'y' }),
      work(t.a1.id, 'in_progress', { agentId: 'gone' }),
      work(t.a1.id, 'completed', { agentId: 'x' }),
    ];
    const subagents = [agent('x'), agent('y', { endedAt: ago(60_000) })];
    const pulses = (state: Session['state']) =>
      layoutOutline({ nodes: t.nodes, resources: [], sessions: [withAgents(session('s1', t.a1.id, state), subagents)], workItems: items, overrides: { [`work:${t.a1.id}`]: 'open' }, now: T0 })
        .items.flatMap((i) => (i.kind === 'work' ? [i.pulse] : []));
    expect(pulses('working')).toEqual([true, false, true, false, false, false]);
    expect(pulses('idle')).toEqual([false, false, true, false, false, false]);
  });
});

describe('agent lines', () => {
  /** What one line adds to a card that had none: the line and the pad under it. */
  const grow = AGENT_LINE + CARD_PAD;

  it("put a session's workers as kin on its lead line at its focus, and on a line without a lead on any other card", () => {
    const t = sample();
    const s1 = withAgents(session('s1', t.a1.id, 'working'), [agent('x', { nodeId: t.b.id }), agent('y'), agent('z', { nodeId: 999 })]);
    const l = layoutOutline({ nodes: t.nodes, resources: [], sessions: [s1], now: T0 });
    expect(rowsOf(l, 'line')).toEqual([
      ['line', `ls1:${t.a1.id}`, t.a1.id, 84, 2 * ROW + NODE_H],
      ['line', `ls1:${t.b.id}`, t.b.id, 56, 4 * ROW + grow + NODE_H],
    ]);
    expect(l.items.find((i) => i.id === `ls1:${t.a1.id}`)).toMatchObject({ sessionId: 's1', lead: true, agentIds: ['y', 'z'] });
    expect(l.items.find((i) => i.id === `ls1:${t.b.id}`)).toMatchObject({ sessionId: 's1', lead: false, agentIds: ['x'] });
    expect(l.nodeItems.get(t.c.id)?.y).toBe(5 * ROW + 2 * grow);
  });

  it('keep an ended worker as a kin for 5 minutes after it stopped', () => {
    const t = sample();
    const s1 = withAgents(session('s1', t.a1.id, 'idle'), [agent('x', { endedAt: ago(ENDED_AGENT_MS - 1000) }), agent('y', { endedAt: ago(ENDED_AGENT_MS) })]);
    const l = layoutOutline({ nodes: t.nodes, resources: [], sessions: [s1], now: T0 });
    expect(l.items.filter((i) => i.kind === 'line')).toEqual([expect.objectContaining({ id: `ls1:${t.a1.id}`, lead: true, agentIds: ['x'] })]);
  });

  it("sit on the nearest visible ancestor when a manual fold hides their node, and need a node or their session's focus", () => {
    const t = sample();
    const s1 = withAgents(session('s1', null, 'working'), [agent('x', { nodeId: t.a1.id }), agent('y')]);
    const l = layoutOutline({ nodes: t.nodes, resources: [], sessions: [s1], overrides: { ['n:' + t.a.id]: 'closed' }, now: T0 });
    expect(rowsOf(l, 'line')).toEqual([['line', `ls1:${t.a.id}`, t.a.id, 56, ROW + NODE_H]]);
    expect(l.items.find((i) => i.kind === 'line')).toMatchObject({ lead: false, agentIds: ['x'] });
  });

  it("leave an ended session's subagents out", () => {
    const t = sample();
    const l = layoutOutline({ nodes: t.nodes, resources: [], sessions: [withAgents(session('s1', t.a1.id, 'ended'), [agent('x')])], now: T0 });
    expect(rowsOf(l, 'line')).toEqual([]);
  });
});

describe('readers', () => {
  const reader = (agentId: string, extra: Partial<SubagentInfo> = {}) => agent(agentId, { agentType: 'Explore', ...extra });

  it('give a running reader no kin: each session folds its running readers on a card into one readers line after its own line', () => {
    const t = sample();
    const s1 = withAgents(session('s1', t.a1.id, 'working'), [
      reader('r1'), agent('w1'), reader('r2', { agentType: 'Plan', nodeId: t.a1.id }), reader('r3', { agentType: 'claude-code-guide', nodeId: t.b.id }),
    ]);
    const l = layoutOutline({ nodes: t.nodes, resources: [], sessions: [s1], now: T0 });
    const top = 2 * ROW + NODE_H;
    const bY = 4 * ROW + AGENT_LINE + READERS_LINE + CARD_PAD;
    expect(rowsOf(l, 'line', 'readers')).toEqual([
      ['line', `ls1:${t.a1.id}`, t.a1.id, 84, top],
      ['readers', `rs1:${t.a1.id}`, t.a1.id, 84, top + AGENT_LINE],
      ['readers', `rs1:${t.b.id}`, t.b.id, 56, bY + NODE_H],
    ]);
    expect(l.items.find((i) => i.id === `ls1:${t.a1.id}`)).toMatchObject({ lead: true, agentIds: ['w1'] });
    expect(l.items.find((i) => i.id === `rs1:${t.a1.id}`)).toEqual({ kind: 'readers', id: `rs1:${t.a1.id}`, sessionId: 's1', nodeId: t.a1.id, agentIds: ['r1', 'r2'], x: 84, y: top + AGENT_LINE });
    expect(l.nodeItems.get(t.c.id)?.y).toBe(bY + NODE_H + READERS_LINE + CARD_PAD + CARD_GAP);
  });

  it("keep each session's readers apart on a shared card, each after its own session's line", () => {
    const t = sample();
    const s1 = withAgents(session('s1', t.a1.id, 'working'), [reader('r1')]);
    const s2 = withAgents(session('s2', t.a1.id, 'working'), [reader('r2'), reader('r3')]);
    const l = layoutOutline({ nodes: t.nodes, resources: [], sessions: [s1, s2], now: T0 });
    expect(rowsOf(l, 'line', 'readers').map(([kind, id]) => [kind, id])).toEqual([
      ['line', `ls1:${t.a1.id}`], ['readers', `rs1:${t.a1.id}`], ['line', `ls2:${t.a1.id}`], ['readers', `rs2:${t.a1.id}`],
    ]);
    expect(l.items.find((i) => i.id === `rs2:${t.a1.id}`)).toMatchObject({ agentIds: ['r2', 'r3'] });
  });

  it('fold readers on a hidden step into the row of its nearest visible ancestor', () => {
    const t = sample();
    const s1 = withAgents(session('s1', null, 'working'), [reader('r1', { nodeId: t.a1.id }), reader('r2', { nodeId: t.a2.id })]);
    const l = layoutOutline({ nodes: t.nodes, resources: [], sessions: [s1], overrides: { ['n:' + t.a.id]: 'closed' }, now: T0 });
    expect(l.items.filter((i) => i.kind === 'readers')).toEqual([expect.objectContaining({ id: `rs1:${t.a.id}`, nodeId: t.a.id, agentIds: ['r1', 'r2'] })]);
  });

  it('show an ended reader nowhere, pinning nothing, while a running one pins its step as a worker does', () => {
    const t = sample();
    const f = n(t.root.id, 'F');
    const g = n(t.root.id, 'G');
    const nodes = [...t.nodes, f, g];
    const hidden = (l: LayoutResult) => l.items.flatMap((i) => (i.kind === 'more' ? i.hiddenIds : []));
    const kin = (l: LayoutResult) => l.items.flatMap((i) => (i.kind === 'line' ? i.agentIds : []));
    const ended = withAgents(session('s1', t.a1.id, 'working'), [reader('r1', { nodeId: t.e.id, endedAt: ago(60_000) })]);
    const gone = layoutOutline({ nodes, resources: [], sessions: [ended], now: T0 });
    expect(rowsOf(gone, 'readers')).toEqual([]);
    expect(kin(gone)).toEqual([]);
    expect(hidden(gone)).toContain(t.e.id);
    const running = withAgents(session('s1', t.a1.id, 'working'), [reader('r1', { nodeId: t.e.id })]);
    const shown = layoutOutline({ nodes, resources: [], sessions: [running], now: T0 });
    expect(hidden(shown)).not.toContain(t.e.id);
    expect(rowsOf(shown, 'readers').map(([kind, id]) => [kind, id])).toEqual([['readers', `rs1:${t.e.id}`]]);
    // A reader is never a kin.
    expect(kin(shown)).toEqual([]);
  });

  it('tell readers by type, and agentVisible keeps a running reader and drops an ended one', () => {
    expect(READER_AGENT_TYPES).toEqual(['Explore', 'Plan', 'claude-code-guide']);
    expect(['Explore', 'Plan', 'claude-code-guide', 'general-purpose', 'explore', 'inprogress-scribe'].map(isReader)).toEqual([true, true, true, false, false, false]);
    expect(agentVisible(reader('r1'), T0)).toBe(true);
    expect(agentVisible(reader('r1', { endedAt: ago(1000) }), T0)).toBe(false);
    expect(agentVisible(agent('w1', { endedAt: ago(1000) }), T0)).toBe(true);
    expect(agentVisible(agent('w1', { endedAt: ago(ENDED_AGENT_MS) }), T0)).toBe(false);
  });
});

describe('the done row in a card', () => {
  /** s1 works on A1 with a worker x, and with two readers when asked; A1 holds four tasks, the first completed. */
  function busy(readers: boolean) {
    const t = sample();
    const reading = readers ? [agent('r1', { agentType: 'Explore' }), agent('r2', { agentType: 'Explore' })] : [];
    const s1 = withAgents(session('s1', t.a1.id, 'working'), [agent('x'), ...reading]);
    const tasks = [1, 2, 3, 4].map((position) => work(t.a1.id, position === 1 ? 'completed' : 'pending', { position }));
    return { t, tasks, l: layoutOutline({ nodes: t.nodes, resources: [], sessions: [s1], workItems: tasks, now: T0 }) };
  }

  it("shares the card's last line when that line holds no kin: here the readers line", () => {
    const { t, tasks, l } = busy(true);
    // 116 is A1's y (84) plus NODE_H; then the 28 px agent line, the 20 px readers line and three 22 px task rows.
    expect(rowsOf(l, 'line', 'readers', 'workDone', 'work')).toEqual([
      ['line', `ls1:${t.a1.id}`, t.a1.id, 84, 116],
      ['readers', `rs1:${t.a1.id}`, t.a1.id, 84, 144],
      ['workDone', `wd${t.a1.id}`, t.a1.id, 84, 144],
      ['work', `w${tasks[1].id}`, t.a1.id, 84, 164],
      ['work', `w${tasks[2].id}`, t.a1.id, 84, 186],
      ['work', `w${tasks[3].id}`, t.a1.id, 84, 208],
    ]);
    expect(l.items.find((i) => i.kind === 'line')).toMatchObject({ lead: true, agentIds: ['x'] });
    expect(l.items.find((i) => i.kind === 'workDone')).toMatchObject({ count: 1, shared: true });
    // 32 + 28 + 20 + 3 × 22 + 8: the done row adds nothing.
    expect(l.nodeItems.get(t.a1.id)).toMatchObject({ y: 84, h: 154, workingFocus: true });
    expect(l.nodeItems.get(t.a2.id)?.y).toBe(248);
    expect(l.height).toBe(400);
  });

  it('takes a DONE_LINE of its own when the last line holds kin', () => {
    const { t, l } = busy(false);
    expect(rowsOf(l, 'line', 'readers', 'workDone', 'work').map(([kind, , , , y]) => [kind, y])).toEqual([
      ['line', 116], ['workDone', 144], ['work', 164], ['work', 186], ['work', 208],
    ]);
    expect(l.items.find((i) => i.kind === 'workDone')).toMatchObject({ shared: false });
    // 32 + 28 + 20 + 3 × 22 + 8.
    expect(l.nodeItems.get(t.a1.id)?.h).toBe(154);
  });

  it('shares a lead line that holds no kin, and adds no height', () => {
    const t = sample();
    const l = layoutOutline({ nodes: t.nodes, resources: [], sessions: [session('s1', t.a1.id, 'idle')], workItems: [work(t.a1.id, 'completed')], now: T0 });
    expect(rowsOf(l, 'line', 'workDone').map(([kind, , , , y]) => [kind, y])).toEqual([['line', 116], ['workDone', 116]]);
    expect(l.items.find((i) => i.kind === 'workDone')).toMatchObject({ shared: true });
    expect(l.nodeItems.get(t.a1.id)?.h).toBe(NODE_H + AGENT_LINE + CARD_PAD);
  });
});
```

- [ ] **Step 17: Replace the `layoutOutline` block and add the stack and lane cases**

Replace lines 31-129: from `describe('layoutOutline', () => {` through its closing `});`, just above
`const T0 = Date.parse('2026-10-02T12:00:00Z');`. The new text holds the contract's worked examples 1, 2 and 5, the
edge rule (the old root-edge cases at l.40, l.103 and l.121 invert), `workingFocus`, the width floor, and the lanes:
one per phase, a folded phase's lane holding only its head, a lane closed by a non-phase step and by the root's fold
row, and the non-phase depth-1 column:

```ts
describe('layoutOutline', () => {
  it('stacks one-line cards a ROW apart: the root at x 8, a depth-1 step at 56, its children at 84, every card ending at x 506', () => {
    const t = sample();
    const l = layoutOutline({ nodes: t.nodes, resources: [], sessions: [] });
    expect(l.items.map((i) => (i.kind === 'node' ? [i.id, i.x, i.y, i.h, i.w] : [i.id, i.x, i.y]))).toEqual([
      [`n${t.root.id}`, 8, 0, NODE_H, 498], [`n${t.a.id}`, 56, ROW, NODE_H, 450], [`n${t.a1.id}`, 84, 2 * ROW, NODE_H, 422],
      [`n${t.a2.id}`, 84, 3 * ROW, NODE_H, 422], [`n${t.b.id}`, 56, 4 * ROW, NODE_H, 450], [`n${t.c.id}`, 56, 5 * ROW, NODE_H, 450],
      [`more${t.root.id}-0`, 56, 6 * ROW],
    ]);
    expect(l.lanes).toEqual([]);
    // A fold row is 26 px tall: FOLD_ROW less the gap under it.
    expect(l.height).toBe(6 * ROW + FOLD_ROW - CARD_GAP);
  });

  it("draws a session's lead line inside its focus's card, marks the working chain, and the focus alone as the working focus", () => {
    const t = sample();
    const l = layoutOutline({ nodes: t.nodes, resources: [resource(9, t.a2.id)], sessions: [session('s1', t.a1.id, 'working'), session('s2', t.b.id, 'ended')] });
    expect(l.items.filter((i) => i.kind === 'line')).toEqual([
      { kind: 'line', id: `ls1:${t.a1.id}`, sessionId: 's1', nodeId: t.a1.id, lead: true, agentIds: [], x: 84, y: 2 * ROW + NODE_H },
    ]);
    expect(l.nodeItems.get(t.a1.id)).toMatchObject({ h: NODE_H + AGENT_LINE + CARD_PAD, working: true, workingFocus: true });
    expect(l.nodeItems.get(t.a2.id)).toMatchObject({ y: 2 * ROW + NODE_H + AGENT_LINE + CARD_PAD + CARD_GAP, needsYou: true, resourceIds: [9] });
    expect(l.nodeItems.get(t.a.id)).toMatchObject({ working: true, workingFocus: false });
    expect(l.nodeItems.get(t.b.id)).toMatchObject({ working: false, workingFocus: false });
  });

  it("marks only a working session's focus as the working focus: never its ancestors, nor an idle or waiting session's focus", () => {
    const t = sample();
    const sessions = [session('s1', t.a1.id, 'working'), session('s2', t.b.id, 'idle'), session('s3', t.c.id, 'permission')];
    const l = layoutOutline({ nodes: t.nodes, resources: [], sessions });
    expect([...l.nodeItems.values()].filter((i) => i.workingFocus).map((i) => i.nodeId)).toEqual([t.a1.id]);
    expect([...l.nodeItems.values()].filter((i) => i.working).map((i) => i.nodeId)).toEqual([t.root.id, t.a.id, t.a1.id]);
  });

  it('reports folded done counts and progress', () => {
    const t = sample();
    const nodes = t.nodes.map((x) => (x.id === t.a.id || x.id === t.a1.id ? { ...x, status: 'done' as const } : x.id === t.a2.id ? { ...x, assignee: 'claude' as const, status: 'done' as const } : x));
    const l = layoutOutline({ nodes, resources: [], sessions: [] });
    expect(l.nodeItems.get(t.a.id)).toMatchObject({ folded: true, doneCount: 2, progress: { done: 2, total: 2 } });
    expect(l.nodeItems.has(t.a1.id)).toBe(false);
  });

  it('draws the lead line on the nearest visible ancestor when a manual fold hides the focus', () => {
    const t = sample();
    const l = layoutOutline({ nodes: t.nodes, resources: [], sessions: [session('s1', t.a1.id, 'working')], overrides: { ['n:' + t.a.id]: 'closed' } });
    expect(l.nodeItems.has(t.a1.id)).toBe(false);
    expect(l.items.find((i) => i.kind === 'line')).toMatchObject({ id: `ls1:${t.a.id}`, nodeId: t.a.id, lead: true, x: 56, y: ROW + NODE_H });
    expect(l.nodeItems.get(t.a.id)).toMatchObject({ working: true, h: NODE_H + AGENT_LINE + CARD_PAD });
  });

  it('gives no line to a session without a focus or focused on a node that is gone', () => {
    const t = sample();
    const l = layoutOutline({ nodes: t.nodes, resources: [], sessions: [session('s1', null, 'working'), session('s2', 999, 'working')] });
    expect(l.items.filter((i) => i.kind === 'line')).toEqual([]);
    expect([...l.nodeItems.values()].filter((i) => i.working || i.workingFocus)).toEqual([]);
    expect(l.height).toBe(layoutOutline({ nodes: t.nodes, resources: [], sessions: [] }).height);
  });

  it('gives each session on a card a line of its own, one AGENT_LINE each, in session order', () => {
    const t = sample();
    const both = layoutOutline({ nodes: t.nodes, resources: [], sessions: [session('s1', t.a1.id, 'working'), session('s2', t.a1.id, 'idle')] });
    const top = 2 * ROW + NODE_H;
    expect(both.items.filter((i) => i.kind === 'line').map((b) => [b.id, b.nodeId, b.x, b.y])).toEqual([
      [`ls1:${t.a1.id}`, t.a1.id, 84, top],
      [`ls2:${t.a1.id}`, t.a1.id, 84, top + AGENT_LINE],
    ]);
    expect(both.nodeItems.get(t.a1.id)?.h).toBe(NODE_H + 2 * AGENT_LINE + CARD_PAD);
    expect(both.nodeItems.get(t.a2.id)?.y).toBe(top + 2 * AGENT_LINE + CARD_PAD + CARD_GAP);
    expect(both.height).toBe(6 * ROW + FOLD_ROW - CARD_GAP + 2 * AGENT_LINE + CARD_PAD);
    // A fold that hides one session's focus puts its line on the anchor, after the line of the session already there.
    const folded = layoutOutline({ nodes: t.nodes, resources: [], sessions: [session('s1', t.a1.id, 'working'), session('s2', t.a.id, 'idle')], overrides: { ['n:' + t.a.id]: 'closed' } });
    expect(folded.items.filter((i) => i.kind === 'line').map((b) => [b.id, b.nodeId, b.y])).toEqual([
      [`ls1:${t.a.id}`, t.a.id, ROW + NODE_H],
      [`ls2:${t.a.id}`, t.a.id, ROW + NODE_H + AGENT_LINE],
    ]);
  });

  it("draws edges only inside a card's subtree, never out of the root or a stack head, each uniquely named", () => {
    const t = sample();
    // A pinned needs-you child in the hidden tail splits it into two "+n more" runs. The root's rows get no edge.
    const f = n(t.root.id, 'F', { assignee: 'me' });
    const g = n(t.root.id, 'G');
    const h = n(t.root.id, 'H');
    const l = layoutOutline({ nodes: [...t.nodes, f, g, h], resources: [], sessions: [session('s1', t.a1.id, 'working')] });
    expect(l.items.filter((i) => i.kind === 'more').map((i) => i.id)).toEqual([`more${t.root.id}-0`, `more${t.root.id}-1`]);
    expect(l.edges).toEqual([
      { id: `e-n${t.a1.id}`, source: `n${t.a.id}`, target: `n${t.a1.id}` },
      { id: `e-n${t.a2.id}`, source: `n${t.a.id}`, target: `n${t.a2.id}` },
    ]);
    // Under a phase: none into the stack head's children, one into theirs.
    const a1a = n(t.a1.id, 'A1a');
    const phased = [...t.nodes.map((x) => (x.id === t.a.id ? { ...x, kind: 'phase' as const } : x)), a1a];
    expect(layoutOutline({ nodes: phased, resources: [], sessions: [] }).edges).toEqual([{ id: `e-n${a1a.id}`, source: `n${t.a1.id}`, target: `n${a1a.id}` }]);
  });

  it('folds a run of old finished steps into one "done" row and tells it from the tail', () => {
    const t = sample();
    const now = Date.parse('2026-10-04T12:00:00Z');
    const old = '2026-10-02T12:00:00Z';
    // A, B and C finished two days ago; D and E stay todo, past the frontier at C.
    const nodes = t.nodes.map((x) =>
      x.id === t.a.id || x.id === t.a1.id || x.id === t.b.id ? { ...x, status: 'done' as const, assignee: 'claude' as const, completedAt: old }
      : x.id === t.a2.id ? { ...x, status: 'dropped' as const, assignee: 'claude' as const, updatedAt: old }
      : x.id === t.c.id ? { ...x, status: 'dropped' as const, updatedAt: old }
      : x,
    );
    const l = layoutOutline({ nodes, resources: [], sessions: [], now });
    const id = `done${t.root.id}-0`;
    expect(l.items.map((i) => i.id)).toEqual([`n${t.root.id}`, id, `n${t.d.id}`, `n${t.e.id}`]);
    expect(l.items[1]).toEqual({ kind: 'more', id, parentId: t.root.id, run: 0, x: 56, y: ROW, depth: 1, hiddenIds: [t.a.id, t.b.id, t.c.id], variant: 'done' });
    expect(l.nodeItems.get(t.d.id)?.y).toBe(ROW + FOLD_ROW);
    // A fold row under the root gets no edge.
    expect(l.edges).toEqual([]);
    // Within a day of finishing, they show.
    expect(layoutOutline({ nodes, resources: [], sessions: [], now: Date.parse(old) + 60_000 }).items.some((i) => i.kind === 'more')).toBe(false);
    // The done: override opens the run.
    expect(layoutOutline({ nodes, resources: [], sessions: [], now, overrides: { [`done:${t.root.id}`]: 'open' } }).nodeItems.has(t.b.id)).toBe(true);
    // The tail keeps its id and says what it is.
    expect(layoutOutline({ nodes: t.nodes, resources: [], sessions: [], now }).items.find((i) => i.kind === 'more')).toMatchObject({ id: `more${t.root.id}-0`, variant: 'tail' });
  });

  it('keeps a deep card at least 240 wide', () => {
    nextId = 1;
    const chain = [n(null, 'Root', { status: 'active' })];
    for (let d = 1; d <= 9; d++) chain.push(n(chain[d - 1].id, `D${d}`, { status: 'active' }));
    const l = layoutOutline({ nodes: chain, resources: [], sessions: [] });
    expect(l.nodeItems.get(chain[8].id)).toMatchObject({ x: 252, w: 254 });
    expect(l.nodeItems.get(chain[9].id)).toMatchObject({ x: 280, w: 240 });
  });
});

describe('stacks and lanes', () => {
  /** sample(), with A and B as phases. */
  function phased() {
    const t = sample();
    return { ...t, nodes: t.nodes.map((x) => (x.id === t.a.id || x.id === t.b.id ? { ...x, kind: 'phase' as const } : x)) };
  }
  /** Each row as [id, x, y], with h, w and stack on a card. */
  const boxes = (l: LayoutResult) => l.items.map((i) => (i.kind === 'node' ? [i.id, i.x, i.y, i.h, i.w, i.stack] : [i.id, i.x, i.y]));

  it("draws a depth-1 phase as a stack head at x 22 that opens a lane, with its children at 56 inside it and no edges", () => {
    const t = phased();
    const l = layoutOutline({ nodes: t.nodes, resources: [], sessions: [] });
    // A's lane opens 18 below the root's card (32 + 18 = 50), and its head sits 9 into it (59). A1 starts STACK_HEAD
    // below the head's top. The lane closes 12 below A2 (176 + 12 = 188), and B's lane opens 18 below that (206).
    expect(boxes(l)).toEqual([
      [`n${t.root.id}`, 8, 0, 32, 498, false],
      [`n${t.a.id}`, 22, 59, 33, 484, true],
      [`n${t.a1.id}`, 56, 59 + STACK_HEAD, 32, 450, false],
      [`n${t.a2.id}`, 56, 144, 32, 450, false],
      [`n${t.b.id}`, 22, 215, 33, 484, true],
      [`n${t.c.id}`, 56, 278, 32, 450, false],
      [`more${t.root.id}-0`, 56, 320],
    ]);
    expect(l.lanes).toEqual([
      { id: `lane${t.a.id}`, nodeId: t.a.id, x: 8, y: 50, w: 504, h: 138 },
      { id: `lane${t.b.id}`, nodeId: t.b.id, x: 8, y: 206, w: 504, h: 54 },
    ]);
    expect(l.edges).toEqual([]);
    expect(l.height).toBe(346);
  });

  it('gives a folded phase a lane that holds only its head', () => {
    const t = phased();
    const l = layoutOutline({ nodes: t.nodes, resources: [], sessions: [], overrides: { ['n:' + t.a.id]: 'closed' } });
    expect(l.nodeItems.get(t.a.id)).toMatchObject({ y: 59, h: 33, folded: true, stack: true });
    // 9 above the head, the 33 px head, 12 below it.
    expect(l.lanes[0]).toEqual({ id: `lane${t.a.id}`, nodeId: t.a.id, x: 8, y: 50, w: 504, h: 54 });
  });

  it("closes a lane at the root's fold row, which sits at x 56 outside it", () => {
    const t = sample();
    const nodes = t.nodes.map((x) => (x.id === t.a.id || x.id === t.c.id ? { ...x, kind: 'phase' as const } : x));
    const l = layoutOutline({ nodes, resources: [], sessions: [] });
    expect(l.lanes.map((x) => [x.id, x.y, x.h])).toEqual([[`lane${t.a.id}`, 50, 138], [`lane${t.c.id}`, 256, 54]]);
    // C's lane ends 12 below its head (298 + 12 = 310), and the fold row starts LANE_GAP (18) below that.
    expect(l.items.at(-1)).toMatchObject({ id: `more${t.root.id}-0`, x: 56, y: 328 });
    expect(l.height).toBe(354);
  });

  it('draws a depth-1 step that is not a phase at x 56 outside any lane, its children at 84 with edges, and the root\'s fold rows at 56', () => {
    const t = phased();
    const c1 = n(t.c.id, 'C1');
    const l = layoutOutline({ nodes: [...t.nodes, c1], resources: [], sessions: [] });
    expect(boxes(l).slice(5)).toEqual([
      [`n${t.c.id}`, 56, 278, 32, 450, false],
      [`n${c1.id}`, 84, 320, 32, 422, false],
      [`more${t.root.id}-0`, 56, 362],
    ]);
    expect(l.lanes.map((x) => x.id)).toEqual([`lane${t.a.id}`, `lane${t.b.id}`]);
    expect(l.edges).toEqual([{ id: `e-n${c1.id}`, source: `n${t.c.id}`, target: `n${c1.id}` }]);
    expect(l.height).toBe(388);
  });

  it("puts a session's line on a stack head STACK_HEAD below its top, and the lane grows with it", () => {
    const t = phased();
    const l = layoutOutline({ nodes: t.nodes, resources: [], sessions: [session('s1', t.a.id, 'idle')] });
    expect(l.items.filter((i) => i.kind === 'line')).toEqual([
      { kind: 'line', id: `ls1:${t.a.id}`, sessionId: 's1', nodeId: t.a.id, lead: true, agentIds: [], x: 22, y: 59 + STACK_HEAD },
    ]);
    // A stack head's box ends with its own lines: no CARD_PAD.
    expect(l.nodeItems.get(t.a.id)).toMatchObject({ y: 59, h: STACK_HEAD + AGENT_LINE });
    expect([t.a1, t.a2, t.b, t.c].map((x) => l.nodeItems.get(x.id)?.y)).toEqual([140, 182, 253, 316]);
    expect(l.lanes.map((x) => [x.id, x.y, x.h])).toEqual([[`lane${t.a.id}`, 50, 176], [`lane${t.b.id}`, 244, 54]]);
    expect(l.height).toBe(384);
  });
});
```

- [ ] **Step 18: Import the new pitch in the tests**

Replace line 2:

```ts
import { BADGE_ROW, INDENT, READERS_ROW, ROW, WORK_GAP, WORK_ROW, agentVisible, eventTarget, findFrontier, formatUpNext, layoutOutline, queueView, type LayoutItem, type LayoutResult } from '../../src/core/layout';
```

with:

```ts
import { AGENT_LINE, CARD_GAP, CARD_PAD, DONE_LINE, FOLD_ROW, NODE_H, READERS_LINE, ROW, STACK_HEAD, TASK_ROW, agentVisible, eventTarget, findFrontier, formatUpNext, layoutOutline, queueView, type LayoutItem, type LayoutResult } from '../../src/core/layout';
```

- [ ] **Step 19: Run the layout tests to see them fail**

```bash
cd /c/personal/InProgress/.claude/worktrees/quiet-t3-layout && npm test -- test/core/layout.test.ts
```

Expected: 62 tests in all, roughly 28 failed and 34 passed. The split is an estimate: what matters is that the
total is 62 and every failure is a case that reads a position, a `line` item, `h`, `w`, `stack`, `workingFocus`,
`shared` or `lanes`. The new constants import as `undefined`, so sums read `NaN`. The cases that pass do not read
geometry: `paused`, `camera helpers`, `queued steps`, `formatUpNext`, `queueView` and most of `the trail of ended
work`. A failure in one of those, or a total other than 62, means a block in Steps 14-18 went in wrong.

- [ ] **Step 20: Set the Quiet pitch**

In `src/core/layout.ts`, replace lines 4-13:

```ts
export const ROW = 32;
export const INDENT = 28;
export const NODE_H = 24;
export const BADGE_ROW = 26;
/** One working task's row: compact, in its node's checklist. */
export const WORK_ROW = 20;
/** Room after a node's working tasks, so the next card doesn't sit right on them. */
export const WORK_GAP = 6;
/** A session's readers on a row (`◇ a · 2 reading`): as compact as a working task's row. */
export const READERS_ROW = WORK_ROW;
```

with:

```ts
/** A card's header box and a one-line card: a 30 px header inside the frame's 1 px border. The camera aims at y + NODE_H / 2. */
export const NODE_H = 32;
/** Between a card's frame and the next row. */
export const CARD_GAP = 10;
/** A one-line card's pitch. */
export const ROW = NODE_H + CARD_GAP; // 42
/** A fold row's pitch: the row is 26 px tall, then CARD_GAP. */
export const FOLD_ROW = 36;
/** A session's agent line in a card, whatever its lead's size. */
export const AGENT_LINE = 28;
/** A session's readers line (`◇ c · 2 reading`). */
export const READERS_LINE = 20;
/** The done row on a line of its own. It adds nothing when it shares a kin-less last line. */
export const DONE_LINE = 20;
/** A working task's row, and an opened done row's trail-agent row. */
export const TASK_ROW = 22;
/** Under the last line of a card that has lines. */
export const CARD_PAD = 8;
export const INDENT = 28;
/** From a stack head's box top to the first row under it. */
export const STACK_HEAD = 43;

/** The root card's x. */
const ROOT_X = 8;
/** A stack head's x. */
const STACK_X = 22;
/** Every card ends here: w = Math.max(CARD_MIN_W, CARD_RIGHT - x). */
const CARD_RIGHT = 506;
const CARD_MIN_W = 240;
const LANE_X = 8;
const LANE_W = 504;
/** A lane's top, above its head box. */
const LANE_PAD_TOP = 9;
/** Below the last row of the phase's subtree. */
const LANE_PAD_BOTTOM = 12;
/** Clear space between a lane and the next lane, or any row outside lanes. */
const LANE_GAP = 18;
```

- [ ] **Step 21: Change the layout types**

Four edits in `src/core/layout.ts`.

At lines 38-39, the end of `LayoutNodeItem`, replace:

```ts
  paused: boolean;
}
```

with:

```ts
  paused: boolean;
  /** A card: its frame's height. A stack head: its box, from the head's top to the end of its own lines. */
  h: number;
  /** Math.max(240, 506 - x): 498 for the root, 484 for a stack head, 450 at x 56, 422 at x 84. */
  w: number;
  /** A depth-1 step of kind 'phase': drawn as an unframed stack head that opens a lane. */
  stack: boolean;
  /** The focus of a live session whose state is 'working'. Never its ancestors: `working` still marks the chain. */
  workingFocus: boolean;
}
```

At lines 57-83, replace the badge and agent items and the readers item's comment:

```ts
export interface LayoutBadgeItem {
  kind: 'badge';
  id: string;
  sessionId: string;
  nodeId: number;
  x: number;
  y: number;
}

/** A subagent's badge: under the node it works on, else under its session's focus, or their nearest visible ancestor. */
export interface LayoutAgentItem {
  kind: 'agent';
  id: string;
  sessionId: string;
  agentId: string;
  /** The row it sits under. */
  nodeId: number;
  x: number;
  y: number;
  /** It stopped less than ENDED_AGENT_MS ago: drawn greyed. */
  ended: boolean;
}

/**
 * A session's running readers (READER_AGENT_TYPES) on one row, as one small row, `◇ a · 2 reading`: under that row's
 * badges of the session, in place of a badge each. Id `r<sessionId>:<nodeId>`.
 */
```

with:

```ts
/** One session's line on one card, one per session per card: its character where its focus anchors, then its kin. */
export interface LayoutLineItem {
  kind: 'line';
  /** `l<sessionId>:<nodeId>` */
  id: string;
  sessionId: string;
  nodeId: number;
  /** The session's focus anchors on this card: the line draws the session's character and label. */
  lead: boolean;
  /**
   * The session's shown non-reader subagents homed on this card (agentVisible: running, or stopped less than
   * ENDED_AGENT_MS ago), in the session's `subagents` order. Each is one kin.
   */
  agentIds: string[];
  x: number;
  y: number;
}

/**
 * A session's running readers (READER_AGENT_TYPES) on one card, as one small line, `◇ a · 2 reading`: after that
 * session's agent line there, in place of a kin each. Id `r<sessionId>:<nodeId>`.
 */
```

At lines 124-127, the end of `LayoutWorkDoneItem`, replace:

```ts
  open: boolean;
  x: number;
  y: number;
}
```

with:

```ts
  open: boolean;
  x: number;
  y: number;
  /** True: it sits at the right end of the card's last line and has that line's y. False: a DONE_LINE of its own. */
  shared: boolean;
}
```

At lines 140-161, replace the item union, the edge and the result:

```ts
export type LayoutItem =
  | LayoutNodeItem
  | LayoutMoreItem
  | LayoutBadgeItem
  | LayoutAgentItem
  | LayoutReadersItem
  | LayoutWorkItem
  | LayoutWorkDoneItem
  | LayoutTrailAgentItem;

export interface LayoutEdge {
  id: string;
  source: string;
  target: string;
}

export interface LayoutResult {
  items: LayoutItem[];
  edges: LayoutEdge[];
  nodeItems: Map<number, LayoutNodeItem>;
  height: number;
}
```

with:

```ts
export type LayoutItem =
  | LayoutNodeItem
  | LayoutMoreItem
  | LayoutLineItem
  | LayoutReadersItem
  | LayoutWorkItem
  | LayoutWorkDoneItem
  | LayoutTrailAgentItem;

export interface LayoutEdge {
  id: string;
  source: string;
  target: string;
}

/** A depth-1 phase's lane, drawn behind its subtree. */
export interface LayoutLane {
  /** `lane<nodeId>`: the React Flow node id. */
  id: string;
  /** The phase. */
  nodeId: number;
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface LayoutResult {
  items: LayoutItem[];
  edges: LayoutEdge[];
  nodeItems: Map<number, LayoutNodeItem>;
  /** One per depth-1 phase, in outline order. Kept out of `items`, so `items` keeps its shape. */
  lanes: LayoutLane[];
  /** The bottom of the last row or lane. */
  height: number;
}
```

- [ ] **Step 22: Replace `layoutOutline`**

Replace lines 294-459: the whole of `export function layoutOutline(input: LayoutInput): LayoutResult {` through its
closing `}`, just above the comment `Where the camera opens: …` on `findFrontier`. Everything before the walk is as
today, except that `badgesByNode` becomes `groupsByNode` (one group per session per card) and `workingFoci` is new.
The walk follows the contract's rules 1 to 8:

```ts
export function layoutOutline(input: LayoutInput): LayoutResult {
  const now = input.now ?? Date.now();
  const index = buildIndex(input.nodes);
  const live = input.sessions.filter((s) => s.state !== 'ended');
  const work = [...(input.workItems ?? [])].sort((a, b) => a.position - b.position || a.id - b.id);
  const shownAgents = (s: Session) => s.subagents.filter((a) => agentVisible(a, now));
  const homeOf = (s: Session, a: SubagentInfo) => agentHome(s, a, (id) => index.byId.has(id));
  const queue = queueView(input.queue ?? [], input.nodes, input.sessions);
  // Where Claude works or plans to go next shows past the fold rules, as a session's focus does: a subagent's node
  // (a running reader's too; an ended reader shows nowhere), a live session's task in progress, and every queued step,
  // whoever owns it (so an Up next entry never points into a "+n more" run). The trail never pins.
  const pins = [
    ...live.flatMap((s) => shownAgents(s).flatMap((a) => homeOf(s, a) ?? [])),
    ...work.filter((w) => w.status === 'in_progress' && w.endedAt === null).map((w) => w.nodeId),
    ...viewedSteps(queue),
  ];
  // Old finished steps fold into "✓ n done" rows on the canvas only; the text outline shows them all.
  const visible = computeVisible(index, live, { overrides: input.overrides, pins, doneRuns: { now } });

  const resourcesByNode = new Map<number, number[]>();
  for (const r of [...input.resources].sort((a, b) => a.id - b.id)) resourcesByNode.set(r.nodeId, [...(resourcesByNode.get(r.nodeId) ?? []), r.id]);
  // A manual fold can hide a live session's focus or a subagent's node: its line goes on the nearest visible ancestor,
  // so a fold never hides a session or a subagent.
  const visibleIds = new Set(visible.flatMap((v) => (v.type === 'node' ? [v.node.id] : [])));
  const anchorOf = (id: number | null): number | undefined => {
    let cur = id === null ? undefined : index.byId.get(id);
    while (cur && !visibleIds.has(cur.id)) cur = cur.parentId === null ? undefined : index.byId.get(cur.parentId);
    return cur?.id;
  };
  /**
   * On each card, per live session in `live` order: whether its focus anchors there (the lead), its shown workers homed
   * there (the kin) and its running readers there, each in the session's order.
   */
  type Group = { session: Session; lead: boolean; agentIds: string[]; readerIds: string[] };
  const groupsByNode = new Map<number, Map<string, Group>>();
  const groupAt = (at: number, s: Session): Group => {
    const bySession = groupsByNode.get(at) ?? new Map<string, Group>();
    groupsByNode.set(at, bySession);
    const group = bySession.get(s.id) ?? { session: s, lead: false, agentIds: [], readerIds: [] };
    bySession.set(s.id, group);
    return group;
  };
  for (const s of live) {
    const focusAt = anchorOf(s.focusNodeId);
    if (focusAt !== undefined) groupAt(focusAt, s).lead = true;
    for (const agent of shownAgents(s)) {
      const at = anchorOf(homeOf(s, agent));
      if (at === undefined) continue;
      // Only running readers are shown (agentVisible), each in its session's readers line on the card it anchors to.
      if (isReader(agent.agentType)) groupAt(at, s).readerIds.push(agent.agentId);
      else groupAt(at, s).agentIds.push(agent.agentId);
    }
  }
  const working = new Set<number>();
  for (const s of live) {
    if (s.state !== 'working' || s.focusNodeId === null) continue;
    let cur = index.byId.get(s.focusNodeId);
    while (cur) {
      working.add(cur.id);
      cur = cur.parentId === null ? undefined : index.byId.get(cur.parentId);
    }
  }
  /** Each working session's focus: its card alone wears the orange frame. */
  const workingFoci = new Set(live.flatMap((s) => (s.state === 'working' && s.focusNodeId !== null ? [s.focusNodeId] : [])));
  // Who is on a step, for paused: each live session's focus (an idle one's too), each running subagent's home (a reader's
  // too), each live session's task in progress, and every ancestor of those, walked in the tree itself, so a manual fold
  // never changes it. A stopped subagent no longer counts, though it still shows greyed for a while.
  const occupied = new Set<number>();
  const occupy = (id: number | null) => {
    let cur = id === null ? undefined : index.byId.get(id);
    while (cur && !occupied.has(cur.id)) {
      occupied.add(cur.id);
      cur = cur.parentId === null ? undefined : index.byId.get(cur.parentId);
    }
  };
  for (const s of live) {
    occupy(s.focusNodeId);
    for (const a of s.subagents) if (a.endedAt === null) occupy(homeOf(s, a));
  }
  for (const w of work) if (w.status === 'in_progress' && w.endedAt === null) occupy(w.nodeId);
  const sessionsById = new Map(live.map((s) => [s.id, s]));
  const pulses = (w: WorkItem): boolean => {
    const s = sessionsById.get(w.sessionId);
    if (w.status !== 'in_progress' || !s) return false;
    return w.agentId === '' ? s.state === 'working' : s.subagents.some((a) => a.agentId === w.agentId && a.endedAt === null);
  };
  const workByNode = new Map<number, WorkItem[]>();
  for (const w of work) workByNode.set(w.nodeId, [...(workByNode.get(w.nodeId) ?? []), w]);
  const trailByNode = new Map<number, TrailAgent[]>();
  for (const { agent, nodeId } of homedTrailAgents({ ...input, now }, (id) => index.byId.has(id))) trailByNode.set(nodeId, [...(trailByNode.get(nodeId) ?? []), agent]);
  /** Each queued step's number in its owner's list. */
  const queued = new Map<number, { pos: number; sessionId: string | null }>();
  for (const [sessionId, ids] of [...queue.bySession, [null, queue.unowned] as const]) ids.forEach((id, i) => queued.set(id, { pos: i + 1, sessionId }));

  const items: LayoutItem[] = [];
  const edges: LayoutEdge[] = [];
  const nodeItems = new Map<number, LayoutNodeItem>();
  const lanes: LayoutLane[] = [];
  /** Where the next row goes. */
  let y = 0;
  /** The bottom of the last row or lane. */
  let bottom = 0;
  /** The open lane: its phase and its top. */
  let lane: { nodeId: number; top: number } | null = null;
  /** The rows walked now sit under a stack head, so they draw one indent further left. */
  let underStack = false;
  const closeLane = () => {
    if (!lane) return;
    const laneBottom = bottom + LANE_PAD_BOTTOM;
    lanes.push({ id: `lane${lane.nodeId}`, nodeId: lane.nodeId, x: LANE_X, y: lane.top, w: LANE_W, h: laneBottom - lane.top });
    bottom = laneBottom;
    y = laneBottom + LANE_GAP;
    lane = null;
  };
  for (const v of visible) {
    const stack = v.type === 'node' && v.depth === 1 && v.node.kind === 'phase';
    // A row at depth 0 or 1 closes the open lane, and a stack head opens its own.
    if (v.depth <= 1) {
      closeLane();
      underStack = stack;
    }
    if (stack) {
      const top = items.length ? bottom + LANE_GAP : 0;
      lane = { nodeId: v.node.id, top };
      y = top + LANE_PAD_TOP;
    }
    const x = v.depth === 0 ? ROOT_X : stack ? STACK_X : (v.depth + (underStack ? 0 : 1)) * INDENT;
    // Edges run only inside a card's subtree: never out of the root or a stack head.
    const parentId = v.type === 'more' ? v.parentId : v.node.parentId;
    const parent = parentId === null ? undefined : index.byId.get(parentId);
    const edge = v.depth >= 3 || (v.depth === 2 && parent?.kind !== 'phase');
    if (v.type === 'more') {
      const id = `${v.variant === 'done' ? 'done' : 'more'}${v.parentId}-${v.run}`;
      items.push({ kind: 'more', id, parentId: v.parentId, run: v.run, x, y, depth: v.depth, hiddenIds: v.hiddenIds, variant: v.variant });
      if (edge) edges.push({ id: `e-${id}`, source: `n${v.parentId}`, target: id });
      bottom = y + FOLD_ROW - CARD_GAP;
      y += FOLD_ROW;
      continue;
    }
    const node = v.node;
    const item: LayoutNodeItem = {
      kind: 'node',
      id: `n${node.id}`,
      nodeId: node.id,
      x,
      y,
      depth: v.depth,
      folded: v.folded,
      doneCount: v.folded ? countDone(index, node.id) : 0,
      progress: progress(index, node.id),
      resourceIds: resourcesByNode.get(node.id) ?? [],
      needsYou: isNeedsYou(node),
      hasChildren: v.hasChildren,
      working: working.has(node.id),
      queue: queued.get(node.id) ?? null,
      paused: node.parentId !== null && node.status === 'active' && node.assignee === 'claude' && !occupied.has(node.id),
      h: NODE_H,
      w: Math.max(CARD_MIN_W, CARD_RIGHT - x),
      stack,
      workingFocus: workingFoci.has(node.id),
    };
    items.push(item);
    nodeItems.set(node.id, item);
    if (edge) edges.push({ id: `e-${item.id}`, source: `n${node.parentId}`, target: item.id });
    // The card's lines, from under its header (a stack head's: under its track). Row items take the card's x.
    const top = y + (stack ? STACK_HEAD : NODE_H);
    let ly = top;
    /** The card's last agent or readers line, and whether it holds kin. */
    let last: { y: number; kin: boolean } | null = null;
    for (const { session, lead, agentIds, readerIds } of groupsByNode.get(node.id)?.values() ?? []) {
      if (lead || agentIds.length) {
        items.push({ kind: 'line', id: `l${session.id}:${node.id}`, sessionId: session.id, nodeId: node.id, lead, agentIds, x, y: ly });
        last = { y: ly, kin: agentIds.length > 0 };
        ly += AGENT_LINE;
      }
      if (readerIds.length) {
        items.push({ kind: 'readers', id: `r${session.id}:${node.id}`, sessionId: session.id, nodeId: node.id, agentIds: readerIds, x, y: ly });
        last = { y: ly, kin: false };
        ly += READERS_LINE;
      }
    }
    // The node's checklist: completed tasks and the trail folded into one done row first, then the live open tasks in
    // the order Claude made them. Opened, the row shows every task in that order, then the trail's agents. It folds
    // with its node.
    const tasks = v.folded ? [] : (workByNode.get(node.id) ?? []);
    const trail = v.folded ? [] : (trailByNode.get(node.id) ?? []);
    const done = tasks.filter((w) => w.status === 'completed').length;
    const unfinished = tasks.filter((w) => w.endedAt !== null && w.status !== 'completed').length;
    const open = input.overrides?.[`work:${node.id}`] === 'open';
    if (done || unfinished || trail.length) {
      // At the end of the card's last line when that line holds no kin; else on a line of its own.
      const sharedY = last && !last.kin ? last.y : null;
      items.push({ kind: 'workDone', id: `wd${node.id}`, nodeId: node.id, count: done, unfinished, agents: trail.length, open, x, y: sharedY ?? ly, shared: sharedY !== null });
      if (sharedY === null) ly += DONE_LINE;
    }
    for (const w of tasks) {
      const stale = w.endedAt !== null;
      if ((w.status === 'completed' || stale) && !open) continue;
      items.push({ kind: 'work', id: `w${w.id}`, workId: w.id, nodeId: node.id, x, y: ly, pulse: pulses(w), stale });
      ly += TASK_ROW;
    }
    if (open) {
      for (const a of trail) {
        items.push({ kind: 'trailAgent', id: `t${a.sessionId}:${a.agentId}`, sessionId: a.sessionId, agentId: a.agentId, nodeId: node.id, x, y: ly });
        ly += TASK_ROW;
      }
    }
    const lines = ly - top;
    item.h = stack ? (lines ? STACK_HEAD + lines : STACK_HEAD - CARD_GAP) : lines ? NODE_H + lines + CARD_PAD : NODE_H;
    bottom = y + item.h;
    y = bottom + CARD_GAP;
  }
  closeLane();
  return { items, edges, nodeItems, lanes, height: bottom };
}
```

How it maps to the contract's rules: `x` is rule 2; `top` and the `ly` advances are rule 3; `sharedY` is rule 4;
`item.h` is rule 5; `bottom` and `y` after each row are rule 6; `closeLane` and the `stack` branch are rule 7; `edge`
is rule 8. `findFrontier`, `eventTarget` and everything above `layoutOutline` stay as they are.

- [ ] **Step 23: Run the layout tests to see them pass**

```bash
cd /c/personal/InProgress/.claude/worktrees/quiet-t3-layout && npm test -- test/core/layout.test.ts
```

Expected: `Tests  62 passed (62)`.

- [ ] **Step 24: Typecheck the root project**

```bash
cd /c/personal/InProgress/.claude/worktrees/quiet-t3-layout && npx tsc -p tsconfig.json
```

Expected: no output. This is Part B's typecheck gate (the contract's "Branches and worktrees"): the root project holds
`src/` and `test/`, and reaches `breadcrumb.ts` and `sheet.ts` through the unit tests but no `.tsx`. Do not expect
`npm run typecheck` to pass on this branch: its second half, `tsc -p web/tsconfig.json`, fails in `Canvas.tsx` until
Task 6 (Step 31 checks that it fails there and only there).

- [ ] **Step 25: Commit**

```bash
git -C /c/personal/InProgress/.claude/worktrees/quiet-t3-layout add src/core/layout.ts test/core/layout.test.ts
git -C /c/personal/InProgress/.claude/worktrees/quiet-t3-layout commit -m "Lay out Quiet cards: the new pitch, one line per session per card, the done row's place, phase lanes and edges inside cards (#81)" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

Expected: `2 files changed`.

- [ ] **Step 26: Write the failing breadcrumb test for a tall card**

In `test/web/breadcrumb.test.ts`, replace lines 2-4:

```ts
import { ROW, layoutOutline } from '../../src/core/layout';
import { buildIndex } from '../../src/core/tree';
import type { TreeNode } from '../../src/core/types';
```

with:

```ts
import { NODE_H, ROW, layoutOutline } from '../../src/core/layout';
import { buildIndex } from '../../src/core/tree';
import type { Session, TreeNode } from '../../src/core/types';
```

Then replace lines 22-24, the end of the file:

```ts
    expect(breadcrumbFor(layout, index, { x: 0, y: -1 * ROW, zoom: 0.5 })).toEqual(['InGame', 'Road to market']);
  });
});
```

with:

```ts
    expect(breadcrumbFor(layout, index, { x: 0, y: -1 * ROW, zoom: 0.5 })).toEqual(['InGame', 'Road to market']);
  });

  it("keeps naming a tall card's ancestors while its lines show, after its header has scrolled off", () => {
    // An idle session on Android signing gives its card an agent line, so the card is taller than its header.
    const session: Session = {
      id: 's1', projectId: 1, title: 'S1', cwd: null, branch: null, transcriptPath: null, state: 'idle', focusNodeId: 3,
      promptsSinceUpdate: 0, startedAt: 't', lastSeenAt: 't', endedAt: null, slot: 0, subagents: [],
    };
    const tall = layoutOutline({ nodes, resources: [], sessions: [session] });
    const card = tall.nodeItems.get(3)!;
    expect(card.h).toBeGreaterThan(NODE_H);
    // The view's top sits 4 px below the header, inside the agent line.
    const top = card.y + NODE_H + 4;
    expect(breadcrumbFor(tall, index, { x: 0, y: -top, zoom: 1 })).toEqual(['InGame', 'Road to market']);
  });
});
```

The two `ROW` cases hold unchanged: with `ROW` 42 the view tops they make (84 in both) still fall in `Android
signing`'s header, at y 84. The new case puts the view's top inside that card's agent line (y 120), below its header
(84 to 116) but above the card's bottom (152).

- [ ] **Step 27: Run the breadcrumb tests to see the new one fail**

```bash
cd /c/personal/InProgress/.claude/worktrees/quiet-t3-layout && npm test -- test/web/breadcrumb.test.ts
```

Expected: `Tests  1 failed | 2 passed (3)`. The diff shows one extra received entry, `+   "Android signing",`:
today's rule `i.y + NODE_H > top` skips the card once its header has gone, and names the next card's ancestors.

- [ ] **Step 28: Read the card's height in the breadcrumb**

In `web/src/canvas/breadcrumb.ts`, replace line 1:

```ts
import { NODE_H, type LayoutNodeItem, type LayoutResult } from '../../../src/core/layout';
```

with:

```ts
import type { LayoutNodeItem, LayoutResult } from '../../../src/core/layout';
```

and line 7:

```ts
  const first = layout.items.find((i): i is LayoutNodeItem => i.kind === 'node' && i.y + NODE_H > top);
```

with:

```ts
  const first = layout.items.find((i): i is LayoutNodeItem => i.kind === 'node' && i.y + i.h > top);
```

- [ ] **Step 29: Run the breadcrumb tests to see them pass**

```bash
cd /c/personal/InProgress/.claude/worktrees/quiet-t3-layout && npm test -- test/web/breadcrumb.test.ts
```

Expected: `Tests  3 passed (3)`.

- [ ] **Step 30: Run the whole unit suite and the root typecheck**

```bash
cd /c/personal/InProgress/.claude/worktrees/quiet-t3-layout && npm test && npx tsc -p tsconfig.json
```

Expected: Vitest reports every test file passed and 0 failed, with `test/core/layout.test.ts (62 tests)`,
`test/web/breadcrumb.test.ts (3 tests)` and `test/web/sheet.test.ts` unchanged. `tsc` prints nothing.

- [ ] **Step 31: Check that the web typecheck fails only where Task 6 works**

```bash
cd /c/personal/InProgress/.claude/worktrees/quiet-t3-layout && npx tsc -p web/tsconfig.json | grep -oE "^web/[^(]+" | sort -u
```

Expected: exactly one line, `web/src/canvas/Canvas.tsx`. Its errors, about twenty (the count does not matter), sit in
its `badge` and `agent` branches and in its node branch, which no longer narrows `LayoutItem` once `line` joins it.
Any other file in the list is a mistake in this part: fix it here, not in Task 6.

- [ ] **Step 32: Commit**

```bash
git -C /c/personal/InProgress/.claude/worktrees/quiet-t3-layout add web/src/canvas/breadcrumb.ts test/web/breadcrumb.test.ts
git -C /c/personal/InProgress/.claude/worktrees/quiet-t3-layout commit -m "Name the crumb from a tall card while its lines are in view (#81)" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
git -C /c/personal/InProgress/.claude/worktrees/quiet-t3-layout log --oneline -2
```

Expected: `2 files changed`, then the two Part B commits. Part B is done. Tell the controller `quiet/t3-layout` is
ready for Task 6. Do not merge it into `quiet-restyle`.

#### How Task 3 is verified

- **Part A** (`quiet/t3-live`): `npm run typecheck` clean in both halves; `npm test` with every file passing
  (`test/web/live.test.ts`: 38, of which 10 are new). No e2e here: nothing renders the helpers yet. The e2e that read
  their output belong to Task 4 (T1028 rewritten, T1356, the chip lines of T1203, T1294 and T1380: chip names such as
  `A · E2E session`) and Task 6 (the new canvas test, T1142, T1203, T1380: kin names, `.ip-agent-time`, the line's
  name `A · E2E session · working`).
- **Part B** (`quiet/t3-layout`): `npx tsc -p tsconfig.json` clean; `npm test` with every file passing
  (`test/core/layout.test.ts`: 62, was 52; `test/web/breadcrumb.test.ts`: 3, was 2); `tsc -p web/tsconfig.json`
  failing in `Canvas.tsx` alone (Step 31). Its e2e run on Task 6's branch once the cards render: the camera tests the
  spec holds (T301, T317, T356, T377, T510 to T630, T716, T736), which read `item.y + NODE_H / 2` through
  `expectLifted`, and T571's margin above `2 Android signing` (about 19 px at 520 × 900 with the 28 px line).

#### How Task 3 merges into `quiet-restyle`

- **Part A, at the end of wave 1.** The controller merges it after `quiet/t2-glyphs`, in the integration worktree:

```bash
git -C /c/personal/InProgress/.claude/worktrees/quiet-restyle merge --no-ff quiet/t3-live -m "Merge Quiet Task 3: copy helpers (#81)" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
cd /c/personal/InProgress/.claude/worktrees/quiet-restyle && npm ci --prefer-offline --no-audit --no-fund && npm run typecheck && npm test
```

  Expected: `Merge made by the 'ort' strategy.`, a clean typecheck and every unit test passing. Part A touches only
  `live.ts` and its test, and Task 2 only new files, so the merge has no conflicts.
- **Part B, never alone.** Task 6 cuts `quiet/t6-canvas` from `quiet-restyle` after wave 1, and its first action
  merges `quiet/t3-layout` into it (`Merge Task 3's layout into the canvas branch (#81)`, the contract's "Task 6's
  start"). Part B touches no file that wave 1 changed, so that merge has no conflicts either. Task 7 then merges
  `quiet/t6-canvas`, which carries both Part B commits, into `quiet-restyle`. Keep the `quiet/t3-layout` branch until
  Task 6 has merged it.

### Task 4: Chrome

Size M, wave 2, after Task 1, Task 2 and Task 3 part A have merged into `quiet-restyle`. It runs beside Tasks 5 and 6
and touches none of their files or regions. It restyles the hairline, the tabs, the session row (characters and
letters, the popover for every chip, the need pill and Follow), Up next and the activity strip, on today's canvas.

Worktree `/c/personal/InProgress/.claude/worktrees/quiet-t4`, branch `quiet/t4-chrome`, `INPROGRESS_E2E_PORT=4394`.
Every command below is Git Bash, run in that worktree unless it says otherwise.

**Files:**
- Create: `web/src/chrome/chips.ts`
- Modify: `web/src/chrome/SessionRow.tsx:1-89` (whole file)
- Modify: `web/src/chrome/UpNext.tsx:17-71` (doc comment and render)
- Modify: `web/src/chrome/ActivityStrip.tsx:6-14`
- Modify: `web/src/chrome/TopBar.tsx:15` (comment only)
- Modify: `web/src/styles.css`, the chrome region: `:48-120` at `0b786b8`; after Task 1, every line between
  `/* Region: chrome. Task 4. */` and `/* Region: canvas. Task 6. */`. `@keyframes ip-pulse` is not in this region:
  Task 1 moved it to the end of the tokens region, where it stays untouched.
- Test: `test/web/chips.test.ts` (Create)
- Test: `test/e2e/ui.spec.ts` at `0b786b8`: T284 l.288; T982 l.990 and l.997; T1028 l.1028-1044 (rewritten); T1203
  l.1228; T1294 l.1319 and l.1321; T1356 l.1362; T1380 l.1388-1393, l.1413 and l.1415. Task 1's edits to T284 shift
  every later line, so find each by the text shown in its step.

Unchanged on purpose: `web/src/chrome/tabs.ts`, `web/src/App.tsx`, `web/src/live.ts` (Task 3's),
`web/src/Character.tsx`, `web/src/characterState.ts`, `web/src/character.css` (Task 2's), `web/tsconfig.json`.

**Interfaces:**
- Consumes:
  - From Task 2: `Character(props: CharacterProps): JSX.Element` (`web/src/Character.tsx`, imported as
    `'../Character'`), with `CharacterProps = { size: CharacterSize; state: CharacterState; slot: number | null;
    seed: string; title?: string }`; `characterState(who: Pick<Session, 'state'> | Pick<SubagentInfo, 'endedAt'>):
    CharacterState` (`web/src/characterState.ts`, imported as `'../characterState'`). The e2e reads its DOM: `span.ip-char[data-state]`, `.ip-char-ring`,
    `.ip-char-ring2`, `.ip-char-body`, `g.ip-char-eyes`, and the keyframe names `ip-ring`, `ip-bob`, `ip-blink`.
  - From Task 3 part A: `chipName(s: Session): string` and `WORDS: Record<SessionState, string>` (`web/src/live.ts`).
  - From Task 1: the tokens `--bg`, `--bar`, `--border`, `--text`, `--text-2`, `--muted`, `--float`, `--panel-2`,
    `--amber`, `--amber-ink`, `--family-0`, `--hairline`, `--radius`, `--font-mono`, `--fs-l`, `--fs-m`, `--fs-s`,
    `--w-text`, `--w-heavy`; the `ip-pulse` keyframes; the blanket reduced-motion rule; the region head comments.
  - Unchanged: `chipLabel`, `agentLine`, `withTag`, `circled` (`web/src/live.ts`); `familyVar` (`web/src/family.ts`);
    `agentVisible`, `queueView` (`src/core/layout.ts`); `sessionTag`, `ownerTag`, `agentTag`, `isReader`
    (`src/core/types.ts`).
- Produces:
  - `chipOrder<T extends Pick<Session, 'slot'>>(sessions: readonly T[]): T[]` (`web/src/chrome/chips.ts`).
  - The chip's DOM: `span.ip-chip-wrap[style=--fam]` > `button.ip-chip-s.s-<state>[aria-label=chipName(s)]
    [aria-describedby=ip-chip-pop-<id>]` > `span.ip-char` (the 18 px character), `span.ip-tag` (the letter) and, while
    waiting for permission, ` · ` and `span.ip-chip-word`; then `div.ip-chip-pop[role=tooltip]` for every chip.
  - The class hooks `.ip-need-dot` and `.ip-upnext-lines`, and the chrome-only hooks (`.ip-chip-word`,
    `.ip-upnext-id`, `.ip-upnext-title`, `.ip-upnext-sep`, `.ip-act-who`, `.ip-act-when`, `.ip-act-what`) of the
    Interface contract's Class hooks table.
  - T1028's new title: `a session chip is its character and letter: its name carries the title, and waiting for
    permission rings it in amber`.
  - Nothing in Tasks 5 and 6 reads these. Task 7's preview script reads `.ip-tab-name` and `.ip-upnext-line`, which
    stay.

- [ ] **Step 1: Create the worktree**

```bash
git -C /c/personal/InProgress worktree add /c/personal/InProgress/.claude/worktrees/quiet-t4 -b quiet/t4-chrome quiet-restyle
cd /c/personal/InProgress/.claude/worktrees/quiet-t4 && npm ci --prefer-offline --no-audit --no-fund
```

Expected: `Preparing worktree (new branch 'quiet/t4-chrome')`, then npm reports the packages it added. If `npm ci`
fails offline, run `npm ci --no-audit --no-fund`.

- [ ] **Step 2: Check that wave 1 is in**

```bash
cd /c/personal/InProgress/.claude/worktrees/quiet-t4
git log --merges --oneline -3
grep -n "export function chipName\|export const WORDS" web/src/live.ts
grep -n "export function Character\b" web/src/Character.tsx
grep -n "export function characterState" web/src/characterState.ts
grep -n "Region:" web/src/styles.css
```

Expected: the log lists `Merge Quiet Task 3: copy helpers (#81)`, `Merge Quiet Task 2: shared glyphs (#81)` and
`Merge Quiet Task 1: tokens and fonts (#81)`. Each grep finds its export. Five region heads, in this order:
`/* Region: tokens. Task 1 only. */`, `/* Region: chrome. Task 4. */`, `/* Region: canvas. Task 6. */`,
`/* Region: Details and viewer. Task 5. */`, `/* Region: reduced motion. Task 1 only. */`. If any export or head is
missing, stop and tell the controller: wave 1 has not merged.

- [ ] **Step 3: Check that the glyph modules resolve by name**

On Windows the file system ignores case, so a `web/src/character.ts` beside `Character.tsx` would capture
`import { Character } from '../Character'`. Task 2 named the helpers `characterState.ts` to avoid that. Confirm it:

```bash
cd /c/personal/InProgress/.claude/worktrees/quiet-t4 && ls web/src | grep -i "^character" && npm run typecheck
```

Expected: exactly `Character.tsx`, `character.css` and `characterState.ts` (no `character.ts`), then both `tsc` runs
print nothing. If a `character.ts` is listed, stop and tell the controller: Task 2's rename did not merge. Never add
`allowImportingTsExtensions` or an extension to the import. Nothing to commit here.

- [ ] **Step 4: Write the failing test for the chip order**

Create `test/web/chips.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { chipOrder } from '../../web/src/chrome/chips';

const session = (id: string, slot: number | null) => ({ id, slot });
const ids = (list: { id: string }[]) => list.map((s) => s.id);

describe('chipOrder', () => {
  it('puts the chips in letter order, whatever order the server lists them in', () => {
    // The server lists the session seen last first.
    expect(ids(chipOrder([session('c', 2), session('a', 0), session('b', 1)]))).toEqual(['a', 'b', 'c']);
  });

  it('puts a session with no slot yet after the lettered ones, in the order it was given', () => {
    expect(ids(chipOrder([session('x', null), session('b', 1), session('y', null), session('a', 0)]))).toEqual(['a', 'b', 'x', 'y']);
  });

  it('leaves the list it was given as it was', () => {
    const given = [session('b', 1), session('a', 0)];
    chipOrder(given);
    expect(ids(given)).toEqual(['b', 'a']);
  });
});
```

- [ ] **Step 5: Run it and see it fail**

```bash
cd /c/personal/InProgress/.claude/worktrees/quiet-t4 && npx vitest run test/web/chips.test.ts
```

Expected: FAIL. Vitest cannot load `../../web/src/chrome/chips`, which does not exist yet.

- [ ] **Step 6: Write the chip order**

Create `web/src/chrome/chips.ts`:

```ts
import type { Session } from '../../../src/core/types';

/** A slot's place in the row: a session with no slot yet has no letter, so it goes after every lettered one. */
const rank = (slot: number | null) => (slot === null ? Number.POSITIVE_INFINITY : slot);

/**
 * The session row's order: by slot, so by letter (A, B, C…), whatever order the server lists them in (it puts the
 * session seen last first). Sessions with no slot yet keep the order they were given. Returns a new array.
 */
export function chipOrder<T extends Pick<Session, 'slot'>>(sessions: readonly T[]): T[] {
  return [...sessions].sort((a, b) => (a.slot === b.slot ? 0 : rank(a.slot) - rank(b.slot)));
}
```

- [ ] **Step 7: Run it, then commit**

```bash
cd /c/personal/InProgress/.claude/worktrees/quiet-t4 && npx vitest run test/web/chips.test.ts && npx tsc -p tsconfig.json
git add web/src/chrome/chips.ts test/web/chips.test.ts
git commit -m "Order session chips by letter (#81)" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

Expected: `✓ test/web/chips.test.ts (3 tests)`, `Test Files  1 passed (1)`; `tsc` prints nothing; `2 files changed`.

- [ ] **Step 8: Rewrite the session row**

Replace the whole of `web/src/chrome/SessionRow.tsx` with:

```tsx
import type { CSSProperties } from 'react';
import { agentVisible } from '../../../src/core/layout';
import { agentTag, isReader, sessionTag, type Session } from '../../../src/core/types';
import { Character } from '../Character';
import { characterState } from '../characterState';
import { familyVar } from '../family';
import { agentLine, chipLabel, chipName, withTag, WORDS } from '../live';
import { useNow } from '../useNow';
import { chipOrder } from './chips';

interface SessionRowProps {
  sessions: Session[];
  onPick: (s: Session) => void;
  /** The current project's count, for the needs-you pill. */
  needsYou: number;
  onNeedsYou: () => void;
  follow: boolean;
  onFollow: () => void;
}

/**
 * The current project's sessions in letter order, with the needs-you pill and Follow at the right end of the first
 * line. A chip is the session's character and its letter in its family's hue; one waiting for permission adds
 * `· needs permission`. Its name leads with the letter and carries the title (`B · Review actions controller · idle`).
 * Hovering a chip, or focusing it from the keyboard, opens its popover under the row: that line and where the session
 * is, then its subagents, each led by its tag, a reader marked `◇` in front (`◇ a2 · …`). An ended reader is not
 * listed.
 */
export function SessionRow({ sessions, onPick, needsYou, onNeedsYou, follow, onFollow }: SessionRowProps) {
  const now = useNow(30_000);
  return (
    <div className="ip-sessions">
      <div className="ip-chips">
        {chipOrder(sessions).map((s) => {
          const where = s.focusNodeId ? `on #${s.focusNodeId}` : 'no focus set yet';
          const agents = s.subagents.filter((a) => agentVisible(a, now));
          const popId = `ip-chip-pop-${s.id}`;
          const letter = sessionTag(s.slot);
          return (
            <span key={s.id} className="ip-chip-wrap" style={{ '--fam': familyVar(s.slot) } as CSSProperties}>
              {/* No native title: it never shows on keyboard focus, and the popover is the one place the row shows the title. */}
              <button className={`ip-chip-s s-${s.state}`} onClick={() => onPick(s)} aria-label={chipName(s)} aria-describedby={popId}>
                <Character size={18} state={characterState(s)} slot={s.slot} seed={s.id} />
                {letter && <span className="ip-tag">{letter}</span>}
                {s.state === 'permission' && (
                  <>
                    {' · '}
                    <span className="ip-chip-word">{WORDS.permission}</span>
                  </>
                )}
              </button>
              <div className="ip-chip-pop" id={popId} role="tooltip">
                <div className="ip-chip-pop-head">{withTag(letter, `${chipLabel(s)} · ${where}`)}</div>
                {agents.length > 0 && (
                  <ul>
                    {agents.map((a) => {
                      const tag = agentTag(s.slot, a.ordinal);
                      return (
                        <li key={a.agentId} className={a.endedAt ? 'ended' : undefined}>
                          {isReader(a.agentType) && <span className="ip-reader-mark">◇ </span>}
                          {tag && (
                            <>
                              <span className="ip-agent-tag">{tag}</span>
                              {' · '}
                            </>
                          )}
                          {agentLine(a, now)}
                        </li>
                      );
                    })}
                  </ul>
                )}
              </div>
            </span>
          );
        })}
      </div>
      {needsYou > 0 && (
        <button className="ip-need" onClick={onNeedsYou} title="Jump to the next item waiting on you (N)">
          <span aria-hidden="true" className="ip-need-dot" />
          {needsYou} need you
        </button>
      )}
      <button className={`ip-follow${follow ? ' on' : ''}`} onClick={onFollow} aria-pressed={follow} title="Follow Claude's changes (F)">
        <span aria-hidden="true">⌖</span> Follow
      </button>
    </div>
  );
}
```

What changed: the chips sort by letter; a chip holds the character and the letter, plus ` · needs permission` while
it waits; its name is `chipName(s)` and it has no `title`; the popover renders for every chip, its list only when
there are subagents; the pill's `●` is a drawn dot (text `1 need you`); Follow's `⌖` is `aria-hidden` (name
`Follow`). Removed: the chip's `.ip-pulse`, `.ip-chip-lead` with its ` · `, and `.ip-chip-label`.

- [ ] **Step 9: Typecheck and commit the session row**

```bash
cd /c/personal/InProgress/.claude/worktrees/quiet-t4 && npm run typecheck
git add web/src/chrome/SessionRow.tsx
git commit -m "Session chips show their character and letter, with a popover for every chip (#81)" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

Expected: both `tsc` runs print nothing; `1 file changed`. A `TS2305` or `TS1149` naming `Character` means a
`character.ts` sits beside `Character.tsx`: go back to Step 3.

- [ ] **Step 10: Put Up next's head in a left column and part each step**

In `web/src/chrome/UpNext.tsx`, replace the doc comment and the function body from line 17 to the end of the file
(`/**` above `export function UpNext` through the closing `}`) with:

```tsx
/**
 * The order Claude plans to work in, as Aiden reads it at a glance:
 *
 *     UP NEXT  A      ① #82 Trail of ended work · ② #78 Guide
 *              B      ① #90 Owned queue entries
 *              later  ① #79 Taskbar icon
 *
 * The head sits once in a left column. Beside it, one line per live session that has steps, in the queue's order, led
 * by its letter in its family's hue (`?` while its slot is empty), then one neutral `later` line for the unowned steps.
 * Each line is numbered as the markers on the cards are, and cut short at the window's edge; each step jumps to its
 * row. Nothing at all while no step is up next.
 */
export function UpNext({ queue, nodes, sessions, onJump }: UpNextProps) {
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const slotOf = new Map(sessions.map((s) => [s.id, s.slot]));
  const view = queueView(queue, nodes, sessions);
  const lines = [
    ...[...view.bySession].map(([id, ids]) => ({ key: `s:${id}`, lead: ownerTag(slotOf.get(id) ?? null), slot: slotOf.get(id) ?? null, owned: true, ids })),
    ...(view.unowned.length ? [{ key: 'later', lead: 'later', slot: null, owned: false, ids: view.unowned }] : []),
  ];
  if (!lines.length) return null;
  const label = (n: TreeNode, i: number) => `${circled(i + 1)} #${n.id} ${n.title}`;
  // Inline spans, not buttons, so a line cuts a title short with an ellipsis instead of hiding a whole step.
  const onKeyDown = (e: KeyboardEvent, id: number) => {
    if (e.key !== 'Enter' && e.key !== ' ') return;
    e.preventDefault();
    onJump(id);
  };
  return (
    <div className="ip-upnext">
      <div className="ip-upnext-head">Up next</div>
      <div className="ip-upnext-lines">
        {lines.map((line) => {
          const steps = line.ids.map((id) => byId.get(id)!);
          return (
            <div
              key={line.key}
              className={`ip-upnext-line${line.owned ? ' owned' : ''}`}
              style={line.owned ? ({ '--fam': familyVar(line.slot) } as CSSProperties) : undefined}
              title={`${line.lead}: ${steps.map(label).join(' · ')}`}
            >
              <span className="ip-upnext-lead">{line.lead}</span>{' '}
              {steps.map((n, i) => (
                <Fragment key={n.id}>
                  {i > 0 && <span className="ip-upnext-sep"> · </span>}
                  {/* The spaces stay literal, so the step's text and name read `① #82 Title` as before. */}
                  <span role="button" tabIndex={0} className="ip-upnext-item" onClick={() => onJump(n.id)} onKeyDown={(e) => onKeyDown(e, n.id)}>
                    {circled(i + 1)} <span className="ip-upnext-id">#{n.id}</span> <span className="ip-upnext-title">{n.title}</span>
                  </span>
                </Fragment>
              ))}
            </div>
          );
        })}
      </div>
    </div>
  );
}
```

The imports (lines 1 to 5) and `UpNextProps` stay as they are. A line's text is still `A ① #82 Trail of ended work ·
② #78 Guide`, so T1259 l.1279 and T1294 l.1307 and l.1336 hold.

```bash
cd /c/personal/InProgress/.claude/worktrees/quiet-t4 && npm run typecheck
git add web/src/chrome/UpNext.tsx
git commit -m "Up next puts its head in a left column and parts each step for the Quiet look (#81)" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

Expected: both `tsc` runs print nothing; `1 file changed`.

- [ ] **Step 11: Part the activity strip, and fix the tab comment**

In `web/src/chrome/ActivityStrip.tsx`, replace lines 6 to 14 (`export function ActivityStrip` to the end) with:

```tsx
/** The latest change on one line: `↳ actor · when · what`. Only the event shrinks, cut short with an ellipsis. */
export function ActivityStrip({ event, snapshot }: { event: EventRow | null; snapshot: ProjectSnapshot }) {
  const now = useNow(30_000);
  if (!event) return <div className="ip-activity muted">No activity yet</div>;
  // Flex items: the strip's gap draws the room, and the spaces around each · keep the text as it reads.
  return (
    <div className="ip-activity" title={event.ts}>
      <span aria-hidden="true">↳ </span>
      <span className="ip-act-who">{actorLabel(event, snapshot)}</span>
      {' · '}
      <span className="ip-act-when">{relativeTime(event.ts, now)}</span>
      {' · '}
      <span className="ip-act-what">{describeEvent(event, snapshot)}</span>
    </div>
  );
}
```

The strip's text is still `↳ Claude · just now · …` (T178 l.189 reads it with `toContainText`).

In `web/src/chrome/TopBar.tsx`, replace line 15:

```tsx
/** The amber count of items waiting on Aiden, and the clay dot while a session works in the project. */
```

with:

```tsx
/** How many items wait on Aiden, as a muted numeral, and an ink dot while a session works in the project. */
```

```bash
cd /c/personal/InProgress/.claude/worktrees/quiet-t4 && npm run typecheck
git add web/src/chrome/ActivityStrip.tsx web/src/chrome/TopBar.tsx
git commit -m "The activity strip parts actor, time and event; the tab comment matches Quiet (#81)" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

Expected: both `tsc` runs print nothing; `2 files changed`.

- [ ] **Step 12: Read the chrome region as Task 1 left it**

```bash
cd /c/personal/InProgress/.claude/worktrees/quiet-t4 && sed -n '/Region: chrome. Task 4./,/Region: canvas. Task 6./p' web/src/styles.css
```

Expected: the two head comments, and between them comments and rules for exactly these selectors, with Task 1's
weights, sizes and token names: `.ip-app`; `.ip-topbar`; `.ip-tabs`; `.ip-tabs::after`; `.ip-tab`;
`.ip-tab + .ip-tab::before`; `.ip-tab:hover`; `.ip-tab[aria-selected='true']`; `.ip-tab:focus-visible`;
`.ip-tab.archived .ip-tab-name`; `.ip-tab-name`; `.ip-tab-count`; `.ip-tab-dot`; `.ip-archive`; `.ip-archive-btn`;
`.ip-archive-btn:hover, .ip-archive-btn[aria-expanded='true']`; `.ip-menu`; `.ip-mi`; `.ip-mi:hover, .ip-mi.cur`;
`.ip-mi .nm`; `.ip-menu .ip-label`; `.ip-need`; `.ip-follow`; `.ip-follow.on`; `.ip-sessions`; `.ip-chips`;
`.ip-chip-wrap`; `.ip-chip-s`; `.ip-chip-lead`; `.ip-tag`; `.ip-chip-pop`;
`.ip-chip-wrap:hover .ip-chip-pop, .ip-chip-s:focus-visible + .ip-chip-pop`; `.ip-chip-pop-head`; `.ip-chip-pop ul`;
`.ip-chip-pop li`; `.ip-chip-pop li.ended .ip-agent-tag`; `.ip-chip-pop li.ended`; `.ip-reader-mark`; `.ip-upnext`;
`.ip-upnext-head`; `.ip-upnext-line`; `.ip-upnext-lead`; `.ip-upnext-line.owned .ip-upnext-lead`; `.ip-upnext-item`;
`.ip-upnext-item:hover`; `.ip-upnext-item:focus-visible`; `.ip-chip-label`; `.ip-chip-s.s-working`;
`.ip-chip-s.s-permission`; `.ip-chip-s.s-permission .ip-tag` (the chip half of today's `:114`; Task 1 moved the badge
half to the canvas region); `.ip-pulse`; `.ip-main`; `.ip-activity`; `.ip-banner`; `.ip-empty`. There is no
`@keyframes ip-pulse` here: Task 1 moved it to the end of the tokens region. If the region holds any other rule, stop
and ask the controller: it belongs to another task, and Step 13 would delete it.

- [ ] **Step 13: Replace the chrome region**

Replace every line strictly between `/* Region: chrome. Task 4. */` and `/* Region: canvas. Task 6. */` with the block
below. Keep both head comments. Do not add `@keyframes ip-pulse`: the rules below use the one in the tokens region.

```css
.ip-app { display: flex; flex-direction: column; height: 100%; }
/* The hairline over the tab bar, in both themes. It sits outside .ip-topbar, so the bar alone stays 38 px. */
.ip-app::before { content: ''; flex: none; height: 3px; background: var(--hairline); }
.ip-topbar { flex: none; display: flex; align-items: stretch; height: 38px; padding: 0 6px 0 0; background: var(--bar); border-bottom: 1px solid var(--border); }
/* One tab per project. When they overflow, the strip scrolls sideways (the wheel too: see TopBar). */
.ip-tabs { display: flex; flex: 0 1 auto; min-width: 0; overflow-x: auto; overflow-y: hidden; scrollbar-width: none; }
/* Room after the last tab: the browser rounds how far the strip scrolls to whole pixels, which would cut a sliver off it. */
.ip-tabs::after { content: ''; flex: none; width: 2px; }
.ip-tab { position: relative; flex: none; display: flex; align-items: center; gap: 7px; padding: 0 12px; color: var(--muted); font-size: var(--fs-m); line-height: 18px; white-space: nowrap; }
.ip-tab + .ip-tab::before { content: ''; position: absolute; left: 0; top: 13px; bottom: 13px; width: 1px; background: var(--border); }
.ip-tab:hover, .ip-tab[aria-selected='true'] { color: var(--text); }
/* The current tab's ink underline, over the bar's rule. The strip's overflow clips its lower pixel, as in the artboard. */
.ip-tab[aria-selected='true']::after { content: ''; position: absolute; left: 12px; right: 12px; bottom: -1px; height: 2px; background: var(--text); }
.ip-tab:focus-visible { outline: 2px solid var(--text-2); outline-offset: -2px; border-radius: var(--radius); }
.ip-tab.archived .ip-tab-name { font-style: italic; }
.ip-tab-name { max-width: 160px; overflow: hidden; text-overflow: ellipsis; }
/* How many items wait on Aiden there: a muted numeral, no pill. */
.ip-tab-count { flex: none; font-family: var(--font-mono); font-size: var(--fs-s); line-height: 14px; color: var(--muted); }
/* A session works there: an ink dot, never a hue. */
.ip-tab-dot { flex: none; width: 6px; height: 6px; border-radius: 50%; background: var(--text-2); animation: ip-pulse 1.6s ease-in-out infinite; }
.ip-archive { position: relative; flex: none; margin-left: auto; display: flex; align-items: center; padding-left: 6px; }
.ip-archive-btn { display: flex; align-items: center; justify-content: center; width: 30px; height: 26px; border-radius: var(--radius); color: var(--muted); font-size: var(--fs-l); font-weight: var(--w-heavy); line-height: 20px; }
.ip-archive-btn:hover, .ip-archive-btn[aria-expanded='true'] { background: var(--panel-2); color: var(--text); }
/* The ⋯ menu floats over the canvas as the crumb and the zoom buttons do: a hairline, no shadow. Its "Archived" head
   takes the section-head look of .ip-label (Details region). */
.ip-menu { position: absolute; top: calc(100% + 4px); right: 0; width: 280px; max-width: calc(100vw - 20px); padding: 6px; background: var(--float); border: 1px solid var(--border); border-radius: var(--radius); z-index: 20; }
.ip-menu .ip-label { margin: 2px 8px 4px; }
.ip-mi { display: flex; align-items: center; gap: 8px; width: 100%; padding: 7px 8px; border-radius: var(--radius); text-align: left; font-size: var(--fs-m); line-height: 18px; }
.ip-mi:hover, .ip-mi.cur { background: var(--panel-2); }
.ip-mi .nm { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
/* The current project's sessions on the left, wrapping onto a second line only when they overflow; the needs-you pill
   and Follow at the right end of the first line. One line is 4 + 30 + 5 px, plus the rule: 40 px. */
.ip-sessions { position: relative; flex: none; display: flex; align-items: flex-start; gap: 4px; min-height: 40px; padding: 4px 12px 5px 8px; background: var(--bar); border-bottom: 1px solid var(--border); }
.ip-chips { flex: 1; min-width: 0; display: flex; flex-wrap: wrap; gap: 0 4px; }
.ip-chip-wrap { flex: none; display: flex; }
/* A chip: the session's character, then its letter in its family's hue (--fam, set on the wrap). No border and no fill
   in any state: the character carries working and idle. */
.ip-chip-s { display: inline-flex; align-items: center; gap: 6px; height: 30px; padding: 0 8px; border-radius: var(--radius); color: var(--muted); font-size: var(--fs-m); line-height: 18px; white-space: nowrap; }
.ip-chip-s .ip-char { flex: none; }
.ip-chip-s .ip-tag { color: var(--fam, var(--family-0)); }
/* Waiting for permission, the chip adds "· needs permission", and its character wears the amber ring (character.css). */
.ip-chip-word { color: var(--amber-ink); }
/* A session's letter: on its chip, and on its agent and readers lines on the canvas. */
.ip-tag { font-weight: var(--w-heavy); }
/* A chip's popover, under the row while the chip is hovered or focused from the keyboard: the session's line and where
   it is, then its subagents. It floats with a hairline and no shadow. A pointer on it keeps its wrap hovered, so it
   stays open, as today's does. */
.ip-chip-pop { display: none; position: absolute; top: calc(100% + 2px); left: 8px; z-index: 25; max-width: min(400px, calc(100% - 20px)); padding: 6px 10px; background: var(--float); border: 1px solid var(--border); border-radius: var(--radius); color: var(--text-2); font-size: var(--fs-m); line-height: 20px; }
.ip-chip-wrap:hover .ip-chip-pop, .ip-chip-s:focus-visible + .ip-chip-pop { display: block; }
.ip-chip-pop-head { color: var(--muted); font-size: var(--fs-s); line-height: 14px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.ip-chip-pop ul { list-style: none; margin: 4px 0 0; padding: 0; }
.ip-chip-pop li { white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
/* A subagent's tag in the popover: DM Mono in its session's hue. An ended row goes grey, tag and all. */
.ip-chip-pop .ip-agent-tag { font-family: var(--font-mono); font-size: var(--fs-s); font-weight: var(--w-text); color: var(--fam, var(--family-0)); }
.ip-chip-pop li.ended, .ip-chip-pop li.ended .ip-agent-tag { color: var(--muted); }
/* A reader's ◇ in a list (the popover, Details): neutral, as only the letter wears the hue. */
.ip-reader-mark { color: var(--muted); }
/* The needs-you pill and Follow: 26 px hairline buttons, centred on the row's first line. */
.ip-need, .ip-follow { flex: none; display: inline-flex; align-items: center; height: 26px; margin-top: 2px; padding: 0 10px; border: 1px solid var(--border); border-radius: var(--radius); font-size: var(--fs-m); line-height: 18px; white-space: nowrap; }
.ip-need { gap: 6px; color: var(--amber-ink); }
.ip-need-dot { flex: none; width: 6px; height: 6px; border-radius: 50%; background: var(--amber); }
.ip-follow { gap: 5px; margin-left: 6px; color: var(--muted); }
.ip-follow.on { color: var(--text-2); border-color: var(--text); }
.ip-need:hover, .ip-follow:hover { background: var(--panel-2); }
/* Keyboard focus in the chrome: a 2 px ink ring, never a hue. */
.ip-chip-s:focus-visible, .ip-need:focus-visible, .ip-follow:focus-visible, .ip-archive-btn:focus-visible, .ip-mi:focus-visible { outline: 2px solid var(--text-2); outline-offset: 1px; }
/* Up next, under the session row: UP NEXT once in an 82 px column, then one line per live session that has steps, led
   by its letter in its family's hue (--fam), then a neutral "later" line. Each line is one inline run, cut short with
   an ellipsis at the window's edge: a flex row would never report itself cut. */
.ip-upnext { flex: none; display: flex; align-items: flex-start; padding: 8px 12px; background: var(--bar); border-bottom: 1px solid var(--border); color: var(--muted); font-size: var(--fs-m); line-height: 20px; }
.ip-upnext-head { flex: none; display: flex; align-items: center; width: 82px; height: 20px; font-size: var(--fs-s); font-weight: var(--w-heavy); line-height: 14px; letter-spacing: .14em; text-transform: uppercase; white-space: nowrap; }
.ip-upnext-lines { flex: 1; min-width: 0; }
.ip-upnext-line { height: 20px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.ip-upnext-lead { display: inline-block; width: 36px; }
.ip-upnext-line.owned .ip-upnext-lead { font-weight: var(--w-heavy); color: var(--fam, var(--family-0)); }
.ip-upnext-item { cursor: pointer; border-radius: var(--radius); }
.ip-upnext-id { font-family: var(--font-mono); font-size: var(--fs-s); }
.ip-upnext-title { color: var(--text-2); }
/* About 8 px each side of the dot, its literal spaces included. */
.ip-upnext-sep { padding: 0 5px; }
/* Hover: ink and an underline on the title, never a hue. */
.ip-upnext-item:hover .ip-upnext-title { color: var(--text); text-decoration: underline; text-underline-offset: 2px; }
.ip-upnext-item:focus-visible { outline: 2px solid var(--text-2); outline-offset: 1px; }
.ip-main { flex: 1; position: relative; min-height: 0; display: flex; }
/* The latest change: ↳ actor · time · event, muted, with the actor and the event in ink. Only the event shrinks. */
.ip-activity { flex: none; display: flex; align-items: center; gap: 6px; height: 32px; padding: 0 12px; background: var(--bar); border-top: 1px solid var(--border); color: var(--muted); font-size: var(--fs-m); line-height: 18px; white-space: nowrap; overflow: hidden; }
.ip-act-who { flex: none; color: var(--text-2); }
.ip-act-when { flex: none; font-family: var(--font-mono); font-size: var(--fs-s); line-height: 14px; }
.ip-act-what { min-width: 0; overflow: hidden; text-overflow: ellipsis; color: var(--text-2); }
/* Reconnecting: a solid amber band with black text. It is rare and must be seen. */
.ip-banner { flex: none; padding: 3px 12px; background: var(--amber); color: #000; font-size: var(--fs-m); line-height: 18px; }
.ip-empty { margin: auto; color: var(--muted); text-align: center; padding: 24px; max-width: 420px; }
```

One reading to flag in review: spec section 2 writes the session row's padding as `0 12px 0 8px`. The block pads 4 px
above and 5 px below instead, because with `align-items: flex-start` that is what centres the 30 px chips in the
40 px row; the row's height, side padding and gap are the spec's.

How the block meets the spec: tabs 38 px with the ink underline and a muted mono count; the session row 40 px on one
line, the chip 30 px with no border or fill, the pill and Follow 26 px hairline buttons; Up next `8 + 20 per line + 8`;
the activity strip 32 px. Every size is `--fs-l`, `--fs-m` or `--fs-s`, every weight 500 (inherited) or
`--w-heavy`. Gone: the working fill, the red permission rules (`.ip-chip-s.s-permission` and the chip half of today's
`:114`; the badge half goes with Task 6's canvas region), `.ip-chip-lead`, `.ip-chip-label` and `.ip-pulse`.

- [ ] **Step 14: Check the region, then commit**

```bash
cd /c/personal/InProgress/.claude/worktrees/quiet-t4
sed -n '/Region: chrome. Task 4./,/Region: canvas. Task 6./p' web/src/styles.css | grep -nE "ip-chip-label|ip-chip-lead|^\.ip-pulse|s-permission|s-working|#fff|font-weight: *(600|700|800|bold)|var\(--(accent|edge|green|purple|clay|panel)\)"
diff <(git show quiet-restyle:web/src/styles.css | grep "@keyframes ip-pulse") <(grep "@keyframes ip-pulse" web/src/styles.css)
grep -c "Region:" web/src/styles.css
npm run typecheck && npm test
```

Expected: the first two commands print nothing (no old hook, no removed token, no `--panel` in the chrome, and the
`ip-pulse` keyframes once, as Task 1 wrote them in the tokens region). `5`. Both `tsc` runs print nothing, and Vitest
reports every test file passed, 0 failed. Then:

```bash
git add web/src/styles.css
git commit -m "Chrome rules in the Quiet look: hairline, tabs, character chips, Up next column, activity strip (#81)" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

Expected: `1 file changed`.

- [ ] **Step 15: e2e, T284 and T982**

In `test/e2e/ui.spec.ts`, T284 (`dark mode reaches the canvas controls; …`), replace:

```ts
  await expect(page.locator('.ip-chip-s .ip-pulse')).toHaveCSS('animation-name', 'none');
```

with:

```ts
  // The working chip's character stands still: no bob and no blink.
  await expect(page.locator('.ip-chip-s .ip-char-body')).toHaveCSS('animation-name', 'none');
  await expect(page.locator('.ip-chip-s g.ip-char-eyes')).toHaveCSS('animation-name', 'none');
```

In T982 (`the needs-you pill and Follow sit at the right end of the session row, …`), replace:

```ts
  await expect(pill).toHaveText('● 1 need you');
```

with:

```ts
  await expect(pill).toHaveText('1 need you');
```

and replace:

```ts
  expect(rowBox.height, 'one line').toBeLessThan(40);
```

with:

```ts
  expect(rowBox.height, 'one line').toBeLessThanOrEqual(40);
```

- [ ] **Step 16: e2e, the chip's name in T1203 and T1356**

In T1203 (`a worker's badge says what it was asked to do, …`), replace:

```ts
    await expect(chip).toHaveText('A · E2E session · 3 subagents');
```

with:

```ts
    await expect(chip).toHaveAccessibleName('A · E2E session · 3 subagents');
    await expect(chip).toHaveText('A');
```

In T1356 (`a session chip counts only live subagents, …`), replace:

```ts
    await expect(chip).toHaveText('A · E2E session · 1 subagent');
```

with:

```ts
    await expect(chip).toHaveAccessibleName('A · E2E session · 1 subagent');
    await expect(chip).toHaveText('A');
```

Both tests keep finding the chip with `getByRole('button', { name: /E2E session/ })`, which now matches its
`aria-label`. Their popover lines hold: there is one session, so one `.ip-chip-pop`.

- [ ] **Step 17: e2e, the chip's hue in T1294 and T1380**

In T1294 (`two sessions keep their own Up next order, …`), inside the `hues` string, replace:

```ts
      const chipB = find('.ip-chip-s', 'Second session');
```

with:

```ts
      const chipB = document.querySelector('.ip-chip-s[aria-label^="B · "] .ip-tag');
```

and replace:

```ts
        chipB: chipB ? getComputedStyle(chipB).backgroundColor : null,
```

with:

```ts
        chipB: color(chipB),
```

`chipB` is now the letter's `color`, so l.1331 (`leadB`) and l.1332 (`markerB`) compare hue with hue.

In T1380 (`two sessions in a project show A and B in different hues, …`), replace these six lines:

```ts
    // The letter leads each chip and focus badge, in its own span: the chip's label still starts with the title.
    const chipA = page.locator('.ip-chip-s', { hasText: 'E2E session' });
    const chipB = page.locator('.ip-chip-s', { hasText: 'Second session' });
    await expect(chipA).toHaveText('A · E2E session');
    await expect(chipB).toHaveText('B · Second session · 1 subagent');
    await expect(chipB.locator('.ip-chip-label')).toHaveText('Second session · 1 subagent');
```

with:

```ts
    // A chip shows only its letter. Its name leads with the letter and carries the title and the count.
    const chipA = page.locator('.ip-sessions').getByRole('button', { name: /^A · / });
    const chipB = page.locator('.ip-sessions').getByRole('button', { name: /^B · / });
    await expect(chipA).toHaveAccessibleName('A · E2E session');
    await expect(chipB).toHaveAccessibleName('B · Second session · 1 subagent');
    await expect(chipB).toHaveText('B');
```

Then, inside its `hues` string, replace:

```ts
        chipA: bg(find('.ip-chip-s', 'E2E session')),
```

with:

```ts
        chipA: getComputedStyle(document.querySelector('.ip-chip-s[aria-label^="A · "] .ip-tag')).color,
```

and replace:

```ts
        chipB: bg(find('.ip-chip-s', 'Second session')),
```

with:

```ts
        chipB: getComputedStyle(document.querySelector('.ip-chip-s[aria-label^="B · "] .ip-tag')).color,
```

Leave the other lines of the block as they are: `badgeA`, `badgeB`, `agentB` and `markerB` are Task 6's, and still
read today's filled badge and kin backgrounds on this branch, which wear the same hue as the letter. `hues.chipA` is
`rgb(11, 107, 125)` (Task 1 set the value), now the A letter's `color`.

- [ ] **Step 18: Typecheck and commit the e2e edits**

```bash
cd /c/personal/InProgress/.claude/worktrees/quiet-t4 && npx tsc -p tsconfig.json
git add test/e2e/ui.spec.ts
git commit -m "Chrome e2e: chips by name and letter hue, the pill's drawn dot, the 40 px row, the still chip character (#81)" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

Expected: `tsc` prints nothing; `1 file changed`.

- [ ] **Step 19: Rewrite T1028 as the session row's e2e**

In `test/e2e/ui.spec.ts`, replace the whole of T1028, from
`test('a long session title is cut short, and the pill and Follow stay at the end of the first line', …` through its
closing `});` (l.1028-1044 at `0b786b8`), with:

```ts
test('a session chip is its character and letter: its name carries the title, and waiting for permission rings it in amber', async ({ page, api, fresh }) => {
  const title = 'A session title long enough to run on well past the edge of a narrow window';
  const second = `e2e-${randomUUID()}`;
  await write(api, second, 'post', `/api/sessions/${second}/enroll`, { project: fresh.slug, title });
  await open(page, fresh);
  const row = page.locator('.ip-sessions');
  const chips = row.locator('.ip-chip-s');
  const chipA = row.getByRole('button', { name: /^A · / });
  const chipB = row.getByRole('button', { name: /^B · / });
  // Letter order, though the server lists B first: it was seen last.
  await expect(chips).toHaveCount(2);
  await expect(chips.first()).toHaveAccessibleName('A · E2E session');
  await expect(chips.nth(1)).toHaveAccessibleName(`B · ${title}`);
  // The chip shows its character and its letter in its family's hue. The title is in its name and its popover, with
  // no native tooltip, which would never show on keyboard focus.
  await expect(chipB).toHaveText('B');
  await expect(chipB).not.toHaveAttribute('title');
  await expect(chipB.locator('.ip-char')).toHaveAttribute('data-state', 'work');
  await expect(chipB.locator('.ip-tag')).toHaveCSS('color', 'rgb(180, 83, 47)');
  expect((await row.boundingBox())!.height, 'one line').toBeLessThanOrEqual(40);
  // Its popover opens on keyboard focus: Tab from the tab strip reaches A, then B.
  const popB = page.locator(`[id="${await chipB.getAttribute('aria-describedby')}"]`);
  await expect(popB).toBeHidden();
  await page.getByRole('tab', { selected: true }).focus();
  await expect(async () => {
    await page.keyboard.press('Tab');
    await expect(chipA).toBeFocused({ timeout: 200 });
  }).toPass({ timeout: 3000 });
  await page.keyboard.press('Tab');
  await expect(chipB).toBeFocused();
  await expect(popB).toBeVisible();
  await expect(popB).toHaveText(`B · ${title} · no focus set yet`);
  await expect(chipB).toHaveAccessibleDescription(`B · ${title} · no focus set yet`);
  // Waiting for permission: the word shows in amber, and the character wears the amber ring, the outer one running.
  await write(api, second, 'post', `/api/sessions/${second}/hook`, { event: 'permission' });
  await expect(chipB).toHaveAccessibleName(`B · ${title} · needs permission`);
  await expect(chipB).toHaveText('B · needs permission');
  await expect(chipB.locator('.ip-chip-word')).toHaveCSS('color', 'rgb(146, 64, 14)');
  await expect(chipB.locator('.ip-char')).toHaveAttribute('data-state', 'wait');
  const ring2 = chipB.locator('.ip-char-ring2');
  await expect(ring2).toHaveCSS('animation-name', 'ip-ring');
  // Under reduced motion the outer ring stops, and the solid ring stays.
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await expect(ring2).toHaveCSS('animation-name', 'none');
  await expect(chipB.locator('.ip-char-ring')).toBeVisible();
  // Five more sessions overflow the first line. The chips wrap, still in letter order, and the pill and Follow stay at
  // the right end of the first line.
  for (let i = 1; i <= 5; i++) {
    const extra = `e2e-${randomUUID()}`;
    await write(api, extra, 'post', `/api/sessions/${extra}/enroll`, { project: fresh.slug, title: `Extra session ${i}` });
  }
  await expect(chips).toHaveCount(7);
  for (const [i, letter] of [...'ABCDEFG'].entries()) await expect(chips.nth(i)).toHaveAccessibleName(new RegExp(`^${letter} · `));
  const pill = row.getByRole('button', { name: /need you/ });
  const follow = row.getByRole('button', { name: /Follow/ });
  const [rowBox, chipsBox, pillBox, followBox] = await Promise.all([row, row.locator('.ip-chips'), pill, follow].map(async (l) => (await l.boundingBox())!));
  expect(rowBox.height, 'two lines').toBeGreaterThan(40);
  expect(chipsBox.x + chipsBox.width).toBeLessThanOrEqual(pillBox.x);
  for (const box of [pillBox, followBox]) expect(box.y - rowBox.y, 'on the first line').toBeLessThanOrEqual(8);
  await expect(follow).toBeInViewport({ ratio: 1 });
});
```

The values: `rgb(180, 83, 47)` is `--family-1` by day (`#b4532f`, B clay); `rgb(146, 64, 14)` is `--amber-ink` by day
(`#92400e`). An enrolled session starts `working`, so B's character is `work` until the hook. Seven chips need about
490 px at 520 px against about 310 px of room, so they wrap whatever the font's exact widths. The test sits where
T1028 was, above the `hook` helper, so it posts its hooks with `write` as the tests around it do.

- [ ] **Step 20: Typecheck and commit the rewritten test**

```bash
cd /c/personal/InProgress/.claude/worktrees/quiet-t4 && npx tsc -p tsconfig.json
git add test/e2e/ui.spec.ts
git commit -m "Rewrite the session row e2e for character chips, letter order and the permission ring (#81)" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

Expected: `tsc` prints nothing; `1 file changed`.

- [ ] **Step 21: Run the e2e tests this task touches, and the chrome tests it must hold**

```bash
cd /c/personal/InProgress/.claude/worktrees/quiet-t4 && npm run build && INPROGRESS_E2E_PORT=4394 npx playwright test -g "dark mode reaches the canvas controls|a long project name is cut short|a tab shows how many items need you|archived projects move into|when the tabs overflow the window|the needs-you pill and Follow sit|a session chip is its character and letter|a worker's badge says what it was asked|Up next: the camera opens on its head|two sessions keep their own Up next order|a session chip counts only live subagents|two sessions in a project show A and B"
```

Expected: `Built into …/.build`, then `12 passed`. The seven this task edits are T284, T982, T1028, T1203, T1294,
T1356 and T1380. The five it must hold unedited are T270, T824, T846, T938 and T1259 (the 38 px bar, the cut tab
name, the count and the pulsing dot, the ⋯ menu, the tab peek, and Up next's head, line text, 20 px line and
ellipsis).

- [ ] **Step 22: Run the whole e2e suite**

The chrome is on every page, and the canvas is 12 px shorter on this branch (113 px of chrome against about 101 today).

```bash
cd /c/personal/InProgress/.claude/worktrees/quiet-t4 && INPROGRESS_E2E_PORT=4394 npm run test:e2e
```

Expected: `50 passed`, 0 failed, 0 flaky. If a camera test (T510 to T630, T571 most likely) fails, do not adjust it:
the spec measured those margins on Task 6's canvas. Stop and report the failure and its numbers to the controller.

- [ ] **Step 23: Hand the branch over**

```bash
git -C /c/personal/InProgress/.claude/worktrees/quiet-t4 status --short
git -C /c/personal/InProgress/.claude/worktrees/quiet-t4 log --oneline quiet-restyle..quiet/t4-chrome
```

Expected: no status output. The log lists this task's commits, newest first: the session row e2e rewrite, the chrome
e2e edits, the chrome rules, the activity strip, Up next, the session row and the chip order (seven commits). Do not
merge and do not push: Task 7 merges the branch.

**Verification.** The task is done when, on `quiet/t4-chrome`: `npm run typecheck` prints no errors from either
`tsc`; `npm test` passes every file, `test/web/chips.test.ts` among them; Step 21 shows `12 passed`; and the full
`INPROGRESS_E2E_PORT=4394 npm run test:e2e` shows `50 passed`.

**Merge into `quiet-restyle`.** Task 7 merges it first of the wave 2 branches, in its Step 2:

```bash
git -C /c/personal/InProgress/.claude/worktrees/quiet-restyle merge --no-ff quiet/t4-chrome -m "Merge Quiet Task 4: chrome (#81)" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

Expected: `Merge made by the 'ort' strategy.`, then Task 7's typecheck and unit gate. Task 4 shares no file region with
Task 5. It does share three e2e blocks with Task 6, line for line, and git stops on edits to adjacent lines. When Task
7 merges `quiet/t6-canvas` and git stops in `test/e2e/ui.spec.ts`, Task 6 merges `quiet-restyle` into its branch and
keeps both sides:
- T1380: Task 4's chip lines (the comment and five lines that replace l.1388-1393) sit right above Task 6's badge
  lines (l.1394-1395). In the `hues` string, Task 4's `chipA` and `chipB` lines (l.1413, l.1415) alternate with Task
  6's `badgeA`, `badgeB` and `agentB` lines (l.1414, l.1416, l.1417).
- T284: Task 4's two chip-character lines replace l.288. If Task 6 adds its font or `.react-flow__background` checks
  next to them, keep both.
- T1203: Task 4 edits only l.1228. Task 6's l.1225 is two lines above, so these merge on their own.

### Task 5: Details

Size M, wave 2. Cut from `quiet-restyle` once Task 1 (wave 0) and Tasks 2 and 3 part A (wave 1) have merged. Runs
beside Tasks 4 and 6 and never merges itself: Task 7 merges it after the chrome. Worktree
`/c/personal/InProgress/.claude/worktrees/quiet-t5`, branch `quiet/t5-details`, `INPROGRESS_E2E_PORT=4395`. It draws
Details and the resource viewer in the Quiet
vocabulary: an opaque `--panel` frame, an L title, 24 px hairline buttons, the shared `Marker` for the status and the
steps, muted section heads and meta, rows that read like the canvas's, an upright log, and Markdown in Inter and
DM Mono. The geometry does not change: the 380 px side panel from 720 px and the bottom sheet over the lower 60 %
below it, which T301 and T510 to T630 depend on.

**Files:**
- Modify: `web/src/panels/Details.tsx`: the imports (`:8`), the working task row (`:90`, `:98`), the status
  (`:221`), the steps (`:260-267`), the log (`:275-280`). Lines at `0b786b8`; Tasks 1 to 3 do not touch the file.
- Modify: `web/src/styles.css`, the Details and viewer region only: every line between
  `/* Region: Details and viewer. Task 5. */` and `/* Region: reduced motion. Task 1 only. */` (`:199-239` at
  `0b786b8`, plus the rules Task 1 moved in). Neither head comment changes.
- Owned, no change: `web/src/panels/ResourceViewer.tsx`, `web/src/panels/Markdown.tsx`.
- Test: `test/e2e/ui.spec.ts`, insertions only, each between two Details lines: T204 after l.214, T247 after l.267,
  T392 after l.453, T1203 after l.1241, T1429 after l.1442, T1445 after l.1501. Line numbers are at `0b786b8`. Task
  1's additions to T284 shift every line after l.299, so find each anchor by the text this task quotes.

**Interfaces:**
- Consumes:
  - `Marker(props: MarkerProps): JSX.Element` from `web/src/Marker.tsx` (Task 2), with
    `MarkerProps = { status: NodeStatus; question: boolean; paused: boolean; needsYou: boolean; pulse: boolean; title?: string }`.
    Its DOM is `span.ip-marker.m-<status>` plus `q`, `m-paused`, `m-you`, `m-pulse`, with text `?`, `✓` or nothing.
    Its look is in `web/src/character.css` (Task 2), which `Marker.tsx` imports. An active marker's
    `background-color` is `--active` (day `rgb(194, 65, 12)`).
  - `isNeedsYou(n: Pick<TreeNode, 'assignee' | 'status'>): boolean` from `src/core/tree.ts` (exists, unchanged).
  - Tokens (Task 1): `--panel`, `--panel-2`, `--border`, `--shadow`, `--text`, `--text-2`, `--muted`, `--faint`,
    `--link`, `--active-ink`, `--amber`, `--amber-ink`, `--amber-fill`, `--bg`; theme-free `--radius`,
    `--font-mono`, `--fs-l`, `--fs-m`, `--fs-s`, `--w-text`, `--w-heavy`, `--track-l`; the inline `--fam` that
    Details already sets on `.ip-wt` and `.ip-dagent`.
  - The two region head comments (Task 1), and the Details rules Task 1 moved into the region (`.ip-dagent.ended`,
    `.ip-dagent.ended .ip-agent-tag`, `.ip-agent-dot`, `.ip-dtrail`, `.ip-dpurpose`).
- Produces:
  - Details and the viewer in Quiet. `.ip-pill` is gone.
  - New hooks `.ip-kid-mark`, `.ip-log-time`, `.ip-log-text`. Hooks kept: `.ip-details`, `.ip-meta`,
    `.ip-meta-label`, `.ip-label`, `.ip-glyph`, `.ip-link`, `.ip-res`, `.ip-wt`, `.ip-dagent`, `.ip-dpurpose`,
    `.ip-dtrail`, `.ip-trail`, `.ip-trail-head`, `.ip-kids`, `.ip-log`, `.ip-md`, `.ip-btn`, `.ip-grab`,
    `.ip-viewer-body`.
  - The `.ip-label` base rule, which Task 4's archived menu reads.
  - The branch `quiet/t5-details`, which Task 7 Step 4 merges.

Day values the e2e reads (Playwright's default scheme is light): `--panel` `rgb(255, 255, 255)`, `--text`
`rgb(15, 23, 42)`, `--text-2` `rgb(30, 41, 59)`, `--muted` `rgb(71, 85, 105)`, `--faint` `rgb(100, 116, 139)`,
`--active-ink` and `--active` `rgb(194, 65, 12)`, `--family-0` `rgb(11, 107, 125)`.

- [ ] **Step 1: Create the worktree**

Only after the controller has merged wave 1 (`quiet/t2-glyphs`, then `quiet/t3-live`) into `quiet-restyle`.

```bash
git -C /c/personal/InProgress worktree add /c/personal/InProgress/.claude/worktrees/quiet-t5 -b quiet/t5-details quiet-restyle
cd /c/personal/InProgress/.claude/worktrees/quiet-t5 && npm ci --prefer-offline --no-audit --no-fund
```

Expected: `Preparing worktree (new branch 'quiet/t5-details')`, then npm reports the packages it added. If `npm ci`
fails offline, run `npm ci --no-audit --no-fund`.

- [ ] **Step 2: Check what wave 1 left**

```bash
cd /c/personal/InProgress/.claude/worktrees/quiet-t5
git log --merges --oneline -3
ls web/src/Marker.tsx web/src/character.css
grep -n "Region:" web/src/styles.css
awk '/Region: Details and viewer/,/Region: reduced motion/' web/src/styles.css
```

Expected:
- The log lists `Merge Quiet Task 3: copy helpers (#81)`, `Merge Quiet Task 2: shared glyphs (#81)` and
  `Merge Quiet Task 1: tokens and fonts (#81)`.
- Both files are listed.
- Five head comments, in this order: `/* Region: tokens. Task 1 only. */`, `/* Region: chrome. Task 4. */`,
  `/* Region: canvas. Task 6. */`, `/* Region: Details and viewer. Task 5. */`,
  `/* Region: reduced motion. Task 1 only. */`.
- The region printed by `awk` holds `.ip-details {`, `.ip-dagent.ended`, `.ip-agent-dot`, `.ip-dtrail` and
  `.ip-dpurpose`, and holds neither `.ip-row > .ip-chip` nor `.ip-res-count` (Task 1 moved those to the canvas).

If a head comment is missing, or the region still holds the narrow-window chip rules, stop and report to the
controller: the region and its moves are Task 1's.

- [ ] **Step 3: Import the Marker and draw the status with it**

In `web/src/panels/Details.tsx`, add the import before the `../time` import (`:8`).

Before:

```tsx
import { relativeTime } from '../time';
```

After:

```tsx
import { Marker } from '../Marker';
import { relativeTime } from '../time';
```

Then replace the status pill (`:221`).

Before:

```tsx
        {isNeedsYou(node) ? <span className="ip-pill you">NEEDS YOU</span> : <span className={`ip-pill st-${node.status}`}>{node.status}</span>}
```

After:

```tsx
        {/* The canvas's marker, then the status as a muted word, or NEEDS YOU in the YOU tag's look. Details has no
            layout item, so a paused step shows its plain status marker, and nothing pulses here. */}
        <Marker status={node.status} question={node.kind === 'question'} paused={false} needsYou={isNeedsYou(node)} pulse={false} />
        {isNeedsYou(node) ? <span className="ip-you">NEEDS YOU</span> : <span>{node.status}</span>}
```

An active step's marker holds no text, so the meta's text still starts with the word (T247 l.266:
`active task · ⧉ ui · Claude`). Only a done step's `✓` or a question's `?` comes before it.

- [ ] **Step 4: Draw each step with the Marker, in an aligned column**

In the same file, replace the step's marker span (`:260-267`).

Before:

```tsx
            {detail.children.map((c) => (
              <li key={c.id}>
                <button onClick={() => onSelectNode(c.id)}>
                  <span className={`ip-marker m-${c.status}`} />#{c.id} {c.title}
                  {c.assignee === 'me' && c.status !== 'done' ? <span className="ip-you">YOU</span> : null}
                </button>
              </li>
            ))}
```

After:

```tsx
            {detail.children.map((c) => (
              <li key={c.id}>
                <button onClick={() => onSelectNode(c.id)}>
                  <span className="ip-kid-mark">
                    <Marker status={c.status} question={c.kind === 'question'} paused={false} needsYou={isNeedsYou(c)} pulse={false} />
                  </span>
                  #{c.id} {c.title}
                  {c.assignee === 'me' && c.status !== 'done' ? <span className="ip-you">YOU</span> : null}
                </button>
              </li>
            ))}
```

A done step's button text becomes `✓#12 Milestone 1`; no e2e locates a step by its name.

- [ ] **Step 5: The hue bar on the session's own tasks only, and an upright log**

In the same file, in `LiveWork`'s working task row (`:90` and `:98`).

Before:

```tsx
                  // The session's own task names its letter here; a subagent's shows its tag on the row.
```

```tsx
                  <span className="ip-work-mark">{TASK_MARK[w.status]}</span> {family && <span className="ip-work-agent" />}
```

After:

```tsx
                  // The session's own task names its letter here and wears the hue bar; a subagent's shows its tag on the row.
```

```tsx
                  <span className="ip-work-mark">{TASK_MARK[w.status]}</span> {family && !w.agentId && <span className="ip-work-agent" />}
```

Then the log (`:275-280`).

Before:

```tsx
            {detail.log.map((l) => (
              <li key={l.id}>
                {relativeTime(l.createdAt)} · {l.text}
                {l.sessionTitle ? <i> · {l.sessionTitle}</i> : null}
              </li>
            ))}
```

After:

```tsx
            {detail.log.map((l) => (
              <li key={l.id}>
                <span className="ip-log-time">{relativeTime(l.createdAt)}</span> · <span className="ip-log-text">{l.text}</span>
                {l.sessionTitle ? <span> · {l.sessionTitle}</span> : null}
              </li>
            ))}
```

The row and log texts do not change. The bar is an empty span, and a log line keeps its text, for example
`just now · Uploaded the key · E2E session`.

- [ ] **Step 6: Typecheck**

```bash
cd /c/personal/InProgress/.claude/worktrees/quiet-t5 && npm run typecheck
```

Expected: both `tsc` runs print nothing and the command exits 0.

- [ ] **Step 7: Commit the markup**

```bash
git -C /c/personal/InProgress/.claude/worktrees/quiet-t5 add web/src/panels/Details.tsx
git -C /c/personal/InProgress/.claude/worktrees/quiet-t5 commit -m "Details: the shared marker for the status and the steps, the hue bar on the session's own tasks, an upright log (#81)" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

Expected: `1 file changed`.

- [ ] **Step 8: Rewrite the region, part 1: frame, header, meta, heads, resources**

In `web/src/styles.css`, select every line after `/* Region: Details and viewer. Task 5. */` up to, but not
including, `/* Region: reduced motion. Task 1 only. */`, and replace them with:

```css
/* Details: a side panel from 720 px, a bottom sheet over the lower 60 % below it (sheet.ts). Opaque --panel with the
   shadow, body M. Details styles the classes it shares with the canvas and the chrome under its own parents (.ip-wt,
   .ip-dagent, .ip-meta, .ip-details), so the other regions can scope their rules. */
.ip-details { position: absolute; right: 0; top: 0; bottom: 0; z-index: 10; width: 380px; padding: 12px; overflow-y: auto; background: var(--panel); border-left: 1px solid var(--border); box-shadow: var(--shadow); font-size: var(--fs-m); line-height: 18px; }
.ip-grab { display: none; width: 36px; height: 4px; margin: 0 auto 8px; border-radius: var(--radius); background: var(--muted); }
@media (max-width: 719px) {
  .ip-details { top: auto; left: 0; width: auto; height: 60%; border-left: 0; border-top: 1px solid var(--border); border-radius: var(--radius) var(--radius) 0 0; }
  .ip-grab { display: block; }
}
/* The header, shared with the viewer: the title in L ink, cut on one line, then 24 px hairline buttons. */
.ip-details header, .ip-viewer header { display: flex; align-items: center; gap: 6px; }
.ip-details header b, .ip-viewer header b { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: var(--fs-l); font-weight: var(--w-heavy); line-height: 20px; letter-spacing: var(--track-l); word-spacing: 0.05em; color: var(--text); }
.ip-btn { flex: none; height: 24px; min-width: 24px; padding: 0 8px; border: 1px solid var(--border); border-radius: var(--radius); font-size: var(--fs-s); line-height: 14px; color: var(--muted); white-space: nowrap; }
.ip-btn:hover { color: var(--text-2); }
.ip-details :focus-visible, .ip-viewer header :focus-visible { outline: 2px solid var(--text-2); outline-offset: 1px; }
/* Status (the shared Marker, then the word, or NEEDS YOU in the YOU tag's look), kind, label, who, parent: one muted
   S line. */
.ip-meta { display: flex; flex-wrap: wrap; align-items: center; gap: 6px; margin: 6px 0 10px; font-size: var(--fs-s); line-height: 14px; color: var(--muted); }
.ip-meta .ip-glyph { font-variant-emoji: text; }
/* ⛁ draws faint at text size. */
.ip-meta .ip-glyph.l-data { font-size: 1.33em; }
.ip-details .ip-you { display: inline-block; height: 18px; padding: 0 6px; border-radius: var(--radius); background: var(--amber-fill); color: var(--amber-ink); font-size: var(--fs-s); font-weight: var(--w-heavy); line-height: 18px; letter-spacing: 0.04em; }
/* Section heads, as Up next's: S at 900, uppercase, spaced, muted. The archived menu's head shares this rule. */
.ip-label { margin: 12px 0 4px; font-size: var(--fs-s); font-weight: var(--w-heavy); line-height: 14px; letter-spacing: 0.14em; text-transform: uppercase; color: var(--muted); }
.ip-link { color: var(--link); text-decoration: underline; }
.ip-outcome { margin: 8px 0; }
.ip-outcome b { font-weight: var(--w-heavy); }
/* A resource: a muted row with a faint tint on hover, its title in ink at 500, its summary in DM Mono. */
.ip-res { display: flex; align-items: center; gap: 6px; width: calc(100% + 12px); margin: 0 -6px 2px; padding: 3px 6px; border-radius: var(--radius); text-align: left; color: var(--muted); }
.ip-res:hover { background: var(--panel-2); }
.ip-res b { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-weight: var(--w-text); color: var(--text-2); }
.ip-res .sub { flex: none; margin-left: auto; font-family: var(--font-mono); font-size: var(--fs-s); line-height: 14px; color: var(--muted); }
```

- [ ] **Step 9: Rewrite the region, part 2: working tasks, subagents, ended work**

Append directly after the last line of Step 8 (`.ip-res .sub { … }`), still above the reduced-motion head:

```css
/* Working tasks, subagents and ended work: text lines with the canvas rows' marks. The tag in DM Mono in the hue, ◐ in
   the active ink and still, ○ and ✓ muted, a stale ○ faint, the hue bar on the session's own tasks only. */
.ip-wts, .ip-dagents { list-style: none; margin: 0; padding: 0; line-height: 1.7; }
.ip-wt, .ip-dagent { color: var(--text-2); }
.ip-wt.w-in_progress { color: var(--text); }
.ip-wt.w-completed, .ip-wt.stale, .ip-dagent.ended, .ip-dtrail { color: var(--muted); }
.ip-wt .ip-work-tag, .ip-dagent .ip-agent-tag { font-family: var(--font-mono); font-size: var(--fs-s); font-weight: var(--w-text); color: var(--fam); }
.ip-dagent.ended .ip-agent-tag { color: inherit; }
.ip-wt .ip-work-mark { display: inline-block; width: 12px; text-align: center; color: var(--muted); }
.ip-wt.w-in_progress .ip-work-mark { color: var(--active-ink); }
.ip-wt.stale:not(.w-completed) .ip-work-mark { color: var(--faint); }
.ip-wt .ip-work-agent { display: inline-block; width: 3px; height: 12px; margin-right: 4px; border-radius: var(--radius); vertical-align: -1px; background: var(--fam); }
/* A reader's ◇ and the trail's ◆, muted. */
.ip-dagent .ip-reader-mark, .ip-agent-dot { color: var(--muted); }
/* A subagent's purpose, under its line. */
.ip-dpurpose { padding-left: 12px; font-size: var(--fs-s); line-height: 14px; color: var(--muted); }
/* Ended work: one group per session, under its title. */
.ip-trail + .ip-trail { margin-top: 4px; }
.ip-trail-head { font-size: var(--fs-s); line-height: 14px; color: var(--muted); }
```

The specificities do the ordering: a stale in-progress row is muted (the muted rule comes after
`.ip-wt.w-in_progress`), and its mark is faint (`.ip-wt.stale:not(.w-completed) .ip-work-mark` has four classes
against three). These rules come after the canvas region, so at equal specificity they also win over any unscoped
row rule left there.

- [ ] **Step 10: Rewrite the region, part 3: steps, log, Markdown, viewer**

Append directly after the last line of Step 9 (`.ip-trail-head { … }`), still above the reduced-motion head:

```css
/* Steps: the shared Marker in a 13 px column, so the titles align, then #id and title. */
.ip-kids { list-style: none; margin: 0; padding: 0; }
.ip-kids li button { display: flex; align-items: center; gap: 8px; width: 100%; padding: 2px 0; text-align: left; color: var(--text-2); }
.ip-kids li button:hover { color: var(--text); }
.ip-kid-mark { flex: none; display: inline-flex; justify-content: center; width: 13px; }
/* The log: the time in DM Mono, the text in ink, the session muted and upright (no italic face ships). */
.ip-log { list-style: none; margin: 0; padding: 0; line-height: 1.7; color: var(--muted); }
.ip-log-time { font-family: var(--font-mono); font-size: var(--fs-s); }
.ip-log-text { color: var(--text-2); }
/* Markdown, in Details and the viewer: headings at L, M and S in 900, code in DM Mono, links in --link. */
.ip-md { line-height: 1.55; overflow-wrap: anywhere; }
.ip-md :is(h1, h2, h3, h4, h5, h6, strong, b, th) { font-weight: var(--w-heavy); }
.ip-md h1 { font-size: var(--fs-l); line-height: 20px; letter-spacing: var(--track-l); word-spacing: 0.05em; }
.ip-md h2 { font-size: var(--fs-m); line-height: 18px; }
.ip-md :is(h3, h4, h5, h6) { font-size: var(--fs-s); line-height: 14px; }
.ip-md a { color: var(--link); }
.ip-md code { font-family: var(--font-mono); font-size: var(--fs-s); }
.ip-md pre { padding: 8px; overflow: auto; background: var(--panel-2); border: 1px solid var(--border); border-radius: var(--radius); }
.ip-md table { border-collapse: collapse; }
.ip-md td, .ip-md th { padding: 2px 6px; border: 1px solid var(--border); }
/* The resource viewer: the whole window on --panel. Its header shares Details' rules above. */
.ip-viewer { position: fixed; inset: 0; z-index: 30; display: flex; flex-direction: column; background: var(--panel); }
.ip-viewer header { padding: 8px 12px; border-bottom: 1px solid var(--border); }
.ip-viewer-body { flex: 1; width: 100%; max-width: 900px; margin: 0 auto; padding: 16px 20px; overflow: auto; outline: none; }
.ip-viewer-body:focus-visible { outline: 2px solid var(--amber); outline-offset: -2px; }
.ip-toast { position: fixed; bottom: 16px; left: 50%; z-index: 40; transform: translateX(-50%); padding: 4px 12px; border-radius: var(--radius); background: var(--text); color: var(--bg); font-size: var(--fs-m); }
```

The viewer's amber focus outline stays, as the spec has it.

- [ ] **Step 11: Check the region and the leftovers**

```bash
cd /c/personal/InProgress/.claude/worktrees/quiet-t5
grep -n "Region:" web/src/styles.css
awk '/Region: Details and viewer/,/Region: reduced motion/' web/src/styles.css | grep -nE "ip-pill|font-weight:\s*(600|700|800|bold)|var\(--(accent|edge|green|purple|clay)\)|#fff\b"; grep -rn "ip-pill" web/src --include=*.tsx
grep -nE "ip-row > \.ip-chip|\.ip-res-count \{ display: inline-block" web/src/styles.css
awk '/Region: Details and viewer/,/Region: reduced motion/' web/src/styles.css | grep -cE "^\.|^@media|^  \."
```

Expected:
- The same five head comments as in Step 2, in the same order.
- The second line prints nothing: no pill, no weight but 500 and 900, no removed token and no white ink in the
  Details region, and no component still renders `.ip-pill`. (The chrome region still holds
  `.ip-chip-s.s-working { … color: #fff; }` on this branch; Task 4 removes it on its own.)
- The third prints two lines, both with line numbers between the canvas head and the Details head.
- The last prints `58`: the rule lines of Steps 8, 9 and 10, counting the `@media` line and the two rules inside it.
  Another number means a block was pasted twice, cut short, or left a rule of today's region behind.

- [ ] **Step 12: Typecheck and unit**

```bash
cd /c/personal/InProgress/.claude/worktrees/quiet-t5 && npm run typecheck && npm test
```

Expected: both `tsc` runs print nothing; Vitest reports every test file passed and 0 failed, the same files as on
`quiet-restyle` (Task 5 adds no unit test: it is styling and markup, with no new logic).

- [ ] **Step 13: Commit the stylesheet**

```bash
git -C /c/personal/InProgress/.claude/worktrees/quiet-t5 add web/src/styles.css
git -C /c/personal/InProgress/.claude/worktrees/quiet-t5 commit -m "Details and the viewer in the Quiet look (#81)" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

Expected: `1 file changed`.

- [ ] **Step 14: e2e, T204: the frame, the header and the steps' markers**

In `test/e2e/ui.spec.ts`, test `clicking a node opens its details and copies a reference`. After its last assertion
(l.214):

```ts
  expect(await page.evaluate<string>('navigator.clipboard.readText()')).toBe(`#${id} Run signing tests`);
```

insert:

```ts
  // Quiet: an opaque sheet with an 8 px top radius, the title in L ink, 24 px hairline buttons.
  await expect(details).toHaveCSS('background-color', 'rgb(255, 255, 255)');
  await expect(details).toHaveCSS('border-top-left-radius', '8px');
  const title = details.locator('header b');
  await expect(title).toHaveCSS('font-size', '15px');
  await expect(title).toHaveCSS('font-weight', '900');
  await expect(title).toHaveCSS('color', 'rgb(15, 23, 42)');
  await expect(details.getByRole('button', { name: 'Close' })).toHaveCSS('height', '24px');
  // Its steps draw the canvas's marker: a ✓ when done, a still orange dot when active, the needs-you mark and YOU.
  await details.getByRole('button', { name: /2 Android signing/ }).click();
  await expect(details).toContainText(`#${demo.ids['2 Android signing']} 2 Android signing`);
  const steps = details.locator('.ip-kids li');
  await expect(steps).toHaveText([/Upload keystore$/, /Play app signing$/, /Run signing tests\s*YOU$/]);
  await expect(steps.nth(0).locator('.ip-marker.m-done')).toHaveText('✓');
  const active = steps.nth(1).locator('.ip-marker.m-active');
  await expect(active).toHaveCSS('background-color', 'rgb(194, 65, 12)');
  await expect(active).toHaveCSS('animation-name', 'none');
  await expect(steps.nth(2).locator('.ip-marker.m-you')).toHaveCount(1);
```

The parent link is the only button on `Run signing tests`' Details whose name holds `2 Android signing`. The test
reads the shared `demo` project and writes nothing.

- [ ] **Step 15: e2e, T247: the status marker, the meta and the log**

Test `a labelled step shows its glyph in a neutral chip named by the word, and Details shows glyph and word`. After
its last assertion (l.267):

```ts
  await expect(meta.locator('.ip-glyph')).toHaveCSS('font-variant-emoji', 'text');
```

insert:

```ts
  // Quiet: the status is the shared marker and a muted word, in place of a filled pill.
  await expect(meta.locator('.ip-marker.m-active')).toHaveCount(1);
  await expect(meta.locator('.ip-pill')).toHaveCount(0);
  await expect(meta).toHaveCSS('font-size', '11px');
  await expect(meta).toHaveCSS('color', 'rgb(71, 85, 105)');
  // The log: the time in DM Mono, the text in ink, the session muted and upright. The entry arrives live.
  await write(api, fresh.session, 'post', `/api/nodes/${fresh.ids['Play app signing']}/log`, { text: 'Uploaded the key', sessionId: fresh.session });
  const entry = page.getByRole('complementary').locator('.ip-log li');
  await expect(entry).toHaveText('just now · Uploaded the key · E2E session');
  await expect(entry.locator('.ip-log-time')).toHaveCSS('font-family', /DM Mono/);
  await expect(entry.locator('.ip-log-text')).toHaveCSS('color', 'rgb(30, 41, 59)');
  await expect(entry.locator('i')).toHaveCount(0);
```

The log route (`POST /api/nodes/:id/log`) is the only writer of log entries, so the `fresh` project's step has this
one entry. Its `log.created` event brings a new snapshot, and Details refetches on it.

- [ ] **Step 16: e2e, T392 l.453: the resource rows**

Test `at 520 px there is no minimap, old finished steps fold into "✓ n done", and a card counts its resources`.
After:

```ts
  await expect(details.locator('.ip-res b')).toHaveText(['Signing test suite', 'Signing checklist']);
```

insert:

```ts
  // Quiet: a resource is a muted row, no purple: its title in ink at 500, its summary in DM Mono.
  const resource = details.locator('.ip-res').first();
  await expect(resource).toHaveCSS('color', 'rgb(71, 85, 105)');
  await expect(resource).toHaveCSS('border-top-style', 'none');
  await expect(resource.locator('b')).toHaveCSS('color', 'rgb(30, 41, 59)');
  await expect(resource.locator('b')).toHaveCSS('font-weight', '500');
  await expect(resource.locator('.sub')).toHaveCSS('font-family', /DM Mono/);
```

- [ ] **Step 17: e2e, T1203 l.1241: the reader's ◇**

Test `a worker's badge says what it was asked to do, and a session's readers on a step fold into one reading row`.
After the Details list check that ends at l.1241:

```ts
    await expect(details.locator('.ip-dagent')).toHaveText([
      new RegExp(`^◇ a2 · Map the signing config · haiku · ${RUNNING}Find where the keystore is configured\\.$`),
      new RegExp(`^◇ a3 · Read the release docs · haiku · ${RUNNING}$`),
    ]);
```

insert:

```ts
    // Quiet: a reader's ◇ is muted in Details, not in the session's hue.
    await expect(details.locator('.ip-dagent .ip-reader-mark').first()).toHaveCSS('color', 'rgb(71, 85, 105)');
```

- [ ] **Step 18: e2e, T1429: the working rows**

Test `Details lists the node's working tasks with who is on each, and the subagents on it`. After its last assertion
(l.1442):

```ts
    await expect(details.locator('.ip-dagent')).toHaveText(new RegExp(`^a1 · Draft the store notes · sonnet · ${RUNNING}$`));
```

insert:

```ts
    // Quiet: the rows read as the canvas's. ◐ in the active ink and still, the hue bar on the session's own task only,
    // the tags in DM Mono in the session's hue.
    const upload = details.locator('.ip-wt', { hasText: /^◐ Upload the key/ });
    const screenshots = details.locator('.ip-wt', { hasText: 'Collect the screenshots' });
    await expect(upload.locator('.ip-work-mark')).toHaveCSS('color', 'rgb(194, 65, 12)');
    await expect(upload.locator('.ip-work-mark')).toHaveCSS('animation-name', 'none');
    await expect(upload.locator('.ip-work-agent')).toHaveCSS('background-color', 'rgb(11, 107, 125)');
    await expect(screenshots.locator('.ip-work-agent')).toHaveCount(0);
    for (const tag of [screenshots.locator('.ip-work-tag'), details.locator('.ip-dagent .ip-agent-tag')]) {
      await expect(tag).toHaveCSS('font-family', /DM Mono/);
      await expect(tag).toHaveCSS('color', 'rgb(11, 107, 125)');
    }
```

The `fresh` project's session holds slot 0, so its hue is `--family-0`, teal.

- [ ] **Step 19: e2e, T1445 l.1501: the trail's ◆ and ○**

Test `an ended session's tasks and subagents stay on their steps as a trail row that opens, and Details lists them
under its title`. After:

```ts
    await expect(group.locator('.ip-dtrail')).toHaveText(new RegExp(`^◆ Check the keystore · sonnet · ran ${RUNNING} · stopped just now$`));
```

insert:

```ts
    // Quiet: the trail's ◆ is muted, and its open task a faint ○.
    await expect(group.locator('.ip-dtrail .ip-agent-dot')).toHaveCSS('color', 'rgb(71, 85, 105)');
    await expect(group.locator('.ip-wt.stale .ip-work-mark')).toHaveCSS('color', 'rgb(100, 116, 139)');
```

- [ ] **Step 20: Typecheck, build, and run the six tests**

```bash
cd /c/personal/InProgress/.claude/worktrees/quiet-t5 && npm run typecheck && npm run build && INPROGRESS_E2E_PORT=4395 npx playwright test -g "clicking a node opens its details|a labelled step shows its glyph|at 520 px there is no minimap|a worker's badge says what it was asked to do|Details lists the node's working tasks|an ended session's tasks and subagents stay on their steps"
```

Expected: typecheck clean, `Built into …/.build`, then `6 passed`. A failure in a `.ip-marker` look (T204's active
dot) is the Marker's rule in `character.css`: report it to the controller for Task 2, and do not add a marker rule
here.

- [ ] **Step 21: Commit the e2e**

```bash
git -C /c/personal/InProgress/.claude/worktrees/quiet-t5 add test/e2e/ui.spec.ts
git -C /c/personal/InProgress/.claude/worktrees/quiet-t5 commit -m "Details e2e: the Quiet frame, marker, rows, resources and log (#81)" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

Expected: `1 file changed` with only insertions.

- [ ] **Step 22: The full e2e on the branch**

On this branch, Task 5 is the first to import `Marker.tsx`, so it is the first to put `character.css` in the
bundle. Its marker rules then reach today's canvas markers too. The canvas's paused and needs-you looks still win
there, with three classes against two (`.ip-node.paused .ip-marker`, `.ip-node.needs-you .ip-marker`), so T465 and
T284 hold. The whole suite checks that nothing else moved, and guards the sheet geometry T301 and T510 to T630
depend on.

```bash
cd /c/personal/InProgress/.claude/worktrees/quiet-t5 && INPROGRESS_E2E_PORT=4395 npm run test:e2e
```

Expected: `Built into …/.build`, then `50 passed`, 0 failed, 0 flaky. A failure on a line Task 5 does not own goes
to the controller with the test's name and the failing line.

- [ ] **Step 23: Hand the branch over**

```bash
git -C /c/personal/InProgress/.claude/worktrees/quiet-t5 status --short
git -C /c/personal/InProgress/.claude/worktrees/quiet-t5 log --oneline quiet-restyle..quiet/t5-details
```

Expected: no status output, and three commits, newest first:
`Details e2e: the Quiet frame, marker, rows, resources and log (#81)`,
`Details and the viewer in the Quiet look (#81)`,
`Details: the shared marker for the status and the steps, the hue bar on the session's own tasks, an upright log (#81)`.

**Verification.** Task 5 is done when `npm run typecheck` and `npm test` pass (Step 12), the six Details tests pass
(Step 20: T204, T247, T392, T1203, T1429, T1445), and the full suite passes with 50 tests (Step 22).

**How it merges.** Task 5 never merges itself. Task 7 Step 4 merges `quiet/t5-details` into `quiet-restyle` with
`--no-ff`, after `quiet/t4-chrome` and before `quiet/t6-canvas`. It should merge cleanly: in `styles.css` the
untouched Details head comment separates this region from the canvas's, and the region's last line sits above the
untouched reduced-motion head; in `ui.spec.ts` each insertion sits between two Details lines no other task edits. If
Task 7 reports a conflict and sends the branch back, merge the integration branch into it here:

```bash
git -C /c/personal/InProgress/.claude/worktrees/quiet-t5 merge quiet-restyle -m "Merge quiet-restyle into the Details branch (#81)" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

Resolve by keeping each side's own lines (Task 5 owns only the Details and viewer region and the six insertions
above), then rerun Step 12 and Step 20 and commit the resolution with
`git -C /c/personal/InProgress/.claude/worktrees/quiet-t5 commit --no-edit`.

### Task 6: Canvas, in two parts

Task 6 is the critical path's long task. It runs as two parts in sequence on one branch and one worktree, for review
size only:

- **6a** makes each card own its lines: the frame, the header, stack heads and their tracks, lanes, the queue gutter,
  the pitch variables, edges, the canvas chrome and the left-anchored camera. The agent line draws its label and its
  kin as text (tag and run time), with no characters yet.
- **6b** puts the Simple characters on the agent line (the lead and each kin) and adds the new canvas e2e test.

Both parts end green: typecheck, unit, and the e2e tests they touch. Task 6 does not merge itself; Task 7 merges
`quiet/t6-canvas` (which carries `quiet/t3-layout`) after the chrome and Details branches.

Line numbers are at `0b786b8`. Task 1 has since reflowed `styles.css` and added lines to T284, so find
`styles.css` rules by their region head (`grep -n "Region:" web/src/styles.css`) and e2e lines by the "Before" text
shown. `Canvas.tsx`, `NodeCard.tsx`, `useCamera.ts` and the row components are as at `0b786b8` (Task 1 changed only the
token on `Canvas.tsx:237`).

The names Task 6 defines (the canvas components and their props, `PITCH`, `centerOnY` and `hasMoved`, the e2e
helpers, the settled wording and the implementer's calls) are in the Interface contract under "Canvas components".

### Task 6a: Cards own their lines: frame, header, stack heads, lanes, gutter, edges, camera

Size L. Wave 2, after Task 1, Task 2 and Task 3 (both parts). Worktree
`/c/personal/InProgress/.claude/worktrees/quiet-t6`, branch `quiet/t6-canvas`, `INPROGRESS_E2E_PORT=4396`.

**Files:**
- Create: `web/src/canvas/pitch.ts`, `web/src/canvas/AgentLine.tsx`, `web/src/canvas/LaneNode.tsx`,
  `test/web/pitch.test.ts`
- Modify: `web/src/canvas/Canvas.tsx:1-48, 98-101, 131-222, 224-240, 324-325, 330-342, 344-370`
- Modify (whole file): `web/src/canvas/NodeCard.tsx`, `web/src/canvas/ReadersRow.tsx`, `web/src/canvas/WorkRow.tsx`,
  `web/src/canvas/WorkDoneRow.tsx`, `web/src/canvas/TrailAgentRow.tsx`
- Modify: `web/src/canvas/useCamera.ts:19-20, 54-65, 71, 95-96, 103, 145-148`
- Modify: `web/src/styles.css`, the whole canvas region (from `/* Region: canvas. Task 6. */` to the line before
  `/* Region: Details and viewer. Task 5. */`)
- Delete: `web/src/canvas/BadgeNode.tsx`, `web/src/canvas/AgentBadge.tsx`
- Test: `test/web/pitch.test.ts` (new); `test/e2e/ui.spec.ts`: helpers after `RUNNING` (l.1083), T284 l.294-295,
  T392 l.416, T1086 l.1106 and l.1112-1113, T1142 l.1151-1200, T1203 l.1211-1213 and l.1225, T1294 after l.1313,
  T1380 l.1394-1406, l.1414, l.1416-1418 and l.1426, T1445 l.1470
- Unchanged on purpose: `MoreNode.tsx`, `sheet.ts`, `followThrottle.ts`, `breadcrumb.ts` (Task 3's)

**Interfaces:**
- Consumes, from Task 3 part B (`src/core/layout.ts`): `NODE_H` 32, `CARD_GAP` 10, `ROW` 42, `FOLD_ROW` 36,
  `AGENT_LINE` 28, `READERS_LINE` 20, `DONE_LINE` 20, `TASK_ROW` 22, `CARD_PAD` 8, `INDENT` 28, `STACK_HEAD` 43;
  `LayoutItem` with `LayoutLineItem { kind: 'line'; id; sessionId; nodeId; lead: boolean; agentIds: string[]; x; y }`;
  `LayoutNodeItem.h`, `.w`, `.stack`, `.workingFocus`; `LayoutWorkDoneItem.shared`; `LayoutResult.lanes:
  LayoutLane[]` with `LayoutLane { id: 'lane<nodeId>'; nodeId; x; y; w; h }`.
- Consumes, from Task 3 part A (`web/src/live.ts`): `WORDS`, `kinTitle(a, slot, now, underNode)`,
  `runTime(fromIso, now)`; and the unchanged `agentLine`, `agentName`, `withTag`, `circled`, `trailLabel`,
  `trailAgentLine`, `workMark`, `withoutOwnId`, `taskFamily`, `taskOwner`, `waitsFor`.
- Consumes, from Task 2: `Marker` and `MarkerProps` (`web/src/Marker.tsx`); the marker's look lives in
  `web/src/character.css`.
- Consumes, from Task 1: the tokens (`--bg`, `--text`, `--text-2`, `--muted`, `--faint`, `--border`, `--card`,
  `--active-fill`, `--active-line`, `--lane`, `--float`, `--panel-2`, `--track`, `--track-fill`, `--active-ink`,
  `--amber`, `--amber-ink`, `--amber-fill`, `--red`, `--family-0` to `--family-5`, `--radius`, `--font-mono`,
  `--fs-l`, `--fs-m`, `--fs-s`, `--w-text`, `--w-heavy`, `--track-l`); the `ip-pulse` keyframes; the blanket
  reduced-motion rule; the region heads; the rules Task 1 moved into the canvas region.
- Produces: `PITCH` (`web/src/canvas/pitch.ts`) and the custom properties `--node-h`, `--card-gap`, `--row`,
  `--fold-row`, `--agent-line`, `--readers-line`, `--done-line`, `--task-row`, `--card-pad`, `--indent`,
  `--stack-head` on `div.ip-canvas`; `AgentLine` / `AgentLineProps`; `ReadersRow` / `ReadersRowProps`; `WorkRow` /
  `WorkRowProps`; `WorkDoneRow` / `WorkDoneRowProps`; `TrailAgentRow` / `TrailAgentRowProps`; `CardRow`; `LaneNode`;
  node types `ipNode`, `ipMore`, `ipLane`; the canvas class hooks of the Interface contract's Class hooks table
  (`.ip-node-col`, `.ip-badge-label`, `.ip-badge-title`, `.ip-badge-sep`, `.ip-badge-word`, `.ip-agent-more`,
  `.ip-readers-text`, `.ip-work-done-label`, and the frame's state classes); `useCamera`'s `centerOnY` and
  `hasMoved`; the e2e helpers `RUN_TIME`, `frameOf`, `expectInside`.

- [ ] **Step 1: Create the worktree and merge Task 3's layout into it**

```bash
git -C /c/personal/InProgress worktree add /c/personal/InProgress/.claude/worktrees/quiet-t6 -b quiet/t6-canvas quiet-restyle
git -C /c/personal/InProgress/.claude/worktrees/quiet-t6 merge --no-ff quiet/t3-layout -m "Merge Task 3's layout into the canvas branch (#81)" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
cd /c/personal/InProgress/.claude/worktrees/quiet-t6 && npm ci --prefer-offline --no-audit --no-fund
```

Expected: `Preparing worktree (new branch 'quiet/t6-canvas')`, then `Merge made by the 'ort' strategy.` with no
conflicts, then npm's `added … packages`. If `npm ci` fails offline, run `npm ci --no-audit --no-fund`.

- [ ] **Step 2: Check the starting point**

```bash
cd /c/personal/InProgress/.claude/worktrees/quiet-t6
ls web/src/Character.tsx web/src/characterState.ts web/src/character.css web/src/Marker.tsx
grep -nE "export (const WORDS|function (kinTitle|runTime|leadTitle))" web/src/live.ts
grep -nE "export const (STACK_HEAD|DONE_LINE|AGENT_LINE)|lanes: LayoutLane\[\]|shared: boolean|workingFocus: boolean" src/core/layout.ts
grep -n "Region:" web/src/styles.css
npx tsc -p tsconfig.json && npm test
npx tsc -p web/tsconfig.json
```

Expected: the four Task 2 files exist; `live.ts` lists `WORDS`, `leadTitle`, `kinTitle` and `runTime`; `layout.ts`
lists the three constants, `lanes`, `shared` and `workingFocus`; the five region heads print in the order tokens,
chrome, canvas, Details and viewer, reduced motion. The root typecheck is clean and every unit test passes (Task 3's
layout tests included). The web typecheck fails, with errors only in `web/src/canvas/Canvas.tsx`, about the `badge` and
`agent` items layout no longer emits. The steps below fix them.

- [ ] **Step 3: Write the failing pitch test**

Create `test/web/pitch.test.ts`:

```ts
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { AGENT_LINE, CARD_GAP, CARD_PAD, DONE_LINE, FOLD_ROW, INDENT, NODE_H, READERS_LINE, ROW, STACK_HEAD, TASK_ROW } from '../../src/core/layout';
import { PITCH } from '../../web/src/canvas/pitch';

/** The canvas region of styles.css, from its head comment to the next region's, without comments. */
function canvasRegion(): string {
  const css = readFileSync('web/src/styles.css', 'utf8');
  const start = css.indexOf('/* Region: canvas. Task 6. */');
  const end = css.indexOf('/* Region: Details and viewer. Task 5. */');
  if (start < 0 || end < start) throw new Error('styles.css has lost its canvas region heads');
  return css.slice(start, end).replace(/\/\*[\s\S]*?\*\//g, '');
}

/** Every rule that holds no nested block: its selectors, whitespace collapsed, and its declarations. */
function rules(css: string): { selectors: string[]; decls: [string, string][] }[] {
  return [...css.matchAll(/([^{}]+)\{([^{}]*)\}/g)].map(([, selectors, body]) => ({
    selectors: selectors.split(',').map((s) => s.trim().replace(/\s+/g, ' ')),
    decls: body.split(';').flatMap((d): [string, string][] => {
      const colon = d.indexOf(':');
      return colon < 0 ? [] : [[d.slice(0, colon).trim(), d.slice(colon + 1).trim()]];
    }),
  }));
}

/** The canvas rules that size a card's parts, and the property each one sizes them by. */
const PITCHED: [selector: string, property: string][] = [
  ['.ip-card > .ip-node', 'height'],
  ['.ip-node.stack', 'height'],
  ['.ip-badge', 'height'],
  ['.ip-readers', 'height'],
  ['.ip-lines > .ip-work-done', 'height'],
  ['.ip-card .ip-work', 'height'],
  ['.ip-trail-agent', 'height'],
  ['.ip-more', 'height'],
  ['.ip-card .ip-lines', 'padding-bottom'],
  ['.ip-card.stack .ip-lines', 'margin-top'],
];

const pitchVar = `var\\(--(?:${Object.keys(PITCH).map((k) => k.slice(2)).join('|')})\\)`;
/** A pitch variable, or a calc() that starts from one and adds or takes away others or the frame's two 1 px borders. */
const FROM_PITCH = new RegExp(`^(?:${pitchVar}|calc\\(${pitchVar}(?: [-+] (?:${pitchVar}|2px))*\\))$`);

describe('the canvas pitch', () => {
  it("is layout's: one custom property per exported constant", () => {
    expect(PITCH).toEqual({
      '--node-h': `${NODE_H}px`,
      '--card-gap': `${CARD_GAP}px`,
      '--row': `${ROW}px`,
      '--fold-row': `${FOLD_ROW}px`,
      '--agent-line': `${AGENT_LINE}px`,
      '--readers-line': `${READERS_LINE}px`,
      '--done-line': `${DONE_LINE}px`,
      '--task-row': `${TASK_ROW}px`,
      '--card-pad': `${CARD_PAD}px`,
      '--indent': `${INDENT}px`,
      '--stack-head': `${STACK_HEAD}px`,
    });
  });

  it('accepts a pitch variable and refuses a literal', () => {
    expect(['var(--agent-line)', 'calc(var(--node-h) - 2px)', 'calc(var(--stack-head) - var(--node-h))'].every((v) => FROM_PITCH.test(v))).toBe(true);
    expect(['28px', 'calc(28px + var(--node-h))', 'calc(var(--node-h) - 4px)', 'var(--fs-m)'].filter((v) => FROM_PITCH.test(v))).toEqual([]);
  });

  it.each(PITCHED)('sizes %s by its %s from the pitch', (selector, property) => {
    const values = rules(canvasRegion())
      .filter((r) => r.selectors.includes(selector))
      .flatMap((r) => r.decls.filter(([p]) => p === property).map(([, v]) => v));
    expect(values, `${selector} { ${property} }`).not.toEqual([]);
    for (const v of values) expect(v, `${selector} { ${property}: ${v} }`).toMatch(FROM_PITCH);
  });

  it('sets no literal height in those rules', () => {
    const pitched = new Set(PITCHED.map(([s]) => s));
    const literal = rules(canvasRegion())
      .filter((r) => r.selectors.some((s) => pitched.has(s)))
      .flatMap((r) => r.decls.filter(([p, v]) => /^(?:min-|max-)?height$/.test(p) && !FROM_PITCH.test(v)).map(([p, v]) => `${r.selectors.join(', ')} { ${p}: ${v} }`));
    expect(literal).toEqual([]);
  });
});
```

Run: `cd /c/personal/InProgress/.claude/worktrees/quiet-t6 && npx vitest run test/web/pitch.test.ts`

Expected: FAIL. The file does not load: Vitest cannot resolve `../../web/src/canvas/pitch`.

- [ ] **Step 4: Create the pitch module**

Create `web/src/canvas/pitch.ts`:

```ts
import { AGENT_LINE, CARD_GAP, CARD_PAD, DONE_LINE, FOLD_ROW, INDENT, NODE_H, READERS_LINE, ROW, STACK_HEAD, TASK_ROW } from '../../../src/core/layout';

/**
 * Layout's pitch as CSS custom properties, one per exported constant. Canvas writes them once, on `div.ip-canvas`,
 * and the canvas rules in styles.css read them for every fixed height, so a card's DOM can't drift from the heights
 * layout spaces it by. test/web/pitch.test.ts holds the stylesheet to it.
 */
export const PITCH: Record<string, string> = {
  '--node-h': `${NODE_H}px`,
  '--card-gap': `${CARD_GAP}px`,
  '--row': `${ROW}px`,
  '--fold-row': `${FOLD_ROW}px`,
  '--agent-line': `${AGENT_LINE}px`,
  '--readers-line': `${READERS_LINE}px`,
  '--done-line': `${DONE_LINE}px`,
  '--task-row': `${TASK_ROW}px`,
  '--card-pad': `${CARD_PAD}px`,
  '--indent': `${INDENT}px`,
  '--stack-head': `${STACK_HEAD}px`,
};
```

Run: `cd /c/personal/InProgress/.claude/worktrees/quiet-t6 && npx vitest run test/web/pitch.test.ts`

Expected: `Tests  11 failed | 2 passed (13)`. The two that pass check `PITCH` and the checker. The ten `sizes …`
cases and `sets no literal height` fail: today's canvas rules use literal heights (`.ip-badge`, `.ip-readers`,
`.ip-more`, `.ip-trail-agent`) or lack the selector.

- [ ] **Step 5: Look at what the canvas region holds now**

```bash
cd /c/personal/InProgress/.claude/worktrees/quiet-t6 && sed -n '/Region: canvas. Task 6./,/Region: Details and viewer. Task 5./p' web/src/styles.css | grep -oE "^\s*[^ {][^{]*\{" | sed 's/{$//'
```

Expected: the selectors of today's canvas rules (`styles.css:121-198` at `0b786b8`, restyled by Task 1), plus the
three things Task 1 moved in. The new block in Step 6 covers every one of them:

| Selectors now in the region | In the new block |
|---|---|
| `.ip-canvas`, `.ip-canvas .react-flow` | kept; the zoom row's colour variables join `.ip-canvas .react-flow` |
| `.ip-crumb` | on `--float`, 24 px, clear of the zoom row |
| `.ip-row` | the node's root, now `position: relative` |
| `.ip-node` and its state rules (`.root`, `.st-active`, `.needs-you`, `.st-todo`, `.st-dropped`, `.selected`, `.flash`), `@keyframes ip-flash` | the header rules; the look moves to the frame `.ip-card` (fill, focus hairline, selected and flash rings) |
| `.ip-marker`, `.ip-marker.*`, `.ip-node.needs-you .ip-marker`, `.ip-node.working .ip-marker.m-active`, `.ip-node.paused .ip-marker` | deleted: the Marker's look is in `character.css` (Task 2) |
| `.ip-you`, `.ip-blocked`, `.ip-progress`, `.ip-chevron`, `.ip-type`, `.ip-type, .ip-glyph`, `.ip-type.l-data, .ip-glyph.l-data` | restyled, unboxed; the two rules shared with Details' `.ip-glyph` keep both selectors |
| `.ip-queue`, `.ip-queue.owned` | the fixed gutter column |
| `.ip-chip`, `.ip-res-count` | muted mono |
| `.ip-more`, `.ip-more-mark` | the 26 px fold row |
| `.ip-badge`, `.ip-badge.s-idle`, `.ip-badge.s-permission` | the agent line and its label |
| moved in by Task 1: `.ip-badge.s-permission .ip-tag` (the badge half of today's `:114`) | deleted: the letter keeps its hue through `.ip-badge .ip-tag`, and permission shows as the amber word and the character's ring |
| `.ip-agent, .ip-trail-agent`, `.ip-agent.ended, .ip-trail-agent` | split: the kin, and the trail row |
| `.ip-readers` | the readers line |
| `.ip-work, .ip-work-done` and every `.ip-work*` rule | task rows scoped under `.ip-card`; the parts Details' `.ip-wt` rows share stay unscoped; the done row |
| `.ip-handle` | kept |
| moved in by Task 1: `.ip-agent-tag` | kept global (the chip popover and Details share it), DM Mono S in the hue |
| moved in by Task 1: `@media (max-width: 719px)` with `.ip-row > .ip-chip` and `.ip-res-count` | kept, last in the region |
| moved in by Task 1: `@media (prefers-reduced-motion: reduce)` with the static flash ring | kept, on `.ip-card.flash` |

If the listing shows a selector this table does not name, copy that rule unchanged to the end of the new block and say
so in the Step 7 commit message.

- [ ] **Step 6: Replace the canvas region**

In `web/src/styles.css`, replace everything from the line `/* Region: canvas. Task 6. */` up to, but not including,
the line `/* Region: Details and viewer. Task 5. */` with:

```css
/* Region: canvas. Task 6. */
.ip-canvas { flex: 1; position: relative; min-width: 0; }
/* The ground is --bg itself: no dot grid. The zoom row takes its colours through React Flow's variables; without the
   hover one, a hovered button paints React Flow's own grey. */
.ip-canvas .react-flow {
  background: var(--bg);
  --xy-controls-button-background-color: var(--float);
  --xy-controls-button-background-color-hover: var(--panel-2);
  --xy-controls-button-color: var(--muted);
  --xy-controls-button-color-hover: var(--text);
  --xy-controls-button-border-color: var(--border);
  --xy-controls-box-shadow: none;
}
/* The zoom row: three 24 px hairline buttons in a row, at the top right. */
.ip-canvas .react-flow__controls { margin: 8px 12px; gap: 4px; }
.ip-canvas .react-flow__controls.horizontal .react-flow__controls-button { width: 24px; height: 24px; padding: 0; border: 1px solid var(--border); border-radius: var(--radius); }
.ip-canvas .react-flow__controls-button:focus-visible { outline: 2px solid var(--text-2); outline-offset: 1px; }
/* The breadcrumb, at the top left, clear of the zoom row. */
.ip-crumb { position: absolute; top: 8px; left: 10px; z-index: 5; height: 24px; max-width: calc(100% - 120px); padding: 0 9px; border: 1px solid var(--border); border-radius: var(--radius); background: var(--float); color: var(--muted); font-size: var(--fs-s); line-height: 22px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
/* A phase's lane: a faint band behind its stack head and its subtree. Canvas turns its pointer events off. */
.react-flow__node-ipLane { background: var(--lane); border-radius: var(--radius); }

/* A step's node: its frame and, from 720 px, its resource chips. It is the containing block of the queue gutter, the
   stack head's track and the handles. */
.ip-row { position: relative; display: flex; align-items: flex-start; gap: 8px; }
/* The frame: one hairline, one radius, the card fill. NodeCard sizes it from layout. */
.ip-card { flex: none; padding: 0 12px 0 4px; border: 1px solid var(--border); border-radius: var(--radius); background: var(--card); cursor: pointer; }
.ip-card.st-done, .ip-card.st-dropped { background: none; }
/* The working focus: the one orange hairline on the canvas. */
.ip-card.focus { border-color: var(--active-line); background: var(--active-fill); }
.ip-card.selected { box-shadow: 0 0 0 2px var(--text-2); }
.ip-card.flash { animation: ip-flash 1.2s ease-out; }
@keyframes ip-flash { 0% { box-shadow: 0 0 0 7px color-mix(in srgb, var(--amber) 60%, transparent); } 100% { box-shadow: 0 0 0 0 transparent; } }
@media (prefers-reduced-motion: reduce) {
  /* The flash holds a static ring instead of fading one out. */
  .ip-card.flash { box-shadow: 0 0 0 3px color-mix(in srgb, var(--amber) 60%, transparent); }
}

/* The header: the step's own row, 30 px inside the frame's border, so its middle is where the camera aims. */
.ip-node { display: flex; align-items: center; gap: 8px; min-width: 0; white-space: nowrap; color: var(--text-2); }
.ip-card > .ip-node { height: calc(var(--node-h) - 2px); }
.ip-node:focus-visible { outline: 2px solid var(--text-2); outline-offset: -2px; border-radius: var(--radius); }
/* Every framed card's 22 px left column, its marker right-aligned in it, so all titles align. */
.ip-node-col { flex: none; display: flex; align-items: center; justify-content: flex-end; width: 22px; }
.ip-node .ip-title { flex: 1 1 auto; min-width: 0; overflow: hidden; text-overflow: ellipsis; font-size: var(--fs-m); line-height: 18px; }
.ip-node.root .ip-title { font-weight: var(--w-heavy); }
.ip-card.focus .ip-title { font-size: var(--fs-l); font-weight: var(--w-heavy); line-height: 20px; letter-spacing: var(--track-l); word-spacing: .05em; color: var(--text); }
.ip-node.st-done .ip-title { color: var(--muted); }
.ip-node.st-dropped .ip-title { text-decoration: line-through; color: var(--muted); }
/* A depth-1 phase: an unframed stack head that opens its lane, centred in a 32 px box, its progress track under it. */
.ip-card.stack { padding: 0; border: 0; background: none; }
.ip-node.stack { height: var(--node-h); gap: 9px; }
.ip-node.stack .ip-title { font-size: var(--fs-l); font-weight: var(--w-heavy); line-height: 20px; letter-spacing: var(--track-l); word-spacing: .05em; color: var(--text); }
.ip-track { position: absolute; top: calc(var(--node-h) + 1px); left: 18px; width: 466px; height: 2px; background: var(--track); }
.ip-track-fill { height: 100%; background: var(--track-fill); }
/* After the title, with no boxes: the type glyph, ▤ n, YOU, blocked, n/m and the chevron. */
.ip-type { flex: none; color: var(--muted); font-size: var(--fs-m); line-height: 18px; }
/* Text presentation, so ⚙ and ⚒ never turn into emoji. Details' glyph shares it. */
.ip-type, .ip-glyph { font-variant-emoji: text; }
/* ⛁ draws faint at text size. */
.ip-type.l-data, .ip-glyph.l-data { font-size: 1.33em; }
/* A narrow window's single resource count, in the header (shown by the max-width: 719px block below). */
.ip-res-count { display: none; flex: none; font-family: var(--font-mono); font-size: var(--fs-s); line-height: 14px; color: var(--muted); white-space: nowrap; }
.ip-you { flex: none; height: 18px; padding: 0 6px; border-radius: var(--radius); background: var(--amber-fill); color: var(--amber-ink); font-size: var(--fs-s); font-weight: var(--w-heavy); line-height: 18px; letter-spacing: .04em; white-space: nowrap; }
.ip-blocked { flex: none; color: var(--red); font-size: var(--fs-s); line-height: 14px; }
.ip-progress { flex: none; font-family: var(--font-mono); font-size: var(--fs-s); line-height: 14px; color: var(--muted); }
.ip-chevron { flex: none; width: 16px; font-size: var(--fs-s); line-height: 14px; color: var(--muted); }
/* Up next place: a fixed gutter column at flow x 6 to 48, whatever the card's indent. NodeCard sets --x, the card's
   flow x, on .ip-row. Owned: letter and numeral in the session's hue. Unowned: ink. */
.ip-queue { position: absolute; top: 0; left: calc(6px - var(--x)); width: 42px; height: var(--node-h); display: flex; align-items: center; justify-content: flex-end; font-size: var(--fs-l); font-weight: var(--w-heavy); line-height: 20px; letter-spacing: var(--track-l); white-space: nowrap; color: var(--text-2); }
.ip-queue.owned { color: var(--fam, var(--family-0)); }
.ip-queue > span + span { margin-left: 1px; }
/* From 720 px a card's first two resources sit beside its frame, past the lane's edge: muted mono, no box. */
.ip-chip { flex: none; margin-top: 9px; max-width: 180px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-family: var(--font-mono); font-size: var(--fs-s); line-height: 14px; color: var(--muted); }
.ip-chip:hover { color: var(--text-2); }

/* A card's lines, under its header. Each is one fixed-height line, so the frame is exactly layout's h. */
.ip-lines { min-width: 0; }
.ip-card .ip-lines { padding-bottom: var(--card-pad); }
/* A stack head's lines sit under its track at flow x 56, unframed. */
.ip-card.stack .ip-lines { margin-top: calc(var(--stack-head) - var(--node-h)); padding: 0 0 0 34px; }
/* One session's agent line: its lead, its kin, then its label. Away from the session's focus the line starts with the
   letter and has no label. The title is the one part that gives way. */
.ip-badge { display: flex; align-items: center; height: var(--agent-line); min-width: 0; padding-left: 6px; white-space: nowrap; font-size: var(--fs-m); line-height: 18px; color: var(--text-2); }
/* Under a stack head there is no frame to clear: the line drops its 6 px, so it starts at flow x 56, as the done row
   of its own line does. */
.ip-card.stack .ip-badge { padding-left: 0; }
.ip-badge .ip-tag, .ip-readers .ip-tag { font-weight: var(--w-heavy); color: var(--fam, var(--family-0)); }
.ip-badge > .ip-tag { flex: none; }
/* The label's parts sit in the line itself, so its title gives way first, down to nothing, and only then the done
   row's label. Its letter starts 12 px after the last kin. */
.ip-badge-label { display: contents; }
.ip-badge-label > :first-child { margin-left: 12px; }
.ip-badge > .ip-badge-label:first-child > :first-child { margin-left: 0; }
.ip-badge-label .ip-tag { flex: none; }
.ip-badge-sep { flex: none; white-space: pre; color: var(--muted); }
.ip-badge-title { flex: 0 1000 auto; min-width: 0; overflow: hidden; text-overflow: ellipsis; }
.ip-badge-word { flex: none; color: var(--muted); }
.ip-badge.s-permission .ip-badge-word { color: var(--amber-ink); }
/* A kin: one shown worker, its character, its tag and, while it runs, its run time. Ended, it goes grey. */
.ip-agent { flex: none; display: inline-flex; align-items: center; gap: 3px; margin-left: 8px; }
.ip-badge > .ip-agent:first-child { margin-left: 0; }
/* A subagent's tag, here, in the chip's list and in Details: DM Mono in its session's hue. */
.ip-agent-tag { font-family: var(--font-mono); font-size: var(--fs-s); font-weight: var(--w-text); line-height: 14px; color: var(--fam, var(--faint)); }
.ip-agent-time { font-family: var(--font-mono); font-size: var(--fs-s); line-height: 14px; color: var(--muted); }
.ip-agent.ended, .ip-agent.ended .ip-agent-tag { color: var(--muted); }
.ip-agent-more { flex: none; margin-left: 8px; font-family: var(--font-mono); font-size: var(--fs-s); line-height: 14px; color: var(--muted); }
/* A session's running readers: one muted line, indented past the lead. Only the letter wears the hue. */
.ip-readers { display: flex; align-items: center; height: var(--readers-line); min-width: 0; padding-left: 38px; white-space: nowrap; font-size: var(--fs-s); line-height: 14px; color: var(--muted); }
.ip-readers-text { flex: 0 1 auto; min-width: 0; overflow: hidden; text-overflow: ellipsis; }
/* The done row: at the right end of a kin-less last line, else on a 20 px line of its own. Its label cuts last. */
.ip-work-done { flex: 0 1 auto; display: inline-flex; align-items: center; gap: 4px; min-width: 0; margin-left: auto; padding-left: 6px; white-space: nowrap; font-size: var(--fs-s); line-height: 14px; color: var(--muted); }
.ip-lines > .ip-work-done { display: flex; width: max-content; max-width: 100%; height: var(--done-line); margin-left: 30px; padding-left: 0; }
.ip-card.stack .ip-lines > .ip-work-done { margin-left: 0; }
.ip-work-done-label { min-width: 0; overflow: hidden; text-overflow: ellipsis; }
.ip-work-done::after { content: '▸'; }
.ip-work-done[aria-expanded='true']::after { content: '▾'; }
.ip-work-done:hover { color: var(--text-2); }
.ip-work-done:focus-visible { outline: 2px solid var(--text-2); outline-offset: 1px; border-radius: var(--radius); }
/* Shared with Details' task rows (.ip-wt, Details.tsx:93-98): the tag, the mark's colour, the hue bar and the trail. */
.ip-work-tag { font-family: var(--font-mono); font-size: var(--fs-s); font-weight: var(--w-text); line-height: 14px; color: var(--fam, var(--family-0)); }
.ip-work-mark { color: var(--muted); }
.w-in_progress .ip-work-mark { color: var(--active-ink); }
.ip-work-agent { display: inline-block; width: 3px; height: 12px; vertical-align: -1px; background: var(--fam, var(--family-0)); }
.ip-work.pulse .ip-work-mark { animation: ip-pulse 1.6s ease-in-out infinite; }
/* A working task in its card: 22 px, no box. The left column holds a subagent's tag; only the session's own rows carry
   the hue bar, and a row without one keeps its slot, so subjects align. */
.ip-card .ip-work { display: flex; align-items: center; gap: 8px; height: var(--task-row); min-width: 0; white-space: nowrap; font-size: var(--fs-m); line-height: 18px; color: var(--text-2); }
.ip-work-col { flex: none; display: flex; justify-content: flex-end; width: 22px; }
.ip-card .ip-work-mark { flex: none; width: 12px; text-align: center; }
.ip-card .ip-work-agent { flex: none; margin-left: -3px; }
.ip-card .ip-work-mark + .ip-work-subject { margin-left: 8px; }
.ip-work-subject { flex: 0 1 auto; min-width: 0; overflow: hidden; text-overflow: ellipsis; }
.ip-card .ip-work.w-in_progress .ip-work-subject { color: var(--text); }
.ip-card .ip-work.w-completed .ip-work-subject { color: var(--muted); }
.ip-work-after { flex: none; max-width: 150px; overflow: hidden; text-overflow: ellipsis; color: var(--muted); }
/* The trail: a task an ended session left open is a hollow ○ in --faint that never pulses; one it completed keeps ✓. */
.ip-card .ip-work.stale .ip-work-subject, .ip-wt.stale { color: var(--muted); }
.ip-work.stale:not(.w-completed) .ip-work-mark, .ip-wt.stale:not(.w-completed) .ip-work-mark { color: var(--faint); animation: none; }
/* A subagent in the trail, under its step's open done row: neutral, its ◆ muted. */
.ip-trail-agent { height: var(--task-row); padding-left: 30px; overflow: hidden; white-space: nowrap; text-overflow: ellipsis; font-size: var(--fs-m); line-height: var(--task-row); color: var(--muted); }
/* "+n more" and "✓ n done": a fold row, 26 px, a dashed hairline on no fill, as wide as its words. */
.ip-more { display: flex; align-items: center; gap: 6px; height: calc(var(--fold-row) - var(--card-gap)); padding: 0 12px; border: 1px dashed var(--border); border-radius: var(--radius); background: transparent; white-space: nowrap; font-size: var(--fs-m); line-height: 18px; color: var(--muted); cursor: pointer; }
.ip-more-mark { color: var(--muted); }
.ip-more:focus-visible { outline: 2px solid var(--text-2); outline-offset: 1px; }
.ip-handle { opacity: 0; width: 1px; height: 1px; min-width: 0; min-height: 0; border: 0; }
@media (max-width: 719px) {
  /* One resource count inside the card instead of the chips beside it. */
  .ip-row > .ip-chip { display: none; }
  .ip-res-count { display: inline-block; }
}
```

Run:

```bash
cd /c/personal/InProgress/.claude/worktrees/quiet-t6
npx vitest run test/web/pitch.test.ts
grep -n "Region:" web/src/styles.css
sed -n '/Region: canvas. Task 6./,/Region: Details and viewer. Task 5./p' web/src/styles.css | grep -nE "font-weight:\s*(600|700|800|bold)|var\(--(accent|edge|green|purple|clay)\)|#fff\b|\.ip-marker"
```

Expected: `Tests  13 passed (13)`. The region heads still print in order. The last command prints nothing: the canvas
region holds no weight above 500 but 900, no removed token, no white ink and no marker rule. (Other regions may still
hold such lines until Tasks 4 and 5 land; they are not this task's.)

- [ ] **Step 7: Commit the pitch and the canvas rules**

```bash
git -C /c/personal/InProgress/.claude/worktrees/quiet-t6 add test/web/pitch.test.ts web/src/canvas/pitch.ts web/src/styles.css
git -C /c/personal/InProgress/.claude/worktrees/quiet-t6 commit -m "Canvas rules for Quiet cards, read from layout's pitch, held by a unit test (#81)" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

Expected: `3 files changed`. The web typecheck still fails in `Canvas.tsx`; Steps 8 to 15 fix it.

- [ ] **Step 8: Make the done row and the readers line plain components**

Replace the whole of `web/src/canvas/WorkDoneRow.tsx` with:

```tsx
import { trailLabel } from '../live';

export interface WorkDoneRowProps {
  nodeId: number;
  /** Completed tasks, of live and ended sessions. */
  count: number;
  /** Tasks an ended session left pending or in progress. */
  unfinished: number;
  /** Subagents in the trail on this node. */
  agents: number;
  /** Whether the completed tasks and the trail show. */
  open: boolean;
  onToggleFold: (key: string, value: 'open' | 'closed') => void;
}

/** What the row shows on a click: "the done and unfinished tasks and the agents". */
function contents({ count, unfinished, agents }: WorkDoneRowProps): string {
  const tasks = [count ? 'done' : '', unfinished ? 'unfinished' : ''].filter(Boolean).join(' and ');
  return [tasks ? `the ${tasks} tasks` : '', agents ? `the ${agents === 1 ? 'agent' : 'agents'} that stopped` : ''].filter(Boolean).join(' and ');
}

/**
 * `✓ 5 done · 2 unfinished · 2 agents`: a step's completed working tasks and its trail of ended work, folded into one
 * row that shows them on a click. It sits at the right end of its card's last line, or on a line of its own. Its label
 * is the part that cuts, so the ✓ and the ▸ stay.
 */
export function WorkDoneRow(props: WorkDoneRowProps) {
  const label = trailLabel({ done: props.count, unfinished: props.unfinished, agents: props.agents }).replace(/^✓ /, '');
  return (
    <button
      className="ip-work-done"
      aria-expanded={props.open}
      title={`${props.open ? 'Hide' : 'Show'} ${contents(props)}`}
      onClick={(e) => {
        // It opens the row, not Details.
        e.stopPropagation();
        props.onToggleFold(`work:${props.nodeId}`, props.open ? 'closed' : 'open');
      }}
    >
      <span className="ip-work-mark">✓</span> <span className="ip-work-done-label">{label}</span>
    </button>
  );
}
```

Replace the whole of `web/src/canvas/ReadersRow.tsx` with:

```tsx
import type { CSSProperties } from 'react';
import { agentTag, ownerTag, type SubagentInfo } from '../../../src/core/types';
import { familyVar } from '../family';
import { agentName, withTag } from '../live';
import { WorkDoneRow, type WorkDoneRowProps } from './WorkDoneRow';

export interface ReadersRowProps {
  /** The session's running readers on this step, in its order. */
  readers: SubagentInfo[];
  /** Its session's slot: the letter wears that family's hue. */
  slot: number | null;
  /** The step it sits in: a leading #id that names it is left out of the tooltip. */
  nodeId: number;
  /** The card's done row, when this is the card's last line: it sits at the line's right end. */
  done: WorkDoneRowProps | null;
}

/**
 * A session's running readers (Explore, Plan, claude-code-guide) on one step, as one muted line: `◇ a · 2 reading`,
 * only the letter in the session's hue (`◇ ? · 2 reading` while its slot is empty). Its tooltip lists what each reads.
 */
export function ReadersRow({ readers, slot, nodeId, done }: ReadersRowProps) {
  return (
    <div
      className="ip-readers"
      style={{ '--fam': familyVar(slot) } as CSSProperties}
      title={readers.map((a) => withTag(agentTag(slot, a.ordinal), agentName(a, nodeId))).join('\n')}
    >
      <span className="ip-readers-text">
        ◇ <span className="ip-tag">{ownerTag(slot).toLowerCase()}</span> · {readers.length} reading
      </span>
      {done && <WorkDoneRow {...done} />}
    </div>
  );
}
```

- [ ] **Step 9: Make the task row and the trail row plain components**

Replace the whole of `web/src/canvas/WorkRow.tsx` with:

```tsx
import type { CSSProperties } from 'react';
import type { WorkItem } from '../../../src/core/types';
import { familyVar } from '../family';
import { withoutOwnId, workMark } from '../live';

export interface WorkRowProps {
  item: WorkItem;
  /** In progress while its session works or its subagent runs: the mark pulses. */
  pulse: boolean;
  /** Its session has ended: a trail row, neutral grey, its mark hollow unless it was completed. Never pulses. */
  stale: boolean;
  /**
   * Its live session's family: the slot whose hue its tag and bar wear, and its subagent's tag (`a1`; '' on the
   * session's own list). Null for a trail row, which stays neutral.
   */
  family: { slot: number | null; tag: string } | null;
  /** Who is on it, for the tooltip: the session's title or the subagent's description, led by its letter or tag while live. */
  owner: string;
  /** The open tasks it waits for. */
  waits: string[];
}

/**
 * One working task in its card: ○ pending, ◐ in progress, ✓ completed. A subagent's carries its tag in the card's left
 * column (`a1 ◐ Write the tests`) and no bar; the session's own carries the hue bar. Left open by an ended session, a
 * hollow ○ with no hue.
 */
export function WorkRow({ item, pulse, stale, family, owner, waits }: WorkRowProps) {
  const subject = withoutOwnId(item.subject, item.nodeId);
  const after = waits.length ? `after ${waits.join(', ')}` : '';
  const left = stale && item.status !== 'completed' ? ' · left unfinished' : '';
  return (
    <div
      className={`ip-work w-${item.status}${stale ? ' stale' : ''}${pulse ? ' pulse' : ''}`}
      style={family ? ({ '--fam': familyVar(family.slot) } as CSSProperties) : undefined}
      title={`${subject} · ${owner}${left}${after ? ` · ${after}` : ''}`}
    >
      <span className="ip-work-col">{family?.tag && <span className="ip-work-tag">{family.tag}</span>}</span>
      <span className="ip-work-mark">{workMark(item.status, stale)}</span>
      {family && item.agentId === '' && <span className="ip-work-agent" />}
      <span className="ip-work-subject">{subject}</span>
      {after && <span className="ip-work-after">{after}</span>}
    </div>
  );
}
```

Replace the whole of `web/src/canvas/TrailAgentRow.tsx` with:

```tsx
import type { TrailAgent } from '../../../src/core/types';
import { trailAgentLine } from '../live';

export interface TrailAgentRowProps {
  agent: TrailAgent;
  /** The step it sits in: a leading #id that names it is left out. */
  nodeId: number;
  /** Its session's title, for the tooltip. */
  sessionTitle: string;
  now: number;
}

/**
 * A subagent in the trail, under its step's open done row: `◆ description · model · ran 40 min · stopped 2 h ago`.
 * Neutral, with no colour of its own, and never pulsing. Its tooltip is its purpose when known.
 */
export function TrailAgentRow({ agent, nodeId, sessionTitle, now }: TrailAgentRowProps) {
  return (
    <div className="ip-trail-agent" title={agent.purpose ?? `${trailAgentLine(agent, now)} (${agent.agentType}), for ${sessionTitle}`}>
      ◆ {trailAgentLine(agent, now, nodeId)}
    </div>
  );
}
```

- [ ] **Step 10: Create the agent line and the lane, and delete the old badges**

Create `web/src/canvas/AgentLine.tsx`:

```tsx
import type { CSSProperties } from 'react';
import { agentTag, sessionDisplayTitle, sessionTag, type Session, type SubagentInfo } from '../../../src/core/types';
import { familyVar } from '../family';
import { WORDS, agentLine, kinTitle, runTime, withTag } from '../live';
import { WorkDoneRow, type WorkDoneRowProps } from './WorkDoneRow';

/** How many kin a line draws. Past that, a muted `+n` stands for the rest. */
const MAX_KIN = 6;

export interface AgentLineProps {
  session: Session;
  /** The step the line sits in: a kin's leading `#id` that names it is left out of the kin's name. */
  nodeId: number;
  /** The session's focus anchors on this step: the line draws its lead and its label. */
  lead: boolean;
  /** Its shown workers on this step, in the session's order (LayoutLineItem.agentIds, resolved). */
  agents: SubagentInfo[];
  now: number;
  /** The card's done row, when this is the card's last line and it holds no kin. */
  done: WorkDoneRowProps | null;
}

interface KinProps {
  agent: SubagentInfo;
  session: Session;
  nodeId: number;
  now: number;
}

/** One shown worker: its tag and, while it runs, its run time. Its name and tooltip carry the rest, then its purpose. */
function Kin({ agent, session, nodeId, now }: KinProps) {
  const tag = agentTag(session.slot, agent.ordinal);
  const name = kinTitle(agent, session.slot, now, nodeId);
  const running = agent.endedAt === null;
  return (
    <span className={running ? 'ip-agent' : 'ip-agent ended'} role="img" aria-label={name} title={name}>
      {tag && <span className="ip-agent-tag">{tag}</span>}
      {running && <span className="ip-agent-time">{runTime(agent.startedAt, now)}</span>}
    </span>
  );
}

/**
 * One session's line in a card. Where its focus anchors: its kin, then its label `A · E2E session · working`. Away
 * from its focus: its letter, then its kin, with no label. Its accessible name leads with the letter either way. The
 * card's done row rides at its right end when this is the card's last line and it holds no kin.
 */
export function AgentLine({ session, nodeId, lead, agents, now, done }: AgentLineProps) {
  const letter = sessionTag(session.slot);
  const title = sessionDisplayTitle(session);
  const word = WORDS[session.state];
  const hidden = agents.slice(MAX_KIN);
  return (
    <div
      className={`ip-badge s-${session.state}`}
      role="group"
      aria-label={withTag(letter, lead ? `${title} · ${word}` : `subagents of ${title}`)}
      style={{ '--fam': familyVar(session.slot) } as CSSProperties}
    >
      {!lead && letter && <span className="ip-tag">{letter}</span>}
      {agents.slice(0, MAX_KIN).map((a) => (
        <Kin key={a.agentId} agent={a} session={session} nodeId={nodeId} now={now} />
      ))}
      {hidden.length > 0 && (
        <span className="ip-agent-more" title={hidden.map((a) => withTag(agentTag(session.slot, a.ordinal), agentLine(a, now, nodeId))).join('\n')}>
          +{hidden.length}
        </span>
      )}
      {lead && (
        <span className="ip-badge-label">
          {letter && (
            <>
              <span className="ip-tag">{letter}</span>
              <span className="ip-badge-sep"> · </span>
            </>
          )}
          <span className="ip-badge-title">{title}</span>
          <span className="ip-badge-sep"> · </span>
          <span className="ip-badge-word">{word}</span>
        </span>
      )}
      {done && <WorkDoneRow {...done} />}
    </div>
  );
}
```

Create `web/src/canvas/LaneNode.tsx`:

```tsx
/**
 * A phase's lane: the faint band behind its stack head and its subtree. Its look is the node wrapper's
 * (`.react-flow__node-ipLane`), sized by layout. Canvas turns its pointer events off, so it never takes a click, a pan
 * or a wheel tick.
 */
export function LaneNode() {
  return null;
}
```

Delete the old badges:

```bash
git -C /c/personal/InProgress/.claude/worktrees/quiet-t6 rm web/src/canvas/BadgeNode.tsx web/src/canvas/AgentBadge.tsx
```

Expected: `rm 'web/src/canvas/AgentBadge.tsx'` and `rm 'web/src/canvas/BadgeNode.tsx'`.

- [ ] **Step 11: Rewrite the card**

Replace the whole of `web/src/canvas/NodeCard.tsx` with:

```tsx
import type { CSSProperties } from 'react';
import { Handle, Position, type Node, type NodeProps } from '@xyflow/react';
import { NODE_H } from '../../../src/core/layout';
import { LABEL_GLYPHS, ownerTag, type ResourceMeta, type TreeNode } from '../../../src/core/types';
import { familyVar } from '../family';
import { circled } from '../live';
import { Marker } from '../Marker';
import { AgentLine, type AgentLineProps } from './AgentLine';
import { ReadersRow, type ReadersRowProps } from './ReadersRow';
import { TrailAgentRow, type TrailAgentRowProps } from './TrailAgentRow';
import { WorkDoneRow, type WorkDoneRowProps } from './WorkDoneRow';
import { WorkRow, type WorkRowProps } from './WorkRow';

/** One line inside a card, from a layout row item, in layout's order. A done row that shares a line rides on its `done`. */
export type CardRow =
  | { kind: 'line'; id: string; props: AgentLineProps }
  | { kind: 'readers'; id: string; props: ReadersRowProps }
  | { kind: 'workDone'; id: string; props: WorkDoneRowProps }
  | { kind: 'work'; id: string; props: WorkRowProps }
  | { kind: 'trailAgent'; id: string; props: TrailAgentRowProps };

export interface NodeCardData extends Record<string, unknown> {
  node: TreeNode;
  folded: boolean;
  doneCount: number;
  progress: { done: number; total: number } | null;
  needsYou: boolean;
  /** How long a needs-you item has waited (needsYouAge), or null: its YOU tag reads "YOU · 3d". */
  age: string | null;
  hasChildren: boolean;
  /** On a working session's focus chain: an active marker pulses. */
  working: boolean;
  /** An active step nobody is on (LayoutNodeItem.paused): its marker draws hollow, with `lastChange` in its tooltip. */
  paused: boolean;
  /** When the step last changed, as relativeTime puts it ("3 d ago"). */
  lastChange: string;
  /**
   * Its place in the Up next queue, or null: its number in its owner's list (1 is next), and the owning session's slot,
   * or no owner when it is unowned.
   */
  queue: { pos: number; owner: { slot: number | null } | null } | null;
  resources: ResourceMeta[];
  flash: boolean;
  selected: boolean;
  /** Its flow x (LayoutNodeItem.x): the queue gutter sits at a fixed flow x, whatever the card's indent. */
  x: number;
  /** Its frame's width and height, from layout (LayoutNodeItem.w and .h). */
  w: number;
  h: number;
  /** A depth-1 phase (LayoutNodeItem.stack): an unframed stack head with a progress track. */
  stack: boolean;
  /** A working session's focus (LayoutNodeItem.workingFocus): the orange hairline, the active fill, the large title. */
  workingFocus: boolean;
  /** Its lines: agent and readers lines, a done row on a line of its own, task rows, trail rows. */
  rows: CardRow[];
  /** Opens Details, as a click on the card does. */
  onSelect: (id: number) => void;
  onToggleFold: (key: string, value: 'open' | 'closed') => void;
  onOpenResource: (id: number) => void;
}

function CardLine({ row }: { row: CardRow }) {
  switch (row.kind) {
    case 'line':
      return <AgentLine {...row.props} />;
    case 'readers':
      return <ReadersRow {...row.props} />;
    case 'workDone':
      return <WorkDoneRow {...row.props} />;
    case 'work':
      return <WorkRow {...row.props} />;
    case 'trailAgent':
      return <TrailAgentRow {...row.props} />;
  }
}

/**
 * A step: its frame, holding its header and then its lines. A depth-1 phase draws as an unframed stack head with its
 * progress track. The header is the tab stop and carries every state class; the frame draws the look. From 720 px the
 * first two resources sit beside the frame.
 */
export function NodeCard({ data }: NodeProps<Node<NodeCardData, 'ipNode'>>) {
  const { node, folded, doneCount, progress, needsYou, age, hasChildren, working, paused, lastChange, queue, resources, flash, selected, x, w, h, stack, workingFocus, rows } = data;
  // The type label shows as its glyph only; the word is the chip's tooltip and accessible name.
  const glyph = node.label ? LABEL_GLYPHS[node.label] : undefined;
  // A paused step keeps st-active (its stored status); `paused` only changes how its marker draws.
  const classes = ['ip-node', `st-${node.status}`, stack && 'stack', needsYou && 'needs-you', working && 'working', paused && 'paused', flash && 'flash', selected && 'selected', node.parentId === null && 'root']
    .filter(Boolean)
    .join(' ');
  const frame = ['ip-card', `st-${node.status}`, stack && 'stack', workingFocus && 'focus', flash && 'flash', selected && 'selected'].filter(Boolean).join(' ');
  const marker = (
    <Marker
      status={node.status}
      question={node.kind === 'question'}
      paused={paused}
      needsYou={needsYou}
      pulse={working}
      title={paused ? `Nobody is on this. Last change ${lastChange}` : undefined}
    />
  );
  return (
    <div className="ip-row" style={{ '--x': `${x}px` } as CSSProperties}>
      {/* Pinned at the header's middle, not the middle of a tall card. */}
      <Handle type="target" position={Position.Left} id="in" className="ip-handle" style={{ top: NODE_H / 2 }} />
      <div className={frame} style={{ width: w, height: h }}>
        {/* React Flow's own Enter/Space handling needs selectable nodes, so the header is the tab stop and handles them.
            Keys aimed at the fold chevron inside are the chevron's. */}
        <div
          className={classes}
          title={`#${node.id}`}
          role="button"
          tabIndex={0}
          onKeyDown={(e) => {
            if (e.target !== e.currentTarget || (e.key !== 'Enter' && e.key !== ' ')) return;
            e.preventDefault();
            data.onSelect(node.id);
          }}
        >
          {stack ? marker : <span className="ip-node-col">{marker}</span>}
          <span className="ip-title">
            {node.title}
            {folded ? ` · ${doneCount} done` : ''}
          </span>
          {node.label && glyph && (
            <span className={`ip-type l-${node.label}`} role="img" title={node.label} aria-label={node.label}>
              {glyph}
            </span>
          )}
          {/* In a narrow window (styles.css) the resource chips beside the card give way to this one count, which opens
              Details, where every resource is listed. */}
          {resources.length > 0 && (
            <button
              className="ip-res-count"
              title={resources.map((r) => `r${r.id} ${r.title}`).join('\n')}
              aria-label={`${resources.length} ${resources.length === 1 ? 'resource' : 'resources'}`}
              onClick={(e) => {
                e.stopPropagation();
                data.onSelect(node.id);
              }}
            >
              ▤ {resources.length}
            </button>
          )}
          {/* In the gutter left of the card (styles.css). An owned place wears its session's letter and hue (A①); an
              unowned one stays a neutral numeral (①). */}
          {queue && (
            <span
              className={`ip-queue${queue.owner ? ' owned' : ''}`}
              style={queue.owner ? ({ '--fam': familyVar(queue.owner.slot) } as CSSProperties) : undefined}
              title={queue.owner ? `Up next for ${ownerTag(queue.owner.slot)}: ${queue.pos}` : `Up next, later: ${queue.pos}`}
            >
              {queue.owner ? (
                <>
                  <span>{ownerTag(queue.owner.slot)}</span>
                  <span>{circled(queue.pos)}</span>
                </>
              ) : (
                circled(queue.pos)
              )}
            </span>
          )}
          {needsYou && <span className="ip-you">{age ? `YOU · ${age}` : 'YOU'}</span>}
          {node.status === 'blocked' && <span className="ip-blocked">blocked</span>}
          {progress && (
            <span className="ip-progress">
              {progress.done}/{progress.total}
            </span>
          )}
          {hasChildren && (
            <button
              className="ip-chevron"
              aria-label={folded ? 'Unfold' : 'Fold'}
              onClick={(e) => {
                e.stopPropagation();
                data.onToggleFold(`n:${node.id}`, folded ? 'open' : 'closed');
              }}
            >
              {folded ? '▸' : '▾'}
            </button>
          )}
        </div>
        {stack && progress && (
          <div className="ip-track">
            <div className="ip-track-fill" style={{ width: `${(progress.done / progress.total) * 100}%` }} />
          </div>
        )}
        {rows.length > 0 && (
          <div className="ip-lines">
            {rows.map((row) => (
              <CardLine key={row.id} row={row} />
            ))}
          </div>
        )}
      </div>
      {resources.slice(0, 2).map((r) => (
        <button
          key={r.id}
          className="ip-chip"
          title={`r${r.id} ${r.title}`}
          onClick={(e) => {
            e.stopPropagation();
            data.onOpenResource(r.id);
          }}
        >
          ▤ {r.title}
        </button>
      ))}
      {resources.length > 2 && <span className="ip-chip">+{resources.length - 2}</span>}
      {/* At the frame's bottom, 18 px in: the rail to the children runs 10 px left of them. */}
      <Handle type="source" position={Position.Bottom} id="out" className="ip-handle" style={{ left: 18 }} />
    </div>
  );
}
```

- [ ] **Step 12: Canvas imports and node types**

In `web/src/canvas/Canvas.tsx`, replace lines 1-48 (the imports through the closing `};` of `nodeTypes`) with:

```tsx
import {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type FocusEvent as ReactFocusEvent,
  type MouseEvent as ReactMouseEvent,
} from 'react';
import { Controls, ReactFlow, useReactFlow, type Edge, type Node, type NodeChange, type Viewport } from '@xyflow/react';
import { layoutOutline, type LayoutItem } from '../../../src/core/layout';
import { buildIndex, needsYouAge, type FoldOverrides } from '../../../src/core/tree';
import { sessionDisplayTitle, sessionTag, type EventRow, type ProjectSnapshot } from '../../../src/core/types';
import { taskFamily, taskOwner, waitsFor, withTag } from '../live';
import { relativeTime } from '../time';
import { useNow } from '../useNow';
import { breadcrumbFor } from './breadcrumb';
import { LaneNode } from './LaneNode';
import { MoreNode, type MoreNodeData } from './MoreNode';
import { NodeCard, type CardRow, type NodeCardData } from './NodeCard';
import { PITCH } from './pitch';
import { visibleHeight } from './sheet';
import { useCamera } from './useCamera';
import type { WorkDoneRowProps } from './WorkDoneRow';

/** How many frames a newly shown card gets to appear before focus stops waiting for it. */
const FOCUS_FRAMES = 30;
/**
 * How often time-based labels ("12 min", a kin's "18m", "done 2 min ago") catch up, and with them the 5-minute grey
 * kin of an ended subagent, which then moves into its step's trail.
 */
const CLOCK_MS = 30_000;

/** A step is one node with its lines inside it. Fold rows and lanes are nodes of their own. */
const nodeTypes = {
  ipNode: NodeCard,
  ipMore: MoreNode,
  ipLane: LaneNode,
};
```

Then replace the comment at lines 98-101 (`// React Flow 12.12 keeps a node hidden …` to `… can't keep focus.`) with:

```tsx
  // React Flow 12.12 keeps a node hidden until the node object passed in carries a size, and the nodes below are new
  // objects on every snapshot, flash, selection and clock tick. Cards and lanes carry layout's size. Fold rows are
  // measured: keep the sizes React Flow reports and pass them back, so they stay measured across rebuilds and never
  // blink out (ruling 1).
```

- [ ] **Step 13: Canvas groups each card's rows into the card**

Replace lines 131-222 of `web/src/canvas/Canvas.tsx` (from `const nodes = useMemo<Node[]>(() => {` to its closing
`}, [layout, index, snapshot, now, flash, selectedNode, onSelectNode, onToggleFold, onOpenResource, expandRun, sizes]);`)
with:

```tsx
  const nodes = useMemo<Node[]>(() => {
    const resourcesById = new Map(snapshot.resources.map((r) => [r.id, r]));
    const sessionsById = new Map(snapshot.sessions.map((s) => [s.id, s]));
    const workById = new Map(snapshot.workItems.map((w) => [w.id, w]));
    const { pastSessions, trailAgents } = snapshot;

    /** A row item as its card draws it, or null when what it stands for has left the snapshot. */
    const toRow = (item: LayoutItem): CardRow | null => {
      switch (item.kind) {
        case 'line': {
          const session = sessionsById.get(item.sessionId);
          if (!session) return null;
          const agents = item.agentIds.flatMap((id) => session.subagents.find((a) => a.agentId === id) ?? []);
          return { kind: 'line', id: item.id, props: { session, nodeId: item.nodeId, lead: item.lead, agents, now, done: null } };
        }
        case 'readers': {
          const session = sessionsById.get(item.sessionId);
          const readers = session ? session.subagents.filter((a) => item.agentIds.includes(a.agentId)) : [];
          if (!session || !readers.length) return null;
          return { kind: 'readers', id: item.id, props: { readers, slot: session.slot, nodeId: item.nodeId, done: null } };
        }
        case 'work': {
          const w = workById.get(item.workId);
          if (!w) return null;
          // A trail row is neutral: no hue, no tag, no letter (its session's slot may be a live session's by now).
          const family = item.stale ? null : taskFamily(w, snapshot.sessions, trailAgents);
          const owner = taskOwner(w, snapshot.sessions, pastSessions, trailAgents);
          return {
            kind: 'work',
            id: item.id,
            props: {
              item: w,
              pulse: item.pulse,
              stale: item.stale,
              family,
              // A live row's tooltip names its session's letter, or its subagent's tag.
              owner: family ? withTag(w.agentId ? family.tag : sessionTag(family.slot), owner) : owner,
              waits: waitsFor(w, snapshot.workItems),
            },
          };
        }
        case 'trailAgent': {
          const agent = trailAgents.find((a) => a.sessionId === item.sessionId && a.agentId === item.agentId);
          if (!agent) return null;
          const session = sessionsById.get(item.sessionId) ?? pastSessions.find((s) => s.id === item.sessionId);
          return { kind: 'trailAgent', id: item.id, props: { agent, nodeId: item.nodeId, sessionTitle: session ? sessionDisplayTitle(session) : 'a session', now } };
        }
        default:
          return null;
      }
    };

    // Each card's lines, in layout's order. A done row that shares a line rides at that line's right end: layout gave it
    // that line's y and no height of its own.
    const rowsByNode = new Map<number, CardRow[]>();
    for (const item of layout.items) {
      if (item.kind === 'node' || item.kind === 'more') continue;
      const rows = rowsByNode.get(item.nodeId) ?? [];
      rowsByNode.set(item.nodeId, rows);
      if (item.kind === 'workDone') {
        const done: WorkDoneRowProps = { nodeId: item.nodeId, count: item.count, unfinished: item.unfinished, agents: item.agents, open: item.open, onToggleFold };
        const last = rows[rows.length - 1];
        if (item.shared && (last?.kind === 'line' || last?.kind === 'readers')) last.props.done = done;
        else rows.push({ kind: 'workDone', id: item.id, props: done });
        continue;
      }
      const row = toRow(item);
      if (row) rows.push(row);
    }

    const cards = layout.items.flatMap((item): Node[] => {
      const position = { x: item.x, y: item.y };
      if (item.kind === 'more') {
        const data: MoreNodeData = {
          count: item.hiddenIds.length,
          variant: item.variant,
          foldKey: `${item.variant === 'done' ? 'done' : 'more'}:${item.parentId}`,
          firstId: item.hiddenIds[0],
          onExpand: expandRun,
        };
        return [{ id: item.id, position, measured: sizes[item.id], draggable: false, selectable: false, type: 'ipMore', data }];
      }
      if (item.kind !== 'node') return [];
      const node = index.byId.get(item.nodeId)!;
      const data: NodeCardData = {
        node,
        folded: item.folded,
        doneCount: item.doneCount,
        progress: item.progress,
        needsYou: item.needsYou,
        // Both age with the clock, which only Canvas holds.
        age: item.needsYou ? needsYouAge(node, now) : null,
        hasChildren: item.hasChildren,
        working: item.working,
        paused: item.paused,
        lastChange: relativeTime(node.updatedAt, now),
        // An owned place takes its session's slot, for the letter and hue it wears.
        queue: item.queue && { pos: item.queue.pos, owner: item.queue.sessionId === null ? null : { slot: sessionsById.get(item.queue.sessionId)?.slot ?? null } },
        resources: item.resourceIds.map((id) => resourcesById.get(id)).filter((r): r is NonNullable<typeof r> => !!r),
        flash: flash === item.nodeId,
        selected: selectedNode === item.nodeId,
        x: item.x,
        w: item.w,
        h: item.h,
        stack: item.stack,
        workingFocus: item.workingFocus,
        rows: rowsByNode.get(item.nodeId) ?? [],
        onSelect: onSelectNode,
        onToggleFold,
        onOpenResource,
      };
      // Layout's size: React Flow shows the card without waiting to measure it, and the frame is as tall as layout
      // spaced it.
      return [{ id: item.id, position, width: item.w, height: item.h, draggable: false, selectable: false, type: 'ipNode', data }];
    });

    // Lanes first, and below everything, edges included. React Flow writes pointer-events: all on every node while the
    // flow has an onNodeClick, then spreads node.style over it: only the style lets clicks, pans and wheel ticks through.
    const lanes = layout.lanes.map(
      (lane): Node => ({
        id: lane.id,
        type: 'ipLane',
        position: { x: lane.x, y: lane.y },
        width: lane.w,
        height: lane.h,
        zIndex: -1,
        draggable: false,
        selectable: false,
        focusable: false,
        style: { pointerEvents: 'none' },
        data: {},
      }),
    );
    return [...lanes, ...cards];
  }, [layout, index, snapshot, now, flash, selectedNode, onSelectNode, onToggleFold, onOpenResource, expandRun, sizes]);
```

- [ ] **Step 14: Canvas edges, keyboard focus, the first move and the chrome**

Replace the `edges` memo, lines 224-240 of `web/src/canvas/Canvas.tsx`, with:

```tsx
  const edges = useMemo<Edge[]>(
    () =>
      layout.edges.map((e) => ({
        id: e.id,
        source: e.source,
        target: e.target,
        sourceHandle: 'out',
        targetHandle: 'in',
        type: 'step',
        // The source handle sits 18 px in and children indent 28 px: an offset of 10 keeps the rail 10 px left of them.
        pathOptions: { offset: 10 },
        selectable: false,
        focusable: false,
        style: { stroke: 'var(--border)', strokeWidth: 1 },
      })),
    [layout.edges],
  );
```

In `onFocus`, replace lines 324-325:

```tsx
      const p = rf.screenToFlowPosition({ x: left + r.width / 2, y: top + r.height / 2 });
      camera.centerOnPoint(p.x, p.y);
```

with:

```tsx
      // Only its height counts: the camera keeps flow x 0 at the canvas's left edge.
      const p = rf.screenToFlowPosition({ x: left + r.width / 2, y: top + r.height / 2 });
      camera.centerOnY(p.y);
```

Replace lines 330-342 (`onInit` and the cleanup effect) with:

```tsx
  // The first move waits for the bundled fonts, so it never runs on fallback metrics. A promise can't be cancelled:
  // skip the move once the canvas has gone, or once the camera has moved already (a Home pressed meanwhile, say).
  const alive = useRef(true);
  const onInit = useCallback(() => {
    void document.fonts.ready.then(() => {
      if (!alive.current || camera.hasMoved()) return;
      initFrame.current = requestAnimationFrame(() => {
        if (!camera.hasMoved()) camera.centerOnFrontier(0, 1);
      });
    });
  }, [camera]);

  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
      cancelAnimationFrame(initFrame.current);
      cancelAnimationFrame(flashFrame.current);
      cancelAnimationFrame(focusFrame.current);
      window.clearTimeout(flashTimer.current);
    };
  }, []);
```

`alive.current = true` in the effect body matters: React's StrictMode (`main.tsx`) mounts, unmounts and mounts again in
development, and a ref set false by the first cleanup would otherwise stay false.

Replace the returned JSX, lines 344-370, with:

```tsx
  return (
    // Layout's pitch, written once: the canvas rules read it for every fixed height.
    <div className="ip-canvas" ref={root} onFocus={onFocus} style={PITCH as CSSProperties}>
      {crumb.length > 0 && <div className="ip-crumb">{crumb.join(' › ')}</div>}
      <ReactFlow
        nodes={nodes}
        edges={edges}
        nodeTypes={nodeTypes}
        onNodesChange={onNodesChange}
        onInit={onInit}
        onNodeClick={onNodeClick}
        onMoveStart={onMoveStart}
        onMove={onMove}
        minZoom={0.15}
        maxZoom={2}
        panOnScroll
        nodesDraggable={false}
        nodesConnectable={false}
        nodesFocusable={false}
        elementsSelectable={false}
        colorMode="system"
        proOptions={{ hideAttribution: true }}
      >
        <Controls position="top-right" orientation="horizontal" showInteractive={false} onZoomIn={manualMove} onZoomOut={manualMove} onFitView={manualMove} />
      </ReactFlow>
    </div>
  );
```

- [ ] **Step 15: The camera holds flow x 0 at the canvas's left edge**

In `web/src/canvas/useCamera.ts`, delete lines 19-20:

```ts
/** Horizontal offset so the card, not its left edge, sits in the middle of the view. */
const CARD_CENTER_X = 140;
```

Replace `moveTo`, lines 54-65:

```ts
  /**
   * Every camera move goes through here. With the Details sheet open, the point sits a quarter of the way down, above
   * the sheet. Under reduced motion the move is instant.
   */
  const moveTo = useCallback(
    (x: number, y: number, duration: number, zoom = rf.getZoom()) => {
      const glide = window.matchMedia(REDUCED_MOTION).matches ? 0 : duration;
      void rf.setCenter(x, sheetOpen() ? y + store.getState().height / 4 / zoom : y, { zoom, duration: glide });
      lastMove.current = Date.now();
    },
    [rf, store, sheetOpen],
  );
```

with:

```ts
  /**
   * Every camera move goes through here, to a flow height. Flow x 0 stays at the canvas's left edge, so cards that run
   * to x 506 are never cut and the lanes stay left of the Details side panel. With the Details sheet open, the point
   * sits a quarter of the way down, above the sheet. Under reduced motion the move is instant.
   */
  const moveTo = useCallback(
    (y: number, duration: number, zoom = rf.getZoom()) => {
      const glide = window.matchMedia(REDUCED_MOTION).matches ? 0 : duration;
      const { width, height } = store.getState();
      void rf.setCenter(width / 2 / zoom, sheetOpen() ? y + height / 4 / zoom : y, { zoom, duration: glide });
      lastMove.current = Date.now();
    },
    [rf, store, sheetOpen],
  );
```

At line 71, replace `moveTo(item.x + CARD_CENTER_X, item.y + NODE_H / 2, duration);` with
`moveTo(item.y + NODE_H / 2, duration);`.

Replace lines 95-96:

```ts
  /** Brings a flow point to the middle at once, for keyboard focus that lands outside the view. */
  const centerOnPoint = useCallback((x: number, y: number) => moveTo(x, y, 0), [moveTo]);
```

with:

```ts
  /** Brings a flow height to the middle at once, for keyboard focus that lands outside the view. */
  const centerOnY = useCallback((y: number) => moveTo(y, 0), [moveTo]);

  /** Whether any camera move has run yet: the first move, held for the fonts, gives way to one that came first. */
  const hasMoved = useCallback(() => lastMove.current !== 0, []);
```

At line 103, replace `if (item) moveTo(item.x + CARD_CENTER_X, item.y + NODE_H / 2, duration, zoom);` with
`if (item) moveTo(item.y + NODE_H / 2, duration, zoom);`.

Replace the return, lines 145-148:

```ts
  return useMemo(
    () => ({ centerOn, centerOnPoint, centerOnFrontier, focusNode, nextNeedsYou, sheetOpen }),
    [centerOn, centerOnPoint, centerOnFrontier, focusNode, nextNeedsYou, sheetOpen],
  );
```

with:

```ts
  return useMemo(
    () => ({ centerOn, centerOnY, centerOnFrontier, focusNode, hasMoved, nextNeedsYou, sheetOpen }),
    [centerOn, centerOnY, centerOnFrontier, focusNode, hasMoved, nextNeedsYou, sheetOpen],
  );
```

- [ ] **Step 16: Typecheck and unit tests**

```bash
cd /c/personal/InProgress/.claude/worktrees/quiet-t6
npm run typecheck && npm test
grep -rnE "BadgeNode|AgentBadge|ipBadge|ipAgent\b|ipReaders|ipWork|ipTrailAgent|centerOnPoint|CARD_CENTER_X|BADGE_ROW|WORK_ROW|WORK_GAP|READERS_ROW|Background" web/src src
```

Expected: both `tsc` runs print nothing and exit 0. Vitest reports every test file passed, `test/web/pitch.test.ts`
among them. The `grep` prints nothing.

If `tsc -p web/tsconfig.json` reports `Property 'done' does not exist` on `last.props`, the narrowing in Step 13 was
copied without the `last?.kind === 'line' || last?.kind === 'readers'` guard: restore it.

- [ ] **Step 17: Commit the cards**

```bash
git -C /c/personal/InProgress/.claude/worktrees/quiet-t6 add web/src/canvas
git -C /c/personal/InProgress/.claude/worktrees/quiet-t6 status --short
git -C /c/personal/InProgress/.claude/worktrees/quiet-t6 commit -m "Cards draw their own lines: frame, header, stack heads, lanes, gutter, edges and a left-anchored camera (#81)" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

Expected: `status` lists `A  web/src/canvas/AgentLine.tsx`, `A  web/src/canvas/LaneNode.tsx`,
`D  web/src/canvas/AgentBadge.tsx`, `D  web/src/canvas/BadgeNode.tsx` and `M` for `Canvas.tsx`, `NodeCard.tsx`,
`ReadersRow.tsx`, `TrailAgentRow.tsx`, `WorkDoneRow.tsx`, `WorkRow.tsx` and `useCamera.ts`. The commit reports
`11 files changed`.

- [ ] **Step 18: e2e helpers, and the checklist test (T1086)**

In `test/e2e/ui.spec.ts`, after the line `const RUNNING = '(<1 min|\\d+ min)';` (l.1083), add:

```ts

/** A running kin's run time on the canvas (runTime): under a minute, or whole minutes. */
const RUN_TIME = '(<1m|\\d+m)';

/** A card's frame: the `.ip-card` around its header (`.ip-node`) and its lines. */
const frameOf = (header: Locator) => header.locator('xpath=..');

type Box = { x: number; y: number; width: number; height: number };

/** The box lies inside the frame's box, give or take half a pixel of rounding. */
function expectInside(box: Box, frame: Box, what = 'inside the frame'): void {
  expect(box.x, what).toBeGreaterThanOrEqual(frame.x - 0.5);
  expect(box.y, what).toBeGreaterThanOrEqual(frame.y - 0.5);
  expect(box.x + box.width, what).toBeLessThanOrEqual(frame.x + frame.width + 0.5);
  expect(box.y + box.height, what).toBeLessThanOrEqual(frame.y + frame.height + 0.5);
}
```

In T1086 (`working tasks sit under their node as a checklist …`), replace l.1106:

```ts
    // Under the card and one level in: the done row, then the open tasks in the order they were created.
```

with:

```ts
    // Inside the card, under its header: the done row at the end of the session's line, then the open tasks in order.
```

and replace l.1112-1113:

```ts
    for (const box of [doneBox, uploadBox, checkBox]) expect(box.x).toBeGreaterThan(cardBox.x + 20);
    expect(uploadBox.height, 'a compact row').toBeLessThanOrEqual(20);
```

with:

```ts
    const frameBox = await boxOf(frameOf(card));
    for (const box of [doneBox, uploadBox, checkBox]) expectInside(box, frameBox);
    expect(uploadBox.height, 'a compact row').toBeLessThanOrEqual(22);
```

Run:

```bash
cd /c/personal/InProgress/.claude/worktrees/quiet-t6 && npm run build && INPROGRESS_E2E_PORT=4396 npx playwright test -g "working tasks sit under their node"
```

Expected: `Built into …/.build`, then `1 passed`.

- [ ] **Step 19: The subagent test (T1142): kin on their session's line**

In T1142 (`each subagent has a badge under its node in its session's hue …`), replace everything from its line
`const wire = page.locator('.ip-agent', { hasText: 'Wire up RevenueCat' });` (l.1151) through
`await expect(review).not.toHaveClass(/\bended\b/);` (l.1200) with:

```ts
    const wire = page.getByRole('img', { name: /^a1 · Wire up RevenueCat/ });
    const review = page.getByRole('img', { name: /^a2 · Review the signing config/ });
    // A kin shows its tag and its run time; its name and tooltip carry its description, model and elapsed time.
    await expect(wire).toHaveText(new RegExp(`^a1${RUN_TIME}$`));
    await expect(wire).toHaveAccessibleName(new RegExp(`^a1 · Wire up RevenueCat · sonnet · ${RUNNING}$`));
    await expect(review).toHaveText(new RegExp(`^a2${RUN_TIME}$`));
    await expect(review).toHaveAccessibleName(new RegExp(`^a2 · Review the signing config · haiku · ${RUNNING}$`));
    const revenueHeader = page.locator('.ip-node', { hasText: '3 RevenueCat' });
    const [revenue, build, play, own, run, wireBox, reviewBox, revenueFrame] = await Promise.all(
      [
        revenueHeader,
        page.locator('.ip-node', { hasText: '4 Build to GitHub' }),
        page.locator('.ip-node', { hasText: 'Play app signing' }),
        page.locator('.ip-badge', { hasText: 'E2E session' }),
        page.locator('.ip-node', { hasText: 'Run signing tests' }),
        wire,
        review,
        frameOf(revenueHeader),
      ].map(boxOf),
    );
    // One inside 3 RevenueCat's frame, under its header; the other a kin on the session's own line, on its focus.
    expect(wireBox.y).toBeGreaterThanOrEqual(revenue.y + revenue.height);
    expect(build.y).toBeGreaterThanOrEqual(wireBox.y + wireBox.height);
    expectInside(wireBox, revenueFrame);
    expect(own.y).toBeGreaterThanOrEqual(play.y + play.height);
    expectInside(reviewBox, own, "on the session's line");
    expect(run.y).toBeGreaterThanOrEqual(reviewBox.y + reviewBox.height);
    const tiers = page.locator('.ip-work', { hasText: 'Compare the tiers' });
    const upload = page.locator('.ip-work', { hasText: 'Upload the key' });
    // A subagent's task carries its tag in the card's left column and no bar; the session's own carries the bar.
    await expect(tiers.locator('.ip-work-agent')).toHaveCount(0);
    await expect(tiers.locator('.ip-work-tag')).toHaveText('a1');
    await expect(upload.locator('.ip-work-agent')).toBeVisible();
    await expect(upload.locator('.ip-work-tag')).toHaveCount(0);
    // One family, one hue: the session's letter, both kin's tags, the subagent's task tag and the session's task bar.
    const colours = await page.evaluate<Record<string, string>>(`(() => {
      const find = (sel, text) => [...document.querySelectorAll(sel)].find((n) => n.textContent.includes(text));
      const kin = (tag) => document.querySelector('.ip-agent[aria-label^="' + tag + ' · "]');
      const color = (n) => getComputedStyle(n).color;
      return {
        own: color(find('.ip-badge', 'E2E session').querySelector('.ip-badge-label .ip-tag')),
        wire: color(kin('a1').querySelector('.ip-agent-tag')),
        review: color(kin('a2').querySelector('.ip-agent-tag')),
        tag: color(find('.ip-work', 'Compare the tiers').querySelector('.ip-work-tag')),
        ownMarker: getComputedStyle(find('.ip-work', 'Upload the key').querySelector('.ip-work-agent')).backgroundColor,
      };
    })()`);
    expect(colours.own).toBe('rgb(11, 107, 125)');
    for (const part of ['wire', 'review', 'tag', 'ownMarker']) expect(colours[part], part).toBe(colours.own);
    await hook(api, fresh.session, { event: 'subagent-stop', agentId: 'agent-1' });
    // Stopped, it keeps its tag, loses its time and goes grey; its name says when it finished.
    await expect(wire).toHaveText('a1');
    await expect(wire).toHaveAccessibleName('a1 · Wire up RevenueCat · sonnet · done just now');
    await expect(wire).toHaveClass(/\bended\b/);
    await expect(wire).toHaveCSS('color', 'rgb(71, 85, 105)');
    await expect(review).not.toHaveClass(/\bended\b/);
```

Run: `cd /c/personal/InProgress/.claude/worktrees/quiet-t6 && INPROGRESS_E2E_PORT=4396 npx playwright test -g "each subagent has a badge under its node"`

Expected: `1 passed`.

- [ ] **Step 20: The readers test (T1203): the kin's tooltip and the readers' letter**

In T1203 (`a worker's badge says what it was asked to do …`), replace l.1211-1213:

```ts
    const wire = page.locator('.ip-agent', { hasText: 'Wire up RevenueCat' });
    const readers = page.locator('.ip-readers');
    await expect(wire).toHaveAttribute('title', purpose);
```

with:

```ts
    const wire = page.getByRole('img', { name: /^a1 · Wire up RevenueCat/ });
    const readers = page.locator('.ip-readers');
    // A kin's tooltip is its line, then what it was asked to do.
    await expect(wire).toHaveAttribute('title', new RegExp(`^a1 · Wire up RevenueCat · sonnet · ${RUNNING}\\nWire the paywall to RevenueCat and report the tiers\\.$`));
```

and replace l.1225, as Task 1 left it:

```ts
    await expect(readers).toHaveCSS('color', 'rgb(11, 107, 125)');
```

with:

```ts
    await expect(readers.locator('.ip-tag')).toHaveCSS('color', 'rgb(11, 107, 125)');
```

Leave l.1226-1232 (the chip and its list) to Task 4.

Run: `cd /c/personal/InProgress/.claude/worktrees/quiet-t6 && INPROGRESS_E2E_PORT=4396 npx playwright test -g "badge says what it was asked to do"`

Expected: `1 passed`.

- [ ] **Step 21: The two-session test (T1380): line names, B's kin, and their hues**

In T1380 (`two sessions in a project show A and B in different hues …`), replace l.1394-1398:

```ts
    await expect(page.locator('.ip-badge', { hasText: 'E2E session' })).toHaveText('◆ A · E2E session · working');
    await expect(page.locator('.ip-badge', { hasText: 'Second session' })).toHaveText('◆ B · Second session · working · 1 subagent');
    // B's subagent leads with b1, and so does its task.
    const agent = page.locator('.ip-agent', { hasText: 'Price the tiers' });
    await expect(agent).toHaveText(new RegExp(`^b1 · Price the tiers · sonnet · ${RUNNING}$`));
```

with:

```ts
    // Each agent line's name leads with its letter: no ◆, no count.
    await expect(page.locator('.ip-badge', { hasText: 'E2E session' })).toHaveAccessibleName('A · E2E session · working');
    await expect(page.locator('.ip-badge', { hasText: 'Second session' })).toHaveAccessibleName('B · Second session · working');
    // B's subagent is a kin led by b1, and so is its task.
    const agent = page.getByRole('img', { name: /^b1 · Price the tiers/ });
    await expect(agent).toHaveText(new RegExp(`^b1${RUN_TIME}$`));
    await expect(agent).toHaveAccessibleName(new RegExp(`^b1 · Price the tiers · sonnet · ${RUNNING}$`));
```

Replace l.1400-1406:

```ts
    // Under the step it names, one level in, before the next step.
    const [revenue, build, agentBox] = await Promise.all(
      [page.locator('.ip-node', { hasText: '3 RevenueCat' }), page.locator('.ip-node', { hasText: '4 Build to GitHub' }), agent].map(boxOf),
    );
    expect(agentBox.y).toBeGreaterThanOrEqual(revenue.y + revenue.height);
    expect(build.y).toBeGreaterThanOrEqual(agentBox.y + agentBox.height);
    expect(agentBox.x).toBeGreaterThan(revenue.x + 20);
```

with:

```ts
    // Inside the step it names, under its header, before the next step.
    const revenueHeader = page.locator('.ip-node', { hasText: '3 RevenueCat' });
    const [revenue, build, agentBox, revenueFrame] = await Promise.all(
      [revenueHeader, page.locator('.ip-node', { hasText: '4 Build to GitHub' }), agent, frameOf(revenueHeader)].map(boxOf),
    );
    expect(agentBox.y).toBeGreaterThanOrEqual(revenue.y + revenue.height);
    expect(build.y).toBeGreaterThanOrEqual(agentBox.y + agentBox.height);
    expectInside(agentBox, revenueFrame);
```

In the `hues` object, replace l.1414:

```ts
        badgeA: bg(find('.ip-badge', 'E2E session')),
```

with:

```ts
        badgeA: getComputedStyle(find('.ip-badge', 'E2E session').querySelector('.ip-badge-label .ip-tag')).color,
```

and replace l.1416-1418:

```ts
        badgeB: bg(find('.ip-badge', 'Second session')),
        agentB: bg(find('.ip-agent', 'Price the tiers')),
        markerB: bg(row.querySelector('.ip-work-agent')),
```

with:

```ts
        badgeB: getComputedStyle(find('.ip-badge', 'Second session').querySelector('.ip-badge-label .ip-tag')).color,
        agentB: getComputedStyle(document.querySelector('.ip-agent[aria-label^="b1 · "] .ip-agent-tag')).color,
```

A subagent's task row has no bar any more (T1142 checks that), so `markerB` goes. Replace l.1426:

```ts
    for (const part of ['badgeB', 'agentB', 'markerB', 'tagB']) expect(hues[part], part).toBe(hues.chipB);
```

with:

```ts
    for (const part of ['badgeB', 'agentB', 'tagB']) expect(hues[part], part).toBe(hues.chipB);
```

Leave l.1388-1393, l.1413, l.1415 and l.1422 (the chips) to Task 4. On this branch the chips are still today's
markup with Task 1's colours, so `chipA` and `chipB` read the working chips' fills, which are the family hues the
letters wear.

Run: `cd /c/personal/InProgress/.claude/worktrees/quiet-t6 && INPROGRESS_E2E_PORT=4396 npx playwright test -g "show A and B in different hues"`

Expected: `1 passed`.

- [ ] **Step 22: The done folds (T392), the gutter (T1294), the trail (T1445) and the night canvas (T284)**

In T392, replace l.416:

```ts
  await expect(page.locator('.ip-node', { hasText: /^Milestone 1$/ })).toHaveCount(0);
```

with:

```ts
  // A done card's header reads "✓Milestone 1": anchor on the title, or this would pass even if the run never folded.
  await expect(page.locator('.ip-node .ip-title', { hasText: /^Milestone 1$/ })).toHaveCount(0);
```

In T1294, after l.1313 (`await expect(marker('6 Beta')).toHaveText('B①');`), add:

```ts
    // The numeral sits in the gutter, left of its card's header.
    const [aMark, aCard] = await Promise.all([marker('3 RevenueCat'), page.locator('.ip-node', { hasText: '3 RevenueCat' })].map(boxOf));
    expect(aMark.x + aMark.width).toBeLessThanOrEqual(aCard.x);
```

In T1445, replace l.1470:

```ts
    expect(rowBox.x).toBeGreaterThan(cardBox.x + 20);
```

with:

```ts
    expectInside(rowBox, await boxOf(frameOf(card)));
```

In T284, replace l.294-295:

```ts
  await expect(flashed).toHaveCSS('animation-name', 'none');
  await expect(flashed).not.toHaveCSS('box-shadow', 'none');
```

with:

```ts
  // The frame draws the flash: under reduced motion, a static amber ring.
  await expect(frameOf(flashed)).toHaveCSS('animation-name', 'none');
  await expect(frameOf(flashed)).not.toHaveCSS('box-shadow', 'none');
  // No dot grid, so the night ground is --bg itself.
  await expect(page.locator('.react-flow__background')).toHaveCount(0);
```

Then, near the end of the same test, after Task 1's line:

```ts
  await expect.poll(() => page.evaluate<string[]>(loadedFaces)).toContain('Inter');
```

add:

```ts
  // The canvas's counts, tags and times bring DM Mono in.
  await expect.poll(() => page.evaluate<string[]>(loadedFaces)).toContain('DM Mono');
```

It reuses Task 1's `loadedFaces` (a face counts only once its status is `loaded`). Do not declare a second
`loadedFaces`: the test already has one, and a second `const` of that name in the same function does not compile.

Leave l.288 (the chip's motion) to Task 4, and Task 1's ground, `Inter` and font-request checks as they are.

Run:

```bash
cd /c/personal/InProgress/.claude/worktrees/quiet-t6 && INPROGRESS_E2E_PORT=4396 npx playwright test -g "no minimap|their own Up next order|stay on their steps as a trail row|dark mode reaches the canvas controls"
```

Expected: `4 passed`.

- [ ] **Step 23: The whole e2e suite**

```bash
cd /c/personal/InProgress/.claude/worktrees/quiet-t6 && INPROGRESS_E2E_PORT=4396 npm run test:e2e
```

Expected: `50 passed`, 0 failed. These hold without edits and guard the camera, Follow, the keyboard and the blink:
T167 (its `.ip-badge` with `E2E session` is now the agent line), T178, T192, T301, T317, T347, T356, T377, T465 (the
paused marker now sits on the `Milestones` stack head), T510 to T630 (`expectLifted` measures the 30 px header,
centred on `item.y + 16`), T635, T657, T673, T716, T736, T761, T909 (the resource chips beside the frame at 1000 px)
and T1259. A failure in one of them is a Task 6 bug: fix the code, not the test.

- [ ] **Step 24: Commit the e2e**

```bash
git -C /c/personal/InProgress/.claude/worktrees/quiet-t6 add test/e2e/ui.spec.ts
git -C /c/personal/InProgress/.claude/worktrees/quiet-t6 commit -m "e2e: kin, frames, the gutter and the night canvas in Quiet cards (#81)" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

Expected: `1 file changed`.

### Task 6b: Characters on the agent line

Size S to M. Runs right after 6a, in the same worktree and branch.

**Files:**
- Modify: `web/src/canvas/AgentLine.tsx` (imports, `Kin`, `AgentLine`, as 6a left them)
- Modify: `web/src/styles.css`, canvas region (two rules after `.ip-badge > .ip-tag { flex: none; }`)
- Test: `test/e2e/ui.spec.ts`: T1142's `colours` block, T1380's `hues` block (l.1417-1418 and l.1426 as 6a left
  them), and the new canvas test at the end of the `Live work` block

**Interfaces:**
- Consumes, from Task 2: `Character` and `CharacterProps` (`web/src/Character.tsx`, imported as
  `'../Character'`), `characterState` (`web/src/characterState.ts`, imported as `'../characterState'`), the
  `.ip-char`, `.c-<state>`, `[data-state]`,
  `.ip-char-body`, `g.ip-char-eyes` hooks and the `ip-bob` and `ip-blink` keyframes in `character.css`. From Task 3
  part A: `leadTitle`. From 6a: `AgentLine`, `RUN_TIME`, `frameOf`, `expectInside`.
- Produces: the lead `span.ip-char` as a direct child of `.ip-badge` (`title` = `leadTitle(s)`), a kin's
  `span.ip-char` as the first child of `.ip-agent`, and the e2e test `a step's agents and tasks sit inside its card:
  one line per session with its character and kin, the done row at the line's end, a lane per phase`.

- [ ] **Step 1: Put the characters on the line**

In `web/src/canvas/AgentLine.tsx`, replace the imports:

```tsx
import type { CSSProperties } from 'react';
import { agentTag, sessionDisplayTitle, sessionTag, type Session, type SubagentInfo } from '../../../src/core/types';
import { familyVar } from '../family';
import { WORDS, agentLine, kinTitle, runTime, withTag } from '../live';
import { WorkDoneRow, type WorkDoneRowProps } from './WorkDoneRow';
```

with:

```tsx
import type { CSSProperties } from 'react';
import { agentTag, sessionDisplayTitle, sessionTag, type Session, type SubagentInfo } from '../../../src/core/types';
import { Character } from '../Character';
import { characterState } from '../characterState';
import { familyVar } from '../family';
import { WORDS, agentLine, kinTitle, leadTitle, runTime, withTag } from '../live';
import { WorkDoneRow, type WorkDoneRowProps } from './WorkDoneRow';
```

Replace the `Kin` component:

```tsx
/** One shown worker: its tag and, while it runs, its run time. Its name and tooltip carry the rest, then its purpose. */
function Kin({ agent, session, nodeId, now }: KinProps) {
  const tag = agentTag(session.slot, agent.ordinal);
  const name = kinTitle(agent, session.slot, now, nodeId);
  const running = agent.endedAt === null;
  return (
    <span className={running ? 'ip-agent' : 'ip-agent ended'} role="img" aria-label={name} title={name}>
      {tag && <span className="ip-agent-tag">{tag}</span>}
      {running && <span className="ip-agent-time">{runTime(agent.startedAt, now)}</span>}
    </span>
  );
}
```

with:

```tsx
/**
 * One shown worker: a 16 px character (working while it runs, ended once it stops), its tag and, while it runs, its
 * run time. Its name and tooltip carry the rest, then its purpose.
 */
function Kin({ agent, session, nodeId, now }: KinProps) {
  const tag = agentTag(session.slot, agent.ordinal);
  const name = kinTitle(agent, session.slot, now, nodeId);
  const running = agent.endedAt === null;
  return (
    <span className={running ? 'ip-agent' : 'ip-agent ended'} role="img" aria-label={name} title={name}>
      <Character size={16} state={characterState(agent)} slot={session.slot} seed={`${session.id}:${agent.agentId}`} />
      {tag && <span className="ip-agent-tag">{tag}</span>}
      {running && <span className="ip-agent-time">{runTime(agent.startedAt, now)}</span>}
    </span>
  );
}
```

Replace `AgentLine`'s doc comment:

```tsx
/**
 * One session's line in a card. Where its focus anchors: its kin, then its label `A · E2E session · working`. Away
 * from its focus: its letter, then its kin, with no label. Its accessible name leads with the letter either way. The
 * card's done row rides at its right end when this is the card's last line and it holds no kin.
 */
```

with:

```tsx
/**
 * One session's line in a card. Where its focus anchors: its lead (the session's character, 24 px while working, else
 * 20), its kin, then its label `A · E2E session · working`. Away from its focus: its letter, then its kin, with no
 * label. Its accessible name leads with the letter either way. The card's done row rides at its right end when this is
 * the card's last line and it holds no kin.
 */
```

Then replace the line's first child:

```tsx
      {!lead && letter && <span className="ip-tag">{letter}</span>}
```

with:

```tsx
      {lead ? (
        <Character size={session.state === 'working' ? 24 : 20} state={characterState(session)} slot={session.slot} seed={session.id} title={leadTitle(session)} />
      ) : (
        letter && <span className="ip-tag">{letter}</span>
      )}
```

- [ ] **Step 2: The lead's fixed slot**

In the canvas region of `web/src/styles.css`, after the rule `.ip-badge > .ip-tag { flex: none; }`, add:

```css
/* The lead: 24 px while working, 20 px otherwise, in a 24 px slot, so its kin and label never move on a flip. */
.ip-badge > .ip-char { flex: none; }
.ip-badge > .ip-char:not(.c-work) { margin: 0 2px; }
.ip-agent > .ip-char { flex: none; }
```

- [ ] **Step 3: Typecheck, unit tests, and commit**

```bash
cd /c/personal/InProgress/.claude/worktrees/quiet-t6 && npm run typecheck && npm test
git -C /c/personal/InProgress/.claude/worktrees/quiet-t6 add web/src/canvas/AgentLine.tsx web/src/styles.css
git -C /c/personal/InProgress/.claude/worktrees/quiet-t6 commit -m "Characters on the agent line: the lead and each kin (#81)" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

Expected: both `tsc` runs print nothing; every unit test passes, the pitch test included; `2 files changed`. If `tsc`
reports `TS2305: Module '"../Character"' has no exported member 'Character'` or `TS1149`, a `web/src/character.ts`
sits beside `Character.tsx`: stop and tell the controller (Task 2 names the helpers `characterState.ts`). Do not add
an extension to the import.

- [ ] **Step 4: The kin tests still read the same text**

```bash
cd /c/personal/InProgress/.claude/worktrees/quiet-t6 && npm run build && INPROGRESS_E2E_PORT=4396 npx playwright test -g "opens on the current work|each subagent has a badge under its node|badge says what it was asked to do|show A and B in different hues"
```

Expected: `4 passed`. The characters' SVGs are `aria-hidden` and hold no text, so a kin's text stays its tag and time
and every name stays as 6a pinned it.

- [ ] **Step 5: The characters wear the family's hue (T1142, T1380)**

In T1142, in the `colours` evaluate, replace:

```ts
      return {
        own: color(find('.ip-badge', 'E2E session').querySelector('.ip-badge-label .ip-tag')),
        wire: color(kin('a1').querySelector('.ip-agent-tag')),
```

with:

```ts
      return {
        own: color(find('.ip-badge', 'E2E session').querySelector('.ip-badge-label .ip-tag')),
        lead: color(find('.ip-badge', 'E2E session').querySelector(':scope > .ip-char svg')),
        wire: color(kin('a1').querySelector('.ip-agent-tag')),
        wireCharacter: color(kin('a1').querySelector('.ip-char svg')),
```

Replace the comment above the `colours` evaluate:

```ts
    // One family, one hue: the session's letter, both kin's tags, the subagent's task tag and the session's task bar.
```

with:

```ts
    // One family, one hue: the session's letter and character, the kin's tags and characters, the subagent's task tag
    // and the session's task bar.
```

Then replace the check after it:

```ts
    for (const part of ['wire', 'review', 'tag', 'ownMarker']) expect(colours[part], part).toBe(colours.own);
```

with:

```ts
    for (const part of ['lead', 'wire', 'wireCharacter', 'review', 'tag', 'ownMarker']) expect(colours[part], part).toBe(colours.own);
```

The character paints its body with `currentColor`, so the colour its SVG inherits is the hue it wears, whichever of
Task 2's elements sets it.

In T1380's `hues` object, after the line
`agentB: getComputedStyle(document.querySelector('.ip-agent[aria-label^="b1 · "] .ip-agent-tag')).color,` add:

```ts
        characterB: getComputedStyle(document.querySelector('.ip-agent[aria-label^="b1 · "] .ip-char svg')).color,
```

and replace:

```ts
    for (const part of ['badgeB', 'agentB', 'tagB']) expect(hues[part], part).toBe(hues.chipB);
```

with:

```ts
    for (const part of ['badgeB', 'agentB', 'characterB', 'tagB']) expect(hues[part], part).toBe(hues.chipB);
```

Run: `cd /c/personal/InProgress/.claude/worktrees/quiet-t6 && INPROGRESS_E2E_PORT=4396 npx playwright test -g "each subagent has a badge under its node|show A and B in different hues"`

Expected: `2 passed`.

- [ ] **Step 6: The new canvas test**

In `test/e2e/ui.spec.ts`, at the end of the `Live work` block, after T1445's closing `  });` and before the block's
closing `});`, add:

```ts

  test("a step's agents and tasks sit inside its card: one line per session with its character and kin, the done row at the line's end, a lane per phase", async ({ page, api, fresh }) => {
    const revenue = fresh.ids['3 RevenueCat'];
    // On the session's focus: a running worker, a worker that has just stopped, a reader and three tasks, one done.
    await subagent(api, fresh, 'agent-1', 'Review the signing config', 'haiku');
    await subagent(api, fresh, 'agent-2', 'Check the keystore', 'sonnet');
    await hook(api, fresh.session, { event: 'subagent-stop', agentId: 'agent-2' });
    await subagent(api, fresh, 'reader-1', 'Map the signing config', 'haiku', { agentType: 'Explore' });
    await task(api, fresh, '1', 'Upload the key', 'in_progress');
    await task(api, fresh, '2', 'Check the release track');
    await task(api, fresh, '3', 'Read the signing guide', 'completed');
    // Away from it, on 3 RevenueCat: a worker, and a done task of its own.
    await subagent(api, fresh, 'agent-3', `#${revenue} Wire up RevenueCat`, 'sonnet');
    await task(api, fresh, '4', `#${revenue} Price the tiers`, 'completed');
    // On the stack head Road to market: a worker, so its line holds kin, and a done task, whose row then takes a line
    // of its own.
    const road = fresh.ids['Road to market'];
    await subagent(api, fresh, 'agent-4', `#${road} Survey the store listings`, 'haiku');
    await task(api, fresh, '5', `#${road} Draft the store notes`, 'completed');
    await open(page, fresh);

    const header = page.locator('.ip-node', { hasText: 'Play app signing' });
    const frame = frameOf(header);
    await expect(header).toBeInViewport();
    const line = page.getByRole('group', { name: 'A · E2E session · working', exact: true });
    const lead = line.locator(':scope > .ip-char');
    const running = page.getByRole('img', { name: /^a1 · Review the signing config/ });
    const stopped = page.getByRole('img', { name: /^a2 · Check the keystore/ });
    const readers = frame.locator('.ip-readers');
    const done = frame.locator('.ip-work-done');
    await expect(done).toHaveText('✓ 1 done');

    // Everything the session does on its focus sits inside the card's frame, and the next card starts below it.
    const [frameBox, lineBox, leadBox, runningBox, readersBox, doneBox, uploadBox, checkBox, letterBox, nextBox] = await Promise.all(
      [
        frame,
        line,
        lead,
        running,
        readers,
        done,
        page.locator('.ip-work', { hasText: 'Upload the key' }),
        page.locator('.ip-work', { hasText: 'Check the release track' }),
        line.locator('.ip-badge-label .ip-tag'),
        frameOf(page.locator('.ip-node', { hasText: 'Run signing tests' })),
      ].map(boxOf),
    );
    const parts = { line: lineBox, lead: leadBox, kin: runningBox, readers: readersBox, done: doneBox, upload: uploadBox, check: checkBox };
    for (const [what, box] of Object.entries(parts)) expectInside(box, frameBox, what);
    expect(nextBox.y - (frameBox.y + frameBox.height), 'the next card, at least 10 px below').toBeGreaterThanOrEqual(9.5);
    // Kin with the lead: the lead, then the kin, then the label, whose letter also leads the line's name.
    expect(leadBox.x + leadBox.width).toBeLessThanOrEqual(runningBox.x);
    expect(runningBox.x + runningBox.width).toBeLessThanOrEqual(letterBox.x);
    // The done row shares the readers line, the card's last, at its right end inside the frame's padding.
    expect(Math.abs(doneBox.y + doneBox.height / 2 - (readersBox.y + readersBox.height / 2)), 'on the readers line').toBeLessThanOrEqual(1);
    expect(frameBox.x + frameBox.width - (doneBox.x + doneBox.width), "at the frame's right padding").toBeCloseTo(13, 0);
    // On a card whose last line holds kin, the done row takes a line of its own below it.
    const revenueFrame = frameOf(page.locator('.ip-node', { hasText: '3 RevenueCat' }));
    const away = revenueFrame.locator('.ip-badge');
    await expect(away).toHaveAccessibleName('A · subagents of E2E session');
    await expect(away.getByRole('img', { name: /^a4 · Wire up RevenueCat/ })).toHaveCount(1);
    const [awayBox, ownLineDone, revenueFrameBox] = await Promise.all([away, revenueFrame.locator('.ip-work-done'), revenueFrame].map(boxOf));
    expect(ownLineDone.y, 'below the line with kin').toBeGreaterThanOrEqual(awayBox.y + awayBox.height - 0.5);
    expectInside(ownLineDone, revenueFrameBox, 'its own line');

    // A running kin shows its run time in DM Mono after its tag; a stopped one shows none, ended and grey.
    await expect(running).toHaveText(new RegExp(`^a1${RUN_TIME}$`));
    const time = running.locator('.ip-agent-time');
    await expect(time).toHaveCSS('font-family', /DM Mono/);
    const [tagBox, timeBox] = await Promise.all([running.locator('.ip-agent-tag'), time].map(boxOf));
    expect(timeBox.x).toBeGreaterThanOrEqual(tagBox.x + tagBox.width);
    await expect(stopped).toHaveText('a2');
    await expect(stopped.locator('.ip-agent-time')).toHaveCount(0);
    await expect(stopped.locator('.ip-char')).toHaveAttribute('data-state', 'ended');
    await expect(stopped.locator('.ip-agent-tag')).toHaveCSS('color', 'rgb(71, 85, 105)');
    await expect(lead).toHaveAttribute('data-state', 'work');

    // A lane per phase: Road to market's holds its stack head and children, 18 px below Milestones'. Clicks pass through.
    const laneOf = (title: string) => page.locator(`.react-flow__node-ipLane[data-id="lane${fresh.ids[title]}"]`);
    const [roadLane, milestonesLane] = await Promise.all([laneOf('Road to market'), laneOf('Milestones')].map(boxOf));
    for (const title of ['Road to market', '1 iOS certificate', '2 Android signing', 'Run signing tests']) {
      expectInside(await boxOf(page.locator('.ip-node', { hasText: title })), roadLane, title);
    }
    expectInside(await boxOf(page.locator('.ip-more', { hasText: '+3 more' })), roadLane, '+3 more');
    expect(roadLane.y - (milestonesLane.y + milestonesLane.height), 'apart').toBeCloseTo(18, 0);
    await expect(laneOf('Road to market')).toHaveCSS('pointer-events', 'none');
    // The stack head's track fills to done / total: 1 of Road to market's 7 steps is done.
    const head = page.locator('.ip-node.stack', { hasText: 'Road to market' });
    await expect(head.locator('.ip-progress')).toHaveText('1/7');
    const track = frameOf(head).locator('.ip-track');
    const [trackBox, fillBox] = await Promise.all([track, track.locator('.ip-track-fill')].map(boxOf));
    expect(fillBox.width / trackBox.width).toBeCloseTo(1 / 7, 2);
    // Its line and the done row on a line of its own both start at flow x 56, where its children's frames start.
    await expect(frameOf(head).getByRole('img', { name: /Survey the store listings/ })).toHaveCount(1);
    const [headLetter, headDone, childFrame] = await Promise.all(
      [frameOf(head).locator('.ip-badge > .ip-tag'), frameOf(head).locator('.ip-work-done'), frameOf(page.locator('.ip-node', { hasText: '1 iOS certificate' }))].map(boxOf),
    );
    expect(Math.abs(headLetter.x - childFrame.x), "the line's letter, at x 56").toBeLessThanOrEqual(1);
    expect(Math.abs(headDone.x - childFrame.x), 'the done row, at x 56').toBeLessThanOrEqual(1);
    // The zoom buttons: one row, at the canvas's top right.
    const canvas = await boxOf(page.locator('.react-flow'));
    const zoom = await Promise.all(['zoomin', 'zoomout', 'fitview'].map((b) => boxOf(page.locator(`.react-flow__controls-${b}`))));
    for (const b of zoom) expect(Math.abs(b.y - zoom[0].y), 'one row').toBeLessThanOrEqual(0.5);
    expect(zoom[0].x + zoom[0].width).toBeLessThanOrEqual(zoom[1].x);
    expect(zoom[1].x + zoom[1].width).toBeLessThanOrEqual(zoom[2].x);
    expect(canvas.x + canvas.width - (zoom[2].x + zoom[2].width), 'at the right').toBeLessThanOrEqual(13);
    expect(zoom[0].y - canvas.y, 'at the top').toBeLessThanOrEqual(9);

    // A click anywhere on the card opens Details, and the frame draws the selected ring.
    await readers.locator('.ip-readers-text').click();
    await expect(page.getByRole('complementary')).toContainText(`#${fresh.ids['Play app signing']} Play app signing`);
    await expect(frame).toHaveClass(/\bselected\b/);
    await expect(frame).not.toHaveCSS('box-shadow', 'none');

    // The working lead bobs and blinks; under reduced motion it holds still.
    const body = lead.locator('.ip-char-body');
    const eyes = lead.locator('g.ip-char-eyes');
    await expect(body).toHaveCSS('animation-name', 'ip-bob');
    await expect(eyes).toHaveCSS('animation-name', 'ip-blink');
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await expect(body).toHaveCSS('animation-name', 'none');
    await expect(eyes).toHaveCSS('animation-name', 'none');
  });
```

Run: `cd /c/personal/InProgress/.claude/worktrees/quiet-t6 && INPROGRESS_E2E_PORT=4396 npx playwright test -g "a step's agents and tasks sit inside its card"`

Expected: `1 passed`. If `a4` is not found, the server numbered the subagents differently: read the kin's name in the
trace (`npx playwright show-trace`) and fix the test's ordinal, never the component.

- [ ] **Step 7: The whole e2e suite**

```bash
cd /c/personal/InProgress/.claude/worktrees/quiet-t6 && INPROGRESS_E2E_PORT=4396 npm run test:e2e
```

Expected: `51 passed` (50, plus the new canvas test), 0 failed, 0 flaky.

- [ ] **Step 8: Commit**

```bash
git -C /c/personal/InProgress/.claude/worktrees/quiet-t6 add test/e2e/ui.spec.ts
git -C /c/personal/InProgress/.claude/worktrees/quiet-t6 commit -m "e2e: a step's agents and tasks sit inside its card (#81)" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
git -C /c/personal/InProgress/.claude/worktrees/quiet-t6 status --short
git -C /c/personal/InProgress/.claude/worktrees/quiet-t6 log --oneline quiet-restyle..quiet/t6-canvas
```

Expected: `1 file changed`; no status output; the log lists Task 6's six commits (6a's three, 6b's two, and the
Step 1 merge) above Task 3's layout commits.

### Verifying Task 6, and how it merges into `quiet-restyle`

**Verification**, from the worktree, on the finished branch:

```bash
cd /c/personal/InProgress/.claude/worktrees/quiet-t6
npm run typecheck
npm test
npx vitest run test/web/pitch.test.ts
npm run build && INPROGRESS_E2E_PORT=4396 npx playwright test -g "a step's agents and tasks sit inside its card|working tasks sit under their node|each subagent has a badge under its node|badge says what it was asked to do|show A and B in different hues|their own Up next order|stay on their steps as a trail row|no minimap|dark mode reaches the canvas controls"
INPROGRESS_E2E_PORT=4396 npm run test:e2e
```

Expected: clean typecheck; every unit test passing; the pitch test `13 passed`; the touched e2e tests `9 passed`; the
full suite `51 passed`.

**Merging.** Task 6 does not merge itself. Task 7 merges `quiet/t4-chrome`, then `quiet/t5-details`, then
`quiet/t6-canvas` into `quiet-restyle` (Task 7, Steps 2 to 8), and `quiet/t6-canvas` brings `quiet/t3-layout` with it.
`styles.css` cannot conflict: each task replaces only its own region, and the unchanged head comments sit between
them.

`test/e2e/ui.spec.ts` can. Tasks 4 and 6 edit neighbouring lines of the same tests:

- T1380: Task 4 edits the chip lines l.1388-1393, l.1413, l.1415 (and maybe l.1422); Task 6 edits l.1394-1406,
  l.1414, l.1416-1418 and l.1426. Git treats edits on touching lines as one conflict.
- T1294: Task 6 inserts three lines after l.1313. If Task 4 also edits l.1314 (the comment above the `hues`
  evaluate), the two touch.
- T1203 (Task 4 at l.1227-1228, Task 6 at l.1225) and T284 (Task 4 at l.288, Task 6 at l.294-295) have an unchanged
  line between the two tasks' edits, so they should merge cleanly.

If Task 7's Step 6 stops on a conflict, Task 7 runs `git merge --abort` and sends the branch back here. Then:

```bash
cd /c/personal/InProgress/.claude/worktrees/quiet-t6 && git merge quiet-restyle
```

In each conflicted hunk of `test/e2e/ui.spec.ts`, keep Task 4's version of the chip lines (`chipA`, `chipB`,
`.ip-chip-s`, `.ip-chip-label`, the chip's text and name) and Task 6's version of every `.ip-badge`, `.ip-agent`,
`frameOf` and `expectInside` line, so the merged test holds both tasks' edits. If Task 4 changed the `bg` helper
(l.1410), keep its change: Task 6's lines call `getComputedStyle` directly and do not use `bg`. Then:

```bash
cd /c/personal/InProgress/.claude/worktrees/quiet-t6
git add test/e2e/ui.spec.ts
git commit -m "Merge quiet-restyle into the canvas branch (#81)" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
npm run typecheck && npm test && npm run build && INPROGRESS_E2E_PORT=4396 npx playwright test -g "show A and B in different hues|their own Up next order|badge says what it was asked to do|dark mode reaches the canvas controls|a step's agents and tasks sit inside its card"
```

Expected: the merge commit; a clean typecheck; every unit test passing; `5 passed`. Task 7 then restarts its Step 6.
Task 5's lines (Details) sit at least one unchanged line away from every Task 6 edit (T392 l.453, T1203 l.1236-1243,
T1445 l.1491-1502, T284 l.297-298), so they should not conflict. Never push.

**Risks this task carries:**

- **The Character import.** A `web/src/character.ts` beside `Character.tsx` would break `'../Character'` on Windows.
  Task 2 names the helpers `characterState.ts` so the bare import works (Interface contract). Task 4 imports the
  same way.
- **The DOM drifts from layout's `h`.** Guarded: cards and lanes take layout's `width` and `height`; every in-card
  line has a fixed height read from the pitch, `nowrap` and an ellipsis; the pitch test fails on a literal height; the
  new e2e checks the next card starts 10 px below the frame.
- **A crowded agent line.** Six running kin with times overflow a 398 px line once the title has cut to nothing. The
  cap stays six, as approved.
- **A queued phase.** The gutter column (flow x 6 to 48) overlaps a stack head at x 22. No phase is queued in the live
  tree.

### Task 7: Integrate and deploy

Size S, wave 3, after every other task. The controller runs it in the integration worktree, then in the main
checkout. It merges the wave 2 branches, checks the whole branch (suites, leftovers, contrast, the real window night
and day), amends the review-actions note, merges into `main` and deploys.

**Files:**
- Modify: `docs/superpowers/specs/2026-10-04-review-actions-design.md:177` (insert a section between line 176,
  `Controller rulings made while running the plan are in …`, and line 178, `## After this plan`)
- Modify (main checkout only, gitignored, never committed): `C:/personal/InProgress/.superpowers/iter/2026-10-05/refresh/contrast.mjs` (whole file)
- Create (main checkout only, gitignored, never committed): `C:/personal/InProgress/.superpowers/iter/2026-10-05/quiet/preview.mjs`
- Test: no new tests. Runs `npm run typecheck`, `npm test`, `npm run test:smoke` and `npm run test:e2e`.

**Interfaces:**
- Consumes: the branches `quiet/t4-chrome`, `quiet/t5-details` and `quiet/t6-canvas` (which carries
  `quiet/t3-layout`); `quiet/t1-tokens`, `quiet/t2-glyphs` and `quiet/t3-live`, already merged. The new canvas test's
  title. The tokens `--bg`, `--bar`, `--lane`, `--card`, `--active-fill`, `--float`, `--panel`, `--family-0` to
  `--family-5`, `--link`, `--red`, `--text`, `--text-2`, `--muted`, `--faint`, `--gone`, `--active-ink`,
  `--amber-ink` and `--sky`, in `:root` and the dark block. The hooks `.ip-node`, `.ip-tab-name`, `.ip-upnext-line`,
  `.ip-title` and `.react-flow__node[data-id="n86"]`.
- Produces: a `--no-ff` merge commit on `main` naming #81, the live build of it, and the amended review-actions note.
  Nothing later depends on this task.

- [ ] **Step 1: Check the integration worktree**

```bash
git -C /c/personal/InProgress/.claude/worktrees/quiet-restyle status --short
git -C /c/personal/InProgress/.claude/worktrees/quiet-restyle log --merges --oneline -3
```

Expected: no status output. The log lists the merges of `quiet/t3-live`, `quiet/t2-glyphs` and `quiet/t1-tokens`.

- [ ] **Step 2: Merge the chrome**

```bash
git -C /c/personal/InProgress/.claude/worktrees/quiet-restyle merge --no-ff quiet/t4-chrome -m "Merge Quiet Task 4: chrome (#81)" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

Expected: `Merge made by the 'ort' strategy.` If git stops on a conflict, run
`git -C /c/personal/InProgress/.claude/worktrees/quiet-restyle merge --abort`, find the conflicting lines' owner in
the regions table (or the test's own lines), and send the branch back to that task to merge `quiet-restyle` into it
and resolve.

- [ ] **Step 3: Gate after the chrome**

```bash
cd /c/personal/InProgress/.claude/worktrees/quiet-restyle && npm run typecheck && npm test
```

Expected: both `tsc` runs print nothing; Vitest reports every test file passed and 0 failed.

- [ ] **Step 4: Merge Details**

```bash
git -C /c/personal/InProgress/.claude/worktrees/quiet-restyle merge --no-ff quiet/t5-details -m "Merge Quiet Task 5: Details (#81)" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

Expected: `Merge made by the 'ort' strategy.` On a conflict, as in Step 2.

- [ ] **Step 5: Gate after Details**

```bash
cd /c/personal/InProgress/.claude/worktrees/quiet-restyle && npm run typecheck && npm test
```

Expected: as in Step 3.

- [ ] **Step 6: Merge the canvas, with Task 3's layout**

```bash
git -C /c/personal/InProgress/.claude/worktrees/quiet-restyle merge --no-ff quiet/t6-canvas -m "Merge Quiet Task 6: canvas, with Task 3's layout (#81)" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
git -C /c/personal/InProgress/.claude/worktrees/quiet-restyle branch --merged quiet-restyle
```

Expected: `Merge made by the 'ort' strategy.` The branch list holds `main`, `quiet-restyle` and all seven task
branches: `quiet/t1-tokens`, `quiet/t2-glyphs`, `quiet/t3-layout`, `quiet/t3-live`, `quiet/t4-chrome`,
`quiet/t5-details`, `quiet/t6-canvas`.

- [ ] **Step 7: Gate after the canvas**

```bash
cd /c/personal/InProgress/.claude/worktrees/quiet-restyle && npm run typecheck && npm test
```

Expected: as in Step 3, now with `test/web/tokens.test.ts`, `test/web/character.test.ts`, `test/web/chips.test.ts`
and `test/web/pitch.test.ts` among the passing files.

- [ ] **Step 8: Rerun the canvas e2e on the merged branch**

```bash
cd /c/personal/InProgress/.claude/worktrees/quiet-restyle && npm run build && INPROGRESS_E2E_PORT=4397 npx playwright test -g "a step's agents and tasks sit inside its card"
```

Expected: `Built into …/.build`, then `1 passed`.

- [ ] **Step 9: Search for leftovers**

```bash
cd /c/personal/InProgress/.claude/worktrees/quiet-restyle
grep -nE "font-weight:\s*(600|700|800|bold)" web/src/styles.css web/src/character.css
grep -rnE "var\(--(accent|edge|green|purple|clay)\)" web/src
grep -nE "color:\s*#fff\b" web/src/styles.css web/src/character.css
grep -lE "data:(font|application/(x-)?font)" .build/web/dist/assets/*.css
ls .build/web/dist/assets | grep -E "\.woff2?$"
```

Expected: the first four commands print nothing. The last lists six font files, `inter-latin-500-normal`,
`inter-latin-900-normal` and `dm-mono-latin-500-normal`, each as `.woff2` and `.woff`, with a hash in the name. Any
other output goes back to the task that owns the file.

- [ ] **Step 10: Amend the review-actions note**

In `docs/superpowers/specs/2026-10-04-review-actions-design.md`, insert this section after line 176 (the
`Controller rulings …` paragraph) and its blank line, so `## After this plan` follows it after one blank line:

```markdown
## Amended by the Quiet restyle (Aiden, 2026-10-05)

The Quiet restyle ([2026-10-05-quiet-restyle-design.md](2026-10-05-quiet-restyle-design.md), #81) changes how the
window draws sessions, subagents and the Up next strip. Aiden approved it on 2026-10-05. The lines named below stay as
written above; this section amends them.

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
```

Check it: `grep -n "^## " /c/personal/InProgress/.claude/worktrees/quiet-restyle/docs/superpowers/specs/2026-10-04-review-actions-design.md`.
Expected: `## Decisions after the preflight (Aiden, 2026-10-04)`, then `## Amended by the Quiet restyle (Aiden,
2026-10-05)`, then `## After this plan`.

- [ ] **Step 11: Commit the amendment**

```bash
git -C /c/personal/InProgress/.claude/worktrees/quiet-restyle add docs/superpowers/specs/2026-10-04-review-actions-design.md
git -C /c/personal/InProgress/.claude/worktrees/quiet-restyle commit -m "Amend the review-actions note for the Quiet restyle: D1, D3, D4, D5, D7, D8, D9, D16 (#81)" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

Expected: `1 file changed` with only insertions.

- [ ] **Step 12: Typecheck, unit and smoke on the whole branch**

```bash
cd /c/personal/InProgress/.claude/worktrees/quiet-restyle && npm run typecheck && npm test && npm run test:smoke
```

Expected: typecheck clean, every unit test passing, every smoke test passing.

- [ ] **Step 13: The full e2e on the whole branch**

```bash
cd /c/personal/InProgress/.claude/worktrees/quiet-restyle && INPROGRESS_E2E_PORT=4397 npm run test:e2e
```

Expected: `51 passed` (50 at `0b786b8`, plus the new canvas test), 0 failed, 0 flaky. A failure goes back to the task
that owns the failing lines.

- [ ] **Step 14: Update the contrast check**

Replace the whole of `C:/personal/InProgress/.superpowers/iter/2026-10-05/refresh/contrast.mjs` with:

```js
// WCAG 2.x contrast for the Quiet tokens, day and night, read from a styles.css so the tables follow the code.
// Run: node contrast.mjs [path/to/styles.css]. Without a path it reads the main checkout's web/src/styles.css.
// Prints Markdown tables. Exits 1 when a required check is under 4.5:1: a family hue as text on any surface it sits
// on, --link on Details and the viewer, --red on a card.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const path = resolve(process.argv[2] ?? resolve(here, '../../../../web/src/styles.css'));
const css = readFileSync(path, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');

/** The custom properties declared in a CSS block's body. */
function tokens(body) {
  const out = {};
  for (const m of body.matchAll(/--([\w-]+)\s*:\s*([^;]+);/g)) out[m[1]] = m[2].trim();
  return out;
}
const dayBody = /:root\s*\{([^}]*)\}/.exec(css)?.[1];
const nightBody = /@media \(prefers-color-scheme: dark\)\s*\{\s*:root\s*\{([^}]*)\}/.exec(css)?.[1];
if (!dayBody || !nightBody) throw new Error(`no :root block or no dark block in ${path}`);
const themes = { day: tokens(dayBody), night: { ...tokens(dayBody), ...tokens(nightBody) } };

/** A token's value with var() references followed, in one theme. */
function resolveToken(theme, name, seen = new Set()) {
  const raw = theme[name];
  if (raw === undefined) throw new Error(`no --${name}`);
  const ref = /^var\(--([\w-]+)\)$/.exec(raw);
  if (!ref) return raw;
  if (seen.has(ref[1])) throw new Error(`cycle at --${ref[1]}`);
  seen.add(ref[1]);
  return resolveToken(theme, ref[1], seen);
}

/** A colour as [r, g, b, alpha]: #rgb, #rrggbb, rgb() or rgba(), with commas or spaces. */
function parse(value) {
  const v = value.trim().toLowerCase();
  let m = /^#([0-9a-f]{3})$/.exec(v);
  if (m) return [...[...m[1]].map((c) => parseInt(c + c, 16)), 1];
  m = /^#([0-9a-f]{6})$/.exec(v);
  if (m) {
    const n = parseInt(m[1], 16);
    return [(n >> 16) & 255, (n >> 8) & 255, n & 255, 1];
  }
  m = /^rgba?\(\s*([\d.]+)[\s,]+([\d.]+)[\s,]+([\d.]+)(?:[\s,/]+([\d.]+%?))?\s*\)$/.exec(v);
  if (m) {
    const a = m[4] === undefined ? 1 : m[4].endsWith('%') ? parseFloat(m[4]) / 100 : parseFloat(m[4]);
    return [Number(m[1]), Number(m[2]), Number(m[3]), a];
  }
  throw new Error(`not a colour this script reads: ${value}`);
}

/** A token painted over an opaque backdrop: an rgba token composites source-over, as browsers paint it. */
function paint(theme, name, under) {
  const [r, g, b, a] = parse(resolveToken(theme, name));
  return [r, g, b].map((c, i) => a * c + (1 - a) * under[i]);
}

/** WCAG 2.x relative luminance of an sRGB colour (0..255 channels). */
function luminance([r, g, b]) {
  const lin = (c) => {
    const s = c / 255;
    return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
}

const ratio = (a, b) => {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
};

/** "4.62", marked with what it passes: AA body text 4.5, large text and UI marks 3. */
const fmt = (r) => `${r.toFixed(2)}${r >= 4.5 ? '' : r >= 3 ? ' (3+)' : ' **(<3)**'}`;

/** The surfaces text sits on in one theme, each composited down to an opaque colour. */
function surfacesOf(theme) {
  const bg = paint(theme, 'bg', [0, 0, 0]);
  const lane = paint(theme, 'lane', bg);
  return {
    '--bg': bg,
    '--bar': paint(theme, 'bar', bg),
    '--lane': lane,
    '--card in a lane': paint(theme, 'card', lane),
    '--active-fill in a lane': paint(theme, 'active-fill', lane),
    '--float': paint(theme, 'float', bg),
    '--panel': paint(theme, 'panel', bg),
  };
}
const surfaces = { day: surfacesOf(themes.day), night: surfacesOf(themes.night) };
const NAMES = Object.keys(surfaces.day);

const lines = [];
const say = (s = '') => lines.push(s);
const failures = [];
/** One required check: text token on a surface, at 4.5:1 or more. */
const need = (themeName, token, surfaceName) => {
  const r = ratio(paint(themes[themeName], token, surfaces[themeName][surfaceName]), surfaces[themeName][surfaceName]);
  if (r < 4.5) failures.push(`${themeName} --${token} on ${surfaceName}: ${r.toFixed(2)}`);
  return fmt(r);
};

say(`Tokens read from ${path}. Every rgba token is composited over --bg (a card and the working focus's fill over --lane over --bg).`);
say('Plain number: passes 4.5:1. "(3+)": 3:1 to 4.5:1, enough only for large text and UI marks. "(<3)": fails both.');

for (const themeName of ['day', 'night']) {
  say();
  say(`### Family hues as text, ${themeName} (required: 4.5:1 on every surface)`);
  say();
  say(`| Token | Value | ${NAMES.join(' | ')} | --bg ink on the hue |`);
  say(`|---|---|${NAMES.map(() => '---').join('|')}|---|`);
  for (let slot = 0; slot < 6; slot++) {
    const token = `family-${slot}`;
    const hue = paint(themes[themeName], token, surfaces[themeName]['--bg']);
    const cells = NAMES.map((s) => need(themeName, token, s));
    say(`| --${token} | ${resolveToken(themes[themeName], token)} | ${cells.join(' | ')} | ${fmt(ratio(surfaces[themeName]['--bg'], hue))} |`);
  }
}

say();
say('### Links and the blocked red (required: 4.5:1)');
say();
say('| Token | Theme | Value | Surface | Ratio |');
say('|---|---|---|---|---|');
for (const themeName of ['day', 'night']) {
  for (const s of ['--bg', '--panel']) say(`| --link | ${themeName} | ${resolveToken(themes[themeName], 'link')} | ${s} | ${need(themeName, 'link', s)} |`);
  for (const s of ['--bg', '--card in a lane', '--active-fill in a lane', '--panel']) say(`| --red | ${themeName} | ${resolveToken(themes[themeName], 'red')} | ${s} | ${need(themeName, 'red', s)} |`);
}

say();
say('### Other text tokens, for reference');
say();
const INFO_SURFACES = ['--bg', '--bar', '--card in a lane', '--panel'];
say(`| Token | Theme | Value | ${INFO_SURFACES.join(' | ')} |`);
say(`|---|---|---|${INFO_SURFACES.map(() => '---').join('|')}|`);
for (const themeName of ['day', 'night']) {
  for (const token of ['text', 'text-2', 'muted', 'faint', 'gone', 'active-ink', 'amber-ink', 'sky']) {
    const cells = INFO_SURFACES.map((s) => fmt(ratio(paint(themes[themeName], token, surfaces[themeName][s]), surfaces[themeName][s])));
    say(`| --${token} | ${themeName} | ${resolveToken(themes[themeName], token)} | ${cells.join(' | ')} |`);
  }
}

say();
if (failures.length) {
  say(`${failures.length} required checks fail:`);
  for (const f of failures) say(`- ${f}`);
  process.exitCode = 1;
} else say('All required checks pass.');
console.log(lines.join('\n'));
```

What changed from today's script: it takes the stylesheet's path; it reads each family slot's day literal from
`:root` and its night literal from the dark block instead of throwing when they differ; it uses Quiet's token names
(no `--accent`, `--green` or `--purple`); it reads `rgb()`, `rgba()` and 3-digit hex and composites every `rgba`
token over `--bg`; and it no longer reads React Flow's `#141414` ground, which Task 6 removes with `<Background>`.

- [ ] **Step 15: Run the contrast check on the worktree's stylesheet**

```bash
node /c/personal/InProgress/.superpowers/iter/2026-10-05/refresh/contrast.mjs /c/personal/InProgress/.claude/worktrees/quiet-restyle/web/src/styles.css; echo "exit=$?"
```

Expected: the tables, then `All required checks pass.` and `exit=0`. With the spec's values, the lowest required
ratio is `--family-1` by day on `--lane`, 4.59. `--link` by day is 5.67 on `--bg` and 5.93 on `--panel`. `--red` is
6.18 by day and 7.00 by night on `--bg`. These numbers come from running this script on Task 1's token block (Step
10), so they hold while the tokens match it. A failing check prints in the list after `required checks fail:`, naming
the token and surface; it goes back to Task 1.

- [ ] **Step 16: Copy the live data for a preview, read-only**

```bash
cd /c/personal/InProgress/.claude/worktrees/quiet-restyle && mkdir -p .live-check/quiet-home && node -e "const D = require('better-sqlite3'); const db = new D(require('node:os').homedir() + '/.inprogress/inprogress.db', { readonly: true, fileMustExist: true }); db.backup('.live-check/quiet-home/inprogress.db').then(() => { db.close(); console.log('copied'); });"
```

Expected: `copied`. The live database is only read. `.live-check/` is gitignored.

- [ ] **Step 17: Start a preview server on the copy**

In a second terminal (it keeps running):

```bash
cd /c/personal/InProgress/.claude/worktrees/quiet-restyle && INPROGRESS_HOME=.live-check/quiet-home INPROGRESS_PORT=4398 node .build/dist/server/main.js
```

Then, in the first terminal:

```bash
curl -s http://127.0.0.1:4398/api/health; echo; git -C /c/personal/InProgress/.claude/worktrees/quiet-restyle rev-parse --short HEAD
```

Expected: `{"ok":true,"app":"inprogress",…,"build":{"sha":"<sha>","dirty":false,…}}` with the same short sha as the
`rev-parse` line. The `.build` is Step 13's.

- [ ] **Step 18: Write the preview script**

Create `C:/personal/InProgress/.superpowers/iter/2026-10-05/quiet/preview.mjs`:

```js
// The Quiet preview at 520 x 1000, night and day: a screenshot of each, and the text the window cuts short.
// Run from a checkout that has @playwright/test: node preview.mjs <port> <out-dir>
import { chromium } from '@playwright/test';

const [port = '4398', out = '.'] = process.argv.slice(2);
const browser = await chromium.launch({ channel: 'msedge' });
try {
  for (const [scheme, name] of [['dark', 'night'], ['light', 'day']]) {
    const page = await browser.newPage({ viewport: { width: 520, height: 1000 }, colorScheme: scheme });
    await page.goto(`http://127.0.0.1:${port}/#/p/inprogress`);
    await page.locator('.ip-node').first().waitFor();
    await page.evaluate(async () => {
      await document.fonts.ready;
    });
    // Let the first camera move and the session row settle.
    await page.waitForTimeout(1500);
    await page.screenshot({ path: `${out}/quiet-${name}.png` });
    const spots = await page.evaluate(() =>
      [...document.querySelectorAll('.ip-tab-name, .ip-upnext-line, .react-flow__node[data-id="n86"] .ip-title')].map((el) => ({
        spot: el.matches('.ip-tab-name') ? 'tab name' : el.matches('.ip-upnext-line') ? 'Up next line' : '#86 title',
        text: (el.textContent ?? '').slice(0, 48),
        cut: el.scrollWidth > el.clientWidth,
        textOverflow: getComputedStyle(el).textOverflow,
      })),
    );
    console.log(`\n${name}: ${out}/quiet-${name}.png`);
    console.table(spots);
    await page.close();
  }
} finally {
  await browser.close();
}
```

- [ ] **Step 19: Take the screenshots and re-check the three ellipsis spots**

```bash
cd /c/personal/InProgress && node .superpowers/iter/2026-10-05/quiet/preview.mjs 4398 .superpowers/iter/2026-10-05/quiet
```

Expected: `quiet-night.png` and `quiet-day.png` in `.superpowers/iter/2026-10-05/quiet/`, and two tables (night, day)
listing every tab name, every Up next line and `#86 title`. Every row with `cut: true` shows `textOverflow:
'ellipsis'`: the tab names over 160 px, the end of the long Up next line, and #86's title (`Draft agents as little
characters (three styles)`). If the table has no `#86 title` row, #86 sits in a folded run: check it by eye in
Step 20 after opening its run. Show both screenshots to Aiden.

- [ ] **Step 20: Aiden looks at the real window, night and day**

```bash
cd /c/personal/InProgress/.claude/worktrees/quiet-restyle && INPROGRESS_HOME=.live-check/quiet-home INPROGRESS_PORT=4398 node .build/dist/cli/main.js open
```

Expected: `Opened http://127.0.0.1:4398`, and an Edge app window of 520 × 1000 opens on the copy. Ask Aiden to look
at it in his current Windows theme, then to switch Windows between dark and light (Settings > Personalization >
Colors > Choose your mode) and look again; the window follows the switch without a reload. Wait for his go-ahead. If
he asks for a change, stop here: the change goes to the task that owns the file, and Task 7 restarts at Step 2 for
that branch.

- [ ] **Step 21: Stop the preview and remove the copy**

```bash
cd /c/personal/InProgress/.claude/worktrees/quiet-restyle && INPROGRESS_HOME=.live-check/quiet-home INPROGRESS_PORT=4398 node .build/dist/cli/main.js stop && rm -rf .live-check/quiet-home
```

Expected: `Stopped the running InProgress server.` Set both variables on this line: without them, `stop` reaches the
live server on 4317. Close the preview's Edge window.

- [ ] **Step 22: Merge into `main`, naming #81**

```bash
git -C /c/personal/InProgress status --short
git -C /c/personal/InProgress merge --no-ff quiet-restyle -m "Merge the Quiet restyle of the window (#81)" -m "Quiet replaces today's look in one deploy: Inter and DM Mono, ink and one hairline, Simple characters for sessions and subagents, a step's agents and tasks inside its card, and phases as lanes. Spec: docs/superpowers/specs/2026-10-05-quiet-restyle-design.md." -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
git -C /c/personal/InProgress log --oneline -1
```

Expected: no status output before the merge; `Merge made by the 'ort' strategy.`; the log line is the merge,
`Merge the Quiet restyle of the window (#81)`. Note its short sha for Step 26.

- [ ] **Step 23: Install the font packages in the main checkout**

```bash
cd /c/personal/InProgress && npm install --no-audit --no-fund && git status --short
```

Expected: `added 2 packages` (`@fontsource/inter` and `@fontsource/dm-mono`), and no status output. Use
`npm install`, not `npm ci`: the live server holds files under `node_modules` open, and `npm ci` deletes the folder
first.

- [ ] **Step 24: Deploy everything**

```bash
cd /c/personal/InProgress && npm run deploy -- --full
```

Expected: the steps `Type checks`, `Unit tests`, `Smoke tests against a fresh build in .build`,
`Browser tests against a full build in .build`, `Making <sha> (…) live` and `Restarting the server on the new build`,
with no `Updating the installed Claude kit` step (the kit did not change), then
``Deployed <sha> (<builtAt>). The previous build is kept: `npm run rollback` swaps back.`` If it prints
`The new build did not start cleanly: rolling back.`, stop and report: the deploy has already put the old build back.

- [ ] **Step 25: Confirm the live build**

```bash
cat /c/personal/InProgress/dist/build.json; git -C /c/personal/InProgress rev-parse --short HEAD; curl -s http://127.0.0.1:4317/api/health
```

Expected: `build.json` and the health answer carry the merge's short sha with `"dirty": false`. The open window
reloads itself on the new build (`useInProgress.ts:47-52`). Tell Aiden Quiet is live and that no session needs a
restart.

- [ ] **Step 26: Roll back, only if Aiden asks**

To bring today's look back at once (it swaps `dist/` and `web/dist/` with the previous build, fonts included):

```bash
cd /c/personal/InProgress && npm run rollback
```

Expected: ``Rolled back. Live: 9ccb572 (…). Run `npm run rollback` again to return.`` (`9ccb572` is the build live at
`0b786b8`; a deploy in between changes it.) Running it again returns to Quiet. Rollback keeps one previous build
only, so after a later deploy Quiet is the build it returns to.

To revert for good, with the merge's sha from Step 22:

```bash
git -C /c/personal/InProgress revert -m 1 --no-commit <merge-sha>
git -C /c/personal/InProgress commit -m "Revert the Quiet restyle (#81)" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
cd /c/personal/InProgress && npm run deploy
```

Expected: the revert commit, then `Deployed <sha> (…)` on today's look.
