# Board and asks: InProgress stage 1

Date: 2026-10-12. Status: approved by Aiden section by section on 2026-10-12; the look (section 2.8) waits on his pick from
the UI drafts. Tracked in the `inprogress` project as #303.

This note extends the InProgress design spec (`2026-09-27-inprogress-design.md`). It amends rulings D5 and D6 of that spec
(section 5 below) and reopens the Quiet restyle's non-goal "No dashboard" (`2026-10-05-quiet-restyle-design.md`, Non-goals):
the Board is a dashboard, and it replaces the tree canvas.

- **Decisions behind it.** `~/.inprogress/resources/inprogress/2026-10-12-inprogress-rethink-brainstorm-prompt.md` (r144):
  Aiden's brief verbatim, decisions 1 to 14, and approach C (two stages). This spec is stage 1.
- **Scope handoff.** `2026-10-12-stage1-board-asks-design-prompt.md` (r145).
- **Section record.** `2026-10-12-stage1-design-sections.md` (r147): each section as presented and Aiden's answers.
- **UI drafts.** `2026-10-12-stage1-ui-drafts-prompt.md` (r149): three drafts per screen plus an InThink-look port, drawn
  in a parallel session.

## Goal

Cut the two things Aiden said hurt most, and test the new model in a week of real use before stage 2 is designed:

- **Verbosity.** The tree canvas is too verbose to read at a glance. Stage 1 replaces it with two views: the Board (what
  is happening now) and the Project view (where the whole project stands).
- **Bombardment.** Small focused sessions ask him about items outside their scope. Stage 1 scopes a worker's briefing to
  the step it claimed, and gives the project-wide view to one Orchestrator session, the `mip-orc` skill.

Questions for Aiden become **asks**: items attached to a step, raised by a session, cleared by him. The Needs me column
lists asks, never steps.

## Non-goals

- Everything in stage 2, designed after the week of use: phases with exit conditions, the feature depth rule, `blocked_by`
  with gating and override, landing policy presets, run modes and headless runs, the data reshape, removing per-session
  queues, focus and `assignee`, the landing chip and the `release` ask kind. Section 7 names each seam.
- Work projects. Aiden scoped the redesign to InProgress, InThink and InGame. Work projects share the server and keep
  today's briefing (section 3.6).
- Keyboard shortcuts for the Board (Aiden, 2026-10-12). Undo after a drag: dragging back does the same.

## Aiden's decisions (2026-10-12)

1. Approach C: stage 1 now, stage 2 designed on the week's evidence.
2. Section 1 (data) as written, including that "Merge PR #514" and the Finances content pass leave Needs me as his own
   steps.
