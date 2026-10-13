---
name: inprogress
description: Opt a Claude session into InProgress, adopt an existing project into it, or look up the full InProgress brief format. Use when the user says "track this in InProgress", "add this to InProgress", "adopt <project> into InProgress", when a prompt hook says the session is not tracked yet, or when a tracked session needs the full brief template.
---

# InProgress

InProgress is a live tree of a project's plan, steps, resources and Claude sessions, shown in a window beside Claude. Aiden reads it. You keep it current by briefing the `inprogress-scribe` agent. You never edit it yourself, with one exception: without the task tools, you set your own working tasks with the `tasks` command below. Otherwise no HTTP calls, no database access, no InProgress tools in this session.

## Tracked sessions

A tracked session has a context block starting `[InProgress] This session is tracked in project …`. It carries the session id, the playbook, where things stand, and the update rules, which are complete: follow them. This section holds the full brief template.

Brief template:

```
Session: <session id> · Project: <slug>
Changes:
- #57 → done; outcome "Play app signing configured"
- add under #55 after #57: "Run signing tests" (task, assignee me); body: run on a device build, report failures
- add under #55: "Fix the upload-key check" (task, fix)
- ask on #55: question, Which store regions at launch?
- a7 answered: EU and UK first
- #56 label → fix
- #63 → dropped; outcome "Replaced by the upload-key check"
- move #64 under #55 after #57
- resource on the new "Run signing tests" node: test-suite "Signing test suite", path {{RESOURCES}}/ingame/2026-09-27-signing-test-suite.md, snapshot_file
- handoff on #55: "Signing tests, next steps", path {{RESOURCES}}/ingame/2026-09-27-signing-handoff.md, snapshot_file
- clear focus of 9c2e41aa-…: (from the Orchestrator) frees another session's focus
- state on #50: (root only, from the Orchestrator) the project's state note, one paragraph and a line per top-level group
- log on #55: "Detour: sandbox network wedge, fixed by restarting VMware NAT"
- focus → the new "Run signing tests" node
- queue: #59, #60
- later: #61
```

When a session needs Aiden to answer, allow or look at something, brief `ask on #id: <kind>, <text>` (kind `question`, `permission` or `review`) and name the asking session; the answer comes back to that session on its next prompt. When he answers in chat, brief `a7 answered: <answer>`. Do not add a question step for it. `assignee me` is only for a step Aiden does himself. A handoff line attaches the handoff doc to its step; a state line is the Orchestrator's note on the root and replaces the previous one. `clear focus of <session id>` clears another session's focus; the scribe passes that session's id, not the briefing session's. `briefing mode <slug>: scoped|full` switches what a project's sessions see in their briefings. Backtracking marks steps `dropped` or moves them; it never deletes them.

Never write an em dash in a brief or a task subject: use a comma, a colon, a period or " · ".

## Type labels

Give each new step one label in its brief: `add under #41: "Faster cold start" (task, server)`. The set: ⧉ `ui` · ⚙ `server` · ⛁ `data` · ⇄ `integration` · ⚒ `ops` · ¶ `docs` · ⚑ `fix` · ↻ `refactor` · ⌕ `research`. Pick by purpose first (`fix`, `refactor`, `research`), else by where the work lands: `integration` is hooks, MCP, the installer, skill rules and other systems; `ops` is build, deploy, the test harness and environments. Phases, goals and Aiden's to-dos stay unlabelled unless one clearly fits. Relabel a step when its purpose changes (`#57 label → fix` when a spike turns into a fix).

## Opting in (session not tracked)

1. The session id comes from the `[InProgress] This session is not tracked yet. Session id: …` line. If it is missing, ask Aiden to mention "InProgress" in his next message so the hook supplies it.
2. Decide the project. If it is unclear, run `"{{NODE}}" "{{REPO}}/dist/cli/main.js" status` to see existing projects (from PowerShell, start the command with `& `), and ask Aiden.
3. Brief the scribe to enroll the session (creating the project first if new: name, one-paragraph purpose, optional playbook) and, if Aiden agrees, bind the current folder. For ticket work in a shared repo, bind with a branch pattern like `*VCAD-978*`.
4. Write the one-line chat note, e.g. `↳ InProgress: enrolled in InGame`.
5. The full briefing, with the update rules, arrives with Aiden's next message after the enroll, not with the scribe's notice. Until then, where the task tools are absent, set your working tasks after each change with `{{TASKS}} <step id> --session <session id> --done "…" --doing "…" --todo "…"`. Run it with the Bash tool. The flags repeat, in list order; no flags clears the list; leave out `<step id>` to use your focus. Put single quotes around a subject that contains `$` or a backtick, and leave double quotes out of subjects.

## Adopting an existing project

Brief the scribe with:
- the purpose (one paragraph) and a playbook if the project has conventions (for example "planning docs live in docs/planning; attach them as resources");
- each finished phase as one `done` phase node with a one-line outcome (for example "M1–M6 build");
- the current plan with real statuses, and which step this session is on;
- anything waiting on Aiden;
- paths of the key existing docs to attach with `snapshot_file`.

Do not reconstruct history beyond that. As after opting in, the full briefing arrives with Aiden's next message.

## Status questions

When a tracked prompt asks where things stand, the prompt hook injects a live `[InProgress] Where things stand …` block: answer from it. For the whole tree, run `"{{NODE}}" "{{REPO}}/dist/cli/main.js" outline <slug>` (read-only; from PowerShell, start the command with `& `). Never dispatch the scribe just to read.

## Stale nudges

A line like `[InProgress] InGame · focus #57 … · last scribe update 3 prompts ago` means the tree may be behind. If a checkpoint happened since the last brief, brief the scribe now; otherwise ignore the line.
