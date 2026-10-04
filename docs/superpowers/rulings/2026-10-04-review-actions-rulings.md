# Review actions: controller rulings

Decisions the controller took on Aiden's behalf while running `docs/superpowers/plans/2026-10-04-review-actions.md`,
in the order made. Aiden's own decisions are in the design note's "Decisions after the preflight" section. Format:
decision, why, what it costs if wrong. Review these and rework anything ruled wrongly.

1. Keep the node-size feedback in `Canvas.tsx` when the minimap goes (P2): only `MiniMap` and its Follow-off wiring
   are removed. React Flow hides a node until it has `measured` dimensions, and Canvas rebuilds every node object on
   each snapshot and on the 30 s clock, so without the feedback every card flickers and a focused card stops being
   focusable. The design note assumed the loop existed only for the minimap. Cost if wrong: about ten lines kept.
2. P3 starts only after both P1 and P2 have merged. P3 edits `src/server/repo/work.ts`, `src/server/briefing.ts` and
   tests that P1 changes. Cost if wrong: P3 waits for the slower of the two.
3. The no-focus hint reads `Name the step: tasks <id> …`, not `tasks #id …`: an unquoted `#` starts a comment in Bash
   and PowerShell. The CLI still accepts a quoted `#88`. Cost if wrong: none.
4. P1 exports `taskCommand(sessionId, …)` and gives `updateRules` an options object, so that P8 reuses both. Cost if
   wrong: none.
5. Allow rules (P1): `Bash(node <repo>/dist/cli/main.js tasks *)` and `PowerShell(node <repo>/dist/cli/main.js tasks *)`,
   with forward slashes. Uninstall finds them by pattern, and install strips task rules for another repo path before
   adding. When the repo path contains a space, install leaves the task rules out and says why, because an unquoted
   path cannot hold a space and a quoted one never matches in PowerShell. Cost if wrong: a repo with spaces in its
   path gets a permission prompt.
6. The `tasks` command never starts the server. When the server is unreachable it says InProgress starts with the next
   prompt and to run the command again then. Bare `node` may not be the Node that better-sqlite3 was built for
   (ruling 71 of the v1 rulings), so the server is only ever started by hooks, deploy or `start`. Cost if wrong: a
   rare retry.
7. Sessions enrolled through the skill learn the command from the skill: P1 writes the full command into the skill
   with `{{REPO}}` filled in and a `<session id>` placeholder. Cost if wrong: none.
8. P3 owns filtering the briefing's open tasks to live sessions (`endedAt === null`), so ended sessions' tasks never
   print as live work. Cost if wrong: none.
9. Trail rows (stale tasks and ended agents) stay neutral grey with no letter (P4), since an ended session's slot can be
   reused by a live one. Cost if wrong: a trail row can't be traced to its session by colour.
10. New P3 and P4 tests use a worker agent type such as `general-purpose`, never `Explore`, which P6 makes a reader.
    Cost if wrong: none.
11. E2E tests that need old timestamps move the browser clock with `page.clock.install({ time: Date.now() + offset })`
    before navigating, never `setFixedTime`, which stalls Follow's throttle. Cost if wrong: none.
12. Unowned queue markers (P5) use a neutral token, never `familyVar(null)`, which is session clay. The readers row
    (P6) uses `sessionTag(slot).toLowerCase()` with a fallback for a null slot. Cost if wrong: none.
13. P8 drops the sibling `Next:` lines only when an Up next line with at least one step is printed. Cost if wrong:
    none.
14. Migrations: P4 is 4, P6 is 5, and P8's "not yet briefed" marker is 6. All only add nullable columns, so
    `min_reader_version` stays 1. Cost if wrong: renumbering if the order changes.
15. Restarts: open sessions restart after P1 and P8, whose changes arrive with the briefing at session start. P6
    changes only what the hook script does, and hooks run the built script afresh on every event, so P6 needs no
    restart. Cost if wrong: one extra restart request.