3. The tree goes. Stage 1 builds a first Project view on today's data; the view switch is Board | Project.
4. Section 2 (the wide Board), with row clicks opening Details and no keyboard shortcuts.
5. The Fable workflow review's nine changes, all taken except "clear with a note creates a Backlog step".
6. Its risks: adopt InGame before the week and return to it cold (#311); enforce the depth rule only at stage 2's reshape.
7. Section 4 (worker briefings), keeping the per-project briefing switch with full as the default.
8. Section 5 (the Orchestrator skill), named `mip-orc`, offering its digest instead of printing it.
9. Section 6 (delivery), keeping the window's usage counts.

## 1. Data

### 1.1 Migration 10

One migration, additive only. `min_reader_version` stays 1: a build from before it reads the database as before.

```sql
CREATE TABLE asks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  node_id INTEGER NOT NULL REFERENCES nodes(id) ON DELETE CASCADE,
  kind TEXT NOT NULL,            -- validated in code (ASK_KINDS); no CHECK, so stage 2 adds 'release' without a rebuild
  text TEXT NOT NULL,
  session_id TEXT REFERENCES sessions(id) ON DELETE SET NULL,   -- who raised it; null for migrated and window rows
  raised_at TEXT NOT NULL,
  cleared_at TEXT,
  cleared_by TEXT,               -- the actor string write() records
  answer TEXT NOT NULL DEFAULT ''
);
CREATE INDEX asks_open ON asks (project_id, cleared_at, raised_at);
CREATE INDEX asks_node ON asks (node_id, raised_at);
CREATE UNIQUE INDEX asks_open_once ON asks (node_id, kind, text) WHERE cleared_at IS NULL;
ALTER TABLE sessions ADD COLUMN role TEXT NOT NULL DEFAULT 'worker';          -- worker | orchestrator, validated in code
ALTER TABLE projects ADD COLUMN briefing_mode TEXT NOT NULL DEFAULT 'full';   -- full | scoped, validated in code
ALTER TABLE resources ADD COLUMN purpose TEXT;                                -- null | handoff | state, validated in code
```

The migration comment says why these enums carry no CHECK when the older ones do: each is expected to grow in stage 2,
and SQLite cannot change a CHECK without rebuilding the table.

The same migration converts the open needs-you steps that already are asks. For every node with `assignee = 'me'` and
`status` in todo, active, blocked:

- `kind = 'question'`: an open ask of kind question, text = the title.
- otherwise, when `body` has a line starting `Needs you:`: an open ask of kind permission, text = that line.
- `raised_at` = the node's `updated_at`; `session_id` null.

Nothing else changes. `assignee` stays on every row. On the live data this converts three questions and #279; "Merge PR
#514" and the Finances content pass become Aiden's own steps; the step waiting on Vince stays blocked. The text
extraction is tested on a copy of the live database before the branch merges.

### 1.2 Asks

- **Kinds.** `question`. `permission`: Aiden must allow or do something before the session can go on. `review`: finished
  work to look at; the step may already be done.
- **Raise** is idempotent: `INSERT ... ON CONFLICT DO NOTHING` on the open-once index, then return the open row. Two
  sessions raising the same ask get one row; two different asks on a step get two.
- **Clear** is idempotent: `cleared_at` and `cleared_by` keep their first value; `answer` takes the first non-empty answer.
  So a window Clear followed by the scribe's clear with Aiden's words lands both. Clearing a cleared ask returns the row,
  records no second event.
- **Dropping a step** clears its open asks in the same write. Finishing it does not.
- **Clearing the ask on a question step** (a node of kind question, from the migration) also marks that node done, its
  outcome the answer, or "Answered" when there is none. New questions are asks on the step they concern; the scribe stops
  creating question nodes.
- **Events.** `ask.raised` and `ask.cleared`, each carrying the row. `ProjectSnapshot` gains `asks`: every open ask, and
  those cleared in the last 7 days.
- **Needs you** means "has an open ask" everywhere it is counted: the tab counts, `inprogress list`, the orchestrator
  briefing and its status line. `isNeedsYou` on nodes is retired; ages count from `raised_at`.

### 1.3 Aiden's own steps

`assignee = 'me'` now means "Aiden does this step himself". The scribe sets it only for that. Such a step takes its
position like any other and carries a "you" badge.

### 1.4 Live permission waits

A session in state `permission` (the Notification hook's live tool prompt) is not stored as an ask. Needs me shows it as a
live row above the stored asks, built from session state: the session's letter, its step, "waiting for permission", the
tool and the command head (from `session_commands`), and the wait's age.

### 1.5 Position

One pure function in `src/core` derives every open step's position from the snapshot. Rules, first match wins:

1. `dropped`: off the board.
2. `done`: Done.
3. A live session's focus is on it, or it is Aiden's own (`assignee = 'me'`) and `active`: Now.
4. In the unowned queue: Next, in queue order. Then entries of a live session's own queue, tagged with its letter.
5. Any other open step with no open children: Backlog.

A step with open children is a group: it is not a row, and shows as the crumb on its children's rows. A group whose
children are all done falls to rule 5. A live session is one that has not ended and was heard from within
`STALE_SESSION_MS`. **Ready** (stage 1) means in Next with no open ask.

Edge cases, each a unit test:

- Done but still queued: Done. The queue entry stays stored and is filtered at read, as today, so a reopened step takes
  its old place.
- Two sessions on one step: one Now row, two session lines, working before idle.
- An open ask and no session: Next or Backlog, with the amber mark; "not ready" in Next.
- A live session's focus on a done step: Done; the step carries the `done_focus` mark.
- A session that ended without closing its step: the step falls back to Next or Backlog with the `ended_open` mark.

### 1.6 Hygiene marks

The same function returns marks on each row, which the Board, the Project view and `mip-orc`'s reconcile all read:

| Mark | When |
|---|---|
| `ended_open` | an open step holds open tasks of an ended session, and no handoff was added after it ended |
| `stale_active` | status active, not Aiden's own, and no live session on it |
| `no_outcome` | done with an empty outcome |
| `stale_ask` | an open ask older than 7 days |
| `done_focus` | a live session's focus is on a done step |
| `deep` | more than three levels below the project root (stage 2's depth rule, shown, not enforced) |

The Board's header shows the count of marks.

### 1.7 Last looks

- **The window** keeps one time per project in local storage, set when Aiden leaves the project's tab or the window hides.
  Done's "new since you looked" divider sits at that time until the next leave.
- **`mip-orc`'s** last look is the `updated_at` of the project's state note (the resource with `purpose = 'state'` on the
  root node), which it rewrites only after showing the full digest. No state note: the last 7 days.
- **The digest reads the tables, not the events:** `completed_at`, `raised_at`, `cleared_at`, `started_at`, `ended_at`,
  `created_at`. Events are pruned after 30 days and a return after months must still work. Only Aiden's moves in Next
  come from events.

## 2. The window

### 2.1 Views

The top bar keeps the project tabs; each tab's count is its open asks plus its permission waits, and the working dot stays.
A view switch, Board | Project, sits in the top bar. Board is the default; the window remembers the last pick in local
storage. The bottom strip (`ActivityStrip`) stays as today on both views.

Removed: the tree canvas, the session row, the Up next strip, the needs-you pill and Follow, with their code and their e2e
tests. Details, the resource viewer and go-to stay; go-to opens the step's Details instead of panning a canvas.

### 2.2 Board, wide (960 px and up)

- **Header lines.** "Where we are": the state note's first sentence and its age ("looked 3d ago"); a click opens the
  Project view; none reads "No state note yet". Then the sessions not on a Now row: the orchestrator ("A orchestrator"),
  and working sessions with no claimed step. Idle sessions with no step leave the board. The hygiene count sits at the
  right.
- **Columns, left to right: Needs me, Next, Now, Done.**
- **Needs me.** Live permission waits first (section 1.4), then open asks oldest first: kind glyph, text clamped to two
  lines, the step (#id and title), who raised it, age, and Clear. Clear opens a one-line optional answer and confirms.
- **Next.** The unowned queue numbered ①②③, then own-queue entries tagged with the session's letter. A step with an open
  ask has the amber mark and reads "not ready". Aiden's own steps carry "you". On hover a row shows "back to Backlog".
- **Backlog** folds at the foot of the Next column: "Backlog · 14". Open, it lists one-line rows grouped by parent, each
  with "to Next" on hover, and a quick-add field at its foot (section 2.5).
- **Now.** Step rows: crumb, title, label chip, parent, resource count `▤ n`, marks (amber ask, "you", handoff chip,
  hygiene). Under the step, one line per session, working before idle: letter, state, current task (its in-progress
  working task), running subagents with elapsed time.
- **Done.** The last five done steps by `completed_at` (dropped excluded): title, label, age, outcome clamped to two lines,
  the "new since you looked" divider.
- **A click on any row** opens Details for the step, in place.
- **Handoff chip.** A step whose newest resource with `purpose = 'handoff'` exists shows "handoff · 2d"; a click opens it
  in the resource viewer.

### 2.3 Board, narrow (below 960 px)

One scroll of stacked bands: Needs me, Now, Next, Done. The order is one constant, to revisit after the week. The header
lines sit on top. An empty band shrinks to one line ("Nothing needs you"). Backlog folds at the foot of Next. Rows, drag,
hover buttons and quick-add are the wide layout's components at full width.

Wide and narrow differ only in order: wide reads left to right as a flow (asked, queued, in flight, done); narrow puts Now
second because the top of a narrow window is where the glance lands.

### 2.4 Project view (both widths)

- **Header.** The project name and the state note in full, with its age, or "No state note yet".
- **Sections.** One per top-level group (a child of the root with children). Top-level steps without children gather in
  a last section, "Other steps". A section's header line: title, progress (done of all steps below it), a position
  summary ("1 now · 2 next · 9 backlog"), and its document count `▤ n`, which opens a list of its resources.
- **Body.** An outline of open steps, indented under their open parents, one line each: position chip (Now, Next with its
  number, Backlog), #id, title, label glyph, marks. A click opens Details. Done children fold per parent to one line,
  "✓ 22 done · latest: #227 Go to a step… 2d", which opens on a click.
- **Folds.** Sections with a step in Now or Next, or an open ask, start open; the rest start folded to their header line.
  Fully done groups gather at the bottom as "Done groups · 3". Fold choices are remembered per project in local storage,
  as today's fold overrides are.
- **Quick-add.** "+ Add a step" at each section's foot creates a Backlog step in that group.
- Narrow is the same outline with less indent.

### 2.5 Window writes

All under `/api/ui/` with the `guarded` middleware, actor `window`, slug-checked like archive and rename.

- **Queue.** `POST /api/ui/projects/:id/queue` with one operation: `{ kind: 'move', node, before: number | null }` or
  `{ kind: 'remove', node }`. The server applies it to the queue as stored, inside one transaction; it never replaces the
  list with what the window last saw. A move takes the node out wherever it sits (any owner) and places it in the unowned
  part before `before`; `null`, or a `before` no longer unowned, appends. A node taken from a session's own queue records
  `takenFrom` in the event. Done and dropped nodes are refused (400, "not open"); a step with an open ask is allowed. The
  event stays `project.updated` with `changes.queue`, plus `data.op`. The window reorders at once and reconciles on the
  event.
- **Drop targets.** Within Next, Backlog into Next, Next back to Backlog. Now, Done and Needs me are not drop targets.
- **Create.** `POST /api/ui/projects/:id/nodes` with `{ title, parent: number | null }` creates a todo step (no label) under
  `parent`, or the root. Entry points: the Board's Backlog fold (root), a Project view section's foot (that group), and
  Details ("Add a step under this one"). Labels and refinement come later from a session or `mip-orc`.
- **Clear.** `POST /api/ui/asks/:id/clear` with `{ answer?: string }`, idempotent as section 1.2.

### 2.6 Measuring the week

The window posts named actions to `POST /api/ui/events`; the server stores each as an event with actor `window` and type
`window.<name>`, which the SSE stream does not send back. Only the action and its time are stored, never content; they are
pruned with every other event after 30 days, and nothing leaves the machine.

| Event | Data |
|---|---|
| `window.view` | the view switched to |
| `window.first_band` | the first band or view opened after the window was hidden an hour or more, and the gap |
| `window.backlog_open` | none |
| `window.details_open` | the node |

`inprogress usage <project> [--days 7]` prints a short table: views by switches and by time open, first band after a gap,
Backlog opens, Details opens, quick-adds, asks raised per day by kind with the median time to clear, `mip-orc` opens and
how many asked for the full status, and the hygiene count per day. Quick-adds, asks and opens come from their own tables
and events.

### 2.7 Details

Details gains the step's asks (open, then cleared with answers), its handoff chip, its marks, and "Add a step under this
one". Everything else stays.

### 2.8 Look

The look (density, row anatomy, how an ask and a session line read, the fold treatments) is set by Aiden's pick from the
UI drafts canvas (r149): three drafts per screen in Quiet, and the same screens in InThink's aesthetic. His pick is
recorded here before the plan's window tasks start; the data and server branches do not depend on it. Until then,
Quiet's tokens, fonts and family hues stand, and the label chip is glyph plus word in muted ink.

## 3. Sessions

### 3.1 Claim

`inprogress claim <id> --session <sid>`, a foreground CLI beside `tasks`, calls `POST /api/sessions/:id/claim`, which runs
the existing `setFocus` (it refuses a step of another project and moves todo to active), sets `role = 'worker'`, and
prints the step block (section 3.4) at once. Actor `session:<sid>`.

Readiness is advisory in stage 1. The output notes each reason and claims anyway: "Note: #42 is not in Next", "has open
ask a7", "is also claimed by A "title" (working)". Stage 2 turns these into exit 1 unless `--override "<reason>"`.

Every handoff opens with "Claim #id". The scribe's "focus → #id" still works; a focus change marks a briefing due, so the
step block arrives on the next prompt.

### 3.2 Role

`sessions.role`: `worker` (default) or `orchestrator`. `inprogress orchestrate --session <sid>` sets orchestrator, clears
the focus, and prints the orchestrator opening (section 4). A claim sets worker again. A SessionStart with source `clear`
resets to worker; compaction and resume keep the role.

### 3.3 Raising and clearing asks

- `inprogress ask <id> --session <sid> --question|--permission|--review "<text>"` raises an ask at once and prints
  `a7 raised on #42`, so a worker that stops to wait can quote it.
- The scribe gains MCP tools `raise_ask(project, node, kind, text, session?)` and `clear_ask(ask, answer?)`. Its rules:
  "ask on #id: <kind>, <text>" when a session needs Aiden; "a7 answered: <answer>" when he answers in chat.
- A worker whose ask was cleared since its previous prompt gets one line on its next prompt:
  `Answered: a7 "<answer>"`.
- Install adds allow rules for `claim`, `ask` and `orchestrate`, from the same prefix helper as `tasks`, so none asks for
  permission. One `claude:install` rerun.

### 3.4 Briefings

`renderBriefing`, `renderStatusAnswer` and `renderStatusLine` choose by the project's `briefing_mode`, then the session's
role. `full` keeps today's line set for every session; its Needs you and check lines read open asks, as everywhere
(section 1.2). `scoped`:

**Worker with a claimed step.**
1. Header, with `Role: worker on #42`.
2. The plan-edit line, the playbook, the update rules (naming claim and ask; "assignee me" only for Aiden's own steps).
3. `Your step:` its parent chain, the step with status and progress, its open children, its own open tasks (at most 5).
4. `Handoff:` the newest handoff resource on the step.
5. `Resources on #42:` newest first, at most 5.
6. `Asks on #42:` open ones with ages; those cleared since the session started, with answers.
7. `Left unfinished on #42 by an earlier session:` this step only.
8. `Other sessions here:` letters and steps, against collisions.

**Worker with no step.** Header (`no step claimed`), the rules, the playbook, `Ready to claim:` up to three Next steps with
no open ask and no live session (own entries first), the claim command; when none is ready, "Nothing is ready. Planning
is the Orchestrator's job (mip-orc)." Then `Other sessions here`.

**Orchestrator.** Header, the rules plus "you never implement", the playbook, the counts offer (section 4), then every line
of today's briefing. Needs you lists open asks oldest first and permission waits.

**Status line** (every second prompt without a scribe update): a worker reads `on #42 (a7 open)` or `no step claimed`,
without a project count; the orchestrator keeps the count. The status answer (a prompt asking for status) gives a worker
its step block and an orchestrator today's answer.

### 3.5 What changes where

Hooks (`src/hooks/`): nothing; they send flags and the server renders. Server: `session-flow.ts` and `briefing.ts` choose
by mode and role and add the answers line; routes for claim, asks and role; the MCP tools. CLI: claim, ask, orchestrate,
digest, usage. Installer: allow rules.

### 3.6 The briefing switch

`projects.briefing_mode` defaults to `full`, so work projects keep today's lines (their Needs you line reads asks). At rollout the scribe sets InProgress
and InThink to `scoped`, and InGame when #311 adopts it. Setting a project back to `full` is the rollback, with no code
change or redeploy.

### 3.7 Failure modes

- Stale role: survives compaction and resume by design; a claim or a `clear` start fixes the wrong direction.
- A session that never claims: the unclaimed view each briefing, the status line every second prompt, and `tasks` refuses
  without a step, as today. No auto-claim.
- Two sessions on one step: allowed and noted; stage 2 refuses unless overridden. A crashed session stays live until the
  stale limit, so a hard refusal now would block a legitimate retry.
- A step of another project: refused by `setFocus`; the CLI exits 1 with the hint.

## 4. The `mip-orc` skill

Lives in `claude/skills/mip-orc/` and ships with the installer beside the inprogress skill, so it works in every tracked
project; `claude-config.ts` and the kit check copy and compare it. Started with "/mip-orc"; "mip-orc status" prints
everything on the first prompt. Periodic: Aiden opens it at the start and end of a working block; the state note is its
memory.

On open:

1. **Role and counts.** It runs `inprogress orchestrate --session <sid>` and shows one short offer: "Since your last look
   (3d): 4 done · 2 asks raised, 1 answered · 2 sessions ended, 1 without a handoff. Reconcile: 3 fixes ready, 1 needs
   you." Then it offers the digest, the reconcile and what's next. With "status", it shows all three at once.
2. **Digest** (on request; also `inprogress digest <project> [--since <iso>]`): steps done with outcomes; asks raised and
   cleared with answers; sessions started and ended, flagging those without a handoff or with open tasks; steps Aiden
   quick-added; his moves in Next; new documents. At most 20 lines, then "+n more".
3. **Reconcile** (on request): from the hygiene marks. Mechanical fixes (stale focus, an empty outcome it can fill from the
   log, a step left active) go to the scribe in one batch after Aiden's yes; judgment calls (dropping a stale ask, closing
   a step) are questions.
4. **What's next** (on request): the top of Next with ready or not ready, and one recommended step with its reasons.
5. **Start**, on Aiden's go: write the handoff (opens "Claim #id"; goal, where things are, decisions, what to read as
   slices, next concrete step), attach it through the scribe with `purpose = 'handoff'`, and offer the chip with
   `spawn_task`; where that tool is missing, print the handoff path and a one-line prompt to paste. A step that is not
   ready needs Aiden's reason, logged on the step.
6. **State note**, after a full digest: rewrite the resource with `purpose = 'state'` on the root: one paragraph of where
   the project is, one line per top-level group, what waits on Aiden. Writing it sets the last look.

Queue edits go through the scribe, after re-reading the queue, so it does not overwrite Aiden's drags.

It never edits code, commits, builds or dispatches implementers; never claims a step; writes the tree only through the
scribe and its own command; and never repeats an ask the last digest already showed.

Before the digest's contents are fixed, the plan reads the "tooling gaps" list kept by the hand-run Orchestrator (r146's
state note).

## 5. Rulings and specs amended

- **D6** (`2026-09-27-inprogress-design.md`), new wording: "Claude edits the plan only through the `inprogress-scribe`
  subagent, never by main-session tool calls. Exceptions: working tasks, claims and asks go through the CLI (2026-10-04
  spec section 1; this spec section 3); Aiden edits from the window under `/api/ui/`, as actor `window`: project archive,
  unarchive, rename, delete and restore, the order of Next, quick-added steps, and clearing asks. A window write is an
  operation the server applies to the current row inside one transaction, never a replacement of what the window last
  saw."
- **D5** ("the window is read-only"): "Claude edits content; Aiden edits placement, adds steps, clears asks and runs
  project lifecycle from the window."
- **Quiet restyle, Non-goals:** "No dashboard" is reopened by this spec.

## 6. Delivery

### 6.1 Branches

| Branch | Holds | Label | Reviewer |
|---|---|---|---|
| data | Migration 10 and its conversion; the asks repo (raise, clear, drop); the position function with marks; asks in the snapshot | data | Opus |
| server | Claim, ask, orchestrate, digest, usage (CLI and routes); MCP raise_ask, clear_ask; briefings by mode and role; the answers line; window queue, create, clear and event routes; install allow rules | integration | Opus |
| window | The Board (both widths), the Project view, Details additions, drag, quick-add, Clear; removal of the canvas, session row and Up next | ui | Opus, and the screen-reviewer |
| skill-docs | `mip-orc`; the scribe agent and inprogress skill texts; the guide; D5 and D6 | docs | Opus (`claude/` runs in every session) |

The data branch lands first; server and window then run in parallel; skill-docs last. Each lands to main after a green
`npm run deploy`. Data and server change nothing visible: every project stays on the full briefing. Each UI task gets its
own `INPROGRESS_E2E_PORT` from 4410 to 4419.

### 6.2 Tests

- **Unit.** The position function, every edge case and mark; raise and clear twice; the migration on a copy of the live
  database; each briefing's line list by mode and role, and the status line; the digest from tables; queue operations,
  refusals and `takenFrom`; the CLIs' parse and output.
- **Smoke** (scratch home): claim, briefing, ask, clear, the answers line on the next prompt.
- **e2e, one per visible feature:** the wide columns; the narrow bands; a drag into Next writes the queue; the Backlog fold
  and quick-add; Clear on an ask; a row click opens Details; Project view sections and folds; the "new since you looked"
  divider; the view switch is remembered.

### 6.3 Rollout

1. Back up the database; deploy from the main checkout; `npm run claude:install`.
2. The scribe sets InProgress and InThink to `scoped`; InGame joins with #311.
3. Restart open sessions: briefings change only for new ones.
4. Open `mip-orc` once to write the first state note. The week starts there.

Rollback: revert the window merge and redeploy; set the switch back to `full`. The migration only adds.

### 6.4 The week's evidence for stage 2

From `inprogress usage`: which band or view comes first after a gap; Board against Project view; Backlog opens and
quick-adds per day; asks per day by kind and time to clear; Details opens; `mip-orc` opens and full-status requests; the
hygiene count over the week. By hand: the time to get going on InGame after returning cold, and Aiden's end-of-week note.

## 7. Stage 2 seams

| Stage 2 item | Seam in stage 1 |
|---|---|
| Stored `position` on steps | The one position function: replace its body with a column read |
| `release` asks | `asks.kind` has no CHECK |
| Phases with exits | Project view sections become phases; the state note gains a line per phase |
| Feature depth rule | The `deep` mark; enforced only at the reshape, never on a scribe write |
| `blocked_by`, gating, override | Claim's advisory notes become refusals unless `--override` |
| Landing policy, landing chip | Small additive columns, as `resources.purpose`; the chip on Done rows |
| Run modes, headless runs | `mip-orc`'s Start step: a headless run replaces the chip |
| Removing per-session queues, focus, assignee | Own-queue entries in Next are the only remaining use of owned queues |

## Consults (pilot log)

Four Fable consults (Aiden's instruction): the asks schema against the needs-you data (adopted); worker briefing scope
(adopted, with the briefing switch kept at full by default); the window queue write (adopted without undo or a scribe-side
op); a workflow review at Aiden's request (nine changes and three risks, taken as above).
