# Build the backup strategy (#516)

Spec: `docs/superpowers/specs/2026-10-19-data-backup-strategy.md` (accepted by Aiden, 2026-10-19). Label data: typecheck + unit, full strict gates (smoke and e2e too, since `src/server` and `src/cli` change). No migration is added, so `min_reader_version` is untouched.

Worktree `.claude/worktrees/interesting-goldberg-e9fd8f`, branch `claude/interesting-goldberg-e9fd8f`.

## Criteria (the bar)

- C1 · The server is up for over 6 hours · expect a new `backups/inprogress-<stamp>.db` per tick when the data changed and none when it did not; the set obeys the tiered retention.
- C2 · Start a build whose schema is one additive migration ahead · expect `backups/inprogress-pre-v<N>-<stamp>.db` written before the migration runs.
- C3 · `inprogress backup --push` · expect a commit in `~/.inprogress/offsite` holding `schema.sql`, `data/*.sql`, `resources/`, `manifest.json`, pushed to the remote, within 30 seconds; `token`, logs, `server.pid` and `capture/` absent.
- C4 · `inprogress restore --from <offsite folder>` into a scratch `INPROGRESS_HOME` · expect a database identical to the source (every table's rows and the schema), `resources/` identical by hash.
- C5 · `inprogress doctor` · expect a Backups line naming the newest snapshot, the newest pushed commit, the last drill and the repo size, warning or failing at the spec's thresholds.

Owner's check: a list. C3 and the first real push are *after the gate* (they need the real remote).

## Design decisions (Sigmund's; Sev builds these, no design choices left)

- Every function takes `home` or a directory argument. Nothing in tests touches `~/.inprogress`.
- Snapshot identity is the SHA-256 of the snapshot file: two `db.backup()` copies of unchanged data are byte-identical (checked).
- One pre-migration copy per `openDb` pass, before the first pending migration, rebuild or additive, named for that first version (`inprogress-pre-v<N>-<stamp>.db`); deduplicated by prefix as today, so a migration that keeps failing copies once. Not for a database `migrate` creates from nothing, nor one newer than the build.
- The dump is canonical text. `schema.sql` holds the `CREATE TABLE` statements, then a line `-- inprogress-dump: after data`, then indexes, triggers and views. The loader runs the part above the line, the data, then the part below, so no trigger fires during a load.
- Offsite git work is async (`execFile`), never blocking the event loop; the dump itself is synchronous (a few hundred ms, once a day).
- The push credential helper is added only for an `https://github.com/<owner>/...` remote and uses `gh auth token --user <owner>`. A local path remote (tests) needs none.
- The clone gets `core.autocrlf=false` and a committed `.gitattributes` of `* -text`, so Windows git never rewrites the dump.
- Commits are made with `-c user.name="InProgress backup" -c user.email=inprogress-backup@localhost`.

## Task 1: canonical dump and loader (`src/server/dump.ts`, test `test/server/dump.test.ts`)

- `DUMP_SPLIT = '-- inprogress-dump: after data'`.
- `dumpDb(db: DB): { schema: string; tables: Record<string, string>; counts: Record<string, number> }`.
  - Schema: rows of `sqlite_master` with `sql IS NOT NULL` and `name NOT LIKE 'sqlite_%'`; tables (ordered by name) above the split line, then indexes, triggers, views (each group ordered by name) below. Each statement as stored, followed by `;\n`.
  - Data: one entry per table (by name), plus `sqlite_sequence` when it exists. Rows from `SELECT * FROM "<t>" ORDER BY rowid` (for a `WITHOUT ROWID` table, by its primary key columns from `pragma_table_info`), statement `.safeIntegers(true)`. One line per row: `INSERT INTO "<t>" VALUES(<v>,...);\n`. Quote identifiers by doubling `"`.
  - Values: `null` → `NULL`; bigint → decimal; number (a REAL) → `String(n)`, plus `.0` when the string has no `.`, `e` or `n` (so `1` becomes `1.0`); `Infinity` → `9e999`, `-Infinity` → `-9e999`; string → `'...'` with `'` doubled, except a string containing `\0`, which goes as `CAST(X'<utf8 hex>' AS TEXT)`; Buffer → `X'<hex>'`.
  - `counts` per table, `sqlite_sequence` included.
- `loadDump(file: string, dump: { schema; tables }): void`: refuse if `file` exists. `new Database(file)`, `foreign_keys = OFF`, then in one transaction: the schema part above the split, every table's data (`sqlite_sequence` last, after `DELETE FROM sqlite_sequence`), the part below. Then `journal_mode = DELETE` stays default (no WAL on the copy), close.
- `writeDump(dir, dump)` writes `schema.sql` and `data/<table>.sql`, removing any `data/*.sql` not in the dump; `readDump(dir)` reads them back.
- `tableDigest(db): Record<string, string>`: SHA-256 per table of its rows in the dump's order, each value tagged with its `typeof`, used by tests and the restore check to prove identity.
- Tests: a database with every value kind (NULL, small int, bigint above 2^53, REAL 1.0 and 0.1 and 1e300, text with `'`, `\r\n`, emoji, `\0`, a blob), a table with an AUTOINCREMENT id after deletes, an index, a trigger that would insert into another table, `openDb` schema with seeded rows from `createProject`/`addNodes`: dump, load, then schema rows and `tableDigest` equal the source and `sqlite_sequence` matches; the trigger did not fire during the load; dumping twice gives identical text; `integrity_check` ok on the load.

## Task 2: snapshots with tiered retention (`src/server/backup.ts`, test `test/server/backup.test.ts`)

- Keep `timestamp`, `truncateIfLarge`, `quickCheck`.
- `parseStamp(name): Date | undefined` for `inprogress-YYYYMMDD-HHMMSS.db` (local time).
- `keepSnapshots(names: string[], now: Date): Set<string>`: snapshot names only. Keep the newest 8 of those within 48 hours of `now`; the newest of each local calendar day for the 14 days back from `now`'s day (days `now - 13` to `now`); the newest of each ISO week (Monday start, local) for 8 weeks (`now`'s week and 7 before). Future-dated names are kept.
- `snapshotDb(db, dir, now = new Date()): Promise<{ file?: string; skipped?: 'unchanged' }>`: quick_check the live db (throws as today, same message); `db.backup` to `<target>.<pid>.tmp`; open the tmp read-only, `integrity_check` (full), close; on failure delete the tmp and throw `Skipped the database backup: integrity_check on the copy reported <first line>`. SHA-256 the tmp; if it equals the newest existing snapshot's file hash, delete the tmp and return `{ skipped: 'unchanged' }`. Else rename to `inprogress-<stamp>.db`, then delete every snapshot name not in `keepSnapshots`. Never touch any other file name.
- `prunePreMigration(dir, now)`: names `inprogress-pre-v<N>-<stamp>.db`; keep the newest 3 by stamp plus any under 30 days old; delete the rest. `pre-stage1-rollout-20261013.db` and `inprogress-pre-restore-*` match neither pattern and stay.
- Remove `backupDb` and its `keep` argument once main.ts uses `snapshotDb`. Update the existing tests to the new API, plus: retention on a synthetic list over 10 weeks (exact expected set), skip when unchanged, a new file after a write, integrity failure leaves no file, the stray names survive pruning.

