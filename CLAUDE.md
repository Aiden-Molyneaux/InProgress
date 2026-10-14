# InProgress: working rules

Change work runs through Sigmund (`.claude/skills/sigmund/`). Routing, overrides and the ship gates live there. The house rules below apply to every session and to every subagent that loads this file; Moh and Parvati skip it and carry their own.

## House rules

- Test gates by label, branch and landing rules are in the InProgress playbook, which the session briefing shows.
- No em dashes (U+2014) or their HTML entities in any file: `test/repo/no-em-dash.test.ts` scans every file.
- Work only in your own worktree under `.claude/worktrees/`. A session spawned from a chip starts in one; otherwise create it with `git worktree add .claude/worktrees/<topic> -b <topic> main`. The main checkout takes only merges, deploys and `claude:install`. Uncommitted changes outside your worktree belong to another session: don't stage them, ask about them or mention them. Stage explicit paths only.
- Deploy and `claude:install` run only from the main checkout: the installed hooks bake in its absolute path.
- `node scripts/session-cost.mjs --by=session --sessions=<id prefixes>` prices sessions from their transcripts at list rates. The baseline is r105 on #289.
