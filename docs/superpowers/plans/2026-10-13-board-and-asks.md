# Board and asks (stage 1) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the tree canvas with the Board and the Project view, turn questions for Aiden into asks, scope a worker's briefing to the step it claimed, and ship the `mip-orc` Orchestrator skill.

**Architecture:** One additive migration (asks table, role, briefing mode, resource purpose). One pure function in `src/core/board.ts` places every step (Now, Next, Backlog, Done) and marks it; the Board, the Project view, the briefings and the digest all read it. The server renders briefings by the project's `briefing_mode` and the session's `role`; the window writes placement, quick-adds and ask clears as operations under `/api/ui/`.

**Tech Stack:** TypeScript, Node, better-sqlite3, Fastify, zod, React (Vite), vitest, Playwright, MCP SDK.

**Spec:** `docs/superpowers/specs/2026-10-12-board-and-asks-design.md` (cited below as "spec 1.5" and so on). Executors read the spec section a task names before starting it.

## Global Constraints

- No em dash (U+2014) or its HTML entities in any file: `test/repo/no-em-dash.test.ts` scans every file.
- Migrations are append-only: never edit a shipped entry of `MIGRATIONS`. Migration 10 keeps `min_reader_version` at `'1'`.
- New enums (`asks.kind`, `sessions.role`, `projects.briefing_mode`, `resources.purpose`) have no SQL CHECK; validate them in code from the `ASK_KINDS`, `SESSION_ROLES`, `BRIEFING_MODES`, `RESOURCE_PURPOSES` constants.
- Every write goes through `write(ctx, actor, fn)` (`src/server/db/tx.ts:42`); never call `write()` inside another `write()`.
- Window writes: under `/api/ui/`, `guarded = { onRequest: requireUi }`, actor `'window'`, project slug-checked with `targetBySlug`. Each is an operation applied to the current row inside one transaction, never a replacement of what the window last saw.
- Hooks (`src/hooks/`) do not change.
- Every project stays on `briefing_mode = 'full'` until the rollout: data and server change no briefing.
- Quiet's tokens, fonts and family hues stand (spec 2.8). The label chip is glyph plus word in muted ink.
- No keyboard shortcuts for the Board (spec Non-goals). Existing keys that stay: `[ ]`, 1 to 9 tabs, Escape, `/` and Ctrl+K.
- e2e ports: each implementer on a UI task sets `INPROGRESS_E2E_PORT` to the port its brief names (4410 to 4419); each screen-reviewer gets a port from 4400 to 4409 and a scratch folder.
- Test gates by label (the playbook): data = typecheck + unit, full strict gates; integration = typecheck + unit + smoke; ui = typecheck + unit + one e2e per user-visible feature; docs = typecheck + unit.

## Deviations from the spec, and why

- **The window's routes move to the window branch** (spec 6.1 lists them under server). Queue, create, clear and events exist only for the window, and the window branch cannot run its e2e tests in parallel with the server branch without them. Task W1.
- **The two bearer ask routes (raise, clear) move to the data branch** (task D2) for the same reason: the window's e2e tests seed asks through them.
- **`ProjectSummary` gains `openAsks` and `permissionWaits` in the data branch** instead of redefining `needsYou`, so data changes nothing visible. The server branch switches `inprogress status` to `openAsks`; the window branch switches the tab count to `openAsks + permissionWaits`. Whichever of server and window merges second deletes `needsYou`, `isNeedsYou` and their leftovers (rule in "Landing").
- **The digest's contents** take in the hand-run Orchestrator's tooling gaps (`~/.inprogress/resources/inprogress/2026-10-13-inprogress-where-we-are.md`, "Tooling gaps"), which spec 4 asks the plan to read. Task S1 lists how each gap is met.

## Branches and order

| Branch | Tasks | Label | Reviewer |
|---|---|---|---|
| `stage1-data` | D1 migration 10, D2 asks repo and snapshot, D3 position function | data | code-reviewer on Opus (`src/server/db/`) |
| `stage1-server` | S1 digest, S2 briefings, S3 claim and orchestrate, S4 asks over the wire, S5 usage | integration | code-reviewer on Opus (`src/server/briefing.ts`, `session-flow.ts`, `src/mcp/`, `claude-config.ts`) |
| `stage1-window` | W1 window routes, W2 shell, W3 Board, W4 Next and Backlog, W5 Project view, W6 Details and measurements | ui | code-reviewer on Opus (focus, popovers, drag, `src/server/repo/`), then the screen-reviewer |
| `stage1-skill-docs` | K1 `mip-orc`, K2 scribe and skill texts, guide, D5 and D6 | docs | code-reviewer on Opus (`claude/`) |

Data lands first. Server and window branch from main after data lands and run in parallel. Skill-docs branches from main after both land. Each branch lands to main from the main checkout after a green `npm run deploy`. Then the rollout (end of this plan).

## Landing rules

- Data and server land with every project on `full`; nothing a session sees changes.
- The second of server and window to merge removes what is left of the old needs-you: `isNeedsYou`, `needsYouAge`, `NEEDS_YOU_STALE_MS` (`src/core/tree.ts:31-40`) when nothing imports them, the `needs_you` subquery and `needsYou` field of `listProjectSummaries` (`src/server/repo/projects.ts:436,449`) and `ProjectSummary.needsYou` (`src/core/types.ts:75`). Run `grep -rn "isNeedsYou\|needsYou\b" src web test` first; every hit must be gone or switched to asks.
- Each branch's session briefs the scribe "#<step> → done; outcome …" after its merge and deploy.

---

# Branch `stage1-data`

## Task D1: Migration 10 and the needs-you conversion

**Files:**
- Modify: `src/server/db/schema.ts` (append entry 10 after line 218)
- Test: `test/server/migration10.test.ts` (new)
- Script: `scripts/check-migration-10.mjs` (new; run once on a copy of the live db)

**Interfaces:**
- Produces: tables and columns of spec 1.1: `asks`, `sessions.role`, `projects.briefing_mode`, `resources.purpose`; `schemaVersion(db) === 10`.

- [ ] **Step 1: Write the failing test**

```ts
// test/server/migration10.test.ts
import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';
import { MIGRATIONS } from '../../src/server/db/schema';
import { migrate, schemaVersion } from '../../src/server/db/connection';

/** A database at schema 9 with the rows the conversion reads, then migrated to 10. */
function at9(seed: (db: Database.Database) => void) {
  const db = new Database(':memory:');
  // Foreign keys stay off while seeding: the project row names its root node before the node exists.
  db.exec('CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)');
  for (const sql of MIGRATIONS.slice(0, 9)) db.exec(sql);
  db.prepare("INSERT INTO meta (key, value) VALUES ('schema_version', '9') ON CONFLICT(key) DO UPDATE SET value = '9'").run();
  seed(db);
  migrate(db);
  return db;
}
```

Check `connection.ts:20-43` for how `migrate` reads the version and creates `meta`; adjust `at9` to match it exactly (the point is: run migrations 1 to 9, seed, then migrate). Then the cases:

```ts
const T = '2026-10-01T00:00:00.000Z';
function seedProject(db: Database.Database) {
  db.prepare("INSERT INTO projects (id, slug, name, description, playbook, status, root_node_id, created_at, updated_at) VALUES (1, 'p', 'P', '', '', 'active', 1, ?, ?)").run(T, T);
  db.prepare("INSERT INTO nodes (id, project_id, parent_id, position, kind, title, body, status, assignee, outcome, created_at, updated_at) VALUES (1, 1, NULL, 1, 'goal', 'P', '', 'active', 'claude', '', ?, ?)").run(T, T);
}
const node = (db: Database.Database, id: number, kind: string, title: string, body: string, status: string, assignee: string, updated = T) =>
  db.prepare("INSERT INTO nodes (id, project_id, parent_id, position, kind, title, body, status, assignee, outcome, created_at, updated_at) VALUES (?, 1, 1, ?, ?, ?, ?, ?, ?, '', ?, ?)").run(id, id, kind, title, body, status, assignee, T, updated);

describe('migration 10', () => {
  it('adds asks, role, briefing_mode and purpose, and keeps min_reader_version 1', () => {
    const db = at9(seedProject);
    expect(schemaVersion(db)).toBe(10);
    expect(db.prepare("SELECT value FROM meta WHERE key = 'min_reader_version'").pluck().get()).toBe('1');
    expect(db.prepare('SELECT briefing_mode FROM projects WHERE id = 1').pluck().get()).toBe('full');
    expect(db.prepare("SELECT name FROM pragma_table_info('sessions') WHERE name = 'role'").pluck().get()).toBe('role');
    expect(db.prepare("SELECT name FROM pragma_table_info('resources') WHERE name = 'purpose'").pluck().get()).toBe('purpose');
  });

  it('converts open question nodes of Aiden to question asks, raised at updated_at', () => {
    const db = at9((d) => { seedProject(d); node(d, 2, 'question', 'Pick a price', '', 'todo', 'me', '2026-10-05T00:00:00.000Z'); });
    expect(db.prepare('SELECT node_id, kind, text, session_id, raised_at, cleared_at, answer FROM asks').all()).toEqual([
      { node_id: 2, kind: 'question', text: 'Pick a price', session_id: null, raised_at: '2026-10-05T00:00:00.000Z', cleared_at: null, answer: '' },
    ]);
  });

  it('converts a Needs you: line to a permission ask with that line as text, CRLF bodies included', () => {
    const db = at9((d) => {
      seedProject(d);
      node(d, 3, 'task', 'Prototype', 'Intro line\r\nNeeds you: try the mod and say yes\r\nmore', 'active', 'me');
      node(d, 4, 'task', 'First line', 'Needs you: at the start', 'todo', 'me');
    });
    expect(db.prepare('SELECT node_id, kind, text FROM asks ORDER BY node_id').all()).toEqual([
      { node_id: 3, kind: 'permission', text: 'Needs you: try the mod and say yes' },
      { node_id: 4, kind: 'permission', text: 'Needs you: at the start' },
    ]);
  });

  it('leaves Aiden-owned steps without such a line, done steps and Claude steps alone', () => {
    const db = at9((d) => {
      seedProject(d);
      node(d, 5, 'task', 'Merge PR #514', 'just do it', 'todo', 'me');
      node(d, 6, 'question', 'Old answered', '', 'done', 'me');
      node(d, 7, 'question', 'Claude asks itself', '', 'todo', 'claude');
      node(d, 8, 'task', 'Mid-line', 'see Needs you: inline', 'blocked', 'me');
    });
    expect(db.prepare('SELECT COUNT(*) FROM asks').pluck().get()).toBe(0);
    expect(db.prepare("SELECT assignee FROM nodes WHERE id = 5").pluck().get()).toBe('me');
  });

  it('refuses a second open ask with the same node, kind and text, and allows it once cleared', () => {
    const db = at9((d) => { seedProject(d); node(d, 2, 'task', 'S', '', 'todo', 'claude'); });
    const ins = db.prepare("INSERT INTO asks (project_id, node_id, kind, text, raised_at) VALUES (1, 2, 'question', 'Q', ?) ON CONFLICT DO NOTHING");
    ins.run(T); ins.run(T);
    expect(db.prepare('SELECT COUNT(*) FROM asks').pluck().get()).toBe(1);
    db.prepare('UPDATE asks SET cleared_at = ?').run(T);
    ins.run(T);
    expect(db.prepare('SELECT COUNT(*) FROM asks').pluck().get()).toBe(2);
  });
});
```

- [ ] **Step 2: Run it to see it fail**

Run: `npx vitest run test/server/migration10.test.ts`
Expected: FAIL (`schemaVersion` is 9; no `asks` table).

- [ ] **Step 3: Append migration 10**

```ts
  // 10: asks, roles, scoped briefings and resource purposes (stage 1, spec 2026-10-12-board-and-asks-design.md section 1).
  // asks.kind, sessions.role, projects.briefing_mode and resources.purpose carry no CHECK, unlike the older enums: each
  // is expected to grow in stage 2, and SQLite cannot change a CHECK without rebuilding the table. Code validates them.
  // The open needs-you steps that already are asks become asks: a question node's title, or a body's "Needs you:" line.
  `
  CREATE TABLE asks (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    node_id INTEGER NOT NULL REFERENCES nodes(id) ON DELETE CASCADE,
    kind TEXT NOT NULL,
    text TEXT NOT NULL,
    session_id TEXT REFERENCES sessions(id) ON DELETE SET NULL,
    raised_at TEXT NOT NULL,
    cleared_at TEXT,
    cleared_by TEXT,
    answer TEXT NOT NULL DEFAULT '',
    answer_delivered_at TEXT
  );
  CREATE INDEX asks_open ON asks (project_id, cleared_at, raised_at);
  CREATE INDEX asks_node ON asks (node_id, raised_at);
  CREATE UNIQUE INDEX asks_open_once ON asks (node_id, kind, text) WHERE cleared_at IS NULL;
  ALTER TABLE sessions ADD COLUMN role TEXT NOT NULL DEFAULT 'worker';
  ALTER TABLE projects ADD COLUMN briefing_mode TEXT NOT NULL DEFAULT 'full';
  ALTER TABLE resources ADD COLUMN purpose TEXT;
  INSERT INTO asks (project_id, node_id, kind, text, raised_at)
    SELECT project_id, id, 'question', title, updated_at FROM nodes
    WHERE assignee = 'me' AND status IN ('todo', 'active', 'blocked') AND kind = 'question';
  INSERT INTO asks (project_id, node_id, kind, text, raised_at)
    SELECT project_id, id, 'permission', substr(t, i + 1, instr(substr(t, i + 1), char(10)) - 1), updated_at
    FROM (
      SELECT project_id, id, updated_at, t, instr(t, char(10) || 'Needs you:') AS i
      FROM (
        SELECT project_id, id, updated_at, char(10) || replace(body, char(13), '') || char(10) AS t FROM nodes
        WHERE assignee = 'me' AND status IN ('todo', 'active', 'blocked') AND kind != 'question'
      )
    )
    WHERE i > 0;
  -- A new table and defaulted or nullable columns: v1 to v9 builds can still read and write this schema.
  INSERT INTO meta (key, value) VALUES ('min_reader_version', '1') ON CONFLICT(key) DO UPDATE SET value = excluded.value;
  `,
```

