# Live work: Claude's working tasks, subagents and planned order

Date: 2026-10-02. Status: approved by Aiden in chat on 2026-10-02. This note extends the InProgress design spec
(`2026-09-27-inprogress-design.md`). Tracked in the `inprogress` project as #57 (working tasks), #56 (execution order) and
#48 (per-subagent tracking).

## Why

Aiden's vision: when Claude says "the guide is written; I'll read it before publishing", that is a task under the guide's
node. He sees it start, sees who is on it (the main session or a subagent), and sees its siblings, so he knows where
Claude is. Across tasks, he wants the order Claude plans to work in.

The v1 rule "steps are plan-level, never single actions" stays for the plan. Underneath it sits a second layer:
Claude's live **working tasks**, which come mostly from Claude Code itself, at no extra cost.

## Sources

### Working tasks (mirrored)
Claude Code sessions keep their own task list with the `TaskCreate` / `TaskUpdate` tools. Aiden's transcripts show 39
creates and 79 updates. The shapes, as observed:
- `TaskCreate` input `{ subject, description, … }`; response `{ task: { id, subject } }` (ids are per session: "1", "2", …).
- `TaskUpdate` input `{ taskId, status?, subject?, addBlocks?, addBlockedBy?, … }`; status is `pending`, `in_progress`,
  `completed` (or `deleted`).

A **PostToolUse** hook (matcher `^(TaskCreate|TaskUpdate)$`) posts each change: the key, subject (clipped to 300), status
and blocks. The hook never forwards `description`.

Hook inputs carry `agent_id` and `agent_type` when the hook fires inside a subagent. A subagent's own task list mirrors
too, keyed by agent.

Attribution of a working task to a node, decided once, at creation:
1. A `#id` at the start of the subject (`#57 Write the design note`), if that node is in the session's project.
2. For a subagent's task: the subagent's node (below), the step its badge sits on. For a subagent with no step of its
   own that is the session's focus when the subagent started, not the focus at task time (amended 2026-10-06,
   review-actions rulings 42 and 43).
3. Otherwise: the session's focus node, else the project root.

### Subagents (#48)
- A **PreToolUse** hook on `^(Agent|Task)$` posts a dispatch: `tool_use_id`, `description` (clipped to 200),
  `subagent_type` and `model`. Of the `prompt` it forwards only the first sentence, clipped to 200 characters, as the
  subagent's purpose, which stays in the local database and is pruned with its row (review actions §5). The node is
  the `#id` at the start of the description, if any, else the session's focus. A subagent with no dispatch (a workflow
  agent) or whose dispatch left it no node stays on the session's focus at its SubagentStart, migration 7's
  `start_focus_id`, or on the first focus the session sets when it had none (review-actions rulings 42 and 43).
- **SubagentStart** (already installed) pairs with the oldest unpaired dispatch for that session and agent type
  (first in, first out).
- A **PostToolUse** hook on `^(Agent|Task)$` posts the launch response's `agentId`. For background agents this arrives
  at launch and makes the pairing exact. Foreground agents get it at completion, which only confirms the pairing.
- **SubagentStop** marks the subagent `ended_at` rather than deleting its row. Ended subagents show greyed for
  5 minutes, then stay 7 days as the trail on their step (review actions §3). Session end marks the running ones
  ended instead of deleting them, with the reason `session`.
