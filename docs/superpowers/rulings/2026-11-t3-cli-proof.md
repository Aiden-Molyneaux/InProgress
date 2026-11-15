# The t3 CLI can start, message and read a thread from outside T3 Code (2026-11-14)

Step #720, criterion C1. Proved with `scripts/t3-proof.mjs`, run from a shell with every T3 variable unset, against
the scratch project.

| Call | Result |
|---|---|
| `t3 thread start <project> - --provider claudeAgent --model claude-haiku-5-5 --wait --json` | exit 0 in 9.5 s; JSON keys `threadId, runId, status, reply, error`; reply READY |
| `t3 thread send <threadId> - --wait --json` | exit 0 in 5.4 s; same keys; reply DONE |
| `t3 thread show <threadId> --json` | `runtimeMode` full-access, `status` completed, `createdBy` agent, `creationSource` mcp |

What it settles:

- No sign-in is needed and no T3 variable has to be set.
- A start must name a provider and a model. Without them it fails with "Pass modelSelection: the project has no
  default model". No project on this machine has a default model.
- A thread started this way runs at Full access. The CLI has no flag to change that.
- Its id carries a prefix, `mcp:<uuid>`, so ids are stored as text and encoded in links.
- T3 records it as created by an agent through mcp. A thread Aiden starts in the app reads `createdBy` user and
  `creationSource` web, so InProgress can tell whose thread it is. A message still carries only its role and text.
- The message can be passed on stdin with `-`, which avoids shell quoting.

The proof thread is titled InProgress-T3-proof, in the No project list.
