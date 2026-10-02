---
name: inprogress
description: Opt a Claude session into InProgress, adopt an existing project into it, or answer where a tracked project stands. Use when the user says "track this in InProgress", "add this to InProgress", "adopt <project> into InProgress", "what's next in InProgress", when a prompt hook says the session is not tracked yet, or when a tracked session needs the InProgress update rules restated.
---

# InProgress

InProgress is a live tree of a project's plan, steps, resources and Claude sessions, shown in a window beside Claude. Aiden reads it. You keep it current by briefing the `inprogress-scribe` agent. You never edit it yourself: no HTTP calls, no database access, no InProgress tools in this session.

## Tracked sessions

A tracked session has a context block starting `[InProgress] This session is tracked in project …`. It carries the session id, the playbook, the update rules and where things stand. Follow those rules. In short:

- Brief the scribe with the Agent tool (`subagent_type: "inprogress-scribe"`, description "InProgress update"). It runs in the background: never wait for it or poll it. At most one brief per turn, with every change batched.
- Checkpoints: a new request with a deliverable arrives (it becomes a step right away, before the work starts); a plan is made or changed (backtracking marks steps `dropped` or moves them); the order of work is decided or changes (brief `queue: #a, #b, #c`, next first); a step starts, finishes or is blocked; something worth finding again is produced; something is handed to Aiden (`assignee: me`) or he reports doing it; an open question appears (`kind: question`) or is answered (`done`, answer in `outcome`).
- Steps are plan-level with outcomes, never single actions. Detours go in the log of the step they interrupted.
- Working tasks sit under the steps, and Aiden watches them live. Start a subagent's description with its step's `#id` when the work belongs to a tracked step (`#44 Build project tabs`). Use the task tools (`TaskCreate`, `TaskUpdate`) for multi-step work, and start a task's subject with `#id` when it belongs to a step other than your focus. InProgress mirrors both on its own: they need no brief. Without the task tools, brief the list instead: `tasks on #57: in progress "Write the guide"; pending "Review it"`.
- Resources always go to the scribe as a file path plus `snapshot_file`. Content that only exists in chat (for example a test suite written in a reply) is first written with the Write tool to `{{RESOURCES}}/<project-slug>/<yyyy-mm-dd>-<kebab-title>.md`.
- After dispatching, write one line in chat, e.g. `↳ InProgress: #57 done, test suite attached to #58`. The scribe's completion notice needs no reply beyond that line.

Brief template:

```
Session: <session id> · Project: <slug>
Changes:
- #57 → done; outcome "Play app signing configured"
- add under #55 after #57: "Run signing tests" (task, assignee me); body: run on a device build, report failures
- resource on the new "Run signing tests" node: test-suite "Signing test suite", path {{RESOURCES}}/ingame/2026-09-27-signing-test-suite.md, snapshot_file
- log on #55: "Detour: sandbox network wedge, fixed by restarting VMware NAT"
- focus → the new "Run signing tests" node
- queue: the new "Run signing tests" node, #59, #60
```

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
