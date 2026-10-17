# #470 Mark a step done from its Now row: plan

Handoff: `~/.inprogress/resources/inprogress/2026-10-17-done-button-on-now.md` (r296). Branch `claude/done-from-now`, worktree `.claude/worktrees/elastic-clarke-52592c`. Label: ui (plus a one-line skill edit under `claude/`).

## Decisions

- Aiden, 2026-10-17: the outcome is optional; an empty one leaves the `no_outcome` mark, and Mip fills it from git and the handoff rather than asking him. A live driver gets named in the confirm; that session keeps its focus and the step carries `done_focus` until it claims something else, ends or goes stale. The digest marks window-closed steps ` (you)`.
- Sigmund: a step with open child steps (status not done or dropped) is refused, naming them. The control still shows on such a box; the refusal shows in the form.
- Sigmund: the form is the confirm. One form for every box: a title line, the driver line when there is a live driver, the outcome field, Mark done and Cancel. Enter in the field is Mark done.
- Sigmund: the window sends the live driver it showed (`driver`, a session id or null). The server refuses (409) when the step now has a different live driver, so a stale window cannot close a step under a session it never named.
- Sigmund: idempotent. A step already done answers as it stands, whatever the body says (and whatever its driver or children), except that an outcome sent for one whose stored outcome is empty fills it.
- #461 has not landed; this branch edits `src/server/digest.ts` first.

## Task 1: server

1. `src/server/schemas.ts`, next to `windowClearBody`: `windowDoneBody = z.object({ slug: windowProjectBody.shape.slug, outcome: z.string().max(2_000).optional(), driver: z.string().max(100).nullable() }).strict()`, with a one-line doc comment.
2. `src/server/repo/nodes.ts`:
   - Move the body of `updateNode`'s write callback after `requireNode` into an unexported `patchWithAsks(ctx, record, actor, before, patch)` (the drop and question-node ask clearing, then `patchNode`). `updateNode` calls it; behaviour unchanged.
   - Add exported `finishNode(ctx, actor, id, outcome: string | undefined, check: (before: TreeNode) => void): TreeNode`. Inside one `write()`: `before = requireNode`, `check(before)`; if `before.status === 'done'`, fill an empty stored outcome from a non-empty trimmed one with `patchNode`, else return `before`; else `patchWithAsks` with `{ status: 'done' }` plus `outcome: outcome.trim()` only when the trimmed outcome is non-empty (an empty one leaves any existing outcome as it is). Doc comment says: the window's Done; already done answers the step as it stands and writes nothing, except that an outcome sent for one with an empty stored outcome fills it.
3. `src/server/routes/window.ts`:
   - Helper `liveDriver(ctx, n)`: `n.driverSessionId` when that session has `focus_node_id = n.id`, `state != 'ended'` and `last_seen_at >= now - STALE_SESSION_MS` (the same live rule as `notInBacklog`), else null.
   - Route `POST /api/ui/projects/:id/nodes/:node/done`, guarded. Parse `windowNodeParams` and `windowDoneBody`; `projectId = targetBySlug(req.params, slug)`; `resolveProject(ctx, projectId)` (a deleted project is 404, as for the delete route). Then `finishNode(ctx, ACTOR, node, outcome, check)` where `check(n)`, in this order:
     1. `n.projectId !== projectId`: `badRequest('#<node> is not in this project', 'Reload the window.')`
     2. `n.parentId === null`: `badRequest('#<node> is the project root', 'Reload the window.')`
     3. `n.status === 'done'`: return (idempotent)
     4. `n.status === 'dropped'`: `badRequest('#<node> is dropped', 'Reload the window.')`
     5. open children (`SELECT id FROM nodes WHERE parent_id = ? AND status NOT IN ('done', 'dropped') ORDER BY id`): `badRequest('#<node> has open steps under it: #a, #b', 'Finish or drop them first.')` (check the column names in `src/server/db/schema.ts`)
     6. `const live = liveDriver(ctx, n); if (live !== null && live !== driver)`: `conflict('A session is driving #<node> now', 'Look again: the box names it.')`
   - Answer `{ node }`. Update the file's top comment list of window writes.
4. `test/server/window-routes.test.ts`, new `describe('node done route')`: marks done with an outcome (status, outcome, `completed_at` set, `driver_session_id` cleared, one `node.updated` event with actor `window`); empty and whitespace outcome leaves the outcome empty; idempotent (second call 200, same node, outcome unchanged, no new event); wrong project 400; slug mismatch 409; dropped 400; root 400; open child 400 naming it, a done child does not block; live driver: refused 409 with `driver: null`, done with `driver: <that id>`, and the session keeps `focus_node_id` (so the board gives `done_focus`); a question-kind step clears its open ask with the outcome as answer; no UI token 401/403 as the other routes test.

## Task 2: digest