## Task 3: pre-migration copy (`src/server/db/connection.ts`, test in `test/server/db.test.ts`)

- Rename the hook `beforeRebuild` to `beforeMigrate(toVersion)`. In `migrate`, before the loop: `const start = schemaVersion(db)`; if `!fresh && start < MIGRATIONS.length`, call `opts.beforeMigrate?.(start + 1)` once. Remove the call inside the loop; the foreign_keys handling for rebuilds is unchanged.
- In `openDb`, the hook keeps its prefix dedupe, tmp and rename, and calls `prunePreMigration(dir, new Date())` after a successful rename (inside try, errors swallowed: pruning never blocks a start).
- Tests: build a database at `MIGRATIONS.length - 1` the way `at12` in `test/server/migration13.test.ts` does (`MIGRATIONS.slice(0, n)` plus `schema_version`). `openDb` on it writes exactly one `inprogress-pre-v<len>-*.db` copy whose `schema_version` is `len - 1` (the last migration is additive, so this proves the additive case); a fresh database gets none; an up-to-date one gets none. Adapt the existing `beforeRebuild` tests in `migration13.test.ts` (lines 152 to 245) to `beforeMigrate`: the at-12 database still gets one copy named `pre-v13`, the dedupe and `.tmp` cases keep passing. Pruning: four old `pre-v*` copies over 30 days plus one recent leave the newest 3 old ones and the recent one, and `pre-stage1-rollout-20261013.db` survives.

