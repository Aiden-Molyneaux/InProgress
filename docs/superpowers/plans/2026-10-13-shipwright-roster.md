# Shipwright roster adoption Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace InProgress's four routed agents and the routing sections of `CLAUDE.md` with the Shipwright roster: Sigmund as the change facilitator skill, and Sev, Moh, Murr and Parvati as agent wrappers, copied from Shipwright's templates and filled with InProgress's edit points.

**Architecture:** Prose and config only. The templates are copied verbatim from Shipwright `main` (after its `roster` branch merged) into `.claude/skills/` and `.claude/agents/`, then every `{{UPPER_SNAKE}}` edit point is filled with the text written out in this plan and each `[edit]` section is reworded where InProgress's rules differ. `CLAUDE.md` shrinks to one Sigmund line plus the house rules; Roles, Routing, Overrides, Evidence, Session rhythm and Handoff live in the InProgress copy of Sigmund. Two repo tests pin the shape. The mip-orc skill learns the handoff line.

**Tech Stack:** Markdown with YAML frontmatter read by Claude Code as a skill and as subagents; vitest repo tests under `test/repo/`; shell greps in Git Bash.

**Spec:** Shipwright `docs/roster-spec.md` (approved by Aiden, 2026-10-13), §4 the InProgress column. The templates and their edit points: Shipwright `docs/roster-build-plan.md` ("The edit points" table, Tasks 1 to 5). Decisions of 2026-10-14 are logged on #423 and summarised in the handoff `~/.inprogress/resources/shipwright/2026-10-14-plan-the-inprogress-adoption.md`.

**InProgress step:** #421 (project shipwright). Tasks 1 to 5 are one branch; Task 6 lands it.

## Global Constraints

