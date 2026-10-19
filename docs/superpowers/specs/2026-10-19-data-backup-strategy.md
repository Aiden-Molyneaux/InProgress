# Backup strategy for InProgress's real data (#514)

Status: recommendation, awaiting Aiden's ruling. Research only; nothing here is built. The build becomes its own change step, run through Sigmund.

## Recommendation

Keep the local snapshots, fix their gaps, and add one off-machine copy: a private GitHub repo on Aiden's personal account that holds a plain-text SQL dump of the database plus the `resources/` tree, committed once a day and pushed with the personal token InProgress already uses to push `main`. Git history then gives point-in-time recovery for both the database and the resources at no cost, the clone on disk doubles as a local versioned copy of `resources/`, commits queue up while Aiden is offline and push when he is back, and a dump is text, so it diffs well, packs small and can be read by eye when something looks wrong. Locally, snapshots move from "once per server start, keep 7" to a timer with tiered retention, a copy before every migration (not just table rebuilds), and `integrity_check` on the copy. A weekly drill rebuilds the database from a fresh clone of the remote and compares row counts, and `inprogress doctor` warns when the newest off-machine copy or drill is stale. From InThink, borrow the manifest and the check-the-copy habit; don't share or port its archive or restore engine (see question 6).

## Options for the off-machine copy

| Option | Cost | Privacy | Setup | Offline | Verdict |
|---|---|---|---|---|---|
| Private GitHub repo, SQL dump + resources, daily commit | Free | Private repo on Aiden's personal account; plaintext at rest on GitHub unless encrypted (which loses the diff benefit) | Low: `gh` and the personal token are already set up | Commits locally, pushes later | **Recommended** |
| Personal OneDrive folder, copy finished snapshots in | Free (5 GB) | Microsoft personal account | Medium: personal OneDrive is not signed in on this laptop (`OneDriveConsumer` is unset, `~/OneDrive` is empty) and a work device may block it | Syncs later | Good fallback if a personal sign-in is allowed |
| Work OneDrive ("OneDrive - Versaterm Inc") | Free | Employer tenant: IT can read it, and it goes when the job or the laptop does | None, already syncing | Syncs later | Rejected: personal data on employer storage, and it fails the "lost or reimaged work laptop" case it is meant to cover when the account is closed |
| Push snapshots to InThink on Railway | Railway volume space | Aiden's own server | High: InThink has no endpoint for it (its `mip` module is the ambient companion, not an InProgress link), so it needs a new authenticated upload route, storage and retention | Needs a local queue | Rejected for now: couples InProgress's survival to InThink, and the volume is a single copy that InThink's own backups also sit on |
| Object storage (Cloudflare R2, Backblaze B2) with restic or rclone | Free tier or cents a month | Encrypted client-side by restic | Medium to high: an account, keys to store, and a binary to install on a work laptop | Needs a local queue | Best if Aiden wants encryption at rest; the second choice |

Syncing the live `inprogress.db` or its `-wal` file through any of these is unsafe (a sync tool can copy the db and the WAL at different moments, and WAL frames are only valid against the db they belong to). Every option above works from a finished, checked snapshot, never the live files.

## 1. Threat model

Observed on 2026-10-19: `inprogress.db` is 7.5 MB with a 2.4 MB WAL, `resources/` is 2.1 MB in 162 files, `backups/` is 60 MB. The 7 rotating copies run from 2026-10-17 17:24 to 2026-10-19 08:41: deploys restart the server so often that the rotation holds under two days of history.

