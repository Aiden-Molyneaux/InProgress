# Delete a step from the Backlog (#405)

Branch `board-feedback`, worktree `C:/personal/InProgress/.claude/worktrees/board-feedback`. Label ui. Gates: typecheck, unit, one e2e for the feature (`INPROGRESS_E2E_PORT=4411`). Stay out of `web/src/board/DoneColumn.tsx`.

Aiden, 2026-10-13: remove means delete from the tree, not `dropped`. It can't be undone, so a confirm comes first.

## 1. Repo: a check inside the delete's write

`src/server/repo/nodes.ts:203` `deleteNode(ctx, actor, id, cascade = false)`. Add a last optional parameter `check?: (node: TreeNode, ids: number[]) => void`, called inside the `write` after `ids` is computed and before the descendants refusal, the way `addNodes` takes `check` (`:117` area). Existing callers are unchanged.

## 2. Server route

`src/server/routes/window.ts`, beside quick-add (`:65`):

```ts
// Delete a step from the tree (the Backlog's Delete). Never one with steps under it: those may be done, and deleting
// them would lose their history. Asks, resources and logs go with it (FK cascade); the queue drops it on read.
app.post('/api/ui/projects/:id/nodes/:node/delete', guarded, async (req) => { ... })
```

- Params: `:id` and `:node`. Add a schema in `src/server/schemas.ts` if `idParam` does not fit (for example `windowNodeParams = z.object({ id: <same as idParam>, node: <same> })`); match how `idParam` is written.
- Body `windowProjectBody` (`{ slug }`). `targetBySlug`, then `resolveProject` (a deleted project 404s, as for the queue route).
- `deleteNode(ctx, ACTOR, node, false, (n, ids) => { ... })`: `n.projectId !== projectId` → `badRequest(`#${node} is not in this project`, 'Reload the window.')`; `ids.length > 1` → `badRequest(`#${node} has steps under it`, 'Move or delete them first.')`. The root is already refused by `deleteNode`; a node that does not exist is whatever `requireNode` throws (404).
- Answer `{ ids }`.

Unit tests in `test/server/window-routes.test.ts` (`setup` at `:13`), a new `describe('node delete route')`:
- deletes a leaf: 200, `{ ids: [a] }`, the row is gone from `nodes`;
- refuses one with a child (add a child under `a` with `addNodes`): 400, both still there;
- refuses a node of another project (make a second project through the bearer API): 400;
- refuses the root: 400;
- a wrong slug is 409;
- without the UI token headers it is refused (match how the other routes' token test asserts).

## 3. Client API

`web/src/api.ts`, beside `createStep` (`:55`):

```ts
/** Deletes a step from the tree, by id; the server refuses one with steps under it. */
export const deleteStep = (projectId: number, slug: string, nodeId: number): Promise<UiResult> =>
  postUi(`/api/ui/projects/${projectId}/nodes/${nodeId}/delete`, { slug });
```

## 4. UI: Backlog row

`web/src/board/Backlog.tsx`. Backlog takes new props `projectId`, `slug` and `onStatus` (the type `BandProps['onStatus']`); `NextColumn.tsx:236` passes `project.id`, `project.slug`, `onStatus`. Handle the result the way `NextColumn.tsx:~73` does (`'reload'` the same way, any other non-`'ok'` string to `onStatus`).

- A second hover action after "to Next": `<button type="button" className="ip-hover-act" data-act aria-haspopup="dialog">Delete…</button>`, same show-on-hover-and-focus rule. Check the CSS for `.ip-hover-act` handles two of them in a line (spacing); add a rule in `web/src/styles.css` only if needed.
- State in `Backlog`: `confirming: number | null`, so one confirm is open at a time; opening another row's confirm closes the first.
- While a row is confirming, its `.ip-line` is replaced by an inline confirm, markup modelled on `web/src/chrome/TopBar.tsx:294-307` and styled by the existing `.ip-confirm` rules (`styles.css:164-169`):
  - wrapper `role="dialog"`, `aria-modal={false}`, `aria-labelledby` the `<b>` "Delete #{id} {title}?", `aria-describedby` the `<p>` "It can't be undone.";
  - buttons Delete (`ip-btn go`) and Cancel (`ip-btn`), both `type="button"`, inside `data-act` so `rowClick` ignores clicks there (the wrapper itself can carry `data-act`).
  - The `li` is `draggable={confirming !== row.node.id}` and drag start does nothing while confirming.
- Focus: Cancel when it opens (an effect or a ref callback). Escape (keydown on the dialog, `stopPropagation` so the board's keyboard handler does not also act) and Cancel close it and put focus back on that row's "Delete…" button.
- Delete: `noteAction('backlog', 'delete')` (extend the measure action type if `'delete'` is not in it), `const after = focusTargetAfter(li)` taken before anything changes, close the confirm, focus `after`, then `await deleteStep(...)` and send a refusal to `onStatus`.
- The ended line (`.ip-system-line`) stays under the confirm.

## 5. e2e

`test/e2e/ui.spec.ts`, after the "to Next" test (`:1981`), one test modelled on it with the `fresh` fixture: make two Backlog steps, open the fold, then
- Tab to the first row's "Delete…" (it shows on focus), Enter: a dialog named "Delete #id title?" is visible and focus is on Cancel;
- Escape: the dialog is gone and focus is on "Delete…";
- open it again, click Delete: the row is gone, Details did not open, and after `page.reload()` (and opening the fold again if it does not persist) the row is still gone and the second step is still there.

Run it 3 times with `--repeat-each=3` to check it is steady.

## Checks to run and report raw

- `npm run typecheck`
- `npx vitest run test/server/window-routes.test.ts` and then the full unit run `npm test` (or whatever `package.json` names it)
- `INPROGRESS_E2E_PORT=4411 npx playwright test test/e2e/ui.spec.ts -g "<the new test name>" --repeat-each=3`, and once the Backlog tests together (`-g "Backlog|to Next"`).
- No em dashes in any file (`test/repo/no-em-dash.test.ts`).