- Work only in the worktree `C:/personal/InProgress/.claude/worktrees/roster-plan` (branch `roster-plan`, cut from `main` at `ec91140`). Never edit the main checkout. `node_modules` resolves from the main checkout.
- The copy source is `C:/personal/shipwright` on `main` after the merge of its `roster` branch (Task 7 of the templates plan; #417, #418 and #419 done). Set `SW=C:/personal/shipwright` once per shell and record `git -C $SW log --oneline -1` in Task 2's and Task 3's commit messages. Do not start Task 2 or 3 before that merge exists.
- Copy the templates, never another project's edited files (spec §6). Fill, do not rewrite: a line this plan does not name stays as the template has it. Keep the `[edit]` markers in headings and bold leads; they show a later diff against the template what is project text.
- No em dashes (U+2014) or their HTML entities in any file: `test/repo/no-em-dash.test.ts` scans every file. The `murr` and `parvati` skills arrive with em dashes and Task 3 strips them. Define once per shell: `EMDASH=$(printf '\xe2\x80\x94')`.
- Edit points are spelled exactly as the templates spell them; after Tasks 2 and 3, `grep -rn '{{' .claude/agents .claude/skills` prints nothing.
- Agent frontmatter pins full model IDs (`claude-sonnet-5-5`, `claude-haiku-5-5`) and sets `effort`; `test/repo/agents.test.ts` checks both. Aliases appear only in Sigmund's override prose.
- Branch label: **integration** (the branch changes `claude/skills/mip-orc/SKILL.md`, which `claude:install` ships). Checks: `npm run typecheck`, `npm test`, `npm run test:smoke`. The deploy in Task 6 decides what runs again from the changed files.
- The implementer never commits, merges, pushes, stashes, resets, checks out, deploys or runs `claude:install`; the main session commits after each task's checks, staging explicit paths only. Commits end with `Co-Authored-By: Claude <model of the committing session> <noreply@anthropic.com>`.
- Claude Code reads agents and skills from the main checkout, so this branch is still reviewed by the old `code-reviewer` (on `opus`: the diff touches `claude/`), and the first Sigmund session starts only after Task 6's merge, deploy and `claude:install`.
- Tasks 1 to 5 run in sequence in the one worktree (Tasks 2 and 3 are large verbatim writes for the `implementer`; the main session may take 1, 4 and 5 itself). Task 6 is the main session's.

## Review Focus

Each line names the failure, the behaviour a user of this repo expects, and the test that pins it.

1. A `{{PLACEHOLDER}}` survives in a frontmatter `description:`; Claude Code would show it in the agent picker. Expected: none anywhere under `.claude/agents` and `.claude/skills`. Pinned by `test/repo/roster.test.ts` "leaves no edit point unfilled" (Task 1).
2. An agent's `skills:` key names a skill whose folder is spelled differently (`murr` vs `Murr`); the wrapper would load without its method. Expected: every `skills:` name has `.claude/skills/<name>/SKILL.md`. Pinned by `test/repo/roster.test.ts` "preloads only skills that exist" (Task 1).
3. The copied `murr` or `parvati` skill keeps one em dash in a line the strip missed (a heading, a report template line). Expected: zero. Pinned by `test/repo/no-em-dash.test.ts` (existing) and Task 3's grep.
4. `CLAUDE.md` keeps a `## Routing` or `## Overrides` heading beside the Sigmund line, so orchestrator and research sessions load routing they do not use. Expected: one Sigmund line, no routing headings. Pinned by `test/repo/roster.test.ts` "keeps one Sigmund line in CLAUDE.md" (Task 1).
5. The mip-orc edit breaks the installed kit (a malformed line, a changed heading the smoke suite greps). Expected: `npm run test:smoke` green after Task 4. Pinned by the existing smoke suite, run in Task 4 step 3.

## File structure

| Path | Change | Responsibility |
|---|---|---|
| `test/repo/roster.test.ts` | create | No `{{` under agents and skills; every `skills:` key resolves; Sigmund exists; CLAUDE.md shape |
| `test/repo/agents.test.ts` | modify line 25 | The exact set becomes `['moh.md', 'murr.md', 'parvati.md', 'sev.md']` |
| `.claude/skills/sigmund/SKILL.md` | create | The InProgress Sigmund, copied from Shipwright `skills/sigmund/SKILL.md` and filled |
| `.claude/agents/sev.md`, `moh.md`, `murr.md`, `parvati.md` | create | Copied from Shipwright `agents/sev.md`, `moh.md`, `murr.md`, `parvati-isolated.md` and filled |
| `.claude/skills/murr/SKILL.md`, `.claude/skills/parvati/SKILL.md` | create | Copied from Shipwright `skills/murr/`, `skills/parvati/`, filled, em dashes stripped |
| `.claude/agents/explorer.md`, `implementer.md`, `code-reviewer.md`, `screen-reviewer.md` | delete | Replaced by the roster |
| `CLAUDE.md` | rewrite | One Sigmund line and the house rules |
| `claude/skills/mip-orc/SKILL.md` | modify lines 63 and 65 | The handoff line "Run this through Sigmund." |
| `docs/superpowers/specs/2026-10-09-dev-session-routing-design.md` | modify line 3 | A status line: agents and routing superseded; hook, window, cost script and worktree rule stand |

Nothing in `src/`, `scripts/` or `test/` outside `test/repo` names the old agents by file: the words "implementer" and "explorer" elsewhere (`src/server/open-path.ts`, `test/scripts/session-cost-lib.test.ts`, `test/web/live.test.ts`) are fixture text or the file explorer, and stay. `claude/skills/inprogress/SKILL.md` has no handoff first-line wording (only the resource line example at :28 and the attach rule at :36), so it does not change.

---

### Task 1: The repo tests (red until Tasks 2 and 3 land)

**Files:**
- Create: `test/repo/roster.test.ts`
- Modify: `test/repo/agents.test.ts:25`

**Interfaces:**
- Produces: the file names and phrases Tasks 2 to 4 must satisfy: `.claude/skills/sigmund/SKILL.md`; `.claude/agents/{moh,murr,parvati,sev}.md`; the CLAUDE.md phrase `Change work runs through Sigmund`; the absent headings `## Routing`, `## Overrides`, `## Session rhythm`, `## Handoff`.

- [ ] **Step 1: Write `test/repo/roster.test.ts`**

```ts
// The roster (CLAUDE.md's one Sigmund line; Shipwright docs/roster-spec.md): the copied templates are filled, every
// wrapper's skill exists, Sigmund exists, and CLAUDE.md no longer carries the routing sections that moved into him.
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const repo = fileURLToPath(new URL('../..', import.meta.url));
const agentsDir = join(repo, '.claude', 'agents');
const skillsDir = join(repo, '.claude', 'skills');

/** Every file under `dir`, recursively, as absolute paths; none when `dir` is missing. */
function filesUnder(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? filesUnder(join(dir, e.name)) : [join(dir, e.name)]));
}

const read = (file: string): string => readFileSync(file, 'utf8').replace(/\r\n/g, '\n');

describe('the roster', () => {
  it('leaves no edit point unfilled under .claude/agents and .claude/skills', () => {
    const unfilled = [...filesUnder(agentsDir), ...filesUnder(skillsDir)].filter((f) => read(f).includes('{{'));
    expect(unfilled).toEqual([]);
  });

  it('preloads only skills that exist', () => {
    const wrappers = filesUnder(agentsDir).filter((f) => /^skills:/m.test(read(f)));
    expect(wrappers.length, 'murr and parvati preload their skills').toBe(2);
    for (const file of wrappers) {
      const name = read(file).match(/^skills:\s*(\S+)\s*$/m)?.[1] ?? '';
      expect(existsSync(join(skillsDir, name, 'SKILL.md')), `${file} preloads ${name}`).toBe(true);
    }
  });

  it('has Sigmund', () => {
    expect(existsSync(join(skillsDir, 'sigmund', 'SKILL.md'))).toBe(true);
  });

  it('keeps one Sigmund line in CLAUDE.md and no routing sections', () => {
    const text = read(join(repo, 'CLAUDE.md'));
    expect(text).toContain('Change work runs through Sigmund');
    for (const heading of ['## Routing', '## Overrides', '## Session rhythm', '## Handoff']) expect(text).not.toContain(heading);
  });
});
```

- [ ] **Step 2: Change the exact set in `test/repo/agents.test.ts`**

Line 25, from:

```ts
    expect(files).toEqual(['code-reviewer.md', 'explorer.md', 'implementer.md', 'screen-reviewer.md']);
```

to:

```ts
    expect(files).toEqual(['moh.md', 'murr.md', 'parvati.md', 'sev.md']);
```

Line 1's comment, from `// The routed agents (CLAUDE.md, Routing):` to `// The roster's agents (.claude/skills/sigmund/SKILL.md, Model routing):`.

- [ ] **Step 3: Run the two files and confirm they are red for the right reasons**

```bash
npx vitest run test/repo/roster.test.ts test/repo/agents.test.ts
```

Expected: `agents.test.ts` "holds exactly the routed agents" fails (the old four are present); `roster.test.ts` "preloads only skills that exist" fails (0 wrappers), "has Sigmund" fails, "keeps one Sigmund line" fails; "leaves no edit point unfilled" passes (nothing to scan). `npm run typecheck` passes.

- [ ] **Step 4: Commit** (main session)

```bash
git add test/repo/roster.test.ts test/repo/agents.test.ts
git commit -m "test: the roster's shape, red until the templates are copied (#421)"
```

---

### Task 2: Sigmund for InProgress

**Files:**
- Create: `.claude/skills/sigmund/SKILL.md` (copied from `$SW/skills/sigmund/SKILL.md`)

**Interfaces:**
- Consumes: the template's placeholders `{{PROJECT}}`, `{{RISK_STATEMENT}}`, `{{RISK_LIST}}`, `{{HARD_ORDERING_LIST}}`, `{{BRANCH_MODEL}}`, `{{PLAN_HOME}}`, `{{CHECKS}}`, `{{VERIFY_PORTS}}`, `{{OWNER_PORTS}}`, `{{SHIP_POLICY}}`, `{{MERGE_GATE}}`, `{{SESSION_RHYTHM}}`, `{{HANDOFF}}`, and its section `## Adopting this template`.
- Produces: the phrases Task 4's CLAUDE.md and mip-orc point at: `Run this through Sigmund` (two occurrences, from the template).

- [ ] **Step 1: Copy**

```bash
mkdir -p .claude/skills/sigmund && cp "$SW/skills/sigmund/SKILL.md" .claude/skills/sigmund/SKILL.md
grep -o '{{[A-Z_]*}}' .claude/skills/sigmund/SKILL.md | sort -u | tr '\n' ' '
# {{BRANCH_MODEL}} {{CHECKS}} {{HANDOFF}} {{HARD_ORDERING_LIST}} {{MERGE_GATE}} {{OWNER_PORTS}} {{PLAN_HOME}} {{PROJECT}} {{RISK_LIST}} {{RISK_STATEMENT}} {{SESSION_RHYTHM}} {{SHIP_POLICY}} {{VERIFY_PORTS}}
```

If the list differs, stop and report it: the template moved and this plan's fills need a look.

- [ ] **Step 2: `{{PROJECT}}`** everywhere (the description and the title):

```bash
sed -i 's/{{PROJECT}}/InProgress/g' .claude/skills/sigmund/SKILL.md
```

- [ ] **Step 3: The prime law.** Replace the whole paragraph that starts `**The prime law [edit].**` with:

```markdown
**The prime law [edit].** `~/.inprogress` and the live window are unrecoverable: the live database holds every project's tree and resources, every Claude session on this machine reads it through the installed hooks, and no git revert undoes a stray write there or a bad deploy. Every phase below bends around that fact.
```

- [ ] **Step 4: The two lists under Overrides.** Replace the line `{{RISK_LIST}}` with:

```markdown
- data: `src/server/db/`, or `min_reader_version`;
- code that runs in every session of every project: `src/hooks/`, `src/cli/claude-config.ts`, `src/mcp/`, `claude/`, `src/server/session-flow.ts`, `src/server/briefing.ts`;
- several sessions writing at once: `src/server/repo/`, `src/lib/ensure-server.ts`, `web/src/stream.ts`, `scripts/deploy*.mjs`;
- focus and keyboard: `web/src/useKeyboard.ts`, `web/src/chrome/menu.ts`, `web/src/chrome/GoTo.tsx`, or any diff that adds a menu, popover, confirm or focus move.
```

Replace the line `{{HARD_ORDERING_LIST}}` with:

```markdown
- hook ordering: what `src/hooks/` injects into a session, and in what order;
- transactions and migrations: `src/server/db/` and `src/server/repo/`;
- races between sessions: several sessions, the scribe and the window writing at once.
```

In the first override bullet, change `Display-only UI (styles, layout, wording)` to `Display-only UI (styles, layout, wording, canvas visuals)`.

- [ ] **Step 5: Phase 1.** Replace the line `{{BRANCH_MODEL}}` with:

```markdown
One worktree per session under `.claude/worktrees/`, one branch per change off `main`. A session spawned from a chip starts in one; otherwise create it with `git worktree add .claude/worktrees/<topic> -b <topic> main`. Work only there: the main checkout takes only merges, deploys and `claude:install`. `node_modules` resolves from the main checkout. Uncommitted changes outside your worktree belong to another session: don't stage them, ask about them or mention them. Stage explicit paths only. The branch's label (ui, server, data, integration, ops, docs, fix, refactor, research) picks its gates in phase 4.
```

- [ ] **Step 6: Phase 2.** Replace the sentence `Plans live in {{PLAN_HOME}}.` with:

```markdown
Plans live in `docs/superpowers/plans/`, specs in `docs/superpowers/specs/`, and provisional rulings and open questions in `docs/superpowers/rulings/`.
```

- [ ] **Step 7: Phase 4.** Replace the line `{{CHECKS}}` with:

```markdown
- every branch: `npm run typecheck` and `npm test` (vitest unit), from the worktree;
- ui: plus one e2e test per user-visible feature in `test/e2e/ui.spec.ts`, run the way `npm run test:e2e` does, narrowed with `-g "<test name>"`, with `INPROGRESS_E2E_PORT` set to the session's port; no failing-test-first for styling or wording;
- integration (`claude/`, `src/hooks/`, `src/cli/`, `src/mcp/`): plus `npm run test:smoke`; the full strict gates for hooks and the installer;
- data (`src/server/db/`): the full strict gates; `min_reader_version` stays 1 when a migration only adds;
- `npm run deploy` (phase 8) decides from the changed files which of smoke and e2e run again before the build goes live.
```

Replace the sentence `UI verification runs only on {{VERIFY_PORTS}}, never on {{OWNER_PORTS}}.` (it wraps over two lines in the template) with:

```markdown
UI verification runs only on a port from 4400 to 4419 that the session picks (Parvati's lane is 4400 to 4409, Sev's e2e lane 4410 to 4419), never on 4317 (the live window) or 4399 (the e2e default, which the deploy's own run uses).
```

- [ ] **Step 8: Phase 6.** Replace the line `{{SHIP_POLICY}}` with:

```markdown
InProgress has no integration branch, and nothing is pushed before the merge. The branch stays in its worktree until phase 8; Sigmund never pushes a branch to origin, and `main` is pushed only by the gate below. Ask first before anything on the risk list, before a migration, before a deletion, and before growing the scope past the request.
```

- [ ] **Step 9: Phase 7, item 5.** Replace item 5 (the two lines from `5. **The risk statement, present even when "none" [edit]:**` through `will require.`) with:

```markdown
5. **The risk statement, present even when "none" [edit]:** does this change touch `~/.inprogress`, the live window, the installed hooks (`src/hooks/`, `claude/`) or the deploy? If yes, say plainly what the merge gate will require: a full deploy, `claude:install`, a migration check.
```

- [ ] **Step 10: Phase 8.** Replace the line `{{MERGE_GATE}}` with:

````markdown
On Aiden's go-ahead only. If `main` moved, merge it into the branch in its worktree first and rerun the checks. Then, from the main checkout: `git merge --no-ff <branch>`, then `npm run deploy` (typecheck and unit always; smoke and e2e when the changed files need them; a red deploy means fix on the branch, merge and deploy again, and `npm run rollback` swaps the previous live build back), then `npm run claude:install` when the branch touched `claude/` or `src/hooks/`. Then push `main` with the personal account's token and leave the active gh account alone:

```bash
git -c credential.helper= -c 'credential.helper=!f() { echo username=x-access-token; echo password=$(gh auth token --user Aiden-Molyneaux); }; f' push origin main
```

A PR only when Aiden asks. Deploy and `claude:install` never run from a worktree: the installed hooks bake in the main checkout's absolute path.
````

- [ ] **Step 11: Across the session.** Replace the line `{{SESSION_RHYTHM}}` with:

```markdown
- You can't see your context size. A hook (`scripts/context-nudge.mjs`) tells you when it crosses 150k and 160k, and `.claude/settings.json` compacts at 300k.
- One thread per session: a feature, or a suite of related features that share code. A clean point is right after a merge, or after a finished plan task with everything committed in your worktree.
- Cut the session when the thread is done, when the next queued item is unrelated, or when the nudge says so. At a cut: write the handoff, brief the scribe to attach it to its step, print the handoff's path, offer the next session as a chip whose prompt is the handoff prompt when the `spawn_task` tool is available (the desktop app), and stop.
- A new request mid-session becomes a queued step through the scribe (`later: #id`, or a new step), unless it is a few lines in code that is already open. The InProgress tree is the memory between sessions.
- Unattended overnight run: the same rhythm without stopping. At each clean point write the handoff, then take the next queued item; compaction is the reset. Provisional rulings and open questions go to the rulings file in `docs/superpowers/rulings/`.
```

Replace the line `{{HANDOFF}}` with:

```markdown
A handoff is a prompt a fresh session can start from, saved as `~/.inprogress/resources/inprogress/<yyyy-mm-dd>-<kebab-title>.md` and attached to its step as a resource. The standing rules live here and in `CLAUDE.md`, so a handoff never repeats them. It holds:

- the goal;
- where things are: branch, commit, worktree;
- decisions made, with who made them;
- what waits on Aiden;
- what to read now, as slices (`file:lines`), not whole files;
- the next concrete step.
```

(The pilot-log bullet of the old Handoff section is dropped on purpose: #291's log ends with this switch.)

- [ ] **Step 12: Delete the `## Adopting this template` section** from its heading to the end of the file, and make sure the file ends with one newline.

- [ ] **Step 13: Run the checks**

```bash
EMDASH=$(printf '\xe2\x80\x94'); f=.claude/skills/sigmund/SKILL.md
grep -c '{{' "$f"                                         # 0
grep -c '^## Phase [0-8]:' "$f"                           # 9
grep -c 'Run this through Sigmund' "$f"                   # 2
grep -c '^## Adopting' "$f"                               # 0
grep -c 'InProgress' "$f"                                 # at least 4
grep -c 'src/server/db/' "$f"                             # 2 (risk list, hard-ordering list)
grep -c '4317' "$f"                                       # 1
grep -c 'credential.helper' "$f"                          # 1
grep -n "$EMDASH" "$f"                                    # nothing
npx vitest run test/repo/roster.test.ts                   # "has Sigmund" and "leaves no edit point unfilled" pass; the other two still red
```

- [ ] **Step 14: Commit** (main session; put Shipwright's commit in the message)

```bash
git add .claude/skills/sigmund/SKILL.md
git commit -m "feat(roster): Sigmund for InProgress, from Shipwright <short sha> (#421)"
```

---

### Task 3: The four agents and the murr and parvati skills

**Files:**
- Create: `.claude/agents/sev.md`, `.claude/agents/moh.md`, `.claude/agents/murr.md`, `.claude/agents/parvati.md`, `.claude/skills/murr/SKILL.md`, `.claude/skills/parvati/SKILL.md`
- Delete: `.claude/agents/explorer.md`, `.claude/agents/implementer.md`, `.claude/agents/code-reviewer.md`, `.claude/agents/screen-reviewer.md`

**Interfaces:**
- Consumes: the templates' placeholders, per file: sev `{{CHECKS}} {{DESIGN_AUTHORITY}} {{FORBIDDEN_COMMANDS}} {{HOUSE_RULE_FILES}} {{OWNER_PORTS}} {{PROJECT}} {{REPO_MAP}} {{SEV_PORT_LANE}}`; moh `{{EXCLUDED_DIRS}} {{PROJECT}} {{REPO_MAP}}`; murr wrapper `{{CHECKS}} {{FORBIDDEN_COMMANDS}} {{PROJECT}}`; parvati-isolated `{{BUILD_AND_RUN}} {{FORBIDDEN_COMMANDS}} {{OWNER_PORTS}} {{PARVATI_PORT_LANE}} {{PROJECT}} {{VIEWPORTS}}`; murr skill `{{HOUSE_RULE_FILES}} {{RISK_LIST}}`; parvati skill `{{DESIGN_AUTHORITY}} {{VIEWPORTS}}`.
- Produces: the file set `test/repo/agents.test.ts` expects, and the `skills: murr` and `skills: parvati` keys `test/repo/roster.test.ts` resolves.

- [ ] **Step 1: Copy and delete**

```bash
cp "$SW/agents/sev.md" "$SW/agents/moh.md" "$SW/agents/murr.md" .claude/agents/
cp "$SW/agents/parvati-isolated.md" .claude/agents/parvati.md
mkdir -p .claude/skills/murr .claude/skills/parvati
cp -r "$SW/skills/murr/." .claude/skills/murr/ && cp -r "$SW/skills/parvati/." .claude/skills/parvati/
git rm -q .claude/agents/explorer.md .claude/agents/implementer.md .claude/agents/code-reviewer.md .claude/agents/screen-reviewer.md
ls .claude/agents                                         # moh.md murr.md parvati.md sev.md
grep -rho '{{[A-Z_]*}}' .claude/agents .claude/skills/murr .claude/skills/parvati | sort -u | tr '\n' ' '
# {{BUILD_AND_RUN}} {{CHECKS}} {{DESIGN_AUTHORITY}} {{EXCLUDED_DIRS}} {{FORBIDDEN_COMMANDS}} {{HOUSE_RULE_FILES}} {{OWNER_PORTS}} {{PARVATI_PORT_LANE}} {{PROJECT}} {{REPO_MAP}} {{RISK_LIST}} {{SEV_PORT_LANE}} {{VIEWPORTS}}
```

(`git rm` is the one git command this task allows: it only removes files from the index and the tree. If the list differs, stop and report it.)

- [ ] **Step 2: The one-line fills, with sed, across all six files.** The replacement texts, exactly:

| Placeholder | Text |
|---|---|
| `{{PROJECT}}` | `InProgress` |
| `{{REPO_MAP}}` | a Node CLI, Claude Code hooks and an MCP server under `src/` (`src/cli`, `src/hooks`, `src/mcp`, `src/server` with Fastify and SQLite, `src/lib`, `src/core`), a React window under `web/src`, the installed kit's skills and scribe agent under `claude/`, scripts under `scripts/`, and tests under `test/` (`test/e2e` is Playwright, `test/smoke` checks the built kit, `test/repo` the repo's shape) |
| `{{HOUSE_RULE_FILES}}` | `CLAUDE.md` (its House rules section) |
| `{{EXCLUDED_DIRS}}` | `node_modules`, `dist`, `.build` and `.claude/worktrees` |
| `{{OWNER_PORTS}}` | 4317 (the live window) or 4399 (the e2e default) |
| `{{SEV_PORT_LANE}}` | 4410 to 4419, passed as `INPROGRESS_E2E_PORT` |
| `{{PARVATI_PORT_LANE}}` | 4400 to 4409 |
| `{{CHECKS}}` | `npm run typecheck` and `npm test`, plus the e2e test the plan names for a UI change (`INPROGRESS_E2E_PORT=<your port> npm run test:e2e -- -g "<test name>"`) |
| `{{DESIGN_AUTHORITY}}` | the window's existing screens under `web/src` (there are no mockups: match the neighbouring components, `web/src/styles.css`, and the keyboard conventions in `web/src/useKeyboard.ts`) |
| `{{VIEWPORTS}}` | 520x900 (the e2e viewport) and 1440x900 |
| `{{FORBIDDEN_COMMANDS}}` | `npm run deploy`, `npm run claude:install` or `npm run claude:uninstall`; never read or write `~/.inprogress` or the live InProgress server on 4317 (tests run against `.test-home` and `.test-claude`) |

Run them from a script so the backticks and slashes survive (write it to the scratch folder your brief names, not the worktree):

```bash
cat > "$SCRATCH/fill.mjs" <<'EOF'
import { readFileSync, writeFileSync } from 'node:fs';
const fills = {
  PROJECT: 'InProgress',
  REPO_MAP: "a Node CLI, Claude Code hooks and an MCP server under `src/` (`src/cli`, `src/hooks`, `src/mcp`, `src/server` with Fastify and SQLite, `src/lib`, `src/core`), a React window under `web/src`, the installed kit's skills and scribe agent under `claude/`, scripts under `scripts/`, and tests under `test/` (`test/e2e` is Playwright, `test/smoke` checks the built kit, `test/repo` the repo's shape)",
  HOUSE_RULE_FILES: '`CLAUDE.md` (its House rules section)',
  EXCLUDED_DIRS: '`node_modules`, `dist`, `.build` and `.claude/worktrees`',
  OWNER_PORTS: '4317 (the live window) or 4399 (the e2e default)',
  SEV_PORT_LANE: '4410 to 4419, passed as `INPROGRESS_E2E_PORT`',
  PARVATI_PORT_LANE: '4400 to 4409',
  CHECKS: '`npm run typecheck` and `npm test`, plus the e2e test the plan names for a UI change (`INPROGRESS_E2E_PORT=<your port> npm run test:e2e -- -g "<test name>"`)',
  DESIGN_AUTHORITY: "the window's existing screens under `web/src` (there are no mockups: match the neighbouring components, `web/src/styles.css`, and the keyboard conventions in `web/src/useKeyboard.ts`)",
  VIEWPORTS: '520x900 (the e2e viewport) and 1440x900',
  FORBIDDEN_COMMANDS: '`npm run deploy`, `npm run claude:install` or `npm run claude:uninstall`; never read or write `~/.inprogress` or the live InProgress server on 4317 (tests run against `.test-home` and `.test-claude`)',
};
for (const file of process.argv.slice(2)) {
  let text = readFileSync(file, 'utf8');
  for (const [key, value] of Object.entries(fills)) text = text.split(`{{${key}}}`).join(value);
  writeFileSync(file, text);
}
EOF
node "$SCRATCH/fill.mjs" .claude/agents/sev.md .claude/agents/moh.md .claude/agents/murr.md .claude/agents/parvati.md .claude/skills/murr/SKILL.md .claude/skills/parvati/SKILL.md
grep -rho '{{[A-Z_]*}}' .claude/agents .claude/skills/murr .claude/skills/parvati | sort -u | tr '\n' ' '
# {{BUILD_AND_RUN}} {{RISK_LIST}}
```

- [ ] **Step 3: `{{RISK_LIST}}` in the murr skill.** In `.claude/skills/murr/SKILL.md`, replace the line `{{RISK_LIST}}` with the same four bullets as Sigmund's:

```markdown
- data: `src/server/db/`, or `min_reader_version`;
- code that runs in every session of every project: `src/hooks/`, `src/cli/claude-config.ts`, `src/mcp/`, `claude/`, `src/server/session-flow.ts`, `src/server/briefing.ts`;
- several sessions writing at once: `src/server/repo/`, `src/lib/ensure-server.ts`, `web/src/stream.ts`, `scripts/deploy*.mjs`;
- focus and keyboard: `web/src/useKeyboard.ts`, `web/src/chrome/menu.ts`, `web/src/chrome/GoTo.tsx`, or any diff that adds a menu, popover, confirm or focus move.
```

Then, in the same `## Project risks [edit]` section, after the paragraph that starts `The house rules this project holds code to`, add this paragraph (InProgress's own attack list, from the retired code-reviewer):

```markdown
What to probe on this codebase, whatever the diff: hooks (`src/hooks/`, `src/server/session-flow.ts`, `src/cli/claude-config.ts`) run in every session of every project, so a slow or failing hook must never block a session and what it injects must stay small; migrations in `src/server/db/schema.ts` are append-only, and an additive one keeps `min_reader_version` at 1 so a rollback across it still works; several sessions, the scribe and the window write at once (`src/server/repo/`, `src/server/db/tx.ts`, `src/mcp/`), so look for transactions, ordering, idempotence and lost updates; Windows paths with backslashes and spaces, shells, process spawning, and files locked during a rename; errors that name their cause and are never swallowed; tests that can fail; and no em dashes in tracked text.
```

- [ ] **Step 4: `{{BUILD_AND_RUN}}` in the parvati wrapper.** In `.claude/agents/parvati.md`, replace the bullet `- Build and run: {{BUILD_AND_RUN}}` with:

```markdown
- Build with `node scripts/build-to.mjs .build` from the worktree; never touch the repo's `dist/`. Start `.build/dist/server/main.js` the way `test/e2e/start-server.mjs` does: `INPROGRESS_HOME` set to a folder in your scratch folder, `INPROGRESS_PORT` set to your port, `INPROGRESS_AGENT_WATCH_MS=500`. Seed what the change needs through that instance's HTTP API; `test/e2e/ui.spec.ts` and `test/helpers.ts` show how the tests create projects, steps and sessions.
```

- [ ] **Step 5: The InProgress rules the templates do not carry.** Three additions, each a bullet in an existing `[edit]` section:

In `.claude/agents/sev.md`, `## Rules [edit]`, after the bullet that starts `- Errors name their cause.`, add:

```markdown
- Migrations are append-only: never edit a shipped entry in `src/server/db/schema.ts`. A migration the plan does not spell out is never yours to write.
- No em dashes (U+2014) anywhere: `test/repo/no-em-dash.test.ts` scans every file.
```

In `.claude/agents/parvati.md`, `## Rules [edit]`, after the bullet that starts `- Never commit, stash, reset or check out.`, add:

```markdown
- No em dashes (U+2014) in anything you write.
```

In `.claude/agents/murr.md`, `## Running as a subagent [edit]`, after the bullet that starts `- The skill's Project risks section`, add:

```markdown
- Windows is the only platform this repo runs on: paths with backslashes and spaces, PowerShell and Git Bash, process spawning and files locked during a rename are part of every attack pass.
```

- [ ] **Step 6: Strip the em dashes from the two skills.** A spaced em dash becomes a colon, any other a comma:

```bash
sed -i 's/ — /: /g; s/—/, /g' .claude/skills/murr/SKILL.md .claude/skills/parvati/SKILL.md
```

Then read both files once, end to end. Where the colon made a sentence wrong (two colons in one sentence, a colon before a capitalised clause that needs a period), reword that sentence by hand and list every such line in your report. Headings read `## The authority: read in this order`, `## Report format: ALWAYS use this`, `## 🧹 Debt (refactorability: not runtime)`, `## ✅ Expected (deferred: proceed)`; the report template lines read `- <surface>: <what was attacked and how it held>`.

- [ ] **Step 7: Run the checks**

```bash
EMDASH=$(printf '\xe2\x80\x94')
grep -rn '{{' .claude/agents .claude/skills                              # nothing
grep -rn "$EMDASH" .claude/agents .claude/skills                        # nothing
grep -c '^## Project risks \[edit\]$' .claude/skills/murr/SKILL.md       # 1
grep -c 'min_reader_version' .claude/skills/murr/SKILL.md               # 2 (risk list, probe paragraph)
grep -c '^### Design authority \[edit\]$' .claude/skills/parvati/SKILL.md   # 1
grep -c 'web/src/styles.css' .claude/skills/parvati/SKILL.md .claude/agents/sev.md   # 1 and 1
grep -E '^(name|model|effort|maxTurns|skills|omitClaudeMd): ' .claude/agents/*.md
# sev: name sev, claude-sonnet-5-5, medium, 60; moh: name moh, claude-haiku-5-5, low, 20, omitClaudeMd true;
# murr: name murr, claude-sonnet-5-5, high, 40, skills murr; parvati: name parvati, claude-sonnet-5-5, medium, 50, omitClaudeMd true, skills parvati
grep -c 'build-to.mjs' .claude/agents/parvati.md                        # 1
grep -c 'INPROGRESS_E2E_PORT' .claude/agents/sev.md                     # 2 (port lane, checks)
grep -rn -i -E 'explorer|implementer|code-reviewer|screen-reviewer' .claude/agents .claude/skills   # only moh.md's "read-only explorer"
npm run typecheck && npm test                                           # green, including test/repo (roster and agents) and no-em-dash
```

If `npm test` fails only on `roster.test.ts` "keeps one Sigmund line in CLAUDE.md": that is Task 4's; report it as expected and go on. Anything else, fix.

- [ ] **Step 8: Commit** (main session; put Shipwright's commit in the message)

```bash
git add .claude/agents .claude/skills/murr .claude/skills/parvati
git commit -m "feat(roster): Sev, Moh, Murr and Parvati replace the four routed agents, from Shipwright <short sha> (#421)"
```

---

### Task 4: CLAUDE.md and the handoff line in mip-orc

**Files:**
- Rewrite: `CLAUDE.md`
- Modify: `claude/skills/mip-orc/SKILL.md:63,65`

**Interfaces:**
- Consumes: `.claude/skills/sigmund/SKILL.md` (Task 2) as the home of everything that leaves CLAUDE.md.
- Produces: the CLAUDE.md phrase `test/repo/roster.test.ts` checks, and the handoff line mip-orc's next session writes.

- [ ] **Step 1: Write `CLAUDE.md`** with exactly this content:

```markdown
# InProgress: working rules

Change work runs through Sigmund (`.claude/skills/sigmund/`). Routing, overrides and the ship gates live there. The house rules below apply to every session and to every subagent that loads this file; Moh and Parvati skip it and carry their own.

## House rules

- Test gates by label, branch and landing rules are in the InProgress playbook, which the session briefing shows.
- No em dashes (U+2014) or their HTML entities in any file: `test/repo/no-em-dash.test.ts` scans every file.
- Work only in your own worktree under `.claude/worktrees/`. A session spawned from a chip starts in one; otherwise create it with `git worktree add .claude/worktrees/<topic> -b <topic> main`. The main checkout takes only merges, deploys and `claude:install`. Uncommitted changes outside your worktree belong to another session: don't stage them, ask about them or mention them. Stage explicit paths only.
- Deploy and `claude:install` run only from the main checkout: the installed hooks bake in its absolute path.
- `node scripts/session-cost.mjs --by=session --sessions=<id prefixes>` prices sessions from their transcripts at list rates. The baseline is r105 on #289.
```

(Roles, Routing, Overrides, Evidence, Session rhythm and Handoff are in Sigmund now. Evidence stays out of CLAUDE.md on purpose: spec §1 puts it in Sigmund.)

- [ ] **Step 2: mip-orc, "Start a step".** In `claude/skills/mip-orc/SKILL.md`, line 63 (item 1) ends `... and say that the fresh worktree the chip creates stays empty.` Append to that item, as one more sentence:

```markdown
 For change work in a repo that has `.claude/skills/sigmund/SKILL.md`, the line after `Claim #<id>` reads `Run this through Sigmund.`
```

Line 65 (item 3) holds `Its prompt names the model and effort to pick (`spawn_task` has no field for them, so the prompt can only ask) and points at the handoff.` Change that sentence to:

```markdown
Its prompt names the model and effort to pick (`spawn_task` has no field for them, so the prompt can only ask), then, for change work in a repo that has `.claude/skills/sigmund/SKILL.md`, says `Run this through Sigmund.`, and points at the handoff.
```

- [ ] **Step 3: Run the checks**

```bash
EMDASH=$(printf '\xe2\x80\x94')
grep -c 'Run this through Sigmund' claude/skills/mip-orc/SKILL.md       # 2
grep -c '^## ' CLAUDE.md                                                # 1
grep -n "$EMDASH" CLAUDE.md claude/skills/mip-orc/SKILL.md              # nothing
npm run typecheck && npm test                                           # green, roster.test.ts all four passing
npm run test:smoke                                                      # green (the kit installs with the edited skill)
```

- [ ] **Step 4: Commit** (main session)

```bash
git add CLAUDE.md claude/skills/mip-orc/SKILL.md
git commit -m "feat(roster): CLAUDE.md keeps one Sigmund line and the house rules; mip-orc handoffs say Run this through Sigmund (#421)"
```

---

### Task 5: The status line on the old routing design

**Files:**
- Modify: `docs/superpowers/specs/2026-10-09-dev-session-routing-design.md:3`

- [ ] **Step 1: Insert after line 3** (the line `2026-10-09 · step #290 (under #288) · brought over from InThink's routing pilot (inthink-marathon-v3 #273)`), with a blank line on each side:

```markdown
**Status (2026-10-14, #421):** the four agents (section 1) and the CLAUDE.md routing are superseded by the Shipwright roster: Sigmund in `.claude/skills/sigmund/`, and Sev, Moh, Murr and Parvati in `.claude/agents/` (Shipwright `docs/roster-spec.md`; the adoption plan is `docs/superpowers/plans/2026-10-13-shipwright-roster.md`). The context nudge hook, the 300k compaction window, `scripts/session-cost.mjs` and the worktree rule stand. The #291 pilot log ends with the switch; #292 reports on the sessions up to it.
```

- [ ] **Step 2: Check and commit** (main session)

```bash
EMDASH=$(printf '\xe2\x80\x94'); grep -n "$EMDASH" docs/superpowers/specs/2026-10-09-dev-session-routing-design.md   # nothing
git add docs/superpowers/specs/2026-10-09-dev-session-routing-design.md
git commit -m "docs: the routing design records what the roster supersedes (#421)"
```

---

### Task 6: Review, land, switch (main session)

- [ ] **Step 1: Wait for the window-feedback branches.** #400, #404, #405 and #422 land before this one. Then in the worktree: `git merge main` and rerun `npm run typecheck && npm test && npm run test:smoke`.

- [ ] **Step 2: Review with the old reviewer.** Dispatch `code-reviewer` with `model: opus` (the diff touches `claude/`), scope `git diff main...HEAD` in the `roster-plan` worktree, request: "InProgress adopts the Shipwright roster; see the plan". Open each finding's `file:line` before fixing. Re-check with `code-reviewer` on `haiku`, "proportional", if the fix diff is small. Record both in the handoff's pilot log, with the models and the reason for the override (the last entries the log gets).

- [ ] **Step 3: Read every copied file once, end to end,** as the next session will: `.claude/skills/sigmund/SKILL.md`, the four agents, both skills. A wording fix is one more commit (`docs(roster): wording`).

- [ ] **Step 4: Land, from the main checkout, on Aiden's go-ahead**

```bash
git merge --no-ff roster-plan -m "Merge branch 'roster-plan': the Shipwright roster replaces the routed agents and the CLAUDE.md routing (#421)"
npm run deploy
npm run claude:install
git -c credential.helper= -c 'credential.helper=!f() { echo username=x-access-token; echo password=$(gh auth token --user Aiden-Molyneaux); }; f' push origin main
```

- [ ] **Step 5: Brief the scribe,** one batch: `#421 → done; outcome: the roster is installed (Sigmund, Sev, Moh, Murr, Parvati) from Shipwright <sha>, merged as <merge sha>, deployed and installed`; `log on #291: the pilot log retires with the roster switch (<merge sha>); #292 reports on the sessions up to it`; `resource on #421: doc "InProgress roster adoption plan", path docs/superpowers/plans/2026-10-13-shipwright-roster.md, snapshot_file` if not attached already.

- [ ] **Step 6: The trigger-collision test (spec §5), in the first session after the switch.** In the InProgress main checkout, start a fresh session and say "drive this to done" with no other context. Record which Sigmund loads (the project's `sigmund` or `cad-dev-loop:sigmund`) as `log on #421: trigger test: "<phrase>" loaded <which>`. If the plugin's loads, the fix is a description change in Shipwright's template (a new Shipwright step), not here.

## Self-review against the spec and the handoff

- Spec §1 roster table: Sigmund (Task 2), Sev and Moh (Task 3, from `agents/sev.md` and `moh.md`), Murr and Parvati as wrapper plus skill (Task 3). Parvati in isolated-build mode, per §7.1 and the handoff (`parvati-isolated.md` copied as `parvati.md`; `{{SIGN_IN}}` unused).
- Spec §2 the CLAUDE.md line: Task 4 step 1, checked by `roster.test.ts`. The handoff line: in Sigmund by copy (Task 2 step 13 counts two) and in mip-orc (Task 4 step 2). "Evidence" leaves CLAUDE.md (Task 4) and is in Sigmund by copy.
- Spec §4, InProgress column, every row: paths (REPO_MAP, HOUSE_RULE_FILES, EXCLUDED_DIRS: Task 3 step 2); ports (OWNER_PORTS, VERIFY_PORTS, SEV_PORT_LANE, PARVATI_PORT_LANE: Task 2 step 7, Task 3 step 2); checks (Task 2 step 7, Task 3 step 2); deploy target and ship gates (BRANCH_MODEL, SHIP_POLICY, MERGE_GATE: Task 2 steps 5, 8, 10); risk statement (Task 2 steps 3 and 9); risk list (Task 2 step 4, Task 3 step 3, the same four bullets); hard-ordering list (Task 2 step 4); design authority (Task 3 step 2, in Sev and the parvati skill); mode, viewports, sign-in (Task 3 steps 2 and 4); forbidden commands (Task 3 step 2).
- Handoff decisions: Session rhythm and Handoff fill Sigmund with the pilot-log bullet removed (Task 2 step 11); the four old agents deleted and `agents.test.ts:25` updated (Tasks 3 and 1); `roster.test.ts` with the four checks named (Task 1); mip-orc lines 63 and 65 (Task 4), `inprogress/SKILL.md` grepped and unchanged (File structure); the docs status line with the #291 retirement logged at landing (Tasks 5 and 6); the old `code-reviewer` on `opus` reviews the branch and the first Sigmund session runs the collision test (Task 6).
- Every placeholder the templates plan lists lands somewhere here except `{{SIGN_IN}}` (shared mode only). `{{BUILD_AND_RUN}}` comes from `screen-reviewer.md:17-19`; `{{REPO_MAP}}` from `explorer.md:12`; the risk list from `CLAUDE.md:27-30`; the attack list in murr's Project risks from `code-reviewer.md:66-72`; Sev's migration and em dash rules from `implementer.md:21,23`.
- Placeholder scan: no "TBD", "similar to", or unstated content; every fill is written out. The only open value is Shipwright's commit sha, which exists once #417 to #419 land.
