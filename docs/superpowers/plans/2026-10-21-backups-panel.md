# #556 Backups panel in the window: status, Back up now, Open folder

Branch `claude/dreamy-wright-835831`, worktree `.claude/worktrees/v3-board-aa87e5`, label ui. Follows #516 (spec `docs/superpowers/specs/2026-10-19-data-backup-strategy.md`).

## Criteria (depth: a list)

- C1 · Click Backups in the footer · a modal panel opens within 1 s showing the newest snapshot (name, age), the newest pushed commit (age), the last drill (passed or FAILED, age) and the backup repo size, each marked ok, warn or fail by doctor's thresholds.
- C2 · With the off-machine copy set up, click Back up now · the button reads Backing up… and is disabled; then the panel says Backed up and pushed., the Pushed row reads a few seconds old, and the remote has a new `Backup <iso>` commit. A second click while it runs starts nothing.
- C3 · While another run holds the lock (`offsite/.git/inprogress-backup.lock`, under 10 minutes old) · Back up now is disabled and the panel says another backup is running.
- C4 · Click Open backups folder · the server opens `<home>/backups` in the file manager (created first if missing).
- C5 · The Restore section · shows `inprogress stop`, `inprogress restore` (naming the newest snapshot it restores) and `inprogress restore --from <offsite path>`, each with a Copy button. There is no restore action in the window.
- C6 · Esc, the Close button or a press on the backdrop · closes the panel, and focus returns to the footer's Backups button.

## Decisions (Sigmund, unattended; name them in the receipt)

- Placement: the footer, between the key hints and the server line. The window has no settings surface; the footer already carries housekeeping (server and build). No keyboard shortcut.
- The panel is a native `<dialog>` opened with `showModal()`, following `web/src/chrome/GoTo.tsx` (opener remembered, Esc handled in keydown with `onCancel` preventDefault, backdrop press closes, `onClose` keeps state in step).
- Back up now = `snapshotDb` then `runOffsite(..., { force: true })`, serialized with the server's own tick through one in-process flag. The POST awaits the run and answers its result plus fresh status.
- Thresholds and doctor's wording live once, in `src/server/backup-status.ts`. Doctor's output stays byte-identical.
- The status read is async (no `execFileSync` in the server): the hooks share the event loop.

## Task 1 · shared status module

`src/core/backups.ts` (types only, so `web/` can import them):

```ts
export type BackupLevel = 'ok' | 'warn' | 'fail';
export interface BackupStatus {
  backupsDir: string;
  offsiteDir: string;
  /** at: ISO of max(stamp, mtime), as doctor ages it. */
  snapshot: { name: string; at: string; level: BackupLevel; note?: string } | null;
  setUp: boolean; // offsite/.git exists
  pushed: { at: string; level: BackupLevel; note?: string } | null;
  drill: { at: string; ok: boolean; detail: string; level: BackupLevel; note?: string } | null;
  repoBytes: number | null;
  repoLevel: BackupLevel;
  busy: boolean;
  warnings: string[];
  fail: boolean;
  /** Doctor's Backups check, exactly as `inprogress doctor` prints it. */
  check: { name: 'Backups'; ok: boolean; warnOnly?: boolean; detail: string };
}
```

`src/server/backup-status.ts`:

