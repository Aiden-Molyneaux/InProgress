# Held cards: second fixes after Murr's re-check (#743)

Murr's re-check of `6a1a6c5..2d27b9f`: three majors, all one gap: the yes is read at click time from things that can
drift (the session's cwd now, commit dates, a key blind to the publish flags). Every fix is decided here. Same rules
as `2026-11-26-lead-stage-1-held-fixes.md`.

## The fix: a held command remembers what it would do

**K1. Keys stored at the hold.** When `holdCheck` holds a command whose actions can take a yes, it stores, with the
held item, the folder and branch the hold resolved (`match.folder`, the branch it read) and, per action, the key the
hold's own `checkLanding` computed (`answer.patchId`, the publish key included; null when there was none). Stored in
the item's outcome after the what: `held: <why>\nwhat: <what>\nkeys: <one-line JSON {"folder","branch","keys":{action:
key|null}}>`. `heldWhatOf` reads the what up to `\nkeys: `; a new `heldKeysOf` reads the JSON. An item with no stored
keys (none exist outside tests: nothing has landed) offers no Go ahead.

**K2. A yes only for exactly what was held.** At a Go ahead in the window and at `lead answer --send` to a held line,
for each action of the held command: compute the key now with the stored folder and branch (never the session's cwd);
record a yes only when it equals the stored key and the stored key is not null. Any other case: the window answers 409
with `CHANGED_AFTER` (or the stored why) and records nothing; the Voice path records no yes for that action and says
`No yes recorded for <action>: it changed after it was held.` This replaces the commit-date anchor for held items in
both paths (the review path keeps its own). A push with nothing to send stays "needless".

**K3. A publish key names where it goes.** `publishKey` adds the normalized destination flags of the held command:
`--dry-run` (present or not), `--registry=<v>`, `--tag=<v>`, `--access=<v>`, `--publish-branch=<v>` (any spelling, `=`
or space, lower-cased flag names), sorted; `--otp` is left out. The landing check, called by a later hold with that
command's own flags, computes the same key, so a yes on `--dry-run` never clears a real publish, and one registry never
clears another. `checkLanding` therefore takes the held command's segment (or its parsed flags) for a publish.

## Minors

- `landing.ts:181`: `git --no-optional-locks status --porcelain --untracked-files=all -- .`
- `hold.ts:86` `heldLines`: keep the newest line per ref, not the oldest.
- Debt: `publishKey` reads package.json with `readFile` (async), as `packageOf` does.

## Tests (each fails without its fix)

- K1/K2: a monorepo session holds bare `npm publish` in `packages/a`; its session's cwd then moves to `packages/b`; Go
  ahead records the yes for a, and a later publish in b is held. Two folders with the same name@version: a yes for one
  does not clear the other.
- K2: a deploy held, then main fast-forwarded to commits dated before the hold; Go ahead is refused (409) and records
  nothing; by the Voice, no yes for deploy. A held push on branch A, the folder switched to branch B; Go ahead refused.
- K3: a yes on `npm publish --dry-run` does not clear `npm publish --access public`; a yes for `--registry X` does not
  clear plain `npm publish`; a yes for `npm publish --tag beta` clears `npm publish --tag=beta`.
- The newest held line per ref decides Go ahead.

## Checks

`npm run typecheck`, `npx vitest run test/server/lead-*.test.ts test/web/*.test.ts test/cli/lead.test.ts
test/core/*.test.ts`, `npm test`, `npm run test:smoke`, and the e2e test "a held command shows as a card in Needs me"
alone on port 4415.
