# The guard: second fixes after Murr (#743)

Murr's main pass on `6146a02..2ff2634`: one blocker, two majors, minors. Every fix is decided here. Same rules as
`2026-11-26-lead-stage-1-guard-fixes.md`. Scope rule from here on: the guard covers what a session does by accident or in
the ordinary way; a session deliberately getting round it (an alias, PATH, HOME, a settings file) is out of scope under
Aiden's "forget security for now", named on the results page, not built.

## G1 (blocker). A deploy script is the repo's own

`src/server/lead/landing.ts` `deployScript`: `node <path>/deploy.mjs` counts as the deploy only when the path resolves,
against the command's folder, to `<show-toplevel>/scripts/deploy.mjs` of that folder's checkout (forward slashes, case
ignored); any other path reads null (held, no key). `npm run deploy` is unchanged. Test: `cd <main> && node
<main>/.claude/worktrees/x/scripts/deploy.mjs` is held with no key; `node scripts/deploy.mjs` in the main checkout keys.

## G2 (major). A held action runs as a command of its own

The key and the clear are read when the hook runs, before the commands in front of the held one have run. So a push,
merge, deploy or publish is keyed or cleared only when every command before it in the same line is a folder change
(`cd`, `Set-Location`, `pushd`, `Push-Location`, `popd`) or one of these read-only commands: `git status`, `git log`, `git
diff`, `git show`, `git fetch`, `git rev-parse`, `git branch --show-current`, `npm test`, `npm run typecheck`. Anything
else in front (a commit, a checkout, a config, a file write, any other command) gives a **split** answer:

- the hook denies the command with `Run the <action> as a command of its own: InProgress reads it before the commands in
  front of it have run.` (no "It waits for his word", no "do not try another way");
- no held item, no card, no Voice line: the session simply runs the commands before it, then the held action alone,
  which is then read exactly.

A1's "this command does more than the publish" becomes this same split answer. Commands after the held one are fine
(they run after it). The server returns a split answer kind the hook prints verbatim; `src/hooks/hold.ts` and its tests
change for it.

## G3 (major). A rollback is Aiden's own act

A rollback never takes a yes: `yesCanRelease` is false when `deployScript(segment)` is `rollback`, its key prefix is
null, the card offers Not yet alone, the Voice records no yes. It is held always (A5). Flip the test at
`test/server/lead-keyed.test.ts:211`. The plan's earlier "only his yes on that rollback releases it" is withdrawn.

## Minors

- `src/core/hold.ts`: families for `yarn npm *`, `corepack *`, `*/npx *`, `*\npx *` (both shells); `packageRun` reads
  `yarn workspace <name> <script|publish>`. `bun publish` is named as a gap, not built.
- PowerShell examples that lock in `$r = git push origin main`, `$r = npm publish`, `$r = npm run deploy` as held.
- `carry.ts` (around 202): when the hold stored a string key and the key reads null now, answer `CHANGED_SINCE_HELD`.
- `landing.ts` `deploysFromMain`: `status --porcelain --untracked-files=all`.

## Proof

Re-run `scripts/lead-proof/hooks.mjs --each` (as the last proof: scratch settings, scratch server on a port from 4410
to 4419, claude-haiku-5-5, the Claude Code session variables unset) with these added: `git add -A && git commit -m x &&
git push` (denied with the split text, and the commit made, the push not), `npm run rollback`, `node
.claude/worktrees/x/scripts/deploy.mjs` from the main checkout's scratch twin, `yarn npm publish`, `corepack pnpm
publish`. Evidence file path in the report.

## Checks

`npm run typecheck`; `npx vitest run test/server/lead-*.test.ts test/core/*.test.ts test/hooks/*.test.ts
test/cli/*.test.ts`; `npm test`; `npm run test:smoke`; the held-card e2e alone on a port from 4410 to 4419; the proof.