- **No SubagentStop** comes when a subagent hits the usage limit or an API error, or is stopped (#125). The server's
  transcript watcher (`agent-watch.ts`) reads each running subagent's own transcript once a minute: a last line that
  marks the end ends it with `limit`, `error` or `killed`, 20 minutes with no new line ends it as `silent`, and a newer
  line brings it back while its session lives; a session that ends and comes back leaves them ended
  (review-actions rulings 44 to 52).

### Planned order (#56)
- Across plan steps: a per-project queue of node ids, set by the scribe with a new MCP tool
  `set_queue(project, nodes, session?, unowned?)` (review actions §6) whenever Claude decides or changes its order of
  work. Every id must belong to the project. Done or dropped nodes leave the queue on their own.
- Within a node: working tasks keep creation order, and their `blocks` links render as "after …" hints.

### Fallback
Where the task tools are absent, the session writes its working tasks for a node itself with the `tasks` command
(review actions §1):
`node <repo>/dist/cli/main.js tasks <step id> --session <session id> --done "…" --doing "…" --todo "…"`. It replaces
that session's list on that node through `POST /api/sessions/:id/tasks`, so these look exactly like mirrored tasks.

## Data (migration 2)
- `work_items`: `id` AUTOINCREMENT · `project_id` · `node_id` (ON DELETE CASCADE) · `session_id` · `agent_id` (`''` for
  the main session) · `task_key` · `subject` · `status` (`pending` | `in_progress` | `completed`) · `blocks` (JSON array
  of task keys) · `position` · `created_at` · `updated_at`.
  - UNIQUE(`session_id`, `agent_id`, `task_key`).
  - `deleted` removes the row.
  - Work items of sessions ended more than 7 days ago are pruned on start.
- `session_subagents` gains: `description`, `model`, `node_id` (ON DELETE SET NULL), `tool_use_id`, `ended_at`.
- `subagent_dispatches`: `session_id` · `tool_use_id` · `agent_type` · `description` · `model` · `node_id` ·
  `created_at` (unpaired dispatches older than 10 minutes are dropped).
- `projects.queue`: JSON `[{ "node": id, "session": id | null }]`, each entry owned by a session or by nobody, default
  `[]`; a bare node id from before reads as unowned (review actions §6).
- Events: `work.updated` (entity `node`, data `{ nodeId }`) once per change, with no per-task history.
  `session.updated` with `changed: ['subagents']` as now. `project.updated` for the queue.

## Hooks
- New `HOOK_EVENTS`: `agent-dispatch`, `agent-launched`, `task-created`, `task-updated`.
- New hook names `pre-tool` and `post-tool`, which branch on `tool_name`.
- New `HOOK_DEFS`:
  - PreToolUse `^(Agent|Task)$` → `pre-tool`, timeout 5
  - PostToolUse `^(Agent|Task|TaskCreate|TaskUpdate)$` → `post-tool`, timeout 5
- Both are silent: no stdout, exit 0. They use the 500 ms budget, and a failure never affects the tool call.
- Deploy notices the kit change and re-runs install. Claude sessions must restart to load the new hooks.

## Snapshot and API
- `Session.subagents[]` gains `description`, `model`, `nodeId`, `endedAt`.
- `ProjectSnapshot` gains `workItems: WorkItem[]` (`id`, `nodeId`, `sessionId`, `agentId`, `subject`, `status`,
  `blocks`, `position`, `updatedAt`) and `project.queue: QueueEntry[]` (`[{ nodeId, sessionId: id | null }]`, stored
  as `[{ "node": id, "session": id | null }]`; review actions §6).
- MCP:
  - new tool `set_queue`
  - `get_outline` prints `Up next: A: #82 → #78 | later: #79` (review actions §6)
- Briefing:
  - an `Up next:` line
  - under "Where things stand", the focused node's working tasks: ◐ in progress, then ○ pending, at most 5

## UI
- **Working tasks.** They render as compact rows (height 20) under their node, indented one level and drawn as a
  checklist: ○ pending, ◐ in progress (pulsing while its session is working), ✓ completed.
  - Completed tasks collapse into one `✓ n done` row, which expands on click.
  - Tasks fold with their node and are never counted in plan progress.
  - A subagent's tasks carry its badge colour.
- **Badges.** Each subagent gets its own badge under its node: `◆ description · model · 12 min`. Ended subagents show
  greyed (`done 2 min ago`) for 5 minutes, then move into the step's trail (review actions §3). The session's own badge
  stays under its focus. One that died without a stop adds a `!` and says why (`was stopped 3 min ago`); one at the
  usage limit stays, in amber, until it runs again or its session ends (rulings 48 and 49).
- **Session chip.** Lists its subagents (description · model · elapsed) on hover or focus.
- **Queue.** Numbered markers ①②③ appear on queued steps. An `Up next` line sits under the session row, lists the
  queue by owner (`Up next: A: #82 → #78 | later: #79`, review actions §6), and jumps to an item on click. When the
  frontier has no working session, it prefers the queue head.
- **Details.** Lists the node's working tasks (with session or subagent) and the subagents attributed to it.

## Skill and briefing rules
- Start a subagent's description with the step's id when the work belongs to a tracked step (`#44 Build project tabs`).
- Use the task tools for multi-step work. Start a task's subject with `#id` when it belongs to a node other than the
  focus.
- When the order of work is decided or changes, brief `queue: #a, #b, #c`.
- Any new request that has a deliverable becomes a node right away (#47).
- Without task tools, write working tasks with the `tasks` command
  (`node <repo>/dist/cli/main.js tasks <step id> --session <session id> --done "…"`).

## Out of scope
Token and cost figures per agent (hooks do not carry them). A live "last action" line per subagent (declined in the
#48 design).

## Amended by background work (#228, 2026-10-10)

Plan: `docs/superpowers/plans/2026-10-09-background-work.md`. Rulings 53 to 80: `docs/superpowers/rulings/2026-10-04-review-actions-rulings.md`, under "Background work (#228)". The sections above stay as written; this
adds what changed against them.

### Background commands

A session can stop while work runs behind it. Three tools start such work: Bash and PowerShell (`run_in_background`,
Ctrl+B, or the auto-background after a timeout) and Monitor. The window now shows these commands.

- **What the hook sends.** A second PostToolUse group, async so it never holds a tool call, matches
  `^(Bash|PowerShell|Monitor|SendMessage|TaskStop)$`. A call posts `command-started` only when its response carries a
  background task id; any other Bash call posts nothing. The body holds the task id, the kind (`shell` or `monitor`),
  `agent_id` for a subagent's call, how long the call ran, the tool's description (at most 200 characters) and a
  command head: the command's first words, at most 3 words and 60 characters, without leading `cd`, assignments and
  flags (`cd /c/x && npm run test:e2e` sends `npm run test:e2e`), and runs through `scrub()`, which redacts inline
  credentials. The full command is never posted to the server. Locally, `src/hooks/capture.ts` (on by default; off
  with `INPROGRESS_HOOK_CAPTURE=0` or a file `~/.inprogress/capture/off`) keeps the first 80 scrubbed characters of a
  Bash or PowerShell command in `~/.inprogress/capture/<day>.jsonl`.
- **How a command starts.** On `command-started`, with `started_at` = now minus the call's duration, in the new
  `session_commands` table (migration 9). Its step is a leading `#id` of the description, else the starting
  subagent's step, else the session's focus.
- **How it ends.** From the first source to arrive, and a later real end replaces a guessed one: the notice prompt's
  `<task-notification>` (`completed`, `failed` with its exit code, or `killed`); a TaskStop; the Stop hook's
  `background_tasks` list, which is session-wide, so a running command missing from it ends as `unknown` (unless it
  started within 10 s of the Stop, `RECONCILE_GRACE_MS`) and a listed one the server lacks is added; and, for a subagent's commands, whose notices never reach the prompt hook, the end
  lines the agent watcher reads from the session's transcript on its 60 s tick (it also reads the transcript of a
  session with a command a Stop ended as `unknown` in the last 5 minutes, so a real end line replaces the guess). A `resume` start, a session's end and
  stale expiry end the rest as `session`. A `compact` or `clear` start leaves them.
- **Busy.** A stored `idle` is read as `busy` while a subagent that is not a reader runs or a command counts as
  work (`src/core/activity.ts`). Nothing new is stored.
- **Serving.** A command counts as work for its first 30 minutes. One that is older, or whose head is `dev`,
  `serve`, `preview`, `start` or `watch` (or a `:` part of a word, as in `test:watch`), or a persistent Monitor, is
  serving: it shows, faint, but is never busy or live.
- **Retention.** The window gets a session's running commands and those ended in the last 5 minutes, at most 30. They
  leave no trail row. A prune deletes ended rows after 24 hours and keeps at most 200 per session.

### Re-homing a resumed agent

The hook also posts `agent-messaged` for a SendMessage whose response succeeded (the real agent id comes from the
response, since `to` can be a name). The server moves the agent to the step named by a leading `#id` of the message's
summary, else of its first sentence, else the session's focus, and takes the summary as its description. A message to
an agent that is still running moves it only for a `#id` naming another step. A resumed agent that had ended is
running again, unless its run started (or restarted) within the last 60 s (`MARKER_QUIET_MS`): the SendMessage post is
async and SubagentStart is not, so a message that close to the start only moves the agent. A SendMessage from inside a
subagent posts nothing; only the main thread's calls count. A TaskStop on an agent ends it as `killed`. The agent
keeps one trail row, which follows it.

### Run time

`SubagentInfo.runStartedAt` is when the current run started: the first start, restarted by a resume (a SendMessage or
a SubagentStart on a known row; a message within 60 s of the run's start leaves it). The kin's running time, the chip popover, the kin tooltip and Details count from it.
The trail's `ran …` still counts from `startedAt`, the first start (ruling 33).
