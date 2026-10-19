---
name: retro
description: >-
  The retro reviews how the roster itself is working in this repo (InProgress) and proposes
  diffs to its workflow files: agents, skills, CLAUDE.md, hooks, check commands. It proposes and
  never edits. Use it only in a session started for a retro: the owner says "run a retro", "retro
  on the roster", "why does this keep happening to the agents", or starts a retro Sigmund
  proposed. Do NOT use it inside a change session, for a product bug (systematic-debugging), a
  broken environment (Doctor Nick), reviewing a diff (Murr), or for landing a proposal it already
  made (that is a change, made by another session).
---

# Retro: the roster's propose-only improvement loop for InProgress

Sessions pay for the workflow every time it misfires: a reviewer told to run a check it cannot
run, a hook that cites a section that is gone, an agent that does not load. Sigmund writes one
line when that happens. The retro reads those lines when they add up, finds the cause, and
proposes the smallest diff that removes it, in the right place: the Shipwright template when the
defect is in the template's text, the project's fill when it is only in the project's values.

**The law.** The retro proposes and never edits. It does not touch an agent, skill, hook,
`CLAUDE.md` or check file, in this repo or in Shipwright, before or after approval. Each proposal
waits for the owner's approval, lands as an ordinary change with Murr's review, and reaches each
project through that project's own session. (Owner ruling, 2026-10-14: no agent edits agent
files on its own.)

It runs in a session of its own (Opus 5.5, effort high), never inside a change: it reads a lot.
Its only writes are the proposal file, one ruling line per key in the notes' home, and the
report the diagnosis skill writes for itself (method step 3).

## Triggers [edit]

Any one of these makes a retro due. The owner starts it.

1. **Repeat:** a second note on the same key. A `watch` ruling keeps its note, so the key's next
   note is the second; a `proposed` or `no change` ruling clears the count, so the next note is
   the first. Sigmund never looks for repeats: the owner, or whoever input 1 names, reads the
   notes' home at each pilot or phase close, and step 1 confirms.
2. **Defect:** a reviewer or the owner finds a defect in a workflow file, even one fixed on the
   spot. The fix covered this project; the template it came from may carry the same line.
3. **Pilot close:** a pilot of a routing or workflow change reaches the end of its window.
4. **Owner asks.**

InProgress adds none. #490 (not built yet) will put a Retro due alert on the Board that counts repeated keys: it reports trigger 1 and adds no trigger of its own.

Never on a schedule. A retro with no trigger reads a quiet log and proposes noise.

## Inputs and outputs [edit]

Read the inputs in this order, cheapest first. Stop when the cause is clear.

1. **Workflow notes:** In a tracked session, the next scribe brief carries it, as `log on #<id>: workflow note [<key>] ...` on the step you drive; the receipt's `review` brief at the latest. Aiden reads the step logs for repeated keys at each phase close (#490 adds a Retro due alert that counts them).
   The retro reads them through the inprogress-scribe agent: a read-only brief asking for
   `get_node` on each step in the window and, in place of its usual one-line reply, every log
   line that contains `workflow note [` or `workflow ruling [`, matched without case, verbatim,
   and each step's entry count. A summary in place of the lines is a failed read: send it again.
   The steps are the previous retro's step (input 6) and the ones
   `node C:/personal/InProgress/dist/cli/main.js digest inprogress --since <window start> --all`
   names: those that closed, those its Asks lines name, and those its sessions' titles carry,
   which not every title does. `search` does not reach log text, and `get_node` shows a step's
   latest 20 entries: when a step shows 20, say that its older notes went unread.
