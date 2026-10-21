# Title Channel Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Keep the status prefix on a Claude Desktop session's title (none, `RUNNING`, `REVIEW`, `BLOCKED`, `DONE`) in step with what InProgress knows, by a nudge on the next prompt everywhere and, where a project turns it on, by sending the session back once at Stop to set it.

**Architecture:** A pure function in `src/core/title.ts` computes the prefix InProgress expects for a session from the project snapshot (its focus step's status, its open asks, its live background work) and splits or rebuilds a title. `src/server/title-channel.ts` turns that into the advice a hook response carries: a line for the prompt briefing (mode A) and, when the project's `title_channel` is `enforce`, a Stop block (mode B), with a per-session memory of the last title it demanded so a declined rename never loops. The Stop hook learns to print a `decision: block` reply; the installer adds the allow rule for `mcp__ccd_session_mgmt__set_session_title`.

**Tech Stack:** TypeScript, Node 20, better-sqlite3, zod, vitest. Hooks run as `dist/hooks/hook.js <name>` with stdin JSON from Claude Code.

**Spec:** `docs/superpowers/specs/2026-10-20-inprogress-redesign-design.md`, section 4.8 and question 2 (B behind a setting, A underneath), question 8 (built before the waiting state, so REVIEW and BLOCKED read scribe asks for now).

## Global Constraints

- No em dash (U+2014) or its HTML entity in any file; `test/repo/no-em-dash.test.ts` scans every file.
- Label `integration`: typecheck, unit, smoke, and the full strict gates for hooks and the installer (the InProgress playbook). `npm run deploy` decides what runs from the files changed.
- A migration that only adds keeps `min_reader_version` at 1 and appends to `MIGRATIONS`; a shipped entry is never edited (`src/server/db/schema.ts:1`).
- Hook budget: every hook but session-start gets one 500 ms POST and a 750 ms ceiling (`src/hooks/budget.ts`). Mode B adds no second round trip: the block rides on the Stop POST's reply.
- Only the main session renames itself; a subagent cannot. Outside the desktop app the title is absent and the channel does nothing.
- The prefix words and their precedence, from Sigmund (`.claude/skills/sigmund/SKILL.md:370-376`) and the spec: `DONE` once the focus step is done and it stays; `BLOCKED` beats `REVIEW` ("the answer comes before a ship"); `RUNNING` when the turn ends with background work still live; else no prefix.
- One branch off main for this change, merged after a green deploy; the main checkout takes only merges.

## Review Focus

1. A session whose title Aiden typed himself: `set_session_title` asks him to approve the rename, and he may decline. The block must not fire again at the next Stop for the same demand (Task 4's `titleAsked` test).
2. A title that already starts with a capitalised word that is not a prefix (`Review and clean up staging`): it is not a prefix and must not be stripped (Task 1's `splitPrefix` test).
3. A Stop with `stop_hook_active: true` (the session is already in the extra pass a block caused): never block again, whatever the title says (Task 4 and Task 5 tests).
4. A session with no title (CLI, not the desktop app): no nudge line, no block (Task 4's test).
5. The prefix flips every Stop when a Monitor runs for hours: `RUNNING` then none then `RUNNING`. Only a change of the expected title ever blocks; an unchanged mismatch waits for the next prompt's nudge (Task 4's `titleAsked` test covers it; the Monitor case is one of its rows).

---

### Task 1: The prefix rules, pure

**Files:**
- Create: `src/core/title.ts`
- Test: `test/core/title.test.ts`

**Interfaces:**
- Consumes: `Session`, `ProjectSnapshot`, `Ask`, `TreeNode` from `src/core/types.ts`; `sessionActivity` from `src/core/activity.ts`; `isLive` from `src/core/board.ts`.
- Produces:
  - `export const TITLE_PREFIXES = ['RUNNING', 'REVIEW', 'BLOCKED', 'DONE'] as const; export type TitlePrefix = (typeof TITLE_PREFIXES)[number];`
  - `export function splitPrefix(title: string): { prefix: TitlePrefix | null; rest: string }`: a leading prefix word followed by one or more spaces, case-sensitive; `rest` is the remainder trimmed. `'DONE #455 Sigmund title status'` gives `{ prefix: 'DONE', rest: '#455 Sigmund title status' }`; `'Review and clean up staging'` gives `{ prefix: null, rest: 'Review and clean up staging' }`; `'DONE'` alone gives `{ prefix: 'DONE', rest: '' }`.
  - `export function withPrefix(rest: string, prefix: TitlePrefix | null): string`: `prefix ? \`${prefix} ${rest}\` : rest`, trimmed.
  - `export function expectedPrefix(session: Session, snapshot: ProjectSnapshot, now: number): TitlePrefix | null`, in this order: the focus step (`session.focusNodeId` found in `snapshot.nodes`) has `status === 'done'` → `'DONE'`; an open ask (`clearedAt === null`) on the focus step with `sessionId === session.id` and kind `question` or `permission` → `'BLOCKED'`; such an ask with kind `review` → `'REVIEW'`; `sessionActivity(session, now) === 'busy'` → `'RUNNING'`; else `null`. A session with no focus step can only be `RUNNING` or `null`.
  - `export function prefixReason(prefix: TitlePrefix | null, nodeId: number | null): string`: the words the nudge and the block use: `DONE` → `#<id> is done`; `BLOCKED` → `an ask on #<id> waits on Aiden`; `REVIEW` → `a review on #<id> waits on Aiden`; `RUNNING` → `background work is still running`; `null` → `nothing is running or waiting`.

- [ ] **Step 1: Write the failing tests**

```ts
// test/core/title.test.ts
import { describe, expect, it } from 'vitest';
import { expectedPrefix, prefixReason, splitPrefix, withPrefix } from '../../src/core/title';
import { snapshotWith, sessionWith } from './title.fixtures'; // small builders you write in this file or beside it: a snapshot with nodes/asks/sessions, a Session with defaults

describe('splitPrefix', () => {
  it('reads a leading prefix word', () => {
    expect(splitPrefix('DONE #455 Sigmund title status')).toEqual({ prefix: 'DONE', rest: '#455 Sigmund title status' });
    expect(splitPrefix('BLOCKED   #12 x')).toEqual({ prefix: 'BLOCKED', rest: '#12 x' });
    expect(splitPrefix('DONE')).toEqual({ prefix: 'DONE', rest: '' });
  });
  it('leaves ordinary words alone', () => {
    expect(splitPrefix('Review and clean up staging')).toEqual({ prefix: null, rest: 'Review and clean up staging' });
    expect(splitPrefix('DONEish work')).toEqual({ prefix: null, rest: 'DONEish work' });
    expect(splitPrefix('')).toEqual({ prefix: null, rest: '' });
  });
});

describe('withPrefix', () => {
  it('rebuilds a title', () => {
    expect(withPrefix('#12 x', 'REVIEW')).toBe('REVIEW #12 x');
    expect(withPrefix('#12 x', null)).toBe('#12 x');
    expect(withPrefix('', 'DONE')).toBe('DONE');
  });
});

describe('expectedPrefix', () => {
  const now = Date.parse('2026-10-20T12:00:00.000Z');
  it('is DONE when the focus step is done, whatever else is true', () => { /* focus step done, a review ask open, a subagent running */ expect(expectedPrefix(s, snap, now)).toBe('DONE'); });
  it('is BLOCKED before REVIEW when both asks are open', () => { expect(expectedPrefix(s, snap, now)).toBe('BLOCKED'); });
  it('is REVIEW for an open review ask this session raised', () => { expect(expectedPrefix(s, snap, now)).toBe('REVIEW'); });
  it('ignores asks another session raised or asks already cleared', () => { expect(expectedPrefix(s, snap, now)).toBeNull(); });
  it('is RUNNING when a non-reader subagent or a counted command is live', () => { expect(expectedPrefix(s, snap, now)).toBe('RUNNING'); });
  it('is null for an idle session with no focus', () => { expect(expectedPrefix(s, snap, now)).toBeNull(); });
});

describe('prefixReason', () => {
  it('names the step', () => {
    expect(prefixReason('BLOCKED', 12)).toBe('an ask on #12 waits on Aiden');
    expect(prefixReason(null, null)).toBe('nothing is running or waiting');
  });
});
```

Build the fixtures from `test/core/board.test.ts`'s helpers where they fit; a reader subagent (`isReader` in `src/core/activity.ts`) must not count as running.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run test/core/title.test.ts`
Expected: FAIL, module `../../src/core/title` not found.

- [ ] **Step 3: Implement `src/core/title.ts`** with the four exports above. `expectedPrefix` reads only the snapshot and the session; no I/O.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run test/core/title.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/core/title.ts test/core/title.test.ts
git commit -m "feat(core): the title prefix rules: split, rebuild, expected prefix"
```

### Task 2: The setting and the session's memory of the last demand

**Files:**
- Modify: `src/server/db/schema.ts` (append migration 15)
- Modify: `src/core/types.ts` (`Project.titleChannel`, `Session.titleAsked`, `TITLE_CHANNELS`)
- Modify: `src/server/repo/projects.ts:22,181,294,361-381` (read, patch, validate `title_channel` as `briefing_mode` is)
- Modify: `src/server/repo/sessions.ts` (`findSession` reads `title_asked`; `saveSession` writes it)
- Modify: `src/server/schemas.ts:46` (`titleChannel` on the project patch body)
- Modify: `src/mcp/server.ts:122-126` (`title_channel` on `update_project`)
- Modify: `claude/agents/inprogress-scribe.md:35` and `claude/skills/inprogress/SKILL.md:36` (the brief line)
- Test: `test/server/migration15.test.ts`, `test/server/projects.test.ts`, `test/server/sessions.test.ts`

**Interfaces:**
- Produces:
  - Migration 15: `ALTER TABLE projects ADD COLUMN title_channel TEXT NOT NULL DEFAULT 'nudge'; ALTER TABLE sessions ADD COLUMN title_asked TEXT;` plus the `min_reader_version` upsert to `'1'`, with the comment style of migration 14 (`src/server/db/schema.ts:322-327`).
  - `export const TITLE_CHANNELS = ['nudge', 'enforce'] as const; export type TitleChannel = (typeof TITLE_CHANNELS)[number];` in `src/core/types.ts`; `Project.titleChannel: TitleChannel` (default `'nudge'`; any other stored value reads as `'nudge'`, as `briefingMode` reads at `projects.ts:181`); `Session.titleAsked: string | null` (the full title the last block demanded, null before any).
  - `updateProject` accepts `titleChannel` in its patch, validated against `TITLE_CHANNELS` with the same `badRequest` shape as `briefingMode` (`projects.ts:361`), written in the same UPDATE, listed in the `project.updated` changes.
  - `update_project` MCP tool takes `title_channel: z.enum(TITLE_CHANNELS).optional()`, described: `nudge: the briefing tells a session when its title prefix is off. enforce: the Stop hook also sends the session back once to set it`.
  - Scribe brief line: `title channel <slug>: nudge` or `enforce` is `update_project` with `title_channel`.

- [ ] **Step 1: Write the failing migration test** (`test/server/migration15.test.ts`, the shape of `migration14.test.ts`): a database at 14 with one project and one session, migrated; asserts `title_channel` exists on projects and reads `'nudge'` for the old row, `title_asked` exists on sessions and is NULL, `min_reader_version` is `'1'`, `MIGRATIONS.length >= 15`.

- [ ] **Step 2: Write the failing repo tests**: in `projects.test.ts`, `updateProject` with `{ titleChannel: 'enforce' }` reads back `titleChannel: 'enforce'` and records `titleChannel` among the changes; `{ titleChannel: 'loud' }` throws a 400 naming `nudge, enforce`. In `sessions.test.ts`, `saveSession` with `titleAsked: 'DONE #1 x'` reads back through `findSession`.

- [ ] **Step 3: Run them to verify they fail**

Run: `npx vitest run test/server/migration15.test.ts test/server/projects.test.ts test/server/sessions.test.ts`
Expected: FAIL (no column, unknown key).

- [ ] **Step 4: Implement** the migration, the types, the repo reads and writes, the zod field, the MCP field, and the two kit text lines. Rebuild nothing else: the window never shows the setting.

- [ ] **Step 5: Run the tests and the typecheck**

Run: `npx vitest run test/server && npx tsc --noEmit -p .`
Expected: PASS, no type errors.

- [ ] **Step 6: Commit**

```bash
git add src/server/db/schema.ts src/core/types.ts src/server/repo/projects.ts src/server/repo/sessions.ts src/server/schemas.ts src/mcp/server.ts claude/agents/inprogress-scribe.md claude/skills/inprogress/SKILL.md test/server/migration15.test.ts test/server/projects.test.ts test/server/sessions.test.ts
git commit -m "feat(data): title_channel on projects, title_asked on sessions (migration 15)"
```

### Task 3: The hook carries `stopHookActive`, and the server's reply can carry a title demand

**Files:**
- Modify: `src/hooks/handlers.ts:86-129` (`buildHookBody`: `stopHookActive` on `stop`), `:47-50` (`HookDeps.post` return type), `:392-408` (`runHandler` returns `HookOutput`)
- Modify: `src/hooks/main.ts:49-55` (print the block reply)
- Modify: `src/server/schemas.ts:72-130` (`stopHookActive: z.boolean().optional()`)
- Modify: `src/server/session-flow.ts:21-66` (`HookEventInput.stopHookActive`, `HookEventResult.title`)
- Test: `test/hooks/handlers.test.ts:474-515` (stop body), `:558-600` (runHandler), `test/server/app.test.ts` (the route accepts the field)

**Interfaces:**
- Produces:
  - Stop body gains `stopHookActive: boolean` when `input.stop_hook_active` is a boolean (absent otherwise, so an older server still accepts the post).
  - `export interface HookOutput { context?: string; block?: string }`; `runHandler` returns `Promise<HookOutput | undefined>`: `context` only for the events in `CONTEXT_EVENT_NAME` (as today), `block` only for `stop`, from `result.title`.
  - `HookDeps.post` returns `Promise<{ tracked: boolean; context?: string; title?: TitleDemand }>` where `export interface TitleDemand { title: string; reason: string }` lives in `src/core/title.ts` (add it in this task).
  - `main.ts`: for `stop`, when `output.block` is set, write `{"decision":"block","reason":<output.block>}` to stdout; for the context events, the `hookSpecificOutput` object as today; never both.
  - `HookEventResult` gains `title?: TitleDemand`; this task leaves it unset (Task 4 fills it).

- [ ] **Step 1: Write the failing tests**: in the stop-body describe, `stop_hook_active: true` yields `stopHookActive: true` and a missing field yields no key; in the runHandler describe, change the "returns context only for events that can inject it" expectations to `HookOutput` shape (`{ context: 'x' }` for session-start and prompt-submit, `undefined` elsewhere) and add: a stub whose post returns `{ tracked: true, title: { title: 'DONE #1 x', reason: '#1 is done' } }` makes `runHandler('stop', …)` resolve to `{ block: expect.stringContaining('DONE #1 x') }` and `runHandler('prompt-submit', …)` resolve without `block`.

- [ ] **Step 2: Run them to verify they fail**

Run: `npx vitest run test/hooks/handlers.test.ts`
Expected: FAIL on the new assertions.

- [ ] **Step 3: Implement** the body field, the `HookOutput` return, the `main.ts` branch, the zod field and the two interfaces. The block text is built in `runHandler` from the demand: `Set this session's title to "<title>" with mcp__ccd_session_mgmt__set_session_title on "self" (InProgress: <reason>), then stop.`

- [ ] **Step 4: Run the hook tests and the smoke suite**

Run: `npx vitest run test/hooks && npm run test:smoke`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/hooks/handlers.ts src/hooks/main.ts src/server/schemas.ts src/server/session-flow.ts src/core/title.ts test/hooks/handlers.test.ts test/server/app.test.ts
git commit -m "feat(hooks): stop carries stop_hook_active; the reply can demand a title"
```

### Task 4: The advice: a nudge line on the prompt, a block at Stop

**Files:**
- Create: `src/server/title-channel.ts`
- Modify: `src/server/session-flow.ts:301-346` (call it after the write; prepend the line; set `title`)
- Test: `test/server/title-channel.test.ts`, `test/server/claim.test.ts` or a new `test/server/session-flow-title.test.ts` for the hook-level cases

**Interfaces:**
- Consumes: `expectedPrefix`, `splitPrefix`, `withPrefix`, `prefixReason`, `TitleDemand` (Task 1 and 3); `getProjectSnapshot`; `findSession`, `saveSession` (Task 2's `titleAsked`).
- Produces:
  - `export function titleAdvice(ctx: Ctx, session: Session, snapshot: ProjectSnapshot, event: 'prompt' | 'stop', o: { stopHookActive: boolean }): { line?: string; demand?: TitleDemand }`. The caller passes the session it just saved and the snapshot it already reads for briefings, so the advice costs no second read. Rules:
    1. The session must have a non-empty `title`; else nothing.
    2. `expected = withPrefix(splitPrefix(session.title).rest, expectedPrefix(session, snapshot, now))`. When `expected === session.title`: nothing, and clear `titleAsked` when it was set.
    3. `line` (both events are allowed to compute it; only `prompt` uses it): `Title: set it to "<expected>" (mcp__ccd_session_mgmt__set_session_title on "self"); InProgress sees <reason>.`
    4. `demand` only when `event === 'stop'`, the project's `titleChannel === 'enforce'`, `o.stopHookActive === false`, and `session.titleAsked !== expected`. Setting it writes `titleAsked = expected` on the session (a write under actor `title-channel`, no event).
  - `handleHookEvent`: for a real prompt (`!input.notice`) the line goes first in `context` (before the answers and reminders of `session-flow.ts:324-345`); for `stop`, `result.title = demand` when present.

- [ ] **Step 1: Write the failing tests** (`test/server/title-channel.test.ts`, with `makeCtx` and the hook path through `handleHookEvent` so the snapshot is real):
  - `no title, no advice`: a session with `title: null` gets `{}` on both events.
  - `prompt nudge`: a session titled `#1 Fix export` whose focus step #1 is done gets `line` containing `"DONE #1 Fix export"` and `#1 is done`; the hook context on its next prompt starts with that line.
  - `in step, nothing`: titled `DONE #1 Fix export`, step done: `{}`.
  - `nudge mode never blocks`: project `titleChannel: 'nudge'`, a mismatch at stop: `demand` undefined, `line` set.
  - `enforce blocks once`: project `enforce`, a mismatch at stop: `demand.title` is the expected title; a second stop with the same mismatch and `stopHookActive: false`: no demand (`titleAsked` matches); a stop after the expected title changes (the step is now done): a new demand.
  - `stop_hook_active never blocks`: `enforce`, mismatch, `stopHookActive: true`: no demand, and `titleAsked` unchanged.
  - `a declined rename does not loop`: `enforce`, demand issued, the next prompt still carries the old title: the prompt gets the line; the stop after it gets no demand.
  - `the RUNNING flip`: a Monitor counted as work at one stop (`RUNNING` demanded), still running at the next (`titleAsked` matches, no demand), ended at the one after (expected is the bare title; a new demand, since it differs from `titleAsked`).
  - `title read from the transcript at stop`: after the session renamed itself, the stop body's `title` (`buildHookBody` reads the transcript's last `custom-title`, `src/hooks/handlers.ts:98`) updates `session.title` before the advice runs, so an obeyed demand yields no second demand.

- [ ] **Step 2: Run them to verify they fail**

Run: `npx vitest run test/server/title-channel.test.ts`
Expected: FAIL, module not found.

- [ ] **Step 3: Implement `src/server/title-channel.ts`** and wire it in `handleHookEvent` after the `write` returns and the `isTracking` check passes, before the context is assembled: read `getProjectSnapshot(ctx, projectId)` once there and hand it to both the briefing renderers and `titleAdvice`. The `titleAsked` write is its own small `write(ctx, 'title-channel', …)` with no event recorded.

- [ ] **Step 4: Run the server tests and the typecheck**

Run: `npx vitest run test/server test/core && npx tsc --noEmit -p .`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/server/title-channel.ts src/server/session-flow.ts test/server/title-channel.test.ts
git commit -m "feat(server): title advice: a nudge on the prompt, one block at stop under enforce"
```

### Task 5: The installer's allow rule, and the kit text

**Files:**
- Modify: `src/cli/claude-config.ts:11` (`STATIC_ALLOW_RULES`)
- Modify: `.claude/skills/sigmund/SKILL.md:370-376` (the Session title section)
- Modify: `claude/skills/inprogress/SKILL.md` (one sentence on the title channel next to the briefing-mode sentence)
- Test: `test/cli/claude-config.test.ts` (it already asserts `allowRules`), `test/repo/no-em-dash.test.ts` runs as always

**Interfaces:**
- Produces: `STATIC_ALLOW_RULES = ['mcp__inprogress', 'Edit(~/.inprogress/resources/**)', 'mcp__ccd_session_mgmt__set_session_title']`. `install` writes it; `removeAllowRules` removes it (it matches by `STATIC_ALLOW_RULES.includes`, so no other change there); `kitStatus` reports `settings` differs on an installed kit without it, so the next deploy re-installs.

- [ ] **Step 1: Write the failing test**: `allowRules(repo)` contains `mcp__ccd_session_mgmt__set_session_title`; after `install` then `uninstall` on a temp Claude dir, `settings.permissions` has no such rule.

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run test/cli`
Expected: FAIL on the new assertion.

- [ ] **Step 3: Implement** the rule, then the text:
  - Sigmund's Session title section: add `RUNNING` ("set when you end a turn with a background subagent or command still running; the next turn's end drops it"); replace the "Read the title with get_session" sentence's mechanics with: InProgress computes the prefix it expects from your focus step, your open asks and your live background work; when yours differs, your next prompt opens with a `Title:` line naming the exact title to set, and in a project with the title channel on `enforce` the Stop hook sends you back once to set it before you stop. Keep the four rules as the meaning of each word; the mechanics are now InProgress's.
  - inprogress skill: one sentence: `title channel <slug>: nudge|enforce` beside the briefing-mode sentence at line 36.

- [ ] **Step 4: Run the installer tests, the no-em-dash scan and the typecheck**

Run: `npx vitest run test/cli test/repo && npx tsc --noEmit -p .`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/cli/claude-config.ts .claude/skills/sigmund/SKILL.md claude/skills/inprogress/SKILL.md test/cli
git commit -m "feat(cli): allow set_session_title; Sigmund's title rules name RUNNING and the channel"
```

### Task 6: Live check and the gate

**Files:**
- No code. The deploy and a manual check.

- [ ] **Step 1: Run the full gates**

Run: `npm run deploy` from the main checkout after merging the branch locally (the playbook: one branch per fix off main, merged after a green deploy, then main pushed). Before the merge, from the worktree: `npx vitest run && npm run test:smoke && npx tsc --noEmit -p .`
Expected: all green.

- [ ] **Step 2: Live check, nudge mode** (every project starts on `nudge`): in a tracked desktop session on a done step whose title has no prefix, send a prompt; the briefing opens with the `Title:` line naming `DONE <title>`. Set the title as it says; the next prompt has no line.

- [ ] **Step 3: Live check, enforce**: brief the scribe `title channel inprogress: enforce`. In a session whose step has an open review ask it raised and whose title has no prefix, end a turn: the session is sent back once, sets `REVIEW …`, and stops. End another turn with nothing changed: no second pass. Launch a background Monitor and end the turn: `RUNNING …`; stop the Monitor and end a turn: the bare title again.

- [ ] **Step 4: Record**: brief the scribe that the step is done with the outcome, and note in the step's log which of the two live checks ran and anything the Stop block did that the tests did not predict (a declined rename, a loop, a timeout in hooks.log).
