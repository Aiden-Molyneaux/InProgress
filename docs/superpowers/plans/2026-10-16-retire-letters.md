# Plan: retire session characters and letters (#438)

Owner: Sigmund (session aa1e1c72, 2026-10-16). Labels: ui + integration (briefing text, `claude/`). Branch `retire-letters`, worktree `.claude/worktrees/wizardly-lalande-6fbf18`.

## Decisions this plan rests on

- Aiden (r243, r249): characters and session letters are deprecated; a task wears a hue, a session does not. The Board cells dropped them in #422.
- Aiden (2026-10-16, this session):
  1. Scope is the window and the session text: hook and briefing lines, the Up next line (briefing, MCP outline, `/api` read), the mip-orc digest and the "also claimed by" note. A session is named by its display title in quotes.
  2. Subagent tags (`a1`, `b2`) go everywhere. A row names the subagent by its type and words, as it already does after the tag. Background commands lose the tag too.
  3. The six session family hues (`--family-0..5`) retire. Rows that wore them go neutral ink. The task hue (`--hue-0..6`) is the only hue left.
  4. Project view outline: an own-queue entry gets one neutral rail mark, `◆`, with the session's title on hover and in its accessible name. The Sessions column lists session titles, each clipped to one line.
- Sigmund: `sessions.slot` stays in the schema and in `Session` (no migration). It still breaks ties in sort order (`src/core/board.ts`, `web/src/board/headerSessions.ts`) and its assignment code in `src/server/session-flow.ts` stays as it is. Only its display goes.
- Sigmund: the relettering re-briefing marks in `session-flow.ts` (`markIfRelettered` and the hook-path mark) stay for now. An extra briefing is harmless; removing them is a follow-up step, not this one.
- Sigmund: Details' working-task hue bar (`.ip-work-agent`) goes with the hues. The row's `· owner` suffix already says whether the session or a subagent holds the task.
- Sigmund: `character.css` also styles the status marker (`Marker.tsx`). It is renamed `marker.css` and keeps only what the marker uses.

## Task 1: session text (server, core, mcp, skill)

Files: `src/core/types.ts`, `src/core/layout.ts`, `src/server/briefing.ts`, `src/server/digest.ts`, `src/server/session-flow.ts` (the note string only), `src/mcp/server.ts` (description only), `src/server/routes/read.ts` (comment only), `claude/skills/mip-orc/SKILL.md`, and their tests.

1. `src/core/types.ts`: delete `sessionTag`, `ownerTag`, `agentTag`. Reword the `slot` doc comment: it orders sessions of a project and is no longer shown.
2. `src/core/layout.ts` `formatUpNext`: name each owner by `"<sessionDisplayTitle clipped to 30 chars with …>"` instead of its letter; an owner missing from `sessions` reads `a session`. The reader's own part reads `Up next (you): …` (no letter). Widen the `sessions` parameter to `Pick<Session, 'id' | 'title'>[]` (drop `slot`). Update the doc comment's examples: `Up next: "Store listing": #82 → #78 | "Docs pass": #90 | later: #79`, and `Up next (you): #82 ⚙ Trail → #78 ⧉ Guide · "Docs pass": #90 · later: #79`.
3. `src/server/briefing.ts`:
   - `needsYouLine`: a permission wait reads `"<title>" waiting for permission on #45 …`.
   - `othersLine`: `Other sessions here: "<title>" (working, on #42 …) · …`.
   - `headerLine`: drop ` You are session X.`; the line ends at `Session id: ID.`
   - Fix each doc comment's example to match.
4. `src/server/digest.ts`: drop the `letter` field and `sessionTag`. A session line reads `${id8} "title" notes…`. An ask raised by a session reads `(… "<title clipped to 30>", 3d)` where it used the letter. Use the digest's existing `clip`.
5. `src/server/session-flow.ts:430`: the note reads `Note: #N is also claimed by "<sessionDisplayTitle>" (<activity>).` Remove the `sessionTag` import. Touch nothing else in this file.
6. `src/mcp/server.ts:93`: the `get_outline` description reads `the queue as "Up next: \"Session title\": #a → #b | later: #c": each live session's own order under its title, then the unowned order.` `src/server/routes/read.ts:24` comment likewise.
7. `claude/skills/mip-orc/SKILL.md`: line 12 "A session gets its letter and its title" → "A session gets its title". Line 48 "List the session (its letter) and the step" → "List the session (its title) and the step".
8. Tests: update the expectations in `test/core/layout.test.ts` (formatUpNext block ~628-662), `test/server/briefing-scoped.test.ts` (59, 81, 130), `test/server/app.test.ts` (~268-274), `test/mcp/server.test.ts` (~92-107), `test/server/digest.test.ts`, `test/server/claim.test.ts` and `test/server/sessions.test.ts` wherever they assert a letter. Delete the unit tests of the deleted helpers. Do not weaken an assertion: replace a letter with the title it now shows. Check `test/cli/claude-config.test.ts`, `test/lib/paths.test.ts`, `test/scripts/context-nudge.test.ts` and leave them unless they test session letters.

## Task 2: the window

Files: `web/src/Character.tsx` (delete), `web/src/characterState.ts` (delete), `web/src/family.ts` (delete), `web/src/character.css` (rename `marker.css`), `web/src/Marker.tsx`, `web/src/styles.css`, `web/src/live.ts`, `web/src/describe.ts`, `web/src/board/HeaderLines.tsx`, `web/src/board/NowColumn.tsx` (the call only), `web/src/project/ProjectView.tsx`, `web/src/project/Section.tsx`, `web/src/panels/Details.tsx`, and their tests.

