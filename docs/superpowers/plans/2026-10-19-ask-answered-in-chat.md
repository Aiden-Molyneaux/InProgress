# Plan: move a step to Now when its ask is answered in chat (#522)

Handoff: r349. Rulings (Aiden, 2026-10-19): the step stays in Now while the counting session is live (working or idle); add `sessions.last_prompt_at`; land the marker now as a hygiene mark; criteria C1 to C5 at list depth, the real chat flow checked after the gate. No auto-clear, no Stop-hook backstop.

## Criteria

- C1: a session raises an ask on a step, then gets a real prompt: the step moves from Needs me to Now, its box foot reads "answered in chat, not recorded", the ask stays open.
- C2: the same session raises a new ask after that prompt: the step returns to Needs me.
- C3: the raiser has ended (or gone stale) and the step's live driver got a real prompt after the raise: the step is in Now. Neither live: Needs me.
- C4: every real prompt to a session holding an open ask it raised (or an open ask on a step it drives whose raiser is not live) carries the reminder line. Background-task notices count for neither fix.
- C5: the ask is cleared: the reminder line and the marker are gone.

## The rule

An open ask is **answered in chat** when all hold:

1. `ask.sessionId` is not null (window and migrated asks never count);
2. the counting session is: the raiser, when it is live (`isLive`); otherwise the step's live driver (`row.driver`), when that is a different session; otherwise none;
3. the counting session's `lastPromptAt` is later than `ask.raisedAt` (compare with `Date.parse`).

A step's **waiting** asks are its open asks less the answered-in-chat ones. The lane reads the waiting asks only. The ask itself is untouched.

## Task 1: record the last real prompt (data)

- `src/server/db/schema.ts`: append migration 14 (index 14). Comment in the house style: "14: when the session last got a real prompt (#522): a UserPromptSubmit that was not a background-task notice. NULL until its next one." SQL: `ALTER TABLE sessions ADD COLUMN last_prompt_at TEXT;` then the `min_reader_version` '1' upsert with the comment "Only a nullable column: v1 to v13 builds can still read and write this schema, so a rollback across it works." Not a rebuild: leave `REBUILDS` alone.
- `src/core/types.ts` `Session`: add `lastPromptAt: string | null;` after `lastSeenAt`, doc comment "When it last got a real prompt (not a background-task notice); null before migration 14 or its first one. The Board's answered-in-chat rule reads it."
- `src/server/repo/sessions.ts`: `last_prompt_at` in `SessionRow`, `toSession`, and `saveSession`'s UPDATE (column and bound value).
- `src/server/session-flow.ts` `case 'prompt'`: inside the existing `if (!input.notice)`, also set `next.lastPromptAt = now;` (make it a block). Nothing else sets it.
- Fixtures: add `lastPromptAt: null` to every `Session` literal the typecheck flags (test/ and web/).
- Tests: `test/server/migration14.test.ts` modelled on `migration12.test.ts` (column exists, existing rows NULL, `min_reader_version` 1). In the hook-event tests (`test/server/sessions.test.ts`): a real prompt sets `lastPromptAt` to the server clock; a notice prompt leaves it unchanged; start and stop leave it unchanged.

## Task 2: the lane rule (core)

`src/core/board.ts`:

- `MARKS`: append `'answered_in_chat'`.
- `BoardRow`: add `waiting: Ask[]` after `asks`, doc "Its open asks still waiting on Aiden, oldest first: `asks` less those answered in chat (answeredInChat)."
- Export `answeredInChat(ask: Ask, sessions: readonly Session[], driver: Session | null, now: number): boolean` implementing The rule above. `sessions` is `input.sessions`; a raiser missing from it counts as not live.
- In `deriveBoard`, per row: `const waiting = asks.filter((a) => !answeredInChat(a, input.sessions, driver, now));`. Push `'answered_in_chat'` when `waiting.length < asks.length` (after `stale_ask`, before `deep`). Pass `waiting` (not `asks`) to `isStalled`. Leave `ready` on `asks`. Put `waiting` on the row.
- Every `BoardRow` literal in tests and web fixtures gains `waiting` (equal to its `asks` unless the test is about this rule).

`src/core/taskState.ts`:

