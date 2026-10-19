# #498 v3 foundations: plan

Branch `claude/v3-foundations-da3031`, worktree `.claude/worktrees/v3-foundations-da3031`, off main 43e693f. Label ui.
Spec: `docs/superpowers/specs/2026-10-18-window-v3-port-design.md` section 2 (2.10 is the landing), section 12's #498 row.

## Criteria (depth: a list)

- C1 · open the window with the OS in light, then dark · the same dark window both times: page #111111, text #f2f2f2, dark scrollbars and fields.
- C2 · look over the Board, a menu, a chip, Details · every corner square; live dots and markers are squares.
- C3 · read a task title, an id, a time · titles and body in Archivo, ids and times in Martian Mono; no font request leaves the origin.
- C4 · Tab through the bar and a Details sheet · a 2 px volt ring on each focused control.
- C5 · look at a working step, a needs-you step, a blocked step · volt, volt, alarm; tiles' hue edges in the seven factions.

## Tasks

1. `test/web/tokens.test.ts` rewritten for one palette (done first, red).
2. `web/src/styles/tokens.css`: v3 tokens, then the Quiet alias block (2.10 table); `color-scheme: dark`; no dark block; `--track-l` gone.
3. `web/src/styles/fonts.css`: latin-only `@font-face` for Archivo (wdth 100 to 125, wght 400 to 800), Martian Mono (wdth 75 to 112.5, wght 400 to 700), Doto 800, from the @fontsource packages' files; imported in `main.tsx`; Inter and DM Mono removed.
4. `web/src/styles/base.css`: body on `--font-body`/`--t-body`/`--w-body`; `border-radius: 0` on everything; `::selection`; thin dark scrollbars; tabular slashed-zero numerals on mono uses.
5. Sheets: delete every `border-radius`; delete both `--track-l` uses; focus outlines `var(--text-2)` to `var(--volt)`; `.ip-banner` `#000` to `var(--volt-ink)`; links dotted-underlined.
6. e2e: rewrite the listed literal-value assertions in `test/e2e/ui.spec.ts`; the theme test becomes "the window is dark whatever the OS theme".
7. typecheck, unit, the touched e2e tests on a 4410-4419 port; Murr; Parvati; check surface; receipt.

## Not in this step

Z-index literals, space literals, motion (blink, reduced-motion rewrite), textures and the type roles' per-element settings move with their surface steps.