- `backupStatus(home, { serverUp, now, drill? }): Promise<BackupStatus>`. `drill` undefined reads the stored drill from `<home>/inprogress.db` read-only (move doctor's `readDrill`); `null` means none; the server passes `lastDrill(db) ?? null`.
- `backupsCheck(home, serverUp, now)` resolves to `(await backupStatus(...)).check`.
- Move the logic of `backupsCheck` from `src/cli/doctor.ts:133-189` unchanged in effect: same parts, same warnings, same order, same `ago()` text, same thresholds (snapshot 26 h while the server is up; push warn 3 d, fail 7 d; drill missing, failed, or over 14 d; repo over 500 MB). Each row's `note` is the warning it raised, if any.
- Git through an async `execFile` with a 10 s timeout, `windowsHide`, `GIT_TERMINAL_PROMPT=0`, failures as undefined (doctor's `gitQuiet`, async).
- `busy` = `lockHeld(offsiteDir)`: add `export function lockHeld(dir: string): boolean` to `src/server/offsite.ts` (the lock file exists and its mtime is under `LOCK_STALE_MS` old).
- `src/cli/doctor.ts` imports `backupsCheck` from the new module and awaits it in `runChecks`; drop what becomes unused there.
- Move the Backups tests at `test/cli/commands.test.ts` (~640-715, the `backupsCheck` cases and their `homeWith` helper) to `test/server/backup-status.test.ts`, awaiting; add cases for the structured rows (levels and notes) and `lockHeld`.

## Task 2 · runner

`src/server/backup-runner.ts`:

```ts
export interface BackUpNowResult { status: 'ok' | 'busy' | 'not set up' | 'failed'; snapshot?: 'written' | 'unchanged' | 'failed'; message: string }
export interface BackupRunner { running(): boolean; startup(): void; tick(): Promise<void>; backUpNow(): Promise<BackUpNowResult> }
export function createBackupRunner(o: { db: DB; home: string; log: OffsiteLog; maintenance: () => void }): BackupRunner;
```

- One flag. `startup()` runs `tickOffsite` in the background under it (today's `main.ts:100-103`). `tick()` returns at once while the flag is set, else snapshot, `maintenance()`, `tickOffsite` (today's `main.ts:88-98`).
- `backUpNow()`: flag set, or `lockHeld` → `{ status: 'busy', message: 'Another backup is running: try again in a few minutes' }`. Else set the flag; `snapshotDb(db, join(home, 'backups'))` (`file` → written, `skipped` → unchanged, a throw → failed, logged); then `runOffsite(db, home, capture, { force: true })`, where `capture` forwards to `log` and keeps the last error message. Messages:
  - ok, snapshot fine: `Backed up and pushed.`
  - not set up: `Took a snapshot. The off-machine copy is not set up: run inprogress backup --init <remote url>`
  - busy (lock taken by another process meanwhile): the busy message above
  - offsite failed: the captured error
  - snapshot failed: status `failed`, message `The snapshot failed: <error>` plus the offsite outcome.
  Clear the flag in `finally`.
- `src/server/main.ts`: replace the `ticking` logic with the runner; the runner's log forwards to `app.log` through a closure; pass `home` and the runner to `buildApp`.
- Tests `test/server/backup-runner.test.ts`: a second `backUpNow` while the first runs answers busy; `tick()` during `backUpNow` does nothing; against a local bare remote (copy the setup in `test/server/offsite.test.ts:~30`, with `core.hooksPath` pointed at a missing folder per `docs/known-issues.md`), `backUpNow` leaves one `Backup ` commit on the remote's main; not set up still writes a snapshot.

## Task 3 · routes

`src/server/routes/backups.ts`, `registerBackupRoutes(app, opts, requireUi)`, registered from `buildApp` only when `opts.home` and `opts.backups` are given. `AppOptions` gains `home?: string`, `backups?: BackupRunner`, `openFolder?: (path: string) => Promise<void>`.

- `GET /api/backups` → `backupStatus(home, { serverUp: true, now: new Date(), drill: lastDrill(ctx.db) ?? null })` with `busy: status.busy || runner.running()`. A read, like the other GETs.
- `POST /api/ui/backups/run` (`onRequest: requireUi`) → `{ result: await runner.backUpNow(), status: <fresh status> }`, 200 for every result.
- `POST /api/ui/backups/open-folder` (`requireUi`) → `mkdir -p <home>/backups`, then `(opts.openFolder ?? openFolder)(dir)`, `{ ok: true }`.
- `src/server/open-path.ts`: `export async function openFolder(path: string)`: win32 `explorer.exe <resolved path>` by absolute path (`systemRoot()`), darwin `open <path>`, else `xdg-open <path>`, through `launch`.
- Tests `test/server/backup-routes.test.ts`: GET shape against a temp home; both POSTs refuse without the UI token (401) and with a foreign Origin (403); run answers a stub runner's result; open-folder creates the folder and calls the stub with it.

## Task 4 · the panel

- `web/src/api.ts`: `backups()` (getJson), `backUpNow()` (sendUi, body `{}`), `openBackupsFolder()` (postUi).
- `web/src/chrome/backupsLogic.ts`, pure, unit-tested in `test/web/backupsLogic.test.ts`: `backupRows(status, now)` → `{ label: 'Snapshot' | 'Pushed' | 'Drill' | 'Repo', value, level, note? }[]` (ages through `relativeTime` from `web/src/time.ts`; not set up → one Pushed row `not set up` at warn with the `inprogress backup --init <remote url>` hint; size as `12.3 MB`); `worstLevel(status)`; `restoreCommands(status)` → the three commands of C5, `--from` with `offsiteDir`.
- `web/src/chrome/Backups.tsx`: the footer button `Backups` with a level mark (`aria-haspopup="dialog"`, `aria-expanded`, a `title` naming the worst warning), and the `<dialog>` (`aria-label="Backups"`): rows; Back up now (disabled while `busy` or in flight; reads `Backing up…` in flight); Open backups folder; a `role="status"` line for the last result or the busy message; the Restore section with one line per command and a Copy button each (`navigator.clipboard.writeText`, button reads `Copied` for 1.5 s), the newest snapshot named under `inprogress restore`, and the sentence `Restore runs in the CLI, with InProgress stopped.`; a Close button. Status is fetched when the footer mounts (for the mark) and on every open; while open and `busy` from someone else's run, refetch every 3 s.
- `web/src/chrome/Footer.tsx`: render it between the keys and the server line.
- Styles in `web/src/styles/chrome.css`, matching `.ip-goto-btn` and `.ip-cmdbar`: ok marks in `--text-muted`, warn and fail in `--alarm` (fail also says FAIL). Fits at 375 px wide.

## Task 5 · e2e

In `test/e2e/ui.spec.ts`, one test, "the Backups panel shows status, backs up to a local remote and opens the folder":

- Setup: a bare repo in a temp folder (`git init --bare --initial-branch=main`), cloned to `.e2e-home/offsite`, with local config `core.autocrlf=false` and `core.hooksPath=<clone>/.git/no-hooks`. Remove both in `finally`.
- C1: open from the footer, see the Snapshot row (the server's start wrote one) and Pushed `nothing pushed yet`.
- C4: `page.route('**/api/ui/backups/open-folder')` fulfils `{ ok: true }`; one request after the click.
- C2: click Back up now: disabled, then `Backed up and pushed.`; `git --git-dir <bare> log --format=%s main` gives one line starting `Backup `.
- C3: write the lock file, reopen: Back up now disabled and the busy line shown; delete it.
- C5: the `--from` line holds the offsite path. C6: Esc closes, focus on the Backups button.

## Checks

`npm run typecheck`; `npm test`; e2e: `INPROGRESS_E2E_PORT=4411 npm run test:e2e -- -g "Backups panel"`.

## Out of scope

Restore from the window; moving the dump off the event loop (#521); a keyboard shortcut.