- `taskStateOf` lines 28-29: `row.waiting` in place of `row.asks` (the session `permission` state check stays as is).
- `taskBoxes` `needTime`: `row.waiting`.

Callers of `sinceFallback` pass the waiting asks: `src/server/repo/taskState.ts:60` (`row.waiting`) and `web/src/board/boxState.ts:27` (`box.row?.waiting ?? []`). `web/src/board/NeedsMe.tsx:43`: `box.row?.waiting ?? []`.

`web/src/board/Marks.tsx` `MARK_WORDS`: `answered_in_chat: 'answered in chat, not recorded'`. No other UI change. The HUD's ask count stays on open asks.

Tests (`test/core/taskState.test.ts`, `test/core/board.test.ts`), each with an explicit `now`:

- C1: raiser live and working, `lastPromptAt` after the raise: state `working`, cell `now`, mark present, `row.asks` still holds the ask, `row.waiting` empty. Same with the raiser idle: state `idle`, cell `now`.
- Prompt before the raise (or `lastPromptAt` null): cell `needs`, no mark.
- C2: two open asks, the second raised after the prompt: cell `needs`, state the second ask's kind, mark present.
- C3: raiser ended, step's live driver prompted after the raise: cell `now`. Raiser ended, driver prompted before the raise: `needs`. Raiser ended, no live driver: `needs`. Raiser stale (live by state, `lastSeenAt` past `STALE_SESSION_MS`) with a prompted driver: `now`.
- A null-session ask: `needs` whatever the sessions did.
- A session in `permission` state on the row: `permission`, even with the ask answered in chat.
- C5: the ask cleared: no mark (cleared asks are not open).
- `isStalled`: a driver idle past `STALL_MS` whose only ask is answered in chat is `stalled`.

## Task 3: the reminder line (server)

`src/server/repo/asks.ts`: export `asksToRemind(ctx, sessionId): Ask[]`, open asks (`cleared_at IS NULL`) in a live project (`inLiveProject`), oldest raised first (`ORDER BY raised_at, id`), where either:

- `session_id = ?` (its own), or
- the driver route: `node_id IN (SELECT id FROM nodes WHERE driver_session_id = ?)`, that node is the session's focus, `session_id IS NOT NULL AND session_id != ?`, and the raiser is not live: `NOT EXISTS (SELECT 1 FROM sessions r WHERE r.id = asks.session_id AND r.state != 'ended' AND r.last_seen_at >= ?)` bound to `msAgo(ctx, STALE_SESSION_MS)`.

Doc comment says it mirrors `answeredInChat`'s counting session in `src/core/board.ts`.

`src/server/session-flow.ts`, in the `input.event === 'prompt' && !input.notice` block after the answers lines: for each of `asksToRemind(ctx, sessionId)`, one line

    Open ask a7 on #391 <title>: "<text>". If this prompt answers it, put "a7 answered: ..." in your next scribe brief.

built as `` `Open ask ${askTag(a.id)} on ${stepRef(a.nodeId, title)}: "${oneLine(a.text)}". If this prompt answers it, put "${askTag(a.id)} answered: ..." in your next scribe brief.` `` with the title read from the node (`findNode`/`requireNode`, whichever the file already imports; `stepRef` from `src/core/step-ref.ts`). Order of the response: answers lines, then reminder lines, then any existing context. The read runs outside the write, like `undeliveredAnswers`.

Tests (hook-event tests next to the answers-line ones, `test/server/asks.test.ts` or `sessions.test.ts`, whichever holds `Answered:`):

- C4: a session raises an ask, a real prompt: the response context holds the exact line. A second real prompt: the line again.
- A notice prompt: no line.
- C5: after `clearAsk`, the next real prompt has no reminder line (and gets the `Answered:` line as today).
- Another session's ask on another step: not in this session's lines.
- Driver route: raiser ended, the prompting session drives and is focused on the step: line present; raiser still live: absent.

## Checks

From the worktree: `npm run typecheck`, `npm test`, `npm run test:smoke` (session-flow shapes the hook response). Murr on Opus (risk list: `src/server/db/`, `src/server/session-flow.ts`). Parvati on the marker in a Now box on a scratch server.
