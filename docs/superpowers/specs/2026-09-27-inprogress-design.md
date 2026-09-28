# InProgress — Design Spec

**Date:** 2026-09-27 · **Status:** approved in brainstorming, pending written-spec review
**Owner:** Aiden · **Builder:** Claude Code

## 1. Problem and purpose

Long Claude Code projects scatter their state across chat scroll-back, multiple sessions,
and subagents. Plans ("step 1 of 7"), things Claude is doing, things Aiden is expected to do,
and resources produced along the way (test suites, runbooks, roadmaps, diagrams, open
questions) end up buried vertically in chat. Finding "the test suite from five messages ago,
before the sandbox detour" means scrolling or asking Claude to regenerate it.

**InProgress** is a local companion window that sits beside Claude and shows each project as a
live tree: what the project is for, the plan broken into steps, which steps are done / active /
waiting on Aiden, where each resource was produced, and which Claude session is working where.
**Claude owns every edit** (create, update, backtrack, attach resources) through a background
scribe subagent. Aiden only reads, navigates, and copies references.

The tree is a *filtered projection* of the work: it cares whether the tests were run, not about
the sandbox detour on the way (detours become log notes on the step they interrupted).

### Success criteria

1. In a tracked session, a plan Claude lays out appears in the window within ~30 s of being
   stated (the background scribe's spin-up dominates) and within ~3 s of the scribe's write
   reaching the server; step status changes (done / active / needs you) show up live without
   Aiden touching the app.
2. A resource produced in chat (e.g. a test suite) can be found later from the tree node where it
   was produced, including when it only ever existed in chat.
3. Each active Claude session shows as a badge on the node it is working on, with a live state
   (working / idle / needs permission) and its running subagent count.
4. An in-flight project (InGame) can be adopted from where it stands today, without backfilling
   its history.
5. Claude's main-session context stays lean: InProgress edits happen in a background subagent and
   cost the main session about one line of chat per update.

## 2. Decisions made during brainstorming

| # | Decision | Chosen | Rejected (why) |
|---|---|---|---|
| D1 | Form factor | **Local web app** (Node server + SQLite on this laptop), shown as a chromeless Edge app window or in the Claude Code tab's browser pane | Electron (extra packaging weight for the same UI); module inside InThink (Versaterm task details would leave the laptop) |
| D2 | Enrollment | **Bound folders (+ optional git branch pattern) auto-track; anything else opts in** with "track this in InProgress" | Opt-in only (must remember every session); track everything (noise) |
| D3 | Tree layout | **Outline flow**: order runs downward, depth indents right; narrow and grows down; active work near the bottom | Classic fan-out tree (too wide for a side window); flowchart cascade (wants width) |
| D4 | Architecture | **Server as single writer**: one local server owns SQLite; Claude writes only via a scribe subagent whose MCP tools are invisible to the main session; hooks report presence | Plain JSON files (concurrent writes clobber; fragile); transcript mining (undocumented format, inference inaccuracy, ongoing cost) |
| D5 | Who edits | **Claude only.** The UI is read-only (navigate, fold, copy, view, open file) | UI editing (Aiden explicitly does not want to maintain it by hand) |
| D6 | Update mechanism | **Main session delegates every edit to the `inprogress-scribe` subagent** (Sonnet, background) | Main session calling tools directly (bloats main context; Aiden asked for subagents) |

## 3. Architecture

```
┌────────────── Claude Code session (desktop Code tab or CLI) ──────────────┐
│  main agent ── follows `inprogress` skill ──▶ spawns inprogress-scribe    │
│      ▲                                           (Sonnet, background)     │
│      │ additionalContext                          │ MCP (stdio, inline,    │
│      │ (briefing / status line)                   │ only the scribe sees)  │
│  hooks (node scripts) ──────────┐                 ▼                        │
└─────────────────────────────────┼──── mcp/main.js (InProgress tools) ──────┘
                                  │ HTTP + bearer token          │ HTTP + token
                                  ▼                              ▼
                     ┌──────────────── InProgress server ───────────────────┐
                     │ Fastify on 127.0.0.1:4317 · SQLite (better-sqlite3)  │
                     │ JSON API · SSE event stream · serves web UI          │
                     └──────────────────────────┬───────────────────────────┘
                                                │ SSE (live) + GET (read-only)
                                                ▼
                              Web UI (React + React Flow), Edge app window
```

### 3.1 Repository layout (`C:\personal\InProgress`)

```
package.json            single package; scripts below
tsconfig.json
src/
  shared/               types, zod schemas, constants (paths, port), HTTP client, path + glob utils
  server/               Fastify app: db/ (schema, migrations, repo functions), routes/, sse, briefing, static
  mcp/                  stdio MCP server exposing scribe tools (uses shared HTTP client)
  hooks/                one entry per hook event; tiny, dependency-light
  cli/                  `inprogress` admin CLI
web/                    Vite + React + @xyflow/react app (built into web/dist, served by server)
claude/
  agents/inprogress-scribe.md      template ({{REPO}} placeholder)
  skills/inprogress/SKILL.md       template ({{REPO}} placeholder)
scripts/
  claude-install.mjs, claude-uninstall.mjs
test/                   vitest unit + integration; test/e2e/ Playwright
docs/superpowers/specs/ this spec
```

Scripts: `build` (server/mcp/hooks/cli via tsup → `dist/`, web via Vite → `web/dist/`),
`dev` (server watch + Vite dev proxying `/api`), `test` (vitest), `test:e2e` (Playwright),
`claude:install`, `claude:uninstall`. `bin: { "inprogress": "dist/cli/main.js" }`.

### 3.2 Runtime paths and config

- Data dir: `%USERPROFILE%\.inprogress\` (override with env `INPROGRESS_HOME`; tests always
  override it).
- Files in the data dir: `inprogress.db`, `token` (32 random bytes hex, created on first server
  start), `server.log`, `hooks.log`, `server.pid`, `backups/`.
- Port: `4317` (override with env `INPROGRESS_PORT`).
- Stack: Node 20 (installed: v20.19.6; `node:sqlite` is unavailable, so better-sqlite3 pinned
  to `^11`, the line already working on this laptop; 13.x requires Node 22),
  TypeScript, Fastify, better-sqlite3, zod, `@modelcontextprotocol/sdk`, React 18,
  `@xyflow/react`, `marked` + `dompurify`, Vite, vitest, Playwright.

## 4. Data model (SQLite, WAL mode, `meta.schema_version` + ordered migrations)

### 4.1 Tables

**projects** — `id` INTEGER PK · `slug` TEXT UNIQUE (kebab-case from name, `-2` suffix on clash) ·
`name` · `description` · `playbook` (markdown: per-project instructions the scribe follows and the
briefing includes; this is how "each project works a little differently") · `status`
(`active` | `archived`) · `root_node_id` · `created_at` · `updated_at`.

**bindings** — `id` · `project_id` (cascade) · `path` (normalized, see 4.3) · `branch_pattern`
(nullable glob, `*` wildcard, case-insensitive) · `created_at` · UNIQUE(`path`, `branch_pattern`).

**nodes** — `id` INTEGER PK (the user-facing `#id`, global across projects) · `project_id` ·
`parent_id` (NULL only for a project's root) · `position` REAL (sibling order) · `kind`
(`goal` | `phase` | `task` | `question`) · `title` (≤ 200 chars) · `body` (markdown, ≤ 20k) ·
`status` (`todo` | `active` | `done` | `blocked` | `dropped`) · `assignee` (`claude` | `me`) ·
`outcome` (short closing note; for questions, the answer) · `created_at` · `updated_at` ·
`completed_at` (set when status becomes `done`, cleared if it leaves `done`).

**resources** — `id` (shown as `r12`) · `project_id` · `node_id` (cascade) · `kind` (`doc` |
`test-suite` | `runbook` | `roadmap` | `diagram` | `link` | `other`) · `title` · `content`
(markdown snapshot, ≤ 1 MB) · `path` · `url` · `session_id` · `created_at` · `updated_at`.
CHECK: at least one of `content`, `path`, `url` is set.

**log_entries** — `id` · `node_id` (cascade) · `text` (≤ 2k) · `session_id` · `created_at`.

**sessions** — `id` TEXT PK (Claude `session_id`) · `project_id` (set by a binding match at
start or by enrollment; enrollment may repoint it) · `title` · `cwd` · `branch` ·
`transcript_path` · `state` (`working` | `idle` | `permission` | `ended`) · `focus_node_id`
(SET NULL on node delete) · `prompts_since_update` INTEGER · `started_at` · `last_seen_at` ·
`ended_at`. **Only tracked sessions are stored**: hook events for a session with no row and no
binding match write nothing. Title: the hook's `session_title` (SessionStart) or the transcript
`custom-title`, whichever is available; `enroll` sets a title only when none exists.

**session_subagents** — `session_id` (cascade) · `agent_id` · `agent_type` · `started_at` ·
PK(`session_id`, `agent_id`). Inserted on SubagentStart, deleted on SubagentStop by `agent_id`,
cleared when the session ends or goes stale. Events with an empty `agent_type` and the scribe
itself are ignored. The running count is the row count, so it cannot drift.

**events** — `id` INTEGER PK (monotonic) · `ts` · `project_id` · `actor` (e.g.
`scribe:<sessionId>`, `hook:prompt`, `system`) · `type` (e.g. `node.created`, `node.updated`,
`node.moved`, `node.deleted`, `resource.created`, `log.created`, `session.updated`,
`project.updated`) · `entity` · `entity_id` · `data` (JSON: the changed fields, before/after for
updates). Append-only. Drives SSE and history.

### 4.2 Derived rules

- **Needs you** = `assignee = 'me'` AND `status IN ('todo','active','blocked')`.
- **Project root**: created with the project (`kind = goal`, title = project name, body =
  description). Cannot be deleted or moved; archive the project instead.
- **Progress count** on any node with children: done / (total − dropped), direct children only.
- **Status side effects**: entering `done` sets `completed_at`; leaving it clears it. No automatic
  parent roll-up: the scribe sets parent statuses explicitly.
- **Move** must stay within the project and must not create a cycle.
- **Positions**: API takes `after` (sibling id | `"start"` | `"end"`, default `"end"`); the server
  computes REAL positions (midpoint insert) and renormalizes a parent's children when a gap
  falls below 1e-6.
- **Stale sessions**: any non-ended session with `last_seen_at` older than 12 h is marked `ended`
  lazily on read, and its `session_subagents` rows are cleared.
- Any write by actor `scribe:<sessionId>` resets that session's `prompts_since_update` to 0.

### 4.3 Binding resolution

Paths are normalized before storage and comparison: backslashes → `/`, Git-Bash form
`/c/x` → `C:/x`, drive letter upper-cased, trailing slash removed, compared case-insensitively.
A binding matches when the session `cwd` equals the binding path or is under it (`path + '/'`
prefix) **and**, if the binding has a `branch_pattern`, the current branch matches it.
Among matches: longest path wins; on equal length, a binding with a branch pattern beats one
without. The resolved project is assigned at session start only if the session has none yet;
`enroll` can repoint a session that was auto-bound to the wrong project.

## 5. Server (Fastify)

- Listens on `127.0.0.1` only. Rejects requests whose `Host` header is not
  `127.0.0.1:<port>` or `localhost:<port>` (DNS-rebinding guard). Sends no CORS headers.
- **Auth**: all mutating routes require `Authorization: Bearer <token file contents>` and
  record `X-InProgress-Actor` (default `system`). Reads need no token.
- **UI token**: a random per-process token is injected into the served `index.html`
  (`<meta name="ip-ui-token">`); only `POST /api/ui/open` accepts it.
- All writes run inside a transaction together with their `events` insert; after commit the
  event is broadcast over SSE.
- **Single instance**: on start, if the port answers `/api/health` with the InProgress
  signature, exit 0 quietly; if something else holds the port, exit 1 with a clear message.
  On `EADDRINUSE` (two sessions starting at once) re-probe health before deciding. Writes
  `server.pid`. `claude:install` stops a running server so the next hook starts the new build;
  `doctor` warns when the running server's version differs from the built one.
- **Backups**: on each start, back up the DB with better-sqlite3's backup API into
  `backups/inprogress-YYYYMMDD-HHmmss.db`, keeping the newest 7.
- `server.log` is truncated on start when above 5 MB.

### 5.1 Routes

Reads:
- `GET /api/health` → `{ ok, app: "inprogress", version, pid }`
- `GET /api/projects` → list with `needsYou`, `activeSessions`, `lastEventAt`, `status`
- `GET /api/projects/:ref` → project, all nodes (no resource content), resource metadata,
  non-ended sessions. `:ref` = id, slug, or case-insensitive exact name.
- `GET /api/projects/:ref/outline?full=0|1` → compact text outline (format in 7.3)
- `GET /api/nodes/:id` → node, children summary, resources (metadata), last 20 log entries
- `GET /api/resources/:id` → resource including content
- `GET /api/bindings` → all bindings (the scribe needs ids for `unbind_folder`)
- `GET /api/search?project=&q=` → matching nodes and resources (case-insensitive substring over
  title/body/outcome/content), max 20
- `GET /api/events/stream?since=<eventId>` → SSE; replays events after `since`, then live;
  heartbeat comment every 25 s

Writes (token):
- `POST /api/projects` `{ name, description?, playbook?, slug? }`
- `PATCH /api/projects/:ref` `{ name?, description?, playbook?, status? }`
- `POST /api/projects/:ref/bindings` `{ path, branchPattern? }` · `DELETE /api/bindings/:id`
- `POST /api/nodes` `{ parentId, after?, nodes: NodeInput[] }` where
  `NodeInput = { title, kind?='task', status?='todo', assignee?='claude', body?, outcome?, children?: NodeInput[] }`
- `PATCH /api/nodes/:id` `{ title?, kind?, status?, assignee?, body?, outcome? }`
- `POST /api/nodes/:id/move` `{ parentId, after? }`
- `DELETE /api/nodes/:id?cascade=1` (cascade required when the node has children)
- `POST /api/resources` `{ nodeId, kind, title, content?, path?, url?, sessionId? }` ·
  `PATCH /api/resources/:id` · `DELETE /api/resources/:id`
- `POST /api/nodes/:id/log` `{ text, sessionId? }`
- `POST /api/sessions/:id/hook` `{ event, source?, cwd?, branch?, transcriptPath?, title?,
  agentId?, agentType?, mentionsInProgress?, asksStatus? }` → `{ tracked, context? }` (hook
  semantics in 6.1)
- `POST /api/sessions/:id/enroll` `{ project, title? }` → `{ briefing }`
- `POST /api/sessions/:id/focus` `{ nodeId | null }`
- `POST /api/admin/shutdown`
- `POST /api/ui/open` `{ resourceId }` (UI token) → opens that resource's stored `path` in VS Code
  (`code`) if on PATH, else reveals it in Explorer (`explorer /select,<path>`). It never runs a
  file through the OS default handler, so a poisoned path cannot execute anything.

`ProjectSnapshot` also carries `lastEvent` (the project's newest event) for the activity strip.

Validation: zod at every route; errors return `{ error, hint? }` with a specific message
(e.g. `#99 is not in project ingame; closest title match: #57 "Play app signing"`).

### 5.2 Briefing (server-generated text, ≤ ~40 lines)

Returned for tracked sessions by the session-start hook and by `enroll`:

```
[InProgress] This session is tracked in project "InGame" (slug ingame). Session id: 3fa9c1f0-….
All InProgress edits go through the inprogress-scribe agent in the background; follow the inprogress skill.
Playbook:
  <playbook, truncated to 15 lines>
Where things stand:
  #53 Road to market — active (2/7)
    #55 2 Android signing — active
      #57 Play app signing — active  ◆ this session
      #58 Run signing tests — NEEDS YOU
  Next: #59 3 RevenueCat · #60 4 Build → GitHub (+3 more)
Needs you (2): #58 Run signing tests · #61 Which RevenueCat plan? (question)
Recent resources: r12 Test suite (on #58) · r11 Signing runbook (on #54)
Other sessions here: "QA drill" (idle, on #70)
```

"Where things stand" = the ancestor chains of all active and needs-you nodes, plus up to two
upcoming todo siblings at each level on those chains, capped at 25 lines (then
`+n more active items`). Recent resources: newest 5.

The briefing also carries the update rules, because it is re-injected after compaction while a
skill body is not: the five checkpoints from 6.4, the one-dispatch-per-turn rule, the brief
template (about 8 lines), the chat-only-resource rule, and "the scribe's completion notice needs
no reply beyond your one line". The skill is then needed only for opt-in and adoption.

## 6. Claude integration

### 6.1 Hooks

Registered in `~/.claude/settings.json` by `claude:install` in **exec form** (no shell, so no Git
Bash spawn per hook): `{"type":"command","command":"node","args":["C:/personal/InProgress/dist/hooks/hook.js","<hook-name>"]}`.
Every hook: reads the stdin JSON, never writes to stderr, always exits 0, logs failures to
`hooks.log`, and aborts its HTTP call after 500 ms (session-start: 3 s total including a server
spawn). Only session-start and prompt-submit ever print to stdout
(`{"hookSpecificOutput":{"hookEventName":…,"additionalContext":…}}`).

Shared hook helpers:
- **Branch**: found by walking up from `cwd` to `.git` (directory, or a file with `gitdir:` for
  worktrees) and reading `HEAD`; detached HEAD yields no branch. No `git` process spawn.
- **Title**: SessionStart's documented `session_title` field first. Otherwise read the last
  256 KB of `transcript_path`, take the last line containing `"type":"custom-title"`, parse it,
  use `customTitle` (the Claude desktop sidebar name). If none is found, send no title (server
  keeps the existing one; the display fallback is `Session <first 6 of id>`). The transcript
  format is undocumented and must degrade silently.
- **Prompt text**: `<pasted_content …>…</pasted_content>` blocks are stripped before any matching,
  so pasting a document that mentions InProgress triggers nothing.

| Event | Action |
|---|---|
| `SessionStart` | Ensure the server is up (health check 300 ms; else spawn `node dist/server/main.js` detached, hidden, output to `server.log`; poll health every 100 ms up to 2 s). Post `start` with `source`, `cwd`, `branch`, `transcriptPath`, `title`. If the session has no row, the server resolves a binding; no match means nothing is stored and nothing printed. For a tracked session it sets state `idle` only when `source` is `startup`, `resume` or `clear` (a `compact` start happens mid-turn and leaves the state alone), and returns the briefing, which the hook prints as `additionalContext`. |
| `UserPromptSubmit` | Post `prompt` with `title`, `mentionsInProgress` (`/\binprogress\b/i`) and `asksStatus` (`/\b(where are we\|what'?s next\|status\|progress so far)\b/i`), both on the prompt with pasted blocks stripped. Tracked: state → `working`, `prompts_since_update += 1`; if `asksStatus`, return the briefing's "Where things stand" and "Needs you" lines; else if `prompts_since_update ≥ 2`, return a one-line status, e.g. `[InProgress] InGame · focus #57 Play app signing · 2 need you · last scribe update 3 prompts ago. If a checkpoint happened, brief the inprogress-scribe; otherwise ignore this line.` Untracked and the prompt mentions InProgress: return `[InProgress] This session is not tracked yet. Session id: <id>. Use the inprogress skill to opt in.` |
| `Stop` | Post `stop` with `title` → state `idle`. |
| `Notification` (matcher `permission_prompt`, fires after ~6 s of waiting) | → state `permission`. It clears on the next `prompt`, `stop` or subagent event. |
| `SubagentStart` / `SubagentStop` (matcher `^(?!inprogress-scribe$).*`, so no process spawns for the scribe) | Insert / delete the `session_subagents` row by `agent_id`; ignore empty `agent_type`. |
| `SessionEnd` | → state `ended`; subagent rows cleared. |

There is no per-tool-call hook: a process spawn on every tool call in every subagent costs more
than a slightly late "needs permission" badge is worth.
The `event` values posted to `/api/sessions/:id/hook` are exactly: `start`, `prompt`, `stop`,
`permission`, `subagent-start`, `subagent-stop`, `end`.

### 6.2 MCP server (`inprogress`, stdio) — scribe-only tools

Defined inline in the scribe agent's frontmatter, so the main session never sees these tools.
It talks to the server over HTTP with the token (reading `token` from the data dir) and starts
the server if it is down (same logic as session-start). Every write tool takes an optional
`session` (Claude session id) used as actor `scribe:<session>`. Results are short plain text
naming the ids touched. Errors return `isError` with the server's specific message.

| Tool | Purpose |
|---|---|
| `list_projects` | slugs, names, status, needs-you counts, active sessions |
| `get_outline(project, full?)` | compact outline with `#id`s (7.3); done branches summarized unless `full` |
| `get_node(id)` | node, children summary, resources, recent log |
| `get_resource(id)` | resource with content |
| `search(project, query)` | find nodes/resources by text |
| `create_project(name, description, playbook?, slug?, bind_path?, branch_pattern?, session?)` | new project + root (+ optional binding) |
| `update_project(project, name?, description?, playbook?, status?)` | edit / archive |
| `bind_folder(project, path, branch_pattern?)` / `unbind_folder(binding_id)` | manage bindings |
| `add_nodes(parent, nodes, after?, session?)` | add one node or a whole nested plan |
| `update_node(id, title?, kind?, status?, assignee?, body?, outcome?, session?)` | edit / change status |
| `move_node(id, parent, after?, session?)` | restructure / backtrack |
| `delete_node(id, cascade?, session?)` | remove mistakes |
| `add_resource(node, kind, title, content?, path?, url?, snapshot_file?, session?)` | attach; `snapshot_file: true` makes the MCP server read `path` itself (≤ 200 KB) into `content` |
| `update_resource(id, …)` / `delete_resource(id)` | edit / remove |
| `add_log(node, text, session?)` | timeline note (detours, context) |
| `enroll_session(session, project, title?)` | opt a session in; returns the briefing |
| `set_focus(session, node)` | which node this session is on (`null` to clear) |

### 6.3 Scribe agent (`~/.claude/agents/inprogress-scribe.md`)

Frontmatter: `name: inprogress-scribe`, `model: sonnet`, `effort: low`, `maxTurns: 15`,
`background: true`, `tools: mcp__inprogress` (no file tools: the MCP server snapshots files
itself), `mcpServers` with an inline stdio server `inprogress` →
`node C:/personal/InProgress/dist/mcp/main.js`, `color: orange`, and a `description` saying it
records progress in the InProgress tree when a briefing or the inprogress skill asks. The docs
confirm inline servers in `~/.claude/agents/` load without trust checks and stay invisible to
the parent session. The installer creates `~/.claude/agents/` if missing, and a newly created
agents directory is only picked up by sessions started afterwards, so install tells Aiden to
restart open sessions.

System prompt rules:
1. Start with `get_outline` for the project (or `search`) to resolve every reference in the brief
   to real `#id`s. Never guess an id; on a miss, search, then report.
2. Apply the brief's changes with as few calls as possible (nested `add_nodes` for plans).
3. Keep titles short and outcome-shaped (≤ 60 chars, e.g. "Play app signing configured").
4. Never invent progress. Only record what the brief states.
5. Pass the brief's session id to every write, and set focus when the brief says where the
   session is working.
6. Return one line summarizing what changed (e.g. `#57 done · added #58 (you) · r12 on #58 ·
   focus #58`), or the failure and what is needed.

### 6.4 Skill (`~/.claude/skills/inprogress/SKILL.md`)

Triggers: the session-start briefing is present; the user says "track this in InProgress",
"add this to InProgress", "adopt X into InProgress", "what's next in InProgress"; or the
prompt-submit hook reports an untracked session that mentions InProgress. Content:

- **Tracked or not**: tracked if the session-start briefing (or an `enroll` result) is in
  context. The briefing carries the session id; for untracked sessions the prompt hook supplies it.
- **Opt-in**: ask which project (offer existing ones via a scribe `list_projects` call if unclear),
  then brief the scribe to `enroll_session` (creating the project if needed) and, if Aiden agrees,
  `bind_folder` with the cwd (and a branch pattern for ticket work, e.g. `*VCAD-978*`).
- **Checkpoints**, when the main session dispatches the scribe (at most once per turn, all changes
  batched into one brief):
  1. a plan is made or changed (new steps, reorder, backtrack → `dropped` / move);
  2. a step starts, finishes, or gets blocked;
  3. something worth finding again is produced (test suite, runbook, roadmap, diagram, handoff,
     decision write-up);
  4. something is handed to Aiden (becomes a node with `assignee: me`), or Aiden reports doing it;
  5. an open question appears (a `question` node) or gets answered (`done` + `outcome`).
- **Granularity**: nodes are plan-level steps with outcomes, never individual actions
  ("edit file", "run grep"). Detours are `add_log` entries on the step they interrupted.
- **Resources**: always hand the scribe a `path` + `snapshot_file: true`, never pasted content,
  so nothing is typed out twice by two models. Content that only exists in chat is first written
  by the main session to `~/.inprogress/resources/<project-slug>/<yyyy-mm-dd>-<kebab-title>.md`
  (outside the project repo, so work repos stay clean; the installer adds an allow rule for it).
- **Brief template**:
  ```
  Session: <session id> · Project: <slug>
  Changes:
  - #57 → done; outcome "Play app signing configured"
  - add under #55 after #57: "Run signing tests" (task, assignee me); body: …
  - resource on the new "Run signing tests" node: test-suite "Signing test suite",
    path C:/Users/…/.inprogress/resources/ingame/2026-09-27-signing-test-suite.md, snapshot_file
  - log on #55: "Detour: sandbox network wedge, fixed by restarting VMware NAT"
  - focus → the new "Run signing tests" node
  ```
- **Chat footprint**: after dispatching, one line in chat, e.g.
  `↳ InProgress: #57 done, test suite attached to #58`. Do not wait for the scribe, and its
  completion notice needs no reply beyond that one line.
- **Status questions** ("where are we?"): the prompt hook injects the current "Where things
  stand" lines when a prompt asks for status, so answer from those. For the full tree, run
  `inprogress outline <slug>` (read-only CLI). Never dispatch the scribe just to read.
- **Adopting an existing project**: brief the scribe with the purpose, the current plan with real
  statuses, a one-line summary per finished phase (each becomes a `done` phase node, e.g.
  "M1–M6 build"), and paths of key existing docs to attach with `snapshot_file`. No history backfill.
- **Never**: call the InProgress HTTP API or edit its database directly, or block the turn on the
  scribe.

### 6.5 Install and uninstall

`npm run claude:install` (requires a prior `npm run build`):
1. Back up `~/.claude/settings.json` to `settings.json.inprogress-backup-<timestamp>`.
2. Render `claude/agents/inprogress-scribe.md` → `~/.claude/agents/`, and
   `claude/skills/inprogress/` → `~/.claude/skills/inprogress/`, substituting `{{REPO}}` with the
   absolute repo path (forward slashes).
3. Merge exec-form hook entries into `settings.json` for the events in 6.1 (session-start
   timeout 10 s, others 5 s). Entries are identified by an `args[0]` ending in
   `/dist/hooks/hook.js`, so re-running install replaces rather than duplicates them. Unknown
   keys and other tools' hooks are preserved.
4. Add to `permissions.allow`: `mcp__inprogress` (the background scribe must never stall on a
   prompt) and `Edit(~/.inprogress/resources/**)` (chat-only resources are written there).
5. Stop a running InProgress server so the next hook starts the freshly built one.
6. Print what changed and suggest `inprogress doctor`. If `~/.claude/agents/` did not exist
   before, say plainly that already-open Claude sessions must be restarted to see the scribe.

`npm run claude:uninstall` removes exactly those hook entries, the allow rule, the agent file,
and the skill directory, after the same backup step. The data dir is left alone.

### 6.6 Admin CLI (`inprogress`)

- `start`: start the server detached if not running.
- `stop`: `POST /api/admin/shutdown`.
- `open`: start if needed, then launch `msedge --app=http://127.0.0.1:4317 --window-size=520,1000`;
  fall back to the default browser.
- `status`: health, projects with needs-you counts, live sessions.
- `outline <project> [--full]`: print the text outline (read-only, no token), for status
  questions from a Claude session and for Aiden in a terminal.
- `doctor`: checks with ✓/✗ and a fix hint each: server health and version match, token
  readable, DB integrity (`PRAGMA quick_check`), hooks present in settings, agent file present
  with valid frontmatter (name, model, tools, mcpServers), skill present, allow rules present,
  the MCP server starts and answers `list_projects`, Edge found (a warning, not a failure).

## 7. Web UI

### 7.1 Shell (see approved mockups, `.superpowers/brainstorm/`)

- **Top bar**: project switcher (dropdown sorted by working sessions, then last activity; each
  row shows state dot, `◆ n working`, `n need you`; archived projects in a sub-list; the
  selection is stored in `localStorage` and the URL hash `#/p/<slug>`), a **needs-you** pill
  (`● n need you`), and a **Follow** toggle (`⌖`).
- **Session row**: one chip per non-ended session in the project. Filled clay = working (pulsing
  dot), clay outline = idle, red outline = needs permission. Label: title · `n subagents` when
  above 0. Click → camera to its focus node.
- **Canvas**: React Flow on a dot-grid background, with zoom controls (+ / − / fit) at bottom-left,
  a minimap at bottom-right, and a sticky breadcrumb at top-left showing the ancestor path of the
  topmost visible node.
- **Activity strip**: one line with the latest event in plain words, e.g.
  `↳ scribe (InGame launch status) · 2 min ago · test suite attached to #58 Run signing tests`.
- **Window title**: `(n) InProgress — <project>` when anything needs Aiden, else
  `InProgress — <project>`.
- Light and dark themes follow the OS. Nothing is editable.

### 7.2 Nodes

A card with: a status marker (done = green dot, active = blue dot that pulses when a working
session is focused on it or a descendant, todo = hollow grey ring, blocked = red dot + "blocked"
tag, dropped = grey with strikethrough, question = "?" glyph coloured by status); the title; a
`YOU` tag when assigned to Aiden and not done (amber border); a progress count (`3/7`) and fold
chevron on parents; up to two resource chips to the right (`▤ title`, purple) plus `+n`; the
`#id` on hover. A session badge (`◆ <title> · working`) sits on its own row directly under the
node that session is focused on.

### 7.3 Outline-flow layout (pure function, unit-tested)

- Input: the project's nodes + fold state + sessions. Output: positioned nodes, edges, badge rows.
- Pre-order DFS over visible nodes. Row height 32 px, node height 24 px, indent 28 px per depth.
  x = depth × 28; y = row index × 32. A session badge adds a 26 px row under its node.
- Edges: parent rail → child, drawn as React Flow `step` edges from a source handle 12 px
  in from the parent's left on its bottom edge to the child's left handle.
- **Auto-fold**: a `done` or `dropped` node with children renders as one summary node
  (`<title> · n done`, n = done descendants). Under any parent, after the last `done`/`active`
  child (or from the first child if there is none), only the next two `todo`/`blocked` children
  show. Pinned children always show and never take one of those two slots; `dropped` children
  show only until both slots are filled. Everything after that collapses into synthetic
  `+n more` nodes, one per contiguous hidden run (a visible node inside the run splits it), but
  only when the hidden total is at least two.
- **Never folded**: ancestors of active nodes, needs-you nodes, and session focus nodes.
- **Manual override**: clicking a chevron or `+n more` toggles fold. Overrides persist in
  `localStorage` per node id and beat auto rules.
- Text outline for the API and briefing uses the same fold rules, rendered as indented lines
  `#id title — status [NEEDS YOU] [r12, r13]`.

### 7.4 Camera

- **On load**: centre on the frontier: the focus node of the most recently active working session;
  else the most recently updated active node; else the last visible row. Zoom 1.
- **Follow on** (default): after each relevant event, re-layout and animate (`setCenter`, 400 ms)
  to the event's node (a resource or log event uses its node). Throttled to one move per 1.5 s
  (the latest target wins).
- A manual pan or zoom turns Follow off; `⌖` turns it back on and recentres.
- **Needs-you pill** / `N` key: centre on the next needs-you node in DFS order and briefly
  highlight it. `F` toggles Follow, `Home` goes to the root, `End` to the frontier, `Esc` closes
  sheets.

### 7.5 Details and resources

- Clicking a node opens its details: a bottom sheet (~60% height) when the window is under 720 px
  wide, else a 380 px right panel. It shows the `#id` and title, **Copy #id** (copies
  `#58 Run signing tests`), status / kind / assignee, parent link, body (markdown), outcome,
  resources, and the log (newest last, relative times, session titles).
- Clicking a resource opens a full-window viewer: rendered markdown (`marked` + `dompurify`),
  **Copy** (raw content), **Open file** (when `path` is set; `POST /api/ui/open` with the resource
  id: VS Code, else reveal in Explorer), **Copy path**, and **Open link** (when `url` is set).
  A 401 from `ui/open` means the server restarted with a new UI token, so the page reloads.

### 7.6 Live data

The UI loads `GET /api/projects` and `GET /api/projects/:ref`, then opens
`/api/events/stream?since=<lastEventId>`. On any event for the current project it refetches the
project snapshot (debounced 150 ms) and applies camera-follow. On other projects' events it
refreshes the switcher counts. On SSE disconnect it shows a small "reconnecting" state and resumes
with `since`.

## 8. Error handling

- **Server down**: session-start and the MCP server start it; other hooks skip silently.
  `inprogress doctor` diagnoses the whole chain.
- **Hooks** never block Claude or surface errors in chat; they log to `hooks.log`.
- **Scribe failures**: specific tool errors, one self-correction retry after a lookup, then a
  one-line failure report that the main session relays. No silent guessing.
- **Data integrity**: transactional writes; cycle and cross-project checks on move; root
  protection; FK cascades as specified; the event log records every change; DB backed up on start
  (7 kept).
- **Security**: loopback-only listener, Host-header check, bearer token for writes, per-process UI
  token for `ui/open`, which opens only a stored resource path and only in VS Code or Explorer's
  reveal, never through the OS default handler.
- **Undocumented inputs** (transcript titles, hook payload fields not in the docs) are read
  defensively with fallbacks, never trusted to exist.

## 9. Testing

- **Unit (vitest)**: repo functions (create, update, move with cycle rejection, delete cascade,
  positions and renormalization, needs-you and progress derivation), binding resolution and path
  normalization, glob matching, briefing and outline rendering, layout and fold rules, transcript
  title extraction from fixture transcripts, branch detection with fixture `.git` dirs.
- **Integration (vitest)**: the Fastify app on a random port with a temp `INPROGRESS_HOME`: auth,
  Host guard, validation errors, every route, SSE replay with `since`; the MCP server driven
  through the SDK client against that server; each hook script run as a child process with
  recorded stdin payloads, asserting stdout JSON and server state.
- **E2E (Playwright)**: a seeded project renders; a write through the API updates the node and the
  camera follows; the needs-you pill cycles; the details sheet opens; Copy #id writes the clipboard;
  the resource viewer renders markdown.
- **Live check before handover**: `claude:install` + `doctor` all green, then a real Claude session
  (the desktop app, or `claude -p` if the CLI is available) in a bound scratch folder: the
  briefing is injected, a three-step plan lands in the window within ~30 s of being stated, a
  step completes, and the session badge moves between working and idle.
- **First real use**: adopt InGame from its docs (`docs/planning/road-to-market.md` and key
  planning docs), then have Aiden correct anything stale.

## 10. Out of scope for v1

Editing from the UI; phone or remote access; transcript mining or history backfill; Jira and
Sigmund integration; multi-machine sync; an Electron wrapper; desktop notifications; cloud
Claude sessions (they cannot reach localhost).