1. Delete `Character.tsx`, `characterState.ts`, `family.ts`, `test/web/character.test.ts`, `test/web/family.test.ts`. Move any assertion in `family.test.ts` that is not about letters, families or slots into the test file of what it tests (likely none).
2. `git mv web/src/character.css web/src/marker.css`; `Marker.tsx` imports `./marker.css`. Remove every `.ip-char*` and `.c-work/.c-busy/.c-idle/.c-ended` rule and any keyframe only those used (grep each keyframe name across `web/src` before deleting it). Rewrite the header comment for the marker alone.
3. `styles.css`: delete the `--family-*` tokens in light and dark and their comment; delete `.ip-tag`, `.ip-num.ip-letter`, `.ip-work-tag`, `.ip-agent-tag` (all rules, 424-480 area), `.ip-work-agent` (both rules); fix the comments at 211, 423-425, 470-471 that mention the letter or hue. `test/web/tokens.test.ts:74` stops expecting family tokens.
4. `live.ts`: delete `withTag`, `taskFamily`, `chipName`, `kinTitle`, `commandTag`. `leadTitle` returns `${title} · ${word}${subagents}${commands}` with no tag. `CommandLineParts` loses `tag`; `commandLineParts` takes `Pick<Session, 'subagents'>` (or drops the session argument if nothing else needs it; update `NowColumn.tsx`'s call). Fix doc comments that mention letters.
5. `describe.ts` `agentLabel`: `a ? agentName(a) : 'a subagent'` (import `agentName` from `./live`); drop `agentTag`.
6. `HeaderLines.tsx`:
   - The state note: the `ip-msg` keeps its body (`Orchestrator · age`, first sentence) with no figure.
   - Each "No claimed step" entry: `<span className="ip-hdr-session" title={leadTitle(s, now)}><b className="ip-hdr-title">{sessionDisplayTitle(s)}</b>{orchestrator word}<span className="ip-quiet"> · {word}</span></span>`. CSS: `.ip-hdr-title` clips to one line with an ellipsis (`min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap`); `.ip-hdr-session` gets `min-width: 0; max-width: 100%`.
7. `ProjectView.tsx`: the note message drops its figure. `RailKey`'s own-queue line becomes `<span className="ip-num ip-own" aria-hidden="true">◆</span> next, in a session's own queue`.
8. `Section.tsx`: delete `hue`. `RailMark`'s own-queue case: `<span className="ip-num ip-own" role="img" aria-label={`next, in the own queue of "${sessionDisplayTitle(owner)}"`} title={sessionDisplayTitle(owner)}>◆</span>`. Rename `letters` to `onIt`; the Sessions cell renders `<span className="ip-osess-title" title={sessionDisplayTitle(s)}>{sessionDisplayTitle(s)}</span>` for each. CSS: `.ip-own { color: var(--text-2); font-size: var(--fs-s); }`; `.ip-osess` becomes `display: flex; flex-direction: column; align-items: flex-end; min-width: 0; max-width: 184px;` and `.ip-osess-title` clips to one line with an ellipsis, `max-width: 100%; font-size: var(--fs-s); color: var(--text-2)`. In the narrow grid (`auto` third column) cap `.ip-osess` at `max-width: 112px`.
9. `Details.tsx`:
   - Working tasks: drop `family`, the `--fam` style, the `title`, the tag span and the `.ip-work-agent` bar. The row is `mark subject · owner · after …`.
   - Subagents: drop `tag`, the `--fam` style and the tag span; `title={`${agent.agentType}, for ${sessionDisplayTitle(session)}`}`.
   - Background: drop `tag`, the style and the tag span; `title={`Background command, for ${sessionDisplayTitle(session)}`}`.
   - Asks: `raiser` returns `sessionDisplayTitle(s)`, else `migrated`.
   - Remove the unused imports.
10. Unit tests: `test/web/live.test.ts` (withTag, taskFamily, chip name, leadTitle `'E2E session · idle'`, `'Second session · working · 1 subagent'`, commandTag), `test/web/describe.test.ts:40` (now reads the agent's name), `test/web/board-header.test.ts:89` (rename the test only if its name mentions letters). Same no-weakening rule as task 1.

## Task 3: e2e (ui gate: one test for the feature)

`test/e2e/ui.spec.ts`:

1. Update the Details test at ~1445-1461: `'○ Collect the screenshots · Draft the store notes'` (no `a1 `), the `.ip-dagent` regex without `a1 · `, drop the hue-bar and tag-colour assertions (they test what was removed), and keep the ◐ mark colour and animation assertions.
2. Update ~1797: the "No claimed step" group contains `Second session` (not `B`).
3. Add one test in the Board describe block, named `no session letter, character or session hue shows anywhere in the window`: enroll a second session with a title and an own-queue step (find how existing tests put a step in a session's own queue first), then:
   - on the Board: `.ip-char, .ip-tag, .ip-letter, .ip-work-tag, .ip-agent-tag` count 0, and the header's "No claimed step" group shows the session's title;
   - on the Project view (wide): the own-queue step's rail mark has accessible name `next, in the own queue of "<title>"` and text `◆`, and its row's `.ip-osess` contains the title; the same five selectors count 0.

## Checks (Sev runs them, Sigmund reruns)

- `npm run typecheck`
- `npm test`
- `npm run test:smoke`
- e2e narrowed to the touched and new tests, on port 4411, run the way `npm run test:e2e` does with `INPROGRESS_E2E_PORT=4411` and `-g`.
- `grep -rnE "sessionTag|agentTag|ownerTag|familyVar|--family-|<Character|ip-letter|ip-tag\b" src web test claude` returns nothing.
- `test/repo/no-em-dash.test.ts` passes (it is in `npm test`): no em dashes anywhere.

## Spec

Sigmund updates `docs/superpowers/specs/2026-10-12-board-and-asks-design.md` (lines ~132, ~302, ~311-312, ~397) himself.
