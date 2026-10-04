---
name: inprogress
description: Opt a Claude session into InProgress, adopt an existing project into it, or answer where a tracked project stands. Use when the user says "track this in InProgress", "add this to InProgress", "adopt <project> into InProgress", "what's next in InProgress", when a prompt hook says the session is not tracked yet, or when a tracked session needs the InProgress update rules restated.
---

# InProgress

InProgress is a live tree of a project's plan, steps, resources and Claude sessions, shown in a window beside Claude. Aiden reads it. You keep it current by briefing the `inprogress-scribe` agent. You never edit it yourself, with one exception: without the task tools, you set your own working tasks with the `tasks` command below. Otherwise no HTTP calls, no database access, no InProgress tools in this session.

## Tracked sessions

A tracked session has a context block starting `[InProgress] This session is tracked in project …`. It carries the session id, the playbook, the update rules and where things stand. Follow those rules. In short:

- Brief the scribe with the Agent tool (`subagent_type: "inprogress-scribe"`, description "InProgress update"). It runs in the background: never wait for it or poll it. At most one brief per turn, with every change batched.
- Checkpoints: a new request with a deliverable arrives (it becomes a step right away, before the work starts); a plan is made or changed (backtracking marks steps `dropped` or moves them); the order of work is decided or changes (brief `queue: #a, #b, #c`, next first); a step starts, finishes or is blocked; something worth finding again is produced; something is handed to Aiden (`assignee: me`) or he reports doing it; an open question appears (`kind: question`) or is answered (`done`, answer in `outcome`).
- Steps are plan-level with outcomes, never single actions. Detours go in the log of the step they interrupted.
- Working tasks sit under the steps, and Aiden watches them live. Start a subagent's description with its step's `#id` when the work belongs to a tracked step (`#44 Build project tabs`). Use the task tools (`TaskCreate`, `TaskUpdate`) for multi-step work, and start a task's subject with `#id` when it belongs to a step other than your focus. InProgress mirrors both on its own: they need no brief. Without the task tools, run this after each change; it is the one write you make yourself, with no brief: `{{TASKS}} <step id> --session <session id> --done "…" --doing "…" --todo "…"`. The flags repeat, in list order; no flags clears the list; leave out `<step id>` to use your focus. The same line runs in the Bash and the PowerShell tool. Put single quotes around a subject that contains `$` or a backtick, and leave double quotes out of subjects.
- Resources always go to the scribe as a file path plus `snapshot_file`. Content that only exists in chat (for example a test suite written in a reply) is first written with the Write tool to `{{RESOURCES}}/<project-slug>/<yyyy-mm-dd>-<kebab-title>.md`.
- After dispatching, write one line in chat, e.g. `↳ InProgress: #57 done, test suite attached to #58`. The scribe's completion notice needs no reply beyond that line.

Brief template:

```
Session: <session id> · Project: <slug>
Changes:
- #57 → done; outcome "Play app signing configured"
- add under #55 after #57: "Run signing tests" (task, assignee me); body: run on a device build, report failures
- add under #55: "Fix the upload-key check" (task, fix)
- resource on the new "Run signing tests" node: test-suite "Signing test suite", path {{RESOURCES}}/ingame/2026-09-27-signing-test-suite.md, snapshot_file
- log on #55: "Detour: sandbox network wedge, fixed by restarting VMware NAT"
- focus → the new "Run signing tests" node
- queue: the new "Run signing tests" node, #59, #60
```

## Type labels

Give each new step one label in its brief: `add under #41: "Faster cold start" (task, server)`. The set: ⧉ `ui` · ⚙ `server` · ⛁ `data` · ⇄ `integration` · ⚒ `ops` · ¶ `docs` · ⚑ `fix` · ↻ `refactor` · ⌕ `research`. Pick by purpose first (`fix`, `refactor`, `research`), else by where the work lands: `integration` is hooks, MCP, the installer, skill rules and other systems; `ops` is build, deploy, the test harness and environments. Phases, goals and Aiden's to-dos stay unlabelled unless one clearly fits. Relabel a step when its purpose changes (`#57 label → fix` when a spike turns into a fix).

The label gives the step's default test gate. Deploy still decides what to run from the files that changed.

| Label | Gate |
|---|---|
| `ui` | typecheck + unit; one e2e test per user-visible feature, run once; no failing-test-first for styling or wording |
| `integration` | typecheck + unit + smoke; full strict gates for hooks and installer |
| `data` | typecheck + unit; full strict gates; `min_reader_version` when the migration only adds |
| everything else | typecheck + unit |

## Opting in (session not tracked)

1. The session id comes from the `[InProgress] This session is not tracked yet. Session id: …` line. If it is missing, ask Aiden to mention "InProgress" in his next message so the hook supplies it.
2. Decide the project. If it is unclear, run `"{{NODE}}" "{{REPO}}/dist/cli/main.js" status` to see existing projects (from PowerShell, start the command with `& `), and ask Aiden.
3. Brief the scribe to enroll the session (creating the project first if new: name, one-paragraph purpose, optional playbook) and, if Aiden agrees, bind the current folder. For ticket work in a shared repo, bind with a branch pattern like `*VCAD-978*`.
4. Write the one-line chat note.

## Adopting an existing project

Brief the scribe with:
- the purpose (one paragraph) and a playbook if the project has conventions (for example "planning docs live in docs/planning; attach them as resources");
- each finished phase as one `done` phase node with a one-line outcome (for example "M1–M6 build");
- the current plan with real statuses, and which step this session is on;
- anything waiting on Aiden;
- paths of the key existing docs to attach with `snapshot_file`.

Do not reconstruct history beyond that.

## Status questions

When a tracked prompt asks where things stand, the prompt hook injects a live `[InProgress] Where things stand …` block: answer from it. For the whole tree, run `"{{NODE}}" "{{REPO}}/dist/cli/main.js" outline <slug>` (read-only; from PowerShell, start the command with `& `). Never dispatch the scribe just to read.

## Stale nudges

A line like `[InProgress] InGame · focus #57 … · last scribe update 3 prompts ago` means the tree may be behind. If a checkpoint happened since the last brief, brief the scribe now; otherwise ignore the line.