## Task 4: off-machine copy (`src/server/offsite.ts`, test `test/server/offsite.test.ts`)

- `offsiteDir(home) = join(home, 'offsite')`. `git(args, cwd)` wraps `execFile('git', ...)` with `windowsHide`, a 120 s timeout, and returns stdout or throws with stderr in the message.
- `credentialArgs(remoteUrl)`: for `https://github.com/<owner>/...`, `['-c', 'credential.helper=', '-c', "credential.helper=!f() { echo username=x-access-token; echo password=$(gh auth token --user <owner>); }; f"]`; else `[]`.
- `initOffsite(home, remoteUrl)`: refuse if the folder exists. `git clone <url> offsite` (with credential args); set `core.autocrlf false` in it; write `.gitattributes` (`* -text\n`) and a `README.md` line saying what the repo is and how to restore (`inprogress restore --from <clone>`).
- `exportOffsite(db, home, now)`: in `offsite/`: `db.backup` to a temp file under `os.tmpdir()`, open it, `integrity_check`, `dumpDb`, close and delete it; `writeDump`; mirror `home/resources` to `offsite/resources` (copy new and changed files, delete ones gone, by SHA-256); write `manifest.json` (2-space JSON): `format_version: 1`, `created_at`, `home` (forward slashes), `version` (VERSION), `git_sha` (readBuild()?.sha ?? null), `schema_version`, `min_reader_version`, `integrity_check`, `tables` (counts), `resources: { count, bytes, files: { "<relpath with />": sha256 } }`. Then verify: `loadDump` into a temp file, `integrity_check`, row counts equal `manifest.tables`; any mismatch throws `Refused the backup commit: ...` before git runs.
- `commitOffsite(home, now)`: `git add -A`, `git commit -m "Backup <iso>"` with the user name and email above. Returns the new sha.
- `pushOffsite(home)`: `git push origin HEAD:main` with credential args from `git remote get-url origin`.
- `runOffsite(db, home, log, { force, now })`: no-op returning `'not set up'` when `offsite/.git` is missing. A lock file `offsite/.git/inprogress-backup.lock` (`wx`; one older than 10 minutes is taken over) guards it; a held lock returns `'busy'`. Commit when `force` or the HEAD commit is older than 24 hours (or there is none). Push when `force`, or when `git rev-list --count origin/main..HEAD` is above 0 (or `origin/main` does not exist and HEAD does). A failed push logs and leaves the commit queued. Never throws from the tick path: `log.error` instead.
- `runDrill(home, now)`: `git clone --depth 1 <origin url>` into a temp folder (credential args), `readDump`, `loadDump` to a temp db, `integrity_check`, counts against the clone's manifest, every resource file's SHA-256 against the manifest. Returns `{ at, ok, detail, commit }`; writes it as JSON to meta key `backup_drill` through a db handle passed in. Temp folders removed either way.
- Tick: `runOffsite`, then the drill when `backup_drill` is missing or older than 7 days and offsite is set up.
- Tests (a bare repo made with `git init --bare` in a temp dir as the remote; remote url is the path): init and push lands a commit on the bare repo holding the expected files and none of `token`, `server.log`, `hooks.log`, `server.pid`, `capture/`; a tick within 24 hours makes no commit; `force` does; a push to a missing remote leaves the commit and the next tick pushes it once the remote is back; a count mismatch (inject by stubbing, or by corrupting the written data file before verify via an exported seam) refuses the commit; the drill passes, and fails after a resource file in the bare repo's history is changed in a new commit without updating the manifest; `.gitattributes` keeps a `\r\n` value byte-exact through the round trip.

