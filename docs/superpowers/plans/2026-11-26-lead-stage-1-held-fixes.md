# Held cards: fixes after Murr (#743)

Murr's main pass on `cf08e1b..c5291a0` (held cards and the publish yes): three majors, minors, owner-calls. Every fix is
decided here. Worktree `.claude/worktrees/lead-stage-1-desk`, branch `lead-stage-1-desk`. House rules; no em dashes;
never `~/.inprogress`, 4317, 4399, the real `t3` or `claude` in a test. Each fix gets a unit test that fails without it.

## The rule behind all of it

A yes covers exactly what Aiden saw, as it was when he could first see it. Go ahead is offered only where a yes can
release the command; where it cannot record a yes, nothing is answered and the card says why.

## Majors

**M1. A publish yes is keyed on what goes out.** `src/server/lead/carry.ts:65` and `src/server/lead/landing.ts:237`.
- A publish can take a yes only when `publishesFolderPackage` is true for its command and the publish folder has no
  uncommitted or untracked (not ignored) changes (`git status --porcelain` empty in that folder). Otherwise no yes, with
  the reason: `this publish names another package, or the folder has changes not committed: run it yourself`.
- The key is the tree of HEAD plus the publish folder's path inside the repo (`git rev-parse --show-prefix`) plus the
  package's name and version from that folder's package.json: `<tree>:<prefix>:<name>@<version>`. The landing check
  computes the same key for the hold, from the held command's own folder (`match.folder`), and `readSessionYeses` is
  given that folder for a held item, never `session.cwd`.
- A yes for a publish is recorded only through a held item (the window or `--send` to a held line). `--yes publish` on
  a review ask is refused with that reason; the rules line in `src/core/lead-rules.ts` moves the publish clause from the
  review line to the held line.
- Tests: two packages in one repo, a yes for a does not clear b; a tarball or workspace publish takes no yes; a dirty
  folder takes no yes; a yes on another repo's folder does not clear this repo's publish.

**M2. A window click is anchored at the hold.** `src/server/routes/window.ts:274`. The "changed after his word" check
uses the held item's `createdAt` (the earliest moment the card existed), as the Voice path uses the line's `doneAt`.
The decision row keeps `saidAt` = now. Test: a commit between the hold and the click gets no yes.

**M3. Push and deploy yeses are keyed as the landing check keys them.** `src/server/lead/carry.ts:64` reads each
action's key with the landing check's own `keyOf` for that action (`landing.ts:203-217`): a push on what it would push
(`origin/<branch>..<branch>` once pushed), a deploy on `<live>..main`. Push with nothing to push needs no yes. Tests: a
branch pushed before, with a new commit, released by one Go ahead; a deploy from the main checkout released by one Go
ahead.

## Minors

- `heldCards` (`carry.ts:129`, `:94`): read the project's held lines once into a ref-to-command map (as
  `morning.ts:158-170` does), shared with `heldScope` and the morning list (one builder). Clip `command` to 2,000
  characters. The snapshot carries `heldTotal` (all waiting, uncapped) and the count and empty state use it.
- Focus after an answer never lands on a Go ahead: `HeldActions.tsx:30` and `AskActions.tsx:44` hand off to the next
  held card's `Not yet` (or the next ask's Answer), never Go ahead. `HeldActions` gets AskActions' `?? input` fallback.
- `web/src/board/focus.ts:5-8` `allSent` counts `[data-ask], [data-held]`.
- The route (`window.ts`) runs the lead and C:\work checks (`requireAnswerLead`, `WORK_PROJECT`) before any git. The
  snapshot leaves out held cards of a C:\work project, and of a step that is parked or shelved (as asks are hidden).
- The window title's count (`web/src/App.tsx:123-131`) includes held cards.
- Debt: `routes/lead.ts:200-202` calls `heldYesActions`; `needsTiles.ts` imports `needTime` from `src/core/taskState.ts`
  (export it); one `leadSends` helper clears untried Voice lines for both `carry.ts:198` and `deskProducers.ts:158-161`;
  the `readYeses` comment in `lead-commands.ts:162-169` says a publish is keyed on what goes out.

## Owner-calls, decided

- **Go ahead only where a yes can release the command.** A held command whose actions are not all yes-able (pr-merge,
  delete, repo, a playbook line, a public push, a publish that cannot take a yes under M1) shows only `Not yet`, and
  under its command the line `Only you can run this one: run it yourself, or turn the round off.` The route refuses
  `go` for it (409, nothing changed).
- **A Go ahead that cannot record a yes changes nothing.** When `readSessionYeses` gives no yes for an action (changed
  after the hold, no step, a read that failed), the route answers 409 with the reason and records nothing: the item
  stays, the session is not told. The card shows the reason in its error line and keeps both buttons.
- **The window's answer is recorded as the window**: the write's actor is `window`, its decision's said-where `window`.
- A Voice line the sender is already trying is still spoken after a window answer, and his reply to it gets "already
  closed". Kept as is.

## Checks

`npm run typecheck`, `npx vitest run test/server/lead-*.test.ts test/web/*.test.ts test/cli/lead.test.ts
test/core/lead-rules.test.ts`, `npm test`, `npm run test:smoke`, and the e2e test "a held command shows as a card in
Needs me..." alone on port 4413 (extend it: a card with only Not yet for a playbook-held command).