1. `src/server/digest.ts`: done items gain `byYou: boolean`. Read `SELECT entity_id, actor FROM events WHERE project_id = ? AND type = 'node.updated' AND ts >= ? AND json_extract(data, '$.changes.status.to') = 'done' ORDER BY id` (from = the digest's `from`); the last row per node wins; `byYou` is `actor === 'window'`. The Done line ends ` (you)` when `byYou`: `#12 Title: "outcome" (you)` and `#12 Title (you)`. Update `readDigest`'s doc comment (events now also say which done steps the window closed).
2. `test/server/digest.test.ts`: a step closed with actor `window` reads ` (you)` (with and without outcome); one closed by `scribe:x` does not; window done then reopened then done by the scribe does not; fix existing `toEqual`s on done items for the new field.

## Task 3: window

1. `web/src/api.ts`: `markDone(projectId, slug, nodeId, outcome: string, driver: string | null): Promise<UiResult>` posting `{ slug, driver }` plus `outcome` only when trimmed non-empty. Doc comment.
2. `web/src/board/NowColumn.tsx`, following `Backlog.tsx`'s confirm and pending pattern:
   - State: `closing: number | null` (one form at a time), `pending: number[]`, `problem: string | null`, `text: string`. `projectId` and `slug` from `snapshot.project`.
   - Each Now box gets `className` `ip-now-row` plus ` confirming` / ` pending`, `still={closing || waiting}`, `li` with `aria-busy` while pending, and while closing the same `onMouseDown` (press outside the form's buttons and field focuses the form) and `onKeyDown` (Escape closes) as Backlog.
   - `extra` when not closing: `<button type="button" className="ip-hover-act" data-act data-done aria-haspopup="dialog">Done…</button>` that opens the form.
   - The form, after the session lines (children): `div.ip-confirm.ip-done-form`, `role="dialog"`, `aria-modal={false}`, `aria-labelledby`, `aria-describedby` (the driver line when shown), `tabIndex={-1}`, `data-act`:
     - `<b>Mark #{id} {title} done?</b>`
     - when `row.driver` is set: `<p>“{sessionDisplayTitle(row.driver)}” drives it. It stays on this step until it claims another, ends or goes stale.</p>`
     - `<input className="ip-answer" aria-label="Outcome (optional)" placeholder="Outcome (optional), then Enter" maxLength={2000}>`; readOnly (not disabled) while the request is out. Enter (not while composing) marks done; Escape closes (preventDefault and stopPropagation).
     - buttons `Mark done` (`ip-btn go`) and `Cancel` (`ip-btn`, `data-cancel`).
     - `{problem && <div className="ip-problem" role="alert">{problem}</div>}`
   - Opening focuses the field. Cancel and Escape close, clear the text and problem, and put focus back on that box's `[data-done]` once drawn (requestAnimationFrame, as Backlog's `refocus`).
   - Mark done: `noteAction('now', 'done')` (`'done_empty'` when the outcome is empty is not needed: one action name). `after = focusTargetAfter(li)`; add to pending; send `markDone(projectId, slug, id, text, row.driver?.id ?? null)`. `'ok'`: close the form, and focus `after` only if focus is still in that row or fell to the body. `'reload'`: reload. Any other string: drop from pending (flushSync), keep the form open, show the problem, focus the field.
   - An effect like Backlog's: a box that left Now no longer pends or confirms; if it took focus with it, the band heading gets it.
3. `web/src/styles.css`: `.ip-now-row.pending` gets Backlog's pending rules (extend the `.ip-backlog-row.pending` selectors); `.ip-now-row .ip-confirm { max-width: none; }` beside the Backlog one; the field inside the form needs a small top margin only if it looks cramped.
4. `test/e2e/ui.spec.ts`, one test after the Backlog Delete test, `Now "Done…" takes an optional outcome, Escape keeps the step, Enter marks it done`: on a Now box, Done… opens the form with focus in the field; Escape closes it, the step stays in Now, focus is back on Done…; reopen, type an outcome, Enter: the box leaves Now and shows in Done, and the stored step has that outcome. Then on a step a live session drives (claim it in the test through the API the fixture uses), the form names that session. A refusal path: mock a 400 with `page.route` as the Delete test does and check the problem line shows and the form stays.

## Task 4: spec and skill

1. `docs/superpowers/specs/2026-10-12-board-and-asks-design.md`:
   - 1.7 (around line 174): events also say which done steps Aiden closed from the window; past the 30-day pruning those read as not his.
   - The Now cell description (around line 218): a Now box's Done… opens a form with an optional outcome that marks the step done; it names a live driver, which keeps its focus (`done_focus`).
   - Digest step 2 (around line 456): steps done with outcomes, those Aiden closed from the window ending ` (you)`.
   - D6 window writes list (around line 483): add "marking a step done from Now".
2. `claude/skills/mip-orc/SKILL.md` line 47 (`no_outcome`): add one sentence: for a step Aiden closed from the window (its Done line ends ` (you)`), propose from the handoff and git log as usual, and when nothing there says what was done leave it empty rather than ask him.

## Checks

From the worktree: `npm run typecheck`, `npm test`, and the new e2e test narrowed with `-g`, with `INPROGRESS_E2E_PORT` in 4410 to 4419. Also the existing Now and Backlog e2e tests (`-g "Now"`, `-g "Backlog"`), since the box gained a button.

## Out of scope

- A Done control anywhere but Now (Details, Next, Backlog).
- Mip changes beyond the one sentence.