- [ ] **Step 4: Run the test, then the whole unit suite**

Run: `npx vitest run test/server/migration10.test.ts` then `npm run typecheck && npm test`
Expected: PASS. `test/server/db.test.ts` may assert the schema version: update its expected number to 10.

- [ ] **Step 5: Check the conversion on a copy of the live database**

Create `scripts/check-migration-10.mjs`:

```js
// Copies the live database to a scratch file, migrates the copy with the built server code, and prints the asks.
// Usage: npm run build && node scripts/check-migration-10.mjs <scratch dir>
import { copyFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const [dir] = process.argv.slice(2);
if (!dir) throw new Error('Usage: node scripts/check-migration-10.mjs <scratch dir>');
const copy = join(dir, 'inprogress-copy.db');
copyFileSync(join(homedir(), '.inprogress', 'inprogress.db'), copy);
const { openDb } = await import(pathToFileURL(join(process.cwd(), '.build/dist/server/db/connection.js')).href);
const db = openDb(copy);
console.log(db.prepare('SELECT a.node_id, a.kind, a.text, p.slug FROM asks a JOIN projects p ON p.id = a.project_id ORDER BY a.node_id').all());
```

Check where the build puts `connection.js` (`ls .build/dist/server`) and whether `openDb` migrates (connection.ts:6-13); call `migrate(db)` too if it does not. Copy the db first if the WAL file exists (`inprogress.db-wal`): copy both, or run `sqlite3 inprogress.db ".backup <copy>"` instead.

Run it. Expected, as of 2026-10-13 (the facts file): question asks on #130, #160, #183, #184, #185, #198 and one permission ask on #279 whose text starts `Needs you:`. Fewer or more is fine if the live data moved; read each text. Paste the output into the implementer report.

- [ ] **Step 6: Commit**

```bash
git add src/server/db/schema.ts test/server/migration10.test.ts test/server/db.test.ts scripts/check-migration-10.mjs
git commit -m "Migration 10: asks, role, briefing mode, resource purpose; needs-you conversion (#303)"
```

## Task D2: Asks repo, events and the snapshot

**Files:**
- Modify: `src/core/types.ts` (constants and types below; `Session.role`, `Project.briefingMode`, `ResourceMeta.purpose`, `PastSession.startedAt`, `ProjectSnapshot.asks` and `stateNote`, `ProjectSummary.openAsks` and `permissionWaits`)
- Create: `src/server/repo/asks.ts`
- Modify: `src/server/repo/nodes.ts:136-138` (`updateNode`: a drop clears the node's open asks)
- Modify: `src/server/repo/sessions.ts` (row mapper reads `role`; `listPastSessions` :150-163 adds `startedAt` and focused sessions)
- Modify: `src/server/repo/projects.ts` (`toProject` reads `briefing_mode`; `applyProjectChange` takes `briefingMode`; `listProjectSummaries` :431-457 adds two counts)
- Modify: `src/server/repo/resources.ts` (meta reads `purpose`; `addResource` and `updateResource` take it; a `state` resource replaces the project's previous one)
- Modify: `src/server/repo/snapshot.ts:17-34` (asks, stateNote)
- Modify: `src/server/schemas.ts` (`resourceBody` gains `purpose`; `updateProjectBody` gains `briefingMode`; new `askBody`, `clearAskBody`)
- Create: `src/server/routes/asks.ts` (the two bearer routes below), registered in `src/server/app.ts:104-109`. They live here, not in the server branch, so the window branch can seed asks in its e2e tests while server and window run in parallel.
- Test: `test/server/asks.test.ts` (new); extend `test/server/resources.test.ts`, `test/server/projects.test.ts`, `test/server/sessions.test.ts`, `test/server/app.test.ts` (the routes)

**Interfaces:**
- Consumes: D1's columns.
- Produces (exact names; later tasks rely on them):

```ts
// src/core/types.ts
export const ASK_KINDS = ['question', 'permission', 'review'] as const;
export type AskKind = (typeof ASK_KINDS)[number];
export const SESSION_ROLES = ['worker', 'orchestrator'] as const;
export type SessionRole = (typeof SESSION_ROLES)[number];
export const BRIEFING_MODES = ['full', 'scoped'] as const;
export type BriefingMode = (typeof BRIEFING_MODES)[number];
export const RESOURCE_PURPOSES = ['handoff', 'state'] as const;
export type ResourcePurpose = (typeof RESOURCE_PURPOSES)[number];
/** How long a cleared ask stays in the snapshot, and how old an open one is before it is stale. */
export const ASK_TRAIL_MS = 7 * 24 * 60 * 60 * 1000;
/** An ask's glyph by kind, for the window and the briefing. */
export const ASK_GLYPHS: Record<AskKind, string> = { question: '?', permission: '⚿', review: '◎' };

export interface Ask {
  id: number;
  projectId: number;
  nodeId: number;
  kind: AskKind;
  text: string;
  /** The session that raised it; null for migrated and window rows. */
  sessionId: string | null;
  raisedAt: string;
  clearedAt: string | null;
  /** The actor string write() recorded for the first clear. */
  clearedBy: string | null;
  answer: string;
  answerDeliveredAt: string | null;
}
/** "a7": how sessions, the briefing and the window name an ask. */
export const askTag = (id: number): string => `a${id}`;

/** The project's state note (the resource with purpose 'state' on the root), with its text. */
export interface StateNote { resourceId: number; updatedAt: string; content: string }

// added fields
// Session:        role: SessionRole;
// Project:        briefingMode: BriefingMode;
// ResourceMeta:   purpose: ResourcePurpose | null;
// PastSession:    startedAt: string;
// ProjectSnapshot: asks: Ask[];  /** Open asks, and those cleared in the last 7 days, oldest raised first. */
//                  stateNote: StateNote | null;
// ProjectSummary: openAsks: number; /** Live sessions in state permission. */ permissionWaits: number;
```

```ts
// src/server/repo/asks.ts
export interface RaiseAskInput { nodeId: number; kind: AskKind; text: string; sessionId?: string | null }
/** Idempotent: the open ask with this node, kind and text, inserted if missing. Records ask.raised only when inserted. */
export function raiseAsk(ctx: Ctx, actor: string, input: RaiseAskInput): Ask;
/** Idempotent (spec 1.2). Clearing a question node's ask marks the node done. */
export function clearAsk(ctx: Ctx, actor: string, askId: number, answer?: string): Ask;
/** clearAsk's work for every open ask on a node, inside an open write (a drop). */
export function clearNodeAsks(ctx: Ctx, record: RecordEvent, actor: string, nodeId: number): void;
export function requireAsk(ctx: Ctx, id: number): Ask;
/** Open asks of the project and those cleared within ASK_TRAIL_MS, oldest raised first. */
export function listProjectAsks(ctx: Ctx, projectId: number): Ask[];
/** Cleared asks this session raised whose answer it has not been told yet, oldest cleared first. */
export function undeliveredAnswers(ctx: Ctx, sessionId: string): Ask[];
/** Sets answer_delivered_at on these asks. Not an event: nobody watches it. */
export function markAnswersDelivered(ctx: Ctx, ids: number[]): void;
```

Bearer routes (`guarded = { preHandler: requireToken }`, actor `actorOf(req)`, as `routes/sessions.ts:8-19`):

- `POST /api/nodes/:id/asks` body `askBody = z.object({ kind: z.enum(ASK_KINDS), text: z.string().trim().min(1).max(2000), sessionId: z.string().min(1).nullish() }).strict()` returns the `Ask`.
- `POST /api/asks/:id/clear` body `clearAskBody = z.object({ answer: z.string().max(2000).optional() }).strict()` returns the `Ask`; 404 for an unknown ask.

- [ ] **Step 1: Write the failing tests** (`test/server/asks.test.ts`)

```ts
import { describe, expect, it } from 'vitest';
import { clearAsk, listProjectAsks, raiseAsk, undeliveredAnswers, markAnswersDelivered } from '../../src/server/repo/asks';
import { listEventsSince } from '../../src/server/repo/events';
import { addNodes, requireNode, updateNode } from '../../src/server/repo/nodes';
import { createProject } from '../../src/server/repo/projects';
import { getProjectSnapshot } from '../../src/server/repo/snapshot';
import { makeCtx } from '../helpers';

function setup() {
  const ctx = makeCtx();
  const project = createProject(ctx, 'test', { name: 'P' });
  const [step] = addNodes(ctx, 'scribe:s1', { parentId: project.rootNodeId, nodes: [{ title: 'Step' }] });
  return { ctx, project, step };
}

describe('asks', () => {
  it('raise is idempotent on node, kind and text, and records one ask.raised', () => {
    const { ctx, step } = setup();
    const a = raiseAsk(ctx, 'session:s1', { nodeId: step.id, kind: 'question', text: 'Which port?' });
    const b = raiseAsk(ctx, 'session:s2', { nodeId: step.id, kind: 'question', text: 'Which port?' });
    expect(b.id).toBe(a.id);
    expect(listEventsSince(ctx, 0).filter((e) => e.type === 'ask.raised')).toHaveLength(1);
    const c = raiseAsk(ctx, 'session:s1', { nodeId: step.id, kind: 'review', text: 'Which port?' });
    expect(c.id).not.toBe(a.id);
  });

  it('refuses an unknown kind, an empty text and a root node', () => {
    const { ctx, project, step } = setup();
    expect(() => raiseAsk(ctx, 'w', { nodeId: step.id, kind: 'release' as never, text: 'x' })).toThrow(/Unknown ask kind/);
    expect(() => raiseAsk(ctx, 'w', { nodeId: step.id, kind: 'question', text: '  ' })).toThrow(/empty/);
    expect(() => raiseAsk(ctx, 'w', { nodeId: project.rootNodeId, kind: 'question', text: 'x' })).toThrow(/root/);
  });

  it('clear keeps the first clearedAt and clearedBy, takes the first non-empty answer, and records one ask.cleared', () => {
    const { ctx, step } = setup();
    const a = raiseAsk(ctx, 'session:s1', { nodeId: step.id, kind: 'question', text: 'Q' });
    const first = clearAsk(ctx, 'window', a.id);
    const second = clearAsk(ctx, 'scribe:s9', a.id, 'Use 4410');
    expect(second).toMatchObject({ clearedAt: first.clearedAt, clearedBy: 'window', answer: 'Use 4410' });
    const third = clearAsk(ctx, 'scribe:s9', a.id, 'Another');
    expect(third.answer).toBe('Use 4410');
    expect(listEventsSince(ctx, 0).filter((e) => e.type === 'ask.cleared')).toHaveLength(1);
  });

  it('clearing the ask on a question node marks the node done with the answer, or "Answered"', () => {
    const { ctx, project } = setup();
    const [q1, q2] = addNodes(ctx, 'scribe:s1', { parentId: project.rootNodeId, nodes: [{ title: 'Pick?', kind: 'question', assignee: 'me' }, { title: 'Other?', kind: 'question', assignee: 'me' }] });
    clearAsk(ctx, 'window', raiseAsk(ctx, 'w', { nodeId: q1.id, kind: 'question', text: 'Pick?' }).id, 'Blue');
    clearAsk(ctx, 'window', raiseAsk(ctx, 'w', { nodeId: q2.id, kind: 'question', text: 'Other?' }).id);
    expect(requireNode(ctx, q1.id)).toMatchObject({ status: 'done', outcome: 'Blue' });
    expect(requireNode(ctx, q2.id)).toMatchObject({ status: 'done', outcome: 'Answered' });
  });

  it('dropping a step clears its open asks in the same write; finishing it does not', () => {
    const { ctx, project } = setup();
    const [d, f] = addNodes(ctx, 'scribe:s1', { parentId: project.rootNodeId, nodes: [{ title: 'D' }, { title: 'F' }] });
    raiseAsk(ctx, 'w', { nodeId: d.id, kind: 'question', text: 'Q' });
    raiseAsk(ctx, 'w', { nodeId: f.id, kind: 'review', text: 'Look' });
    updateNode(ctx, 'scribe:s1', d.id, { status: 'dropped' });
    updateNode(ctx, 'scribe:s1', f.id, { status: 'done' });
    const asks = listProjectAsks(ctx, project.id);
    expect(asks.find((a) => a.nodeId === d.id)).toMatchObject({ clearedBy: 'scribe:s1' });
    expect(asks.find((a) => a.nodeId === f.id)?.clearedAt).toBeNull();
  });

  it('lists open asks and those cleared in the last 7 days, in the snapshot too', () => {
    const { ctx, project, step } = setup();
    const old = raiseAsk(ctx, 'w', { nodeId: step.id, kind: 'question', text: 'old' });
    clearAsk(ctx, 'window', old.id);
    ctx.db.prepare('UPDATE asks SET cleared_at = ? WHERE id = ?').run('2000-01-01T00:00:00.000Z', old.id);
    raiseAsk(ctx, 'w', { nodeId: step.id, kind: 'question', text: 'open' });
    expect(getProjectSnapshot(ctx, project.id).asks.map((a) => a.text)).toEqual(['open']);
  });

  it('gives each cleared answer to its raising session once', () => {
    const { ctx, step } = setup();
    const a = raiseAsk(ctx, 'session:s1', { nodeId: step.id, kind: 'question', text: 'Q', sessionId: null });
    clearAsk(ctx, 'window', a.id, 'Yes');
    expect(undeliveredAnswers(ctx, 's1')).toEqual([]); // no session row: sessionId null
    // With a tracked session (insert one through the hook path or enrollSession as sessions.test.ts does), raise with
    // sessionId 's1', clear, then: undeliveredAnswers(ctx, 's1') has it; markAnswersDelivered([id]); it is gone.
  });
});
```

Turn the last test's comment into code using the session helper `test/server/sessions.test.ts` already uses to create a tracked session (read its setup first). Add to `test/server/resources.test.ts`: `purpose` round-trips; an unknown purpose is refused; adding a `state` resource on the root deletes the project's previous `state` resource and records `resource.deleted` for it; a `state` resource on a non-root node is refused ("The state note goes on the project root"). Add to `test/server/projects.test.ts`: `briefingMode` defaults to `'full'`, `changeProject(ctx, 'scribe:s1', 'test', { briefingMode: 'scoped' })` stores it and records `project.updated` with `changes.briefingMode`, an unknown mode is refused; `listProjectSummaries` returns `openAsks` (open asks only) and `permissionWaits` (live sessions in state permission). Add to `test/server/sessions.test.ts`: a new session has `role: 'worker'`; `listPastSessions` includes an ended session that had a focus and no work items, with `startedAt`.

- [ ] **Step 2: Run them to see them fail**

Run: `npx vitest run test/server/asks.test.ts test/server/resources.test.ts test/server/projects.test.ts test/server/sessions.test.ts`
Expected: FAIL (module `repo/asks` missing; new fields undefined).

- [ ] **Step 3: Implement**

`src/server/repo/asks.ts`:

```ts
import { ASK_KINDS, ASK_TRAIL_MS, type Ask, type AskKind } from '../../core/types';
import { msAgo, write, type Ctx, type RecordEvent } from '../db/tx';
import { badRequest, notFound } from '../errors';
import { patchNode, requireNode } from './nodes';

interface AskRow {
  id: number; project_id: number; node_id: number; kind: string; text: string; session_id: string | null;
  raised_at: string; cleared_at: string | null; cleared_by: string | null; answer: string; answer_delivered_at: string | null;
}
const toAsk = (r: AskRow): Ask => ({
  id: r.id, projectId: r.project_id, nodeId: r.node_id, kind: r.kind as AskKind, text: r.text, sessionId: r.session_id,
  raisedAt: r.raised_at, clearedAt: r.cleared_at, clearedBy: r.cleared_by, answer: r.answer, answerDeliveredAt: r.answer_delivered_at,
});
const getRow = (ctx: Ctx, id: number) => ctx.db.prepare('SELECT * FROM asks WHERE id = ?').get(id) as AskRow | undefined;

export function requireAsk(ctx: Ctx, id: number): Ask {
  const row = getRow(ctx, id);
  if (!row) throw notFound(`Ask a${id} not found`, 'The briefing and the window name asks as a<id>.');
  return toAsk(row);
}

export function raiseAsk(ctx: Ctx, actor: string, input: RaiseAskInput): Ask {
  if (!(ASK_KINDS as readonly string[]).includes(input.kind)) throw badRequest(`Unknown ask kind ${JSON.stringify(input.kind)}. Use one of: ${ASK_KINDS.join(', ')}.`);
  const text = input.text.trim();
  if (!text) throw badRequest('An ask needs text: it is empty', 'Say what Aiden should answer, allow or look at.');
  return write(ctx, actor, (record) => {
    const node = requireNode(ctx, input.nodeId);
    if (node.parentId === null) throw badRequest(`#${node.id} is the project root`, 'Raise the ask on the step it concerns.');
    const info = ctx.db
      .prepare('INSERT INTO asks (project_id, node_id, kind, text, session_id, raised_at) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT DO NOTHING')
      .run(node.projectId, node.id, input.kind, text, input.sessionId ?? null, ctx.now());
    const row = ctx.db.prepare('SELECT * FROM asks WHERE node_id = ? AND kind = ? AND text = ? AND cleared_at IS NULL').get(node.id, input.kind, text) as AskRow;
    const ask = toAsk(row);
    if (info.changes) record({ projectId: node.projectId, type: 'ask.raised', entity: 'ask', entityId: ask.id, data: { ask } });
    return ask;
  });
}

