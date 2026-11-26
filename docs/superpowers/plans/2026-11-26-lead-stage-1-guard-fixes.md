# The guard: fixes after Murr's "one more look" (#743)

Aiden asked for one more look before the stage lands. Murr, on `9232719..9e3f13a` and the whole held-yes path: four
majors. None is a regression against today (today nothing is held), but the guard is weaker than it claims. Every fix is
decided here. House rules; no em dashes; never `~/.inprogress`, 4317, 4399, the real `t3` or `claude` in a unit test.
Each fix gets a test that fails without it.

## The rule behind all of it

A command is keyed (so a yes can match it, or Landing can clear it) only when InProgress can read exactly what it does.
Anything it cannot read exactly (settings changed in the command, options in front of the tool, the wrong folder) is held
with no key: it is Aiden's to run himself, or to release by turning the round off. Over-holding only takes a yes away.

## Part A: what gets a key (server: src/server/lead/hold.ts, landing.ts, carry.ts, routes/lead.ts)

**A1. A publish is keyed only when the rest of its command is folder changes.** Every other part of the held command
(the parts heldActions splits it into) is `cd`, `Set-Location`, `pushd`, `Push-Location` or `popd`; otherwise held with no
key, why `this command does more than the publish: run it yourself`. The npm_config_ guard stays, with its own why:
`npm's settings are changed in this command: run it yourself`; the card's npm_config_ test applies only when a publish is
among the matches. A repeated value flag (`--tag a --tag b`) makes `publishesFolderPackage` false.

**A2. A push or merge with git's options or environment changed is held with no key, whatever it touches.** In the
segment: anything before `git`, or a git global option other than `-C <dir>`, `--no-pager`, `-P`, `-p`. In the whole
command: any part that sets a `GIT_` variable (`GIT_X=`, `export GIT_X`, `set GIT_X`, `$env:GIT_X`, any case). Why: `this
command changes how git runs: run it yourself`. This holds even with Landing on and nothing risky in the change.

**A3. A force push is held and keyed apart.** `-f`, `--force`, `--force-with-lease` (any form), or a `+` refspec: held
always (why `a force push overwrites history`), with `force` in its key, so a yes on a plain push never clears it.

**A4. A merge of a name that is also a tag at another commit takes no key**: in `readChange`, the key is computed only
when `rev-parse --verify <name>^{commit}` equals `refs/heads/<name>`; else held, why `the name is a tag as well as a
branch: run it yourself`.

**A5. A deploy is keyed, or cleared, only from the main checkout on main with nothing uncommitted.** The folder's
`--show-toplevel` equals the parent of its `--git-common-dir`, HEAD is `refs/heads/main`, `status --porcelain` is empty;
else held with no key, why `a deploy runs from the main checkout, on main, with nothing uncommitted`. The script name
(`deploy` or `rollback`) is part of the key. **A rollback is always held** (why `a rollback is Aiden's`), and only his
yes on that rollback releases it. The card's what for a deploy names the script.

**A6. The Voice follows the card's rule.** `lead answer --send` to a held line where `heldGoAhead` is false records no
yes, says `No yes recorded: only Aiden can run this one.`, and answers nothing else (the item stays).

**Minors.** Drop the push-null clause in `keyedForYes` (a held push never has nothing to send). The judge keeps no key
when the check throws: test it through `holdCheck` (a push of a missing branch: `goAhead` false). `test/held-keys.ts`
writes nothing for an action whose check threw, as the hold does. Move heldGoAhead's doc block to it and state its rules.

## Part B: what gets held at all (src/core/hold.ts and the hook `if` families; risk list)

**B1. The publish and deploy rules see every spelling.** `npm`, `pnpm`, `yarn` with `.cmd`, `.exe` or `.ps1`, as
`program()` strips for git; options before the subcommand (`npm --registry x publish`, `npm -w a publish`, `npm --tag next
publish`); `npx [-y] npm[@<v>] publish` and `pnpm dlx`/`yarn dlx` the same. `npm run deploy` and `npm run rollback`
likewise (`npm.cmd run deploy`, `npm --silent run deploy`).

**B2. The hook starts for them.** Widen the PreToolUse `if` families the installer writes (Bash and PowerShell) so each
spelling in B1, and a segment that starts with an environment assignment (`NPM_CONFIG_X=y npm publish`, `GIT_DIR=x git
push`), starts the hold; the server still decides. Update the installer's strict-gate tests.

**B3. Proved under the real Claude Code.** Re-run `scripts/lead-proof/hooks.mjs` (with `--each`) in a scratch settings
file and repo, as before (never the live hooks or server), with these added commands: `npm.cmd publish`, `npm --registry
https://x.invalid publish`, `npx -y npm@10 publish`, `NPM_CONFIG_REGISTRY=https://x.invalid npm publish`, `GIT_DIR=.git git
push`, `git -c remote.origin.pushurl=x push origin main`, `git push -f`, `npm.cmd run deploy`. Each must be denied before
it runs; nothing runs. Keep the evidence file in the scratchpad and report its path.

## Checks

`npm run typecheck`; `npx vitest run test/server/lead-*.test.ts test/core/*.test.ts test/cli/*.test.ts test/hooks/*.test.ts
test/web/*.test.ts`; `npm test`; `npm run test:smoke`; the held-card e2e alone on a port from 4410 to 4419; the hook proof
of B3.