| Loss | Covered today? | Under the recommendation |
|---|---|---|
| Dead disk | No: every copy is on the same disk | GitHub remote |
| Lost, stolen or reimaged laptop | No | GitHub remote; restore onto a new machine (see the restore path below) |
| `~/.inprogress` deleted by accident, or encrypted by malware | No: `backups/` sits inside it | GitHub remote, with force-push to the backup branch disabled so history can't be rewritten from the laptop |
| Table-rebuild migration goes wrong | Yes: `connection.ts:16-37` copies the db aside (`inprogress-pre-v<N>-*`) before a rebuild | Same, plus pruning |
| Additive migration goes wrong | Partly: the start backup runs at `main.ts:80`, after `openDb` migrates at `main.ts:34`, so the newest pre-migration state is the previous start's backup and anything written since is lost | A copy before every migration, rebuild or not |
| Bad write or bug noticed days later (a wrong purge, a script that rewrites rows) | Only for under two days, since restarts rotate the 7 copies out | 14 dailies, 8 weeklies locally; full history in git |
| Server runs for weeks without a restart | No new backups after the first | Timer snapshots |
| `resources/` file deleted or overwritten | No: `resources/` is not backed up at all | Daily in git, with history |
| Physical corruption of the db | Partly: `backup.ts:23-24` refuses to back up a db that fails `quick_check`, so good copies are not displaced; nothing alerts beyond a log line | Same refusal, `integrity_check` on the copy, and a doctor warning when the newest good snapshot is stale |
| Logical corruption that passes `quick_check` | Only for under two days | Depth of history (dailies, weeklies, git) |

Not worth backing up: `token` (a secret, kept out of the remote; regenerate on restore), `server.log`, `hooks.log`, `server.pid`, and `capture/` (6 MB of debug JSONL from 2026-10-07 to 10-09, switched off).

## 2. Where the off-machine copy lives

A private repo on Aiden's personal GitHub account, for example `Aiden-Molyneaux/inprogress-data`, cloned to `~/.inprogress/offsite/`. The push uses the same per-command credential helper the playbook already uses for `main` (`gh auth token --user Aiden-Molyneaux`), so the active `gh` account (the work one) is left alone. Branch protection on the backup branch blocks force-push, so a compromised or confused laptop can add commits but can't erase history.

Why this over the others: it costs nothing, needs no new account, key or installed binary, works offline (a push that fails leaves the commit queued and the next tick retries), and history is the versioning. Size: a daily dump of a ~7 MB db that changes by small amounts packs to well under a few hundred MB a year; the doctor reports the repo size so it can be revisited, and an orphan-branch squash can trim it if it ever matters.

If Aiden rules that plaintext on GitHub is not acceptable (question 3), the fallback is restic to R2 or B2, which is encrypted and deduplicated but needs an account and a binary installed.

## 3. Unit and format

