# InProgress

I usually have several Claude Code sessions going at once, across more than one project. Each holds a piece of the picture: the plan it laid out, a decision I made twenty messages back, the test suite it wrote before a detour, a question it is still waiting on me to answer. After a few days, the state of a project lives in chat scroll-back, on disk and in my head, and the only way to find out what needs me is to click into every session.

InProgress is a small local window that sits beside Claude and keeps that picture in one place. For each project it shows what needs me, what is in flight and which session is on it, what comes next, and what got done. Claude keeps it up to date while it works. My part is reading it, answering whatever is waiting, and choosing the order of the work.

## What you see and do

- Needs me lists the questions, permission waits and review requests from the project's sessions, oldest first. Each names the session that asked and has an Open session button that takes you into that session in the Claude desktop app, so you answer in the chat that has the context. You can also clear an ask from the window.
- Now shows each step in flight with the sessions on it: whether each is working, idle or waiting, the task it is on, and any subagents or background commands still running. One session drives a step from start to done, so you know which chat to talk to.
- Next is the queue the next free session pulls from. Drag to reorder it.
- The Backlog holds everything else, ranked in three bands (Next up, Soon, Someday), with views for triage, stale steps and parked ones. Add an idea with a note, park a step you are not ready to decide on, or drag it into place. Claude files into the same list. Its steps come with a short What and Why written for you, and a "proposed" chip when the step was its idea and not yours.
- Done lists finished steps, each with a one-line outcome.
- Details on a step shows its What and Why, asks, outcome, and the resources made along the way (docs, test suites, runbooks, handoffs). Each resource is attached to the step that produced it, so you find it there instead of scrolling back through a chat.
- Docs shows a project's pages, read live from its repo and marked stale once commits touch the paths they cover. The Library holds the pages that span projects.

`/` or Ctrl+K jumps to any step.

The Claude desktop sidebar is the second place to look. Sessions keep a `DONE`, `REVIEW`, `BLOCKED`, `PARKED` or `RUNNING` prefix on their title, and InProgress checks it every turn. A session running a background job then reads as running, not idle, and I don't have to click in to check on it.

## A day with it

I start a block of work by opening a session and running `/mip-orc`, the Orchestrator. It tells me what changed since I last looked, points out loose ends (a done step with no outcome, a step whose session has gone quiet), and recommends what to start next. When I agree, it writes a handoff and offers to start a worker session on that step. The worker claims the step and does the work. Anything it needs from me shows up in Needs me, and when it finishes it marks the step done with an outcome. Meanwhile I drop ideas into the Backlog and rank them. The Orchestrator keeps a state note on the project, and its next opening starts from there.

## How Claude keeps it current

Hooks installed into Claude Code report each session's state to a local server and give a session a briefing when it starts: the project's playbook, where things stand, and the rules for keeping the tree current. The main session never edits the tree itself. It sends a short brief to the `inprogress-scribe` agent, which runs in the background on Sonnet and writes through an MCP server that only the scribe can see. Each update costs the main session about one line of chat. Sessions also run a few CLI commands themselves, for their working tasks, claims and asks.

All of it runs on your machine: a Fastify server on `127.0.0.1:4317`, SQLite under `~/.inprogress`, and a React window served by the same server that updates live.

## Who it is for

This is my personal tooling, published as it is. I build it on Windows and use it there: the window opens as a Microsoft Edge app window, Open session hands a link to the Claude desktop app, and I have only tested the scripts and hooks on Windows. The skills, the scribe and the briefings address me by name, and the Library's Sync shelf checks projects against my own workflow templates. The `.claude/` folder in the repo holds the agents I use to work on InProgress itself.

## Requirements

- Node 20.19 or later
- git
- Claude Code (the Claude desktop app for Open session and the title prefixes)
- Microsoft Edge, for the app window and the browser tests

## Setup

```bash
git clone https://github.com/Aiden-Molyneaux/InProgress.git
cd InProgress
npm install
npm run deploy          # type checks, tests, builds into dist/ and starts the server
npm run claude:install  # writes the hooks, allow rules, scribe agent and skills into ~/.claude
node dist/cli/main.js doctor
node dist/cli/main.js open
```

The first deploy runs every test suite, including the browser tests in Edge. `claude:install` backs up `settings.json` before it writes anything, then stops the running server so the next hook starts the new build. If `~/.claude/agents` did not exist before, restart any open Claude sessions so they can see the scribe. `doctor` checks the server, token, database, hooks, agent, skills, allow rules, MCP server and Edge.

To start, say "track this in InProgress" in a Claude session, or "adopt <project> into InProgress" for a project that is already under way.

`npm run claude:uninstall` removes the hooks, allow rules, agent and skills. It leaves your data in `~/.inprogress` alone.

## CLI

Run commands as `node dist/cli/main.js <command>`. The package's `inprogress` bin points to the same file.

| Command | What it does |
|---|---|
| `start`, `stop` | Start or stop the local server |
| `open` | Open the window |
| `status` | List projects with their open asks and sessions |
| `outline <project> [--full]` | Print a project's tree |
| `digest <project> [--since <iso>] [--all]` | Show what changed in a project |
| `usage <project> [--days <n>]` | Print the window's usage numbers |
| `backup [--push \| --drill \| --init <remote url>]` | Snapshot the database, or push a copy to a git remote |
| `restore [--from <backup>]` | Restore from a snapshot or the pushed copy |
| `doctor` | Check the install |
| `claude-install`, `claude-uninstall` | Add or remove the Claude Code hooks, agent and skills |

Sessions run `tasks`, `claim`, `ask` and `orchestrate` themselves. The briefing gives them the exact commands.

## Configuration

- `INPROGRESS_HOME`: the data folder (default `~/.inprogress`)
- `INPROGRESS_PORT`: the server port (default 4317). The hooks, scribe, CLI and server all read it, so set it everywhere or nowhere.
- `CLAUDE_CONFIG_DIR`: where `claude-install` writes (default `~/.claude`)

## Development

- `npm run dev` runs a watch build on port 4318 with a throwaway data folder, plus Vite for the UI
- `npm run typecheck`
- `npm test`, `npm run test:slow`, `npm run test:smoke`, `npm run test:e2e`
- `npm run rollback` swaps back to the previous live build

`docs/library/session-hooks.md` covers the hooks and the briefing in detail. The design decisions behind each part are in `docs/superpowers/specs/`.

## Licence

MIT
