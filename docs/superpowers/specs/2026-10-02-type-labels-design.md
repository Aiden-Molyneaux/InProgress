# Type labels: what kind of work each step is

Date: 2026-10-02. Status: approved by Aiden in chat on 2026-10-02. This note extends the InProgress design spec
(`2026-09-27-inprogress-design.md`). Tracked in the `inprogress` project as #76.

## Why

Aiden wants to see at a glance what kind of work each step is (UI, server, a refactor, a fix). Claude picks the label
when it adds a step, and InProgress shows it. The label also tells Claude which test gate the step needs, so it does
more than decorate.

## The set

One label per step, from a fixed set. Pick by purpose first (fix, refactor, research), else by where the work lands. A
step that truly spans three areas is probably a phase.

| Label | Glyph | For |
|---|---|---|
| `ui` | ⧉ | anything Aiden sees or clicks: canvas, panels, styling |
| `server` | ⚙ | server logic, routes, startup, the write path |
| `data` | ⛁ | schema, migrations, queries, data fixes |
| `integration` | ⇄ | hooks, MCP, installer, skill rules, other systems |
| `ops` | ⚒ | build, deploy, test harness, environments, VMs |
| `docs` | ¶ | specs, guides, design notes, write-ups |
| `fix` | ⚑ | making something broken work again |
| `refactor` | ↻ | restructuring with no behaviour change |
| `research` | ⌕ | investigating, verifying, spikes; no code deliverable |

Phases, goals and Aiden's own to-dos (`assignee: me`) stay unlabelled unless a label clearly fits.

## No colour

Labels are glyph-first and render in neutral ink. Measured against the colours the UI already spends (status green,
blue, amber and red; session clay; resource purple; the five agent-badge hues), every mid-bright hue sits within
OKLab ΔE 15 of one of them. The few deep tones left fail together under colour-blind simulation (navy against plum
measures ΔE 0.9 for protanopia). A label colour would read as a status or an agent, so the glyph carries the type.

All nine glyphs render as monochrome text in Edge with the UI font stack (`system-ui`, Segoe UI), in light and dark.
Set `font-variant-emoji: text` on the chip so ⚙ and ⚒ never turn into emoji. ⛁ is faint at 12 px and may need a size
bump.

## Data (migration 3)
- `nodes` gains `label TEXT` (nullable), CHECK in the set above.
- It only adds a nullable column, so `min_reader_version` stays at 1 and a rollback keeps working.
- `TreeNode` gains `label: NodeLabel | null`; `NODE_LABELS` sits beside `NODE_KINDS` in `src/core/types.ts`.
- Label changes ride the existing `node.updated` event.

## MCP and briefing
- `add_nodes` and `update_node` take `label` (`null` clears it). An unknown label is a bad request that lists the set.
- `get_outline`, the CLI `outline` and the briefing print the glyph before the title: `#62 ⧉ UI: working-task rows`.
- The briefing's standing update rules list the set and the picking rule once. The playbook is per-project text Aiden
  writes, so the set stays out of it. The scribe reads the set in the `add_nodes` and `update_node` descriptions.

## UI
- **Chip.** A small neutral chip after the title, glyph only, with the word in its tooltip and accessible name
  (`aria-label="ui"`). It uses text tokens, never a hue.
- **Details.** Shows the label as glyph and word beside kind and status.
- **Working tasks.** They show no chip of their own and take their node's label.
- **Minimap.** No change.

## Labels pick the test gate
The skill rules map labels to Aiden's lean-testing rules, so a label tells Claude which tests a step needs:

| Label | Gate |
|---|---|
| `ui` | typecheck + unit; one e2e test per user-visible feature, run once; no failing-test-first for styling or wording |
| `integration` | typecheck + unit + smoke; full strict gates for hooks and installer |
| `data` | typecheck + unit; full strict gates; `min_reader_version` when the migration only adds |
| everything else | typecheck + unit |

The gate describes the default only. Deploy still decides what to run from the files that changed.

## Skill and scribe rules
- Claude picks the label when it briefs a new step: `add under #41: "Faster cold start" (task, server)`.
- The scribe passes it through and never invents one. A step briefed without a label stays unlabelled.
- Relabel when a step's purpose changes (a research spike that turns into a fix).
- One-off backfill: after deploy, Claude briefs labels for the open steps of each active project.

## Out of scope
Per-task labels for working tasks. Filtering or counting by label. Colour (see above). Inferring labels from the files a
session edits.