## Task 5: restore (`src/cli/restore.ts`, test `test/cli/restore.test.ts`)

- `runRestore(args, out, { home, serverUp: () => Promise<boolean> })`. `--from` takes a `.db` file, a folder holding `manifest.json` (a clone), or anything else as a commit in `offsite/` (checked out with `git clone --shared --no-checkout offsite <tmp>` then `git -C <tmp> checkout <commit>`). No `--from`: the newest `backups/inprogress-<stamp>.db`.
- Refuse with exit 1 while `serverUp()`: "Stop InProgress first: inprogress stop".
- Pre-restore: if `inprogress.db` exists, open it (read-write; the server is down) and `backup()` it to `backups/inprogress-pre-restore-<stamp>.db`; if `resources/` exists and the source is a dump, copy it to `backups/resources-pre-restore-<stamp>/`.
- Build `inprogress.db.restore-<pid>.tmp` in `home`: from a `.db`, open it read-only and `backup()`; from a dump, `loadDump`, then row counts against the manifest. `integrity_check` either way. Rewrite the `resources.path` prefix when the manifest's `home` differs from this `home` (compare forward-slashed, case-insensitive on win32): `UPDATE resources SET path = <new> || substr(path, length(<old>) + 1) WHERE lower(substr(path, 1, length(<old>))) = lower(<old>)`, both forward-slashed.
- Delete `inprogress.db-wal` and `-shm`, rename the tmp over `inprogress.db`. From a dump, replace `home/resources` with the source's `resources/`. Leave `token` alone (a new machine has none; the next start makes one).
- Print what it did, including the pre-restore copy's path. Any failure deletes the tmp and leaves the current database untouched.
- Tests: refused while up; from a snapshot; from an offsite folder into a scratch home with a different path (prefix rewritten, `tableDigest` otherwise equal, resources equal by hash); from a commit; leftover `-wal` removed; a damaged source leaves the live file unchanged.

## Task 6: CLI and server wiring

- `src/cli/commands.ts`: `backup [--push] [--drill] [--init <remote url>]` and `restore [--from <x>]`, added to USAGE. `backup` alone takes a snapshot (opening the live db with plain `new Database(file, { fileMustExist: true })` and `busy_timeout`, no migrate); `--push` runs `runOffsite` with `force`; `--drill` runs the drill and prints it; `--init` runs `initOffsite` then `--push`. Logs go to `out`.
- `src/server/main.ts`: at start, `snapshotDb` replaces `backupDb` (same place, same catch). The maintenance interval callback becomes one function `tick()` that awaits `snapshotDb` (caught, logged), then `runMaintenance`, then `runOffsite` and the drill (caught, logged), guarded by a `ticking` flag so ticks never overlap. At start, after `runMaintenance`, kick the offsite part off without awaiting it.
- Tests: commands test covers `backup` writing a snapshot in a temp home and USAGE listing both.

## Task 7: doctor Backups check (`src/cli/doctor.ts`, tests in `test/cli/commands.test.ts`)

- `backupsCheck(home, serverUp: boolean, now)`: newest snapshot age (warn when over 26 hours and the server is up); newest pushed commit from `git -C offsite log -1 --format=%cI origin/main` (sync `execFileSync`, no network; warn over 3 days, fail over 7; warn "not set up: run inprogress backup --init <remote url>" when missing); `backup_drill` from meta read-only (warn when missing, failed, or over 14 days); repo size from `git count-objects -v` (`size-pack` plus `size`, KiB; warn over 500 MB). Detail lists each part. `warnOnly` unless the push is over 7 days.
- `restoreHint` gains: "or run `inprogress restore` (newest snapshot) or `inprogress restore --from <home>/offsite`".
- Tests with fixed `now`: fresh snapshot and recent push ok; 4-day push warns; 8-day push fails; no offsite warns; failed drill warns.

## Order

Tasks 1 to 7 in order; each with its tests, `npm run typecheck` and `npx vitest run <its test files>` green before the next. At the end, `npm test` in full and `npm run test:smoke`.