/** Inside an open write: the idempotent clear of spec 1.2. */
function clearInWrite(ctx: Ctx, record: RecordEvent, actor: string, before: Ask, answer: string): Ask {
  const first = before.clearedAt === null;
  const takesAnswer = before.answer === '' && answer !== '';
  if (!first && !takesAnswer) return before;
  ctx.db
    .prepare('UPDATE asks SET cleared_at = COALESCE(cleared_at, ?), cleared_by = COALESCE(cleared_by, ?), answer = CASE WHEN answer = \'\' THEN ? ELSE answer END WHERE id = ?')
    .run(ctx.now(), actor, answer, before.id);
  const ask = requireAsk(ctx, before.id);
  if (first) {
    record({ projectId: ask.projectId, type: 'ask.cleared', entity: 'ask', entityId: ask.id, data: { ask } });
    const node = requireNode(ctx, ask.nodeId);
    if (node.kind === 'question' && node.status !== 'done' && node.status !== 'dropped') {
      patchNode(ctx, record, node, { status: 'done', outcome: ask.answer || 'Answered' });
    }
  }
  return ask;
}

export function clearAsk(ctx: Ctx, actor: string, askId: number, answer = ''): Ask {
  return write(ctx, actor, (record) => clearInWrite(ctx, record, actor, requireAsk(ctx, askId), answer.trim()));
}

export function clearNodeAsks(ctx: Ctx, record: RecordEvent, actor: string, nodeId: number): void {
  const open = ctx.db.prepare('SELECT * FROM asks WHERE node_id = ? AND cleared_at IS NULL').all(nodeId) as AskRow[];
  for (const row of open) clearInWrite(ctx, record, actor, toAsk(row), '');
}

export function listProjectAsks(ctx: Ctx, projectId: number): Ask[] {
  return (ctx.db
    .prepare('SELECT * FROM asks WHERE project_id = ? AND (cleared_at IS NULL OR cleared_at >= ?) ORDER BY raised_at, id')
    .all(projectId, msAgo(ctx, ASK_TRAIL_MS)) as AskRow[]).map(toAsk);
}

export function undeliveredAnswers(ctx: Ctx, sessionId: string): Ask[] {
  return (ctx.db
    .prepare('SELECT * FROM asks WHERE session_id = ? AND cleared_at IS NOT NULL AND answer_delivered_at IS NULL ORDER BY cleared_at, id')
    .all(sessionId) as AskRow[]).map(toAsk);
}

export function markAnswersDelivered(ctx: Ctx, ids: number[]): void {
  if (!ids.length) return;
  ctx.db.prepare(`UPDATE asks SET answer_delivered_at = ? WHERE id IN (${ids.map(() => '?').join(', ')})`).run(ctx.now(), ...ids);
}
```

A second clear that only adds an answer records no event (spec 1.2: "records no second event"), but the window refetches on any event; that is fine, since the answer shows on the next one. Check `errors.ts:12-14` for the exact `badRequest`/`notFound` signatures and adjust.

`updateNode` (nodes.ts:136):

```ts
export function updateNode(ctx: Ctx, actor: string, id: number, patch: NodePatch): TreeNode {
  return write(ctx, actor, (record) => {
    const before = requireNode(ctx, id);
    const after = patchNode(ctx, record, before, patch);
    // A dropped step's asks are moot (spec 1.2); a finished one's stay, a review ask most of all.
    if (after.status === 'dropped' && before.status !== 'dropped') clearNodeAsks(ctx, record, actor, id);
    return after;
  });
}
```

Import `clearNodeAsks` from `./asks`; `asks.ts` imports `patchNode` from `./nodes`. ES module cycles between these two are fine because neither uses the other at load time; if the bundler complains, move `clearNodeAsks`'s call behind a function import as `snapshot.ts` does.

Sessions: the row mapper in `repo/sessions.ts` reads `role` (`r.role === 'orchestrator' ? 'orchestrator' : 'worker'`). `listPastSessions`: add `s.started_at` to the select and to the mapped row; widen the WHERE with `OR (s.ended_at >= ? AND s.focus_node_id IS NOT NULL)` (one more `cutoff` argument), so a session that focused a step and ended within the trail is listed even with no work items.

Projects: `toProject` reads `briefingMode: r.briefing_mode === 'scoped' ? 'scoped' : 'full'`. `UpdateProjectInput` and `updateProjectBody` gain `briefingMode: z.enum(BRIEFING_MODES).optional()`; `applyProjectChange` writes `briefing_mode` and includes `briefingMode` in `changes` as it does for `name`. `listProjectSummaries` adds:

```sql
(SELECT COUNT(*) FROM asks a WHERE a.project_id = p.id AND a.cleared_at IS NULL) AS open_asks,
(SELECT COUNT(*) FROM sessions s WHERE s.project_id = p.id AND s.state = 'permission' AND s.last_seen_at >= ?) AS permission_waits,
```

with one more `liveSince` argument, mapped to `openAsks` and `permissionWaits`.

Resources: meta select includes `purpose`; `ResourceInput` and `resourceBody` gain `purpose: z.enum(RESOURCE_PURPOSES).nullish()`; the patch schema (`resourcePatchBody`) gets it through `.partial()`. In `addResource`'s write: when `purpose === 'state'`, refuse unless `nodeId` is the project's root (`badRequest('The state note goes on the project root', 'Attach it to #<root id>.')`), then delete every other resource of the project with `purpose = 'state'`, recording `resource.deleted` for each as `deleteResource` does (reuse its body as an in-write helper rather than calling it: it opens its own write).

Snapshot (`snapshot.ts:23-33`):

```ts
    asks: listProjectAsks(ctx, project.id),
    stateNote: readStateNote(ctx, project.id),
```

with, in `repo/resources.ts`:

```ts
/** The project's state note: the newest resource with purpose 'state', with its content ('' when it has none). */
export function readStateNote(ctx: Ctx, projectId: number): StateNote | null {
  const row = ctx.db
    .prepare("SELECT id, updated_at, content FROM resources WHERE project_id = ? AND purpose = 'state' ORDER BY updated_at DESC, id DESC LIMIT 1")
    .get(projectId) as { id: number; updated_at: string; content: string | null } | undefined;
  return row ? { resourceId: row.id, updatedAt: row.updated_at, content: row.content ?? '' } : null;
}
```

Every test helper or fixture that builds a `Session`, `Project`, `ResourceMeta` or `ProjectSnapshot` literal (grep `test/` and `web/` for `pastSessions:` and `rootNodeId:`) needs the new fields: add `role: 'worker'`, `briefingMode: 'full'`, `purpose: null`, `startedAt`, `asks: []`, `stateNote: null`. Let `npm run typecheck` find them.

- [ ] **Step 4: Run the tests and the suite**

Run: `npx vitest run test/server` then `npm run typecheck && npm test`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/core/types.ts src/server/repo src/server/schemas.ts test
git commit -m "Asks repo, ask events, asks and state note in the snapshot, role, briefing mode, resource purpose (#303)"
```

## Task D3: The position function and hygiene marks

**Files:**
- Create: `src/core/board.ts`
- Test: `test/core/board.test.ts`

**Interfaces:**
- Consumes: `Ask`, `ASK_TRAIL_MS`, `TRAIL_MS`, `ProjectSnapshot` fields from D2; `buildIndex`, `kids`, `ancestors` from `src/core/tree.ts`.
- Produces:

```ts
export type Column = 'now' | 'next' | 'backlog' | 'done';
export const MARKS = ['ended_open', 'no_outcome', 'stale_ask', 'done_focus', 'deep'] as const;
export type Mark = (typeof MARKS)[number];
export type BoardInput = Pick<ProjectSnapshot, 'project' | 'nodes' | 'sessions' | 'pastSessions' | 'resources' | 'asks'>;

export interface BoardRow {
  node: TreeNode;
  column: Column;
  /** 1-based place among the unowned Next entries; null otherwise. */
  queueNumber: number | null;
  /** The live session whose own queue holds it (Next only); null otherwise. */
  owner: Session | null;
  /** Live sessions focused on it: working, then permission, then idle; ties by slot. */
  sessions: Session[];
  /** Its open asks, oldest first. */
  asks: Ask[];
  marks: Mark[];
  /** In Next with no open ask (spec 1.5). */
  ready: boolean;
  /** Its ancestors below the root, outermost first. */
  crumb: TreeNode[];
  /** Its newest resource with purpose 'handoff', if any. */
  handoff: ResourceMeta | null;
}

export interface Board {
  /** Next rows in rail order: unowned by queue order, then each live owner's entries in stored order. */
  next: BoardRow[];
  /** Now rows in tree order. */
  now: BoardRow[];
  /** Backlog rows in tree order. */
  backlog: BoardRow[];
  /** Done rows, newest completedAt first (ties: higher id first). */
  done: BoardRow[];
  /** Every row by node id (groups and the root have none). */
  byId: Map<number, BoardRow>;
  /** Open nodes with open children that are not rows: shown as crumbs. */
  groups: Set<number>;
  /** Rows with at least one mark, in tree order. */
  marked: BoardRow[];
}

export function deriveBoard(input: BoardInput, now: number): Board;
/** A live session: not ended. The snapshot's read already expired stale ones. */
export const isLive: (s: Pick<Session, 'state'>) => boolean;
```