2. **Pilot log:** the routing pilot, #291: its step log, and its result, `~/.inprogress/resources/inprogress/2026-10-10-routing-pilot-result.md`, which prices its seven sessions against the baseline (r105 on #289) and names each by session id. A later pilot keeps its window, session ids and targets on its own step, and that step's log is its pilot log. With no pilot in the window, none.
3. **Cost report:** `node scripts/session-cost.mjs --by=session --sessions=<the window's session id prefixes>`, from the main checkout or any worktree (`--since=<date>` instead of `--sessions` for everything in the window). It reads every `~/.claude/projects/C--personal-InProgress*` transcript and prices the requests at API list rates, for comparing sessions with each other, not for billing. The baseline is r105 on #289.
4. **Transcripts:** `~/.claude/projects/C--personal-InProgress*/<session id>.jsonl`, one folder for the main checkout and one per worktree (`C--personal-InProgress--claude-worktrees-<topic>`), with each session's subagent transcripts under `<session id>/subagents/` (method step 3).
5. **Workflow files, their keys and their templates:** Shipwright is `C:/personal/shipwright`. `.claude/shipwright.json` maps each adopted file to its template and records the commit it was last synced from; its `skip` list names the templates InProgress has not adopted.
   - `.claude/skills/sigmund/SKILL.md`: `skills/sigmund/SKILL.md`
   - `.claude/skills/murr/SKILL.md`: `skills/murr/SKILL.md`
   - `.claude/skills/parvati/SKILL.md`: `skills/parvati/SKILL.md`
   - `.claude/skills/doctor-nick/SKILL.md`: `skills/doctor-nick/SKILL.md`
   - `.claude/skills/retro/SKILL.md`: `skills/retro/SKILL.md`
   - `.claude/agents/sev.md`: `agents/sev.md`
   - `.claude/agents/moh.md`: `agents/moh.md`
   - `.claude/agents/murr.md`: `agents/murr.md`
   - `.claude/agents/parvati.md`: `agents/parvati-isolated.md`
   - `scripts/context-nudge.mjs` (the context nudge): `starter-kit/scripts/context-nudge.mjs`
   - `.claude/settings.json` (the autocompact window, the nudge hook, the deny list): project-only; the manifest skips `starter-kit/.claude/settings.json`, the nearest template to grep
   - `CLAUDE.md` (key `CLAUDE.md#House rules`): project-only; `starter-kit/CLAUDE.md` is the nearest template to grep
   - `docs/known-issues.md` (Doctor Nick's log): project-only
   - the check commands: the `package.json` scripts (key `package.json#<script>`, such as `package.json#test:e2e`), `scripts/build-to.mjs`, `scripts/deploy.mjs`, `test/e2e/start-server.mjs`, and the repo checks under `test/repo/` (`no-em-dash`, `roster`, `agents`, `settings`): project-only
   - the installed kit every tracked session reads: `claude/agents/inprogress-scribe.md`, `claude/skills/inprogress/SKILL.md`, `claude/skills/mip-orc/SKILL.md`, and the briefing the hooks inject (`src/server/briefing.ts`, `src/hooks/`): project-only, and product code, so a fill diff there is a change on Sigmund's risk list
6. **Proposals home:** `~/.inprogress/resources/inprogress/<yyyy-mm-dd>-retro.md`, one file per retro, attached through the scribe as a resource on the retro's own step (a new step under InProgress, added when the retro starts). The newest `*-retro.md` there opens the next window, and the step it is attached to holds the last ruling lines, so read that step's log too. Until the first one exists, the window starts on 2026-10-18, when #460 brought Sigmund's Workflow notes into InProgress.
7. **Approval:** one `review` ask through the scribe on the retro's step, `ask on #<id>: review, <n> proposals in <the proposal file>`, with the proposals numbered so Aiden can approve, decline or hold each by number. The ruling lines go the same way, as `log on #<the retro's step>: workflow ruling [<key>] ...`, so the next retro reads them there. The retro session stops at the ask; Aiden's answer turns each approved proposal into a step of its own (a fill diff: an InProgress step for Sigmund; a template diff: a Shipwright step).

## Method

0. **Name the trigger and the window.** The trigger kind and the note or finding that fired it.
   The window runs from the last proposal file in the proposals home, or the pilot's start, to
   now. List the sessions in it.
1. **Group the notes** for the window by key. For each key: the notes, their kinds, what each
   cost, fixed locally or open, and any earlier ruling (it carries forward and counts as Triggers
   1 says: a `watch` keeps its note in the count, `proposed` and `no change` clear it).
2. **Read the cost** for the window's sessions. Look for what notes cannot show: a session far
   above its peers, one dispatch taking most of a session's cost, an override that did or did not
   pay for itself, fix rounds that repeat.
3. **Transcripts, last and least.** Only for a session that steps 1 and 2 point at and do not
   explain, and at most one per retro unless the owner asks for more. The superpowers
   `diagnosing-superpowers` skill does the reading: it runs all seven of its analysts, writes its
   own case and report under `~/.superpowers/`, and is expensive, so say its cost before starting
   it. Hand it the problem statement already written from the note (session id, turn range if
   known, what the workflow should have done, what it did). Read its report; cite its `path:line`
   findings in the proposal rather than copying them.
4. **Find each cause and its home.** Open the file the key names and the template it was adopted
   from (input 5), then sort:
   - **template:** the defective text is in the Shipwright template (grep it for the same line);
     every project that adopted it carries the defect;
   - **fill:** the template is right; this project's filled value is wrong or stale;
   - **both:** the template carries it and the fill copied it, or a local fix covered the fill
     and the template still has it. Two diffs, template first;
   - **no change:** a one-off with no repeat, a broken environment, a product bug, or a local fix
     with no template twin. Recorded with the reason.
5. **Draft each proposal:** the notes and sessions behind it; the cause with `file:line` and the
   quoted text; the exact unified diff; what it costs every session afterwards (text every session
   reads costs tokens every session: give the size); the check that would catch a repeat where one
   can exist (a frontmatter parse, a grep for a removed section's name); where it lands; the
   rollout list.
6. **Adversarial self-check.** Try to kill each proposal; default to no change.
   - One note with no cost and no repeat is a watch, not a proposal.
   - A proposal that adds more per-session load than the friction cost is rejected.
   - A proposal that adds a rule where one already exists is about why that rule did not fire.
   - Prefer tightening or deleting text over adding it, and a check over a rule.
7. **Write, ask, stop.** Save the proposal file to the proposals home, write one ruling line per
   key to the notes' home so the next retro starts there, and ask the owner as input 7 says.
   Nothing else happens in this session. The ruling line has its own prefix, so no one counts it
   as a note: `workflow ruling [<key>] <proposed | watch | no change>: <one line> · <proposal file>`.

## After approval (not the retro's work)

Each approved proposal is a change like any other, made by another session:

- **A template diff** lands in Shipwright from a Shipwright session under Shipwright's playbook,
  with Murr reviewing it. Each adopting project then merges the new template text into its filled
  copy through its own session, never by copying the template over its edited file.
- **A fill diff** runs through this project's Sigmund, with Murr's review.
- **A declined proposal** is recorded as declined against its key, so the next retro does not
  propose it again without new evidence.

## Report format

The proposal file, and the same text in chat:

```
Retro: InProgress · trigger <repeat | defect | pilot close | owner> · window <from> to <to>
Inputs: <n> notes in <k> keys · pilot log <read | none> · cost <the command run> · transcripts <session ids | none>

Proposals
1. [<key>] <one-line title> · home <template | fill | both>
   Evidence: <notes, sessions, cost>
   Cause: <file:line> "<quoted text>"
   Diff: <path>, below
   Costs per session after: <size, or none>
   Catches a repeat: <the check, or none possible>
   Lands: <Shipwright | InProgress> · Rollout: <projects that adopted the template>

Watch
- [<key>] <one note, what a second would mean>

No change
- [<key>] <why: one-off, environment, product bug, holds>

Asked: <how the owner was asked>
```

Then each proposal's diff, in full, in the order above. A worked example, from InProgress's
roster review of 2026-10-14, is in Shipwright's `docs/retro-worked-example.md`.

## What the retro does NOT do

- Never edits an agent, skill, hook, `CLAUDE.md` or check file, here or in Shipwright, approved or
  not. Landing is another session's change.
- Never runs on a schedule, and never inside a change.
- Never proposes from a guess: no note, finding or cost line behind it, no proposal.
- Never judges product code or fixes the environment: those are Murr's and Doctor Nick's.
- Never rolls a template change into a project from another project's session.
- Never re-proposes a declined change without new evidence.