- **What goes off-machine:** the database and `resources/`. Leave out the files listed under question 1.
- **Format off-machine:** a canonical SQL dump (`schema.sql` from `sqlite_master`, then one `data/<table>.sql` per table, rows in rowid order so diffs stay small), the `resources/` tree as plain files, and `manifest.json`. better-sqlite3 has no `.dump`, so the build writes a small dumper (about 60 lines) and a matching loader. A dump also means a corrupt page can't be committed: reading every row is itself a full check.
- **Format locally:** plain `.db` copies, as today, so the doctor's restore hint (`doctor.ts:70-76`) stays a file copy. The local clone of the repo is the local versioned copy of `resources/`, so no separate resources copy is needed.
- **Manifest** (borrowed from InThink's `archive.ts:5-16`): `format_version`, `created_at`, InProgress `VERSION` and git sha, `schema_version`, `min_reader_version`, `integrity_check` result, per-table row counts, resource file count and total bytes, and a SHA-256 of each resource file. The row counts are what the restore drill checks against.
- **Encryption:** recommended off, because it destroys the diff and packing benefits and a lost key is itself a way to lose everything. The data is plans, notes and handoffs; the one secret (`token`) stays out. This is Aiden's call (see the ask). If he wants encryption, use restic instead of git rather than committing encrypted blobs.
- **Restore across machines:** `resources.path` stores absolute paths such as `C:/Users/aiden.molyneaux/.inprogress/resources/...`. A restore onto a machine with a different home folder rewrites that prefix.

## 4. Cadence and retention

| Copy | When | Kept |
|---|---|---|
| Local snapshot | At start (as today) and on the existing 6-hour maintenance tick (`main.ts:17`), skipped when its SHA-256 matches the newest snapshot | Every snapshot from the last 48 hours (cap 8), the newest per day for 14 days, the newest per week for 8 weeks |
| Pre-migration copy | Before every migration, rebuild or additive (moves the hook in `migrate` to fire for both) | The newest 3, plus any under 30 days old |
| Off-machine commit | The first maintenance tick 24 hours after the last successful commit, and on demand (`inprogress backup --push`) | All (git history) |
| Restore drill | Weekly, on a maintenance tick | The last result, in `meta` |

Local disk: about 30 copies of 7.5 MB, roughly 230 MB, against 60 MB today. The stray `pre-stage1-rollout-20261013.db` falls outside every pattern; the build should leave it alone and say so.

## 5. Verification

- **Each snapshot:** `integrity_check` (the full check, not `quick_check`) on the copy, as InThink does at `service.ts:56-62`, and keep the existing refusal to back up a db that fails `quick_check`.
- **Each off-machine commit:** load the dump into a temp db, run `integrity_check`, compare per-table row counts with the manifest, and refuse to commit on any mismatch.
- **Weekly drill:** a shallow clone of the remote into a temp folder (so it tests what GitHub holds, not the local clone), rebuild the db, `integrity_check`, row counts against that commit's manifest, resource hashes against the manifest. Result and time go in `meta`.
- **Doctor:** a new Backups check that warns when the newest local snapshot is over 26 hours old while the server ran, the newest pushed commit is over 3 days old (fails at 7), the last drill is over 14 days old or failed, or the backup repo is over 500 MB. The Database check's restore hint gains the remote path.
- **Once, at adoption:** Aiden runs the restore end to end into a scratch home folder (`INPROGRESS_HOME` pointing elsewhere) and opens the app on it.

## 6. Reuse of InThink

Verdict: **adapt two ideas, share no code.**

What InThink has (`server/src/modules/ops/backups/`, 1,885 lines with tests): a `.tar.gz` of the db, uploads and a manifest, made on a button press (no timer; `createSnapshot` is only called from the route), keeping the newest 3 on the same Railway volume as the live db, with a web restore that uploads an archive, checks the master password, puts the server in 503 maintenance mode, takes a pre-restore snapshot, swaps the db and uploads with revert on failure, then migrates.

| Piece | Fit for InProgress | Take it? |
|---|---|---|
| Manifest (`archive.ts:5-16`) | Good: a self-describing copy with schema version and integrity result | Yes, the idea, extended with row counts and file hashes |
| `integrity_check` on the copy, `wal_checkpoint` first (`service.ts:49-62`) | Good: stronger than today's `quick_check` on the live db | Yes |
| Pre-restore safety snapshot (`restore-engine.ts:304-330`) | Good: a restore must never destroy the only copy of the current state | Yes, the idea |
| `.tar.gz` archive (`archive.ts:189-222`) | Poor: an opaque blob defeats git's diffs and packing; a local `.db` restores by copy | No |
| Restore engine: upload, master password, maintenance-mode 503s, job polling (`restore-engine.ts`, `maintenance.ts`, `routes.ts`) | Poor: built for a hosted, password-guarded web app with a browser client. InProgress is local and single-user; its restore is `inprogress stop`, then a CLI command | No |
| Keep 3, manual only, same volume | Has the same single-location gap InProgress has | No |

Sharing code would need a package both repos depend on, for about 100 useful lines, and the two apps' needs pull apart (web upload vs CLI, tarball vs git). Copying the ideas is cheaper and leaves neither repo tied to the other. Worth noting for InThink: its own backups have the gap this spec closes for InProgress (manual only, on the same volume as the data), so the dump-to-git approach could serve it later as a separate step.

## Restore path (for the build to implement)

`inprogress restore [--from <snapshot.db | backup-repo folder | commit>]`: refuses while the server runs, takes a pre-restore copy of the current db, builds the new db in a temp file (copy, or load from dump), runs `integrity_check`, deletes `-wal` and `-shm`, swaps the file in, restores `resources/` from the repo when restoring from it, rewrites the `resources.path` prefix when the home folder differs, and leaves a fresh `token` to be generated on the next start.

## Decisions for Aiden

1. **Where the off-machine copy goes:** a private repo on your personal GitHub (recommended), personal OneDrive, or restic to R2 or B2.
2. **Encryption at rest:** plaintext SQL in a private repo (recommended; keeps diffs, no key to lose), or encrypted, which means restic rather than git.

Everything else above (cadence, retention, verification, the InThink verdict) is the recommendation unless he overrides it.