The rules are spec 1.5 and 1.6. Read both before writing code. Restated for the code:

1. The root and `dropped` nodes: no row.
2. `done`: Done (even if queued or focused). Marks: `no_outcome` when `outcome.trim() === ''`; `done_focus` when a live session's focus is on it.
3. Open (todo, active, blocked) and (a live session's focus is on it, or `assignee === 'me' && status === 'active'`): Now.
4. Open and an unowned queue entry: Next with `queueNumber`; open and an entry of a live session's own queue: Next with `owner`. An owned entry whose session is not live is ignored here.
5. Open, no open children: Backlog. Open with open children and none of 3 or 4: a group (in `groups`, no row). Open children are children with status todo, active or blocked.
6. Marks on open rows: `stale_ask` when an open ask's `raisedAt` is older than `ASK_TRAIL_MS`; `ended_open` when no live session is on it and, among `pastSessions` whose `focusNodeId` is the node, the latest by `endedAt` ended within `TRAIL_MS` and the node has no `handoff` resource with `createdAt` after that session's `startedAt`. On any row: `deep` when it has more than three ancestors below the root (crumb length 3 or more means depth 4 or more: root's child is depth 1).
7. `ready` = column next and no open ask.

- [ ] **Step 1: Write the failing tests** (`test/core/board.test.ts`)

```ts
import { describe, expect, it } from 'vitest';
import { deriveBoard, type BoardInput } from '../../src/core/board';
import type { Ask, PastSession, ResourceMeta, Session, TreeNode } from '../../src/core/types';

const NOW = Date.parse('2026-10-13T12:00:00.000Z');
const T = '2026-10-13T11:00:00.000Z';
const DAYS = (n: number) => new Date(NOW - n * 86_400_000).toISOString();

function n(id: number, parentId: number | null, o: Partial<TreeNode> = {}): TreeNode {
  return { id, projectId: 1, parentId, position: id, kind: 'task', title: `S${id}`, body: '', status: 'todo', assignee: 'claude', outcome: '', label: null, createdAt: T, updatedAt: T, completedAt: null, ...o };
}
function s(id: string, o: Partial<Session> = {}): Session {
  return { id, projectId: 1, title: id, cwd: null, branch: null, transcriptPath: null, state: 'working', focusNodeId: null, promptsSinceUpdate: 0, startedAt: T, lastSeenAt: T, endedAt: null, slot: 0, subagents: [], commands: [], role: 'worker', ...o };
}
function ask(id: number, nodeId: number, o: Partial<Ask> = {}): Ask {
  return { id, projectId: 1, nodeId, kind: 'question', text: 'Q', sessionId: null, raisedAt: T, clearedAt: null, clearedBy: null, answer: '', answerDeliveredAt: null, ...o };
}
function input(o: Partial<BoardInput> & { queue?: { nodeId: number; sessionId: string | null }[] }): BoardInput {
  return {
    project: { id: 1, slug: 'p', name: 'P', description: '', playbook: '', status: 'active', rootNodeId: 1, createdAt: T, updatedAt: T, queue: o.queue ?? [], briefingMode: 'full' },
    nodes: o.nodes ?? [n(1, null)], sessions: o.sessions ?? [], pastSessions: o.pastSessions ?? [], resources: o.resources ?? [], asks: o.asks ?? [],
  };
}
const col = (b: ReturnType<typeof deriveBoard>, id: number) => b.byId.get(id)?.column;

describe('deriveBoard', () => {
  it('places by the rules, first match wins', () => {
    const b = deriveBoard(input({
      nodes: [n(1, null), n(2, 1, { status: 'done', completedAt: T }), n(3, 1, { status: 'dropped' }), n(4, 1), n(5, 1), n(6, 1), n(7, 1, { assignee: 'me', status: 'active' })],
      sessions: [s('a', { focusNodeId: 4 })],
      queue: [{ nodeId: 5, sessionId: null }],
    }), NOW);
    expect([col(b, 1), col(b, 2), col(b, 3), col(b, 4), col(b, 5), col(b, 6), col(b, 7)]).toEqual([undefined, 'done', undefined, 'now', 'next', 'backlog', 'now']);
  });

  it('done but still queued is Done; the queue entry is not a Next row', () => {
    const b = deriveBoard(input({ nodes: [n(1, null), n(2, 1, { status: 'done', completedAt: T })], queue: [{ nodeId: 2, sessionId: null }] }), NOW);
    expect(col(b, 2)).toBe('done');
    expect(b.next).toEqual([]);
  });

  it('two sessions on one step: one Now row, working before idle', () => {
    const b = deriveBoard(input({ nodes: [n(1, null), n(2, 1)], sessions: [s('i', { focusNodeId: 2, state: 'idle', slot: 0 }), s('w', { focusNodeId: 2, state: 'working', slot: 1 })] }), NOW);
    expect(b.now).toHaveLength(1);
    expect(b.now[0].sessions.map((x) => x.id)).toEqual(['w', 'i']);
  });

  it('an open ask and no session: Next or Backlog, not ready in Next', () => {
    const b = deriveBoard(input({ nodes: [n(1, null), n(2, 1), n(3, 1)], queue: [{ nodeId: 2, sessionId: null }], asks: [ask(1, 2), ask(2, 3)] }), NOW);
    expect(b.byId.get(2)).toMatchObject({ column: 'next', ready: false });
    expect(b.byId.get(3)).toMatchObject({ column: 'backlog', ready: false });
  });

  it('a live focus on a done step: Done with done_focus', () => {
    const b = deriveBoard(input({ nodes: [n(1, null), n(2, 1, { status: 'done', completedAt: T, outcome: 'ok' })], sessions: [s('a', { focusNodeId: 2 })] }), NOW);
    expect(b.byId.get(2)).toMatchObject({ column: 'done', marks: ['done_focus'] });
  });

  it('ended_open: a step its last session left open without a newer handoff', () => {
    const past: PastSession[] = [{ id: 'old', title: null, focusNodeId: 2, startedAt: DAYS(2), endedAt: DAYS(1) }];
    const left = deriveBoard(input({ nodes: [n(1, null), n(2, 1, { status: 'active' })], pastSessions: past }), NOW);
    expect(left.byId.get(2)).toMatchObject({ column: 'backlog', marks: ['ended_open'] });
    const handoff: ResourceMeta = { id: 9, projectId: 1, nodeId: 2, kind: 'doc', title: 'h', path: null, url: null, contentLength: 1, sessionId: 'old', createdAt: DAYS(1.5), updatedAt: DAYS(1.5), purpose: 'handoff' };
    const clean = deriveBoard(input({ nodes: [n(1, null), n(2, 1, { status: 'active' })], pastSessions: past, resources: [handoff] }), NOW);
    expect(clean.byId.get(2)?.marks).toEqual([]);
    expect(clean.byId.get(2)?.handoff?.id).toBe(9);
  });

  it('ended_open never on a Now row, and not past the trail', () => {
    const past: PastSession[] = [{ id: 'old', title: null, focusNodeId: 2, startedAt: DAYS(9), endedAt: DAYS(8) }];
    const b = deriveBoard(input({ nodes: [n(1, null), n(2, 1, { status: 'active' }), n(3, 1)], pastSessions: [...past, { id: 'o2', title: null, focusNodeId: 3, startedAt: DAYS(2), endedAt: DAYS(1) }], sessions: [s('a', { focusNodeId: 3 })] }), NOW);
    expect(b.byId.get(2)?.marks).toEqual([]);
    expect(b.byId.get(3)).toMatchObject({ column: 'now', marks: [] });
  });

  it('no_outcome, stale_ask and deep', () => {
    const b = deriveBoard(input({
      nodes: [n(1, null), n(2, 1, { status: 'done', completedAt: T }), n(3, 1), n(4, 3), n(5, 4), n(6, 5), n(7, 6)],
      asks: [ask(1, 3, { raisedAt: DAYS(8) })],
    }), NOW);
    expect(b.byId.get(2)?.marks).toEqual(['no_outcome']);
    expect(b.byId.get(6)?.marks ?? []).toEqual([]);   // depth 4 but a group (open child 7)
    expect(b.byId.get(7)?.marks).toEqual(['deep']);   // depth 5
    expect(b.groups.has(3)).toBe(true);
    // node 3 is a group, so its stale ask shows on no row; a stale ask on a row:
    const c = deriveBoard(input({ nodes: [n(1, null), n(2, 1)], asks: [ask(1, 2, { raisedAt: DAYS(8) })] }), NOW);
    expect(c.byId.get(2)?.marks).toEqual(['stale_ask']);
  });

  it('a group with all children done falls to Backlog; a queued group is a Next row', () => {
    const b = deriveBoard(input({ nodes: [n(1, null), n(2, 1), n(3, 2, { status: 'done', completedAt: T }), n(4, 1), n(5, 4)], queue: [{ nodeId: 4, sessionId: null }] }), NOW);
    expect(col(b, 2)).toBe('backlog');
    expect(col(b, 4)).toBe('next');
  });

  it('orders Next: unowned by queue number, then live owners; ignores an ended owner', () => {
    const b = deriveBoard(input({
      nodes: [n(1, null), n(2, 1), n(3, 1), n(4, 1), n(5, 1)],
      sessions: [s('a', { slot: 0 }), s('gone', { slot: 1, state: 'ended', endedAt: T })],
      queue: [{ nodeId: 4, sessionId: 'a' }, { nodeId: 5, sessionId: 'gone' }, { nodeId: 3, sessionId: null }, { nodeId: 2, sessionId: null }],
    }), NOW);
    expect(b.next.map((r) => [r.node.id, r.queueNumber, r.owner?.id ?? null])).toEqual([[3, 1, null], [2, 2, null], [4, null, 'a']]);
    expect(col(b, 5)).toBe('backlog');
  });

  it('done rows newest first; crumb is the ancestors below the root', () => {
    const b = deriveBoard(input({ nodes: [n(1, null), n(2, 1), n(3, 2, { status: 'done', completedAt: DAYS(2) }), n(4, 2, { status: 'done', completedAt: DAYS(1) }), n(5, 2)] }), NOW);
    expect(b.done.map((r) => r.node.id)).toEqual([4, 3]);
    expect(b.byId.get(5)?.crumb.map((c) => c.id)).toEqual([2]);
  });
});
```

- [ ] **Step 2: Run to see it fail**

Run: `npx vitest run test/core/board.test.ts`
Expected: FAIL (module missing).

- [ ] **Step 3: Implement `src/core/board.ts`**

```ts
import { ancestors, buildIndex, dfsOrder, kids } from './tree';
import { ASK_TRAIL_MS, TRAIL_MS, type Ask, type ProjectSnapshot, type ResourceMeta, type Session, type TreeNode } from './types';

// (Column, MARKS, Mark, BoardInput, BoardRow, Board as in Interfaces above)

export const isLive = (s: Pick<Session, 'state'>): boolean => s.state !== 'ended';
const OPEN = new Set(['todo', 'active', 'blocked']);
const isOpen = (n: TreeNode) => OPEN.has(n.status);
const STATE_ORDER: Record<string, number> = { working: 0, permission: 1, idle: 2 };

export function deriveBoard(input: BoardInput, now: number): Board {
  const index = buildIndex(input.nodes);
  const order = dfsOrder(index);
  const rootId = index.root?.id ?? null;
  const live = input.sessions.filter(isLive);
  const liveIds = new Set(live.map((s) => s.id));
  const focusOf = new Map<number, Session[]>();
  for (const s of live) if (s.focusNodeId !== null) focusOf.set(s.focusNodeId, [...(focusOf.get(s.focusNodeId) ?? []), s]);
  for (const list of focusOf.values()) list.sort((a, b) => (STATE_ORDER[a.state] ?? 3) - (STATE_ORDER[b.state] ?? 3) || (a.slot ?? 0) - (b.slot ?? 0));
  const openAsks = new Map<number, Ask[]>();
  for (const a of input.asks) if (a.clearedAt === null) openAsks.set(a.nodeId, [...(openAsks.get(a.nodeId) ?? []), a]);
  const handoffOf = new Map<number, ResourceMeta>();
  for (const r of input.resources) {
    if (r.purpose !== 'handoff') continue;
    const had = handoffOf.get(r.nodeId);
    if (!had || r.createdAt > had.createdAt) handoffOf.set(r.nodeId, r);
  }
  const lastPast = new Map<number, ProjectSnapshot['pastSessions'][number]>();
  for (const p of input.pastSessions) {
    if (p.focusNodeId === null) continue;
    const had = lastPast.get(p.focusNodeId);
    if (!had || p.endedAt > had.endedAt) lastPast.set(p.focusNodeId, p);
  }
  const unowned = input.project.queue.filter((e) => e.sessionId === null);
  const queueNumber = new Map<number, number>();
  let k = 0;
  const openIds = new Set(input.nodes.filter(isOpen).map((x) => x.id));
  for (const e of unowned) if (openIds.has(e.nodeId)) queueNumber.set(e.nodeId, ++k);
  const ownerOf = new Map<number, Session>();
  for (const e of input.project.queue) {
    if (e.sessionId === null || !liveIds.has(e.sessionId) || queueNumber.has(e.nodeId)) continue;
    ownerOf.set(e.nodeId, live.find((s) => s.id === e.sessionId)!);
  }

  const byId = new Map<number, BoardRow>();
  const groups = new Set<number>();
  for (const node of input.nodes) {
    if (node.id === rootId || node.status === 'dropped') continue;
    const crumb = ancestors(index, node.id).filter((a) => a.id !== rootId);
    const sessions = focusOf.get(node.id) ?? [];
    const asks = openAsks.get(node.id) ?? [];
    let column: Column;
    if (node.status === 'done') column = 'done';
    else if (sessions.length || (node.assignee === 'me' && node.status === 'active')) column = 'now';
    else if (queueNumber.has(node.id) || ownerOf.has(node.id)) column = 'next';
    else if (kids(index, node.id).some(isOpen)) { groups.add(node.id); continue; }
    else column = 'backlog';
    const marks: Mark[] = [];
    if (column === 'done') {
      if (!node.outcome.trim()) marks.push('no_outcome');
      if (sessions.length) marks.push('done_focus');
    } else {
      if (column !== 'now') {
        const past = lastPast.get(node.id);
        const handoff = handoffOf.get(node.id);
        if (past && now - Date.parse(past.endedAt) <= TRAIL_MS && !(handoff && handoff.createdAt > past.startedAt)) marks.push('ended_open');
      }
      if (asks.some((a) => now - Date.parse(a.raisedAt) > ASK_TRAIL_MS)) marks.push('stale_ask');
    }
    if (crumb.length >= 3) marks.push('deep');
    byId.set(node.id, {
      node, column, crumb, sessions, asks, marks,
      queueNumber: column === 'next' ? (queueNumber.get(node.id) ?? null) : null,
      owner: column === 'next' ? (ownerOf.get(node.id) ?? null) : null,
      ready: column === 'next' && asks.length === 0,
      handoff: handoffOf.get(node.id) ?? null,
    });
  }
  const rows = [...byId.values()];
  const treeOrder = (a: BoardRow, b: BoardRow) => (order.get(a.node.id) ?? 0) - (order.get(b.node.id) ?? 0);
  const queueOrder = new Map(input.project.queue.map((e, i) => [e.nodeId, i]));
  const next = rows.filter((r) => r.column === 'next').sort((a, b) =>
    (a.owner ? 1 : 0) - (b.owner ? 1 : 0) || (a.queueNumber ?? 0) - (b.queueNumber ?? 0) || (a.owner?.slot ?? 0) - (b.owner?.slot ?? 0) || (queueOrder.get(a.node.id) ?? 0) - (queueOrder.get(b.node.id) ?? 0));
  return {
    next,
    now: rows.filter((r) => r.column === 'now').sort(treeOrder),
    backlog: rows.filter((r) => r.column === 'backlog').sort(treeOrder),
    done: rows.filter((r) => r.column === 'done').sort((a, b) => (b.node.completedAt ?? '').localeCompare(a.node.completedAt ?? '') || b.node.id - a.node.id),
    byId, groups,
    marked: rows.filter((r) => r.marks.length).sort(treeOrder),
  };
}
```

Check `ancestors` (`src/core/tree.ts`) returns root-first or nearest-first and whether it includes the node; reverse if needed so `crumb` is outermost first. Check `dfsOrder`'s return type (a Map of id to order, as `briefing.ts:136` uses it).

- [ ] **Step 4: Run the tests and the suite**

Run: `npx vitest run test/core/board.test.ts` then `npm run typecheck && npm test`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/core/board.ts test/core/board.test.ts
git commit -m "Position function: Now, Next, Backlog, Done and hygiene marks (#303)"
```

**Data branch done when:** typecheck, unit and the migration check on the live copy pass; code-reviewer (Opus) clean; `npm run deploy` green from the main checkout after merge. Nothing visible changes.

---

# Branch `stage1-server`

Branch from main after `stage1-data` lands. Every task here keeps every project on `full`.

## Task S1: The digest

**Files:**
- Create: `src/server/digest.ts`
- Modify: `src/server/routes/projects.ts` (or wherever `GET /api/projects/:ref/outline` is registered: `grep -rn "outline" src/server/routes`), add `GET /api/projects/:ref/digest`
- Modify: `src/cli/commands.ts` (case `digest`; usage string :13)
- Test: `test/server/digest.test.ts`, `test/cli/commands.test.ts`

**Interfaces:**
- Consumes: D2 tables and `ASK_GLYPHS`, `askTag`; D3 `deriveBoard`.
- Produces:

```ts
export interface Digest {
  project: { slug: string; name: string };
  /** The window start: --since, else the state note's updatedAt, else 7 days ago. */
  since: string;
  sinceSource: 'given' | 'state_note' | 'default';
  done: { id: number; title: string; outcome: string; completedAt: string }[];
  asksRaised: Ask[];
  asksCleared: Ask[];
  /** Sessions started, or ended (by MIN(ended_at, last_seen_at)), in the window; ended ones within the 7-day trail only. */
  sessions: { id: string; letter: string; title: string; startedAt: string; endedAt: string | null; focusNodeId: number | null; handoff: boolean; openTasks: number }[];
  /** Steps created by actor 'window' in the window. */
  quickAdds: { id: number; title: string; createdAt: string }[];
  /** project.updated events by actor 'window' with data.op, in the window. */
  moves: { ts: string; op: 'move' | 'remove'; nodeId: number }[];
  /** Resources created in the window. */
  documents: { id: number; title: string; nodeId: number; purpose: string | null; createdAt: string }[];
  /** deriveBoard(...).marked, as id, title and marks. */
  marked: { id: number; title: string; marks: Mark[] }[];
}
export function readDigest(ctx: Ctx, ref: string | number, since?: string): Digest;
/** The one-line counts offer of spec 4 step 1. */
export function formatCounts(d: Digest, now: number): string;
/** The digest, at most 20 item lines, then "+n more". */
export function formatDigest(d: Digest, now: number): string;
```

How the hand-run Orchestrator's tooling gaps (where-we-are note, "Tooling gaps") are met here:

| Gap | In this task |
|---|---|
| 1 A digest read with times | `readDigest` reads `nodes.completed_at`, `asks.raised_at` and `cleared_at`, `sessions.started_at` and `ended_at`, `resources.created_at` (spec 1.7: tables, not events) |
| 2 Last look | `since` from the state note's `updated_at` (`purpose = 'state'`), else 7 days |
| 3 Needs-you history | `asksRaised`, `asksCleared` from the asks table |
| 4 Ended without a handoff | a session has a handoff when a resource with `purpose = 'handoff'` has `session_id` = its id |
| 5 Swept session ends | a session's end is `MIN(ended_at, last_seen_at)`; a run of 3 or more ends within the same minute prints as one line, "5 sessions swept as ended at 12:52" |
| 6 Open tasks on done steps | `openTasks` counts the session's work items with status pending or in_progress on any step, done ones included |
| 8 Done without outcome | the `no_outcome` mark in `marked` |
| 12 Session letters | session lines print letter and id prefix together, `B a4e13975` |
| 9, 10, 11, 13 | S3 (orchestrate), K1 (mip-orc), K1, D3 (`ready`) |
| 7 Shipped but still open | stage 2; not in this plan |

`moves` are the only event read (spec 1.7). Sessions: `SELECT ... FROM sessions WHERE project_id = ? AND (started_at >= :since OR (state = 'ended' AND MIN(ended_at, last_seen_at) >= MAX(:since, :trailCutoff)))`.

`formatCounts` output, exactly (parts with zero leave out their clause; "1 answered" counts cleared asks with an answer):

```
Since your last look (3d): 4 done · 2 asks raised, 1 answered · 2 sessions ended, 1 without a handoff. Marks: 3 steps.
```

`formatDigest` output shape:

```
Digest for InProgress since 2026-10-10 12:15 (state note):
Done (4): #301 Title: "outcome clipped to 80" · ...
Asks raised (2): a7 ? on #42 "text" (B, 3h) · ...
Asks cleared (1): a5 on #40: "answer" (window)
Sessions (3): B a4e13975 "title" ended 2d ago, no handoff, 2 open tasks · ...
Quick-added (1): #312 Title
Moved in Next (2): #45 moved, #46 removed
New documents (2): r160 "title" on #26 (state) · ...
Marks (3): #279 stale_ask · #173 ended_open · #53 no_outcome
```

One line per item when a section has more than three items (indented two spaces); 20 item lines in all, then `+n more (inprogress digest <slug> --since <iso>)`. Empty sections are left out; nothing at all prints `Nothing since <time>.`

- [ ] **Step 1: Write failing tests** in `test/server/digest.test.ts` covering: `since` from a state note, else 7 days, else `--since`; a done step inside and outside the window; an ask raised and one cleared with an answer; a session ended without a handoff and one with a handoff by `session_id`; a swept run of three ends in one minute prints one line; a quick-add (create a node with actor `'window'` through `addNodes(ctx, 'window', ...)`) and a resource; the 20-line cap with `+n more`; `formatCounts` with zeros. Build the data with the repo functions (`addNodes`, `updateNode`, `raiseAsk`, `clearAsk`, `addResource`) and the session helper from `test/server/sessions.test.ts`; move `makeCtx`'s clock where a test needs a time (`makeCtx(start)` advances 1 s per call).
- [ ] **Step 2: Run them; expect FAIL** (`npx vitest run test/server/digest.test.ts`).
- [ ] **Step 3: Implement** `readDigest`, `formatCounts`, `formatDigest`; the route returns `{ digest, text: formatDigest(...), counts: formatCounts(...) }` and takes `?since=<iso>` (zod: `z.string().datetime().optional()`). CLI: `inprogress digest <project> [--since <iso>]` prints `text`; exit 1 with the usage line when the project is missing; the server down prints `InProgress is not running.` and exits 1, as `status` does.
- [ ] **Step 4: Add a CLI test** in `test/cli/commands.test.ts` in the style of the existing `status` test (read it first): the command prints the route's `text`.
- [ ] **Step 5: Run** `npm run typecheck && npm test`; expect PASS.
- [ ] **Step 6: Commit** `git add src/server/digest.ts src/server/routes src/cli/commands.ts test && git commit -m "Digest from tables: inprogress digest, counts line (#303)"`

## Task S2: Briefings by mode and role

**Files:**
- Create: `src/server/briefing-scoped.ts` (the scoped renderers)
- Modify: `src/server/briefing.ts` (rules line, Needs you and check lines read asks; dispatch by mode and role)
- Modify: `src/server/session-flow.ts:299-306` (pass the session's role through; nothing else here)
- Modify: `src/cli/commands.ts:79-81` (`status` prints `openAsks`)
- Test: `test/server/briefing-scoped.test.ts` (new); update the existing briefing tests (`grep -rln renderBriefing test`)

**Interfaces:**
- Consumes: `deriveBoard`, `BoardRow` (D3); `Ask`, `askTag`, `ASK_GLYPHS`, `Session.role`, `Project.briefingMode`, `StateNote` (D2); `formatCounts`, `readDigest` (S1).
- Produces:

```ts
// briefing-scoped.ts
/** Spec 3.4 items 3 to 7 for one step: the block claim prints and the scoped worker briefing carries. */
export function stepBlock(snapshot: ProjectSnapshot, nodeId: number, session: Session, now: number): string[];
export function renderWorkerBriefing(snapshot: ProjectSnapshot, session: Session, now: number): string;
export function renderUnclaimedBriefing(snapshot: ProjectSnapshot, session: Session, now: number, cli?: string): string;
export function renderOrchestratorBriefing(snapshot: ProjectSnapshot, session: Session, now: number, counts: string, opts: BriefingOptions): string;
// briefing.ts
export interface RulesMode { scoped: boolean; orchestrator: boolean }
export function updateRules(o: UpdateRulesOptions & { mode?: RulesMode }): string[];
/** Open asks oldest first, then live permission waits: `Needs you (2): a7 ? on #42 "Which port?" (3d) · D waiting for permission on #45 (2m)`. */
export function needsYouLine(snapshot: ProjectSnapshot, now: number): string | undefined;
```

Rules (spec 3.4), with exact wording:

- Both modes: the rules bullet at `briefing.ts:34` changes its last clause from `something goes to Aiden (assignee me) or he answers.` to `Aiden must answer, allow or look at something ("ask on #id: <question|permission|review>, <text>"; "assignee me" only for a step Aiden does himself) or he answers ("a7 answered: <answer>").`
- `full`: today's line set for every session, with `needsYouLine` and `checkLine` reading open asks (age from `raisedAt`; the check line lists asks older than 3 days by `a<id>`); `statusText` no longer prints NEEDS YOU (a step's asks show on the Needs you line); `lineFor` drops `(question)`; the frontier's `targets` (`briefing.ts:82`) become active steps plus steps with an open ask.
- `scoped` worker with a claimed step (role worker, focus set on an open or done step of this project):
  1. Header line as today, then `Role: worker on #42.`
  2. The plan-edit line, the playbook, the update rules with `mode.scoped`: the "a step starts" clause reads `a step starts ("inprogress claim <id> --session <sid>")`, and the "the plan or an order changes (\"queue: ...\")" clause is removed.
  3. `Your step:` the parent chain as `#26 InProgress › #303 Declutter window`, then `  #42 ⧉ Title · active (2/5)`, its open children one per line (at most 8), its live open tasks (at most 5, `◐`/`○`).
  4. `Handoff: r160 "title" (2d)` when `BoardRow.handoff` is set.
  5. `Resources on #42: r12 title · r11 title` newest first, at most 5.
  6. `Asks on #42: a7 ? "text" (open, 3h) · a5 ◎ "text" (answered: "yes")`: open ones, then cleared since the session's `startedAt`.
  7. `Left unfinished on #42 by an earlier session: "subject", ...` (`leftUnfinishedLine` filtered to the step).
  8. `Other sessions here:` as today.
- `scoped` worker with no step: header, `Role: worker, no step claimed.`, the rules with `mode.scoped`, the playbook, `Ready to claim: #45 ⧉ Title · #46 ...` (up to three `deriveBoard().next` rows with `ready`, not `assignee === 'me'`, own-queue entries of this session first), then `Claim one: node <cli> claim <id> --session <sid>`; or, none ready, `Nothing is ready. Planning is the Orchestrator's job (mip-orc).`; then `Other sessions here`.
- `scoped` orchestrator: header with `Role: orchestrator. You never implement: no code edits, commits, builds or implementers.`, the rules with `mode.orchestrator` (keeps "later:", drops "queue:"), the playbook, the counts line (S1 `formatCounts`), then every line of today's full briefing after the rules (`Where things stand` to `Other sessions here`).
- In a `full` project, an orchestrator gets the orchestrator briefing too (the role was asked for); a worker gets today's.
- Status line (`renderStatusLine`): `scoped` worker: `[InProgress] P · on #42 (a7 open) · last scribe update 3 prompts ago. ...` or `· no step claimed ·`, no needs-you count; orchestrator and `full`: today's line with `n need you` from open asks.
- Status answer (`renderStatusAnswer`): `scoped` worker: the step block (or the unclaimed lines); orchestrator and `full`: today's answer.

- [ ] **Step 1: Write failing tests** in `test/server/briefing-scoped.test.ts`: build snapshots with `getProjectSnapshot` over a `makeCtx` db (project set to `scoped` with `changeProject`), and assert the exact line list for: worker on a step with a parent, two children, a handoff, two resources, one open and one cleared ask, a left-unfinished task, another session; worker with none ready; worker with two ready (own-queue first); orchestrator (counts line present, "you never implement"); status line for each; status answer for a worker. In the existing briefing tests, replace `assignee: 'me'` needs-you fixtures with raised asks and update the expected rules line.
- [ ] **Step 2: Run; expect FAIL.**
- [ ] **Step 3: Implement.** `renderBriefing` gains the dispatch at its top:

```ts
  const session = sessions.find((s) => s.id === sessionId);
  if (session?.role === 'orchestrator') return renderOrchestratorBriefing(snapshot, session, now, opts.counts ?? '', opts);
  if (project.briefingMode === 'scoped' && session) {
    const focus = session.focusNodeId !== null ? snapshot.nodes.find((n) => n.id === session.focusNodeId) : undefined;
    return focus ? renderWorkerBriefing(snapshot, session, now) : renderUnclaimedBriefing(snapshot, session, now);
  }
```

`BriefingOptions` gains `counts?: string`; `session-flow.ts:301` passes `counts: formatCounts(readDigest(ctx, projectId), now)` only when the session's role is orchestrator (read the session row first; `readDigest` must run outside any write, as `getProjectSnapshot` does). Same dispatch in `renderStatusAnswer` and `renderStatusLine`. `status` CLI prints `${p.openAsks} need you`.
- [ ] **Step 4: Run** `npm run typecheck && npm test`; expect PASS.
- [ ] **Step 5: Commit** `git commit -m "Briefings by mode and role; Needs you from asks (#303)"` with the changed paths.

## Task S3: Claim and orchestrate

**Files:**
- Modify: `src/lib/task-command.ts` (generalise the prefix helper)
- Modify: `src/cli/claude-config.ts:113-136` (allow rules for tasks, claim, ask, orchestrate, digest)
- Modify: `src/server/session-flow.ts` (`applyFocus` extracted from `setFocus` :343-372; `claimStep`; `orchestrate`; `clear` start resets role at :131; scribe focus in a scoped project marks a briefing due)
- Modify: `src/server/routes/sessions.ts` (`POST /api/sessions/:id/claim`, `POST /api/sessions/:id/orchestrate`)
- Modify: `src/server/schemas.ts` (`claimBody = z.object({ nodeId: z.number().int().positive() }).strict()`, `orchestrateBody = z.object({ status: z.boolean().optional() }).strict()`)
- Create: `src/cli/claim.ts` (parse and run `claim`, `orchestrate`)
- Modify: `src/cli/commands.ts` (cases; usage)
- Test: `test/server/claim.test.ts`, `test/cli/claim.test.ts`, `test/cli/claude-config.test.ts`, `test/lib/task-command.test.ts` (`ls test/lib` first; extend the existing file if there is one)

**Interfaces:**
- Consumes: `stepBlock`, `renderOrchestratorBriefing` (S2); `readDigest`, `formatCounts` (S1); `deriveBoard` (D3).
- Produces:

```ts
// task-command.ts
export const CLI_SUBCOMMANDS = ['tasks', 'claim', 'ask', 'orchestrate', 'digest'] as const;
export type CliSubcommand = (typeof CLI_SUBCOMMANDS)[number];
export function cliPrefix(cli: string, sub: CliSubcommand): string;        // `node C:/.../dist/cli/main.js claim`
export function cliAllowRules(cli: string): string[];                      // Bash and PowerShell rule per subcommand
export function isCliAllowRule(rule: string): boolean;                     // any subcommand, any repo path
// taskPrefix, taskAllowRules, isTaskAllowRule stay as thin wrappers (or are replaced at every caller: grep them)
export function claimCommand(sessionId: string, o?: { cli?: string }): string; // `node <cli> claim <id> --session <sid>`
// session-flow.ts
export interface ClaimResult { session: Session; notes: string[]; block: string[] }
export function claimStep(ctx: Ctx, actor: string, sessionId: string, nodeId: number): ClaimResult;
export function orchestrate(ctx: Ctx, actor: string, sessionId: string, o: { status: boolean }): { session: Session; opening: string };
```

Behaviour (spec 3.1, 3.2, 3.7):

- `applyFocus(ctx, record, existing, nodeId)` holds `setFocus`'s body from line 345 to 370 (everything inside the `write`). `setFocus` = `write(... applyFocus ...)`, plus: when `actor.startsWith('scribe')`, the project's `briefing_mode` is `scoped` and the focus changed, `markBriefingDue(ctx, sessionId)` inside the same write.
- `claimStep`: notes are computed before the write from `deriveBoard(getProjectSnapshot(...))`: `Note: #42 is not in Next.` when its row's column is not `next` and not `now`; `Note: #42 has open ask a7.` per open ask; `Note: #42 is also claimed by A "title" (working).` per other live session focused on it. Then one `write`: `applyFocus`, then `UPDATE sessions SET role = 'worker'`, recording `session.updated` with `changed: ['role']` only when the role changed. Marks nothing due. Then `block = stepBlock(fresh snapshot, nodeId, session, now)`. Refusals are `setFocus`'s (another project's step, untracked session).
- `orchestrate`: one `write`: role `orchestrator`, focus null (record `session.updated` with `changed: ['role', 'focusNodeId']`), and an event `{ type: 'session.orchestrate', entity: 'session', entityId: sessionId, data: { status, marks: board.marked.length } }`. Returns `opening = renderOrchestratorBriefing(...)` with `formatCounts(readDigest(...))`; with `status: true` the opening appends `formatDigest(...)`, the reconcile lines (`board.marked`, one per step: `#53 no_outcome`) and the top three of Next with ready or not ready.
- SessionStart with `source === 'clear'` (`session-flow.ts:131`): set `next.role = 'worker'`. `saveSession` must write `role` (check its column list). Compaction and resume keep the role.
- CLI: `inprogress claim <id> --session <sid>` posts to `/api/sessions/<sid>/claim` with actor `session:<sid>`, prints the notes then the block, exit 0; a 400 prints the error and hint, exit 1. `inprogress orchestrate --session <sid> [--status]` prints the opening. Parse like `parseTasksArgs` (`src/cli/tasks.ts:31`): a missing `--session` or id exits 1 with the usage line. Neither starts the server: server down prints the same hint `tasks` prints (`TASKS_NOT_RUNNING_HINT`).
- Install: `allowRules(repo)` (claude-config.ts:113) returns `cliAllowRules(repoCli(repo))`; `addAllowRules`/`removeAllowRules` use `isCliAllowRule` so a reinstall replaces old `tasks` rules and an uninstall removes all five. The kit check (`kitStatus`) reports `settings` as differing until every rule is present.
- The briefing's rules line for scoped workers (S2) prints `claimCommand(sessionId)`; replace S2's literal with it.

- [ ] **Step 1: Write failing tests:** claim on a todo step makes it active, sets role worker, returns the block, records no `briefing_due`; the three notes; claim on another project's step throws with the hint; orchestrate sets role, clears focus, records `session.orchestrate` with `status`; a scribe `setFocus` in a scoped project marks the briefing due and in a full one does not; a `clear` start resets an orchestrator to worker and a `compact` start does not; `cliAllowRules` gives ten rules and none for a path with a space; `isCliAllowRule` matches each and refuses `Bash(node x/dist/cli/main.js rm *)`; install writes the ten rules and uninstall removes them (extend the existing claude-config test); CLI parse errors exit 1.
- [ ] **Step 2: Run; expect FAIL.**
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** `npm run typecheck && npm test`; expect PASS.
- [ ] **Step 5: Commit** `git commit -m "Claim and orchestrate: CLIs, routes, roles, allow rules (#303)"` with the changed paths.

## Task S4: Asks over the wire, and the answers line

**Files:**
- Create: `src/cli/ask.ts`; modify `src/cli/commands.ts`
- Modify: `src/mcp/server.ts` (`raise_ask`, `clear_ask`; `purpose` on `add_resource` and `update_resource`; `briefing_mode` on `update_project`)
- Modify: `src/server/session-flow.ts:303-306` (the answers line)
- Test: `test/cli/ask.test.ts`, `test/mcp/*` (`ls test/mcp`; extend the server tool test), `test/server/sessions.test.ts` or a new `test/server/answers.test.ts`

**Interfaces:**
- Consumes: `undeliveredAnswers`, `markAnswersDelivered` (D2); the bearer routes `POST /api/nodes/:id/asks` and `POST /api/asks/:id/clear` (D2).
- Produces: MCP tools:
  - `raise_ask`: `{ node: id, kind: z.enum(ASK_KINDS), text: z.string().min(1), session }` returns `a7 raised on #42.`
  - `clear_ask`: `{ ask: z.number().int().positive(), answer: z.string().optional(), session }` returns `a7 cleared.` or `a7 answered: "…"`.
  - `add_resource` and `update_resource` gain `purpose: z.enum(RESOURCE_PURPOSES).optional()`; `update_project` gains `briefing_mode: z.enum(BRIEFING_MODES).optional()`, sent as `briefingMode`.

Behaviour:

- `inprogress ask <id> --session <sid> --question|--permission|--review "<text>"` posts with actor `session:<sid>` and `sessionId: <sid>`, prints `a7 raised on #42`. Exactly one kind flag; else exit 1 with the usage line.
- The answers line (spec 3.3): in `handleHookEvent`, for a real prompt (`input.event === 'prompt' && !input.notice`), after the decision above it: `const answers = undeliveredAnswers(ctx, sessionId)`; when any, prepend one line per ask to whatever context the prompt returns (briefing, status answer, status line or none): `Answered: a7 "<answer>"` or `Cleared: a7, no answer`; then `markAnswersDelivered(ctx, ids)`. Outside any `write()`; the mark is one UPDATE.
- The MCP tool descriptions say when to use them: raise_ask "when a session needs Aiden to answer, allow or look at something, on the step it concerns"; clear_ask "when Aiden answers in chat".

- [ ] **Step 1: Write failing tests:** the CLI parse and output; each MCP tool's call and reply (follow the existing MCP test's fake client); the answers line arrives once on the next real prompt and not on a notice prompt; `Cleared: a7, no answer`.
- [ ] **Step 2: Run; expect FAIL.**
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Smoke:** extend `test/smoke/built.test.ts` (copy the test at :156): in a scratch home, enroll a session, claim a step (`runCli(['claim', ...])` or the built CLI), ask, clear through `POST /api/asks/:id/clear`, then a prompt hook returns `Answered: a1 "..."`. Run `npm run build && npx vitest run test/smoke`.
- [ ] **Step 5: Run** `npm run typecheck && npm test`; expect PASS.
- [ ] **Step 6: Commit** `git commit -m "Asks over CLI and MCP, resource purpose, briefing mode, the answers line (#303)"` with the changed paths.

## Task S5: Usage

**Files:**
- Create: `src/server/usage.ts`; route `GET /api/projects/:ref/usage?days=7` beside the digest route
- Modify: `src/cli/commands.ts` (case `usage`)
- Test: `test/server/usage.test.ts`

**Interfaces:**
- Produces: `readUsage(ctx, ref, days): Usage` and `formatUsage(u): string`.

The table (spec 2.6), one row per day for `days` days, newest last, columns:

```
day         shown(board/project)  switches  first band      backlog  details  quick-adds  asks q/p/r  median clear  mip-orc(status)  marks
2026-10-14  3/1                   2         needs_me 2      1        4        2           1/0/1       3h            1(0)             4
```

Sources: `window.shown` (data `{ view, gapMs, marks }`), `window.view`, `window.first_action` (data `{ area, action }`), `window.backlog_open`, `window.details_open` events; quick-adds from nodes created by actor `window` (events `node.created` with actor `window`, or `nodes.created_at` joined to that event; check what `addNodes` records); asks from the asks table (raised per day by kind; median of `cleared_at - raised_at` for those cleared that day); `session.orchestrate` events (count, and how many with `data.status`); marks: the last `marks` value that day from `window.shown` or `session.orchestrate`.

- [ ] **Step 1: Write failing tests** seeding events through `write(ctx, 'window', (record) => record({...}))` and asks through D2; assert the rows and the formatted table.
- [ ] **Step 2: Run; expect FAIL.**
- [ ] **Step 3: Implement**; CLI `inprogress usage <project> [--days 7]`.
- [ ] **Step 4: Run** `npm run typecheck && npm test`; expect PASS.
- [ ] **Step 5: Commit** `git commit -m "inprogress usage: the week's counts (#303)"`.

**Server branch done when:** typecheck, unit, smoke pass; code-reviewer (Opus) clean; merged and `npm run deploy` green; `npm run claude:install` rerun from the main checkout (allow rules). Every project still on `full`.

---

# Branch `stage1-window`

Branch from main after `stage1-data` lands. Read spec section 2 whole before W2. The look: spec 2.8 and the artboards `.superpowers/iter/2026-10-12/stage1-drafts/project/BoardWideC.dc.html`, `BoardNarrowC.dc.html`, `ProjectC.dc.html`, `ProjectWideC.dc.html` (open them in a browser; they are reference for spacing and type, the spec wins on behaviour). Each implementer gets its `INPROGRESS_E2E_PORT` from the brief.

## Task W1: Window routes

**Files:**
- Modify: `src/server/repo/projects.ts` (export `applyQueueOp` beside `setQueue` :367, reusing `parseQueue`, `liveQueue`, `storeQueue`)
- Modify: `src/server/routes/window.ts` (queue, nodes, asks clear, events)
- Modify: `src/server/schemas.ts` (`windowQueueBody`, `windowNodeBody`, `windowClearBody`, `windowEventBody`)
- Modify: `src/server/repo/events.ts` (`recordQuiet`; `listEventsSince` :26 skips `window.` types)
- Test: `test/server/window-routes.test.ts` (new, `buildApp` + `inject` as `test/server/app.test.ts:21-33`), `test/server/projects.test.ts`, `test/server/events.test.ts`

**Interfaces:**
- Produces:

```ts
// src/core/types.ts (the window imports it too)
export type QueueOp = { kind: 'move'; node: number; before: number | null } | { kind: 'remove'; node: number };
// src/server/repo/projects.ts
/** Spec 2.5: applied to the stored queue inside one write. Returns the project. */
export function applyQueueOp(ctx: Ctx, actor: string, projectId: number, op: QueueOp): Project;
/** Inserts an event row with no bus notice (the window's measurements). */
export function recordQuiet(ctx: Ctx, actor: string, e: EventInput): void;
```

Routes (all `guarded`, `ACTOR`):

- `POST /api/ui/projects/:id/queue` body `{ slug, op: QueueOp }` → `{ project }`.
- `POST /api/ui/projects/:id/nodes` body `{ slug, title: string (trim, 1..200), parent: number | null }` → `{ node }`: `addNodes(ctx, ACTOR, { parentId: parent ?? project.rootNodeId, nodes: [{ title }] })` after checking `parent` is in the project (400 otherwise).
- `POST /api/ui/asks/:id/clear` body `{ answer?: string (max 2000) }` → `{ ask }` (`clearAsk(ctx, ACTOR, id, answer)`; 404 for an unknown ask).
- `POST /api/ui/events` body `{ name: z.enum(['view','shown','first_action','backlog_open','details_open']), projectId: number | null, data: z.record(z.union([z.string(), z.number(), z.boolean(), z.null()])).optional() }` → 204. Stores type `window.<name>` via `recordQuiet`; data keys limited to `view`, `gapMs`, `marks`, `area`, `action`, `node` (strip the rest: never content).

`applyQueueOp` (spec 2.5):

```ts
export function applyQueueOp(ctx: Ctx, actor: string, projectId: number, op: QueueOp): Project {
  return write(ctx, actor, (record) => {
    const node = ctx.db.prepare('SELECT project_id, status FROM nodes WHERE id = ?').get(op.node) as { project_id: number; status: string } | undefined;
    if (node?.project_id !== projectId) throw badRequest(`#${op.node} is not in this project`, 'Reload the window.');
    if (node.status === 'done' || node.status === 'dropped') throw badRequest('not open', `#${op.node} is ${node.status}.`);
    const row = ctx.db.prepare('SELECT queue FROM projects WHERE id = ?').get(projectId) as { queue: string };
    const stored = parseQueue(row.queue);
    const taken = stored.find((e) => e.nodeId === op.node);
    const rest = stored.filter((e) => e.nodeId !== op.node);
    let next = rest;
    if (op.kind === 'move') {
      const entry = { nodeId: op.node, sessionId: null };
      const at = op.before === null ? -1 : rest.findIndex((e) => e.nodeId === op.before && e.sessionId === null);
      next = at < 0 ? [...rest, entry] : [...rest.slice(0, at), entry, ...rest.slice(at)];
    }
    storeQueueWith(ctx, record, projectId, row.queue, next, { op: op.kind, node: op.node, ...(taken?.sessionId ? { takenFrom: taken.sessionId } : {}) });
    return getProjectById(ctx, projectId)!;
  });
}
```

`storeQueueWith` is `storeQueue` with an extra `data` merged into the event's `data` (add an optional parameter to `storeQueue` rather than a copy). Owned entries stay first because they come first in `rest` and the new entry joins the unowned part; assert that in a test.

`listEventsSince` adds `AND type NOT LIKE 'window.%'` to its SQL. `recordQuiet` is one `INSERT INTO events` with `ctx.now()`, outside `write()`, no bus.

- [ ] **Step 1: Write failing tests:** move into an empty queue; move before an unowned entry; move before an owned entry appends; move from a session's own queue records `takenFrom`; remove; a done node is refused with "not open"; a step with an open ask is allowed; the event is `project.updated` with `changes.queue` and `data.op`; a wrong slug is 409 (as rename); create under root and under a group, and a parent of another project is 400; clear with and without an answer, twice; the events route stores `window.view` and the SSE replay (`listEventsSince`) does not return it; a non-UI request is refused (copy the existing requireUi test).
- [ ] **Step 2: Run; expect FAIL.**
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** `npm run typecheck && npm test`; expect PASS.
- [ ] **Step 5: Commit** `git commit -m "Window routes: queue op, quick-add, clear ask, measurements (#303)"`.

## Task W2: Shell: view switch, removals, go-to opens Details

**Files:**
- Create: `web/src/views/view.ts`, `web/src/chrome/ViewSwitch.tsx`, `web/src/board/Board.tsx` (skeleton), `web/src/project/ProjectView.tsx` (skeleton)
- Modify: `web/src/App.tsx` (state :25-53, render :173-231, keys :150-167, go-to :103-141), `web/src/chrome/TopBar.tsx` (switch; tab count :48-55), `web/src/api.ts` (`queueOp`, `createStep`, `clearAsk`, `postEvent`)
- Delete: `web/src/canvas/` (all), `web/src/chrome/SessionRow.tsx`, `web/src/chrome/UpNext.tsx`, `web/src/chrome/chips.ts`, `web/src/folds.ts`, `web/src/useFoldOverrides.ts`; `src/core/layout.ts` if nothing else imports it (`grep -rn "core/layout" src web`; `briefing.ts` imports `formatUpNext`, `queueView`: if it still does, keep layout.ts and delete only what is unused); unit tests `test/web/{breadcrumb,chips,folds,followThrottle,pitch,sheet}.test.ts`; styles.css canvas region :259-431 and `.ip-sessions`, `.ip-chips`, `.ip-follow`, `.ip-upnext`
- Test: `test/web/view.test.ts`, `test/e2e/ui.spec.ts`

**Interfaces:**

```ts
// web/src/views/view.ts
export type View = 'board' | 'project';
export function loadView(): View;              // storage key 'ip.view', default 'board'
export function saveView(v: View): void;
// web/src/api.ts (all through sendUi, never reject; return 'ok' or an error string)
export function queueOp(projectId: number, slug: string, op: QueueOp): Promise<UiResult>;
export function createStep(projectId: number, slug: string, title: string, parent: number | null): Promise<UiResult>;
export function clearAsk(askId: number, answer?: string): Promise<UiResult>;
export function postEvent(name: WindowEventName, projectId: number | null, data?: Record<string, string | number | boolean | null>): void; // fire and forget
// Board and ProjectView props
export interface ViewProps { snapshot: ProjectSnapshot; now: number; onOpenNode: (id: number) => void; onOpenResource: (id: number) => void; onOpenProject?: () => void }
```

Check `api.ts:55-71` for `sendUi`'s result type name and reuse it as `UiResult`. `QueueOp` is imported from `src/core` (move the type from `projects.ts` to `src/core/types.ts` in W1 if the web cannot import server code; it cannot: put it in `types.ts` from the start).

- The view switch: two buttons "Board" and "Project" in the top bar, `aria-pressed` on the current one; a click saves the view and posts `window.view`.
- `main.ip-main` renders `<Board>` or `<ProjectView>` (skeletons in this task: a heading per column or section and one button per row with the step title, enough for the e2e row-click test), and `<Details>` in place when `selectedNode !== null` (unchanged).
- Go-to (`App.tsx:108-111, 137-141`) sets `selectedNode` instead of `canvas.current.goTo(id)`.
- Remove `follow`, `needsYou` memo, the f, n, Home, End keys and their handlers; keep `[ ]`, 1 to 9, Escape, `/`, Ctrl+K. The document title's needs-you count reads `snapshot.asks` open count plus live permission sessions.
- Tab count: `openAsks + permissionWaits` (`ProjectSummary`, D2).
- e2e: delete the tests that drive removed UI (the facts file lists them: `test/e2e/ui.spec.ts` :170, :181, :195, :207, :277, :326, :365, :381, :411, :420, :441, :456, :540, :584, :597, :611, :622, :633, :646, :658, :682, :703, :1070, :1735's Up next part, :1829, :2039 to :2699 except :2608, :2920, :2953, :3068's Follow part, :3114 to :3255). Line numbers are from d441d87: find each by its title. Note in the report which behaviours they carried that W3 picks up (permission ring :1829, subagent chips :2456 and :2481, busy words :3114 and :3255, go-to opens Details :2920, row click opens Details :207). Add: "the view switch is remembered" (switch to Project, reload, Project shows) and "go-to opens the step's Details".

- [ ] **Step 1:** Write `test/web/view.test.ts` (default board; save and load; a junk stored value reads board) and the two e2e tests; run them, expect FAIL.
- [ ] **Step 2:** Implement the switch, the skeletons, go-to, the api functions, the tab count.
- [ ] **Step 3:** Delete the removed code, tests and CSS; `npm run typecheck` until clean.
- [ ] **Step 4:** Run `npm run typecheck && npm test && npm run build && npx playwright test` with `INPROGRESS_E2E_PORT` set; expect PASS.
- [ ] **Step 5:** Commit `git commit -m "Window shell: Board | Project switch; canvas, session row, Up next and Follow removed (#303)"`.

## Task W3: Board: header lines, Needs me, Now, Done, both widths

**Files:**
- Create: `web/src/board/{Board.tsx,HeaderLines.tsx,NeedsMe.tsx,NowColumn.tsx,DoneColumn.tsx,Marks.tsx,lastLook.ts,useWide.ts}`
- Modify: `web/src/styles.css` (a "board" region where the canvas region was)
- Test: `test/web/lastLook.test.ts`, `test/web/board-header.test.ts`, e2e in `test/e2e/ui.spec.ts`

**Interfaces:**

```ts
// lastLook.ts
/** The last time Aiden left this project's tab, blurred or hid the window (spec 1.7). Null when never. */
export function loadLastLook(projectId: number): string | null;    // key `ip.look.<projectId>`
export function saveLastLook(projectId: number, iso: string): void;
/** Installs the leave listeners (tab change, window blur, visibilitychange hidden) for the current project. */
export function useLastLook(projectId: number | null): string | null; // the time the divider sits at until the next leave
// useWide.ts
export function useWide(): boolean;                                   // matchMedia('(min-width: 960px)')
// HeaderLines: pure helper for the session lines, unit-tested
export function headerSessions(board: Board, sessions: Session[]): Session[]; // orchestrator live; working with no claimed step (focus null or on no row); never idle workers with no step
```

Behaviour: spec 2.2, 2.3, 2.8, rows and words exactly as written there. The pieces:

- Header: the state note as a message from the Orchestrator ("Orchestrator · 2h", the first sentence of `snapshot.stateNote.content`, "Project view ›" which calls `onOpenProject`), or "No state note yet"; `headerSessions` beside it (wide) or under it (narrow) headed "No claimed step"; the hygiene count at the right, `title` naming `board.marked` (`#53 no_outcome · #173 ended_open`).
- Needs me: live permission waits first (sessions with `state === 'permission'`: character with the amber ring, "D is waiting · ⚿ permission · 2m · LIVE", the newest running command's tool and `commandHead` on a code line, "on #id title"); then open asks oldest first ("B asks · ◎ review · 3h", a dashed avatar and "migrated" when `sessionId` is null, text clamped to two lines, "on #id title", Answer… and Clear). Answer… opens a one-line field in the row (focus moves into it; Enter sends `clearAsk(id, text)`; Escape closes it and returns focus to the Answer… button); Clear sends `clearAsk(id)`. Empty: "Nothing needs you" on one line.
- Now: `board.now`, each a message per session (character, letter, state word, its in-progress working task as the main line, running subagent chips with elapsed time at the right; reuse `web/src/live.ts` words and `Character.tsx`), then the step quoted under them ("on #id title", label chip, crumb, `▤ n`, marks: amber ask mark, "you", the handoff chip "handoff · 2d" that opens the resource viewer, hygiene marks as a grey system line "B ended 3h ago without closing"). A Now step with no session reads "No session · YOU · Your step: nobody is on it".
- Done: the five newest `board.done` rows (dropped never appear): ages in a left column, ✓ dots on a vertical rule, title, label, outcome clamped to two lines, marks (`no_outcome`, `done_focus`, amber for an open review ask), and "New since you looked" across the rule at the last look.
- Narrow (below 960 px): stacked bands Needs me, Now, Next, Done (one constant `NARROW_ORDER`), header on top, Now and Next rows drop the crumb, Done folds the rows completed before the last look to one line ("✓ 3 earlier").
- A click on any row (not on its buttons) opens Details in place (`onOpenNode`), and posts `window.first_action` when it is the first click after a gap (W6 wires the gap; here call `noteAction(area, action)` from `web/src/measure.ts`, created in W6; create the module now with a no-op `noteAction` export so W6 fills it).

e2e (one per visible feature): the wide columns show a seeded ask, a Now session with its step, a Done row with its outcome; the narrow bands at 800 px in the order Needs me, Now, Next, Done; a permission wait row (seed a session in state permission through the hook route the existing e2e uses for :1829's ring); Clear on an ask with an answer (Answer…, type, Enter: the row leaves and Details shows the answer); a row click opens Details; the "new since you looked" divider (set `ip.look.<id>` in local storage before load to a time between two done steps). Seed asks with the bearer `POST /api/nodes/:id/asks` (D2) through the `write` fixture (`test/e2e/ui.spec.ts:23`).

- [ ] **Step 1:** Unit tests for `lastLook` (load/save/junk) and `headerSessions` (orchestrator live shows; idle worker with no step does not; working with focus on a group shows). Run, expect FAIL.
- [ ] **Step 2:** Implement the components and CSS against the artboards.
- [ ] **Step 3:** e2e tests above; run with the port; expect PASS.
- [ ] **Step 4:** Commit `git commit -m "Board: header, Needs me, Now, Done, wide and narrow (#303)"`.

## Task W4: Next and Backlog: rail, drag, hover buttons, quick-add

**Files:**
- Create: `web/src/board/{NextColumn.tsx,Backlog.tsx,QuickAdd.tsx,dragQueue.ts}`
- Test: `test/web/dragQueue.test.ts`, e2e

**Interfaces:**

```ts
// dragQueue.ts: what a drop means, as a queue op (pure)
export type DropTarget = { zone: 'next'; before: number | null } | { zone: 'backlog' };
export function dropToOp(nodeId: number, target: DropTarget): QueueOp;
/** The Next order the window shows at once, before the server's event: the op applied to the rows. */
export function optimisticNext(rows: BoardRow[], op: QueueOp): number[];
```

Behaviour (spec 2.2, 2.5, 2.8): the rail with large numerals for unowned entries and the session letter for own-queue entries under "<letter>'s own queue"; "not ready" and "you" on the row; hover shows "back to Backlog" (Next rows) and "to Next" (Backlog rows), both as real buttons reachable by Tab; drag within Next, Backlog into Next, Next back to Backlog (native HTML5 drag and drop: `draggable`, `onDragStart` sets the node id, drop zones between rows); Now, Done and Needs me are not drop targets. The rail's foot reads "Backlog · n ▸" and "+ add"; open, Backlog groups its rows by parent (the parent's title as a group line) and ends with the quick-add field (Enter creates under the root via `createStep(..., null)` and keeps the field open and focused; Escape closes it). Opening Backlog posts `window.backlog_open`. After a write, the window shows `optimisticNext` until the next snapshot; an error string shows in the existing toast.

- [ ] **Step 1:** Unit tests for `dropToOp` and `optimisticNext`. Run, expect FAIL.
- [ ] **Step 2:** Implement.
- [ ] **Step 3:** e2e: a drag from Backlog into Next writes the queue (after reload the step is ①); "to Next" on a Backlog row writes the queue; the Backlog fold opens and quick-add creates a step that shows in Backlog. Playwright's `dragTo` works with HTML5 drag; if it does not on this build, dispatch `dragstart`/`drop` events as Playwright's docs show.
- [ ] **Step 4:** Commit `git commit -m "Board: Next rail, Backlog fold, drag, quick-add (#303)"`.

## Task W5: Project view

**Files:**
- Create: `web/src/project/{ProjectView.tsx,Section.tsx,projectOutline.ts,projectFolds.ts}`
- Test: `test/web/projectOutline.test.ts`, `test/web/projectFolds.test.ts`, e2e

**Interfaces:**

```ts
// projectOutline.ts (pure)
export interface Section {
  /** The group node; null for "Top level". */
  group: TreeNode | null;
  title: string;
  done: number; total: number;            // steps below it (all depths)
  counts: { now: number; next: number; backlog: number; done: number };
  docs: ResourceMeta[];                    // resources on the group and every node below it
  lines: OutlineLine[];                    // open steps, indented
  startsOpen: boolean;                     // a step in Now or Next, or an open ask
  allDone: boolean;
}
export type OutlineLine =
  | { kind: 'step'; row: BoardRow | null; node: TreeNode; depth: number }       // row null for a group line
  | { kind: 'done'; parentId: number; count: number; latest: TreeNode; depth: number };
export function projectSections(snapshot: ProjectSnapshot, board: Board): Section[]; // top-level groups in tree order, then "Top level", fully done groups last
// projectFolds.ts
export function loadFolds(projectId: number): Record<string, boolean>;  // key `ip.folds.<projectId>` (the old key: old values are ignored when not 'section:<id>' or 'done:<id>')
export function saveFolds(projectId: number, folds: Record<string, boolean>): void;
```

Behaviour: spec 2.4 and 2.8's Project view paragraph. Sections are the root's children with children; childless children of the root gather in "Top level"; a section header carries the segmented bar (done, now, next, backlog) with its legend, the progress count and `▤ n` (opens a list of its resources, each opening the resource viewer); folded sections show only header and bar; the outline's left rail: filled orange dot for Now with a session, grey dot for Now without one, the queue number for Next, the session letter for an own-queue entry, a hollow ring for Backlog; session letters at the right; done children fold per parent to "✓ 22 done · latest: #227 Title 2d" (a click opens them); "+ Add a step" at a section's foot creates in that group (`createStep(..., group.id)`); "Done groups · n" last. At 960 px and up, the left column (project name, state note, a key to the rail, Done groups) and the Label, Marks, Sessions and Docs columns. Narrow: the same outline with less indent.

- [ ] **Step 1:** Unit tests for `projectSections` (sections and "Top level"; counts; startsOpen; done folding per parent; fully done groups last) and folds. Run, expect FAIL.
- [ ] **Step 2:** Implement.
- [ ] **Step 3:** e2e: Project view sections and folds (a folded section opens on a click and stays open after reload); quick-add in a section.
- [ ] **Step 4:** Commit `git commit -m "Project view: sections, outline, folds, quick-add (#303)"`.

## Task W6: Details additions and the week's measurements

**Files:**
- Modify: `web/src/panels/Details.tsx` (asks, handoff chip, marks, "Add a step under this one"; drop the isNeedsYou uses :254, :279)
- Create/fill: `web/src/measure.ts`
- Test: `test/web/measure.test.ts`, e2e

**Interfaces:**

```ts
// measure.ts
/** Call on window show or focus: posts window.shown when the last one was an hour or more ago, with the gap and mark count. */
export function noteShown(projectId: number | null, view: View, marks: number, now?: number): void;
/** The first click after a gap posts window.first_action once. */
export function noteAction(area: 'needs_me' | 'now' | 'next' | 'backlog' | 'done' | 'header' | 'project', action: string): void;
export const GAP_MS = 60 * 60 * 1000;
```

Details (spec 2.7): under the meta, "Asks": open ones (kind glyph, text, who raised, age, Answer… and Clear as on the Board), then cleared ones with answers (`a5 ◎ "text" · answered "yes" · 2d`); the handoff chip; the step's marks; at the foot "Add a step under this one" (a one-line field; Enter creates under this node with `createStep(..., nodeId)`). Opening Details posts `window.details_open` with the node. App wires `noteShown` to `focus` and `visibilitychange` (visible).

- [ ] **Step 1:** Unit tests for `measure.ts` with a fake clock and a stub `postEvent`: no post within an hour; a post after; `first_action` once per gap. Run, expect FAIL.
- [ ] **Step 2:** Implement.
- [ ] **Step 3:** e2e: a row click opens Details, which shows the step's asks and handoff (seed a handoff with the bearer `POST /api/resources` and `purpose: 'handoff'`, which D2 accepts); "Add a step under this one" creates a child.
- [ ] **Step 4:** Run the whole gate: `npm run typecheck && npm test && npm run build && npx playwright test`.
- [ ] **Step 5:** Commit `git commit -m "Details: asks, handoff, marks, add a step; window measurements (#303)"`.

**Window branch done when:** gates pass; code-reviewer (Opus) clean; the screen-reviewer has driven every state the branch adds (both widths, Answer… open and closed, Backlog open, a drag, quick-add, Project view folds, Details with asks, focus after each close) and listed any it could not reach; merged; `npm run deploy` green.

---

# Branch `stage1-skill-docs`

Branch from main after server and window land.

## Task K1: The `mip-orc` skill

**Files:**
- Create: `claude/skills/mip-orc/SKILL.md`
- Modify: `src/cli/claude-config.ts:249-318` (copy every file in `claude/skills/mip-orc/` through `renderTemplate` as it does for `claude/skills/inprogress/`; `kitStatus` :265-280 compares it and reports `'skill'`, or a new `'mip-orc'` entry, when it differs)
- Test: `test/cli/claude-config.test.ts` (install writes the skill; the kit check reports a changed copy; uninstall removes it)

The skill text (frontmatter `name: mip-orc`, a description that triggers on "/mip-orc", "mip-orc status", "orchestrate", "what's next across the project") follows spec section 4 step by step, and adds from the tooling gaps:

- On open, before anything: if the session is not on Opus 5.5, say so in one line and ask Aiden to pick it in the model menu (gap 10).
- Step 1 runs `node <cli> orchestrate --session <sid>` (with `--status` for "mip-orc status") and shows its counts line as the offer: digest, reconcile, what's next.
- Digest: `node <cli> digest <slug>`; never repeat an ask the last digest showed.
- Reconcile: from the marks in the orchestrate output; mechanical fixes (stale focus, an empty outcome it can fill from the step's log, a step left active) go to the scribe in one batch after Aiden's yes; judgment calls (dropping a stale ask, closing a step) are questions. Open tasks of ended sessions are listed, not cleared (stage 2).
- What's next: the top of Next with ready or not ready, one recommended step with reasons.
- Start, on Aiden's go: the handoff (opens "Claim #id"; goal, where things are, decisions, what to read as slices, next concrete step; for a branch in flight, the worktree to work in and "leave the fresh worktree empty", gap 11), attached through the scribe as "handoff on #id: ..."; the chip with `spawn_task` whose prompt names the model and effort to pick (gap 10); where `spawn_task` is missing, the handoff path and a one-line prompt. A step that is not ready needs Aiden's reason, logged on the step.
- State note after a full digest: "state on #<root>: ..." through the scribe (`purpose = 'state'`), one paragraph of where the project is, one line per top-level group, what waits on Aiden.
- Never edits code, commits, builds or dispatches implementers; never claims a step; queue edits go through the scribe after re-reading the queue.

- [ ] **Step 1:** Failing install test; **Step 2:** write the skill and the install change; **Step 3:** `npm run typecheck && npm test`; **Step 4:** run the skill text through the humanizer (CLAUDE.md gate: outward-facing text); **Step 5:** commit `git commit -m "mip-orc: the Orchestrator skill, installed with the kit (#303)"`.

## Task K2: Scribe and skill texts, the guide, D5 and D6

**Files:**
- Modify: `claude/agents/inprogress-scribe.md` (ask lines: "ask on #id: <kind>, <text>" → `raise_ask`; "a7 answered: <answer>" → `clear_ask`; "handoff on #id: ..." → `add_resource` with `purpose: 'handoff'`; "state on #<root>: ..." → `purpose: 'state'`; "briefing mode <slug>: scoped|full" → `update_project` with `briefing_mode`; no new question nodes; `assignee: "me"` only for a step Aiden does himself; in a scoped project, a "focus → #id" still works)
- Modify: `claude/skills/inprogress/*` (the brief template gains the ask, handoff and state lines; the needs-you wording goes)
- Modify: the user guide (`grep -rln "needs you\|Needs you" docs/` for the guide file): Board, Project view, asks, claim, scoped briefings, `mip-orc`
- Modify: `docs/superpowers/specs/2026-09-27-inprogress-design.md` (D5 and D6 with the new wording, spec section 5, verbatim) and `docs/superpowers/specs/2026-10-05-quiet-restyle-design.md` (Non-goals: "No dashboard" reopened by the stage 1 spec)
- Test: `test/cli/claude-config.test.ts` still passes (the kit renders); `test/repo/no-em-dash.test.ts`

- [ ] **Step 1:** Edit the texts. **Step 2:** humanizer pass on the guide and skill texts. **Step 3:** `npm run typecheck && npm test`. **Step 4:** commit `git commit -m "Scribe, skill and guide for asks, claims, handoffs, state notes; D5 and D6 (#303)"`.

**Skill-docs branch done when:** gates pass; code-reviewer (Opus) clean; merged; `npm run deploy` green; `npm run claude:install` from the main checkout.

---

# Rollout (spec 6.3), after skill-docs lands

1. Back up the database (`inprogress` backup command or copy `~/.inprogress/inprogress.db` with its WAL); deploy from the main checkout; `npm run claude:install`.
2. Brief the scribe: "briefing mode inprogress: scoped", "briefing mode inthink: scoped". #311 adopts InGame, set to `scoped`, before the week starts (waits on Aiden: confirm `C:/personal/InGame`).
3. Restart open sessions: briefings change only for new ones.
4. Open `mip-orc` once to write the first state note. The week starts there.

Rollback: revert the window merge and redeploy; set the switch back to `full`. The migration only adds.
