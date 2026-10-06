# InProgress Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build InProgress: a local web app beside Claude Code that shows each project as a live outline-flow tree, kept current by a background `inprogress-scribe` subagent, with hooks reporting session presence.

**Architecture:** One Node server (Fastify + better-sqlite3) on 127.0.0.1:4317 is the single writer. It serves a JSON API, an SSE event stream, and a React + React Flow UI. Claude writes only through a scribe subagent whose MCP server (stdio) calls the HTTP API. Hook scripts post session events over HTTP and inject a briefing into tracked sessions.

**Tech Stack:** Node 20.19, TypeScript, Fastify 5, better-sqlite3 11, zod 3, @modelcontextprotocol/sdk 1.x, tsup, React 18, @xyflow/react 12, marked + DOMPurify, Vite 6, vitest 2, Playwright (system Edge via `channel: 'msedge'`).

**Spec:** `docs/superpowers/specs/2026-09-27-inprogress-design.md` (read it before starting any task).

## Global Constraints

- Node `>=20.19` (installed v20.19.6). `node:sqlite` is unavailable: use better-sqlite3.
- Windows 11 is the primary platform. Paths written into generated config use forward slashes.
- The server listens on `127.0.0.1` only. Default port `4317`, override `INPROGRESS_PORT`. Data dir `%USERPROFILE%\.inprogress`, override `INPROGRESS_HOME`. Claude config dir `~/.claude`, override `INPROGRESS_CLAUDE_DIR`.
- Tests never touch the real `~/.inprogress` or `~/.claude`: always use temp dirs via the env overrides above.
- Every mutation runs inside `write()` (Task 3), which records an `events` row in the same transaction. Never call `write()` inside another `write()`.
- Limits: node title ≤ 200 chars, body ≤ 20,000, outcome ≤ 2,000, log text ≤ 2,000, resource content ≤ 1,000,000, `snapshot_file` ≤ 200 KB, project name ≤ 120, playbook ≤ 10,000.
- Hooks run in exec form (`command: <absolute node.exe path recorded at install>`, `args: [<repo>/dist/hooks/hook.js, <hook-name>]`), always exit 0, never write to stderr, and abort their HTTP call after 500 ms (session-start: 3 s including a server spawn).
- Only tracked sessions are stored. Untracked sessions leave no rows.
- The UI never mutates data. Its only POST is `/api/ui/open` (UI token, resource id).
- Commit after every task. Every commit message ends with a blank line and `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.
- Shell commands below are Git Bash syntax, run from the repo root `C:/personal/InProgress`.
- `claude:install` / `claude:uninstall` are CLI subcommands (`node dist/cli/main.js claude-install`) wrapped by npm scripts.

## File Structure

```
package.json · tsconfig.json · tsup.config.ts · vitest.config.ts · vitest.smoke.config.ts · playwright.config.ts
scripts/dev.mjs                      dev loop: tsup watch + server on 4318 + Vite
src/core/                            pure TS shared by server and web (no Node APIs)
  types.ts                           enums, row types, snapshot/detail shapes
  tree.ts                            index, derived stats, fold rules, outline text
  layout.ts                          outline-flow layout, frontier, event targets
src/lib/                             Node-only helpers shared by server, MCP, hooks, CLI
  paths.ts glob.ts git.ts transcript.ts home.ts log.ts version.ts client.ts ensure-server.ts
src/server/
  errors.ts schemas.ts app.ts main.ts backup.ts briefing.ts session-flow.ts util.ts
  db/schema.ts db/connection.ts db/tx.ts
  repo/projects.ts repo/nodes.ts repo/resources.ts repo/logs.ts repo/search.ts repo/events.ts repo/sessions.ts repo/snapshot.ts
  routes/read.ts routes/write.ts routes/sessions.ts routes/sse.ts routes/ui.ts
src/mcp/server.ts format.ts main.ts  scribe-only MCP tools
src/hooks/handlers.ts main.ts        hook logic + entry (dist/hooks/hook.js)
src/cli/main.ts commands.ts doctor.ts open.ts claude-config.ts
claude/agents/inprogress-scribe.md   template ({{REPO}})
claude/skills/inprogress/SKILL.md    template ({{REPO}})
web/index.html web/vite.config.ts web/tsconfig.json
web/src/main.tsx App.tsx api.ts storage.ts useInProgress.ts useFoldOverrides.ts useKeyboard.ts describe.ts time.ts styles.css
web/src/chrome/TopBar.tsx SessionRow.tsx ActivityStrip.tsx
web/src/canvas/Canvas.tsx NodeCard.tsx MoreNode.tsx BadgeNode.tsx useCamera.ts breadcrumb.ts
web/src/panels/Details.tsx ResourceViewer.tsx Markdown.tsx
test/helpers.ts test/lib/* test/core/* test/server/* test/mcp/* test/hooks/* test/cli/* test/web/*
test/smoke/built.test.ts             runs against dist/ (npm run test:smoke)
test/e2e/start-server.mjs test/e2e/ui.spec.ts
```

---

### Task 1: Scaffold, path normalization, glob matching

**Files:**
- Create: `package.json`, `tsconfig.json`, `vitest.config.ts`, `vitest.smoke.config.ts`, `src/lib/paths.ts`, `src/lib/glob.ts`, `src/lib/version.ts`
- Modify: `.gitignore`
- Test: `test/lib/paths.test.ts`, `test/lib/glob.test.ts`

**Interfaces:**
- Produces: `normalizePath(input: string): string`, `isUnder(child: string, parent: string): boolean` (paths.ts); `globMatch(pattern: string, value: string): boolean` (glob.ts); `VERSION: string` (version.ts).

- [ ] **Step 1: Create `package.json`**

```json
{
  "name": "inprogress",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "description": "Live task tree beside Claude Code, kept current by Claude",
  "bin": { "inprogress": "dist/cli/main.js" },
  "engines": { "node": ">=20.19" },
  "scripts": {
    "build": "npm run build:node && npm run build:web",
    "build:node": "tsup",
    "build:web": "vite build --config web/vite.config.ts",
    "dev": "node scripts/dev.mjs",
    "typecheck": "tsc -p tsconfig.json && tsc -p web/tsconfig.json",
    "test": "vitest run",
    "test:smoke": "npm run build:node && vitest run --config vitest.smoke.config.ts",
    "test:e2e": "npm run build && playwright test",
    "claude:install": "node dist/cli/main.js claude-install",
    "claude:uninstall": "node dist/cli/main.js claude-uninstall"
  }
}
```

- [ ] **Step 2: Install dependencies**

Run:
```bash
npm install fastify@^5 @fastify/static@^8 better-sqlite3@^11 zod@^3.25 @modelcontextprotocol/sdk@^1
npm install -D typescript@^5.6 tsup@^8 vitest@^2 @types/node@^20 @types/better-sqlite3 @playwright/test@^1.48 vite@^6 @vitejs/plugin-react@^4 react@^18 react-dom@^18 @types/react@^18 @types/react-dom@^18 @xyflow/react@^12 marked@^14 dompurify@^3
```
Expected: both succeed; `node -e "require('better-sqlite3')(':memory:')"` prints nothing and exits 0. If npm reports a zod peer conflict with the MCP SDK, install the zod major the SDK declares and use its v3-compatible API. Do not run `npx playwright install`: the e2e tests use the system Edge.

- [ ] **Step 3: Create `tsconfig.json`, `vitest.config.ts`, `vitest.smoke.config.ts`, update `.gitignore`**

`tsconfig.json`:
```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ESNext",
    "moduleResolution": "Bundler",
    "lib": ["ES2022"],
    "types": ["node"],
    "strict": true,
    "noEmit": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "resolveJsonModule": true,
    "isolatedModules": true,
    "forceConsistentCasingInFileNames": true
  },
  "include": ["src", "test", "*.config.ts", "web/vite.config.ts"]
}
```

`vitest.config.ts`:
```ts
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    exclude: ['test/smoke/**', 'test/e2e/**', 'node_modules/**'],
    environment: 'node',
    pool: 'forks',
    testTimeout: 20_000,
    hookTimeout: 30_000,
    // Keep every test out of the real ~/.inprogress and ~/.claude.
    env: { INPROGRESS_HOME: '.test-home', INPROGRESS_CLAUDE_DIR: '.test-claude' },
  },
});
```

`vitest.smoke.config.ts`:
```ts
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/smoke/**/*.test.ts'],
    environment: 'node',
    pool: 'forks',
    fileParallelism: false,
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
});
```

Append to `.gitignore`:
```
.dev-home/
.e2e-home/
.test-home/
.test-claude/
.live-check/
```

- [ ] **Step 4: Write the failing tests**

`test/lib/paths.test.ts`:
```ts
import { describe, expect, it } from 'vitest';
import { isUnder, normalizePath } from '../../src/lib/paths';

describe('normalizePath', () => {
  it('converts backslashes and strips the trailing slash', () => {
    expect(normalizePath('C:\\personal\\InGame\\')).toBe('C:/personal/InGame');
  });
  it('converts Git Bash drive paths', () => {
    expect(normalizePath('/c/personal/InGame')).toBe('C:/personal/InGame');
    expect(normalizePath('/c')).toBe('C:/');
  });
  it('upper-cases the drive letter and keeps drive roots', () => {
    expect(normalizePath('c:/x/')).toBe('C:/x');
    expect(normalizePath('C:\\')).toBe('C:/');
  });
  it('leaves posix paths alone apart from the trailing slash', () => {
    expect(normalizePath('/home/aiden/')).toBe('/home/aiden');
  });
});

describe('isUnder', () => {
  it('matches the folder itself and anything below it, case-insensitively', () => {
    expect(isUnder('C:/personal/InGame', 'C:/personal/InGame')).toBe(true);
    expect(isUnder('C:\\personal\\InGame\\docs', 'c:/personal/ingame')).toBe(true);
  });
  it('does not match sibling folders sharing a prefix', () => {
    expect(isUnder('C:/personal/InGameX', 'C:/personal/InGame')).toBe(false);
  });
});
```

`test/lib/glob.test.ts`:
```ts
import { describe, expect, it } from 'vitest';
import { globMatch } from '../../src/lib/glob';

describe('globMatch', () => {
  it('matches * anywhere, case-insensitively', () => {
    expect(globMatch('*VCAD-978*', 'feature/VCAD-978-fix')).toBe(true);
    expect(globMatch('*vcad-978*', 'feature/VCAD-978')).toBe(true);
    expect(globMatch('release/*', 'release/1.2')).toBe(true);
  });
  it('anchors the whole value', () => {
    expect(globMatch('main', 'main2')).toBe(false);
  });
  it('treats regex characters literally and ? as one character', () => {
    expect(globMatch('v1.2', 'v1x2')).toBe(false);
    expect(globMatch('v?.2', 'v1.2')).toBe(true);
  });
});
```

- [ ] **Step 5: Run tests to verify they fail**

Run: `npx vitest run test/lib`
Expected: FAIL, cannot resolve `../../src/lib/paths` and `../../src/lib/glob`.

- [ ] **Step 6: Implement**

`src/lib/paths.ts`:
```ts
/**
 * Normalize a filesystem path for storage and comparison: forward slashes,
 * Git Bash `/c/x` converted to `C:/x`, upper-case drive letter, no trailing slash.
 * Windows-first: a POSIX path whose first segment is one letter (`/x/data`) is read as a drive.
 */
export function normalizePath(input: string): string {
  let p = input.trim().replace(/\\/g, '/');
  const gitBash = /^\/([a-zA-Z])(\/.*)?$/.exec(p);
  if (gitBash) p = `${gitBash[1]}:${gitBash[2] ?? '/'}`;
  p = p.replace(/^([a-z]):/, (_m, drive: string) => `${drive.toUpperCase()}:`);
  while (p.length > 1 && p.endsWith('/') && !/^[A-Za-z]:\/$/.test(p)) p = p.slice(0, -1);
  return p;
}

/** True when `child` is `parent` or inside it. Case-insensitive (Windows). */
export function isUnder(child: string, parent: string): boolean {
  const c = normalizePath(child).toLowerCase();
  const p = normalizePath(parent).toLowerCase();
  if (c === p) return true;
  return c.startsWith(p.endsWith('/') ? p : `${p}/`);
}
```

`src/lib/glob.ts`:
```ts
const escapeRe = (s: string) => s.replace(/[.+^${}()|[\]\\]/g, '\\$&');

/** Case-insensitive glob over a whole string: `*` = any run of characters, `?` = one character. */
export function globMatch(pattern: string, value: string): boolean {
  const source = pattern
    .split('*')
    .map((part) => part.split('?').map(escapeRe).join('.'))
    .join('.*');
  return new RegExp(`^${source}$`, 'i').test(value);
}
```

`src/lib/version.ts`:
```ts
export const VERSION = '0.1.0';
```

- [ ] **Step 7: Run tests to verify they pass**

Run: `npx vitest run test/lib`
Expected: PASS (2 files, 9 tests).

- [ ] **Step 8: Commit**

```bash
git add package.json package-lock.json tsconfig.json vitest.config.ts vitest.smoke.config.ts .gitignore src/lib test/lib
git commit -m "Scaffold InProgress with path and glob helpers

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 2: Branch detection, transcript titles, data dir and token, log helper

**Files:**
- Create: `src/lib/git.ts`, `src/lib/transcript.ts`, `src/lib/home.ts`, `src/lib/log.ts`
- Test: `test/lib/git.test.ts`, `test/lib/transcript.test.ts`, `test/lib/home.test.ts`

**Interfaces:**
- Produces:
  - `detectBranch(cwd: string, ceiling?: string): string | undefined`
  - `readTranscriptTitle(file: string, maxBytes?: number): string | undefined`
  - `homeDir(): string`, `port(): number`, `baseUrl(p?: number): string`, `tokenPath(home?: string): string`, `readToken(home?: string): string | undefined`, `ensureToken(home?: string): string`
  - `appendLog(file: string, message: string): void`

- [ ] **Step 1: Write the failing tests**

`test/lib/git.test.ts`:
```ts
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { detectBranch } from '../../src/lib/git';

function repo(head: string): string {
  const root = mkdtempSync(join(tmpdir(), 'ip-git-'));
  mkdirSync(join(root, '.git'));
  writeFileSync(join(root, '.git', 'HEAD'), head);
  return root;
}

describe('detectBranch', () => {
  it('reads the branch from a parent folder', () => {
    const root = repo('ref: refs/heads/feature/VCAD-978-fix\n');
    const nested = join(root, 'src', 'deep');
    mkdirSync(nested, { recursive: true });
    expect(detectBranch(nested, root)).toBe('feature/VCAD-978-fix');
  });
  it('returns undefined for a detached HEAD', () => {
    const root = repo('3f2a9c0d1e2f3a4b5c6d7e8f9a0b1c2d3e4f5a6b\n');
    expect(detectBranch(root, root)).toBeUndefined();
  });
  it('follows a worktree .git file', () => {
    const main = repo('ref: refs/heads/main\n');
    const wtGit = join(main, '.git', 'worktrees', 'wt1');
    mkdirSync(wtGit, { recursive: true });
    writeFileSync(join(wtGit, 'HEAD'), 'ref: refs/heads/wt-branch\n');
    const wt = mkdtempSync(join(tmpdir(), 'ip-wt-'));
    writeFileSync(join(wt, '.git'), `gitdir: ${wtGit}\n`);
    expect(detectBranch(wt, wt)).toBe('wt-branch');
  });
  it('returns undefined when no repo is found below the ceiling', () => {
    const dir = mkdtempSync(join(tmpdir(), 'ip-norepo-'));
    expect(detectBranch(dir, dir)).toBeUndefined();
  });
});
```

`test/lib/transcript.test.ts`:
```ts
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { readTranscriptTitle } from '../../src/lib/transcript';

const line = (o: object) => JSON.stringify(o);

describe('readTranscriptTitle', () => {
  it('returns the last custom-title entry', () => {
    const file = join(mkdtempSync(join(tmpdir(), 'ip-tr-')), 't.jsonl');
    writeFileSync(file, [
      line({ type: 'user', message: 'hi' }),
      line({ type: 'custom-title', customTitle: 'Old name', sessionId: 's' }),
      line({ type: 'assistant', message: 'ok' }),
      line({ type: 'custom-title', customTitle: 'InGame launch status', sessionId: 's' }),
      '',
    ].join('\n'));
    expect(readTranscriptTitle(file)).toBe('InGame launch status');
  });
  it('returns undefined when there is no title or no file', () => {
    const file = join(mkdtempSync(join(tmpdir(), 'ip-tr-')), 't.jsonl');
    writeFileSync(file, `${line({ type: 'user' })}\n`);
    expect(readTranscriptTitle(file)).toBeUndefined();
    expect(readTranscriptTitle(join(tmpdir(), 'does-not-exist.jsonl'))).toBeUndefined();
  });
  it('only reads the tail window', () => {
    const file = join(mkdtempSync(join(tmpdir(), 'ip-tr-')), 't.jsonl');
    writeFileSync(file, `${line({ type: 'custom-title', customTitle: 'Early' })}\n${'x'.repeat(5000)}\n`);
    expect(readTranscriptTitle(file, 1000)).toBeUndefined();
  });
});
```

`test/lib/home.test.ts`:
```ts
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { baseUrl, ensureToken, homeDir, port, readToken } from '../../src/lib/home';

afterEach(() => {
  delete process.env.INPROGRESS_HOME;
  delete process.env.INPROGRESS_PORT;
});

describe('home', () => {
  it('honours INPROGRESS_HOME and INPROGRESS_PORT', () => {
    process.env.INPROGRESS_HOME = 'C:/tmp/ip-home';
    process.env.INPROGRESS_PORT = '4399';
    expect(homeDir()).toBe('C:/tmp/ip-home');
    expect(port()).toBe(4399);
    expect(baseUrl()).toBe('http://127.0.0.1:4399');
  });
  it('defaults the port to 4317 when unset or invalid', () => {
    expect(port()).toBe(4317);
    process.env.INPROGRESS_PORT = 'abc';
    expect(port()).toBe(4317);
  });
  it('creates the token once and then reuses it', () => {
    const home = mkdtempSync(join(tmpdir(), 'ip-home-'));
    expect(readToken(home)).toBeUndefined();
    const t = ensureToken(home);
    expect(t).toMatch(/^[0-9a-f]{64}$/);
    expect(ensureToken(home)).toBe(t);
    expect(readFileSync(join(home, 'token'), 'utf8').trim()).toBe(t);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run test/lib`
Expected: FAIL for git/transcript/home (modules not found); paths/glob still pass.

- [ ] **Step 3: Implement**

`src/lib/git.ts`:
```ts
import { existsSync, readFileSync, statSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';

/**
 * Current git branch for `cwd`, found by walking up to `.git` and reading HEAD.
 * No git process is spawned. `ceiling` stops the walk (used by tests).
 */
export function detectBranch(cwd: string, ceiling?: string): string | undefined {
  try {
    let dir = resolve(cwd);
    const stop = ceiling ? resolve(ceiling) : undefined;
    for (;;) {
      const dotGit = join(dir, '.git');
      if (existsSync(dotGit)) {
        let gitDir = dotGit;
        if (statSync(dotGit).isFile()) {
          const m = /^gitdir:\s*(.+)$/m.exec(readFileSync(dotGit, 'utf8'));
          if (!m) return undefined;
          const target = m[1].trim();
          gitDir = isAbsolute(target) ? target : resolve(dir, target);
        }
        const head = readFileSync(join(gitDir, 'HEAD'), 'utf8').trim();
        const ref = /^ref:\s*refs\/heads\/(.+)$/.exec(head);
        return ref ? ref[1] : undefined;
      }
      if (stop && dir === stop) return undefined;
      const parent = dirname(dir);
      if (parent === dir) return undefined;
      dir = parent;
    }
  } catch {
    return undefined;
  }
}
```

`src/lib/transcript.ts`:
```ts
import { closeSync, fstatSync, openSync, readSync } from 'node:fs';

const MARKER = '"type":"custom-title"';

/**
 * The Claude desktop sidebar title, read from the newest `custom-title` line in the
 * tail of a transcript JSONL file. The format is undocumented, so every failure
 * returns undefined.
 */
export function readTranscriptTitle(file: string, maxBytes = 256 * 1024): string | undefined {
  let fd: number | undefined;
  try {
    fd = openSync(file, 'r');
    const size = fstatSync(fd).size;
    const len = Math.min(size, maxBytes);
    const buf = Buffer.alloc(len);
    readSync(fd, buf, 0, len, size - len);
    const lines = buf.toString('utf8').split('\n');
    for (let i = lines.length - 1; i >= 0; i--) {
      if (!lines[i].includes(MARKER)) continue;
      try {
        const entry = JSON.parse(lines[i]) as { customTitle?: unknown };
        if (typeof entry.customTitle === 'string' && entry.customTitle.trim()) return entry.customTitle.trim();
      } catch {
        // partial first line of the window
      }
    }
    return undefined;
  } catch {
    return undefined;
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}
```

`src/lib/home.ts`:
```ts
import { randomBytes } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { isAbsolute, join, resolve } from 'node:path';

/** Data dir. A relative INPROGRESS_HOME is made absolute so child processes with another cwd agree. */
export function homeDir(): string {
  const configured = process.env.INPROGRESS_HOME;
  if (!configured) return join(homedir(), '.inprogress');
  return isAbsolute(configured) ? configured : resolve(configured);
}

export function port(): number {
  const value = Number(process.env.INPROGRESS_PORT);
  return Number.isInteger(value) && value > 0 && value < 65536 ? value : 4317;
}

export function baseUrl(p: number = port()): string {
  return `http://127.0.0.1:${p}`;
}

export function tokenPath(home: string = homeDir()): string {
  return join(home, 'token');
}

export function readToken(home: string = homeDir()): string | undefined {
  try {
    return readFileSync(tokenPath(home), 'utf8').trim() || undefined;
  } catch {
    return undefined;
  }
}

export function ensureToken(home: string = homeDir()): string {
  mkdirSync(home, { recursive: true });
  const existing = readToken(home);
  if (existing) return existing;
  const token = randomBytes(32).toString('hex');
  writeFileSync(tokenPath(home), `${token}\n`, { mode: 0o600 });
  return token;
}
```

`src/lib/log.ts`:
```ts
import { appendFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

/** Append a timestamped line. Never throws: logging must not break a hook. */
export function appendLog(file: string, message: string): void {
  try {
    mkdirSync(dirname(file), { recursive: true });
    appendFileSync(file, `${new Date().toISOString()} ${message}\n`);
  } catch {
    // ignore
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run test/lib`
Expected: PASS (5 files).

- [ ] **Step 5: Commit**

```bash
git add src/lib test/lib
git commit -m "Add branch detection, transcript titles, token and log helpers

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 3: Core types, database schema, transactional event log

**Files:**
- Create: `src/core/types.ts`, `src/server/errors.ts`, `src/server/util.ts`, `src/server/db/schema.ts`, `src/server/db/connection.ts`, `src/server/db/tx.ts`
- Create: `test/helpers.ts`
- Test: `test/server/db.test.ts`

**Interfaces:**
- Produces (types.ts): `NODE_KINDS`, `NodeKind`, `NODE_STATUSES`, `NodeStatus`, `ASSIGNEES`, `Assignee`, `RESOURCE_KINDS`, `ResourceKind`, `SESSION_STATES`, `SessionState`, `HOOK_EVENTS`, `HookEvent`, `SCRIBE_AGENT`, `STALE_SESSION_MS`, interfaces `Project`, `ProjectSummary`, `Binding`, `TreeNode`, `NodeInput`, `After`, `ResourceMeta`, `Resource`, `LogEntry`, `Session`, `SubagentInfo`, `EventRow`, `ProjectSnapshot`, `NodeDetail`, `SearchResult`, function `sessionDisplayTitle(s)`.
- Produces (server): `ApiError`, `notFound`, `badRequest`, `conflict` (errors.ts); `definedOnly(o)` (util.ts); `DB`, `openDb(file)`, `migrate(db)`, `schemaVersion(db)` (connection.ts); `EventBus`, `Ctx`, `createCtx(db, now?)`, `EventInput`, `RecordEvent`, `write(ctx, actor, fn)` (tx.ts); `makeCtx()` (test/helpers.ts).

- [ ] **Step 1: Create `src/core/types.ts`**

```ts
export const NODE_KINDS = ['goal', 'phase', 'task', 'question'] as const;
export type NodeKind = (typeof NODE_KINDS)[number];
export const NODE_STATUSES = ['todo', 'active', 'done', 'blocked', 'dropped'] as const;
export type NodeStatus = (typeof NODE_STATUSES)[number];
export const ASSIGNEES = ['claude', 'me'] as const;
export type Assignee = (typeof ASSIGNEES)[number];
export const RESOURCE_KINDS = ['doc', 'test-suite', 'runbook', 'roadmap', 'diagram', 'link', 'other'] as const;
export type ResourceKind = (typeof RESOURCE_KINDS)[number];
export const SESSION_STATES = ['working', 'idle', 'permission', 'ended'] as const;
export type SessionState = (typeof SESSION_STATES)[number];
export const HOOK_EVENTS = ['start', 'prompt', 'stop', 'permission', 'subagent-start', 'subagent-stop', 'end'] as const;
export type HookEvent = (typeof HOOK_EVENTS)[number];
export const SCRIBE_AGENT = 'inprogress-scribe';
export const STALE_SESSION_MS = 12 * 60 * 60 * 1000;

export interface Project {
  id: number;
  slug: string;
  name: string;
  description: string;
  playbook: string;
  status: 'active' | 'archived';
  rootNodeId: number;
  createdAt: string;
  updatedAt: string;
}

export interface ProjectSummary extends Project {
  needsYou: number;
  activeSessions: number;
  workingSessions: number;
  lastEventAt: string | null;
}

export interface Binding {
  id: number;
  projectId: number;
  path: string;
  branchPattern: string | null;
  createdAt: string;
}

export interface TreeNode {
  id: number;
  projectId: number;
  parentId: number | null;
  position: number;
  kind: NodeKind;
  title: string;
  body: string;
  status: NodeStatus;
  assignee: Assignee;
  outcome: string;
  createdAt: string;
  updatedAt: string;
  completedAt: string | null;
}

export interface NodeInput {
  title: string;
  kind?: NodeKind;
  status?: NodeStatus;
  assignee?: Assignee;
  body?: string;
  outcome?: string;
  children?: NodeInput[];
}

/** Insert position among siblings: after a sibling #id, at the start, or at the end. */
export type After = number | 'start' | 'end';

export interface ResourceMeta {
  id: number;
  projectId: number;
  nodeId: number;
  kind: ResourceKind;
  title: string;
  path: string | null;
  url: string | null;
  contentLength: number;
  sessionId: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface Resource extends ResourceMeta {
  content: string | null;
}

export interface LogEntry {
  id: number;
  nodeId: number;
  text: string;
  sessionId: string | null;
  createdAt: string;
  sessionTitle: string | null;
}

export interface SubagentInfo {
  agentId: string;
  agentType: string;
  startedAt: string;
}

export interface Session {
  id: string;
  projectId: number | null;
  title: string | null;
  cwd: string | null;
  branch: string | null;
  transcriptPath: string | null;
  state: SessionState;
  focusNodeId: number | null;
  promptsSinceUpdate: number;
  startedAt: string;
  lastSeenAt: string;
  endedAt: string | null;
  subagents: SubagentInfo[];
}

export interface EventRow {
  id: number;
  ts: string;
  projectId: number | null;
  actor: string;
  type: string;
  entity: string;
  entityId: string;
  data: unknown;
}

export interface ProjectSnapshot {
  project: Project;
  nodes: TreeNode[];
  resources: ResourceMeta[];
  sessions: Session[];
  lastEventId: number;
  lastEvent: EventRow | null;
}

export interface NodeDetail {
  node: TreeNode;
  parent: { id: number; title: string } | null;
  children: Pick<TreeNode, 'id' | 'title' | 'status' | 'assignee' | 'kind'>[];
  resources: ResourceMeta[];
  log: LogEntry[];
}

export interface SearchResult {
  nodes: Pick<TreeNode, 'id' | 'title' | 'status' | 'kind'>[];
  resources: Pick<ResourceMeta, 'id' | 'title' | 'kind' | 'nodeId'>[];
}

export function sessionDisplayTitle(s: Pick<Session, 'id' | 'title'>): string {
  return s.title?.trim() || `Session ${s.id.slice(0, 6)}`;
}
```

- [ ] **Step 2: Create `src/server/errors.ts` and `src/server/util.ts`**

`src/server/errors.ts`:
```ts
export class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly hint?: string,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

export const notFound = (message: string, hint?: string) => new ApiError(404, message, hint);
export const badRequest = (message: string, hint?: string) => new ApiError(400, message, hint);
export const conflict = (message: string, hint?: string) => new ApiError(409, message, hint);
```

`src/server/util.ts`:
```ts
/** Copy of `o` without keys whose value is undefined. */
export function definedOnly<T extends object>(o: T): Partial<T> {
  return Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)) as Partial<T>;
}
```

- [ ] **Step 3: Write the failing test**

`test/helpers.ts`:
```ts
import { openDb } from '../src/server/db/connection';
import { createCtx, type Ctx } from '../src/server/db/tx';

/** In-memory database with a clock that advances one second per call. */
export function makeCtx(start = '2026-09-27T12:00:00.000Z'): Ctx {
  const db = openDb(':memory:');
  let t = Date.parse(start);
  return createCtx(db, () => new Date((t += 1000)).toISOString());
}
```

`test/server/db.test.ts`:
```ts
import { describe, expect, it } from 'vitest';
import { schemaVersion } from '../../src/server/db/connection';
import { write } from '../../src/server/db/tx';
import type { EventRow } from '../../src/core/types';
import { makeCtx } from '../helpers';

describe('database', () => {
  it('migrates to the latest schema with foreign keys on', () => {
    const ctx = makeCtx();
    expect(schemaVersion(ctx.db)).toBe(1);
    const tables = (ctx.db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as { name: string }[]).map((r) => r.name);
    expect(tables).toEqual(expect.arrayContaining(['projects', 'bindings', 'nodes', 'resources', 'log_entries', 'sessions', 'session_subagents', 'events', 'meta']));
    expect(ctx.db.pragma('foreign_keys', { simple: true })).toBe(1);
  });

  it('records events inside the transaction and emits them after commit', () => {
    const ctx = makeCtx();
    const seen: EventRow[] = [];
    ctx.bus.on('event', (e: EventRow) => seen.push(e));
    const result = write(ctx, 'test', (record) => {
      record({ projectId: null, type: 'demo.done', entity: 'demo', entityId: 7, data: { a: 1 } });
      expect(seen).toHaveLength(0);
      return 42;
    });
    expect(result).toBe(42);
    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({ actor: 'test', type: 'demo.done', entityId: '7', data: { a: 1 } });
    const row = ctx.db.prepare('SELECT COUNT(*) AS c FROM events').get() as { c: number };
    expect(row.c).toBe(1);
  });

  it('rolls back events and emits nothing when the callback throws', () => {
    const ctx = makeCtx();
    const seen: EventRow[] = [];
    ctx.bus.on('event', (e: EventRow) => seen.push(e));
    expect(() =>
      write(ctx, 'test', (record) => {
        record({ projectId: null, type: 'demo', entity: 'demo', entityId: 1 });
        throw new Error('boom');
      }),
    ).toThrow('boom');
    expect(seen).toHaveLength(0);
    expect((ctx.db.prepare('SELECT COUNT(*) AS c FROM events').get() as { c: number }).c).toBe(0);
  });

  it('resets prompts_since_update for scribe writes of that session', () => {
    const ctx = makeCtx();
    ctx.db.prepare("INSERT INTO sessions (id, state, prompts_since_update, started_at, last_seen_at) VALUES ('s1', 'working', 5, 'x', 'x')").run();
    write(ctx, 'scribe:s1', () => undefined);
    expect((ctx.db.prepare("SELECT prompts_since_update AS p FROM sessions WHERE id = 's1'").get() as { p: number }).p).toBe(0);
  });
});
```

- [ ] **Step 4: Run test to verify it fails**

Run: `npx vitest run test/server/db.test.ts`
Expected: FAIL, cannot resolve `../../src/server/db/connection`.

- [ ] **Step 5: Implement the schema, connection and tx modules**

`src/server/db/schema.ts`:
```ts
/** Ordered migrations. Never edit a shipped entry: append a new one. */
export const MIGRATIONS: string[] = [
  `
  CREATE TABLE projects (
    id INTEGER PRIMARY KEY,
    slug TEXT NOT NULL UNIQUE,
    name TEXT NOT NULL,
    description TEXT NOT NULL DEFAULT '',
    playbook TEXT NOT NULL DEFAULT '',
    status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','archived')),
    root_node_id INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
  CREATE TABLE bindings (
    id INTEGER PRIMARY KEY,
    project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    path TEXT NOT NULL,
    branch_pattern TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL
  );
  CREATE UNIQUE INDEX bindings_unique ON bindings (lower(path), branch_pattern);
  CREATE TABLE nodes (
    id INTEGER PRIMARY KEY,
    project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    parent_id INTEGER REFERENCES nodes(id) ON DELETE CASCADE,
    position REAL NOT NULL,
    kind TEXT NOT NULL CHECK (kind IN ('goal','phase','task','question')),
    title TEXT NOT NULL,
    body TEXT NOT NULL DEFAULT '',
    status TEXT NOT NULL DEFAULT 'todo' CHECK (status IN ('todo','active','done','blocked','dropped')),
    assignee TEXT NOT NULL DEFAULT 'claude' CHECK (assignee IN ('claude','me')),
    outcome TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    completed_at TEXT
  );
  CREATE INDEX nodes_project ON nodes (project_id);
  CREATE INDEX nodes_parent ON nodes (parent_id, position);
  CREATE TABLE resources (
    id INTEGER PRIMARY KEY,
    project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    node_id INTEGER NOT NULL REFERENCES nodes(id) ON DELETE CASCADE,
    kind TEXT NOT NULL CHECK (kind IN ('doc','test-suite','runbook','roadmap','diagram','link','other')),
    title TEXT NOT NULL,
    content TEXT,
    path TEXT,
    url TEXT,
    session_id TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    CHECK (content IS NOT NULL OR path IS NOT NULL OR url IS NOT NULL)
  );
  CREATE INDEX resources_node ON resources (node_id);
  CREATE INDEX resources_project ON resources (project_id);
  CREATE TABLE log_entries (
    id INTEGER PRIMARY KEY,
    node_id INTEGER NOT NULL REFERENCES nodes(id) ON DELETE CASCADE,
    text TEXT NOT NULL,
    session_id TEXT,
    created_at TEXT NOT NULL
  );
  CREATE INDEX log_node ON log_entries (node_id);
  CREATE TABLE sessions (
    id TEXT PRIMARY KEY,
    project_id INTEGER REFERENCES projects(id) ON DELETE SET NULL,
    title TEXT,
    cwd TEXT,
    branch TEXT,
    transcript_path TEXT,
    state TEXT NOT NULL DEFAULT 'idle' CHECK (state IN ('working','idle','permission','ended')),
    focus_node_id INTEGER REFERENCES nodes(id) ON DELETE SET NULL,
    prompts_since_update INTEGER NOT NULL DEFAULT 0,
    started_at TEXT NOT NULL,
    last_seen_at TEXT NOT NULL,
    ended_at TEXT
  );
  CREATE INDEX sessions_project ON sessions (project_id);
  CREATE TABLE session_subagents (
    session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
    agent_id TEXT NOT NULL,
    agent_type TEXT NOT NULL,
    started_at TEXT NOT NULL,
    PRIMARY KEY (session_id, agent_id)
  );
  CREATE TABLE events (
    id INTEGER PRIMARY KEY,
    ts TEXT NOT NULL,
    project_id INTEGER,
    actor TEXT NOT NULL,
    type TEXT NOT NULL,
    entity TEXT NOT NULL,
    entity_id TEXT NOT NULL,
    data TEXT NOT NULL
  );
  CREATE INDEX events_project ON events (project_id, id);
  `,
];
```

`src/server/db/connection.ts`:
```ts
import Database from 'better-sqlite3';
import { MIGRATIONS } from './schema';

export type DB = Database.Database;

export function openDb(file: string): DB {
  const db = new Database(file);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.pragma('busy_timeout = 5000');
  migrate(db);
  return db;
}

export function schemaVersion(db: DB): number {
  const row = db.prepare("SELECT value FROM meta WHERE key = 'schema_version'").get() as { value: string } | undefined;
  return row ? Number(row.value) : 0;
}

export function migrate(db: DB): void {
  db.exec('CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)');
  for (let v = schemaVersion(db); v < MIGRATIONS.length; v++) {
    db.transaction(() => {
      db.exec(MIGRATIONS[v]);
      db.prepare(
        "INSERT INTO meta (key, value) VALUES ('schema_version', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
      ).run(String(v + 1));
    })();
  }
}
```

`src/server/db/tx.ts`:
```ts
import { EventEmitter } from 'node:events';
import type { EventRow } from '../../core/types';
import type { DB } from './connection';

export class EventBus extends EventEmitter {
  constructor() {
    super();
    this.setMaxListeners(0);
  }
}

export interface Ctx {
  db: DB;
  bus: EventBus;
  now: () => string;
}

export function createCtx(db: DB, now: () => string = () => new Date().toISOString()): Ctx {
  return { db, bus: new EventBus(), now };
}

export interface EventInput {
  projectId: number | null;
  type: string;
  entity: string;
  entityId: string | number;
  data?: unknown;
}

export type RecordEvent = (event: EventInput) => void;

/**
 * Run `fn` in one transaction. Events passed to `record` are inserted in the same
 * transaction and emitted on `ctx.bus` only after commit. A write by
 * `scribe:<sessionId>` resets that session's stale-update counter.
 * Never call write() inside another write().
 */
export function write<T>(ctx: Ctx, actor: string, fn: (record: RecordEvent) => T): T {
  const pending: EventRow[] = [];
  const insert = ctx.db.prepare(
    'INSERT INTO events (ts, project_id, actor, type, entity, entity_id, data) VALUES (?, ?, ?, ?, ?, ?, ?)',
  );
  const run = ctx.db.transaction((): T => {
    const result = fn((e) => {
      const ts = ctx.now();
      const data = e.data ?? {};
      const info = insert.run(ts, e.projectId, actor, e.type, e.entity, String(e.entityId), JSON.stringify(data));
      pending.push({ id: Number(info.lastInsertRowid), ts, projectId: e.projectId, actor, type: e.type, entity: e.entity, entityId: String(e.entityId), data });
    });
    if (actor.startsWith('scribe:')) {
      ctx.db.prepare('UPDATE sessions SET prompts_since_update = 0 WHERE id = ?').run(actor.slice('scribe:'.length));
    }
    return result;
  });
  const result = run();
  for (const event of pending) ctx.bus.emit('event', event);
  return result;
}
```

- [ ] **Step 6: Run test to verify it passes**

Run: `npx vitest run test/server/db.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 7: Commit**

```bash
git add src/core src/server test/helpers.ts test/server
git commit -m "Add core types, SQLite schema and transactional event log

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 4: Projects and folder bindings

**Files:**
- Create: `src/server/repo/projects.ts`
- Test: `test/server/projects.test.ts`

**Interfaces:**
- Consumes: `write`, `Ctx` (tx.ts); `normalizePath`, `isUnder` (paths.ts); `globMatch` (glob.ts); errors.
- Produces:
  - `slugify(name: string): string`
  - `getProjectById(ctx, id: number): Project | undefined`
  - `resolveProject(ctx, ref: string | number): Project` (throws 404 with known slugs as hint)
  - `createProject(ctx, actor, input: CreateProjectInput): Project` where `CreateProjectInput = { name; description?; playbook?; slug? }`
  - `updateProject(ctx, actor, ref, patch: UpdateProjectInput): Project` where `UpdateProjectInput = { name?; description?; playbook?; status?: 'active' | 'archived' }`
  - `listProjectSummaries(ctx): ProjectSummary[]`
  - `addBinding(ctx, actor, ref, path: string, branchPattern?: string | null): Binding`
  - `removeBinding(ctx, actor, id: number): void`
  - `listBindings(ctx): Binding[]`
  - `resolveBinding(ctx, cwd: string, branch?: string | null): Project | undefined`

- [ ] **Step 1: Write the failing test**

`test/server/projects.test.ts`:
```ts
import { describe, expect, it } from 'vitest';
import {
  addBinding, createProject, listBindings, listProjectSummaries, removeBinding,
  resolveBinding, resolveProject, slugify, updateProject,
} from '../../src/server/repo/projects';
import { makeCtx } from '../helpers';

describe('projects', () => {
  it('slugifies names', () => {
    expect(slugify('InGame: Road to Market!')).toBe('ingame-road-to-market');
    expect(slugify('***')).toBe('project');
  });

  it('creates a project with an active goal root and unique slugs', () => {
    const ctx = makeCtx();
    const a = createProject(ctx, 'test', { name: 'InGame', description: 'Game collection app' });
    const b = createProject(ctx, 'test', { name: 'InGame' });
    expect(a.slug).toBe('ingame');
    expect(b.slug).toBe('ingame-2');
    const root = ctx.db.prepare('SELECT * FROM nodes WHERE id = ?').get(a.rootNodeId) as { kind: string; title: string; body: string; status: string; parent_id: number | null };
    expect(root).toMatchObject({ kind: 'goal', title: 'InGame', body: 'Game collection app', status: 'active', parent_id: null });
    const types = (ctx.db.prepare('SELECT type FROM events ORDER BY id').all() as { type: string }[]).map((r) => r.type);
    expect(types).toEqual(['project.created', 'node.created', 'project.created', 'node.created']);
  });

  it('resolves by id, slug, or name and explains misses', () => {
    const ctx = makeCtx();
    const p = createProject(ctx, 'test', { name: 'InGame' });
    expect(resolveProject(ctx, p.id).slug).toBe('ingame');
    expect(resolveProject(ctx, String(p.id)).slug).toBe('ingame');
    expect(resolveProject(ctx, 'INGAME').id).toBe(p.id);
    expect(resolveProject(ctx, 'ingame').id).toBe(p.id);
    expect(() => resolveProject(ctx, 'nope')).toThrow('Project "nope" not found');
    try { resolveProject(ctx, 'nope'); } catch (e) { expect((e as { hint?: string }).hint).toContain('ingame'); }
  });

  it('keeps the root in sync with the name and description, and archives', () => {
    const ctx = makeCtx();
    const p = createProject(ctx, 'test', { name: 'Old' });
    const u = updateProject(ctx, 'test', p.slug, { name: 'New', description: 'Purpose', status: 'archived' });
    expect(u).toMatchObject({ name: 'New', description: 'Purpose', status: 'archived' });
    const root = ctx.db.prepare('SELECT title, body FROM nodes WHERE id = ?').get(p.rootNodeId);
    expect(root).toEqual({ title: 'New', body: 'Purpose' });
  });

  it('adds bindings idempotently and refuses to steal another project\'s folder', () => {
    const ctx = makeCtx();
    const a = createProject(ctx, 'test', { name: 'A' });
    const b = createProject(ctx, 'test', { name: 'B' });
    const first = addBinding(ctx, 'test', a.slug, 'C:\\personal\\InGame\\');
    expect(first).toMatchObject({ path: 'C:/personal/InGame', branchPattern: null });
    expect(addBinding(ctx, 'test', a.slug, '/c/personal/ingame').id).toBe(first.id);
    expect(() => addBinding(ctx, 'test', b.slug, 'C:/personal/InGame')).toThrow('already bound to project a');
    const withBranch = addBinding(ctx, 'test', b.slug, 'C:/personal/InGame', '*VCAD-978*');
    expect(withBranch.branchPattern).toBe('*VCAD-978*');
    removeBinding(ctx, 'test', first.id);
    expect(listBindings(ctx).map((x) => x.id)).toEqual([withBranch.id]);
    expect(() => removeBinding(ctx, 'test', 9999)).toThrow('Binding 9999 not found');
  });

  it('resolves the longest matching binding, preferring a branch match, skipping archived projects', () => {
    const ctx = makeCtx();
    const repo = createProject(ctx, 'test', { name: 'Repo' });
    const docs = createProject(ctx, 'test', { name: 'Docs' });
    const ticket = createProject(ctx, 'test', { name: 'Ticket' });
    addBinding(ctx, 'test', repo.slug, 'C:/work/repo');
    addBinding(ctx, 'test', docs.slug, 'C:/work/repo/docs');
    addBinding(ctx, 'test', ticket.slug, 'C:/work/repo', '*VCAD-978*');
    expect(resolveBinding(ctx, 'C:\\work\\repo\\src', 'main')?.slug).toBe('repo');
    expect(resolveBinding(ctx, 'C:/work/repo/src', 'feature/VCAD-978-x')?.slug).toBe('ticket');
    expect(resolveBinding(ctx, 'C:/work/repo/docs/a', 'feature/VCAD-978-x')?.slug).toBe('docs');
    expect(resolveBinding(ctx, 'C:/elsewhere', 'main')).toBeUndefined();
    updateProject(ctx, 'test', 'ticket', { status: 'archived' });
    expect(resolveBinding(ctx, 'C:/work/repo/src', 'feature/VCAD-978-x')?.slug).toBe('repo');
  });

  it('summarizes needs-you counts and live sessions', () => {
    const ctx = makeCtx();
    const p = createProject(ctx, 'test', { name: 'P' });
    const ts = ctx.now();
    ctx.db.prepare("INSERT INTO nodes (project_id, parent_id, position, kind, title, status, assignee, created_at, updated_at) VALUES (?, ?, 1, 'task', 'Run tests', 'todo', 'me', ?, ?)").run(p.id, p.rootNodeId, ts, ts);
    ctx.db.prepare("INSERT INTO sessions (id, project_id, state, started_at, last_seen_at) VALUES ('s1', ?, 'working', ?, ?)").run(p.id, ts, ts);
    const [s] = listProjectSummaries(ctx);
    expect(s).toMatchObject({ slug: 'p', needsYou: 1, activeSessions: 1, workingSessions: 1 });
    expect(s.lastEventAt).not.toBeNull();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/server/projects.test.ts`
Expected: FAIL, cannot resolve `../../src/server/repo/projects`.

- [ ] **Step 3: Implement `src/server/repo/projects.ts`**

```ts
import { STALE_SESSION_MS, type Binding, type Project, type ProjectSummary } from '../../core/types';
import { globMatch } from '../../lib/glob';
import { isUnder, normalizePath } from '../../lib/paths';
import { write, type Ctx } from '../db/tx';
import { badRequest, conflict, notFound } from '../errors';

interface ProjectRow {
  id: number;
  slug: string;
  name: string;
  description: string;
  playbook: string;
  status: 'active' | 'archived';
  root_node_id: number;
  created_at: string;
  updated_at: string;
}

interface BindingRow {
  id: number;
  project_id: number;
  path: string;
  branch_pattern: string;
  created_at: string;
}

export const toProject = (r: ProjectRow): Project => ({
  id: r.id,
  slug: r.slug,
  name: r.name,
  description: r.description,
  playbook: r.playbook,
  status: r.status,
  rootNodeId: r.root_node_id,
  createdAt: r.created_at,
  updatedAt: r.updated_at,
});

const toBinding = (r: BindingRow): Binding => ({
  id: r.id,
  projectId: r.project_id,
  path: r.path,
  branchPattern: r.branch_pattern || null,
  createdAt: r.created_at,
});

export function slugify(name: string): string {
  const s = name
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return s || 'project';
}

export function getProjectById(ctx: Ctx, id: number): Project | undefined {
  const row = ctx.db.prepare('SELECT * FROM projects WHERE id = ?').get(id) as ProjectRow | undefined;
  return row ? toProject(row) : undefined;
}

export function resolveProject(ctx: Ctx, ref: string | number): Project {
  const text = String(ref).trim();
  let row: ProjectRow | undefined;
  if (/^\d+$/.test(text)) row = ctx.db.prepare('SELECT * FROM projects WHERE id = ?').get(Number(text)) as ProjectRow | undefined;
  row ??= ctx.db.prepare('SELECT * FROM projects WHERE slug = ?').get(text.toLowerCase()) as ProjectRow | undefined;
  row ??= ctx.db.prepare('SELECT * FROM projects WHERE lower(name) = lower(?)').get(text) as ProjectRow | undefined;
  if (!row) {
    const slugs = (ctx.db.prepare('SELECT slug FROM projects ORDER BY slug').all() as { slug: string }[]).map((r) => r.slug);
    throw notFound(
      `Project "${text}" not found`,
      slugs.length ? `Known projects: ${slugs.join(', ')}` : 'No projects exist yet; create one first.',
    );
  }
  return toProject(row);
}

export interface CreateProjectInput {
  name: string;
  description?: string;
  playbook?: string;
  slug?: string;
}

export function createProject(ctx: Ctx, actor: string, input: CreateProjectInput): Project {
  const name = input.name.trim();
  if (!name) throw badRequest('Project name is empty');
  return write(ctx, actor, (record) => {
    const base = slugify(input.slug ?? name);
    let slug = base;
    for (let n = 2; ctx.db.prepare('SELECT 1 FROM projects WHERE slug = ?').get(slug); n++) slug = `${base}-${n}`;
    const ts = ctx.now();
    const description = input.description ?? '';
    const info = ctx.db
      .prepare("INSERT INTO projects (slug, name, description, playbook, status, root_node_id, created_at, updated_at) VALUES (?, ?, ?, ?, 'active', 0, ?, ?)")
      .run(slug, name, description, input.playbook ?? '', ts, ts);
    const projectId = Number(info.lastInsertRowid);
    const root = ctx.db
      .prepare("INSERT INTO nodes (project_id, parent_id, position, kind, title, body, status, assignee, outcome, created_at, updated_at) VALUES (?, NULL, 1, 'goal', ?, ?, 'active', 'claude', '', ?, ?)")
      .run(projectId, name, description, ts, ts);
    const rootId = Number(root.lastInsertRowid);
    ctx.db.prepare('UPDATE projects SET root_node_id = ? WHERE id = ?').run(rootId, projectId);
    record({ projectId, type: 'project.created', entity: 'project', entityId: projectId, data: { slug, name } });
    record({ projectId, type: 'node.created', entity: 'node', entityId: rootId, data: { ids: [rootId], parentId: null } });
    return getProjectById(ctx, projectId)!;
  });
}

export interface UpdateProjectInput {
  name?: string;
  description?: string;
  playbook?: string;
  status?: 'active' | 'archived';
}

export function updateProject(ctx: Ctx, actor: string, ref: string | number, patch: UpdateProjectInput): Project {
  return write(ctx, actor, (record) => {
    const before = resolveProject(ctx, ref);
    const next = {
      name: patch.name?.trim() || before.name,
      description: patch.description ?? before.description,
      playbook: patch.playbook ?? before.playbook,
      status: patch.status ?? before.status,
    };
    const ts = ctx.now();
    ctx.db
      .prepare('UPDATE projects SET name = ?, description = ?, playbook = ?, status = ?, updated_at = ? WHERE id = ?')
      .run(next.name, next.description, next.playbook, next.status, ts, before.id);
    if (patch.name !== undefined || patch.description !== undefined) {
      ctx.db.prepare('UPDATE nodes SET title = ?, body = ?, updated_at = ? WHERE id = ?').run(next.name, next.description, ts, before.rootNodeId);
    }
    const changes: Record<string, { from: unknown; to: unknown }> = {};
    for (const key of ['name', 'description', 'playbook', 'status'] as const) {
      if (patch[key] !== undefined && before[key] !== next[key]) changes[key] = { from: before[key], to: next[key] };
    }
    record({ projectId: before.id, type: 'project.updated', entity: 'project', entityId: before.id, data: { changes } });
    if (changes.name || changes.description) {
      const rootChanges = { ...(changes.name ? { title: changes.name } : {}), ...(changes.description ? { body: changes.description } : {}) };
      record({ projectId: before.id, type: 'node.updated', entity: 'node', entityId: before.rootNodeId, data: { changes: rootChanges } });
    }
    return getProjectById(ctx, before.id)!;
  });
}

export function listProjectSummaries(ctx: Ctx): ProjectSummary[] {
  const liveSince = new Date(Date.parse(ctx.now()) - STALE_SESSION_MS).toISOString();
  const rows = ctx.db
    .prepare(
      `SELECT p.*,
        (SELECT COUNT(*) FROM nodes n WHERE n.project_id = p.id AND n.assignee = 'me' AND n.status IN ('todo','active','blocked')) AS needs_you,
        (SELECT COUNT(*) FROM sessions s WHERE s.project_id = p.id AND s.state != 'ended' AND s.last_seen_at >= ?) AS active_sessions,
        (SELECT COUNT(*) FROM sessions s WHERE s.project_id = p.id AND s.state = 'working' AND s.last_seen_at >= ?) AS working_sessions,
        (SELECT MAX(ts) FROM events e WHERE e.project_id = p.id) AS last_event_at
       FROM projects p`,
    )
    .all(liveSince, liveSince) as (ProjectRow & { needs_you: number; active_sessions: number; working_sessions: number; last_event_at: string | null })[];
  return rows
    .map((r) => ({ ...toProject(r), needsYou: r.needs_you, activeSessions: r.active_sessions, workingSessions: r.working_sessions, lastEventAt: r.last_event_at }))
    .sort((a, b) => b.workingSessions - a.workingSessions || (b.lastEventAt ?? '').localeCompare(a.lastEventAt ?? ''));
}

export function addBinding(ctx: Ctx, actor: string, ref: string | number, rawPath: string, branchPattern?: string | null): Binding {
  return write(ctx, actor, (record) => {
    const project = resolveProject(ctx, ref);
    const path = normalizePath(rawPath);
    if (!path) throw badRequest('Binding path is empty');
    const pattern = branchPattern?.trim() ?? '';
    const existing = ctx.db
      .prepare('SELECT * FROM bindings WHERE lower(path) = lower(?) AND branch_pattern = ?')
      .get(path, pattern) as BindingRow | undefined;
    if (existing) {
      if (existing.project_id === project.id) return toBinding(existing);
      const owner = getProjectById(ctx, existing.project_id);
      throw conflict(
        `${path}${pattern ? ` (branch ${pattern})` : ''} is already bound to project ${owner?.slug ?? existing.project_id}`,
        'Unbind it first, or add a branch pattern to tell the projects apart.',
      );
    }
    const info = ctx.db
      .prepare('INSERT INTO bindings (project_id, path, branch_pattern, created_at) VALUES (?, ?, ?, ?)')
      .run(project.id, path, pattern, ctx.now());
    const binding = toBinding(ctx.db.prepare('SELECT * FROM bindings WHERE id = ?').get(Number(info.lastInsertRowid)) as BindingRow);
    record({ projectId: project.id, type: 'binding.created', entity: 'binding', entityId: binding.id, data: { path, branchPattern: binding.branchPattern } });
    return binding;
  });
}

export function removeBinding(ctx: Ctx, actor: string, id: number): void {
  write(ctx, actor, (record) => {
    const row = ctx.db.prepare('SELECT * FROM bindings WHERE id = ?').get(id) as BindingRow | undefined;
    if (!row) throw notFound(`Binding ${id} not found`, 'list_projects shows binding ids.');
    ctx.db.prepare('DELETE FROM bindings WHERE id = ?').run(id);
    record({ projectId: row.project_id, type: 'binding.deleted', entity: 'binding', entityId: id, data: { path: row.path } });
  });
}

export function listBindings(ctx: Ctx): Binding[] {
  return (ctx.db.prepare('SELECT * FROM bindings ORDER BY id').all() as BindingRow[]).map(toBinding);
}

export function resolveBinding(ctx: Ctx, cwd: string, branch?: string | null): Project | undefined {
  const rows = ctx.db
    .prepare("SELECT b.* FROM bindings b JOIN projects p ON p.id = b.project_id WHERE p.status = 'active'")
    .all() as BindingRow[];
  let best: BindingRow | undefined;
  for (const row of rows) {
    if (!isUnder(cwd, row.path)) continue;
    if (row.branch_pattern && !(branch && globMatch(row.branch_pattern, branch))) continue;
    const longer = !best || row.path.length > best.path.length;
    const tieWithBranch = !!best && row.path.length === best.path.length && !!row.branch_pattern && !best.branch_pattern;
    if (longer || tieWithBranch) best = row;
  }
  return best ? getProjectById(ctx, best.project_id) : undefined;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/server/projects.test.ts`
Expected: PASS (7 tests).

- [ ] **Step 5: Commit**

```bash
git add src/server/repo/projects.ts test/server/projects.test.ts
git commit -m "Add projects and folder bindings

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 5: Nodes: nested add, update, move, delete

**Files:**
- Create: `src/server/repo/nodes.ts`
- Test: `test/server/nodes.test.ts`

**Interfaces:**
- Consumes: `write`, `Ctx`; `definedOnly`; errors; `createProject` (tests only).
- Produces:
  - `toNode(row): TreeNode`, `findNode(ctx, id): TreeNode | undefined`, `requireNode(ctx, id): TreeNode`
  - `listNodes(ctx, projectId): TreeNode[]`
  - `insertPositions(siblings: { id: number; position: number }[], after: After, count: number): number[]`
  - `addNodes(ctx, actor, input: { parentId: number; after?: After; nodes: NodeInput[] }): TreeNode[]` (created nodes, pre-order)
  - `updateNode(ctx, actor, id, patch: NodePatch): TreeNode` where `NodePatch = { title?; kind?; status?; assignee?; body?; outcome? }`
  - `moveNode(ctx, actor, id, input: { parentId: number; after?: After }): TreeNode`
  - `deleteNode(ctx, actor, id, cascade?: boolean): { ids: number[] }`

- [ ] **Step 1: Write the failing test**

`test/server/nodes.test.ts`:
```ts
import { describe, expect, it } from 'vitest';
import { createProject } from '../../src/server/repo/projects';
import { addNodes, deleteNode, insertPositions, listNodes, moveNode, requireNode, updateNode } from '../../src/server/repo/nodes';
import { makeCtx } from '../helpers';

function setup() {
  const ctx = makeCtx();
  const project = createProject(ctx, 'test', { name: 'P' });
  return { ctx, project, root: project.rootNodeId };
}

describe('insertPositions', () => {
  const sibs = [{ id: 1, position: 1 }, { id: 2, position: 2 }];
  it('appends, prepends, and inserts between', () => {
    expect(insertPositions([], 'end', 2)).toEqual([1, 2]);
    expect(insertPositions(sibs, 'end', 2)).toEqual([3, 4]);
    expect(insertPositions(sibs, 'start', 2)).toEqual([-1, 0]);
    expect(insertPositions(sibs, 1, 1)).toEqual([1.5]);
  });
  it('rejects an after id that is not a sibling', () => {
    expect(() => insertPositions(sibs, 9, 1)).toThrow('#9 is not a child of this parent');
  });
});

describe('nodes', () => {
  it('adds a nested plan in pre-order with defaults, and one event', () => {
    const { ctx, root } = setup();
    const created = addNodes(ctx, 'scribe:s1', {
      parentId: root,
      nodes: [{ title: 'Road to market', kind: 'phase', status: 'active', children: [{ title: 'iOS cert', status: 'done' }, { title: 'Run tests', assignee: 'me' }] }],
    });
    expect(created.map((n) => n.title)).toEqual(['Road to market', 'iOS cert', 'Run tests']);
    expect(created[1]).toMatchObject({ kind: 'task', status: 'done', assignee: 'claude', parentId: created[0].id });
    expect(created[1].completedAt).not.toBeNull();
    expect(created[2]).toMatchObject({ status: 'todo', assignee: 'me', completedAt: null });
    const ev = ctx.db.prepare("SELECT data FROM events WHERE type = 'node.created' ORDER BY id DESC LIMIT 1").get() as { data: string };
    expect(JSON.parse(ev.data)).toEqual({ ids: created.map((n) => n.id), parentId: root });
  });

  it('inserts after a sibling', () => {
    const { ctx, root } = setup();
    const [a, b] = addNodes(ctx, 't', { parentId: root, nodes: [{ title: 'A' }, { title: 'B' }] });
    addNodes(ctx, 't', { parentId: root, after: a.id, nodes: [{ title: 'A2' }] });
    const kids = listNodes(ctx, a.projectId).filter((n) => n.parentId === root).sort((x, y) => x.position - y.position);
    expect(kids.map((n) => n.title)).toEqual(['A', 'A2', 'B']);
    expect(b.title).toBe('B');
  });

  it('updates fields, maintains completed_at, and records the diff', () => {
    const { ctx, root } = setup();
    const [n] = addNodes(ctx, 't', { parentId: root, nodes: [{ title: 'Step' }] });
    const done = updateNode(ctx, 't', n.id, { status: 'done', outcome: 'Shipped' });
    expect(done.completedAt).not.toBeNull();
    const reopened = updateNode(ctx, 't', n.id, { status: 'active' });
    expect(reopened.completedAt).toBeNull();
    const ev = ctx.db.prepare("SELECT data FROM events WHERE type = 'node.updated' ORDER BY id DESC LIMIT 1").get() as { data: string };
    expect(JSON.parse(ev.data)).toEqual({ changes: { status: { from: 'done', to: 'active' } } });
    expect(() => updateNode(ctx, 't', root, { kind: 'task' })).toThrow('project root');
  });

  it('moves within a project, never under its own descendant, never the root', () => {
    const { ctx, root } = setup();
    const [a, child] = addNodes(ctx, 't', { parentId: root, nodes: [{ title: 'A', children: [{ title: 'A.1' }] }] });
    const [b] = addNodes(ctx, 't', { parentId: root, nodes: [{ title: 'B' }] });
    expect(moveNode(ctx, 't', child.id, { parentId: b.id }).parentId).toBe(b.id);
    expect(() => moveNode(ctx, 't', b.id, { parentId: child.id })).toThrow('under its own descendant');
    expect(() => moveNode(ctx, 't', root, { parentId: a.id })).toThrow('cannot be moved');
    const other = createProject(ctx, 't', { name: 'Other' });
    expect(() => moveNode(ctx, 't', a.id, { parentId: other.rootNodeId })).toThrow('different project');
  });

  it('deletes leaves, requires cascade for subtrees, protects the root', () => {
    const { ctx, root } = setup();
    const [a, a1] = addNodes(ctx, 't', { parentId: root, nodes: [{ title: 'A', children: [{ title: 'A.1' }] }] });
    expect(() => deleteNode(ctx, 't', a.id)).toThrow('has 1 descendant');
    expect(deleteNode(ctx, 't', a.id, true).ids.sort()).toEqual([a.id, a1.id].sort());
    expect(() => requireNode(ctx, a1.id)).toThrow(`Node #${a1.id} not found`);
    expect(() => deleteNode(ctx, 't', root)).toThrow('project root');
  });

  it('rejects unknown parents with a hint', () => {
    const { ctx } = setup();
    expect(() => addNodes(ctx, 't', { parentId: 999, nodes: [{ title: 'X' }] })).toThrow('Node #999 not found');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/server/nodes.test.ts`
Expected: FAIL, cannot resolve `../../src/server/repo/nodes`.

- [ ] **Step 3: Implement `src/server/repo/nodes.ts`**

```ts
import type { After, Assignee, NodeInput, NodeKind, NodeStatus, TreeNode } from '../../core/types';
import { write, type Ctx } from '../db/tx';
import { badRequest, notFound } from '../errors';
import { definedOnly } from '../util';

interface NodeRow {
  id: number;
  project_id: number;
  parent_id: number | null;
  position: number;
  kind: NodeKind;
  title: string;
  body: string;
  status: NodeStatus;
  assignee: Assignee;
  outcome: string;
  created_at: string;
  updated_at: string;
  completed_at: string | null;
}

export const toNode = (r: NodeRow): TreeNode => ({
  id: r.id,
  projectId: r.project_id,
  parentId: r.parent_id,
  position: r.position,
  kind: r.kind,
  title: r.title,
  body: r.body,
  status: r.status,
  assignee: r.assignee,
  outcome: r.outcome,
  createdAt: r.created_at,
  updatedAt: r.updated_at,
  completedAt: r.completed_at,
});

export function findNode(ctx: Ctx, id: number): TreeNode | undefined {
  const row = ctx.db.prepare('SELECT * FROM nodes WHERE id = ?').get(id) as NodeRow | undefined;
  return row ? toNode(row) : undefined;
}

export function requireNode(ctx: Ctx, id: number): TreeNode {
  const node = findNode(ctx, id);
  if (!node) throw notFound(`Node #${id} not found`, 'Use get_outline or search to find the right #id.');
  return node;
}

export function listNodes(ctx: Ctx, projectId: number): TreeNode[] {
  return (ctx.db.prepare('SELECT * FROM nodes WHERE project_id = ? ORDER BY parent_id, position, id').all(projectId) as NodeRow[]).map(toNode);
}

function siblings(ctx: Ctx, parentId: number, excludeId?: number): { id: number; position: number }[] {
  return (ctx.db.prepare('SELECT id, position FROM nodes WHERE parent_id = ? ORDER BY position, id').all(parentId) as { id: number; position: number }[])
    .filter((s) => s.id !== excludeId);
}

const range = (n: number) => Array.from({ length: n }, (_, i) => i);

export function insertPositions(sibs: { id: number; position: number }[], after: After, count: number): number[] {
  if (sibs.length === 0) return range(count).map((i) => i + 1);
  if (after === 'end') {
    const last = sibs[sibs.length - 1].position;
    return range(count).map((i) => last + i + 1);
  }
  if (after === 'start') {
    const first = sibs[0].position;
    return range(count).map((i) => first - (count - i));
  }
  const idx = sibs.findIndex((s) => s.id === after);
  if (idx < 0) throw badRequest(`#${after} is not a child of this parent`, 'after must be a sibling #id, "start", or "end".');
  const lo = sibs[idx].position;
  const hi = sibs[idx + 1]?.position;
  if (hi === undefined) return range(count).map((i) => lo + i + 1);
  const step = (hi - lo) / (count + 1);
  return range(count).map((i) => lo + step * (i + 1));
}

function renormalize(ctx: Ctx, parentId: number): void {
  const sibs = siblings(ctx, parentId);
  const tight = sibs.some((s, i) => i > 0 && s.position - sibs[i - 1].position < 1e-6);
  if (!tight) return;
  const update = ctx.db.prepare('UPDATE nodes SET position = ? WHERE id = ?');
  sibs.forEach((s, i) => update.run(i + 1, s.id));
}

export function addNodes(ctx: Ctx, actor: string, input: { parentId: number; after?: After; nodes: NodeInput[] }): TreeNode[] {
  if (input.nodes.length === 0) throw badRequest('nodes is empty');
  return write(ctx, actor, (record) => {
    const parent = requireNode(ctx, input.parentId);
    const positions = insertPositions(siblings(ctx, parent.id), input.after ?? 'end', input.nodes.length);
    const ts = ctx.now();
    const insert = ctx.db.prepare(
      'INSERT INTO nodes (project_id, parent_id, position, kind, title, body, status, assignee, outcome, created_at, updated_at, completed_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)',
    );
    const ids: number[] = [];
    const add = (n: NodeInput, parentId: number, position: number) => {
      const title = n.title.trim();
      if (!title) throw badRequest('A node title is empty');
      const status = n.status ?? 'todo';
      const info = insert.run(parent.projectId, parentId, position, n.kind ?? 'task', title, n.body ?? '', status, n.assignee ?? 'claude', n.outcome ?? '', ts, ts, status === 'done' ? ts : null);
      const id = Number(info.lastInsertRowid);
      ids.push(id);
      (n.children ?? []).forEach((child, i) => add(child, id, i + 1));
    };
    input.nodes.forEach((n, i) => add(n, parent.id, positions[i]));
    renormalize(ctx, parent.id);
    record({ projectId: parent.projectId, type: 'node.created', entity: 'node', entityId: ids[0], data: { ids, parentId: parent.id } });
    return ids.map((id) => requireNode(ctx, id));
  });
}

export interface NodePatch {
  title?: string;
  kind?: NodeKind;
  status?: NodeStatus;
  assignee?: Assignee;
  body?: string;
  outcome?: string;
}

export function updateNode(ctx: Ctx, actor: string, id: number, patch: NodePatch): TreeNode {
  return write(ctx, actor, (record) => {
    const before = requireNode(ctx, id);
    const changes = definedOnly(patch);
    if (changes.title !== undefined) changes.title = changes.title.trim();
    const next = { ...before, ...changes };
    if (!next.title) throw badRequest('title is empty');
    if (before.parentId === null && next.kind !== 'goal') throw badRequest(`#${id} is the project root; its kind stays "goal"`);
    const ts = ctx.now();
    const completedAt = next.status === 'done' ? (before.status === 'done' ? before.completedAt : ts) : null;
    ctx.db
      .prepare('UPDATE nodes SET title = ?, kind = ?, status = ?, assignee = ?, body = ?, outcome = ?, updated_at = ?, completed_at = ? WHERE id = ?')
      .run(next.title, next.kind, next.status, next.assignee, next.body, next.outcome, ts, completedAt, id);
    const diff: Record<string, { from: unknown; to: unknown }> = {};
    for (const key of Object.keys(changes) as (keyof NodePatch)[]) {
      if (before[key] !== next[key]) diff[key] = { from: before[key], to: next[key] };
    }
    record({ projectId: before.projectId, type: 'node.updated', entity: 'node', entityId: id, data: { changes: diff } });
    return requireNode(ctx, id);
  });
}

export function moveNode(ctx: Ctx, actor: string, id: number, input: { parentId: number; after?: After }): TreeNode {
  return write(ctx, actor, (record) => {
    const node = requireNode(ctx, id);
    if (node.parentId === null) throw badRequest(`#${id} is the project root and cannot be moved`);
    const parent = requireNode(ctx, input.parentId);
    if (parent.projectId !== node.projectId) throw badRequest(`#${parent.id} is in a different project than #${id}`);
    for (let cur: TreeNode | undefined = parent; cur; cur = cur.parentId === null ? undefined : findNode(ctx, cur.parentId)) {
      if (cur.id === id) throw badRequest(`Cannot move #${id} under its own descendant #${parent.id}`);
    }
    const [position] = insertPositions(siblings(ctx, parent.id, id), input.after ?? 'end', 1);
    ctx.db.prepare('UPDATE nodes SET parent_id = ?, position = ?, updated_at = ? WHERE id = ?').run(parent.id, position, ctx.now(), id);
    renormalize(ctx, parent.id);
    record({ projectId: node.projectId, type: 'node.moved', entity: 'node', entityId: id, data: { fromParentId: node.parentId, toParentId: parent.id } });
    return requireNode(ctx, id);
  });
}

export function deleteNode(ctx: Ctx, actor: string, id: number, cascade = false): { ids: number[] } {
  return write(ctx, actor, (record) => {
    const node = requireNode(ctx, id);
    if (node.parentId === null) throw badRequest(`#${id} is the project root; archive the project instead`);
    const ids = (
      ctx.db
        .prepare('WITH RECURSIVE sub(id) AS (SELECT ? UNION ALL SELECT n.id FROM nodes n JOIN sub ON n.parent_id = sub.id) SELECT id FROM sub')
        .all(id) as { id: number }[]
    ).map((r) => r.id);
    if (ids.length > 1 && !cascade) {
      throw badRequest(`#${id} has ${ids.length - 1} descendant(s)`, 'Pass cascade: true to delete them too, or move them first.');
    }
    ctx.db.prepare('DELETE FROM nodes WHERE id = ?').run(id);
    record({ projectId: node.projectId, type: 'node.deleted', entity: 'node', entityId: id, data: { ids, parentId: node.parentId } });
    return { ids };
  });
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/server/nodes.test.ts`
Expected: PASS (8 tests).

- [ ] **Step 5: Commit**

```bash
git add src/server/repo/nodes.ts test/server/nodes.test.ts
git commit -m "Add node operations: nested add, update, move, delete

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 6: Resources, log entries, search, event queries

**Files:**
- Create: `src/server/repo/resources.ts`, `src/server/repo/logs.ts`, `src/server/repo/search.ts`, `src/server/repo/events.ts`
- Test: `test/server/resources.test.ts`

**Interfaces:**
- Consumes: `write`, `Ctx`, `requireNode` (nodes.ts), errors.
- Produces:
  - resources.ts: `ResourceInput = { nodeId; kind; title; content?; path?; url?; sessionId? }`, `ResourcePatch = { nodeId?; kind?; title?; content?; path?; url? }`, `addResource(ctx, actor, input): Resource`, `updateResource(ctx, actor, id, patch): Resource`, `deleteResource(ctx, actor, id): void`, `requireResource(ctx, id): Resource`, `listResourceMeta(ctx, projectId): ResourceMeta[]`, `listNodeResources(ctx, nodeId): ResourceMeta[]`
  - logs.ts: `addLog(ctx, actor, nodeId, text, sessionId?): LogEntry`, `listLogs(ctx, nodeId, limit = 20): LogEntry[]` (oldest first)
  - search.ts: `search(ctx, projectId, query): SearchResult` (≤ 20 results total)
  - events.ts: `toEvent(row): EventRow`, `listEventsSince(ctx, since, limit = 5000): EventRow[]`, `maxEventId(ctx): number`, `lastProjectEvent(ctx, projectId): EventRow | null`

- [ ] **Step 1: Write the failing test**

`test/server/resources.test.ts`:
```ts
import { describe, expect, it } from 'vitest';
import { listEventsSince, lastProjectEvent, maxEventId } from '../../src/server/repo/events';
import { addLog, listLogs } from '../../src/server/repo/logs';
import { addNodes } from '../../src/server/repo/nodes';
import { createProject } from '../../src/server/repo/projects';
import { addResource, deleteResource, listNodeResources, listResourceMeta, requireResource, updateResource } from '../../src/server/repo/resources';
import { search } from '../../src/server/repo/search';
import { makeCtx } from '../helpers';

function setup() {
  const ctx = makeCtx();
  const project = createProject(ctx, 'test', { name: 'P' });
  const [step, other] = addNodes(ctx, 'test', { parentId: project.rootNodeId, nodes: [{ title: 'Run signing tests' }, { title: 'Other step' }] });
  return { ctx, project, step, other };
}

describe('resources', () => {
  it('requires content, a path, or a url', () => {
    const { ctx, step } = setup();
    expect(() => addResource(ctx, 't', { nodeId: step.id, kind: 'doc', title: 'Empty' })).toThrow('needs content, a path, or a url');
  });

  it('adds, lists metadata without content, updates, moves within the project, and deletes', () => {
    const { ctx, project, step, other } = setup();
    const r = addResource(ctx, 'scribe:s1', { nodeId: step.id, kind: 'test-suite', title: 'Signing suite', content: '# Tests\n- a', sessionId: 's1' });
    expect(r).toMatchObject({ nodeId: step.id, projectId: project.id, content: '# Tests\n- a', contentLength: 11, sessionId: 's1' });
    const meta = listResourceMeta(ctx, project.id);
    expect(meta).toHaveLength(1);
    expect(meta[0]).not.toHaveProperty('content');
    expect(meta[0].contentLength).toBe(11);
    const moved = updateResource(ctx, 't', r.id, { nodeId: other.id, title: 'Suite v2' });
    expect(moved).toMatchObject({ nodeId: other.id, title: 'Suite v2' });
    expect(listNodeResources(ctx, other.id).map((x) => x.id)).toEqual([r.id]);
    expect(() => updateResource(ctx, 't', r.id, { content: null })).toThrow('needs content, a path, or a url');
    deleteResource(ctx, 't', r.id);
    expect(() => requireResource(ctx, r.id)).toThrow(`Resource r${r.id} not found`);
  });

  it('refuses to move a resource to another project', () => {
    const { ctx, step } = setup();
    const p2 = createProject(ctx, 't', { name: 'P2' });
    const r = addResource(ctx, 't', { nodeId: step.id, kind: 'link', title: 'Docs', url: 'https://example.com' });
    expect(() => updateResource(ctx, 't', r.id, { nodeId: p2.rootNodeId })).toThrow('different project');
  });
});

describe('logs', () => {
  it('returns the newest entries, oldest first, with session titles', () => {
    const { ctx, step } = setup();
    ctx.db.prepare("INSERT INTO sessions (id, title, state, started_at, last_seen_at) VALUES ('s1', 'InGame launch status', 'idle', 'x', 'x')").run();
    for (let i = 1; i <= 3; i++) addLog(ctx, 't', step.id, `note ${i}`, 's1');
    const log = listLogs(ctx, step.id, 2);
    expect(log.map((l) => l.text)).toEqual(['note 2', 'note 3']);
    expect(log[0].sessionTitle).toBe('InGame launch status');
    expect(() => addLog(ctx, 't', step.id, '   ')).toThrow('Log text is empty');
  });
});

describe('search', () => {
  it('finds nodes and resources case-insensitively, treating % and _ literally', () => {
    const { ctx, project, step } = setup();
    addResource(ctx, 't', { nodeId: step.id, kind: 'runbook', title: 'Keystore runbook', content: 'Use 100% of the SIGNING key' });
    const res = search(ctx, project.id, 'signing');
    expect(res.nodes.map((n) => n.title)).toEqual(['Run signing tests']);
    expect(res.resources.map((r) => r.title)).toEqual(['Keystore runbook']);
    expect(search(ctx, project.id, '100%').resources).toHaveLength(1);
    expect(search(ctx, project.id, '_').nodes).toHaveLength(0);
  });
});

describe('events', () => {
  it('lists events after an id and finds the newest per project', () => {
    const { ctx, project } = setup();
    const max = maxEventId(ctx);
    expect(max).toBeGreaterThan(0);
    expect(listEventsSince(ctx, max - 1)).toHaveLength(1);
    expect(lastProjectEvent(ctx, project.id)?.id).toBe(max);
    expect(lastProjectEvent(ctx, 999)).toBeNull();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/server/resources.test.ts`
Expected: FAIL, cannot resolve the new modules.

- [ ] **Step 3: Implement**

`src/server/repo/resources.ts`:
```ts
import type { Resource, ResourceKind, ResourceMeta } from '../../core/types';
import { write, type Ctx } from '../db/tx';
import { badRequest, notFound } from '../errors';
import { requireNode } from './nodes';

interface ResourceRow {
  id: number;
  project_id: number;
  node_id: number;
  kind: ResourceKind;
  title: string;
  content?: string | null;
  path: string | null;
  url: string | null;
  session_id: string | null;
  created_at: string;
  updated_at: string;
  content_length: number | null;
}

const META = 'id, project_id, node_id, kind, title, path, url, session_id, created_at, updated_at, length(content) AS content_length';

const toMeta = (r: ResourceRow): ResourceMeta => ({
  id: r.id,
  projectId: r.project_id,
  nodeId: r.node_id,
  kind: r.kind,
  title: r.title,
  path: r.path,
  url: r.url,
  contentLength: r.content_length ?? 0,
  sessionId: r.session_id,
  createdAt: r.created_at,
  updatedAt: r.updated_at,
});

export interface ResourceInput {
  nodeId: number;
  kind: ResourceKind;
  title: string;
  content?: string | null;
  path?: string | null;
  url?: string | null;
  sessionId?: string | null;
}

export interface ResourcePatch {
  nodeId?: number;
  kind?: ResourceKind;
  title?: string;
  content?: string | null;
  path?: string | null;
  url?: string | null;
}

const clean = (v: string | null | undefined) => (v?.trim() ? v.trim() : null);

export function requireResource(ctx: Ctx, id: number): Resource {
  const row = ctx.db.prepare(`SELECT ${META}, content FROM resources WHERE id = ?`).get(id) as ResourceRow | undefined;
  if (!row) throw notFound(`Resource r${id} not found`, 'get_node lists a node\'s resources.');
  return { ...toMeta(row), content: row.content ?? null };
}

export function listResourceMeta(ctx: Ctx, projectId: number): ResourceMeta[] {
  return (ctx.db.prepare(`SELECT ${META} FROM resources WHERE project_id = ? ORDER BY id`).all(projectId) as ResourceRow[]).map(toMeta);
}

export function listNodeResources(ctx: Ctx, nodeId: number): ResourceMeta[] {
  return (ctx.db.prepare(`SELECT ${META} FROM resources WHERE node_id = ? ORDER BY id`).all(nodeId) as ResourceRow[]).map(toMeta);
}

export function addResource(ctx: Ctx, actor: string, input: ResourceInput): Resource {
  return write(ctx, actor, (record) => {
    const node = requireNode(ctx, input.nodeId);
    const content = input.content ?? null;
    const path = clean(input.path);
    const url = clean(input.url);
    if (content === null && !path && !url) throw badRequest('A resource needs content, a path, or a url');
    const title = input.title.trim();
    if (!title) throw badRequest('Resource title is empty');
    const ts = ctx.now();
    const info = ctx.db
      .prepare('INSERT INTO resources (project_id, node_id, kind, title, content, path, url, session_id, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?)')
      .run(node.projectId, node.id, input.kind, title, content, path, url, input.sessionId ?? null, ts, ts);
    const resource = requireResource(ctx, Number(info.lastInsertRowid));
    record({ projectId: node.projectId, type: 'resource.created', entity: 'resource', entityId: resource.id, data: { nodeId: node.id, title, kind: input.kind } });
    return resource;
  });
}

export function updateResource(ctx: Ctx, actor: string, id: number, patch: ResourcePatch): Resource {
  return write(ctx, actor, (record) => {
    const before = requireResource(ctx, id);
    let nodeId = before.nodeId;
    if (patch.nodeId !== undefined && patch.nodeId !== before.nodeId) {
      const node = requireNode(ctx, patch.nodeId);
      if (node.projectId !== before.projectId) throw badRequest(`#${node.id} is in a different project than r${id}`);
      nodeId = node.id;
    }
    const next = {
      kind: patch.kind ?? before.kind,
      title: patch.title?.trim() || before.title,
      content: patch.content !== undefined ? patch.content : before.content,
      path: patch.path !== undefined ? clean(patch.path) : before.path,
      url: patch.url !== undefined ? clean(patch.url) : before.url,
    };
    if (next.content === null && !next.path && !next.url) throw badRequest('A resource needs content, a path, or a url');
    ctx.db
      .prepare('UPDATE resources SET node_id = ?, kind = ?, title = ?, content = ?, path = ?, url = ?, updated_at = ? WHERE id = ?')
      .run(nodeId, next.kind, next.title, next.content, next.path, next.url, ctx.now(), id);
    record({ projectId: before.projectId, type: 'resource.updated', entity: 'resource', entityId: id, data: { nodeId, fromNodeId: before.nodeId } });
    return requireResource(ctx, id);
  });
}

export function deleteResource(ctx: Ctx, actor: string, id: number): void {
  write(ctx, actor, (record) => {
    const before = requireResource(ctx, id);
    ctx.db.prepare('DELETE FROM resources WHERE id = ?').run(id);
    record({ projectId: before.projectId, type: 'resource.deleted', entity: 'resource', entityId: id, data: { nodeId: before.nodeId } });
  });
}
```

`src/server/repo/logs.ts`:
```ts
import type { LogEntry } from '../../core/types';
import { write, type Ctx } from '../db/tx';
import { badRequest } from '../errors';
import { requireNode } from './nodes';

interface LogRow {
  id: number;
  node_id: number;
  text: string;
  session_id: string | null;
  created_at: string;
  session_title: string | null;
}

const toLog = (r: LogRow): LogEntry => ({
  id: r.id,
  nodeId: r.node_id,
  text: r.text,
  sessionId: r.session_id,
  createdAt: r.created_at,
  sessionTitle: r.session_title,
});

export function addLog(ctx: Ctx, actor: string, nodeId: number, text: string, sessionId?: string | null): LogEntry {
  return write(ctx, actor, (record) => {
    const node = requireNode(ctx, nodeId);
    const body = text.trim();
    if (!body) throw badRequest('Log text is empty');
    const info = ctx.db.prepare('INSERT INTO log_entries (node_id, text, session_id, created_at) VALUES (?, ?, ?, ?)').run(node.id, body, sessionId ?? null, ctx.now());
    const id = Number(info.lastInsertRowid);
    record({ projectId: node.projectId, type: 'log.created', entity: 'log', entityId: id, data: { nodeId: node.id } });
    const row = ctx.db.prepare('SELECT l.*, s.title AS session_title FROM log_entries l LEFT JOIN sessions s ON s.id = l.session_id WHERE l.id = ?').get(id) as LogRow;
    return toLog(row);
  });
}

export function listLogs(ctx: Ctx, nodeId: number, limit = 20): LogEntry[] {
  const rows = ctx.db
    .prepare('SELECT l.*, s.title AS session_title FROM log_entries l LEFT JOIN sessions s ON s.id = l.session_id WHERE l.node_id = ? ORDER BY l.id DESC LIMIT ?')
    .all(nodeId, limit) as LogRow[];
  return rows.reverse().map(toLog);
}
```

`src/server/repo/search.ts`:
```ts
import type { SearchResult } from '../../core/types';
import type { Ctx } from '../db/tx';
import { badRequest } from '../errors';

export function search(ctx: Ctx, projectId: number, query: string): SearchResult {
  const q = query.trim();
  if (!q) throw badRequest('Search query is empty');
  const like = `%${q.replace(/[\\%_]/g, (m) => `\\${m}`)}%`;
  const nodes = ctx.db
    .prepare("SELECT id, title, status, kind FROM nodes WHERE project_id = ? AND (title LIKE ? ESCAPE '\\' OR body LIKE ? ESCAPE '\\' OR outcome LIKE ? ESCAPE '\\') ORDER BY updated_at DESC LIMIT 20")
    .all(projectId, like, like, like) as SearchResult['nodes'];
  const resources = ctx.db
    .prepare("SELECT id, title, kind, node_id AS nodeId FROM resources WHERE project_id = ? AND (title LIKE ? ESCAPE '\\' OR content LIKE ? ESCAPE '\\') ORDER BY updated_at DESC LIMIT 20")
    .all(projectId, like, like) as SearchResult['resources'];
  return { nodes, resources: resources.slice(0, Math.max(0, 20 - nodes.length)) };
}
```

`src/server/repo/events.ts`:
```ts
import type { EventRow } from '../../core/types';
import type { Ctx } from '../db/tx';

interface EventDbRow {
  id: number;
  ts: string;
  project_id: number | null;
  actor: string;
  type: string;
  entity: string;
  entity_id: string;
  data: string;
}

export const toEvent = (r: EventDbRow): EventRow => ({
  id: r.id,
  ts: r.ts,
  projectId: r.project_id,
  actor: r.actor,
  type: r.type,
  entity: r.entity,
  entityId: r.entity_id,
  data: JSON.parse(r.data) as unknown,
});

export function listEventsSince(ctx: Ctx, since: number, limit = 5000): EventRow[] {
  return (ctx.db.prepare('SELECT * FROM events WHERE id > ? ORDER BY id LIMIT ?').all(since, limit) as EventDbRow[]).map(toEvent);
}

export function maxEventId(ctx: Ctx): number {
  return (ctx.db.prepare('SELECT COALESCE(MAX(id), 0) AS id FROM events').get() as { id: number }).id;
}

export function lastProjectEvent(ctx: Ctx, projectId: number): EventRow | null {
  const row = ctx.db.prepare('SELECT * FROM events WHERE project_id = ? ORDER BY id DESC LIMIT 1').get(projectId) as EventDbRow | undefined;
  return row ? toEvent(row) : null;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/server/resources.test.ts`
Expected: PASS (6 tests).

- [ ] **Step 5: Commit**

```bash
git add src/server/repo test/server/resources.test.ts
git commit -m "Add resources, log entries, search and event queries

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 7: Pure tree logic: index, derived stats, fold rules, text outline

**Files:**
- Create: `src/core/tree.ts`
- Test: `test/core/tree.test.ts`

**Interfaces:**
- Consumes: types from `src/core/types.ts`.
- Produces:
  - `FoldOverrides = Record<string, 'open' | 'closed'>` (keys `n:<nodeId>` and `more:<parentId>`)
  - `TreeIndex = { byId: Map<number, TreeNode>; children: Map<number, TreeNode[]>; root: TreeNode | undefined }`
  - `buildIndex(nodes): TreeIndex`, `kids(index, id): TreeNode[]`, `ancestors(index, id): TreeNode[]` (root first, excluding the node), `isNeedsYou(n): boolean`, `progress(index, id): { done: number; total: number } | null`, `countDone(index, id): number`, `pinnedIds(index, sessions): Set<number>`, `dfsOrder(index): Map<number, number>`
  - `VisibleItem = { type: 'node'; node; depth; folded; hasChildren } | { type: 'more'; parentId; run: number; depth; hiddenIds: number[] }`
  - `computeVisible(index, sessions, opts?: { overrides?: FoldOverrides; noFold?: boolean }): VisibleItem[]`
  - `statusLabel(n): string`, `nodeLine(index, n, resourcesByNode?): string`, `renderOutline(index, sessions, opts?: { full?: boolean; overrides?: FoldOverrides; resourcesByNode?: Map<number, number[]> }): string`
- `sessions` parameters accept `Pick<Session, 'focusNodeId' | 'state'>[]`.

- [ ] **Step 1: Write the failing test**

`test/core/tree.test.ts`:
```ts
import { describe, expect, it } from 'vitest';
import type { TreeNode } from '../../src/core/types';
import { ancestors, buildIndex, computeVisible, countDone, isNeedsYou, pinnedIds, progress, renderOutline } from '../../src/core/tree';

let nextId = 1;
function n(parentId: number | null, title: string, extra: Partial<TreeNode> = {}): TreeNode {
  const id = extra.id ?? nextId++;
  return { id, projectId: 1, parentId, position: id, kind: parentId === null ? 'goal' : 'task', title, body: '', status: 'todo', assignee: 'claude', outcome: '', createdAt: 't', updatedAt: 't', completedAt: null, ...extra };
}

function sample() {
  nextId = 1;
  const root = n(null, 'InGame', { status: 'active' });
  const m = n(root.id, 'M1-M6 build', { status: 'done', kind: 'phase' });
  const m1 = n(m.id, 'M1', { status: 'done' });
  const m2 = n(m.id, 'M2', { status: 'done' });
  const road = n(root.id, 'Road to market', { status: 'active', kind: 'phase' });
  const s1 = n(road.id, '1 iOS certificate', { status: 'done' });
  const s2 = n(road.id, '2 Android signing', { status: 'active' });
  const a1 = n(s2.id, 'Upload keystore', { status: 'done' });
  const a2 = n(s2.id, 'Play app signing', { status: 'active' });
  const a3 = n(s2.id, 'Run signing tests', { assignee: 'me' });
  const s3 = n(road.id, '3 RevenueCat');
  const s4 = n(road.id, '4 Build to GitHub');
  const s5 = n(road.id, '5 Store listing');
  const s6 = n(road.id, '6 Beta');
  const s7 = n(road.id, '7 Launch');
  const nodes = [root, m, m1, m2, road, s1, s2, a1, a2, a3, s3, s4, s5, s6, s7];
  return { nodes, root, m, road, s1, s2, a1, a2, a3, s3, s4, s5, s6, s7 };
}

describe('derived stats', () => {
  it('computes needs-you, progress, done counts and ancestors', () => {
    const t = sample();
    const index = buildIndex(t.nodes);
    expect(isNeedsYou(t.a3)).toBe(true);
    expect(isNeedsYou({ ...t.a3, status: 'done' })).toBe(false);
    expect(progress(index, t.road.id)).toEqual({ done: 1, total: 7 });
    expect(progress(index, t.a1.id)).toBeNull();
    expect(countDone(index, t.m.id)).toBe(2);
    expect(ancestors(index, t.a2.id).map((x) => x.title)).toEqual(['InGame', 'Road to market', '2 Android signing']);
  });

  it('pins active nodes, needs-you nodes and session focus, with their ancestors', () => {
    const t = sample();
    const index = buildIndex(t.nodes);
    const pinned = pinnedIds(index, [{ focusNodeId: t.s6.id, state: 'idle' }, { focusNodeId: t.s7.id, state: 'ended' }]);
    expect(pinned.has(t.a3.id)).toBe(true);
    expect(pinned.has(t.road.id)).toBe(true);
    expect(pinned.has(t.s6.id)).toBe(true);
    expect(pinned.has(t.s7.id)).toBe(false);
    expect(pinned.has(t.m.id)).toBe(false);
  });
});

describe('computeVisible', () => {
  it('folds done branches and hides the far todo tail', () => {
    const t = sample();
    const items = computeVisible(buildIndex(t.nodes), []);
    const titles = items.map((i) => (i.type === 'node' ? `${i.node.title}${i.folded ? ' [folded]' : ''}` : `+${i.hiddenIds.length} more`));
    expect(titles).toEqual([
      'InGame', 'M1-M6 build [folded]', 'Road to market', '1 iOS certificate', '2 Android signing',
      'Upload keystore', 'Play app signing', 'Run signing tests', '3 RevenueCat', '4 Build to GitHub', '+3 more',
    ]);
  });

  it('splits hidden runs around a pinned node', () => {
    const t = sample();
    const nodes = t.nodes.map((x) => (x.id === t.s6.id ? { ...x, assignee: 'me' as const } : x));
    const items = computeVisible(buildIndex(nodes), []);
    const tail = items.slice(-4).map((i) => (i.type === 'node' ? i.node.title : `+${i.hiddenIds.length} more`));
    expect(tail).toEqual(['4 Build to GitHub', '+1 more', '6 Beta', '+1 more']);
  });

  it('does not hide a single leftover node', () => {
    const t = sample();
    const nodes = t.nodes.filter((x) => x.id !== t.s6.id && x.id !== t.s7.id);
    const items = computeVisible(buildIndex(nodes), []);
    expect(items.some((i) => i.type === 'more')).toBe(false);
  });

  it('honours manual overrides and noFold', () => {
    const t = sample();
    const index = buildIndex(t.nodes);
    const opened = computeVisible(index, [], { overrides: { [`n:${t.m.id}`]: 'open', [`more:${t.road.id}`]: 'open' } });
    expect(opened.filter((i) => i.type === 'node')).toHaveLength(15);
    const closed = computeVisible(index, [], { overrides: { [`n:${t.s2.id}`]: 'closed' } });
    expect(closed.find((i) => i.type === 'node' && i.node.id === t.s2.id)).toMatchObject({ folded: true });
    expect(computeVisible(index, [], { noFold: true }).filter((i) => i.type === 'node')).toHaveLength(15);
  });
});

describe('renderOutline', () => {
  it('renders ids, statuses, needs-you, progress, resources and folds', () => {
    const t = sample();
    const text = renderOutline(buildIndex(t.nodes), [], { resourcesByNode: new Map([[t.a3.id, [12]]]) });
    expect(text.split('\n')).toEqual([
      `#${t.root.id} InGame · active (1/2)`,
      `  #${t.m.id} M1-M6 build (phase) · done (2/2) · 2 done inside (folded)`,
      `  #${t.road.id} Road to market (phase) · active (1/7)`,
      `    #${t.s1.id} 1 iOS certificate · done`,
      `    #${t.s2.id} 2 Android signing · active (1/3)`,
      `      #${t.a1.id} Upload keystore · done`,
      `      #${t.a2.id} Play app signing · active`,
      `      #${t.a3.id} Run signing tests · NEEDS YOU [r12]`,
      `    #${t.s3.id} 3 RevenueCat · todo`,
      `    #${t.s4.id} 4 Build to GitHub · todo`,
      `    +3 more: #${t.s5.id}, #${t.s6.id}, #${t.s7.id}`,
    ]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/core/tree.test.ts`
Expected: FAIL, cannot resolve `../../src/core/tree`.

- [ ] **Step 3: Implement `src/core/tree.ts`**

```ts
import type { Session, TreeNode } from './types';

export type FoldOverrides = Record<string, 'open' | 'closed'>;
type SessionLike = Pick<Session, 'focusNodeId' | 'state'>;

export interface TreeIndex {
  byId: Map<number, TreeNode>;
  children: Map<number, TreeNode[]>;
  root: TreeNode | undefined;
}

export function buildIndex(nodes: TreeNode[]): TreeIndex {
  const byId = new Map(nodes.map((n) => [n.id, n] as const));
  const children = new Map<number, TreeNode[]>();
  let root: TreeNode | undefined;
  for (const n of nodes) {
    if (n.parentId === null) {
      root = n;
      continue;
    }
    const list = children.get(n.parentId) ?? [];
    list.push(n);
    children.set(n.parentId, list);
  }
  for (const list of children.values()) list.sort((a, b) => a.position - b.position || a.id - b.id);
  return { byId, children, root };
}

export const kids = (index: TreeIndex, id: number): TreeNode[] => index.children.get(id) ?? [];

export function isNeedsYou(n: Pick<TreeNode, 'assignee' | 'status'>): boolean {
  return n.assignee === 'me' && (n.status === 'todo' || n.status === 'active' || n.status === 'blocked');
}

export function ancestors(index: TreeIndex, id: number): TreeNode[] {
  const out: TreeNode[] = [];
  let cur = index.byId.get(id);
  while (cur && cur.parentId !== null) {
    const parent = index.byId.get(cur.parentId);
    if (!parent) break;
    out.unshift(parent);
    cur = parent;
  }
  return out;
}

export function progress(index: TreeIndex, id: number): { done: number; total: number } | null {
  const list = kids(index, id).filter((c) => c.status !== 'dropped');
  if (list.length === 0) return null;
  return { done: list.filter((c) => c.status === 'done').length, total: list.length };
}

export function countDone(index: TreeIndex, id: number): number {
  let count = 0;
  const walk = (nid: number) => {
    for (const k of kids(index, nid)) {
      if (k.status === 'done') count++;
      walk(k.id);
    }
  };
  walk(id);
  return count;
}

export function pinnedIds(index: TreeIndex, sessions: SessionLike[]): Set<number> {
  const pinned = new Set<number>();
  const pin = (id: number) => {
    let cur = index.byId.get(id);
    while (cur && !pinned.has(cur.id)) {
      pinned.add(cur.id);
      cur = cur.parentId === null ? undefined : index.byId.get(cur.parentId);
    }
  };
  for (const n of index.byId.values()) {
    if (n.parentId !== null && (n.status === 'active' || isNeedsYou(n))) pin(n.id);
  }
  for (const s of sessions) if (s.state !== 'ended' && s.focusNodeId !== null) pin(s.focusNodeId);
  return pinned;
}

export function dfsOrder(index: TreeIndex): Map<number, number> {
  const order = new Map<number, number>();
  const visit = (n: TreeNode) => {
    order.set(n.id, order.size);
    for (const k of kids(index, n.id)) visit(k);
  };
  if (index.root) visit(index.root);
  return order;
}

export type VisibleItem =
  | { type: 'node'; node: TreeNode; depth: number; folded: boolean; hasChildren: boolean }
  | { type: 'more'; parentId: number; run: number; depth: number; hiddenIds: number[] };

export interface VisibleOptions {
  overrides?: FoldOverrides;
  noFold?: boolean;
}

export function computeVisible(index: TreeIndex, sessions: SessionLike[], opts: VisibleOptions = {}): VisibleItem[] {
  const out: VisibleItem[] = [];
  if (!index.root) return out;
  const overrides = opts.overrides ?? {};
  const pinned = pinnedIds(index, sessions);

  const isFolded = (n: TreeNode): boolean => {
    if (opts.noFold || kids(index, n.id).length === 0) return false;
    const manual = overrides[`n:${n.id}`];
    if (manual) return manual === 'closed';
    return (n.status === 'done' || n.status === 'dropped') && !pinned.has(n.id);
  };

  const hiddenRuns = (parent: TreeNode, list: TreeNode[]): number[][] => {
    if (opts.noFold || overrides[`more:${parent.id}`] === 'open') return [];
    let last = -1;
    list.forEach((k, i) => {
      if (k.status === 'done' || k.status === 'active') last = i;
    });
    const candidates = list.slice(last + 1).filter((k) => (k.status === 'todo' || k.status === 'blocked') && !pinned.has(k.id));
    const hidden = new Set(candidates.slice(2).map((k) => k.id));
    if (hidden.size < 2) return [];
    const runs: number[][] = [];
    let current: number[] = [];
    for (const k of list) {
      if (hidden.has(k.id)) current.push(k.id);
      else if (current.length) {
        runs.push(current);
        current = [];
      }
    }
    if (current.length) runs.push(current);
    return runs;
  };

  const visit = (n: TreeNode, depth: number) => {
    const list = kids(index, n.id);
    const folded = isFolded(n);
    out.push({ type: 'node', node: n, depth, folded, hasChildren: list.length > 0 });
    if (folded) return;
    const runs = hiddenRuns(n, list);
    const runOf = new Map<number, number>();
    runs.forEach((run, i) => run.forEach((id) => runOf.set(id, i)));
    for (const k of list) {
      const run = runOf.get(k.id);
      if (run === undefined) visit(k, depth + 1);
      else if (runs[run][0] === k.id) out.push({ type: 'more', parentId: n.id, run, depth: depth + 1, hiddenIds: runs[run] });
    }
  };
  visit(index.root, 0);
  return out;
}

export function statusLabel(n: TreeNode): string {
  if (!isNeedsYou(n)) return n.status;
  return n.status === 'todo' ? 'NEEDS YOU' : `NEEDS YOU (${n.status})`;
}

export function nodeLine(index: TreeIndex, n: TreeNode, resourcesByNode?: Map<number, number[]>): string {
  const kind = n.parentId === null || n.kind === 'task' ? '' : ` (${n.kind})`;
  const prog = progress(index, n.id);
  const res = resourcesByNode?.get(n.id);
  return `#${n.id} ${n.title}${kind} · ${statusLabel(n)}${prog ? ` (${prog.done}/${prog.total})` : ''}${res?.length ? ` [${res.map((r) => `r${r}`).join(', ')}]` : ''}`;
}

export interface OutlineOptions {
  full?: boolean;
  overrides?: FoldOverrides;
  resourcesByNode?: Map<number, number[]>;
}

export function renderOutline(index: TreeIndex, sessions: SessionLike[], opts: OutlineOptions = {}): string {
  return computeVisible(index, sessions, { overrides: opts.overrides, noFold: opts.full })
    .map((item) => {
      const pad = '  '.repeat(item.depth);
      if (item.type === 'more') return `${pad}+${item.hiddenIds.length} more: ${item.hiddenIds.map((id) => `#${id}`).join(', ')}`;
      const line = nodeLine(index, item.node, opts.resourcesByNode);
      return item.folded ? `${pad}${line} · ${countDone(index, item.node.id)} done inside (folded)` : `${pad}${line}`;
    })
    .join('\n');
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/core/tree.test.ts`
Expected: PASS (7 tests).

- [ ] **Step 5: Commit**

```bash
git add src/core/tree.ts test/core/tree.test.ts
git commit -m "Add pure tree logic: fold rules and text outline

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 8: Sessions, snapshots, briefing, hook-event flow

**Files:**
- Create: `src/server/repo/sessions.ts`, `src/server/repo/snapshot.ts`, `src/server/briefing.ts`, `src/server/session-flow.ts`
- Test: `test/server/sessions.test.ts`

**Interfaces:**
- Consumes: tasks 3–7 (`write`, `resolveProject`, `getProjectById`, `resolveBinding`, `listNodes`, `requireNode`, `listResourceMeta`, `listNodeResources`, `listLogs`, `maxEventId`, `lastProjectEvent`, `buildIndex`, `kids`, `ancestors`, `isNeedsYou`, `progress`, `dfsOrder`).
- Produces:
  - sessions.ts: `findSession(ctx, id): Session | undefined`, `saveSession(ctx, s): void`, `listProjectSessions(ctx, projectId): Session[]` (non-ended, stale ones expired first), `expireStaleSessions(ctx): void`, `addSubagent(ctx, sessionId, agentId, agentType, at)`, `removeSubagent(ctx, sessionId, agentId)`, `clearSubagents(ctx, sessionId)`
  - snapshot.ts: `getProjectSnapshot(ctx, ref): ProjectSnapshot`, `getNodeDetail(ctx, id): NodeDetail`
  - briefing.ts: `UPDATE_RULES: string[]`, `frontierLines(snapshot, sessionId?): string[]`, `renderBriefing(snapshot, sessionId): string`, `renderStatusAnswer(snapshot, sessionId): string`, `renderStatusLine(snapshot, session): string`, `untrackedHint(sessionId): string`
  - session-flow.ts: `HookEventInput`, `HookEventResult = { tracked: boolean; context?: string }`, `handleHookEvent(ctx, sessionId, input): HookEventResult`, `enrollSession(ctx, actor, sessionId, projectRef, title?): { session: Session; briefing: string }`, `setFocus(ctx, actor, sessionId, nodeId: number | null): Session`

- [ ] **Step 1: Write the failing test**

`test/server/sessions.test.ts`:
```ts
import { describe, expect, it } from 'vitest';
import { addNodes } from '../../src/server/repo/nodes';
import { addBinding, createProject, updateProject } from '../../src/server/repo/projects';
import { addResource } from '../../src/server/repo/resources';
import { findSession, listProjectSessions } from '../../src/server/repo/sessions';
import { getNodeDetail, getProjectSnapshot } from '../../src/server/repo/snapshot';
import { enrollSession, handleHookEvent, setFocus } from '../../src/server/session-flow';
import { createCtx } from '../../src/server/db/tx';
import { openDb } from '../../src/server/db/connection';
import { makeCtx } from '../helpers';

function setup() {
  const ctx = makeCtx();
  const project = createProject(ctx, 'test', { name: 'InGame', playbook: 'Planning docs live in docs/planning.' });
  addBinding(ctx, 'test', project.slug, 'C:/personal/InGame');
  const [road, s1, s2, a1, a2, a3] = addNodes(ctx, 'test', {
    parentId: project.rootNodeId,
    nodes: [{
      title: 'Road to market', kind: 'phase', status: 'active',
      children: [
        { title: '1 iOS certificate', status: 'done' },
        { title: '2 Android signing', status: 'active', children: [
          { title: 'Upload keystore', status: 'done' },
          { title: 'Play app signing', status: 'active' },
          { title: 'Run signing tests', assignee: 'me' },
        ] },
        { title: '3 RevenueCat' }, { title: '4 Build to GitHub' }, { title: '5 Store listing' }, { title: '6 Beta' }, { title: '7 Launch' },
      ],
    }],
  });
  return { ctx, project, road, s1, s2, a1, a2, a3 };
}

const start = (cwd = 'C:\\personal\\InGame\\docs', extra = {}) => ({ event: 'start' as const, source: 'startup', cwd, ...extra });

describe('handleHookEvent', () => {
  it('stores nothing for an untracked session', () => {
    const { ctx } = setup();
    expect(handleHookEvent(ctx, 'u1', start('C:/elsewhere'))).toEqual({ tracked: false });
    expect(handleHookEvent(ctx, 'u1', { event: 'prompt' })).toEqual({ tracked: false });
    expect(findSession(ctx, 'u1')).toBeUndefined();
  });

  it('hints at opt-in when an untracked prompt mentions InProgress', () => {
    const { ctx } = setup();
    const r = handleHookEvent(ctx, 'u2', { event: 'prompt', mentionsInProgress: true });
    expect(r.tracked).toBe(false);
    expect(r.context).toContain('Session id: u2');
  });

  it('briefs a bound session with rules, frontier, needs-you and resources', () => {
    const { ctx, a2, a3 } = setup();
    addResource(ctx, 'test', { nodeId: a3.id, kind: 'test-suite', title: 'Signing suite', content: 'x' });
    const r = handleHookEvent(ctx, 's1', start(undefined, { title: 'InGame launch status' }));
    expect(r.tracked).toBe(true);
    const text = r.context!;
    expect(text).toContain('tracked in project "InGame" (slug ingame). Session id: s1.');
    expect(text).toContain('Planning docs live in docs/planning.');
    expect(text).toContain('inprogress-scribe');
    expect(text).toContain(`#${a2.id} Play app signing · active`);
    expect(text).toContain(`#${a3.id} Run signing tests · NEEDS YOU`);
    expect(text).toMatch(/Next: #\d+ 3 RevenueCat · #\d+ 4 Build to GitHub \(\+3 more\)/);
    expect(text).toContain(`Needs you (1): #${a3.id} Run signing tests`);
    expect(text).toContain(`Signing suite (on #${a3.id})`);
    expect(findSession(ctx, 's1')).toMatchObject({ title: 'InGame launch status', state: 'idle', cwd: 'C:\\personal\\InGame\\docs' });
  });

  it('tracks prompt, stop and permission states and nudges when stale', () => {
    const { ctx } = setup();
    handleHookEvent(ctx, 's1', start());
    expect(handleHookEvent(ctx, 's1', { event: 'prompt' }).context).toBeUndefined();
    expect(findSession(ctx, 's1')?.state).toBe('working');
    const nudge = handleHookEvent(ctx, 's1', { event: 'prompt' }).context!;
    expect(nudge).toMatch(/^\[InProgress\] InGame · no focus set · 1 need you · last scribe update 2 prompts ago/);
    handleHookEvent(ctx, 's1', { event: 'permission' });
    expect(findSession(ctx, 's1')?.state).toBe('permission');
    handleHookEvent(ctx, 's1', { event: 'stop' });
    expect(findSession(ctx, 's1')?.state).toBe('idle');
  });

  it('answers status questions with the current frontier', () => {
    const { ctx, a3 } = setup();
    handleHookEvent(ctx, 's1', start());
    const r = handleHookEvent(ctx, 's1', { event: 'prompt', asksStatus: true });
    expect(r.context).toContain('[InProgress] Where things stand in InGame');
    expect(r.context).toContain(`#${a3.id} Run signing tests · NEEDS YOU`);
  });

  it('leaves state alone on a compact restart but still re-briefs', () => {
    const { ctx } = setup();
    handleHookEvent(ctx, 's1', start());
    handleHookEvent(ctx, 's1', { event: 'prompt' });
    const r = handleHookEvent(ctx, 's1', { event: 'start', source: 'compact', cwd: 'C:/personal/InGame' });
    expect(r.context).toContain('Session id: s1');
    expect(findSession(ctx, 's1')?.state).toBe('working');
  });

  it('tracks subagents by agent id, ignoring the scribe and empty types', () => {
    const { ctx } = setup();
    handleHookEvent(ctx, 's1', start());
    handleHookEvent(ctx, 's1', { event: 'subagent-start', agentId: 'a1', agentType: 'Explore' });
    handleHookEvent(ctx, 's1', { event: 'subagent-start', agentId: 'a2', agentType: 'inprogress-scribe' });
    handleHookEvent(ctx, 's1', { event: 'subagent-start', agentId: 'a3', agentType: '' });
    expect(findSession(ctx, 's1')?.subagents.map((s) => s.agentType)).toEqual(['Explore']);
    handleHookEvent(ctx, 's1', { event: 'subagent-stop', agentId: 'a1', agentType: 'Explore' });
    expect(findSession(ctx, 's1')?.subagents).toEqual([]);
    handleHookEvent(ctx, 's1', { event: 'subagent-start', agentId: 'a4', agentType: 'general-purpose' });
    handleHookEvent(ctx, 's1', { event: 'end' });
    expect(findSession(ctx, 's1')).toMatchObject({ state: 'ended', subagents: [] });
  });
});

describe('enrollSession and setFocus', () => {
  it('enrolls, repoints, keeps an existing title, and refuses archived projects', () => {
    const { ctx, project } = setup();
    const other = createProject(ctx, 'test', { name: 'Other' });
    const r = enrollSession(ctx, 'scribe:e1', 'e1', 'ingame', 'Chosen by scribe');
    expect(r.briefing).toContain('Session id: e1');
    expect(r.session).toMatchObject({ projectId: project.id, title: 'Chosen by scribe' });
    expect(enrollSession(ctx, 'scribe:e1', 'e1', other.slug, 'Another name').session).toMatchObject({ projectId: other.id, title: 'Chosen by scribe' });
    updateProject(ctx, 'test', other.slug, { status: 'archived' });
    expect(() => enrollSession(ctx, 'scribe:e2', 'e2', other.slug)).toThrow('archived');
  });

  it('sets focus within the session project and resets the stale counter', () => {
    const { ctx, a2 } = setup();
    handleHookEvent(ctx, 's1', start());
    handleHookEvent(ctx, 's1', { event: 'prompt' });
    handleHookEvent(ctx, 's1', { event: 'prompt' });
    expect(setFocus(ctx, 'scribe:s1', 's1', a2.id)).toMatchObject({ focusNodeId: a2.id, promptsSinceUpdate: 0 });
    const other = createProject(ctx, 'test', { name: 'Other' });
    expect(() => setFocus(ctx, 'scribe:s1', 's1', other.rootNodeId)).toThrow("not in this session's project");
    expect(() => setFocus(ctx, 'scribe:x', 'untracked', null)).toThrow('not tracked');
  });
});

describe('snapshots', () => {
  it('returns nodes, resources, live sessions and the last event', () => {
    const { ctx, project } = setup();
    handleHookEvent(ctx, 's1', start());
    const snap = getProjectSnapshot(ctx, project.slug);
    expect(snap.nodes).toHaveLength(12);
    expect(snap.nodes.some((n) => n.parentId === null)).toBe(true);
    expect(snap.sessions.map((s) => s.id)).toEqual(['s1']);
    expect(snap.lastEvent?.type).toBe('session.updated');
    expect(snap.lastEventId).toBe(snap.lastEvent?.id);
  });

  it('expires sessions not seen for 12 hours', () => {
    const db = openDb(':memory:');
    let now = Date.parse('2026-09-27T00:00:00Z');
    const ctx = createCtx(db, () => new Date(now).toISOString());
    const p = createProject(ctx, 'test', { name: 'P' });
    addBinding(ctx, 'test', p.slug, 'C:/p');
    handleHookEvent(ctx, 's1', start('C:/p'));
    now += 13 * 60 * 60 * 1000;
    expect(listProjectSessions(ctx, p.id)).toEqual([]);
    expect(findSession(ctx, 's1')?.state).toBe('ended');
  });

  it('builds node details with parent, children, resources and log', () => {
    const { ctx, s2, road } = setup();
    const d = getNodeDetail(ctx, s2.id);
    expect(d.parent).toEqual({ id: road.id, title: 'Road to market' });
    expect(d.children.map((c) => c.title)).toEqual(['Upload keystore', 'Play app signing', 'Run signing tests']);
    expect(d.resources).toEqual([]);
    expect(d.log).toEqual([]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/server/sessions.test.ts`
Expected: FAIL, cannot resolve the new modules.

- [ ] **Step 3: Implement `src/server/repo/sessions.ts`**

```ts
import { STALE_SESSION_MS, type Session, type SessionState, type SubagentInfo } from '../../core/types';
import { write, type Ctx } from '../db/tx';

interface SessionRow {
  id: string;
  project_id: number | null;
  title: string | null;
  cwd: string | null;
  branch: string | null;
  transcript_path: string | null;
  state: SessionState;
  focus_node_id: number | null;
  prompts_since_update: number;
  started_at: string;
  last_seen_at: string;
  ended_at: string | null;
}

function subagentsOf(ctx: Ctx, sessionId: string): SubagentInfo[] {
  return (ctx.db.prepare('SELECT agent_id, agent_type, started_at FROM session_subagents WHERE session_id = ? ORDER BY started_at, agent_id').all(sessionId) as { agent_id: string; agent_type: string; started_at: string }[])
    .map((r) => ({ agentId: r.agent_id, agentType: r.agent_type, startedAt: r.started_at }));
}

const toSession = (ctx: Ctx, r: SessionRow): Session => ({
  id: r.id,
  projectId: r.project_id,
  title: r.title,
  cwd: r.cwd,
  branch: r.branch,
  transcriptPath: r.transcript_path,
  state: r.state,
  focusNodeId: r.focus_node_id,
  promptsSinceUpdate: r.prompts_since_update,
  startedAt: r.started_at,
  lastSeenAt: r.last_seen_at,
  endedAt: r.ended_at,
  subagents: subagentsOf(ctx, r.id),
});

export function findSession(ctx: Ctx, id: string): Session | undefined {
  const row = ctx.db.prepare('SELECT * FROM sessions WHERE id = ?').get(id) as SessionRow | undefined;
  return row ? toSession(ctx, row) : undefined;
}

/** Persist every column except subagents (which live in session_subagents). */
export function saveSession(ctx: Ctx, s: Session): void {
  ctx.db
    .prepare('UPDATE sessions SET project_id = ?, title = ?, cwd = ?, branch = ?, transcript_path = ?, state = ?, focus_node_id = ?, prompts_since_update = ?, last_seen_at = ?, ended_at = ? WHERE id = ?')
    .run(s.projectId, s.title, s.cwd, s.branch, s.transcriptPath, s.state, s.focusNodeId, s.promptsSinceUpdate, s.lastSeenAt, s.endedAt, s.id);
}

/**
 * Mark sessions not seen for 12 hours as ended, recording an event for each so the UI drops
 * their badges. Opens its own write(): never call this (or listProjectSessions /
 * getProjectSnapshot, which call it) from inside another write().
 */
export function expireStaleSessions(ctx: Ctx): void {
  const cutoff = new Date(Date.parse(ctx.now()) - STALE_SESSION_MS).toISOString();
  const stale = ctx.db
    .prepare("SELECT id, project_id FROM sessions WHERE state != 'ended' AND last_seen_at < ?")
    .all(cutoff) as { id: string; project_id: number | null }[];
  if (!stale.length) return;
  write(ctx, 'system', (record) => {
    const now = ctx.now();
    for (const { id, project_id } of stale) {
      ctx.db.prepare("UPDATE sessions SET state = 'ended', ended_at = ? WHERE id = ?").run(now, id);
      clearSubagents(ctx, id);
      record({ projectId: project_id, type: 'session.updated', entity: 'session', entityId: id, data: { changed: ['state'], state: 'ended' } });
    }
  });
}

export function listProjectSessions(ctx: Ctx, projectId: number): Session[] {
  expireStaleSessions(ctx);
  return (ctx.db.prepare("SELECT * FROM sessions WHERE project_id = ? AND state != 'ended' ORDER BY last_seen_at DESC").all(projectId) as SessionRow[])
    .map((r) => toSession(ctx, r));
}

export function addSubagent(ctx: Ctx, sessionId: string, agentId: string, agentType: string, at: string): void {
  ctx.db.prepare('INSERT OR IGNORE INTO session_subagents (session_id, agent_id, agent_type, started_at) VALUES (?, ?, ?, ?)').run(sessionId, agentId, agentType, at);
}

export function removeSubagent(ctx: Ctx, sessionId: string, agentId: string): void {
  ctx.db.prepare('DELETE FROM session_subagents WHERE session_id = ? AND agent_id = ?').run(sessionId, agentId);
}

export function clearSubagents(ctx: Ctx, sessionId: string): void {
  ctx.db.prepare('DELETE FROM session_subagents WHERE session_id = ?').run(sessionId);
}
```

- [ ] **Step 4: Implement `src/server/repo/snapshot.ts`**

```ts
import type { NodeDetail, ProjectSnapshot } from '../../core/types';
import type { Ctx } from '../db/tx';
import { lastProjectEvent, maxEventId } from './events';
import { listLogs } from './logs';
import { listNodes, requireNode } from './nodes';
import { resolveProject } from './projects';
import { listNodeResources, listResourceMeta } from './resources';
import { listProjectSessions } from './sessions';

export function getProjectSnapshot(ctx: Ctx, ref: string | number): ProjectSnapshot {
  const project = resolveProject(ctx, ref);
  return {
    project,
    nodes: listNodes(ctx, project.id),
    resources: listResourceMeta(ctx, project.id),
    sessions: listProjectSessions(ctx, project.id),
    lastEventId: maxEventId(ctx),
    lastEvent: lastProjectEvent(ctx, project.id),
  };
}

export function getNodeDetail(ctx: Ctx, id: number): NodeDetail {
  const node = requireNode(ctx, id);
  const parent = node.parentId === null
    ? null
    : ((ctx.db.prepare('SELECT id, title FROM nodes WHERE id = ?').get(node.parentId) as { id: number; title: string } | undefined) ?? null);
  const children = ctx.db
    .prepare('SELECT id, title, status, assignee, kind FROM nodes WHERE parent_id = ? ORDER BY position, id')
    .all(id) as NodeDetail['children'];
  return { node, parent, children, resources: listNodeResources(ctx, id), log: listLogs(ctx, id, 20) };
}
```

- [ ] **Step 5: Implement `src/server/briefing.ts`**

```ts
import { ancestors, buildIndex, dfsOrder, isNeedsYou, kids, progress, type TreeIndex } from '../core/tree';
import { sessionDisplayTitle, type ProjectSnapshot, type Session, type TreeNode } from '../core/types';

const MAX_FRONTIER_LINES = 25;

export const UPDATE_RULES = [
  'Keeping InProgress current (the tree beside Claude that Aiden watches):',
  '- Never edit it yourself. Brief the inprogress-scribe agent (Agent tool, subagent_type "inprogress-scribe"); it runs in the background. At most one brief per turn, batching every change.',
  '- Brief at these checkpoints: a plan is made or changed (backtracking = mark steps dropped or move them); a step starts, finishes, or is blocked; something worth finding again is produced (test suite, runbook, walkthrough, roadmap, diagram, handoff); something is handed to Aiden (assignee me) or he reports doing it; an open question appears or is answered.',
  '- Steps are plan-level with outcomes, never single actions. Detours go in the log of the step they interrupted.',
  '- Resources: pass a file path with snapshot_file. Content that only exists in chat is first written to ~/.inprogress/resources/<slug>/<yyyy-mm-dd>-<kebab-title>.md.',
  '- Brief format: "Session: <id> · Project: <slug>", then one "- " line per change, e.g. "#57 → done; outcome ...", "add under #55: \\"Run signing tests\\" (assignee me)", "resource on #58: test-suite \\"Signing suite\\", path ..., snapshot_file", "log on #55: ...", "focus → #58".',
  '- After dispatching, write one line in chat ("↳ InProgress: #57 done, suite attached to #58"). The scribe\'s completion notice needs no reply beyond that line.',
];

function statusText(n: TreeNode): string {
  if (!isNeedsYou(n)) return n.status;
  return n.status === 'todo' ? 'NEEDS YOU' : `NEEDS YOU (${n.status})`;
}

function lineFor(index: TreeIndex, n: TreeNode, focusOf: Map<number, Session[]>, sessionId?: string): string {
  const prog = progress(index, n.id);
  const here = (focusOf.get(n.id) ?? []).map((s) => (s.id === sessionId ? '◆ this session' : `◆ "${sessionDisplayTitle(s)}"`));
  return `#${n.id} ${n.title}${n.kind === 'question' ? ' (question)' : ''} · ${statusText(n)}${prog ? ` (${prog.done}/${prog.total})` : ''}${here.length ? `  ${here.join(' ')}` : ''}`;
}

export function frontierLines(snapshot: ProjectSnapshot, sessionId?: string): string[] {
  const index = buildIndex(snapshot.nodes);
  const root = index.root;
  if (!root) return ['(empty project)'];
  const live = snapshot.sessions.filter((s) => s.state !== 'ended');
  const focusOf = new Map<number, Session[]>();
  for (const s of live) if (s.focusNodeId !== null) focusOf.set(s.focusNodeId, [...(focusOf.get(s.focusNodeId) ?? []), s]);
  const chain = new Set<number>();
  const targets = snapshot.nodes.filter((n) => n.parentId !== null && (n.status === 'active' || isNeedsYou(n)));
  for (const id of [...targets.map((t) => t.id), ...focusOf.keys()]) {
    if (!index.byId.has(id)) continue;
    chain.add(id);
    for (const a of ancestors(index, id)) chain.add(a.id);
  }
  const lines: string[] = [];
  if (chain.size <= 1) {
    lines.push('Nothing is active yet. Top level:');
    for (const k of kids(index, root.id).slice(0, 10)) lines.push(`  ${lineFor(index, k, focusOf, sessionId)}`);
    return lines;
  }
  const walk = (parent: TreeNode, depth: number) => {
    const list = kids(index, parent.id);
    let last = -1;
    list.forEach((k, i) => {
      if (chain.has(k.id) || k.status === 'done' || k.status === 'active') last = i;
    });
    for (const k of list) {
      if (!chain.has(k.id)) continue;
      lines.push(`${'  '.repeat(depth)}${lineFor(index, k, focusOf, sessionId)}`);
      walk(k, depth + 1);
    }
    const upcoming = list.slice(last + 1).filter((k) => k.status === 'todo' && !chain.has(k.id));
    if (upcoming.length) {
      lines.push(`${'  '.repeat(depth)}Next: ${upcoming.slice(0, 2).map((k) => `#${k.id} ${k.title}`).join(' · ')}${upcoming.length > 2 ? ` (+${upcoming.length - 2} more)` : ''}`);
    }
  };
  walk(root, 0);
  if (lines.length > MAX_FRONTIER_LINES) {
    const extra = lines.length - MAX_FRONTIER_LINES;
    return [...lines.slice(0, MAX_FRONTIER_LINES), `+${extra} more active items (run: inprogress outline ${snapshot.project.slug})`];
  }
  return lines;
}

function needsYouLine(snapshot: ProjectSnapshot): string | undefined {
  const index = buildIndex(snapshot.nodes);
  const order = dfsOrder(index);
  const needs = snapshot.nodes.filter(isNeedsYou).sort((a, b) => (order.get(a.id) ?? 0) - (order.get(b.id) ?? 0));
  if (!needs.length) return undefined;
  const shown = needs.slice(0, 8).map((n) => `#${n.id} ${n.title}${n.kind === 'question' ? ' (question)' : ''}`);
  return `Needs you (${needs.length}): ${shown.join(' · ')}${needs.length > 8 ? ` · +${needs.length - 8} more` : ''}`;
}

export function renderBriefing(snapshot: ProjectSnapshot, sessionId: string): string {
  const { project, resources, sessions } = snapshot;
  const lines = [
    `[InProgress] This session is tracked in project "${project.name}" (slug ${project.slug}). Session id: ${sessionId}.`,
    'All InProgress edits go through the inprogress-scribe agent in the background; follow the inprogress skill.',
  ];
  const playbook = project.playbook.trim();
  if (playbook) {
    const pl = playbook.split('\n');
    lines.push('Playbook:', ...pl.slice(0, 15).map((l) => `  ${l}`));
    if (pl.length > 15) lines.push(`  … (${pl.length - 15} more lines)`);
  }
  lines.push(...UPDATE_RULES);
  lines.push('Where things stand:', ...frontierLines(snapshot, sessionId).map((l) => `  ${l}`));
  const needs = needsYouLine(snapshot);
  if (needs) lines.push(needs);
  const recent = [...resources].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt) || b.id - a.id).slice(0, 5);
  if (recent.length) lines.push(`Recent resources: ${recent.map((r) => `r${r.id} ${r.title} (on #${r.nodeId})`).join(' · ')}`);
  const others = sessions.filter((s) => s.id !== sessionId && s.state !== 'ended');
  if (others.length) {
    lines.push(`Other sessions here: ${others.map((s) => `"${sessionDisplayTitle(s)}" (${s.state}${s.focusNodeId ? `, on #${s.focusNodeId}` : ''})`).join(' · ')}`);
  }
  return lines.join('\n');
}

export function renderStatusAnswer(snapshot: ProjectSnapshot, sessionId: string): string {
  const lines = [`[InProgress] Where things stand in ${snapshot.project.name} (live):`, ...frontierLines(snapshot, sessionId).map((l) => `  ${l}`)];
  const needs = needsYouLine(snapshot);
  if (needs) lines.push(needs);
  return lines.join('\n');
}

export function renderStatusLine(snapshot: ProjectSnapshot, session: Session): string {
  const focus = session.focusNodeId !== null ? snapshot.nodes.find((n) => n.id === session.focusNodeId) : undefined;
  const needs = snapshot.nodes.filter(isNeedsYou).length;
  return `[InProgress] ${snapshot.project.name} · ${focus ? `focus #${focus.id} ${focus.title}` : 'no focus set'} · ${needs} need you · last scribe update ${session.promptsSinceUpdate} prompts ago. If a checkpoint happened, brief the inprogress-scribe; otherwise ignore this line.`;
}

export function untrackedHint(sessionId: string): string {
  return `[InProgress] This session is not tracked yet. Session id: ${sessionId}. Use the inprogress skill to opt in.`;
}
```

- [ ] **Step 6: Implement `src/server/session-flow.ts`**

```ts
import { SCRIBE_AGENT, type HookEvent, type Session } from '../core/types';
import { write, type Ctx } from './db/tx';
import { badRequest } from './errors';
import { renderBriefing, renderStatusAnswer, renderStatusLine, untrackedHint } from './briefing';
import { requireNode } from './repo/nodes';
import { getProjectById, resolveBinding, resolveProject } from './repo/projects';
import { addSubagent, clearSubagents, findSession, removeSubagent, saveSession } from './repo/sessions';
import { getProjectSnapshot } from './repo/snapshot';

export interface HookEventInput {
  event: HookEvent;
  source?: string;
  cwd?: string;
  branch?: string | null;
  transcriptPath?: string;
  title?: string;
  agentId?: string;
  agentType?: string;
  mentionsInProgress?: boolean;
  asksStatus?: boolean;
}

export interface HookEventResult {
  tracked: boolean;
  context?: string;
}

const VISIBLE = ['projectId', 'title', 'state', 'focusNodeId'] as const;

function insertSession(ctx: Ctx, id: string, projectId: number, state: Session['state']): void {
  const now = ctx.now();
  ctx.db.prepare('INSERT INTO sessions (id, project_id, state, started_at, last_seen_at) VALUES (?, ?, ?, ?, ?)').run(id, projectId, state, now, now);
}

export function handleHookEvent(ctx: Ctx, sessionId: string, input: HookEventInput): HookEventResult {
  const session = write(ctx, `hook:${input.event}`, (record): Session | undefined => {
    let before = findSession(ctx, sessionId);
    let created = false;
    if (!before) {
      if (input.event !== 'start' || !input.cwd) return undefined;
      const project = resolveBinding(ctx, input.cwd, input.branch ?? null);
      if (!project) return undefined;
      insertSession(ctx, sessionId, project.id, 'idle');
      before = findSession(ctx, sessionId)!;
      created = true;
    }
    const now = ctx.now();
    const next: Session = { ...before, lastSeenAt: now };
    if (input.cwd) next.cwd = input.cwd;
    if (input.branch !== undefined) next.branch = input.branch;
    if (input.transcriptPath) next.transcriptPath = input.transcriptPath;
    if (input.title?.trim()) next.title = input.title.trim();
    switch (input.event) {
      case 'start':
        if (input.source !== 'compact') {
          next.state = 'idle';
          next.endedAt = null;
        }
        break;
      case 'prompt':
        next.state = 'working';
        next.promptsSinceUpdate += 1;
        break;
      case 'stop':
        next.state = 'idle';
        break;
      case 'permission':
        next.state = 'permission';
        break;
      case 'subagent-start':
        if (input.agentId && input.agentType && input.agentType !== SCRIBE_AGENT) addSubagent(ctx, sessionId, input.agentId, input.agentType, now);
        if (next.state === 'permission') next.state = 'working';
        break;
      case 'subagent-stop':
        if (input.agentId) removeSubagent(ctx, sessionId, input.agentId);
        if (next.state === 'permission') next.state = 'working';
        break;
      case 'end':
        next.state = 'ended';
        next.endedAt = now;
        clearSubagents(ctx, sessionId);
        break;
    }
    saveSession(ctx, next);
    const after = findSession(ctx, sessionId)!;
    const changed: string[] = VISIBLE.filter((k) => before![k] !== after[k]);
    if (before.subagents.length !== after.subagents.length) changed.push('subagents');
    if (created || changed.length) {
      record({ projectId: after.projectId, type: 'session.updated', entity: 'session', entityId: sessionId, data: { changed: created ? ['created', ...changed] : changed, state: after.state } });
    }
    return after;
  });

  const project = session?.projectId != null ? getProjectById(ctx, session.projectId) : undefined;
  if (!session || !project || project.status !== 'active') {
    return input.event === 'prompt' && input.mentionsInProgress ? { tracked: false, context: untrackedHint(sessionId) } : { tracked: false };
  }
  if (input.event === 'start') return { tracked: true, context: renderBriefing(getProjectSnapshot(ctx, project.id), sessionId) };
  if (input.event === 'prompt') {
    if (input.asksStatus) return { tracked: true, context: renderStatusAnswer(getProjectSnapshot(ctx, project.id), sessionId) };
    if (session.promptsSinceUpdate >= 2) return { tracked: true, context: renderStatusLine(getProjectSnapshot(ctx, project.id), session) };
  }
  return { tracked: true };
}

export function enrollSession(ctx: Ctx, actor: string, sessionId: string, projectRef: string | number, title?: string): { session: Session; briefing: string } {
  write(ctx, actor, (record) => {
    const project = resolveProject(ctx, projectRef);
    if (project.status !== 'active') throw badRequest(`Project ${project.slug} is archived`, 'Unarchive it with update_project first.');
    if (!findSession(ctx, sessionId)) insertSession(ctx, sessionId, project.id, 'working');
    const before = findSession(ctx, sessionId)!;
    const next: Session = { ...before, projectId: project.id, lastSeenAt: ctx.now() };
    if (title?.trim() && !before.title) next.title = title.trim();
    saveSession(ctx, next);
    record({ projectId: project.id, type: 'session.updated', entity: 'session', entityId: sessionId, data: { changed: ['projectId'], state: next.state } });
  });
  // Re-read after commit: write() resets prompts_since_update for scribe actors after fn() runs.
  const session = findSession(ctx, sessionId)!;
  return { session, briefing: renderBriefing(getProjectSnapshot(ctx, session.projectId!), sessionId) };
}

export function setFocus(ctx: Ctx, actor: string, sessionId: string, nodeId: number | null): Session {
  write(ctx, actor, (record) => {
    const existing = findSession(ctx, sessionId);
    let projectId = existing?.projectId ?? null;
    if (nodeId !== null) {
      const node = requireNode(ctx, nodeId);
      if (projectId === null) projectId = node.projectId;
      else if (node.projectId !== projectId) throw badRequest(`#${nodeId} is not in this session's project`, 'Use enroll_session to move the session to another project first.');
    }
    if (projectId === null) throw badRequest(`Session ${sessionId} is not tracked`, 'Use enroll_session first.');
    if (!existing) insertSession(ctx, sessionId, projectId, 'working');
    const current = findSession(ctx, sessionId)!;
    saveSession(ctx, { ...current, projectId, focusNodeId: nodeId, lastSeenAt: ctx.now() });
    record({ projectId, type: 'session.updated', entity: 'session', entityId: sessionId, data: { changed: ['focusNodeId'], focusNodeId: nodeId } });
  });
  return findSession(ctx, sessionId)!;
}
```

- [ ] **Step 7: Run test to verify it passes**

Run: `npx vitest run test/server/sessions.test.ts`
Expected: PASS (12 tests).

- [ ] **Step 8: Commit**

```bash
git add src/server test/server/sessions.test.ts
git commit -m "Add sessions, snapshots, briefing and hook-event flow

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 9: HTTP API (Fastify): guards, validation, routes

**Files:**
- Create: `src/server/schemas.ts`, `src/server/app.ts`, `src/server/open-path.ts`, `src/server/routes/read.ts`, `src/server/routes/write.ts`, `src/server/routes/sessions.ts`, `src/server/routes/ui.ts`
- Test: `test/server/app.test.ts`

**Interfaces:**
- Consumes: every repo function from Tasks 4–8, `handleHookEvent`, `enrollSession`, `setFocus`, `buildIndex`, `renderOutline`.
- Produces:
  - `buildApp(opts: AppOptions): FastifyInstance` with `AppOptions = { ctx; token; uiToken; version; webDir?; logger?; onShutdown?: () => void; openPath?: (path: string) => Promise<void> }`
  - `actorOf(req): string`, `type Guard`
  - `openInEditorOrReveal(path): Promise<void>` (open-path.ts)
  - HTTP routes exactly as spec §5.1 (SSE comes in Task 10).

- [ ] **Step 1: Write the failing test**

`test/server/app.test.ts`:
```ts
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { buildApp, type AppOptions } from '../../src/server/app';
import { makeCtx } from '../helpers';

const TOKEN = 'test-token';
const auth = { authorization: `Bearer ${TOKEN}`, 'x-inprogress-actor': 'scribe:s1' };

function setup(extra: Partial<AppOptions> = {}) {
  const ctx = makeCtx();
  const app = buildApp({ ctx, token: TOKEN, uiToken: 'ui-token', version: 'test', ...extra });
  return { ctx, app };
}

describe('guards', () => {
  it('serves health and rejects foreign Host headers', async () => {
    const { app } = setup();
    const ok = await app.inject({ url: '/api/health' });
    expect(ok.json()).toMatchObject({ ok: true, app: 'inprogress', version: 'test' });
    const bad = await app.inject({ url: '/api/health', headers: { host: 'evil.example:4317' } });
    expect(bad.statusCode).toBe(403);
  });

  it('requires the token for writes and explains validation and lookup errors', async () => {
    const { app } = setup();
    expect((await app.inject({ method: 'POST', url: '/api/projects', payload: { name: 'X' } })).statusCode).toBe(401);
    const invalid = await app.inject({ method: 'POST', url: '/api/projects', headers: auth, payload: { name: '', extra: 1 } });
    expect(invalid.statusCode).toBe(400);
    expect(invalid.json().hint).toContain('name');
    const missing = await app.inject({ url: '/api/projects/nope' });
    expect(missing.statusCode).toBe(404);
    expect(missing.json()).toMatchObject({ error: 'Project "nope" not found' });
  });
});

describe('project lifecycle over HTTP', () => {
  it('creates, binds, plans, updates, moves, attaches, logs, searches and outlines', async () => {
    const { app } = setup();
    const p = (await app.inject({ method: 'POST', url: '/api/projects', headers: auth, payload: { name: 'InGame', description: 'Game app' } })).json();
    expect(p.slug).toBe('ingame');
    const b = await app.inject({ method: 'POST', url: '/api/projects/ingame/bindings', headers: auth, payload: { path: 'C:\\personal\\InGame' } });
    expect(b.statusCode).toBe(201);
    expect((await app.inject({ url: '/api/bindings' })).json()).toHaveLength(1);
    const nodes = (await app.inject({
      method: 'POST', url: '/api/nodes', headers: auth,
      payload: { parentId: p.rootNodeId, nodes: [{ title: 'Road to market', kind: 'phase', status: 'active', children: [{ title: 'iOS cert' }, { title: 'Run tests', assignee: 'me' }] }] },
    })).json();
    expect(nodes.map((n: { title: string }) => n.title)).toEqual(['Road to market', 'iOS cert', 'Run tests']);
    const [road, ios, tests] = nodes;
    expect((await app.inject({ method: 'PATCH', url: `/api/nodes/${ios.id}`, headers: auth, payload: { status: 'done', outcome: 'Cert installed' } })).json().status).toBe('done');
    const moved = await app.inject({ method: 'POST', url: `/api/nodes/${tests.id}/move`, headers: auth, payload: { parentId: road.id, after: 'start' } });
    expect(moved.statusCode).toBe(200);
    const res = (await app.inject({ method: 'POST', url: '/api/resources', headers: auth, payload: { nodeId: tests.id, kind: 'test-suite', title: 'Signing suite', content: '# Signing tests' } })).json();
    expect((await app.inject({ url: `/api/resources/${res.id}` })).json().content).toBe('# Signing tests');
    expect((await app.inject({ method: 'PATCH', url: `/api/resources/${res.id}`, headers: auth, payload: { title: 'Suite v2' } })).json().title).toBe('Suite v2');
    expect((await app.inject({ method: 'POST', url: `/api/nodes/${road.id}/log`, headers: auth, payload: { text: 'Detour: sandbox wedge' } })).statusCode).toBe(201);
    const detail = (await app.inject({ url: `/api/nodes/${road.id}` })).json();
    expect(detail.log[0].text).toBe('Detour: sandbox wedge');
    expect((await app.inject({ url: '/api/search?project=ingame&q=signing' })).json().resources[0].title).toBe('Suite v2');
    const outline = await app.inject({ url: '/api/projects/ingame/outline' });
    expect(outline.headers['content-type']).toContain('text/plain');
    expect(outline.body).toContain(`#${tests.id} Run tests · NEEDS YOU [r${res.id}]`);
    const snap = (await app.inject({ url: '/api/projects/ingame' })).json();
    expect(snap.nodes).toHaveLength(4);
    expect(snap.lastEvent.type).toBe('log.created');
    expect((await app.inject({ method: 'DELETE', url: `/api/nodes/${road.id}`, headers: auth })).statusCode).toBe(400);
    expect((await app.inject({ method: 'DELETE', url: `/api/nodes/${road.id}?cascade=1`, headers: auth })).json().ids).toHaveLength(3);
    expect((await app.inject({ method: 'DELETE', url: `/api/resources/${res.id}`, headers: auth })).statusCode).toBe(404);
    expect((await app.inject({ method: 'PATCH', url: '/api/projects/ingame', headers: auth, payload: { status: 'archived' } })).json().status).toBe('archived');
    expect((await app.inject({ url: '/api/projects' })).json()[0].slug).toBe('ingame');
  });
});

describe('session routes', () => {
  it('handles hook events, enrollment and focus', async () => {
    const { app } = setup();
    const p = (await app.inject({ method: 'POST', url: '/api/projects', headers: auth, payload: { name: 'InGame' } })).json();
    const untracked = await app.inject({ method: 'POST', url: '/api/sessions/s1/hook', headers: auth, payload: { event: 'start', source: 'startup', cwd: 'C:/x' } });
    expect(untracked.json()).toEqual({ tracked: false });
    const enrolled = (await app.inject({ method: 'POST', url: '/api/sessions/s1/enroll', headers: auth, payload: { project: 'ingame', title: 'Launch' } })).json();
    expect(enrolled.briefing).toContain('Session id: s1');
    const focus = await app.inject({ method: 'POST', url: '/api/sessions/s1/focus', headers: auth, payload: { nodeId: p.rootNodeId } });
    expect(focus.json().focusNodeId).toBe(p.rootNodeId);
    const bad = await app.inject({ method: 'POST', url: '/api/sessions/s1/hook', headers: auth, payload: { event: 'nonsense' } });
    expect(bad.statusCode).toBe(400);
  });
});

describe('ui routes', () => {
  it('opens only a stored resource path, and only with the UI token', async () => {
    const opened: string[] = [];
    const { app } = setup({ openPath: async (p) => { opened.push(p); } });
    const p = (await app.inject({ method: 'POST', url: '/api/projects', headers: auth, payload: { name: 'P' } })).json();
    const file = join(mkdtempSync(join(tmpdir(), 'ip-open-')), 'suite.md');
    writeFileSync(file, '# x');
    const withPath = (await app.inject({ method: 'POST', url: '/api/resources', headers: auth, payload: { nodeId: p.rootNodeId, kind: 'doc', title: 'Doc', path: file } })).json();
    const noPath = (await app.inject({ method: 'POST', url: '/api/resources', headers: auth, payload: { nodeId: p.rootNodeId, kind: 'doc', title: 'Inline', content: 'x' } })).json();
    expect((await app.inject({ method: 'POST', url: '/api/ui/open', payload: { resourceId: withPath.id } })).statusCode).toBe(401);
    const ok = await app.inject({ method: 'POST', url: '/api/ui/open', headers: { 'x-ip-ui-token': 'ui-token' }, payload: { resourceId: withPath.id } });
    expect(ok.statusCode).toBe(200);
    expect(opened).toEqual([file]);
    const none = await app.inject({ method: 'POST', url: '/api/ui/open', headers: { 'x-ip-ui-token': 'ui-token' }, payload: { resourceId: noPath.id } });
    expect(none.statusCode).toBe(400);
  });

  it('reports an unbuilt UI, and injects the UI token into a built one', async () => {
    expect((await setup().app.inject({ url: '/' })).statusCode).toBe(503);
    const webDir = mkdtempSync(join(tmpdir(), 'ip-web-'));
    writeFileSync(join(webDir, 'index.html'), '<html><head><meta name="ip-ui-token" content="" /></head><body></body></html>');
    const res = await setup({ webDir }).app.inject({ url: '/' });
    expect(res.body).toContain('<meta name="ip-ui-token" content="ui-token">');
  });

  it('shuts down on request', async () => {
    const onShutdown = vi.fn();
    const { app } = setup({ onShutdown });
    expect((await app.inject({ method: 'POST', url: '/api/admin/shutdown', headers: auth })).statusCode).toBe(200);
    await new Promise((r) => setImmediate(r));
    expect(onShutdown).toHaveBeenCalledOnce();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/server/app.test.ts`
Expected: FAIL, cannot resolve `../../src/server/app`.

- [ ] **Step 3: Create `src/server/schemas.ts`**

```ts
import { z } from 'zod';
import { ASSIGNEES, HOOK_EVENTS, NODE_KINDS, NODE_STATUSES, RESOURCE_KINDS, type NodeInput } from '../core/types';

const title = z.string().trim().min(1, 'title is empty').max(200);
export const after = z.union([z.number().int().positive(), z.literal('start'), z.literal('end')]).optional();

export const nodeInput: z.ZodType<NodeInput> = z.lazy(() =>
  z
    .object({
      title,
      kind: z.enum(NODE_KINDS).optional(),
      status: z.enum(NODE_STATUSES).optional(),
      assignee: z.enum(ASSIGNEES).optional(),
      body: z.string().max(20_000).optional(),
      outcome: z.string().max(2_000).optional(),
      children: z.array(nodeInput).max(200).optional(),
    })
    .strict(),
);

export const idParam = z.object({ id: z.coerce.number().int().positive() });
export const sessionParam = z.object({ id: z.string().min(1).max(100) });
export const searchQuery = z.object({ project: z.string().min(1), q: z.string().min(1).max(200) });

export const createProjectBody = z
  .object({ name: z.string().trim().min(1, 'name is empty').max(120), description: z.string().max(5_000).optional(), playbook: z.string().max(10_000).optional(), slug: z.string().max(60).optional() })
  .strict();
export const updateProjectBody = z
  .object({ name: z.string().trim().min(1).max(120).optional(), description: z.string().max(5_000).optional(), playbook: z.string().max(10_000).optional(), status: z.enum(['active', 'archived']).optional() })
  .strict();
export const bindingBody = z.object({ path: z.string().trim().min(1).max(500), branchPattern: z.string().trim().max(200).nullish() }).strict();
export const addNodesBody = z.object({ parentId: z.number().int().positive(), after, nodes: z.array(nodeInput).min(1).max(200) }).strict();
export const updateNodeBody = z
  .object({ title: title.optional(), kind: z.enum(NODE_KINDS).optional(), status: z.enum(NODE_STATUSES).optional(), assignee: z.enum(ASSIGNEES).optional(), body: z.string().max(20_000).optional(), outcome: z.string().max(2_000).optional() })
  .strict();
export const moveNodeBody = z.object({ parentId: z.number().int().positive(), after }).strict();
export const resourceBody = z
  .object({
    nodeId: z.number().int().positive(),
    kind: z.enum(RESOURCE_KINDS),
    title,
    content: z.string().max(1_000_000).nullish(),
    path: z.string().max(1_000).nullish(),
    url: z.string().url().max(2_000).nullish(),
    sessionId: z.string().max(100).nullish(),
  })
  .strict();
export const resourcePatchBody = resourceBody.omit({ sessionId: true }).partial().strict();
export const logBody = z.object({ text: z.string().trim().min(1).max(2_000), sessionId: z.string().max(100).nullish() }).strict();
export const hookBody = z
  .object({
    event: z.enum(HOOK_EVENTS),
    source: z.string().max(40).optional(),
    cwd: z.string().max(1_000).optional(),
    branch: z.string().max(300).nullish(),
    transcriptPath: z.string().max(1_000).optional(),
    title: z.string().max(300).optional(),
    agentId: z.string().max(200).optional(),
    agentType: z.string().max(200).optional(),
    mentionsInProgress: z.boolean().optional(),
    asksStatus: z.boolean().optional(),
  })
  .strict();
export const enrollBody = z.object({ project: z.union([z.string().min(1), z.number().int().positive()]), title: z.string().max(300).optional() }).strict();
export const focusBody = z.object({ nodeId: z.number().int().positive().nullable() }).strict();
export const openBody = z.object({ resourceId: z.number().int().positive() }).strict();
```

- [ ] **Step 4: Create `src/server/open-path.ts`**

```ts
import { spawn, spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

/**
 * VS Code's real executable. On Windows `code` is a .cmd shim, and running it through cmd.exe
 * would let characters like & | % in a stored path execute commands, so we find Code.exe instead.
 */
export function findVsCode(): string | undefined {
  if (process.platform !== 'win32') {
    return spawnSync('which', ['code'], { stdio: 'ignore' }).status === 0 ? 'code' : undefined;
  }
  const where = spawnSync('where', ['code'], { encoding: 'utf8', windowsHide: true });
  const shims = where.status === 0 ? where.stdout.split(/\r?\n/).map((l) => l.trim()).filter(Boolean) : [];
  const candidates = shims.map((shim) => join(dirname(dirname(shim)), 'Code.exe'));
  if (process.env.LOCALAPPDATA) candidates.push(join(process.env.LOCALAPPDATA, 'Programs', 'Microsoft VS Code', 'Code.exe'));
  if (process.env.ProgramFiles) candidates.push(join(process.env.ProgramFiles, 'Microsoft VS Code', 'Code.exe'));
  return candidates.find((p) => existsSync(p));
}

/**
 * Open a file in VS Code, or reveal it in the file manager. No shell is involved and the file
 * never goes to the OS default handler, so nothing gets executed.
 */
export async function openInEditorOrReveal(path: string): Promise<void> {
  const target = resolve(path);
  const detached = { detached: true, stdio: 'ignore' as const, windowsHide: true };
  const code = findVsCode();
  if (code) {
    spawn(code, [target], detached).unref();
    return;
  }
  if (process.platform === 'win32') spawn('explorer.exe', [`/select,${target}`], detached).unref();
  else if (process.platform === 'darwin') spawn('open', ['-R', target], detached).unref();
  else spawn('xdg-open', [dirname(target)], detached).unref();
}
```

- [ ] **Step 5: Create `src/server/app.ts`**

```ts
import { timingSafeEqual } from 'node:crypto';
import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest, type FastifyServerOptions } from 'fastify';
import { ZodError } from 'zod';
import type { Ctx } from './db/tx';
import { ApiError } from './errors';
import { registerReadRoutes } from './routes/read';
import { registerSessionRoutes } from './routes/sessions';
import { registerUi } from './routes/ui';
import { registerWriteRoutes } from './routes/write';

export interface AppOptions {
  ctx: Ctx;
  token: string;
  uiToken: string;
  version: string;
  webDir?: string;
  logger?: FastifyServerOptions['logger'];
  onShutdown?: () => void;
  openPath?: (path: string) => Promise<void>;
}

export type Guard = (req: FastifyRequest, reply: FastifyReply) => Promise<unknown>;

const ALLOWED_HOSTS = new Set(['127.0.0.1', 'localhost', '[::1]']);

export const actorOf = (req: FastifyRequest): string => String(req.headers['x-inprogress-actor'] ?? 'system').slice(0, 120);

export function buildApp(opts: AppOptions): FastifyInstance {
  // 8 MiB: a 1,000,000-character resource grows past 2 MiB once JSON-escaped and UTF-8 encoded.
  const app = Fastify({ logger: opts.logger ?? false, bodyLimit: 8 * 1024 * 1024, forceCloseConnections: true });

  app.addHook('onRequest', async (req, reply) => {
    const host = (req.headers.host ?? '').toLowerCase().replace(/:\d+$/, '');
    if (!ALLOWED_HOSTS.has(host)) {
      reply.code(403).send({ error: 'Forbidden host' });
      return reply;
    }
  });

  // Fastify 5 types the handler's error as unknown unless told otherwise.
  app.setErrorHandler<Error & { statusCode?: number }>((err, _req, reply) => {
    if (err instanceof ApiError) return reply.code(err.status).send({ error: err.message, hint: err.hint });
    if (err instanceof ZodError) {
      return reply.code(400).send({ error: 'Invalid request', hint: err.issues.map((i) => `${i.path.join('.') || 'body'}: ${i.message}`).join('; ') });
    }
    const status = err.statusCode;
    if (status && status >= 400 && status < 500) return reply.code(status).send({ error: err.message });
    app.log.error(err);
    return reply.code(500).send({ error: err.message || 'Internal error' });
  });

  const expected = Buffer.from(`Bearer ${opts.token}`);
  const requireToken: Guard = async (req, reply) => {
    const got = Buffer.from(req.headers.authorization ?? '');
    if (got.length !== expected.length || !timingSafeEqual(got, expected)) {
      reply.code(401).send({ error: 'Missing or invalid InProgress token' });
      return reply;
    }
  };

  registerReadRoutes(app, opts.ctx, opts.version);
  registerWriteRoutes(app, opts.ctx, requireToken);
  registerSessionRoutes(app, opts.ctx, requireToken);
  registerUi(app, opts, requireToken);
  return app;
}
```

- [ ] **Step 6: Create the route modules**

`src/server/routes/read.ts`:
```ts
import type { FastifyInstance } from 'fastify';
import { buildIndex, renderOutline } from '../../core/tree';
import type { Ctx } from '../db/tx';
import { listBindings, listProjectSummaries, resolveProject } from '../repo/projects';
import { requireResource } from '../repo/resources';
import { search } from '../repo/search';
import { getNodeDetail, getProjectSnapshot } from '../repo/snapshot';
import { idParam, searchQuery } from '../schemas';

export function registerReadRoutes(app: FastifyInstance, ctx: Ctx, version: string): void {
  app.get('/api/health', async () => ({ ok: true, app: 'inprogress', version, pid: process.pid }));
  app.get('/api/projects', async () => listProjectSummaries(ctx));
  app.get('/api/projects/:ref', async (req) => getProjectSnapshot(ctx, (req.params as { ref: string }).ref));
  app.get('/api/projects/:ref/outline', async (req, reply) => {
    const snap = getProjectSnapshot(ctx, (req.params as { ref: string }).ref);
    const full = ['1', 'true'].includes(String((req.query as { full?: string }).full));
    const resourcesByNode = new Map<number, number[]>();
    for (const r of snap.resources) resourcesByNode.set(r.nodeId, [...(resourcesByNode.get(r.nodeId) ?? []), r.id]);
    const header = `Project ${snap.project.name} (slug ${snap.project.slug}${snap.project.status === 'archived' ? ', archived' : ''})`;
    const body = renderOutline(buildIndex(snap.nodes), snap.sessions, { full, resourcesByNode });
    return reply.type('text/plain; charset=utf-8').send(`${header}\n${body}`);
  });
  app.get('/api/nodes/:id', async (req) => getNodeDetail(ctx, idParam.parse(req.params).id));
  app.get('/api/resources/:id', async (req) => requireResource(ctx, idParam.parse(req.params).id));
  app.get('/api/bindings', async () => listBindings(ctx));
  app.get('/api/search', async (req) => {
    const q = searchQuery.parse(req.query);
    return search(ctx, resolveProject(ctx, q.project).id, q.q);
  });
}
```

`src/server/routes/write.ts`:
```ts
import type { FastifyInstance } from 'fastify';
import { actorOf, type Guard } from '../app';
import type { Ctx } from '../db/tx';
import { addLog } from '../repo/logs';
import { addNodes, deleteNode, moveNode, updateNode } from '../repo/nodes';
import { addBinding, createProject, removeBinding, updateProject } from '../repo/projects';
import { addResource, deleteResource, updateResource } from '../repo/resources';
import {
  addNodesBody, bindingBody, createProjectBody, idParam, logBody, moveNodeBody,
  resourceBody, resourcePatchBody, updateNodeBody, updateProjectBody,
} from '../schemas';

export function registerWriteRoutes(app: FastifyInstance, ctx: Ctx, requireToken: Guard): void {
  const guarded = { preHandler: requireToken };
  const ref = (params: unknown) => (params as { ref: string }).ref;

  app.post('/api/projects', guarded, async (req, reply) => reply.code(201).send(createProject(ctx, actorOf(req), createProjectBody.parse(req.body))));
  app.patch('/api/projects/:ref', guarded, async (req) => updateProject(ctx, actorOf(req), ref(req.params), updateProjectBody.parse(req.body)));
  app.post('/api/projects/:ref/bindings', guarded, async (req, reply) => {
    const body = bindingBody.parse(req.body);
    return reply.code(201).send(addBinding(ctx, actorOf(req), ref(req.params), body.path, body.branchPattern));
  });
  app.delete('/api/bindings/:id', guarded, async (req) => {
    removeBinding(ctx, actorOf(req), idParam.parse(req.params).id);
    return { ok: true };
  });
  app.post('/api/nodes', guarded, async (req, reply) => reply.code(201).send(addNodes(ctx, actorOf(req), addNodesBody.parse(req.body))));
  app.patch('/api/nodes/:id', guarded, async (req) => updateNode(ctx, actorOf(req), idParam.parse(req.params).id, updateNodeBody.parse(req.body)));
  app.post('/api/nodes/:id/move', guarded, async (req) => moveNode(ctx, actorOf(req), idParam.parse(req.params).id, moveNodeBody.parse(req.body)));
  app.delete('/api/nodes/:id', guarded, async (req) => {
    const cascade = ['1', 'true'].includes(String((req.query as { cascade?: string }).cascade));
    return deleteNode(ctx, actorOf(req), idParam.parse(req.params).id, cascade);
  });
  app.post('/api/resources', guarded, async (req, reply) => reply.code(201).send(addResource(ctx, actorOf(req), resourceBody.parse(req.body))));
  app.patch('/api/resources/:id', guarded, async (req) => updateResource(ctx, actorOf(req), idParam.parse(req.params).id, resourcePatchBody.parse(req.body)));
  app.delete('/api/resources/:id', guarded, async (req) => {
    deleteResource(ctx, actorOf(req), idParam.parse(req.params).id);
    return { ok: true };
  });
  app.post('/api/nodes/:id/log', guarded, async (req, reply) => {
    const body = logBody.parse(req.body);
    return reply.code(201).send(addLog(ctx, actorOf(req), idParam.parse(req.params).id, body.text, body.sessionId));
  });
}
```

`src/server/routes/sessions.ts`:
```ts
import type { FastifyInstance } from 'fastify';
import { actorOf, type Guard } from '../app';
import type { Ctx } from '../db/tx';
import { enrollBody, focusBody, hookBody, sessionParam } from '../schemas';
import { enrollSession, handleHookEvent, setFocus } from '../session-flow';

export function registerSessionRoutes(app: FastifyInstance, ctx: Ctx, requireToken: Guard): void {
  const guarded = { preHandler: requireToken };
  app.post('/api/sessions/:id/hook', guarded, async (req) => handleHookEvent(ctx, sessionParam.parse(req.params).id, hookBody.parse(req.body)));
  app.post('/api/sessions/:id/enroll', guarded, async (req) => {
    const body = enrollBody.parse(req.body);
    return enrollSession(ctx, actorOf(req), sessionParam.parse(req.params).id, body.project, body.title);
  });
  app.post('/api/sessions/:id/focus', guarded, async (req) => setFocus(ctx, actorOf(req), sessionParam.parse(req.params).id, focusBody.parse(req.body).nodeId));
}
```

`src/server/routes/ui.ts`:
```ts
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import fastifyStatic from '@fastify/static';
import type { FastifyInstance } from 'fastify';
import type { AppOptions, Guard } from '../app';
import { badRequest } from '../errors';
import { openInEditorOrReveal } from '../open-path';
import { requireResource } from '../repo/resources';
import { openBody } from '../schemas';

const TOKEN_META = /<meta name="ip-ui-token" content="[^"]*"\s*\/?>/;

export function registerUi(app: FastifyInstance, opts: AppOptions, requireToken: Guard): void {
  app.post('/api/admin/shutdown', { preHandler: requireToken }, async () => {
    setImmediate(() => opts.onShutdown?.());
    return { ok: true };
  });

  app.post('/api/ui/open', async (req, reply) => {
    if (req.headers['x-ip-ui-token'] !== opts.uiToken) {
      reply.code(401).send({ error: 'Missing or invalid UI token' });
      return reply;
    }
    const { resourceId } = openBody.parse(req.body);
    const resource = requireResource(opts.ctx, resourceId);
    if (!resource.path) throw badRequest(`r${resourceId} has no file path`);
    if (!existsSync(resource.path)) throw badRequest(`File not found: ${resource.path}`);
    await (opts.openPath ?? openInEditorOrReveal)(resource.path);
    return { ok: true };
  });

  const webDir = opts.webDir;
  if (!webDir || !existsSync(join(webDir, 'index.html'))) {
    app.get('/', async (_req, reply) => reply.code(503).type('text/plain; charset=utf-8').send('InProgress UI is not built. Run: npm run build'));
    return;
  }
  const html = readFileSync(join(webDir, 'index.html'), 'utf8').replace(TOKEN_META, `<meta name="ip-ui-token" content="${opts.uiToken}">`);
  app.get('/', async (_req, reply) => reply.type('text/html; charset=utf-8').header('cache-control', 'no-store').send(html));
  if (existsSync(join(webDir, 'assets'))) app.register(fastifyStatic, { root: join(webDir, 'assets'), prefix: '/assets/' });
}
```

- [ ] **Step 7: Run test to verify it passes**

Run: `npx vitest run test/server/app.test.ts`
Expected: PASS (7 tests). Then run the whole suite: `npx vitest run` → all green.

- [ ] **Step 8: Commit**

```bash
git add src/server test/server/app.test.ts
git commit -m "Add the HTTP API with host guard, token auth and validation

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 10: Live event stream, server entry point, backups, build config

**Files:**
- Create: `src/server/routes/sse.ts`, `src/server/backup.ts`, `src/server/main.ts`, `tsup.config.ts`
- Modify: `src/server/app.ts` (register SSE)
- Test: `test/server/sse.test.ts`, `test/server/backup.test.ts`

**Interfaces:**
- Consumes: `listEventsSince`, `maxEventId` (events.ts); `buildApp`; `openDb`, `createCtx`; `homeDir`, `port`, `baseUrl`, `ensureToken` (home.ts); `VERSION`.
- Produces: `registerSse(app, ctx)`; `backupDb(db, dir, keep?, stamp?): Promise<string>`, `timestamp(d?): string`, `truncateIfLarge(file, maxBytes)`; `dist/server/main.js` (starts the server, single instance); tsup entries for server, MCP, CLI and hooks.

- [ ] **Step 1: Write the failing tests**

`test/server/sse.test.ts`:
```ts
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import type { EventRow } from '../../src/core/types';
import { buildApp } from '../../src/server/app';
import { createProject } from '../../src/server/repo/projects';
import { makeCtx } from '../helpers';

const closers: (() => Promise<unknown>)[] = [];
afterEach(async () => { while (closers.length) await closers.pop()!(); });

async function listen() {
  const ctx = makeCtx();
  const app = buildApp({ ctx, token: 't', uiToken: 'u', version: 'test' });
  await app.listen({ port: 0, host: '127.0.0.1' });
  closers.push(() => app.close());
  return { ctx, base: `http://127.0.0.1:${(app.server.address() as AddressInfo).port}` };
}

/** Read SSE `data:` payloads until `count` events arrive. */
async function collect(url: string, count: number, during: () => void): Promise<EventRow[]> {
  const ac = new AbortController();
  const res = await fetch(url, { signal: ac.signal });
  const reader = res.body!.getReader();
  const decoder = new TextDecoder();
  const events: EventRow[] = [];
  let buffer = '';
  during();
  while (events.length < count) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let idx: number;
    while ((idx = buffer.indexOf('\n\n')) >= 0) {
      const chunk = buffer.slice(0, idx);
      buffer = buffer.slice(idx + 2);
      const data = chunk.split('\n').find((l) => l.startsWith('data: '));
      if (data) events.push(JSON.parse(data.slice(6)) as EventRow);
    }
  }
  ac.abort();
  return events;
}

describe('SSE stream', () => {
  it('streams live events after connecting', async () => {
    const { ctx, base } = await listen();
    const events = await collect(`${base}/api/events/stream`, 2, () => {
      setTimeout(() => createProject(ctx, 'test', { name: 'Live' }), 50);
    });
    expect(events.map((e) => e.type)).toEqual(['project.created', 'node.created']);
  });

  it('replays events after ?since before going live', async () => {
    const { ctx, base } = await listen();
    createProject(ctx, 'test', { name: 'Old' });
    const events = await collect(`${base}/api/events/stream?since=1`, 1, () => undefined);
    expect(events[0]).toMatchObject({ id: 2, type: 'node.created' });
  });
});
```

`test/server/backup.test.ts`:
```ts
import { existsSync, mkdtempSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { backupDb, timestamp, truncateIfLarge } from '../../src/server/backup';
import { openDb } from '../../src/server/db/connection';

describe('backups', () => {
  it('writes a restorable copy and keeps only the newest N', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ip-bak-'));
    const db = openDb(join(dir, 'live.db'));
    db.prepare("INSERT INTO meta (key, value) VALUES ('marker', 'yes')").run();
    for (let i = 1; i <= 4; i++) await backupDb(db, join(dir, 'backups'), 3, `20260927-00000${i}`);
    const files = readdirSync(join(dir, 'backups')).sort();
    expect(files).toEqual(['inprogress-20260927-000002.db', 'inprogress-20260927-000003.db', 'inprogress-20260927-000004.db']);
    const copy = openDb(join(dir, 'backups', files[2]));
    expect(copy.prepare("SELECT value FROM meta WHERE key = 'marker'").get()).toEqual({ value: 'yes' });
  });

  it('formats timestamps and truncates large logs', () => {
    expect(timestamp(new Date(2026, 8, 27, 7, 5, 9))).toBe('20260927-070509');
    const file = join(mkdtempSync(join(tmpdir(), 'ip-log-')), 'server.log');
    writeFileSync(file, 'x'.repeat(100));
    truncateIfLarge(file, 50);
    expect(statSync(file).size).toBe(0);
    truncateIfLarge(join(tmpdir(), 'missing-ip.log'), 50);
    expect(existsSync(join(tmpdir(), 'missing-ip.log'))).toBe(false);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run test/server/sse.test.ts test/server/backup.test.ts`
Expected: FAIL (stream route returns 404; backup module missing).

- [ ] **Step 3: Implement SSE and register it**

`src/server/routes/sse.ts`:
```ts
import type { FastifyInstance } from 'fastify';
import type { EventRow } from '../../core/types';
import type { Ctx } from '../db/tx';
import { listEventsSince, maxEventId } from '../repo/events';

export function registerSse(app: FastifyInstance, ctx: Ctx): void {
  app.get('/api/events/stream', (req, reply) => {
    const { since } = req.query as { since?: string };
    reply.hijack();
    const res = reply.raw;
    res.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache',
      connection: 'keep-alive',
      'x-accel-buffering': 'no',
    });
    res.write(': connected\n\n');
    const send = (e: EventRow) => res.write(`id: ${e.id}\ndata: ${JSON.stringify(e)}\n\n`);
    // Everything below runs synchronously, so no event can slip between the replay query and the subscription.
    let last = maxEventId(ctx);
    if (since !== undefined && /^\d+$/.test(since)) {
      const rows = listEventsSince(ctx, Number(since), 5000);
      rows.forEach(send);
      last = rows.length ? rows[rows.length - 1].id : Math.min(last, Number(since));
    }
    const onEvent = (e: EventRow) => {
      if (e.id > last) {
        last = e.id;
        send(e);
      }
    };
    ctx.bus.on('event', onEvent);
    const heartbeat = setInterval(() => res.write(': heartbeat\n\n'), 25_000);
    req.raw.on('close', () => {
      clearInterval(heartbeat);
      ctx.bus.off('event', onEvent);
    });
  });
}
```

In `src/server/app.ts`, add `import { registerSse } from './routes/sse';` and call `registerSse(app, opts.ctx);` right after `registerSessionRoutes(...)`.

- [ ] **Step 4: Implement backups**

`src/server/backup.ts`:
```ts
import { mkdirSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { DB } from './db/connection';

export function timestamp(d: Date = new Date()): string {
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

export async function backupDb(db: DB, dir: string, keep = 7, stamp: string = timestamp()): Promise<string> {
  mkdirSync(dir, { recursive: true });
  const file = join(dir, `inprogress-${stamp}.db`);
  await db.backup(file);
  const files = readdirSync(dir).filter((f) => /^inprogress-\d{8}-\d{6}\.db$/.test(f)).sort();
  for (const f of files.slice(0, Math.max(0, files.length - keep))) rmSync(join(dir, f), { force: true });
  return file;
}

export function truncateIfLarge(file: string, maxBytes: number): void {
  try {
    if (statSync(file).size > maxBytes) writeFileSync(file, '');
  } catch {
    // missing file: nothing to do
  }
}
```

- [ ] **Step 5: Run the tests**

Run: `npx vitest run test/server/sse.test.ts test/server/backup.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 6: Create the server entry `src/server/main.ts`**

```ts
import { randomBytes } from 'node:crypto';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { baseUrl, ensureToken, homeDir, port as configuredPort } from '../lib/home';
import { VERSION } from '../lib/version';
import { buildApp } from './app';
import { backupDb, truncateIfLarge } from './backup';
import { openDb } from './db/connection';
import { createCtx } from './db/tx';

type Probe = 'inprogress' | 'other' | 'free';

async function probe(url: string): Promise<Probe> {
  try {
    const res = await fetch(`${url}/api/health`, { signal: AbortSignal.timeout(800) });
    const body = (await res.json().catch(() => null)) as { app?: string } | null;
    return body?.app === 'inprogress' ? 'inprogress' : 'other';
  } catch {
    return 'free';
  }
}

async function main(): Promise<void> {
  const home = homeDir();
  mkdirSync(home, { recursive: true });
  const port = configuredPort();
  const url = baseUrl(port);
  const first = await probe(url);
  if (first === 'inprogress') return;
  if (first === 'other') {
    console.error(`InProgress: port ${port} is used by another program. Set INPROGRESS_PORT to pick another port.`);
    process.exitCode = 1;
    return;
  }
  const logFile = join(home, 'server.log');
  truncateIfLarge(logFile, 5 * 1024 * 1024);
  const token = ensureToken(home);
  const db = openDb(join(home, 'inprogress.db'));
  const ctx = createCtx(db);
  let closing = false;
  const app = buildApp({
    ctx,
    token,
    uiToken: randomBytes(16).toString('hex'),
    version: VERSION,
    webDir: fileURLToPath(new URL('../../web/dist', import.meta.url)),
    logger: { level: 'info', file: logFile },
    onShutdown: () => void shutdown(),
  });
  async function shutdown(): Promise<void> {
    if (closing) return;
    closing = true;
    await app.close().catch(() => undefined);
    db.close();
    rmSync(join(home, 'server.pid'), { force: true });
    process.exit(0);
  }
  try {
    await app.listen({ port, host: '127.0.0.1' });
  } catch (err) {
    db.close();
    // Two sessions starting together: whoever lost the race exits quietly if the winner is ours.
    if ((err as NodeJS.ErrnoException).code === 'EADDRINUSE' && (await probe(url)) === 'inprogress') return;
    console.error(`InProgress: could not listen on ${port}: ${(err as Error).message}`);
    process.exitCode = 1;
    return;
  }
  writeFileSync(join(home, 'server.pid'), String(process.pid));
  // Back up only once we own the port, so two racing starts never write the same backup file.
  await backupDb(db, join(home, 'backups'), 7).catch(() => undefined);
  process.on('SIGINT', () => void shutdown());
  process.on('SIGTERM', () => void shutdown());
}

void main();
```

- [ ] **Step 7: Create `tsup.config.ts` and build**

```ts
import { defineConfig } from 'tsup';

export default defineConfig({
  entry: {
    'server/main': 'src/server/main.ts',
    'mcp/main': 'src/mcp/main.ts',
    'cli/main': 'src/cli/main.ts',
    'hooks/hook': 'src/hooks/main.ts',
  },
  format: ['esm'],
  platform: 'node',
  target: 'node20',
  splitting: false,
  sourcemap: true,
  clean: true,
  outDir: 'dist',
});
```

`splitting: false` matters: each entry must be self-contained, because `ensureServer` locates `dist/server/main.js` relative to its own file via `import.meta.url`.

Until Tasks 12, 13 and 15 add their entries, build only the server:

Run: `npx tsup src/server/main.ts --format esm --platform node --target node20 --out-dir dist/server --no-splitting --clean`
Then: `INPROGRESS_HOME=.dev-home INPROGRESS_PORT=4319 node dist/server/main.js &` and `curl -s http://127.0.0.1:4319/api/health`
Expected: `{"ok":true,"app":"inprogress","version":"0.1.0","pid":<n>}`. Stop it with `kill %1`. Delete `.dev-home` afterwards.

- [ ] **Step 8: Commit**

```bash
git add src/server tsup.config.ts test/server
git commit -m "Add SSE stream, server entry point, DB backups and build config

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 11: HTTP client and server auto-start

**Files:**
- Create: `src/lib/client.ts`, `src/lib/ensure-server.ts`
- Test: `test/lib/client.test.ts`

**Interfaces:**
- Produces:
  - `ApiClientError(status, message, hint?)`
  - `createClient({ baseUrl, token?, timeoutMs? })` → `{ get<T>(path, o?), text(path, o?), post<T>(path, body, o?), patch<T>(path, body, o?), del<T>(path, o?) }` where `o = { actor?: string; timeoutMs?: number }`; `type Client`
  - `isServerUp(baseUrl, timeoutMs = 300): Promise<boolean>`, `serverEntry(): string`, `ensureServer({ baseUrl, entry?, waitMs? }): Promise<boolean>`

- [ ] **Step 1: Write the failing test**

`test/lib/client.test.ts`:
```ts
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ApiClientError, createClient } from '../../src/lib/client';
import { ensureServer, isServerUp } from '../../src/lib/ensure-server';
import { buildApp } from '../../src/server/app';
import { makeCtx } from '../helpers';

let base = '';
let close: () => Promise<unknown>;

beforeAll(async () => {
  const app = buildApp({ ctx: makeCtx(), token: 'tok', uiToken: 'u', version: 'test' });
  await app.listen({ port: 0, host: '127.0.0.1' });
  base = `http://127.0.0.1:${(app.server.address() as AddressInfo).port}`;
  close = () => app.close();
});
afterAll(() => close());

describe('client', () => {
  it('sends the token and actor, and parses JSON and text', async () => {
    const c = createClient({ baseUrl: base, token: 'tok' });
    const p = await c.post<{ slug: string; rootNodeId: number }>('/api/projects', { name: 'Client' }, { actor: 'scribe:s9' });
    expect(p.slug).toBe('client');
    expect(await c.text('/api/projects/client/outline')).toContain('Project Client');
    expect((await c.get<{ slug: string }[]>('/api/projects')).map((x) => x.slug)).toContain('client');
  });

  it('surfaces server errors with their hint', async () => {
    const c = createClient({ baseUrl: base, token: 'tok' });
    await expect(c.get('/api/projects/missing')).rejects.toMatchObject({ status: 404, message: 'Project "missing" not found' });
    await expect(createClient({ baseUrl: base }).post('/api/projects', { name: 'x' })).rejects.toMatchObject({ status: 401 });
  });

  it('reports an unreachable server clearly', async () => {
    const err = await createClient({ baseUrl: 'http://127.0.0.1:1', timeoutMs: 300 }).get('/api/health').catch((e) => e);
    expect(err).toBeInstanceOf(ApiClientError);
    expect(err.status).toBe(0);
    expect(err.message).toContain('unreachable');
  });
});

describe('ensureServer', () => {
  it('returns true without spawning when the server is up', async () => {
    expect(await isServerUp(base)).toBe(true);
    expect(await ensureServer({ baseUrl: base, entry: 'does-not-exist.js' })).toBe(true);
  });

  it('gives up after waitMs when the spawned server never answers', async () => {
    expect(await isServerUp('http://127.0.0.1:1')).toBe(false);
    const started = Date.now();
    expect(await ensureServer({ baseUrl: 'http://127.0.0.1:1', entry: 'does-not-exist.js', waitMs: 400 })).toBe(false);
    expect(Date.now() - started).toBeLessThan(3000);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/lib/client.test.ts`
Expected: FAIL, cannot resolve `../../src/lib/client`.

- [ ] **Step 3: Implement**

`src/lib/client.ts`:
```ts
export class ApiClientError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly hint?: string,
  ) {
    super(message);
    this.name = 'ApiClientError';
  }
}

export interface ClientOptions {
  baseUrl: string;
  token?: string;
  timeoutMs?: number;
}

export interface CallOptions {
  actor?: string;
  timeoutMs?: number;
}

export function createClient(opts: ClientOptions) {
  async function call(method: string, path: string, body: unknown, co: CallOptions, as: 'json' | 'text'): Promise<unknown> {
    const headers: Record<string, string> = {};
    if (body !== undefined) headers['content-type'] = 'application/json';
    if (opts.token) headers.authorization = `Bearer ${opts.token}`;
    if (co.actor) headers['x-inprogress-actor'] = co.actor;
    let res: Response;
    try {
      res = await fetch(`${opts.baseUrl}${path}`, {
        method,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(co.timeoutMs ?? opts.timeoutMs ?? 5000),
      });
    } catch (err) {
      throw new ApiClientError(0, `InProgress server unreachable at ${opts.baseUrl} (${(err as Error).message})`, 'Run `inprogress start`, or `inprogress doctor` to diagnose.');
    }
    const text = await res.text();
    if (!res.ok) {
      let payload: { error?: string; hint?: string } = {};
      try {
        payload = JSON.parse(text) as { error?: string; hint?: string };
      } catch {
        // not JSON
      }
      throw new ApiClientError(res.status, payload.error ?? `HTTP ${res.status}`, payload.hint);
    }
    if (as === 'text') return text;
    return text ? (JSON.parse(text) as unknown) : undefined;
  }
  return {
    get: <T>(path: string, co: CallOptions = {}) => call('GET', path, undefined, co, 'json') as Promise<T>,
    text: (path: string, co: CallOptions = {}) => call('GET', path, undefined, co, 'text') as Promise<string>,
    post: <T>(path: string, body: unknown, co: CallOptions = {}) => call('POST', path, body ?? {}, co, 'json') as Promise<T>,
    patch: <T>(path: string, body: unknown, co: CallOptions = {}) => call('PATCH', path, body, co, 'json') as Promise<T>,
    del: <T>(path: string, co: CallOptions = {}) => call('DELETE', path, undefined, co, 'json') as Promise<T>,
  };
}

export type Client = ReturnType<typeof createClient>;
```

`src/lib/ensure-server.ts`:
```ts
import { spawn } from 'node:child_process';
import { closeSync, mkdirSync, openSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { homeDir } from './home';

export async function isServerUp(baseUrl: string, timeoutMs = 300): Promise<boolean> {
  try {
    const res = await fetch(`${baseUrl}/api/health`, { signal: AbortSignal.timeout(timeoutMs) });
    if (!res.ok) return false;
    const body = (await res.json()) as { app?: string };
    return body.app === 'inprogress';
  } catch {
    return false;
  }
}

/** dist/server/main.js, resolved from the bundled entry that calls this (dist/<dir>/<file>.js). */
export function serverEntry(): string {
  return fileURLToPath(new URL('../server/main.js', import.meta.url));
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Start the server detached if it is not answering, then wait up to `waitMs` for health. */
export async function ensureServer(o: { baseUrl: string; entry?: string; waitMs?: number }): Promise<boolean> {
  if (await isServerUp(o.baseUrl)) return true;
  const home = homeDir();
  mkdirSync(home, { recursive: true });
  const out = openSync(join(home, 'server.log'), 'a');
  try {
    const child = spawn(process.execPath, [o.entry ?? serverEntry()], { detached: true, stdio: ['ignore', out, out], windowsHide: true, env: process.env });
    child.on('error', () => undefined);
    child.unref();
  } finally {
    closeSync(out);
  }
  const deadline = Date.now() + (o.waitMs ?? 2000);
  while (Date.now() < deadline) {
    await sleep(100);
    if (await isServerUp(o.baseUrl, 200)) return true;
  }
  return false;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/lib/client.test.ts`
Expected: PASS (5 tests). The failed spawn logs to `.test-home/server.log` (the vitest `env` from Task 1), never to the real `~/.inprogress`.

- [ ] **Step 5: Commit**

```bash
git add src/lib test/lib
git commit -m "Add the HTTP client and server auto-start

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 12: Scribe MCP server

**Files:**
- Create: `src/mcp/format.ts`, `src/mcp/server.ts`, `src/mcp/main.ts`
- Test: `test/mcp/server.test.ts`

**Interfaces:**
- Consumes: `Client`, `ApiClientError` (client.ts); `ensureServer`; `baseUrl`, `readToken`, `homeDir`; `appendLog`; core types; `VERSION`.
- Produces: `createMcpServer(client: Client): McpServer` exposing exactly these tools: `list_projects`, `get_outline`, `get_node`, `get_resource`, `search`, `create_project`, `update_project`, `bind_folder`, `unbind_folder`, `add_nodes`, `update_node`, `move_node`, `delete_node`, `add_resource`, `update_resource`, `delete_resource`, `add_log`, `enroll_session`, `set_focus`. Entry `dist/mcp/main.js` (stdio).

- [ ] **Step 1: Write the failing test**

`test/mcp/server.test.ts`:
```ts
import { mkdtempSync, writeFileSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createClient } from '../../src/lib/client';
import { createMcpServer } from '../../src/mcp/server';
import { buildApp } from '../../src/server/app';
import { makeCtx } from '../helpers';

let mcp: Client;
let close: () => Promise<unknown>;

beforeAll(async () => {
  const app = buildApp({ ctx: makeCtx(), token: 'tok', uiToken: 'u', version: 'test' });
  await app.listen({ port: 0, host: '127.0.0.1' });
  const base = `http://127.0.0.1:${(app.server.address() as AddressInfo).port}`;
  const server = createMcpServer(createClient({ baseUrl: base, token: 'tok' }));
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  await server.connect(serverSide);
  mcp = new Client({ name: 'test', version: '1' });
  await mcp.connect(clientSide);
  close = () => app.close();
});
afterAll(() => close());

async function call(name: string, args: Record<string, unknown> = {}) {
  const res = (await mcp.callTool({ name, arguments: args })) as { content: { text: string }[]; isError?: boolean };
  return { text: res.content.map((c) => c.text).join('\n'), isError: !!res.isError };
}
const ids = (text: string) => [...text.matchAll(/#(\d+)/g)].map((m) => Number(m[1]));
/** The leading #id of each line (formatCreated prints one created node per line). */
const lineIds = (text: string) => text.split('\n').map((l) => Number(/^#(\d+)/.exec(l)![1]));

describe('scribe MCP tools', () => {
  it('lists exactly the specified tools', async () => {
    const { tools } = await mcp.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual([
      'add_log', 'add_nodes', 'add_resource', 'bind_folder', 'create_project', 'delete_node', 'delete_resource',
      'enroll_session', 'get_node', 'get_outline', 'get_resource', 'list_projects', 'move_node', 'search',
      'set_focus', 'unbind_folder', 'update_node', 'update_project', 'update_resource',
    ]);
  });

  it('runs a scribe workflow end to end', async () => {
    const created = await call('create_project', { name: 'InGame', description: 'Game app', bind_path: 'C:/personal/InGame', session: 's1' });
    expect(created.text).toContain('Created project ingame');
    expect(created.text).toContain('Bound C:/personal/InGame');
    const rootId = ids(created.text)[0];

    const plan = await call('add_nodes', {
      parent: rootId, session: 's1',
      nodes: [{ title: 'Road to market', kind: 'phase', status: 'active', children: [{ title: 'Play app signing', status: 'active' }, { title: 'Run signing tests', assignee: 'me' }] }],
    });
    const [road, play, tests] = lineIds(plan.text);
    expect(plan.text).toContain('Run signing tests (task, todo, you)');

    expect((await call('update_node', { id: play, status: 'done', outcome: 'Configured', session: 's1' })).text).toBe(`#${play} Play app signing · done.`);

    const file = join(mkdtempSync(join(tmpdir(), 'ip-mcp-')), 'suite.md');
    writeFileSync(file, '# Signing tests\n- upload key accepted');
    const res = await call('add_resource', { node: tests, kind: 'test-suite', title: 'Signing suite', path: file, snapshot_file: true, session: 's1' });
    expect(res.text).toMatch(/^r\d+ "Signing suite" \(test-suite\) attached to #\d+ · 37 chars saved\.$/);
    const rid = Number(/^r(\d+)/.exec(res.text)![1]);
    expect((await call('get_resource', { id: rid })).text).toContain('# Signing tests');

    expect((await call('add_log', { node: road, text: 'Detour: sandbox wedge', session: 's1' })).text).toBe(`Logged on #${road}.`);
    expect((await call('enroll_session', { session: 's1', project: 'ingame', title: 'Launch' })).text).toContain('Session id: s1');
    expect((await call('set_focus', { session: 's1', node: tests })).text).toBe(`Focus → #${tests}.`);

    const outline = await call('get_outline', { project: 'ingame' });
    expect(outline.text).toContain(`#${tests} Run signing tests · NEEDS YOU [r${rid}]`);
    const node = await call('get_node', { id: road });
    expect(node.text).toContain('Detour: sandbox wedge');
    expect((await call('search', { project: 'ingame', query: 'upload key' })).text).toContain(`r${rid} Signing suite`);
    expect((await call('list_projects')).text).toMatch(/ingame · InGame \(active\) · root #\d+ · 1 need you/);
  });

  it('returns specific errors as tool errors', async () => {
    const missing = await call('update_node', { id: 99999, status: 'done' });
    expect(missing.isError).toBe(true);
    expect(missing.text).toContain('Node #99999 not found');
    const tooBig = join(mkdtempSync(join(tmpdir(), 'ip-mcp-')), 'big.md');
    writeFileSync(tooBig, 'x'.repeat(210 * 1024));
    const big = await call('add_resource', { node: 1, kind: 'doc', title: 'Big', path: tooBig, snapshot_file: true });
    expect(big.isError).toBe(true);
    expect(big.text).toContain('snapshot limit is 200 KB');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/mcp/server.test.ts`
Expected: FAIL, cannot resolve `../../src/mcp/server`.

- [ ] **Step 3: Implement `src/mcp/format.ts`**

```ts
import type { NodeDetail, Resource, SearchResult, TreeNode } from '../core/types';

export function formatCreated(nodes: TreeNode[]): string {
  return nodes
    .map((n) => `#${n.id} ${n.title} (${n.kind}, ${n.status}${n.assignee === 'me' ? ', you' : ''}) under #${n.parentId}`)
    .join('\n');
}

export function formatNodeDetail(d: NodeDetail): string {
  const n = d.node;
  const lines = [`#${n.id} ${n.title} (${n.kind}) · ${n.status}, ${n.assignee === 'me' ? 'assigned to Aiden' : 'Claude'}`];
  if (d.parent) lines.push(`Parent: #${d.parent.id} ${d.parent.title}`);
  if (n.body) lines.push(`Body:\n${n.body}`);
  if (n.outcome) lines.push(`Outcome: ${n.outcome}`);
  if (d.children.length) lines.push('Children:', ...d.children.map((c) => `  #${c.id} ${c.title} · ${c.status}${c.assignee === 'me' ? ' (you)' : ''}`));
  if (d.resources.length) lines.push('Resources:', ...d.resources.map((r) => `  r${r.id} ${r.title} (${r.kind})${r.path ? ` ${r.path}` : ''}`));
  if (d.log.length) lines.push('Log:', ...d.log.map((l) => `  ${l.createdAt} ${l.text}`));
  return lines.join('\n');
}

export function formatResource(r: Resource): string {
  const lines = [`r${r.id} ${r.title} (${r.kind}) on #${r.nodeId}`];
  if (r.path) lines.push(`Path: ${r.path}`);
  if (r.url) lines.push(`URL: ${r.url}`);
  if (r.content) lines.push('Content:', r.content);
  return lines.join('\n');
}

export function formatSearch(s: SearchResult): string {
  if (!s.nodes.length && !s.resources.length) return 'No matches.';
  return [
    ...s.nodes.map((n) => `#${n.id} ${n.title} · ${n.status}`),
    ...s.resources.map((r) => `r${r.id} ${r.title} (${r.kind}) on #${r.nodeId}`),
  ].join('\n');
}
```

- [ ] **Step 4: Implement `src/mcp/server.ts`**

```ts
import { readFileSync, statSync } from 'node:fs';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import {
  ASSIGNEES, NODE_KINDS, NODE_STATUSES, RESOURCE_KINDS,
  type Binding, type LogEntry, type NodeDetail, type NodeInput, type Project, type ProjectSummary, type Resource, type SearchResult, type TreeNode,
} from '../core/types';
import { ApiClientError, type Client } from '../lib/client';
import { VERSION } from '../lib/version';
import { formatCreated, formatNodeDetail, formatResource, formatSearch } from './format';

const SNAPSHOT_LIMIT = 200 * 1024;

type ToolResult = { content: { type: 'text'; text: string }[]; isError?: boolean };
const ok = (text: string): ToolResult => ({ content: [{ type: 'text', text }] });
const fail = (err: unknown): ToolResult => {
  const text = err instanceof ApiClientError ? (err.hint ? `${err.message}. ${err.hint}` : err.message) : err instanceof Error ? err.message : String(err);
  return { isError: true, content: [{ type: 'text', text }] };
};
const actor = (session?: string) => (session ? `scribe:${session}` : 'scribe');
const enc = encodeURIComponent;

const nodeInputSchema: z.ZodType<NodeInput> = z.lazy(() =>
  z.object({
    title: z.string().min(1).max(200),
    kind: z.enum(NODE_KINDS).optional(),
    status: z.enum(NODE_STATUSES).optional(),
    assignee: z.enum(ASSIGNEES).optional(),
    body: z.string().optional(),
    outcome: z.string().optional(),
    children: z.array(nodeInputSchema).optional(),
  }),
);
const after = z.union([z.number().int().positive(), z.enum(['start', 'end'])]).optional().describe('Insert after this sibling #id, or "start" / "end" (default end)');
const session = z.string().optional().describe('The Claude session id from the brief. Always pass it on writes.');
const id = z.number().int().positive();

export function createMcpServer(client: Client): McpServer {
  const server = new McpServer({ name: 'inprogress', version: VERSION });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const tool = (name: string, description: string, shape: z.ZodRawShape, run: (args: any) => Promise<string>) => {
    server.registerTool(name, { description, inputSchema: shape }, async (args: unknown) => {
      try {
        return ok(await run(args));
      } catch (err) {
        return fail(err);
      }
    });
  };

  tool('list_projects', 'List projects with needs-you counts, live sessions and folder bindings (binding ids are for unbind_folder).', {}, async () => {
    const [projects, bindings] = await Promise.all([client.get<ProjectSummary[]>('/api/projects'), client.get<Binding[]>('/api/bindings')]);
    if (!projects.length) return 'No projects yet.';
    return projects
      .map((p) => {
        const own = bindings.filter((b) => b.projectId === p.id).map((b) => `  binding ${b.id}: ${b.path}${b.branchPattern ? ` [branch ${b.branchPattern}]` : ''}`);
        return [`${p.slug} · ${p.name} (${p.status}) · root #${p.rootNodeId} · ${p.needsYou} need you · ${p.activeSessions} session(s)`, ...own].join('\n');
      })
      .join('\n');
  });

  tool('get_outline', 'Outline of a project tree with #ids, statuses, assignees and resource ids. Finished branches are folded unless full is true.', { project: z.string().describe('slug, name or id'), full: z.boolean().optional() },
    async (a: { project: string; full?: boolean }) => client.text(`/api/projects/${enc(a.project)}/outline${a.full ? '?full=1' : ''}`));

  tool('get_node', 'One node with its parent, children, resources and recent log.', { id },
    async (a: { id: number }) => formatNodeDetail(await client.get<NodeDetail>(`/api/nodes/${a.id}`)));

  tool('get_resource', 'A resource including its saved content.', { id },
    async (a: { id: number }) => formatResource(await client.get<Resource>(`/api/resources/${a.id}`)));

  tool('search', 'Find nodes and resources in a project by text.', { project: z.string(), query: z.string().min(1) },
    async (a: { project: string; query: string }) => formatSearch(await client.get<SearchResult>(`/api/search?project=${enc(a.project)}&q=${enc(a.query)}`)));

  tool('create_project', 'Create a project with its root node, optionally binding a folder (and git branch glob) so sessions there are tracked automatically.',
    { name: z.string().min(1), description: z.string(), playbook: z.string().optional(), slug: z.string().optional(), bind_path: z.string().optional(), branch_pattern: z.string().optional(), session },
    async (a: { name: string; description: string; playbook?: string; slug?: string; bind_path?: string; branch_pattern?: string; session?: string }) => {
      const p = await client.post<Project>('/api/projects', { name: a.name, description: a.description, playbook: a.playbook, slug: a.slug }, { actor: actor(a.session) });
      const lines = [`Created project ${p.slug} "${p.name}" (root #${p.rootNodeId}).`];
      if (a.bind_path) {
        const b = await client.post<Binding>(`/api/projects/${enc(p.slug)}/bindings`, { path: a.bind_path, branchPattern: a.branch_pattern ?? null }, { actor: actor(a.session) });
        lines.push(`Bound ${b.path}${b.branchPattern ? ` [branch ${b.branchPattern}]` : ''} (binding ${b.id}).`);
      }
      return lines.join('\n');
    });

  tool('update_project', 'Rename a project, change its description or playbook, or archive / unarchive it.',
    { project: z.string(), name: z.string().optional(), description: z.string().optional(), playbook: z.string().optional(), status: z.enum(['active', 'archived']).optional(), session },
    async ({ project, session: s, ...patch }: { project: string; session?: string; name?: string; description?: string; playbook?: string; status?: 'active' | 'archived' }) => {
      const p = await client.patch<Project>(`/api/projects/${enc(project)}`, patch, { actor: actor(s) });
      return `Updated project ${p.slug} (${p.status}).`;
    });

  tool('bind_folder', 'Bind a folder, optionally with a git branch glob like *VCAD-978*, so sessions started there are tracked.', { project: z.string(), path: z.string(), branch_pattern: z.string().optional(), session },
    async (a: { project: string; path: string; branch_pattern?: string; session?: string }) => {
      const b = await client.post<Binding>(`/api/projects/${enc(a.project)}/bindings`, { path: a.path, branchPattern: a.branch_pattern ?? null }, { actor: actor(a.session) });
      return `Binding ${b.id}: ${b.path}${b.branchPattern ? ` [branch ${b.branchPattern}]` : ''} → ${a.project}.`;
    });

  tool('unbind_folder', 'Remove a folder binding by id (list_projects shows ids).', { binding_id: id, session },
    async (a: { binding_id: number; session?: string }) => {
      await client.del(`/api/bindings/${a.binding_id}`, { actor: actor(a.session) });
      return `Removed binding ${a.binding_id}.`;
    });

  tool('add_nodes', 'Add one node or a whole nested plan under a parent #id. Defaults: kind task, status todo, assignee claude. Use assignee "me" for anything Aiden must do.',
    { parent: id, nodes: z.array(nodeInputSchema).min(1), after, session },
    async (a: { parent: number; nodes: NodeInput[]; after?: number | 'start' | 'end'; session?: string }) =>
      formatCreated(await client.post<TreeNode[]>('/api/nodes', { parentId: a.parent, after: a.after, nodes: a.nodes }, { actor: actor(a.session) })));

  tool('update_node', "Change a node's title, kind, status, assignee, body or outcome. Set outcome when something finishes.",
    { id, title: z.string().optional(), kind: z.enum(NODE_KINDS).optional(), status: z.enum(NODE_STATUSES).optional(), assignee: z.enum(ASSIGNEES).optional(), body: z.string().optional(), outcome: z.string().optional(), session },
    async ({ id: nodeId, session: s, ...patch }: { id: number; session?: string } & Record<string, unknown>) => {
      const n = await client.patch<TreeNode>(`/api/nodes/${nodeId}`, patch, { actor: actor(s) });
      return `#${n.id} ${n.title} · ${n.status}${n.assignee === 'me' ? ' (you)' : ''}.`;
    });

  tool('move_node', 'Move a node and its subtree under a new parent, optionally after a sibling.', { id, parent: id, after, session },
    async (a: { id: number; parent: number; after?: number | 'start' | 'end'; session?: string }) => {
      const n = await client.post<TreeNode>(`/api/nodes/${a.id}/move`, { parentId: a.parent, after: a.after }, { actor: actor(a.session) });
      return `Moved #${n.id} under #${n.parentId}.`;
    });

  tool('delete_node', 'Delete a node created by mistake. For abandoned work prefer status "dropped". cascade=true also deletes its subtree.', { id, cascade: z.boolean().optional(), session },
    async (a: { id: number; cascade?: boolean; session?: string }) => {
      const r = await client.del<{ ids: number[] }>(`/api/nodes/${a.id}${a.cascade ? '?cascade=1' : ''}`, { actor: actor(a.session) });
      return `Deleted ${r.ids.map((i) => `#${i}`).join(', ')}.`;
    });

  tool('add_resource', 'Attach a resource to the node where it was produced. Give a path (with snapshot_file=true for text files up to 200 KB), a url, or content.',
    { node: id, kind: z.enum(RESOURCE_KINDS), title: z.string().min(1), content: z.string().optional(), path: z.string().optional(), url: z.string().optional(), snapshot_file: z.boolean().optional(), session },
    async (a: { node: number; kind: string; title: string; content?: string; path?: string; url?: string; snapshot_file?: boolean; session?: string }) => {
      let content = a.content;
      if (a.snapshot_file) {
        if (!a.path) throw new Error('snapshot_file needs a path');
        const size = statSync(a.path).size;
        if (size > SNAPSHOT_LIMIT) throw new Error(`${a.path} is ${Math.round(size / 1024)} KB; the snapshot limit is 200 KB. Attach it by path only.`);
        content = readFileSync(a.path, 'utf8');
      }
      const r = await client.post<Resource>('/api/resources', { nodeId: a.node, kind: a.kind, title: a.title, content: content ?? null, path: a.path ?? null, url: a.url ?? null, sessionId: a.session ?? null }, { actor: actor(a.session) });
      return `r${r.id} "${r.title}" (${r.kind}) attached to #${r.nodeId}${r.contentLength ? ` · ${r.contentLength} chars saved` : ''}.`;
    });

  tool('update_resource', 'Edit a resource or move it to another node in the same project.',
    { id, node: id.optional(), kind: z.enum(RESOURCE_KINDS).optional(), title: z.string().optional(), content: z.string().optional(), path: z.string().optional(), url: z.string().optional(), session },
    async ({ id: rid, node, session: s, ...patch }: { id: number; node?: number; session?: string } & Record<string, unknown>) => {
      const r = await client.patch<Resource>(`/api/resources/${rid}`, { ...patch, nodeId: node }, { actor: actor(s) });
      return `r${r.id} "${r.title}" on #${r.nodeId}.`;
    });

  tool('delete_resource', 'Delete a resource.', { id, session }, async (a: { id: number; session?: string }) => {
    await client.del(`/api/resources/${a.id}`, { actor: actor(a.session) });
    return `Deleted r${a.id}.`;
  });

  tool('add_log', 'Add a timeline note to a node: detours, context, decisions made along the way.', { node: id, text: z.string().min(1), session },
    async (a: { node: number; text: string; session?: string }) => {
      const l = await client.post<LogEntry>(`/api/nodes/${a.node}/log`, { text: a.text, sessionId: a.session ?? null }, { actor: actor(a.session) });
      return `Logged on #${l.nodeId}.`;
    });

  tool('enroll_session', 'Track a Claude session in a project (also repoints a session bound to the wrong project). Returns the project briefing.', { session: z.string().min(1), project: z.string(), title: z.string().optional() },
    async (a: { session: string; project: string; title?: string }) => {
      const r = await client.post<{ briefing: string }>(`/api/sessions/${enc(a.session)}/enroll`, { project: a.project, title: a.title }, { actor: actor(a.session) });
      return r.briefing;
    });

  tool('set_focus', 'Set which node a session is working on (null clears it). Drives the session badge in the UI.', { session: z.string().min(1), node: id.nullable() },
    async (a: { session: string; node: number | null }) => {
      await client.post(`/api/sessions/${enc(a.session)}/focus`, { nodeId: a.node }, { actor: actor(a.session) });
      return a.node === null ? 'Focus cleared.' : `Focus → #${a.node}.`;
    });

  return server;
}
```

- [ ] **Step 5: Implement the stdio entry `src/mcp/main.ts`**

```ts
import { join } from 'node:path';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { createClient } from '../lib/client';
import { ensureServer } from '../lib/ensure-server';
import { baseUrl, homeDir, readToken } from '../lib/home';
import { appendLog } from '../lib/log';
import { createMcpServer } from './server';

async function main(): Promise<void> {
  const url = baseUrl();
  // stdout belongs to the MCP protocol: never print here.
  await ensureServer({ baseUrl: url, waitMs: 3000 }).catch((err) => appendLog(join(homeDir(), 'hooks.log'), `mcp ensureServer: ${String(err)}`));
  const server = createMcpServer(createClient({ baseUrl: url, token: readToken() }));
  await server.connect(new StdioServerTransport());
}

void main();
```

- [ ] **Step 6: Run test to verify it passes**

Run: `npx vitest run test/mcp/server.test.ts`
Expected: PASS (3 tests). If the SDK version installed in Task 1 exposes `server.tool(name, description, shape, cb)` but not `registerTool`, replace the one `server.registerTool(...)` call inside `tool()` with `server.tool(name, description, shape, async (args: unknown) => …)`; nothing else changes.

- [ ] **Step 7: Commit**

```bash
git add src/mcp test/mcp
git commit -m "Add the scribe MCP server

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 13: Hook scripts

**Files:**
- Create: `src/hooks/handlers.ts`, `src/hooks/main.ts`
- Test: `test/hooks/handlers.test.ts`

**Interfaces:**
- Consumes: `detectBranch`, `readTranscriptTitle`, `createClient`, `ensureServer`, `baseUrl`, `homeDir`, `readToken`, `appendLog`.
- Produces:
  - `HOOK_NAMES = ['session-start','prompt-submit','stop','notification','subagent-start','subagent-stop','session-end']`, `type HookName`
  - `CONTEXT_EVENT_NAME: Partial<Record<HookName, string>>` (`SessionStart`, `UserPromptSubmit`)
  - `stripPasted(prompt): string`, `buildHookBody(name, input): Record<string, unknown>`
  - `runHandler(name, input, deps: { post(path, body): Promise<{ tracked: boolean; context?: string }>; ensureServer(): Promise<boolean> }): Promise<string | undefined>`
  - Entry `dist/hooks/hook.js <hook-name>`: reads stdin JSON, prints `{"hookSpecificOutput":{"hookEventName","additionalContext"}}` when there is context, always exits 0.

- [ ] **Step 1: Write the failing test**

`test/hooks/handlers.test.ts`:
```ts
import { mkdtempSync, writeFileSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildHookBody, runHandler, stripPasted, type HookName } from '../../src/hooks/handlers';
import { createClient } from '../../src/lib/client';
import { buildApp } from '../../src/server/app';
import { addNodes } from '../../src/server/repo/nodes';
import { addBinding, createProject } from '../../src/server/repo/projects';
import { findSession } from '../../src/server/repo/sessions';
import type { Ctx } from '../../src/server/db/tx';
import { makeCtx } from '../helpers';

let ctx: Ctx;
let close: () => Promise<unknown>;
let deps: Parameters<typeof runHandler>[2];
const bound = 'C:/personal/HookDemo';

beforeAll(async () => {
  ctx = makeCtx();
  const p = createProject(ctx, 'test', { name: 'HookDemo' });
  addBinding(ctx, 'test', p.slug, bound);
  addNodes(ctx, 'test', { parentId: p.rootNodeId, nodes: [{ title: 'Step one', status: 'active' }, { title: 'Run the tests', assignee: 'me' }] });
  const app = buildApp({ ctx, token: 'tok', uiToken: 'u', version: 'test' });
  await app.listen({ port: 0, host: '127.0.0.1' });
  const client = createClient({ baseUrl: `http://127.0.0.1:${(app.server.address() as AddressInfo).port}`, token: 'tok' });
  deps = { post: (path, body) => client.post(path, body), ensureServer: async () => true };
  close = () => app.close();
});
afterAll(() => close());

const run = (name: HookName, input: Record<string, unknown>) => runHandler(name, input, deps);

describe('buildHookBody', () => {
  it('strips pasted blocks before matching', () => {
    expect(stripPasted('hi <pasted_content id="x">track InProgress</pasted_content> there')).toBe('hi  there');
    expect(buildHookBody('prompt-submit', { session_id: 's', prompt: '<pasted_content a>InProgress spec</pasted_content>' })).toMatchObject({ mentionsInProgress: false });
    expect(buildHookBody('prompt-submit', { session_id: 's', prompt: "What's next?" })).toMatchObject({ asksStatus: true, mentionsInProgress: false });
  });

  it('prefers session_title and falls back to the transcript title', () => {
    const file = join(mkdtempSync(join(tmpdir(), 'ip-hook-')), 't.jsonl');
    writeFileSync(file, `${JSON.stringify({ type: 'custom-title', customTitle: 'From transcript' })}\n`);
    expect(buildHookBody('session-start', { session_id: 's', cwd: bound, session_title: 'From hook', transcript_path: file }).title).toBe('From hook');
    expect(buildHookBody('stop', { session_id: 's', transcript_path: file }).title).toBe('From transcript');
  });
});

describe('runHandler', () => {
  it('briefs a session started in a bound folder and ignores others', async () => {
    const brief = await run('session-start', { session_id: 'h1', cwd: `${bound}/src`, source: 'startup', session_title: 'Hook session' });
    expect(brief).toContain('tracked in project "HookDemo"');
    expect(brief).toContain('Session id: h1');
    expect(findSession(ctx, 'h1')?.title).toBe('Hook session');
    expect(await run('session-start', { session_id: 'h2', cwd: 'C:/elsewhere', source: 'startup' })).toBeUndefined();
    expect(findSession(ctx, 'h2')).toBeUndefined();
  });

  it('hints untracked sessions only on a direct mention', async () => {
    expect(await run('prompt-submit', { session_id: 'h3', prompt: '<pasted_content>InProgress</pasted_content>' })).toBeUndefined();
    expect(await run('prompt-submit', { session_id: 'h3', prompt: 'track this in InProgress please' })).toContain('Session id: h3');
  });

  it('answers status questions and updates states', async () => {
    await run('session-start', { session_id: 'h4', cwd: bound, source: 'startup' });
    expect(await run('prompt-submit', { session_id: 'h4', prompt: 'where are we?' })).toContain('Where things stand in HookDemo');
    await run('notification', { session_id: 'h4' });
    expect(findSession(ctx, 'h4')?.state).toBe('permission');
    await run('subagent-start', { session_id: 'h4', agent_id: 'ag1', agent_type: 'Explore' });
    expect(findSession(ctx, 'h4')).toMatchObject({ state: 'working', subagents: [{ agentId: 'ag1', agentType: 'Explore' }] });
    await run('subagent-stop', { session_id: 'h4', agent_id: 'ag1', agent_type: 'Explore' });
    await run('stop', { session_id: 'h4' });
    await run('session-end', { session_id: 'h4' });
    expect(findSession(ctx, 'h4')).toMatchObject({ state: 'ended', subagents: [] });
  });

  it('does nothing without a session id', async () => {
    let posted = false;
    const r = await runHandler('stop', {}, { post: async () => { posted = true; return { tracked: false }; }, ensureServer: async () => true });
    expect(r).toBeUndefined();
    expect(posted).toBe(false);
  });

  it('never returns context for events that cannot inject it', async () => {
    await run('session-start', { session_id: 'h5', cwd: bound, source: 'startup' });
    expect(await run('stop', { session_id: 'h5' })).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/hooks/handlers.test.ts`
Expected: FAIL, cannot resolve `../../src/hooks/handlers`.

- [ ] **Step 3: Implement `src/hooks/handlers.ts`**

```ts
import type { HookEvent } from '../core/types';
import { detectBranch } from '../lib/git';
import { readTranscriptTitle } from '../lib/transcript';

export const HOOK_NAMES = ['session-start', 'prompt-submit', 'stop', 'notification', 'subagent-start', 'subagent-stop', 'session-end'] as const;
export type HookName = (typeof HOOK_NAMES)[number];

const EVENT_FOR: Record<HookName, HookEvent> = {
  'session-start': 'start',
  'prompt-submit': 'prompt',
  stop: 'stop',
  notification: 'permission',
  'subagent-start': 'subagent-start',
  'subagent-stop': 'subagent-stop',
  'session-end': 'end',
};

export const CONTEXT_EVENT_NAME: Partial<Record<HookName, string>> = {
  'session-start': 'SessionStart',
  'prompt-submit': 'UserPromptSubmit',
};

export interface HookStdin {
  session_id?: string;
  transcript_path?: string;
  cwd?: string;
  source?: string;
  session_title?: string;
  prompt?: string;
  agent_id?: string;
  agent_type?: string;
  [key: string]: unknown;
}

export interface HookDeps {
  post: (path: string, body: unknown) => Promise<{ tracked: boolean; context?: string }>;
  ensureServer: () => Promise<boolean>;
}

const MENTIONS = /\binprogress\b/i;
const ASKS_STATUS = /\b(where are we|where were we|what'?s next|what'?s left|status update|project status|progress so far)\b/i;

export function stripPasted(prompt: string): string {
  return prompt.replace(/<pasted_content\b[^>]*>[\s\S]*?<\/pasted_content>/gi, '');
}

export function buildHookBody(name: HookName, input: HookStdin): Record<string, unknown> {
  const body: Record<string, unknown> = { event: EVENT_FOR[name] };
  if (input.transcript_path) body.transcriptPath = input.transcript_path;
  if (name === 'session-start') {
    if (input.source) body.source = input.source;
    if (input.cwd) {
      body.cwd = input.cwd;
      body.branch = detectBranch(input.cwd) ?? null;
    }
  }
  if (name === 'session-start' || name === 'prompt-submit' || name === 'stop') {
    const title = (typeof input.session_title === 'string' && input.session_title.trim()) || (input.transcript_path ? readTranscriptTitle(input.transcript_path) : undefined);
    if (title) body.title = title;
  }
  if (name === 'prompt-submit') {
    const prompt = stripPasted(typeof input.prompt === 'string' ? input.prompt : '');
    body.mentionsInProgress = MENTIONS.test(prompt);
    body.asksStatus = ASKS_STATUS.test(prompt);
  }
  if (name === 'subagent-start' || name === 'subagent-stop') {
    if (input.agent_id) body.agentId = input.agent_id;
    if (typeof input.agent_type === 'string') body.agentType = input.agent_type;
  }
  return body;
}

export async function runHandler(name: HookName, input: HookStdin, deps: HookDeps): Promise<string | undefined> {
  if (!input.session_id) return undefined;
  if (name === 'session-start') await deps.ensureServer();
  const result = await deps.post(`/api/sessions/${encodeURIComponent(input.session_id)}/hook`, buildHookBody(name, input));
  return CONTEXT_EVENT_NAME[name] ? result.context : undefined;
}
```

- [ ] **Step 4: Implement the entry `src/hooks/main.ts`**

```ts
import { join } from 'node:path';
import { createClient } from '../lib/client';
import { ensureServer } from '../lib/ensure-server';
import { baseUrl, homeDir, readToken } from '../lib/home';
import { appendLog } from '../lib/log';
import { CONTEXT_EVENT_NAME, HOOK_NAMES, runHandler, type HookName, type HookStdin } from './handlers';

function readStdin(timeoutMs: number): Promise<string> {
  return new Promise((resolve) => {
    let data = '';
    const timer = setTimeout(() => resolve(data), timeoutMs);
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (chunk) => (data += chunk));
    process.stdin.on('end', () => {
      clearTimeout(timer);
      resolve(data);
    });
    process.stdin.on('error', () => {
      clearTimeout(timer);
      resolve(data);
    });
  });
}

function writeStdout(text: string): Promise<void> {
  return new Promise((resolve) => process.stdout.write(text, () => resolve()));
}

async function main(): Promise<void> {
  const name = process.argv[2] as HookName;
  const logFile = join(homeDir(), 'hooks.log');
  if (!(HOOK_NAMES as readonly string[]).includes(name)) {
    appendLog(logFile, `unknown hook "${String(name)}"`);
    return;
  }
  // Total budget: session-start 3 s (up to 2 s spawning the server + 1 s for the POST), others 500 ms.
  const budget = name === 'session-start' ? 3000 : 500;
  const postTimeout = name === 'session-start' ? 1000 : 500;
  const work = (async () => {
    const raw = await readStdin(1000);
    const input = JSON.parse(raw || '{}') as HookStdin;
    const url = baseUrl();
    const context = await runHandler(name, input, {
      ensureServer: () => ensureServer({ baseUrl: url, waitMs: 2000 }),
      // Read the token lazily: the first server start creates it.
      post: (path, body) => createClient({ baseUrl: url, token: readToken(), timeoutMs: postTimeout }).post(path, body),
    });
    const eventName = CONTEXT_EVENT_NAME[name];
    if (context && eventName) await writeStdout(JSON.stringify({ hookSpecificOutput: { hookEventName: eventName, additionalContext: context } }));
  })();
  work.catch((err) => appendLog(logFile, `${name}: ${(err as Error).message}`));
  await Promise.race([work.catch(() => undefined), new Promise((r) => setTimeout(r, budget + 250))]);
}

main()
  .catch(() => undefined)
  .finally(() => process.exit(0));
```

- [ ] **Step 5: Run test to verify it passes**

Run: `npx vitest run test/hooks/handlers.test.ts`
Expected: PASS (7 tests).

- [ ] **Step 6: Commit**

```bash
git add src/hooks test/hooks
git commit -m "Add hook scripts for session presence and briefings

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 14: Claude kit (scribe agent, skill) and the settings installer

**Files:**
- Create: `claude/agents/inprogress-scribe.md`, `claude/skills/inprogress/SKILL.md`, `src/cli/claude-config.ts`
- Test: `test/cli/claude-config.test.ts`

**Interfaces:**
- Consumes: `HookName` (handlers.ts).
- Produces:
  - `ALLOW_RULES = ['mcp__inprogress', 'Edit(~/.inprogress/resources/**)']`, `HOOK_SCRIPT_SUFFIX = '/dist/hooks/hook.js'`
  - `HookDef = { event: string; name: HookName; matcher?: string; timeout: number }`, `HOOK_DEFS: HookDef[]`
  - `claudeDir(): string` (honours `INPROGRESS_CLAUDE_DIR`), `repoRoot(): string`
  - `hookEntry(repo, name, timeout)`, `isInProgressHook(entry): boolean`, `stripInProgressHooks(settings)`, `addInProgressHooks(settings, repo)`, `addAllowRules(settings)`, `removeAllowRules(settings)`, `renderTemplate(text, repo)`
  - `install({ repo, claudeDir, stamp }): { log: string[]; agentsDirCreated: boolean }`, `uninstall({ claudeDir, stamp }): string[]`

- [ ] **Step 1: Create the scribe agent template `claude/agents/inprogress-scribe.md`**

```markdown
---
name: inprogress-scribe
description: Records progress in the InProgress task tree (projects, plan steps, statuses, resources, session focus) when an InProgress briefing or the inprogress skill asks for an update. Runs in the background and returns a one-line summary.
model: sonnet
effort: low
maxTurns: 15
background: true
color: orange
tools: mcp__inprogress
mcpServers:
  - inprogress:
      type: stdio
      command: "{{NODE}}"
      args: ["{{REPO}}/dist/mcp/main.js"]
---

You are the InProgress scribe. You keep a project's task tree accurate by applying the brief you are given, using the `inprogress` tools. You run in the background; your final message reaches the main session as a notification, so keep it to one line.

## Applying a brief

1. The brief names the session id and the project slug.
2. Call `get_outline` for the project (or `search`) and resolve every reference in the brief to a real `#id`. Never guess an id. If a reference still does not resolve after one search, report it instead of writing.
3. Apply the changes with as few calls as possible:
   - a new plan or several new steps: one `add_nodes` call with nested `children`;
   - status changes: `update_node`, setting `outcome` when something finishes;
   - backtracking: `update_node` with status `dropped`, or `move_node`; `delete_node` only for mistakes;
   - produced artifacts: `add_resource` on the node where they were produced, with `path` and `snapshot_file: true` for text files;
   - detours and context: `add_log` on the step they interrupted;
   - where the session is working now: `set_focus`.
4. Pass the brief's session id as `session` on every write.
5. Titles are short and outcome-shaped, 60 characters or fewer. Detail goes in `body`.
6. Record only what the brief states. Never invent progress, statuses or resources.

## Opt-in and adoption briefs

- "enroll" / "track this session": `list_projects`, then `create_project` if the project does not exist, then `enroll_session` (and `bind_folder` when asked). Reply with the first line of the briefing.
- "adopt": create the project with its purpose (and playbook if given); add finished phases as `done` phase nodes with one-line outcomes; add the current plan with its real statuses; add items for Aiden with `assignee: me`; attach the listed docs with `snapshot_file: true`; then `enroll_session` and `set_focus`.

## Final message

One line naming what changed, e.g. `#57 done · added #58 (you) · r12 on #58 · focus #58`. On failure: what failed and what the main session needs to supply.
```

- [ ] **Step 2: Create the skill template `claude/skills/inprogress/SKILL.md`**

````markdown
---
name: inprogress
description: Opt a Claude session into InProgress, adopt an existing project into it, or answer where a tracked project stands. Use when the user says "track this in InProgress", "add this to InProgress", "adopt <project> into InProgress", "what's next in InProgress", when a prompt hook says the session is not tracked yet, or when a tracked session needs the InProgress update rules restated.
---

# InProgress

InProgress is a live tree of a project's plan, steps, resources and Claude sessions, shown in a window beside Claude. Aiden reads it. You keep it current by briefing the `inprogress-scribe` agent. You never edit it yourself: no HTTP calls, no database access, no InProgress tools in this session.

## Tracked sessions

A tracked session has a context block starting `[InProgress] This session is tracked in project …`. It carries the session id, the playbook, the update rules and where things stand. Follow those rules. In short:

- Brief the scribe with the Agent tool (`subagent_type: "inprogress-scribe"`, description "InProgress update"). It runs in the background: never wait for it or poll it. At most one brief per turn, with every change batched.
- Checkpoints: a plan is made or changed (backtracking marks steps `dropped` or moves them); a step starts, finishes or is blocked; something worth finding again is produced; something is handed to Aiden (`assignee: me`) or he reports doing it; an open question appears (`kind: question`) or is answered (`done`, answer in `outcome`).
- Steps are plan-level with outcomes, never single actions. Detours go in the log of the step they interrupted.
- Resources always go to the scribe as a file path plus `snapshot_file`. Content that only exists in chat (for example a test suite written in a reply) is first written with the Write tool to `~/.inprogress/resources/<project-slug>/<yyyy-mm-dd>-<kebab-title>.md`.
- After dispatching, write one line in chat, e.g. `↳ InProgress: #57 done, test suite attached to #58`. The scribe's completion notice needs no reply beyond that line.

Brief template:

```
Session: <session id> · Project: <slug>
Changes:
- #57 → done; outcome "Play app signing configured"
- add under #55 after #57: "Run signing tests" (task, assignee me); body: run on a device build, report failures
- resource on the new "Run signing tests" node: test-suite "Signing test suite", path C:/Users/<you>/.inprogress/resources/ingame/2026-09-27-signing-test-suite.md, snapshot_file
- log on #55: "Detour: sandbox network wedge, fixed by restarting VMware NAT"
- focus → the new "Run signing tests" node
```

## Opting in (session not tracked)

1. The session id comes from the `[InProgress] This session is not tracked yet. Session id: …` line. If it is missing, ask Aiden to mention "InProgress" in his next message so the hook supplies it.
2. Decide the project. If it is unclear, run `node "{{REPO}}/dist/cli/main.js" status` to see existing projects, and ask Aiden.
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

When a tracked prompt asks where things stand, the prompt hook injects a live `[InProgress] Where things stand …` block: answer from it. For the whole tree, run `node "{{REPO}}/dist/cli/main.js" outline <slug>` (read-only). Never dispatch the scribe just to read.

## Stale nudges

A line like `[InProgress] InGame · focus #57 … · last scribe update 3 prompts ago` means the tree may be behind. If a checkpoint happened since the last brief, brief the scribe now; otherwise ignore the line.
````

- [ ] **Step 3: Write the failing test**

`test/cli/claude-config.test.ts`:
```ts
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ALLOW_RULES, HOOK_DEFS, install, uninstall } from '../../src/cli/claude-config';

const repo = process.cwd().replace(/\\/g, '/');

function claudeDirWithSettings(settings: object | undefined) {
  const dir = mkdtempSync(join(tmpdir(), 'ip-claude-'));
  if (settings) writeFileSync(join(dir, 'settings.json'), JSON.stringify(settings, null, 2));
  return dir;
}
const readSettings = (dir: string) => JSON.parse(readFileSync(join(dir, 'settings.json'), 'utf8'));

const existing = {
  model: 'opus',
  enabledPlugins: { 'superpowers@claude-plugins-official': true },
  permissions: { allow: ['Bash(git status)'] },
  hooks: { Stop: [{ hooks: [{ type: 'command', command: 'other-tool --stop' }] }] },
};

describe('install', () => {
  it('merges exec-form hooks and allow rules while preserving everything else', () => {
    const dir = claudeDirWithSettings(existing);
    const { log, agentsDirCreated } = install({ repo, claudeDir: dir, stamp: '20260927-120000' });
    expect(agentsDirCreated).toBe(true);
    expect(log.join('\n')).toContain('restart');
    const s = readSettings(dir);
    expect(s.model).toBe('opus');
    expect(s.enabledPlugins).toEqual(existing.enabledPlugins);
    expect(s.permissions.allow).toEqual(['Bash(git status)', ...ALLOW_RULES]);
    expect(s.hooks.Stop).toHaveLength(2);
    expect(s.hooks.Stop[0].hooks[0].command).toBe('other-tool --stop');
    for (const def of HOOK_DEFS) {
      const group = s.hooks[def.event].at(-1);
      expect(group.matcher).toBe(def.matcher);
      expect(group.hooks[0]).toEqual({ type: 'command', command: process.execPath.replace(/\\/g, '/'), args: [`${repo}/dist/hooks/hook.js`, def.name], timeout: def.timeout });
    }
    expect(existsSync(join(dir, 'settings.json.inprogress-backup-20260927-120000'))).toBe(true);
    const agent = readFileSync(join(dir, 'agents', 'inprogress-scribe.md'), 'utf8');
    expect(agent).toContain(`args: ["${repo}/dist/mcp/main.js"]`);
    expect(agent).not.toContain('{{REPO}}');
    expect(agent).toContain(`command: "${process.execPath.replace(/\\/g, '/')}"`);
    expect(readFileSync(join(dir, 'skills', 'inprogress', 'SKILL.md'), 'utf8')).toContain(`${repo}/dist/cli/main.js`);
  });

  it('is idempotent and reports an existing agents dir', () => {
    const dir = claudeDirWithSettings(existing);
    mkdirSync(join(dir, 'agents'));
    install({ repo, claudeDir: dir, stamp: 'a' });
    const second = install({ repo, claudeDir: dir, stamp: 'b' });
    expect(second.agentsDirCreated).toBe(false);
    const s = readSettings(dir);
    expect(s.hooks.SessionStart).toHaveLength(1);
    expect(s.hooks.Stop).toHaveLength(2);
    expect(s.permissions.allow.filter((r: string) => r === 'mcp__inprogress')).toHaveLength(1);
  });

  it('works without an existing settings file', () => {
    const dir = claudeDirWithSettings(undefined);
    install({ repo, claudeDir: dir, stamp: 'c' });
    expect(Object.keys(readSettings(dir).hooks)).toHaveLength(HOOK_DEFS.length);
  });
});

describe('uninstall', () => {
  it('removes exactly what install added', () => {
    const dir = claudeDirWithSettings(existing);
    install({ repo, claudeDir: dir, stamp: 'd' });
    uninstall({ claudeDir: dir, stamp: 'e' });
    const s = readSettings(dir);
    expect(s).toEqual(existing);
    expect(existsSync(join(dir, 'agents', 'inprogress-scribe.md'))).toBe(false);
    expect(existsSync(join(dir, 'skills', 'inprogress'))).toBe(false);
  });
});
```

- [ ] **Step 4: Run test to verify it fails**

Run: `npx vitest run test/cli/claude-config.test.ts`
Expected: FAIL, cannot resolve `../../src/cli/claude-config`.

- [ ] **Step 5: Implement `src/cli/claude-config.ts`**

```ts
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { HookName } from '../hooks/handlers';

export const ALLOW_RULES = ['mcp__inprogress', 'Edit(~/.inprogress/resources/**)'];
export const HOOK_SCRIPT_SUFFIX = '/dist/hooks/hook.js';
const NOT_SCRIBE = '^(?!inprogress-scribe$).*';

export interface HookDef {
  event: string;
  name: HookName;
  matcher?: string;
  timeout: number;
}

export const HOOK_DEFS: HookDef[] = [
  { event: 'SessionStart', name: 'session-start', timeout: 10 },
  { event: 'UserPromptSubmit', name: 'prompt-submit', timeout: 5 },
  { event: 'Stop', name: 'stop', timeout: 5 },
  { event: 'Notification', name: 'notification', matcher: 'permission_prompt', timeout: 5 },
  { event: 'SubagentStart', name: 'subagent-start', matcher: NOT_SCRIBE, timeout: 5 },
  { event: 'SubagentStop', name: 'subagent-stop', matcher: NOT_SCRIBE, timeout: 5 },
  { event: 'SessionEnd', name: 'session-end', timeout: 5 },
];

type HookEntry = { type?: string; command?: string; args?: string[]; timeout?: number };
type HookGroup = { matcher?: string; hooks?: HookEntry[] };
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Settings = Record<string, any>;

export function claudeDir(): string {
  const configured = process.env.INPROGRESS_CLAUDE_DIR;
  if (!configured) return join(homedir(), '.claude');
  return isAbsolute(configured) ? configured : resolve(configured);
}

/** Repo root from the bundled CLI at dist/cli/main.js. */
export function repoRoot(): string {
  return resolve(fileURLToPath(new URL('../..', import.meta.url))).replace(/\\/g, '/');
}

/**
 * The Node binary running the installer, as an absolute forward-slash path. Hooks and the scribe's
 * MCP server use it instead of relying on `node` being on the PATH the Claude desktop app inherits.
 */
export function nodeBinary(): string {
  return process.execPath.replace(/\\/g, '/');
}

export function hookEntry(repo: string, name: HookName, timeout: number): HookEntry {
  return { type: 'command', command: nodeBinary(), args: [`${repo}${HOOK_SCRIPT_SUFFIX}`, name], timeout };
}

export function isInProgressHook(entry: HookEntry): boolean {
  return (entry.args?.[0] ?? '').replace(/\\/g, '/').endsWith(HOOK_SCRIPT_SUFFIX) || (entry.command ?? '').includes(HOOK_SCRIPT_SUFFIX);
}

export function stripInProgressHooks(settings: Settings): Settings {
  const hooks = settings.hooks as Record<string, HookGroup[]> | undefined;
  if (!hooks) return settings;
  for (const [event, groups] of Object.entries(hooks)) {
    const kept = groups
      .map((g) => ({ ...g, hooks: (g.hooks ?? []).filter((h) => !isInProgressHook(h)) }))
      .filter((g) => g.hooks.length > 0);
    if (kept.length) hooks[event] = kept;
    else delete hooks[event];
  }
  if (Object.keys(hooks).length === 0) delete settings.hooks;
  return settings;
}

export function addInProgressHooks(settings: Settings, repo: string): Settings {
  stripInProgressHooks(settings);
  settings.hooks ??= {};
  for (const d of HOOK_DEFS) {
    const group: HookGroup = { ...(d.matcher ? { matcher: d.matcher } : {}), hooks: [hookEntry(repo, d.name, d.timeout)] };
    (settings.hooks[d.event] ??= []).push(group);
  }
  return settings;
}

export function addAllowRules(settings: Settings): Settings {
  settings.permissions ??= {};
  settings.permissions.allow ??= [];
  for (const rule of ALLOW_RULES) if (!settings.permissions.allow.includes(rule)) settings.permissions.allow.push(rule);
  return settings;
}

export function removeAllowRules(settings: Settings): Settings {
  const allow = settings.permissions?.allow;
  if (Array.isArray(allow)) settings.permissions.allow = allow.filter((r: string) => !ALLOW_RULES.includes(r));
  return settings;
}

export const renderTemplate = (text: string, repo: string): string => text.replaceAll('{{REPO}}', repo).replaceAll('{{NODE}}', nodeBinary());

function readSettings(file: string): Settings {
  return existsSync(file) ? (JSON.parse(readFileSync(file, 'utf8')) as Settings) : {};
}

function backup(file: string, stamp: string): string | undefined {
  if (!existsSync(file)) return undefined;
  const target = `${file}.inprogress-backup-${stamp}`;
  copyFileSync(file, target);
  return target;
}

export function install(o: { repo: string; claudeDir: string; stamp: string }): { log: string[]; agentsDirCreated: boolean } {
  const repo = o.repo.replace(/\\/g, '/');
  const log: string[] = [];
  mkdirSync(o.claudeDir, { recursive: true });
  const settingsFile = join(o.claudeDir, 'settings.json');
  const saved = backup(settingsFile, o.stamp);
  if (saved) log.push(`Backed up settings to ${saved}`);
  const settings = addAllowRules(addInProgressHooks(readSettings(settingsFile), repo));
  writeFileSync(settingsFile, `${JSON.stringify(settings, null, 2)}\n`);
  log.push(`Hooks: ${HOOK_DEFS.map((d) => d.event).join(', ')}`, `Allow rules: ${ALLOW_RULES.join(', ')}`);

  const agentsDir = join(o.claudeDir, 'agents');
  const agentsDirCreated = !existsSync(agentsDir);
  mkdirSync(agentsDir, { recursive: true });
  const agentFile = join(agentsDir, 'inprogress-scribe.md');
  writeFileSync(agentFile, renderTemplate(readFileSync(join(repo, 'claude', 'agents', 'inprogress-scribe.md'), 'utf8'), repo));
  log.push(`Agent: ${agentFile}`);

  const skillSrc = join(repo, 'claude', 'skills', 'inprogress');
  const skillDst = join(o.claudeDir, 'skills', 'inprogress');
  rmSync(skillDst, { recursive: true, force: true });
  mkdirSync(skillDst, { recursive: true });
  for (const f of readdirSync(skillSrc)) writeFileSync(join(skillDst, f), renderTemplate(readFileSync(join(skillSrc, f), 'utf8'), repo));
  log.push(`Skill: ${skillDst}`);

  if (agentsDirCreated) log.push('The agents folder is new: restart any open Claude sessions so they can see the scribe.');
  return { log, agentsDirCreated };
}

export function uninstall(o: { claudeDir: string; stamp: string }): string[] {
  const log: string[] = [];
  const settingsFile = join(o.claudeDir, 'settings.json');
  const saved = backup(settingsFile, o.stamp);
  if (saved) log.push(`Backed up settings to ${saved}`);
  if (existsSync(settingsFile)) {
    const settings = removeAllowRules(stripInProgressHooks(readSettings(settingsFile)));
    writeFileSync(settingsFile, `${JSON.stringify(settings, null, 2)}\n`);
    log.push('Removed InProgress hooks and allow rules');
  }
  rmSync(join(o.claudeDir, 'agents', 'inprogress-scribe.md'), { force: true });
  rmSync(join(o.claudeDir, 'skills', 'inprogress'), { recursive: true, force: true });
  log.push('Removed the scribe agent and the inprogress skill');
  return log;
}
```

- [ ] **Step 6: Run test to verify it passes**

Run: `npx vitest run test/cli/claude-config.test.ts`
Expected: PASS (4 tests). The uninstall test's `toEqual(existing)` proves the merge preserves unknown keys and removes only InProgress entries.

- [ ] **Step 7: Commit**

```bash
git add claude src/cli/claude-config.ts test/cli
git commit -m "Add the scribe agent, the inprogress skill and the settings installer

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 15: Admin CLI, doctor, and smoke tests against the build

**Files:**
- Create: `src/cli/open.ts`, `src/cli/doctor.ts`, `src/cli/commands.ts`, `src/cli/main.ts`, `test/smoke/built.test.ts`
- Test: `test/cli/commands.test.ts`

**Interfaces:**
- Consumes: `createClient`, `ensureServer`, `isServerUp`, `baseUrl`, `homeDir`, `readToken`, `VERSION`, `install`, `uninstall`, `claudeDir`, `repoRoot`, `HOOK_DEFS`, `ALLOW_RULES`, `isInProgressHook`, `timestamp` (backup.ts).
- Produces:
  - `findEdge(): string | undefined`, `edgeArgs(url): string[]`, `openAppWindow(url): void`
  - `Check = { name: string; ok: boolean; detail: string; warnOnly?: boolean }`, `runChecks(o: DoctorOptions): Promise<Check[]>` with `DoctorOptions = { baseUrl; home; claudeDir; repo; skipMcp? }`, `doctor(o, out): Promise<number>`
  - `runCli(args: string[], out?: (line: string) => void): Promise<number>` with commands `start | stop | open | status | outline <project> [--full] | doctor | claude-install | claude-uninstall`

- [ ] **Step 1: Write the failing test**

`test/cli/commands.test.ts`:
```ts
import { mkdirSync, mkdtempSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { install } from '../../src/cli/claude-config';
import { runCli } from '../../src/cli/commands';
import { runChecks } from '../../src/cli/doctor';
import { edgeArgs } from '../../src/cli/open';
import { ensureToken } from '../../src/lib/home';
import { buildApp } from '../../src/server/app';
import { openDb } from '../../src/server/db/connection';
import { createCtx } from '../../src/server/db/tx';
import { createProject } from '../../src/server/repo/projects';

let base = '';
let home = '';
let close: () => Promise<unknown>;

beforeAll(async () => {
  home = mkdtempSync(join(tmpdir(), 'ip-cli-'));
  const token = ensureToken(home);
  const ctx = createCtx(openDb(join(home, 'inprogress.db')));
  createProject(ctx, 'test', { name: 'CLI Demo' });
  const app = buildApp({ ctx, token, uiToken: 'u', version: '0.1.0' });
  await app.listen({ port: 0, host: '127.0.0.1' });
  const port = (app.server.address() as AddressInfo).port;
  base = `http://127.0.0.1:${port}`;
  process.env.INPROGRESS_PORT = String(port);
  process.env.INPROGRESS_HOME = home;
  close = () => app.close();
});
afterAll(() => close());

function capture() {
  const lines: string[] = [];
  return { lines, out: (l: string) => lines.push(l) };
}

describe('runCli', () => {
  it('prints status and outlines', async () => {
    const s = capture();
    expect(await runCli(['status'], s.out)).toBe(0);
    expect(s.lines.join('\n')).toContain('cli-demo');
    const o = capture();
    expect(await runCli(['outline', 'cli-demo'], o.out)).toBe(0);
    expect(o.lines.join('\n')).toContain('Project CLI Demo (slug cli-demo)');
    const bad = capture();
    expect(await runCli(['outline'], bad.out)).toBe(1);
    expect(await runCli(['nonsense'], capture().out)).toBe(1);
  });

  it('builds the Edge app-window arguments', () => {
    expect(edgeArgs('http://127.0.0.1:4317')).toEqual(['--app=http://127.0.0.1:4317', '--window-size=520,1000']);
  });
});

describe('doctor checks', () => {
  it('passes after install and reports what is missing before it', async () => {
    const claude = mkdtempSync(join(tmpdir(), 'ip-doc-'));
    const repo = process.cwd().replace(/\\/g, '/');
    const before = await runChecks({ baseUrl: base, home, claudeDir: claude, repo, skipMcp: true });
    expect(before.find((c) => c.name === 'Server')).toMatchObject({ ok: true });
    expect(before.find((c) => c.name === 'Hooks')).toMatchObject({ ok: false });
    mkdirSync(join(claude, 'agents'), { recursive: true });
    install({ repo, claudeDir: claude, stamp: 'x' });
    const after = await runChecks({ baseUrl: base, home, claudeDir: claude, repo, skipMcp: true });
    const failing = after.filter((c) => !c.ok && !c.warnOnly).map((c) => `${c.name}: ${c.detail}`);
    expect(failing).toEqual([]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/cli/commands.test.ts`
Expected: FAIL, cannot resolve `../../src/cli/commands`.

- [ ] **Step 3: Implement `src/cli/open.ts`**

```ts
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

export function findEdge(): string | undefined {
  const bases = [process.env['ProgramFiles(x86)'], process.env.ProgramFiles, process.env.LOCALAPPDATA].filter((b): b is string => !!b);
  return bases.map((b) => join(b, 'Microsoft', 'Edge', 'Application', 'msedge.exe')).find((p) => existsSync(p));
}

export function edgeArgs(url: string): string[] {
  return [`--app=${url}`, '--window-size=520,1000'];
}

/** Open the UI as a chromeless Edge window, else in the default browser. */
export function openAppWindow(url: string): void {
  const edge = findEdge();
  const detached = { detached: true, stdio: 'ignore' as const };
  if (edge) spawn(edge, edgeArgs(url), detached).unref();
  else if (process.platform === 'win32') spawn('explorer.exe', [url], detached).unref();
  else spawn(process.platform === 'darwin' ? 'open' : 'xdg-open', [url], detached).unref();
}
```

- [ ] **Step 4: Implement `src/cli/doctor.ts`**

```ts
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import Database from 'better-sqlite3';
import { readToken } from '../lib/home';
import { VERSION } from '../lib/version';
import { ALLOW_RULES, HOOK_DEFS, isInProgressHook } from './claude-config';
import { findEdge } from './open';

export interface Check {
  name: string;
  ok: boolean;
  detail: string;
  warnOnly?: boolean;
}

export interface DoctorOptions {
  baseUrl: string;
  home: string;
  claudeDir: string;
  repo: string;
  skipMcp?: boolean;
}

function readJson(file: string): Record<string, any> | undefined { // eslint-disable-line @typescript-eslint/no-explicit-any
  try {
    return JSON.parse(readFileSync(file, 'utf8'));
  } catch {
    return undefined;
  }
}

async function serverCheck(baseUrl: string): Promise<Check> {
  try {
    const res = await fetch(`${baseUrl}/api/health`, { signal: AbortSignal.timeout(1000) });
    const body = (await res.json()) as { app?: string; version?: string };
    if (body.app !== 'inprogress') return { name: 'Server', ok: false, detail: `${baseUrl} answers but is not InProgress` };
    if (body.version !== VERSION) return { name: 'Server', ok: false, detail: `running ${body.version}, built ${VERSION}: run \`inprogress stop\`; the next session starts the new build` };
    return { name: 'Server', ok: true, detail: `running ${body.version} at ${baseUrl}` };
  } catch {
    return { name: 'Server', ok: false, detail: 'not running: run `inprogress start` and check server.log' };
  }
}

function dbCheck(file: string): Check {
  if (!existsSync(file)) return { name: 'Database', ok: false, detail: `${file} is missing: start the server once` };
  try {
    const db = new Database(file, { readonly: true, fileMustExist: true });
    const result = db.pragma('quick_check', { simple: true });
    db.close();
    return { name: 'Database', ok: result === 'ok', detail: result === 'ok' ? 'integrity ok' : String(result) };
  } catch (err) {
    return { name: 'Database', ok: false, detail: (err as Error).message };
  }
}

function agentCheck(file: string): Check {
  if (!existsSync(file)) return { name: 'Scribe agent', ok: false, detail: `${file} is missing: run npm run claude:install` };
  const text = readFileSync(file, 'utf8');
  const front = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text)?.[1] ?? '';
  const missing = ['name: inprogress-scribe', 'model:', 'tools: mcp__inprogress', 'mcpServers:', 'dist/mcp/main.js'].filter((k) => !front.includes(k));
  return missing.length ? { name: 'Scribe agent', ok: false, detail: `frontmatter missing: ${missing.join(', ')}` } : { name: 'Scribe agent', ok: true, detail: file };
}

async function mcpCheck(entry: string): Promise<Check> {
  if (!existsSync(entry)) return { name: 'MCP server', ok: false, detail: `${entry} is missing: run npm run build` };
  const client = new Client({ name: 'inprogress-doctor', version: VERSION });
  try {
    await client.connect(new StdioClientTransport({ command: process.execPath, args: [entry], env: { ...process.env } as Record<string, string> }));
    const res = (await client.callTool({ name: 'list_projects', arguments: {} })) as { isError?: boolean; content: { text?: string }[] };
    await client.close();
    return { name: 'MCP server', ok: !res.isError, detail: res.isError ? String(res.content[0]?.text) : 'answers list_projects' };
  } catch (err) {
    return { name: 'MCP server', ok: false, detail: (err as Error).message };
  }
}

export async function runChecks(o: DoctorOptions): Promise<Check[]> {
  const checks: Check[] = [await serverCheck(o.baseUrl)];
  const token = readToken(o.home);
  checks.push({ name: 'Token', ok: !!token, detail: token ? 'readable' : `missing at ${join(o.home, 'token')}: start the server once` });
  checks.push(dbCheck(join(o.home, 'inprogress.db')));
  const settings = readJson(join(o.claudeDir, 'settings.json'));
  const missingHooks = HOOK_DEFS.filter(
    (d) => !(settings?.hooks?.[d.event] ?? []).some((g: { hooks?: { args?: string[]; command?: string }[] }) => (g.hooks ?? []).some((h) => isInProgressHook(h))),
  ).map((d) => d.event);
  const ourHooks = (Object.values(settings?.hooks ?? {}) as { hooks?: { command?: string; args?: string[] }[] }[][])
    .flat()
    .flatMap((g) => g.hooks ?? [])
    .filter((h) => isInProgressHook(h));
  const badBinary = ourHooks.find((h) => h.command && /[\\/]/.test(h.command) && !existsSync(h.command))?.command;
  checks.push({
    name: 'Hooks',
    ok: missingHooks.length === 0 && !badBinary,
    detail: missingHooks.length
      ? `missing: ${missingHooks.join(', ')}: run npm run claude:install`
      : badBinary
        ? `node binary ${badBinary} no longer exists: rerun npm run claude:install`
        : 'all installed',
  });
  checks.push(agentCheck(join(o.claudeDir, 'agents', 'inprogress-scribe.md')));
  const skill = join(o.claudeDir, 'skills', 'inprogress', 'SKILL.md');
  checks.push({ name: 'Skill', ok: existsSync(skill), detail: skill });
  const allow: string[] = settings?.permissions?.allow ?? [];
  const missingRules = ALLOW_RULES.filter((r) => !allow.includes(r));
  checks.push({ name: 'Allow rules', ok: missingRules.length === 0, detail: missingRules.length ? `missing: ${missingRules.join(', ')}` : ALLOW_RULES.join(', ') });
  if (!o.skipMcp) checks.push(await mcpCheck(join(o.repo, 'dist', 'mcp', 'main.js')));
  const edge = findEdge();
  checks.push({ name: 'Edge', ok: !!edge, detail: edge ?? 'not found: `inprogress open` will use the default browser', warnOnly: true });
  return checks;
}

export async function doctor(o: DoctorOptions, out: (line: string) => void): Promise<number> {
  const checks = await runChecks(o);
  for (const c of checks) out(`${c.ok ? '✓' : c.warnOnly ? '!' : '✗'} ${c.name}: ${c.detail}`);
  return checks.every((c) => c.ok || c.warnOnly) ? 0 : 1;
}
```

- [ ] **Step 5: Implement `src/cli/commands.ts` and `src/cli/main.ts`**

`src/cli/commands.ts`:
```ts
import { join } from 'node:path';
import type { ProjectSummary } from '../core/types';
import { createClient } from '../lib/client';
import { ensureServer, isServerUp } from '../lib/ensure-server';
import { baseUrl, homeDir, readToken } from '../lib/home';
import { timestamp } from '../server/backup';
import { claudeDir, install, repoRoot, uninstall } from './claude-config';
import { doctor } from './doctor';
import { openAppWindow } from './open';

const USAGE = 'Usage: inprogress <start | stop | open | status | outline <project> [--full] | doctor | claude-install | claude-uninstall>';

/** Ask the server to shut down and wait until it has actually stopped answering (up to 3 s). */
async function stopServer(url: string, out: (l: string) => void): Promise<void> {
  if (!(await isServerUp(url))) return;
  await createClient({ baseUrl: url, token: readToken() }).post('/api/admin/shutdown', {});
  for (let i = 0; i < 30; i++) {
    if (!(await isServerUp(url, 200))) {
      out('Stopped the running InProgress server.');
      return;
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  out('Asked InProgress to stop, but it is still answering after 3 s.');
}

export async function runCli(args: string[], out: (line: string) => void = console.log): Promise<number> {
  const [cmd, ...rest] = args;
  const url = baseUrl();
  switch (cmd) {
    case 'start': {
      const up = await ensureServer({ baseUrl: url, waitMs: 5000 });
      out(up ? `InProgress is running at ${url}` : `InProgress did not start. See ${join(homeDir(), 'server.log')}`);
      return up ? 0 : 1;
    }
    case 'stop':
      if (!(await isServerUp(url))) out('InProgress is not running.');
      else await stopServer(url, out);
      return 0;
    case 'open': {
      if (!(await ensureServer({ baseUrl: url, waitMs: 5000 }))) {
        out(`InProgress did not start. See ${join(homeDir(), 'server.log')}`);
        return 1;
      }
      openAppWindow(url);
      out(`Opened ${url}`);
      return 0;
    }
    case 'status': {
      if (!(await isServerUp(url))) {
        out('InProgress is not running.');
        return 1;
      }
      const projects = await createClient({ baseUrl: url }).get<ProjectSummary[]>('/api/projects');
      out(`InProgress at ${url}`);
      if (!projects.length) out('  no projects yet');
      for (const p of projects) {
        out(`  ${p.slug.padEnd(24)} ${p.name}${p.status === 'archived' ? ' (archived)' : ''} · ${p.needsYou} need you · ${p.workingSessions} working / ${p.activeSessions} sessions`);
      }
      return 0;
    }
    case 'outline': {
      const project = rest.find((a) => !a.startsWith('--'));
      if (!project) {
        out('Usage: inprogress outline <project> [--full]');
        return 1;
      }
      const full = rest.includes('--full');
      out(await createClient({ baseUrl: url }).text(`/api/projects/${encodeURIComponent(project)}/outline${full ? '?full=1' : ''}`));
      return 0;
    }
    case 'doctor':
      return doctor({ baseUrl: url, home: homeDir(), claudeDir: claudeDir(), repo: repoRoot() }, out);
    case 'claude-install': {
      await stopServer(url, out).catch(() => undefined);
      const { log } = install({ repo: repoRoot(), claudeDir: claudeDir(), stamp: timestamp() });
      log.forEach((l) => out(l));
      out('Next: run `inprogress doctor`, then start a new Claude session.');
      return 0;
    }
    case 'claude-uninstall':
      uninstall({ claudeDir: claudeDir(), stamp: timestamp() }).forEach((l) => out(l));
      return 0;
    default:
      out(USAGE);
      return cmd ? 1 : 0;
  }
}
```

`src/cli/main.ts`:
```ts
#!/usr/bin/env node
import { runCli } from './commands';

runCli(process.argv.slice(2)).then(
  (code) => process.exit(code),
  (err) => {
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  },
);
```

- [ ] **Step 6: Run the unit tests**

Run: `npx vitest run test/cli`
Expected: PASS (7 tests across the two files).

- [ ] **Step 7: Write the smoke test against the build**

`test/smoke/built.test.ts`:
```ts
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { createServer, type AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createClient } from '../../src/lib/client';
import { isServerUp } from '../../src/lib/ensure-server';
import { readToken } from '../../src/lib/home';

const home = mkdtempSync(join(tmpdir(), 'ip-smoke-'));
const claude = mkdtempSync(join(tmpdir(), 'ip-smoke-claude-'));
let base = '';
let env: NodeJS.ProcessEnv = {};
let server: ChildProcess;

/** A port nothing is listening on, so a stale server from an earlier run can never answer. */
function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = createServer();
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const { port } = probe.address() as AddressInfo;
      probe.close(() => resolve(port));
    });
  });
}

beforeAll(async () => {
  const port = await freePort();
  base = `http://127.0.0.1:${port}`;
  env = { ...process.env, INPROGRESS_HOME: home, INPROGRESS_PORT: String(port), INPROGRESS_CLAUDE_DIR: claude };
  server = spawn(process.execPath, ['dist/server/main.js'], { env, stdio: 'ignore' });
  for (let i = 0; i < 80 && !(await isServerUp(base)); i++) await new Promise((r) => setTimeout(r, 100));
  expect(await isServerUp(base)).toBe(true);
});
afterAll(async () => {
  await createClient({ baseUrl: base, token: readToken(home) }).post('/api/admin/shutdown', {}).catch(() => undefined);
  server.kill();
});

describe('built artifacts', () => {
  it('session-start hook prints a briefing for a bound folder', async () => {
    const client = createClient({ baseUrl: base, token: readToken(home) });
    const p = await client.post<{ slug: string }>('/api/projects', { name: 'Smoke' });
    const dir = mkdtempSync(join(tmpdir(), 'ip-smoke-bound-'));
    await client.post(`/api/projects/${p.slug}/bindings`, { path: dir });
    const r = spawnSync(process.execPath, ['dist/hooks/hook.js', 'session-start'], { input: JSON.stringify({ session_id: 'smoke-1', cwd: dir, source: 'startup' }), env, encoding: 'utf8' });
    expect(r.status).toBe(0);
    const out = JSON.parse(r.stdout) as { hookSpecificOutput: { hookEventName: string; additionalContext: string } };
    expect(out.hookSpecificOutput.hookEventName).toBe('SessionStart');
    expect(out.hookSpecificOutput.additionalContext).toContain('tracked in project "Smoke"');
  });

  it('hooks exit 0 silently when the server is unreachable', () => {
    const r = spawnSync(process.execPath, ['dist/hooks/hook.js', 'stop'], { input: JSON.stringify({ session_id: 'x' }), env: { ...env, INPROGRESS_PORT: '1' }, encoding: 'utf8' });
    expect(r.status).toBe(0);
    expect(r.stdout).toBe('');
    expect(r.stderr).toBe('');
  });

  it('MCP server answers over stdio', async () => {
    const client = new Client({ name: 'smoke', version: '1' });
    await client.connect(new StdioClientTransport({ command: process.execPath, args: ['dist/mcp/main.js'], env: env as Record<string, string> }));
    const res = (await client.callTool({ name: 'list_projects', arguments: {} })) as { content: { text: string }[] };
    expect(res.content[0].text).toContain('smoke');
    await client.close();
  });

  it('CLI installs into a temp Claude dir and doctor passes', () => {
    expect(spawnSync(process.execPath, ['dist/cli/main.js', 'claude-install'], { env, encoding: 'utf8' }).status).toBe(0);
    // claude-install stopped the server; start it again for doctor.
    expect(spawnSync(process.execPath, ['dist/cli/main.js', 'start'], { env, encoding: 'utf8' }).status).toBe(0);
    const doc = spawnSync(process.execPath, ['dist/cli/main.js', 'doctor'], { env, encoding: 'utf8' });
    expect(doc.stdout).not.toContain('✗');
    expect(doc.status).toBe(0);
  });
});
```

- [ ] **Step 8: Build and run the smoke test**

Run: `npm run test:smoke`
Expected: tsup builds `dist/server/main.js`, `dist/mcp/main.js`, `dist/cli/main.js`, `dist/hooks/hook.js`; 4 smoke tests PASS.

- [ ] **Step 9: Commit**

```bash
git add src/cli test/cli test/smoke
git commit -m "Add the admin CLI, doctor, and smoke tests against the build

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 16: Outline-flow layout (pure)

**Files:**
- Create: `src/core/layout.ts`
- Test: `test/core/layout.test.ts`

**Interfaces:**
- Consumes: `buildIndex`, `computeVisible`, `countDone`, `isNeedsYou`, `progress`, `FoldOverrides` (tree.ts); core types.
- Produces:
  - constants `ROW = 32`, `INDENT = 28`, `NODE_H = 24`, `BADGE_ROW = 26`
  - `LayoutNodeItem = { kind: 'node'; id: 'n<id>'; nodeId; x; y; depth; folded; doneCount; progress; resourceIds: number[]; needsYou; hasChildren; working }`
  - `LayoutMoreItem = { kind: 'more'; id: 'more<parentId>-<run>'; parentId; run; x; y; depth; hiddenIds }`
  - `LayoutBadgeItem = { kind: 'badge'; id: 'b<sessionId>'; sessionId; nodeId; x; y }`
  - `LayoutEdge = { id; source; target }`, `LayoutResult = { items; edges; nodeItems: Map<number, LayoutNodeItem>; height }`
  - `layoutOutline({ nodes, resources, sessions, overrides? }): LayoutResult`
  - `findFrontier(nodes, sessions, layout): number | undefined`, `needsYouOrder(layout): number[]`, `eventTarget(event: EventRow): number | undefined`

- [ ] **Step 1: Write the failing test**

`test/core/layout.test.ts`:
```ts
import { describe, expect, it } from 'vitest';
import { BADGE_ROW, INDENT, ROW, eventTarget, findFrontier, layoutOutline, needsYouOrder } from '../../src/core/layout';
import type { EventRow, ResourceMeta, Session, TreeNode } from '../../src/core/types';

let nextId = 1;
function n(parentId: number | null, title: string, extra: Partial<TreeNode> = {}): TreeNode {
  const id = nextId++;
  return { id, projectId: 1, parentId, position: id, kind: parentId === null ? 'goal' : 'task', title, body: '', status: 'todo', assignee: 'claude', outcome: '', createdAt: 't', updatedAt: `2026-09-27T00:00:${String(id).padStart(2, '0')}Z`, completedAt: null, ...extra };
}
function session(id: string, focusNodeId: number | null, state: Session['state'], lastSeenAt = '2026-09-27T01:00:00Z'): Session {
  return { id, projectId: 1, title: id, cwd: null, branch: null, transcriptPath: null, state, focusNodeId, promptsSinceUpdate: 0, startedAt: 't', lastSeenAt, endedAt: null, subagents: [] };
}
const resource = (id: number, nodeId: number): ResourceMeta => ({ id, projectId: 1, nodeId, kind: 'doc', title: `R${id}`, path: null, url: null, contentLength: 1, sessionId: null, createdAt: 't', updatedAt: 't' });

function sample() {
  nextId = 1;
  const root = n(null, 'Root', { status: 'active' });
  const a = n(root.id, 'A', { status: 'active' });
  const a1 = n(a.id, 'A1', { status: 'active' });
  const a2 = n(a.id, 'A2', { assignee: 'me' });
  const b = n(root.id, 'B');
  const c = n(root.id, 'C');
  const d = n(root.id, 'D');
  const e = n(root.id, 'E');
  return { nodes: [root, a, a1, a2, b, c, d, e], root, a, a1, a2, b, c, d, e };
}

describe('layoutOutline', () => {
  it('stacks rows downward and indents by depth', () => {
    const t = sample();
    const l = layoutOutline({ nodes: t.nodes, resources: [], sessions: [] });
    const rows = l.items.map((i) => (i.kind === 'node' ? [i.id, i.x, i.y] : [i.id, i.x, i.y]));
    expect(rows).toEqual([
      [`n${t.root.id}`, 0, 0], [`n${t.a.id}`, INDENT, ROW], [`n${t.a1.id}`, 2 * INDENT, 2 * ROW], [`n${t.a2.id}`, 2 * INDENT, 3 * ROW],
      [`n${t.b.id}`, INDENT, 4 * ROW], [`n${t.c.id}`, INDENT, 5 * ROW], [`more${t.root.id}-0`, INDENT, 6 * ROW],
    ]);
    expect(l.edges).toContainEqual({ id: `e-more${t.root.id}-0`, source: `n${t.root.id}`, target: `more${t.root.id}-0` });
    expect(l.edges).toContainEqual({ id: `e-n${t.a1.id}`, source: `n${t.a.id}`, target: `n${t.a1.id}` });
    expect(l.height).toBe(7 * ROW);
  });

  it('adds a badge row under a focused node and marks the working chain', () => {
    const t = sample();
    const l = layoutOutline({ nodes: t.nodes, resources: [resource(9, t.a2.id)], sessions: [session('s1', t.a1.id, 'working'), session('s2', t.b.id, 'ended')] });
    const badge = l.items.find((i) => i.kind === 'badge')!;
    expect(badge).toMatchObject({ id: 'bs1', sessionId: 's1', nodeId: t.a1.id, x: 3 * INDENT, y: 3 * ROW });
    expect(l.nodeItems.get(t.a2.id)).toMatchObject({ y: 3 * ROW + BADGE_ROW, needsYou: true, resourceIds: [9] });
    expect(l.nodeItems.get(t.a.id)?.working).toBe(true);
    expect(l.nodeItems.get(t.b.id)?.working).toBe(false);
    expect(l.items.filter((i) => i.kind === 'badge')).toHaveLength(1);
  });

  it('reports folded done counts and progress', () => {
    const t = sample();
    const nodes = t.nodes.map((x) => (x.id === t.a.id || x.id === t.a1.id ? { ...x, status: 'done' as const } : x.id === t.a2.id ? { ...x, assignee: 'claude' as const, status: 'done' as const } : x));
    const l = layoutOutline({ nodes, resources: [], sessions: [] });
    expect(l.nodeItems.get(t.a.id)).toMatchObject({ folded: true, doneCount: 2, progress: { done: 2, total: 2 } });
    expect(l.nodeItems.has(t.a1.id)).toBe(false);
  });
});

describe('camera helpers', () => {
  it('prefers the freshest working focus, then the latest active node, then the last row', () => {
    const t = sample();
    const l = layoutOutline({ nodes: t.nodes, resources: [], sessions: [] });
    expect(findFrontier(t.nodes, [session('s1', t.b.id, 'idle'), session('s2', t.a2.id, 'working')], l)).toBe(t.a2.id);
    expect(findFrontier(t.nodes, [], l)).toBe(t.a1.id);
    const idle = t.nodes.map((x) => (x.parentId === null ? x : { ...x, status: 'todo' as const }));
    expect(findFrontier(idle, [], layoutOutline({ nodes: idle, resources: [], sessions: [] }))).toBe(t.c.id);
  });

  it('orders needs-you nodes top to bottom', () => {
    const t = sample();
    const nodes = t.nodes.map((x) => (x.id === t.b.id ? { ...x, assignee: 'me' as const } : x));
    expect(needsYouOrder(layoutOutline({ nodes, resources: [], sessions: [] }))).toEqual([t.a2.id, t.b.id]);
  });

  it('maps events to the node the camera should visit', () => {
    const ev = (type: string, entityId: string, data: unknown): EventRow => ({ id: 1, ts: 't', projectId: 1, actor: 'x', type, entity: 'x', entityId, data });
    expect(eventTarget(ev('node.created', '5', { ids: [5, 6, 7] }))).toBe(7);
    expect(eventTarget(ev('node.updated', '4', {}))).toBe(4);
    expect(eventTarget(ev('resource.created', '9', { nodeId: 3 }))).toBe(3);
    expect(eventTarget(ev('log.created', '2', { nodeId: 8 }))).toBe(8);
    expect(eventTarget(ev('session.updated', 's1', { changed: ['focusNodeId'], focusNodeId: 11 }))).toBe(11);
    expect(eventTarget(ev('session.updated', 's1', { changed: ['state'], state: 'working' }))).toBeUndefined();
    expect(eventTarget(ev('node.deleted', '4', { ids: [4] }))).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/core/layout.test.ts`
Expected: FAIL, cannot resolve `../../src/core/layout`.

- [ ] **Step 3: Implement `src/core/layout.ts`**

```ts
import { buildIndex, computeVisible, countDone, isNeedsYou, progress, type FoldOverrides } from './tree';
import type { EventRow, ResourceMeta, Session, TreeNode } from './types';

export const ROW = 32;
export const INDENT = 28;
export const NODE_H = 24;
export const BADGE_ROW = 26;

export interface LayoutNodeItem {
  kind: 'node';
  id: string;
  nodeId: number;
  x: number;
  y: number;
  depth: number;
  folded: boolean;
  doneCount: number;
  progress: { done: number; total: number } | null;
  resourceIds: number[];
  needsYou: boolean;
  hasChildren: boolean;
  working: boolean;
}

export interface LayoutMoreItem {
  kind: 'more';
  id: string;
  parentId: number;
  run: number;
  x: number;
  y: number;
  depth: number;
  hiddenIds: number[];
}

export interface LayoutBadgeItem {
  kind: 'badge';
  id: string;
  sessionId: string;
  nodeId: number;
  x: number;
  y: number;
}

export type LayoutItem = LayoutNodeItem | LayoutMoreItem | LayoutBadgeItem;

export interface LayoutEdge {
  id: string;
  source: string;
  target: string;
}

export interface LayoutResult {
  items: LayoutItem[];
  edges: LayoutEdge[];
  nodeItems: Map<number, LayoutNodeItem>;
  height: number;
}

export interface LayoutInput {
  nodes: TreeNode[];
  resources: ResourceMeta[];
  sessions: Session[];
  overrides?: FoldOverrides;
}

export function layoutOutline(input: LayoutInput): LayoutResult {
  const index = buildIndex(input.nodes);
  const live = input.sessions.filter((s) => s.state !== 'ended');
  const visible = computeVisible(index, live, { overrides: input.overrides });

  const resourcesByNode = new Map<number, number[]>();
  for (const r of [...input.resources].sort((a, b) => a.id - b.id)) resourcesByNode.set(r.nodeId, [...(resourcesByNode.get(r.nodeId) ?? []), r.id]);
  const badgesByNode = new Map<number, Session[]>();
  for (const s of live) if (s.focusNodeId !== null) badgesByNode.set(s.focusNodeId, [...(badgesByNode.get(s.focusNodeId) ?? []), s]);
  const working = new Set<number>();
  for (const s of live) {
    if (s.state !== 'working' || s.focusNodeId === null) continue;
    let cur = index.byId.get(s.focusNodeId);
    while (cur) {
      working.add(cur.id);
      cur = cur.parentId === null ? undefined : index.byId.get(cur.parentId);
    }
  }

  const items: LayoutItem[] = [];
  const edges: LayoutEdge[] = [];
  const nodeItems = new Map<number, LayoutNodeItem>();
  let y = 0;
  for (const v of visible) {
    const x = v.depth * INDENT;
    if (v.type === 'more') {
      const id = `more${v.parentId}-${v.run}`;
      items.push({ kind: 'more', id, parentId: v.parentId, run: v.run, x, y, depth: v.depth, hiddenIds: v.hiddenIds });
      edges.push({ id: `e-${id}`, source: `n${v.parentId}`, target: id });
      y += ROW;
      continue;
    }
    const node = v.node;
    const item: LayoutNodeItem = {
      kind: 'node',
      id: `n${node.id}`,
      nodeId: node.id,
      x,
      y,
      depth: v.depth,
      folded: v.folded,
      doneCount: v.folded ? countDone(index, node.id) : 0,
      progress: progress(index, node.id),
      resourceIds: resourcesByNode.get(node.id) ?? [],
      needsYou: isNeedsYou(node),
      hasChildren: v.hasChildren,
      working: working.has(node.id),
    };
    items.push(item);
    nodeItems.set(node.id, item);
    if (node.parentId !== null) edges.push({ id: `e-${item.id}`, source: `n${node.parentId}`, target: item.id });
    y += ROW;
    for (const s of badgesByNode.get(node.id) ?? []) {
      items.push({ kind: 'badge', id: `b${s.id}`, sessionId: s.id, nodeId: node.id, x: x + INDENT, y });
      y += BADGE_ROW;
    }
  }
  return { items, edges, nodeItems, height: y };
}

export function findFrontier(nodes: TreeNode[], sessions: Session[], layout: LayoutResult): number | undefined {
  const workingFocus = sessions
    .filter((s) => s.state === 'working' && s.focusNodeId !== null)
    .sort((a, b) => b.lastSeenAt.localeCompare(a.lastSeenAt));
  if (workingFocus.length) return workingFocus[0].focusNodeId!;
  const active = nodes.filter((n) => n.parentId !== null && n.status === 'active').sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  if (active.length) return active[0].id;
  const rows = layout.items.filter((i): i is LayoutNodeItem => i.kind === 'node');
  return rows.length ? rows[rows.length - 1].nodeId : undefined;
}

export function needsYouOrder(layout: LayoutResult): number[] {
  return layout.items.filter((i): i is LayoutNodeItem => i.kind === 'node' && i.needsYou).map((i) => i.nodeId);
}

export function eventTarget(e: EventRow): number | undefined {
  const d = (e.data ?? {}) as { ids?: number[]; nodeId?: number; changed?: string[]; focusNodeId?: number | null };
  switch (e.type) {
    case 'node.created':
      return d.ids?.length ? d.ids[d.ids.length - 1] : Number(e.entityId);
    case 'node.updated':
    case 'node.moved':
      return Number(e.entityId);
    case 'resource.created':
    case 'resource.updated':
    case 'log.created':
      return typeof d.nodeId === 'number' ? d.nodeId : undefined;
    case 'session.updated':
      return d.changed?.includes('focusNodeId') && typeof d.focusNodeId === 'number' ? d.focusNodeId : undefined;
    default:
      return undefined;
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/core/layout.test.ts`
Expected: PASS (6 tests).

- [ ] **Step 5: Commit**

```bash
git add src/core/layout.ts test/core/layout.test.ts
git commit -m "Add the outline-flow layout and camera helpers

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 17: Web app shell: data hook, top bar, session row, activity strip

**Files:**
- Create: `web/index.html`, `web/vite.config.ts`, `web/tsconfig.json`, `scripts/dev.mjs`
- Create: `web/src/main.tsx`, `web/src/App.tsx`, `web/src/api.ts`, `web/src/storage.ts`, `web/src/useInProgress.ts`, `web/src/describe.ts`, `web/src/time.ts`, `web/src/styles.css`
- Create: `web/src/chrome/TopBar.tsx`, `web/src/chrome/SessionRow.tsx`, `web/src/chrome/ActivityStrip.tsx`
- Test: `test/web/describe.test.ts`

**Interfaces:**
- Consumes: core types; `isNeedsYou` (tree.ts); HTTP routes from Task 9 and SSE from Task 10.
- Produces:
  - `api.projects()`, `api.project(slug)`, `api.node(id)`, `api.resource(id)`, `api.openResource(id): Promise<'opened' | 'reload' | string>`; `subscribe(onEvent, onStatus): () => void`
  - `load(key)`, `save(key, value)`, `loadJson(key, fallback)` (storage.ts)
  - `useInProgress(): { projects; slug; snapshot; lastEvent; liveEvent; connection: 'open' | 'reconnecting'; loaded; selectProject(slug) }` (`liveEvent` is set only by SSE, so opening the window never triggers a camera jump)
  - `describeEvent(event, snapshot): string`, `actorLabel(event, snapshot): string` (describe.ts); `relativeTime(iso, now?): string` (time.ts)
  - Components `TopBar`, `SessionRow`, `ActivityStrip`; `App` (canvas placeholder until Task 18)

- [ ] **Step 1: Write the failing test**

`test/web/describe.test.ts`:
```ts
import { describe, expect, it } from 'vitest';
import type { EventRow, ProjectSnapshot } from '../../src/core/types';
import { actorLabel, describeEvent } from '../../web/src/describe';
import { relativeTime } from '../../web/src/time';

const snapshot = {
  project: { id: 1, slug: 'p', name: 'P' },
  nodes: [{ id: 58, title: 'Run signing tests' }, { id: 55, title: '2 Android signing' }],
  resources: [],
  sessions: [{ id: 's1', title: 'InGame launch status' }],
} as unknown as ProjectSnapshot;

const ev = (type: string, entityId: string, data: unknown, actor = 'scribe:s1'): EventRow => ({ id: 1, ts: '2026-09-27T12:00:00Z', projectId: 1, actor, type, entity: 'x', entityId, data });

describe('describeEvent', () => {
  it('describes changes in plain words', () => {
    expect(describeEvent(ev('node.created', '58', { ids: [58], parentId: 55 }), snapshot)).toBe('added #58 Run signing tests');
    expect(describeEvent(ev('node.created', '58', { ids: [58, 59], parentId: 55 }), snapshot)).toBe('added 2 steps under #55 2 Android signing');
    expect(describeEvent(ev('node.updated', '58', { changes: { status: { from: 'todo', to: 'done' } } }), snapshot)).toBe('#58 Run signing tests → done');
    expect(describeEvent(ev('resource.created', '12', { nodeId: 58, title: 'Signing suite' }), snapshot)).toBe('"Signing suite" attached to #58 Run signing tests');
    expect(describeEvent(ev('log.created', '3', { nodeId: 55 }), snapshot)).toBe('note on #55 2 Android signing');
    expect(describeEvent(ev('session.updated', 's1', { changed: ['state'], state: 'permission' }), snapshot)).toBe('InGame launch status is waiting for a permission');
    expect(describeEvent(ev('session.updated', 's1', { changed: ['focusNodeId'], focusNodeId: 58 }), snapshot)).toBe('InGame launch status is on #58 Run signing tests');
  });

  it('labels actors', () => {
    expect(actorLabel(ev('node.created', '1', {}), snapshot)).toBe('scribe (InGame launch status)');
    expect(actorLabel(ev('node.created', '1', {}, 'hook:prompt'), snapshot)).toBe('Claude');
    expect(actorLabel(ev('node.created', '1', {}, 'system'), snapshot)).toBe('system');
  });
});

describe('relativeTime', () => {
  const now = Date.parse('2026-09-27T12:00:00Z');
  it('rounds to friendly units', () => {
    expect(relativeTime('2026-09-27T11:59:40Z', now)).toBe('just now');
    expect(relativeTime('2026-09-27T11:58:00Z', now)).toBe('2 min ago');
    expect(relativeTime('2026-09-27T09:00:00Z', now)).toBe('3 h ago');
    expect(relativeTime('2026-09-25T12:00:00Z', now)).toBe('2 d ago');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/web/describe.test.ts`
Expected: FAIL, cannot resolve `../../web/src/describe`.

- [ ] **Step 3: Implement `web/src/describe.ts` and `web/src/time.ts`**

`web/src/time.ts`:
```ts
export function relativeTime(iso: string, now: number = Date.now()): string {
  const seconds = Math.max(0, Math.round((now - Date.parse(iso)) / 1000));
  if (seconds < 45) return 'just now';
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours} h ago`;
  return `${Math.round(hours / 24)} d ago`;
}
```

`web/src/describe.ts`:
```ts
import { sessionDisplayTitle, type EventRow, type ProjectSnapshot } from '../../src/core/types';

const STATE_WORDS: Record<string, string> = { working: 'working', idle: 'idle', permission: 'waiting for a permission', ended: 'ended' };

function nodeLabel(id: number | undefined, snapshot: ProjectSnapshot | null): string {
  if (id === undefined) return 'a step';
  const node = snapshot?.nodes.find((n) => n.id === id);
  return node ? `#${id} ${node.title}` : `#${id}`;
}

function sessionLabel(id: string, snapshot: ProjectSnapshot | null): string {
  const s = snapshot?.sessions.find((x) => x.id === id);
  return s ? sessionDisplayTitle(s) : 'a session';
}

export function describeEvent(e: EventRow, snapshot: ProjectSnapshot | null): string {
  const d = (e.data ?? {}) as {
    ids?: number[]; parentId?: number; nodeId?: number; title?: string; path?: string;
    changes?: { status?: { to: string } }; changed?: string[]; state?: string; focusNodeId?: number | null;
  };
  switch (e.type) {
    case 'node.created':
      return (d.ids?.length ?? 1) === 1 ? `added ${nodeLabel(d.ids?.[0] ?? Number(e.entityId), snapshot)}` : `added ${d.ids!.length} steps under ${nodeLabel(d.parentId, snapshot)}`;
    case 'node.updated':
      return d.changes?.status ? `${nodeLabel(Number(e.entityId), snapshot)} → ${d.changes.status.to}` : `updated ${nodeLabel(Number(e.entityId), snapshot)}`;
    case 'node.moved':
      return `moved ${nodeLabel(Number(e.entityId), snapshot)}`;
    case 'node.deleted':
      return `removed ${d.ids?.length ?? 1} step(s)`;
    case 'resource.created':
      return `"${d.title ?? `r${e.entityId}`}" attached to ${nodeLabel(d.nodeId, snapshot)}`;
    case 'resource.updated':
      return `updated r${e.entityId}`;
    case 'resource.deleted':
      return `removed r${e.entityId}`;
    case 'log.created':
      return `note on ${nodeLabel(d.nodeId, snapshot)}`;
    case 'session.updated': {
      const who = sessionLabel(e.entityId, snapshot);
      if (d.changed?.includes('focusNodeId')) return d.focusNodeId ? `${who} is on ${nodeLabel(d.focusNodeId, snapshot)}` : `${who} cleared its focus`;
      return `${who} is ${STATE_WORDS[d.state ?? ''] ?? d.state ?? 'updated'}`;
    }
    case 'project.created':
      return 'project created';
    case 'project.updated':
      return 'project updated';
    case 'binding.created':
      return `folder bound: ${d.path ?? ''}`;
    case 'binding.deleted':
      return 'folder unbound';
    default:
      return e.type;
  }
}

export function actorLabel(e: EventRow, snapshot: ProjectSnapshot | null): string {
  if (e.actor.startsWith('scribe:')) {
    const s = snapshot?.sessions.find((x) => x.id === e.actor.slice('scribe:'.length));
    return s ? `scribe (${sessionDisplayTitle(s)})` : 'scribe';
  }
  if (e.actor.startsWith('hook:')) return 'Claude';
  return e.actor;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/web/describe.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Create the Vite project files**

`web/index.html`:
```html
<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <meta name="ip-ui-token" content="" />
    <link rel="icon" href="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 16 16'%3E%3Ccircle cx='8' cy='8' r='6' fill='%23d97757'/%3E%3C/svg%3E" />
    <title>InProgress</title>
  </head>
  <body>
    <div id="root"></div>
    <script type="module" src="/src/main.tsx"></script>
  </body>
</html>
```

`web/vite.config.ts`:
```ts
import { fileURLToPath } from 'node:url';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

export default defineConfig({
  root: fileURLToPath(new URL('.', import.meta.url)),
  plugins: [react()],
  build: { outDir: 'dist', emptyOutDir: true },
  server: {
    port: 5183,
    fs: { allow: ['..'] },
    // Host stays localhost:5183, which the server's host guard accepts.
    proxy: { '/api': { target: `http://127.0.0.1:${process.env.INPROGRESS_PORT ?? '4318'}` } },
  },
});
```

`web/tsconfig.json`:
```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ESNext",
    "moduleResolution": "Bundler",
    "lib": ["ES2022", "DOM", "DOM.Iterable"],
    "jsx": "react-jsx",
    "strict": true,
    "noEmit": true,
    "skipLibCheck": true,
    "isolatedModules": true,
    "types": []
  },
  "include": ["src", "../src/core"]
}
```

`scripts/dev.mjs`:
```js
// Dev loop: rebuilds and restarts the server on port 4318 with a throwaway data dir, and runs Vite on 5183.
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const repo = fileURLToPath(new URL('..', import.meta.url));
const env = { ...process.env, INPROGRESS_PORT: '4318', INPROGRESS_HOME: `${repo}.dev-home` };
const run = (command) => spawn(command, { cwd: repo, env, stdio: 'inherit', shell: true });
run('npx tsup --watch --onSuccess "node dist/server/main.js"');
run('npx vite --config web/vite.config.ts');
```

- [ ] **Step 6: Create the data layer**

`web/src/storage.ts`:
```ts
export function load(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

export function save(key: string, value: string): void {
  try {
    localStorage.setItem(key, value);
  } catch {
    // storage blocked: the UI still works without persistence
  }
}

export function loadJson<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(key);
    return raw ? (JSON.parse(raw) as T) : fallback;
  } catch {
    return fallback;
  }
}
```

`web/src/api.ts`:
```ts
import type { EventRow, NodeDetail, ProjectSnapshot, ProjectSummary, Resource } from '../../src/core/types';

async function getJson<T>(path: string): Promise<T> {
  const res = await fetch(path);
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { error?: string };
    throw new Error(body.error ?? `HTTP ${res.status}`);
  }
  return (await res.json()) as T;
}

const uiToken = () => document.querySelector<HTMLMetaElement>('meta[name="ip-ui-token"]')?.content ?? '';

export const api = {
  projects: () => getJson<ProjectSummary[]>('/api/projects'),
  project: (slug: string) => getJson<ProjectSnapshot>(`/api/projects/${encodeURIComponent(slug)}`),
  node: (id: number) => getJson<NodeDetail>(`/api/nodes/${id}`),
  resource: (id: number) => getJson<Resource>(`/api/resources/${id}`),
  /** 'reload' means the server restarted with a new UI token. */
  async openResource(id: number): Promise<'opened' | 'reload' | string> {
    const res = await fetch('/api/ui/open', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-ip-ui-token': uiToken() },
      body: JSON.stringify({ resourceId: id }),
    });
    if (res.ok) return 'opened';
    if (res.status === 401) return 'reload';
    const body = (await res.json().catch(() => ({}))) as { error?: string };
    return body.error ?? `HTTP ${res.status}`;
  },
};

/** Live events. Reconnects after errors and replays what was missed via ?since. */
export function subscribe(onEvent: (e: EventRow) => void, onStatus: (s: 'open' | 'reconnecting') => void): () => void {
  let source: EventSource | null = null;
  let closed = false;
  let lastId: number | undefined;
  let timer = 0;
  const connect = () => {
    source = new EventSource(lastId === undefined ? '/api/events/stream' : `/api/events/stream?since=${lastId}`);
    source.onopen = () => onStatus('open');
    source.onmessage = (m) => {
      const e = JSON.parse(m.data as string) as EventRow;
      lastId = e.id;
      onEvent(e);
    };
    source.onerror = () => {
      onStatus('reconnecting');
      source?.close();
      if (!closed) timer = window.setTimeout(connect, 1500);
    };
  };
  connect();
  return () => {
    closed = true;
    window.clearTimeout(timer);
    source?.close();
  };
}
```

`web/src/useInProgress.ts`:
```ts
import { useCallback, useEffect, useRef, useState } from 'react';
import type { EventRow, ProjectSnapshot, ProjectSummary } from '../../src/core/types';
import { api, subscribe } from './api';
import { load, save } from './storage';

const hashSlug = () => /^#\/p\/([^/]+)$/.exec(window.location.hash)?.[1] ?? null;

export interface InProgressState {
  projects: ProjectSummary[];
  slug: string | null;
  snapshot: ProjectSnapshot | null;
  /** Newest event for the activity strip, including the one loaded with the snapshot. */
  lastEvent: EventRow | null;
  /** Only events that arrived live over SSE: the camera follows these, never the loaded one. */
  liveEvent: EventRow | null;
  connection: 'open' | 'reconnecting';
  loaded: boolean;
  selectProject: (slug: string) => void;
}

export function useInProgress(): InProgressState {
  const [projects, setProjects] = useState<ProjectSummary[]>([]);
  const [slug, setSlug] = useState<string | null>(() => hashSlug() ?? load('ip.project'));
  const [snapshot, setSnapshot] = useState<ProjectSnapshot | null>(null);
  const [lastEvent, setLastEvent] = useState<EventRow | null>(null);
  const [liveEvent, setLiveEvent] = useState<EventRow | null>(null);
  const [connection, setConnection] = useState<'open' | 'reconnecting'>('open');
  const [loaded, setLoaded] = useState(false);
  const slugRef = useRef(slug);
  slugRef.current = slug;
  const projectIdRef = useRef<number | null>(null);
  projectIdRef.current = snapshot?.project.id ?? null;

  const loadProjects = useCallback(async () => {
    const list = await api.projects().catch(() => null);
    if (!list) return;
    setProjects(list);
    setLoaded(true);
    setSlug((cur) => (cur && list.some((p) => p.slug === cur) ? cur : (list.find((p) => p.status === 'active') ?? list[0])?.slug ?? null));
  }, []);

  const loadSnapshot = useCallback(async (s: string) => {
    const snap = await api.project(s).catch(() => null);
    if (slugRef.current !== s) return;
    setSnapshot(snap);
    if (snap) setLastEvent((cur) => (cur && cur.projectId === snap.project.id && cur.id >= (snap.lastEvent?.id ?? 0) ? cur : snap.lastEvent));
  }, []);

  useEffect(() => {
    void loadProjects();
  }, [loadProjects]);

  useEffect(() => {
    if (!slug) return;
    save('ip.project', slug);
    if (window.location.hash !== `#/p/${slug}`) window.history.replaceState(null, '', `#/p/${slug}`);
    setSnapshot(null);
    void loadSnapshot(slug);
  }, [slug, loadSnapshot]);

  useEffect(() => {
    const onHash = () => {
      const s = hashSlug();
      if (s) setSlug(s);
    };
    window.addEventListener('hashchange', onHash);
    return () => window.removeEventListener('hashchange', onHash);
  }, []);

  useEffect(() => {
    let projectTimer = 0;
    let snapshotTimer = 0;
    const refreshSnapshot = () => {
      window.clearTimeout(snapshotTimer);
      snapshotTimer = window.setTimeout(() => slugRef.current && void loadSnapshot(slugRef.current), 150);
    };
    const refreshProjects = () => {
      window.clearTimeout(projectTimer);
      projectTimer = window.setTimeout(() => void loadProjects(), 400);
    };
    const unsubscribe = subscribe(
      (e) => {
        refreshProjects();
        if (e.projectId !== null && e.projectId === projectIdRef.current) {
          setLastEvent(e);
          setLiveEvent(e);
          refreshSnapshot();
        }
      },
      (status) => {
        setConnection(status);
        // Refresh on every (re)connect: covers events that landed before the stream opened.
        if (status === 'open') {
          refreshProjects();
          refreshSnapshot();
        }
      },
    );
    return () => {
      unsubscribe();
      window.clearTimeout(projectTimer);
      window.clearTimeout(snapshotTimer);
    };
  }, [loadProjects, loadSnapshot]);

  return { projects, slug, snapshot, lastEvent, liveEvent, connection, loaded, selectProject: setSlug };
}
```

- [ ] **Step 7: Create the chrome components**

`web/src/chrome/TopBar.tsx`:
```tsx
import { useEffect, useRef, useState } from 'react';
import type { Project, ProjectSummary } from '../../../src/core/types';

interface TopBarProps {
  projects: ProjectSummary[];
  current: Project | null;
  onSelect: (slug: string) => void;
  needsYou: number;
  onNeedsYou: () => void;
  follow: boolean;
  onFollow: () => void;
}

function ProjectRow({ p, current, onPick }: { p: ProjectSummary; current: boolean; onPick: (slug: string) => void }) {
  const dot = p.workingSessions > 0 ? 'clay' : p.needsYou > 0 ? 'amber' : 'grey';
  const status = [p.workingSessions > 0 ? `◆ ${p.workingSessions} working` : p.activeSessions > 0 ? 'idle' : null, p.needsYou > 0 ? `${p.needsYou} need you` : null]
    .filter(Boolean)
    .join(' · ');
  return (
    <button role="option" aria-selected={current} className={`ip-mi${current ? ' cur' : ''}`} onClick={() => onPick(p.slug)}>
      <span className={`ip-dot ${dot}`} />
      <span className="nm">{p.name}</span>
      <span className="st">{status || 'no sessions'}</span>
    </button>
  );
}

export function TopBar({ projects, current, onSelect, needsYou, onNeedsYou, follow, onFollow }: TopBarProps) {
  const [open, setOpen] = useState(false);
  const [showArchived, setShowArchived] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent) => {
      if (!ref.current?.contains(e.target as Node)) setOpen(false);
    };
    window.addEventListener('mousedown', close);
    return () => window.removeEventListener('mousedown', close);
  }, [open]);
  const active = projects.filter((p) => p.status === 'active');
  const archived = projects.filter((p) => p.status === 'archived');
  const othersWorking = projects.some((p) => p.id !== current?.id && p.workingSessions > 0);
  const pick = (slug: string) => {
    onSelect(slug);
    setOpen(false);
  };
  return (
    <header className="ip-topbar">
      <div className="ip-switcher" ref={ref}>
        <button className="ip-proj" onClick={() => setOpen((o) => !o)} aria-haspopup="listbox" aria-expanded={open}>
          {open ? '▴' : '▾'} {current?.name ?? 'Projects'}
          {othersWorking && <span className="ip-dot clay" title="Another project has a working session" />}
        </button>
        {open && (
          <div className="ip-menu" role="listbox">
            {active.map((p) => (
              <ProjectRow key={p.id} p={p} current={p.id === current?.id} onPick={pick} />
            ))}
            {archived.length > 0 && (
              <>
                <div className="ip-sep" />
                <button className="ip-mi muted" onClick={() => setShowArchived((s) => !s)}>
                  Archived ({archived.length}) {showArchived ? '▾' : '▸'}
                </button>
                {showArchived && archived.map((p) => <ProjectRow key={p.id} p={p} current={p.id === current?.id} onPick={pick} />)}
              </>
            )}
          </div>
        )}
      </div>
      <span className="ip-spacer" />
      {needsYou > 0 && (
        <button className="ip-need" onClick={onNeedsYou} title="Jump to the next item waiting on you (N)">
          ● {needsYou} need you
        </button>
      )}
      <button className={`ip-follow${follow ? ' on' : ''}`} onClick={onFollow} title="Follow Claude's changes (F)">
        ⌖ Follow
      </button>
    </header>
  );
}
```

`web/src/chrome/SessionRow.tsx`:
```tsx
import { sessionDisplayTitle, type Session } from '../../../src/core/types';

const SUFFIX: Record<Session['state'], string> = { working: '', idle: ' · idle', permission: ' · needs permission', ended: ' · ended' };

export function SessionRow({ sessions, onPick }: { sessions: Session[]; onPick: (s: Session) => void }) {
  if (!sessions.length) return null;
  return (
    <div className="ip-sessions">
      {sessions.map((s) => (
        <button key={s.id} className={`ip-chip-s s-${s.state}`} onClick={() => onPick(s)} title={s.focusNodeId ? `On #${s.focusNodeId}` : 'No focus set yet'}>
          {s.state === 'working' && <span className="ip-pulse" />}
          {sessionDisplayTitle(s)}
          {s.subagents.length > 0 ? ` · ${s.subagents.length} subagent${s.subagents.length > 1 ? 's' : ''}` : ''}
          {SUFFIX[s.state]}
        </button>
      ))}
    </div>
  );
}
```

`web/src/chrome/ActivityStrip.tsx`:
```tsx
import { useEffect, useState } from 'react';
import type { EventRow, ProjectSnapshot } from '../../../src/core/types';
import { actorLabel, describeEvent } from '../describe';
import { relativeTime } from '../time';

function useNow(intervalMs: number): number {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const t = window.setInterval(() => setNow(Date.now()), intervalMs);
    return () => window.clearInterval(t);
  }, [intervalMs]);
  return now;
}

export function ActivityStrip({ event, snapshot }: { event: EventRow | null; snapshot: ProjectSnapshot }) {
  const now = useNow(30_000);
  if (!event) return <div className="ip-activity muted">No activity yet</div>;
  return (
    <div className="ip-activity" title={event.ts}>
      ↳ {actorLabel(event, snapshot)} · {relativeTime(event.ts, now)} · {describeEvent(event, snapshot)}
    </div>
  );
}
```

- [ ] **Step 8: Create `web/src/main.tsx`, a first `web/src/App.tsx`, and `web/src/styles.css`**

`web/src/main.tsx`:
```tsx
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { ReactFlowProvider } from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import './styles.css';
import { App } from './App';

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <ReactFlowProvider>
      <App />
    </ReactFlowProvider>
  </StrictMode>,
);
```

`web/src/App.tsx` (the canvas replaces the placeholder in Task 18):
```tsx
import { useEffect, useMemo } from 'react';
import { isNeedsYou } from '../../src/core/tree';
import { ActivityStrip } from './chrome/ActivityStrip';
import { SessionRow } from './chrome/SessionRow';
import { TopBar } from './chrome/TopBar';
import { useInProgress } from './useInProgress';

export function App() {
  const state = useInProgress();
  const { snapshot, projects } = state;
  const needsYou = useMemo(() => (snapshot ? snapshot.nodes.filter(isNeedsYou).length : 0), [snapshot]);
  useEffect(() => {
    document.title = `${needsYou ? `(${needsYou}) ` : ''}InProgress${snapshot ? ` · ${snapshot.project.name}` : ''}`;
  }, [needsYou, snapshot]);
  if (!state.loaded) return <div className="ip-empty">Loading…</div>;
  return (
    <div className="ip-app">
      <TopBar projects={projects} current={snapshot?.project ?? null} onSelect={state.selectProject} needsYou={needsYou} onNeedsYou={() => undefined} follow onFollow={() => undefined} />
      {snapshot && <SessionRow sessions={snapshot.sessions} onPick={() => undefined} />}
      {state.connection === 'reconnecting' && <div className="ip-banner">Reconnecting to InProgress…</div>}
      <main className="ip-main">
        {projects.length === 0 ? (
          <div className="ip-empty">No projects yet. In a Claude session, say "track this in InProgress".</div>
        ) : (
          <div className="ip-empty">{snapshot ? `${snapshot.nodes.length} nodes` : 'Loading project…'}</div>
        )}
      </main>
      {snapshot && <ActivityStrip event={state.lastEvent} snapshot={snapshot} />}
    </div>
  );
}
```

`web/src/styles.css`:
```css
:root {
  color-scheme: light dark;
  --bg: #f5f5f7;
  --panel: #ffffff;
  --panel-2: #ececef;
  --border: #d1d1d6;
  --text: #1d1d1f;
  --muted: #6e6e73;
  --faint: #aeaeb2;
  --accent: #0071e3;
  --green: #34c759;
  --amber: #ff9f0a;
  --amber-ink: #a35d00;
  --red: #ff3b30;
  --purple: #af52de;
  --clay: #d97757;
  --edge: #aeaeb2;
  --shadow: 0 8px 24px rgba(0, 0, 0, 0.14);
}
@media (prefers-color-scheme: dark) {
  :root {
    --bg: #1b1b1d;
    --panel: #2a2a2d;
    --panel-2: #333337;
    --border: #424245;
    --text: #f5f5f7;
    --muted: #a1a1a6;
    --faint: #636366;
    --accent: #0a84ff;
    --amber-ink: #ffb340;
    --edge: #636366;
    --shadow: 0 8px 24px rgba(0, 0, 0, 0.5);
  }
}
* { box-sizing: border-box; }
html, body, #root { height: 100%; margin: 0; }
body { font: 13px/1.45 system-ui, -apple-system, 'Segoe UI', sans-serif; background: var(--bg); color: var(--text); }
button { font: inherit; color: inherit; background: none; border: 0; cursor: pointer; padding: 0; }
.muted { color: var(--muted); }
.ip-app { display: flex; flex-direction: column; height: 100%; }
.ip-topbar { display: flex; align-items: center; gap: 8px; padding: 8px 10px; background: var(--panel); border-bottom: 1px solid var(--border); }
.ip-spacer { flex: 1; }
.ip-switcher { position: relative; }
.ip-proj { font-weight: 700; border: 1px solid var(--border); border-radius: 6px; padding: 2px 8px; display: flex; align-items: center; gap: 6px; }
.ip-menu { position: absolute; top: calc(100% + 4px); left: 0; width: 320px; max-width: calc(100vw - 20px); background: var(--panel); border: 1px solid var(--border); border-radius: 10px; box-shadow: var(--shadow); padding: 6px; z-index: 20; }
.ip-mi { display: flex; align-items: center; gap: 8px; width: 100%; padding: 7px 8px; border-radius: 7px; text-align: left; }
.ip-mi:hover, .ip-mi.cur { background: var(--panel-2); }
.ip-mi .nm { font-weight: 600; }
.ip-mi .st { margin-left: auto; font-size: 11px; color: var(--muted); }
.ip-sep { height: 1px; background: var(--border); margin: 4px 6px; }
.ip-dot { width: 8px; height: 8px; border-radius: 50%; display: inline-block; flex: none; }
.ip-dot.clay { background: var(--clay); }
.ip-dot.amber { background: var(--amber); }
.ip-dot.grey { border: 1.5px solid var(--faint); }
.ip-need { border: 1px solid var(--amber); color: var(--amber-ink); background: color-mix(in srgb, var(--amber) 14%, transparent); border-radius: 10px; padding: 0 8px; font-weight: 600; font-size: 12px; }
.ip-follow { border: 1px solid var(--border); border-radius: 6px; padding: 0 7px; font-size: 12px; color: var(--muted); }
.ip-follow.on { border-color: var(--accent); color: var(--accent); }
.ip-sessions { display: flex; flex-wrap: wrap; gap: 6px; padding: 6px 10px; background: var(--panel); border-bottom: 1px solid var(--border); }
.ip-chip-s { display: inline-flex; align-items: center; gap: 6px; border-radius: 10px; padding: 1px 9px; font-size: 12px; font-weight: 600; border: 1px solid var(--clay); color: var(--clay); }
.ip-chip-s.s-working { background: var(--clay); color: #fff; }
.ip-chip-s.s-permission { border-color: var(--red); color: var(--red); }
.ip-pulse { width: 6px; height: 6px; border-radius: 50%; background: currentColor; animation: ip-pulse 1.6s ease-in-out infinite; }
@keyframes ip-pulse { 0%, 100% { opacity: 1; } 50% { opacity: 0.3; } }
.ip-main { flex: 1; position: relative; min-height: 0; display: flex; }
.ip-activity { font-size: 12px; color: var(--muted); padding: 6px 10px; border-top: 1px solid var(--border); background: var(--panel); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.ip-banner { background: var(--amber); color: #000; font-size: 12px; padding: 3px 10px; }
.ip-empty { margin: auto; color: var(--muted); text-align: center; padding: 24px; max-width: 420px; }
```

- [ ] **Step 9: Type-check and build the UI**

Run: `npx tsc -p web/tsconfig.json && npm run build:web`
Expected: no type errors; Vite writes `web/dist/index.html` and `web/dist/assets/*`.

- [ ] **Step 10: Commit**

```bash
git add web scripts/dev.mjs test/web
git commit -m "Add the web app shell: live data, top bar, sessions and activity strip

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 18: The whiteboard canvas: nodes, camera, folding, keyboard

**Files:**
- Create: `web/src/canvas/breadcrumb.ts`, `web/src/canvas/NodeCard.tsx`, `web/src/canvas/MoreNode.tsx`, `web/src/canvas/BadgeNode.tsx`, `web/src/canvas/useCamera.ts`, `web/src/canvas/Canvas.tsx`, `web/src/useFoldOverrides.ts`, `web/src/useKeyboard.ts`
- Modify: `web/src/App.tsx` (replace the placeholder with the canvas), `web/src/styles.css` (append canvas styles)
- Test: `test/web/breadcrumb.test.ts`

**Interfaces:**
- Consumes: `layoutOutline`, `findFrontier`, `needsYouOrder`, `eventTarget`, `NODE_H`, layout types (layout.ts); `buildIndex`, `ancestors`, `TreeIndex`, `FoldOverrides` (tree.ts); `load`/`save`/`loadJson`.
- Produces:
  - `breadcrumbFor(layout, index, viewport: { x; y; zoom }): string[]`
  - `useCamera({ layout, snapshot, index, lastEvent, follow }) → { centerOn(id, duration?): boolean; centerOnFrontier(duration?, zoom?): void; nextNeedsYou(): number | undefined }`
  - `Canvas` (forwardRef) with `CanvasHandle = { focusNode(id); nextNeedsYou(); goRoot(); goFrontier() }` and props `{ snapshot; lastEvent; follow; onFollowChange; overrides; onToggleFold(key, value); selectedNode; onSelectNode(id); onOpenResource(id) }`
  - `useFoldOverrides(projectId) → [FoldOverrides, (key, value) => void]`, `useKeyboard({ onFollow, onNext, onHome, onEnd, onEscape })`
  - DOM contract used by e2e tests: node card `.ip-node` with classes `st-<status>`, `needs-you`, `flash`, `selected`; YOU tag `.ip-you`; resource chip `.ip-chip`; hidden run `.ip-more`; session badge `.ip-badge`.

- [ ] **Step 1: Write the failing test**

`test/web/breadcrumb.test.ts`:
```ts
import { describe, expect, it } from 'vitest';
import { ROW, layoutOutline } from '../../src/core/layout';
import { buildIndex } from '../../src/core/tree';
import type { TreeNode } from '../../src/core/types';
import { breadcrumbFor } from '../../web/src/canvas/breadcrumb';

const node = (id: number, parentId: number | null, title: string): TreeNode => ({
  id, projectId: 1, parentId, position: id, kind: parentId === null ? 'goal' : 'task', title, body: '', status: 'active', assignee: 'claude', outcome: '', createdAt: 't', updatedAt: 't', completedAt: null,
});

describe('breadcrumbFor', () => {
  const nodes = [node(1, null, 'InGame'), node(2, 1, 'Road to market'), node(3, 2, 'Android signing'), node(4, 3, 'Play app signing')];
  const layout = layoutOutline({ nodes, resources: [], sessions: [] });
  const index = buildIndex(nodes);

  it('is empty when the root is at the top of the view', () => {
    expect(breadcrumbFor(layout, index, { x: 0, y: 0, zoom: 1 })).toEqual([]);
  });

  it('shows the ancestors of the topmost visible row', () => {
    expect(breadcrumbFor(layout, index, { x: 0, y: -2 * ROW, zoom: 1 })).toEqual(['InGame', 'Road to market']);
    expect(breadcrumbFor(layout, index, { x: 0, y: -1 * ROW, zoom: 0.5 })).toEqual(['InGame', 'Road to market']);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/web/breadcrumb.test.ts`
Expected: FAIL, cannot resolve `../../web/src/canvas/breadcrumb`.

- [ ] **Step 3: Implement `web/src/canvas/breadcrumb.ts`**

```ts
import { NODE_H, type LayoutNodeItem, type LayoutResult } from '../../../src/core/layout';
import { ancestors, type TreeIndex } from '../../../src/core/tree';

/** Titles above the topmost row that is still (partly) visible. */
export function breadcrumbFor(layout: LayoutResult, index: TreeIndex, viewport: { x: number; y: number; zoom: number }): string[] {
  const top = -viewport.y / viewport.zoom;
  const first = layout.items.find((i): i is LayoutNodeItem => i.kind === 'node' && i.y + NODE_H > top);
  return first ? ancestors(index, first.nodeId).map((n) => n.title) : [];
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/web/breadcrumb.test.ts`
Expected: PASS (2 tests). (Last case: `y = -32` at zoom 0.5 puts the top at flow y 64, the third row, so the ancestors are the first two titles.)

- [ ] **Step 5: Create the node components**

`web/src/canvas/NodeCard.tsx`:
```tsx
import { Handle, Position, type Node, type NodeProps } from '@xyflow/react';
import type { ResourceMeta, TreeNode } from '../../../src/core/types';

export interface NodeCardData extends Record<string, unknown> {
  node: TreeNode;
  folded: boolean;
  doneCount: number;
  progress: { done: number; total: number } | null;
  needsYou: boolean;
  hasChildren: boolean;
  working: boolean;
  resources: ResourceMeta[];
  flash: boolean;
  selected: boolean;
  onToggleFold: (key: string, value: 'open' | 'closed') => void;
  onOpenResource: (id: number) => void;
}

export function NodeCard({ data }: NodeProps<Node<NodeCardData, 'ipNode'>>) {
  const { node, folded, doneCount, progress, needsYou, hasChildren, working, resources, flash, selected } = data;
  const classes = ['ip-node', `st-${node.status}`, needsYou && 'needs-you', working && 'working', flash && 'flash', selected && 'selected', node.parentId === null && 'root']
    .filter(Boolean)
    .join(' ');
  return (
    <div className="ip-row">
      <Handle type="target" position={Position.Left} id="in" className="ip-handle" />
      <div className={classes} title={`#${node.id}`}>
        <span className={`ip-marker m-${node.status}${node.kind === 'question' ? ' q' : ''}`}>{node.kind === 'question' ? '?' : ''}</span>
        <span className="ip-title">
          {node.title}
          {folded ? ` · ${doneCount} done` : ''}
        </span>
        {needsYou && <span className="ip-you">YOU</span>}
        {node.status === 'blocked' && <span className="ip-blocked">blocked</span>}
        {progress && <span className="ip-progress">{progress.done}/{progress.total}</span>}
        {hasChildren && (
          <button
            className="ip-chevron"
            aria-label={folded ? 'Unfold' : 'Fold'}
            onClick={(e) => {
              e.stopPropagation();
              data.onToggleFold(`n:${node.id}`, folded ? 'open' : 'closed');
            }}
          >
            {folded ? '▸' : '▾'}
          </button>
        )}
      </div>
      {resources.slice(0, 2).map((r) => (
        <button
          key={r.id}
          className="ip-chip"
          title={`r${r.id} ${r.title}`}
          onClick={(e) => {
            e.stopPropagation();
            data.onOpenResource(r.id);
          }}
        >
          ▤ {r.title}
        </button>
      ))}
      {resources.length > 2 && <span className="ip-chip">+{resources.length - 2}</span>}
      <Handle type="source" position={Position.Bottom} id="out" className="ip-handle" style={{ left: 12 }} />
    </div>
  );
}
```

`web/src/canvas/MoreNode.tsx`:
```tsx
import { Handle, Position, type Node, type NodeProps } from '@xyflow/react';

export interface MoreNodeData extends Record<string, unknown> {
  count: number;
  parentId: number;
  onToggleFold: (key: string, value: 'open' | 'closed') => void;
}

export function MoreNode({ data }: NodeProps<Node<MoreNodeData, 'ipMore'>>) {
  return (
    <div
      className="ip-more"
      onClick={(e) => {
        e.stopPropagation();
        data.onToggleFold(`more:${data.parentId}`, 'open');
      }}
    >
      <Handle type="target" position={Position.Left} id="in" className="ip-handle" />+{data.count} more
    </div>
  );
}
```

`web/src/canvas/BadgeNode.tsx`:
```tsx
import type { Node, NodeProps } from '@xyflow/react';
import { sessionDisplayTitle, type Session } from '../../../src/core/types';

const WORDS: Record<Session['state'], string> = { working: 'working', idle: 'idle', permission: 'needs permission', ended: 'ended' };

export interface BadgeNodeData extends Record<string, unknown> {
  session: Session;
}

export function BadgeNode({ data }: NodeProps<Node<BadgeNodeData, 'ipBadge'>>) {
  const s = data.session;
  const subs = s.subagents.length;
  return (
    <div className={`ip-badge s-${s.state}`} title={subs ? s.subagents.map((a) => a.agentType).join(', ') : undefined}>
      {s.state === 'working' && <span className="ip-pulse" />}◆ {sessionDisplayTitle(s)} · {WORDS[s.state]}
      {subs ? ` · ${subs} subagent${subs > 1 ? 's' : ''}` : ''}
    </div>
  );
}
```

- [ ] **Step 6: Create the camera hook `web/src/canvas/useCamera.ts`**

```ts
import { useCallback, useEffect, useMemo, useRef } from 'react';
import { useReactFlow } from '@xyflow/react';
import { NODE_H, eventTarget, findFrontier, needsYouOrder, type LayoutNodeItem, type LayoutResult } from '../../../src/core/layout';
import type { TreeIndex } from '../../../src/core/tree';
import type { EventRow, ProjectSnapshot } from '../../../src/core/types';

interface CameraArgs {
  layout: LayoutResult;
  snapshot: ProjectSnapshot;
  index: TreeIndex;
  lastEvent: EventRow | null;
  follow: boolean;
}

/** Horizontal offset so the card, not its left edge, sits in the middle of the view. */
const CARD_CENTER_X = 140;
const FOLLOW_INTERVAL_MS = 1500;

export function useCamera({ layout, snapshot, index, lastEvent, follow }: CameraArgs) {
  const rf = useReactFlow();
  const layoutRef = useRef(layout);
  layoutRef.current = layout;
  const indexRef = useRef(index);
  indexRef.current = index;
  const snapRef = useRef(snapshot);
  snapRef.current = snapshot;
  const lastMove = useRef(0);
  const timer = useRef(0);
  const cursor = useRef(-1);

  /** The node's row, or its nearest visible ancestor's when it is folded away. */
  const itemFor = useCallback((nodeId: number): LayoutNodeItem | undefined => {
    let id: number | null = nodeId;
    while (id !== null) {
      const item = layoutRef.current.nodeItems.get(id);
      if (item) return item;
      id = indexRef.current.byId.get(id)?.parentId ?? null;
    }
    return undefined;
  }, []);

  const centerOn = useCallback(
    (nodeId: number, duration = 400): boolean => {
      const item = itemFor(nodeId);
      if (!item) return false;
      void rf.setCenter(item.x + CARD_CENTER_X, item.y + NODE_H / 2, { zoom: rf.getZoom(), duration });
      lastMove.current = Date.now();
      return true;
    },
    [rf, itemFor],
  );

  const centerOnFrontier = useCallback(
    (duration = 400, zoom?: number) => {
      const s = snapRef.current;
      const id = findFrontier(s.nodes, s.sessions, layoutRef.current);
      const item = id !== undefined ? itemFor(id) : undefined;
      if (!item) return;
      void rf.setCenter(item.x + CARD_CENTER_X, item.y + NODE_H / 2, { zoom: zoom ?? rf.getZoom(), duration });
      lastMove.current = Date.now();
    },
    [rf, itemFor],
  );

  // Follow Claude's changes: at most one move per 1.5 s (latest target wins), retrying
  // briefly because the snapshot that contains a brand-new node arrives ~150 ms after its event.
  useEffect(() => {
    if (!follow || !lastEvent) return;
    const target = eventTarget(lastEvent);
    if (target === undefined) return;
    let attempts = 0;
    const attempt = () => {
      if (centerOn(target) || ++attempts >= 4) return;
      timer.current = window.setTimeout(attempt, 300);
    };
    window.clearTimeout(timer.current);
    timer.current = window.setTimeout(attempt, Math.max(350, FOLLOW_INTERVAL_MS - (Date.now() - lastMove.current)));
    return () => window.clearTimeout(timer.current);
  }, [lastEvent, follow, centerOn]);

  const nextNeedsYou = useCallback((): number | undefined => {
    const ids = needsYouOrder(layoutRef.current);
    if (!ids.length) return undefined;
    cursor.current = (cursor.current + 1) % ids.length;
    const id = ids[cursor.current];
    centerOn(id);
    return id;
  }, [centerOn]);

  return useMemo(() => ({ centerOn, centerOnFrontier, nextNeedsYou }), [centerOn, centerOnFrontier, nextNeedsYou]);
}
```

- [ ] **Step 7: Create `web/src/canvas/Canvas.tsx`**

```tsx
import { forwardRef, useCallback, useImperativeHandle, useMemo, useState } from 'react';
import { Background, BackgroundVariant, Controls, MiniMap, ReactFlow, type Edge, type Node, type Viewport } from '@xyflow/react';
import { layoutOutline, type LayoutItem } from '../../../src/core/layout';
import { buildIndex, type FoldOverrides } from '../../../src/core/tree';
import type { EventRow, ProjectSnapshot } from '../../../src/core/types';
import { BadgeNode } from './BadgeNode';
import { breadcrumbFor } from './breadcrumb';
import { MoreNode } from './MoreNode';
import { NodeCard, type NodeCardData } from './NodeCard';
import { useCamera } from './useCamera';

const nodeTypes = { ipNode: NodeCard, ipMore: MoreNode, ipBadge: BadgeNode };

export interface CanvasHandle {
  focusNode: (id: number) => void;
  nextNeedsYou: () => void;
  goRoot: () => void;
  goFrontier: () => void;
}

export interface CanvasProps {
  snapshot: ProjectSnapshot;
  lastEvent: EventRow | null;
  follow: boolean;
  onFollowChange: (follow: boolean) => void;
  overrides: FoldOverrides;
  onToggleFold: (key: string, value: 'open' | 'closed') => void;
  selectedNode: number | null;
  onSelectNode: (id: number) => void;
  onOpenResource: (id: number) => void;
}

function minimapColor(n: Node): string {
  if (n.type === 'ipBadge') return '#d97757';
  if (n.type === 'ipMore') return '#aeaeb2';
  const d = n.data as NodeCardData;
  if (d.needsYou) return '#ff9f0a';
  if (d.node.status === 'done') return '#34c759';
  if (d.node.status === 'active') return '#0a84ff';
  return '#aeaeb2';
}

export const Canvas = forwardRef<CanvasHandle, CanvasProps>(function Canvas(props, ref) {
  const { snapshot, overrides, onToggleFold, onOpenResource, selectedNode } = props;
  const layout = useMemo(
    () => layoutOutline({ nodes: snapshot.nodes, resources: snapshot.resources, sessions: snapshot.sessions, overrides }),
    [snapshot, overrides],
  );
  const index = useMemo(() => buildIndex(snapshot.nodes), [snapshot.nodes]);
  const [flash, setFlash] = useState<number | null>(null);
  const [crumb, setCrumb] = useState<string[]>([]);
  const camera = useCamera({ layout, snapshot, index, lastEvent: props.lastEvent, follow: props.follow });

  const nodes = useMemo<Node[]>(() => {
    const resourcesById = new Map(snapshot.resources.map((r) => [r.id, r]));
    const sessionsById = new Map(snapshot.sessions.map((s) => [s.id, s]));
    const toNode = (item: LayoutItem): Node | null => {
      const position = { x: item.x, y: item.y };
      if (item.kind === 'more') {
        return { id: item.id, type: 'ipMore', position, data: { count: item.hiddenIds.length, parentId: item.parentId, onToggleFold }, draggable: false, selectable: false };
      }
      if (item.kind === 'badge') {
        const session = sessionsById.get(item.sessionId);
        return session ? { id: item.id, type: 'ipBadge', position, data: { session }, draggable: false, selectable: false } : null;
      }
      const node = index.byId.get(item.nodeId)!;
      const data: NodeCardData = {
        node,
        folded: item.folded,
        doneCount: item.doneCount,
        progress: item.progress,
        needsYou: item.needsYou,
        hasChildren: item.hasChildren,
        working: item.working,
        resources: item.resourceIds.map((id) => resourcesById.get(id)).filter((r): r is NonNullable<typeof r> => !!r),
        flash: flash === item.nodeId,
        selected: selectedNode === item.nodeId,
        onToggleFold,
        onOpenResource,
      };
      return { id: item.id, type: 'ipNode', position, data, draggable: false, selectable: false };
    };
    return layout.items.map(toNode).filter((n): n is Node => n !== null);
  }, [layout, index, snapshot.resources, snapshot.sessions, flash, selectedNode, onToggleFold, onOpenResource]);

  const edges = useMemo<Edge[]>(
    () =>
      layout.edges.map((e) => ({
        id: e.id,
        source: e.source,
        target: e.target,
        sourceHandle: 'out',
        targetHandle: 'in',
        type: 'step',
        // The source handle sits 12 px in and children indent 28 px: an offset of 16 keeps the rail straight.
        pathOptions: { offset: 16 },
        selectable: false,
        focusable: false,
        style: { stroke: 'var(--edge)', strokeWidth: 1.2 },
      })),
    [layout.edges],
  );

  useImperativeHandle(
    ref,
    () => ({
      focusNode: (id) => void camera.centerOn(id),
      nextNeedsYou: () => {
        const id = camera.nextNeedsYou();
        if (id === undefined) return;
        setFlash(id);
        window.setTimeout(() => setFlash((f) => (f === id ? null : f)), 1500);
      },
      goRoot: () => {
        if (index.root) camera.centerOn(index.root.id);
      },
      goFrontier: () => camera.centerOnFrontier(),
    }),
    [camera, index],
  );

  const { onFollowChange } = props;
  // onMove fires only when the viewport actually changes: a user pan or zoom carries an event,
  // programmatic camera moves carry null. (onMoveStart would also fire on plain clicks.)
  const onMove = useCallback(
    (event: MouseEvent | TouchEvent | null, vp: Viewport) => {
      if (event) onFollowChange(false);
      setCrumb(breadcrumbFor(layout, index, vp));
    },
    [layout, index, onFollowChange],
  );

  return (
    <div className="ip-canvas">
      {crumb.length > 0 && <div className="ip-crumb">{crumb.join(' › ')}</div>}
      <ReactFlow
        nodes={nodes}
        edges={edges}
        nodeTypes={nodeTypes}
        onInit={() => requestAnimationFrame(() => camera.centerOnFrontier(0, 1))}
        onNodeClick={(_, n) => {
          if (n.type === 'ipNode') props.onSelectNode((n.data as NodeCardData).node.id);
        }}
        onMove={onMove}
        minZoom={0.15}
        maxZoom={2}
        panOnScroll
        nodesDraggable={false}
        nodesConnectable={false}
        elementsSelectable={false}
        proOptions={{ hideAttribution: true }}
      >
        <Background variant={BackgroundVariant.Dots} gap={16} size={1} />
        <MiniMap position="bottom-right" pannable zoomable nodeColor={minimapColor} />
        <Controls position="bottom-left" showInteractive={false} />
      </ReactFlow>
    </div>
  );
});
```

- [ ] **Step 8: Create the fold-override and keyboard hooks**

`web/src/useFoldOverrides.ts`:
```ts
import { useCallback, useEffect, useState } from 'react';
import type { FoldOverrides } from '../../src/core/tree';
import { loadJson, save } from './storage';

const stored = (projectId: number | undefined): FoldOverrides =>
  projectId === undefined ? {} : loadJson<FoldOverrides>(`ip.folds.${projectId}`, {});

/**
 * Per-project manual fold state, persisted in localStorage. Loaded synchronously so the first
 * layout already honours it. Folding a node also re-collapses its "+n more" tail, which makes
 * "+n more" a toggle: fold and unfold the parent to hide the tail again.
 */
export function useFoldOverrides(projectId: number | undefined): [FoldOverrides, (key: string, value: 'open' | 'closed') => void] {
  const [overrides, setOverrides] = useState<FoldOverrides>(() => stored(projectId));
  useEffect(() => {
    setOverrides(stored(projectId));
  }, [projectId]);
  const set = useCallback(
    (key: string, value: 'open' | 'closed') => {
      setOverrides((cur) => {
        const next: FoldOverrides = { ...cur, [key]: value };
        if (key.startsWith('n:') && value === 'closed') delete next[`more:${key.slice(2)}`];
        if (projectId !== undefined) save(`ip.folds.${projectId}`, JSON.stringify(next));
        return next;
      });
    },
    [projectId],
  );
  return [overrides, set];
}
```

`web/src/useKeyboard.ts`:
```ts
import { useEffect, useRef } from 'react';

export interface KeyHandlers {
  onFollow: () => void;
  onNext: () => void;
  onHome: () => void;
  onEnd: () => void;
  onEscape: () => void;
}

export function useKeyboard(handlers: KeyHandlers): void {
  const ref = useRef(handlers);
  ref.current = handlers;
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.ctrlKey || e.metaKey || e.altKey) return;
      const target = e.target as HTMLElement | null;
      if (target && (target.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName))) return;
      const h = ref.current;
      const map: Record<string, () => void> = { f: h.onFollow, F: h.onFollow, n: h.onNext, N: h.onNext, Home: h.onHome, End: h.onEnd, Escape: h.onEscape };
      const fn = map[e.key];
      if (!fn) return;
      e.preventDefault();
      fn();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);
}
```

- [ ] **Step 9: Replace `web/src/App.tsx`**

```tsx
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { isNeedsYou } from '../../src/core/tree';
import { Canvas, type CanvasHandle } from './canvas/Canvas';
import { ActivityStrip } from './chrome/ActivityStrip';
import { SessionRow } from './chrome/SessionRow';
import { TopBar } from './chrome/TopBar';
import { useFoldOverrides } from './useFoldOverrides';
import { useInProgress } from './useInProgress';
import { useKeyboard } from './useKeyboard';

export function App() {
  const state = useInProgress();
  const { snapshot, projects } = state;
  const [follow, setFollow] = useState(true);
  const [selectedNode, setSelectedNode] = useState<number | null>(null);
  const [overrides, setOverride] = useFoldOverrides(snapshot?.project.id);
  const canvas = useRef<CanvasHandle>(null);
  const needsYou = useMemo(() => (snapshot ? snapshot.nodes.filter(isNeedsYou).length : 0), [snapshot]);

  useEffect(() => {
    document.title = `${needsYou ? `(${needsYou}) ` : ''}InProgress${snapshot ? ` · ${snapshot.project.name}` : ''}`;
  }, [needsYou, snapshot]);
  useEffect(() => setSelectedNode(null), [snapshot?.project.id]);

  const followOn = useCallback(() => {
    setFollow(true);
    canvas.current?.goFrontier();
  }, []);

  useKeyboard({
    onFollow: () => (follow ? setFollow(false) : followOn()),
    onNext: () => canvas.current?.nextNeedsYou(),
    onHome: () => canvas.current?.goRoot(),
    onEnd: () => canvas.current?.goFrontier(),
    onEscape: () => setSelectedNode(null),
  });

  if (!state.loaded) return <div className="ip-empty">Loading…</div>;
  return (
    <div className="ip-app">
      <TopBar
        projects={projects}
        current={snapshot?.project ?? null}
        onSelect={state.selectProject}
        needsYou={needsYou}
        onNeedsYou={() => canvas.current?.nextNeedsYou()}
        follow={follow}
        onFollow={followOn}
      />
      {snapshot && <SessionRow sessions={snapshot.sessions} onPick={(s) => s.focusNodeId !== null && canvas.current?.focusNode(s.focusNodeId)} />}
      {state.connection === 'reconnecting' && <div className="ip-banner">Reconnecting to InProgress…</div>}
      <main className="ip-main">
        {projects.length === 0 ? (
          <div className="ip-empty">No projects yet. In a Claude session, say "track this in InProgress".</div>
        ) : snapshot ? (
          <Canvas
            key={snapshot.project.id}
            ref={canvas}
            snapshot={snapshot}
            lastEvent={state.liveEvent}
            follow={follow}
            onFollowChange={setFollow}
            overrides={overrides}
            onToggleFold={setOverride}
            selectedNode={selectedNode}
            onSelectNode={setSelectedNode}
            onOpenResource={() => undefined}
          />
        ) : (
          <div className="ip-empty">Loading project…</div>
        )}
      </main>
      {snapshot && <ActivityStrip event={state.lastEvent} snapshot={snapshot} />}
    </div>
  );
}
```

- [ ] **Step 10: Append the canvas styles to `web/src/styles.css`**

```css
.ip-canvas { flex: 1; position: relative; min-width: 0; }
.ip-canvas .react-flow { background: var(--bg); }
.ip-crumb { position: absolute; top: 8px; left: 10px; z-index: 5; font-size: 11px; color: var(--muted); background: var(--panel); border: 1px solid var(--border); border-radius: 6px; padding: 0 8px; max-width: calc(100% - 20px); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.ip-row { display: flex; align-items: center; gap: 8px; }
.ip-node { display: flex; align-items: center; gap: 6px; height: 24px; padding: 0 8px; background: var(--panel); border: 1px solid var(--border); border-radius: 6px; font-size: 12px; white-space: nowrap; max-width: 360px; cursor: pointer; color: var(--text); }
.ip-node .ip-title { overflow: hidden; text-overflow: ellipsis; }
.ip-node.root { font-weight: 700; }
.ip-node.st-active { border: 2px solid var(--accent); }
.ip-node.needs-you { border: 2px solid var(--amber); }
.ip-node.st-todo:not(.needs-you) { opacity: 0.75; }
.ip-node.st-dropped .ip-title { text-decoration: line-through; color: var(--muted); }
.ip-node.selected { box-shadow: 0 0 0 3px color-mix(in srgb, var(--accent) 35%, transparent); }
.ip-node.flash { animation: ip-flash 1.2s ease-out; }
@keyframes ip-flash { 0% { box-shadow: 0 0 0 7px color-mix(in srgb, var(--amber) 60%, transparent); } 100% { box-shadow: 0 0 0 0 transparent; } }
.ip-marker { width: 8px; height: 8px; border-radius: 50%; flex: none; display: inline-flex; align-items: center; justify-content: center; font-size: 9px; font-weight: 800; color: #fff; }
.ip-marker.q { width: 12px; height: 12px; }
.ip-marker.m-done { background: var(--green); }
.ip-marker.m-active { background: var(--accent); }
.ip-marker.m-todo { border: 1.5px solid var(--faint); color: var(--muted); }
.ip-marker.m-blocked { background: var(--red); }
.ip-marker.m-dropped { background: var(--faint); }
.ip-node.needs-you .ip-marker { background: var(--amber); border: 0; color: #fff; }
.ip-node.working .ip-marker.m-active { animation: ip-pulse 1.6s ease-in-out infinite; }
.ip-you { background: var(--amber); color: #fff; border-radius: 3px; font-size: 9px; font-weight: 700; padding: 0 4px; }
.ip-blocked { color: var(--red); font-size: 10px; font-weight: 600; }
.ip-progress { color: var(--muted); font-size: 11px; }
.ip-chevron { color: var(--muted); font-size: 11px; padding: 0 2px; }
.ip-chip { font-size: 11px; color: var(--purple); background: color-mix(in srgb, var(--purple) 12%, transparent); border: 1px solid var(--purple); border-radius: 4px; padding: 0 6px; white-space: nowrap; max-width: 180px; overflow: hidden; text-overflow: ellipsis; }
.ip-more { height: 24px; display: flex; align-items: center; padding: 0 8px; border: 1px dashed var(--border); border-radius: 6px; font-size: 12px; color: var(--muted); background: var(--panel); cursor: pointer; }
.ip-badge { display: inline-flex; align-items: center; gap: 6px; height: 18px; padding: 0 8px; border-radius: 4px; font-size: 11px; font-weight: 600; color: #fff; background: var(--clay); white-space: nowrap; }
.ip-badge.s-idle { background: transparent; color: var(--clay); border: 1px solid var(--clay); }
.ip-badge.s-permission { background: transparent; color: var(--red); border: 1px solid var(--red); }
.ip-handle { opacity: 0; width: 1px; height: 1px; min-width: 0; min-height: 0; border: 0; }
```

- [ ] **Step 11: Type-check, build, and look at it**

Run: `npx tsc -p web/tsconfig.json && npm run build`
Expected: no errors. Then run `npm run dev`, seed a project with a nested plan through the API (token from `.dev-home/token`), open http://localhost:5183, and check in the browser (in the Vite dev page the UI token is empty, so "Open file" answers 401 and reloads; test that button against the built UI at http://127.0.0.1:4318 instead): rows stack downward with elbow connectors, finished branches fold, `+n more` expands on click, the Follow toggle turns off when you drag and back on with F, N cycles needs-you items. Stop the dev loop afterwards.

- [ ] **Step 12: Commit**

```bash
git add web test/web
git commit -m "Add the whiteboard canvas with folding, camera follow and keyboard control

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 19: Node details panel and resource viewer

**Files:**
- Create: `web/src/panels/format.ts`, `web/src/panels/Markdown.tsx`, `web/src/panels/Details.tsx`, `web/src/panels/ResourceViewer.tsx`
- Modify: `web/src/App.tsx` (wire both panels), `web/src/styles.css` (append panel styles)
- Test: `test/web/format.test.ts`

**Interfaces:**
- Consumes: `api.node`, `api.resource`, `api.openResource`; `isNeedsYou`; `relativeTime`; core types.
- Produces: `resourceSummary(r: ResourceMeta): string`; `Markdown({ text })`; `Details({ nodeId, snapshot, onClose, onSelectNode, onOpenResource })` rendered as `<aside>` (role complementary); `ResourceViewer({ resourceId, onClose })` rendered with `role="dialog"`.

- [ ] **Step 1: Write the failing test**

`test/web/format.test.ts`:
```ts
import { describe, expect, it } from 'vitest';
import type { ResourceMeta } from '../../src/core/types';
import { resourceSummary } from '../../web/src/panels/format';

const base: ResourceMeta = { id: 1, projectId: 1, nodeId: 1, kind: 'test-suite', title: 'Suite', path: null, url: null, contentLength: 0, sessionId: null, createdAt: 't', updatedAt: 't' };

describe('resourceSummary', () => {
  it('summarizes kind, size, and where it lives', () => {
    expect(resourceSummary({ ...base, contentLength: 420 })).toBe('test-suite · 420 chars');
    expect(resourceSummary({ ...base, contentLength: 3210, path: 'C:/x.md' })).toBe('test-suite · 3.2k chars · file');
    expect(resourceSummary({ ...base, kind: 'link', url: 'https://example.com' })).toBe('link · link');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/web/format.test.ts`
Expected: FAIL, cannot resolve `../../web/src/panels/format`.

- [ ] **Step 3: Implement `web/src/panels/format.ts`**

```ts
import type { ResourceMeta } from '../../../src/core/types';

export function resourceSummary(r: ResourceMeta): string {
  const parts: string[] = [r.kind];
  if (r.contentLength) parts.push(r.contentLength >= 1000 ? `${(r.contentLength / 1000).toFixed(1)}k chars` : `${r.contentLength} chars`);
  if (r.path) parts.push('file');
  if (r.url) parts.push('link');
  return parts.join(' · ');
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/web/format.test.ts`
Expected: PASS (1 test).

- [ ] **Step 5: Create the panels**

`web/src/panels/Markdown.tsx`:
```tsx
import { useMemo } from 'react';
import DOMPurify from 'dompurify';
import { marked } from 'marked';

DOMPurify.addHook('afterSanitizeAttributes', (node) => {
  if (node.tagName === 'A') {
    node.setAttribute('target', '_blank');
    node.setAttribute('rel', 'noopener noreferrer');
  }
});

export function Markdown({ text }: { text: string }) {
  const html = useMemo(() => DOMPurify.sanitize(marked.parse(text, { async: false }) as string), [text]);
  return <div className="ip-md" dangerouslySetInnerHTML={{ __html: html }} />;
}
```

`web/src/panels/Details.tsx`:
```tsx
import { useEffect, useState } from 'react';
import { isNeedsYou } from '../../../src/core/tree';
import type { NodeDetail, ProjectSnapshot } from '../../../src/core/types';
import { api } from '../api';
import { relativeTime } from '../time';
import { resourceSummary } from './format';
import { Markdown } from './Markdown';

interface DetailsProps {
  nodeId: number;
  snapshot: ProjectSnapshot;
  onClose: () => void;
  onSelectNode: (id: number) => void;
  onOpenResource: (id: number) => void;
}

export function Details({ nodeId, snapshot, onClose, onSelectNode, onOpenResource }: DetailsProps) {
  const [detail, setDetail] = useState<NodeDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  // Refetch whenever the snapshot changes, so the panel follows Claude's edits.
  useEffect(() => {
    let alive = true;
    api
      .node(nodeId)
      .then((d) => {
        if (!alive) return;
        setDetail(d);
        setError(null);
      })
      .catch((e: Error) => alive && setError(e.message));
    return () => {
      alive = false;
    };
  }, [nodeId, snapshot]);

  if (error) {
    return (
      <aside className="ip-details" aria-label="Node details">
        <header>
          <b>#{nodeId}</b>
          <button className="ip-btn" onClick={onClose} aria-label="Close">×</button>
        </header>
        <p className="muted">{error}</p>
      </aside>
    );
  }
  if (!detail) {
    return (
      <aside className="ip-details" aria-label="Node details">
        <p className="muted">Loading…</p>
      </aside>
    );
  }

  const { node } = detail;
  const copy = async () => {
    await navigator.clipboard.writeText(`#${node.id} ${node.title}`);
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1200);
  };

  return (
    <aside className="ip-details" aria-label="Node details">
      <div className="ip-grab" />
      <header>
        <b>#{node.id} {node.title}</b>
        <button className="ip-btn" onClick={() => void copy()}>{copied ? 'Copied' : `Copy #${node.id}`}</button>
        <button className="ip-btn" onClick={onClose} aria-label="Close">×</button>
      </header>
      <div className="ip-meta">
        {isNeedsYou(node) ? <span className="ip-pill you">NEEDS YOU</span> : <span className={`ip-pill st-${node.status}`}>{node.status}</span>}
        <span>{node.kind}</span>
        <span>· {node.assignee === 'me' ? 'you' : 'Claude'}</span>
        {detail.parent && (
          <span>
            · in{' '}
            <button className="ip-link" onClick={() => onSelectNode(detail.parent!.id)}>
              #{detail.parent.id} {detail.parent.title}
            </button>
          </span>
        )}
      </div>
      {node.body && <Markdown text={node.body} />}
      {node.outcome && (
        <p className="ip-outcome">
          <b>Outcome:</b> {node.outcome}
        </p>
      )}
      {detail.resources.length > 0 && (
        <>
          <div className="ip-label">Resources</div>
          {detail.resources.map((r) => (
            <button key={r.id} className="ip-res" onClick={() => onOpenResource(r.id)}>
              ▤ <b>{r.title}</b>
              <span className="sub">{resourceSummary(r)}</span>
            </button>
          ))}
        </>
      )}
      {detail.children.length > 0 && (
        <>
          <div className="ip-label">Steps</div>
          <ul className="ip-kids">
            {detail.children.map((c) => (
              <li key={c.id}>
                <button onClick={() => onSelectNode(c.id)}>
                  <span className={`ip-marker m-${c.status}`} />#{c.id} {c.title}
                  {c.assignee === 'me' && c.status !== 'done' ? <span className="ip-you">YOU</span> : null}
                </button>
              </li>
            ))}
          </ul>
        </>
      )}
      {detail.log.length > 0 && (
        <>
          <div className="ip-label">Log</div>
          <ul className="ip-log">
            {detail.log.map((l) => (
              <li key={l.id}>
                {relativeTime(l.createdAt)} · {l.text}
                {l.sessionTitle ? <i> · {l.sessionTitle}</i> : null}
              </li>
            ))}
          </ul>
        </>
      )}
      <p className="muted" style={{ marginTop: 12 }}>
        Updated {relativeTime(node.updatedAt)} · {snapshot.project.name}
      </p>
    </aside>
  );
}
```

`web/src/panels/ResourceViewer.tsx`:
```tsx
import { useEffect, useState } from 'react';
import type { Resource } from '../../../src/core/types';
import { api } from '../api';
import { Markdown } from './Markdown';

export function ResourceViewer({ resourceId, onClose }: { resourceId: number; onClose: () => void }) {
  const [resource, setResource] = useState<Resource | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [toast, setToast] = useState<string | null>(null);

  useEffect(() => {
    api.resource(resourceId).then(setResource).catch((e: Error) => setError(e.message));
  }, [resourceId]);

  const flash = (message: string) => {
    setToast(message);
    window.setTimeout(() => setToast(null), 1500);
  };
  const copy = async (text: string, label: string) => {
    await navigator.clipboard.writeText(text);
    flash(label);
  };
  const open = async (id: number) => {
    const result = await api.openResource(id);
    if (result === 'reload') window.location.reload();
    else flash(result === 'opened' ? 'Opened' : result);
  };

  return (
    <div className="ip-viewer" role="dialog" aria-label="Resource">
      <header>
        <b>{resource ? `r${resource.id} ${resource.title}` : 'Resource'}</b>
        {resource?.content && <button className="ip-btn" onClick={() => void copy(resource.content!, 'Copied')}>Copy</button>}
        {resource?.path && <button className="ip-btn" onClick={() => void open(resource.id)}>Open file</button>}
        {resource?.path && <button className="ip-btn" onClick={() => void copy(resource.path!, 'Path copied')}>Copy path</button>}
        {resource?.url && <button className="ip-btn" onClick={() => window.open(resource.url!, '_blank', 'noopener')}>Open link</button>}
        <button className="ip-btn" onClick={onClose} aria-label="Close">×</button>
      </header>
      <div className="ip-viewer-body">
        {error ? (
          <p className="muted">{error}</p>
        ) : !resource ? (
          <p className="muted">Loading…</p>
        ) : resource.content ? (
          <Markdown text={resource.content} />
        ) : (
          <p className="muted">{resource.path ? `File: ${resource.path}` : resource.url}</p>
        )}
      </div>
      {toast && <div className="ip-toast">{toast}</div>}
    </div>
  );
}
```

- [ ] **Step 6: Replace `web/src/App.tsx` to wire the panels**

```tsx
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { isNeedsYou } from '../../src/core/tree';
import { Canvas, type CanvasHandle } from './canvas/Canvas';
import { ActivityStrip } from './chrome/ActivityStrip';
import { SessionRow } from './chrome/SessionRow';
import { TopBar } from './chrome/TopBar';
import { Details } from './panels/Details';
import { ResourceViewer } from './panels/ResourceViewer';
import { useFoldOverrides } from './useFoldOverrides';
import { useInProgress } from './useInProgress';
import { useKeyboard } from './useKeyboard';

export function App() {
  const state = useInProgress();
  const { snapshot, projects } = state;
  const [follow, setFollow] = useState(true);
  const [selectedNode, setSelectedNode] = useState<number | null>(null);
  const [viewerResource, setViewerResource] = useState<number | null>(null);
  const [overrides, setOverride] = useFoldOverrides(snapshot?.project.id);
  const canvas = useRef<CanvasHandle>(null);
  const needsYou = useMemo(() => (snapshot ? snapshot.nodes.filter(isNeedsYou).length : 0), [snapshot]);

  useEffect(() => {
    document.title = `${needsYou ? `(${needsYou}) ` : ''}InProgress${snapshot ? ` · ${snapshot.project.name}` : ''}`;
  }, [needsYou, snapshot]);
  useEffect(() => {
    setSelectedNode(null);
    setViewerResource(null);
  }, [snapshot?.project.id]);

  const followOn = useCallback(() => {
    setFollow(true);
    canvas.current?.goFrontier();
  }, []);

  useKeyboard({
    onFollow: () => (follow ? setFollow(false) : followOn()),
    onNext: () => canvas.current?.nextNeedsYou(),
    onHome: () => canvas.current?.goRoot(),
    onEnd: () => canvas.current?.goFrontier(),
    onEscape: () => (viewerResource !== null ? setViewerResource(null) : setSelectedNode(null)),
  });

  if (!state.loaded) return <div className="ip-empty">Loading…</div>;
  return (
    <div className="ip-app">
      <TopBar
        projects={projects}
        current={snapshot?.project ?? null}
        onSelect={state.selectProject}
        needsYou={needsYou}
        onNeedsYou={() => canvas.current?.nextNeedsYou()}
        follow={follow}
        onFollow={followOn}
      />
      {snapshot && <SessionRow sessions={snapshot.sessions} onPick={(s) => s.focusNodeId !== null && canvas.current?.focusNode(s.focusNodeId)} />}
      {state.connection === 'reconnecting' && <div className="ip-banner">Reconnecting to InProgress…</div>}
      <main className="ip-main">
        {projects.length === 0 ? (
          <div className="ip-empty">No projects yet. In a Claude session, say "track this in InProgress".</div>
        ) : snapshot ? (
          <Canvas
            key={snapshot.project.id}
            ref={canvas}
            snapshot={snapshot}
            lastEvent={state.liveEvent}
            follow={follow}
            onFollowChange={setFollow}
            overrides={overrides}
            onToggleFold={setOverride}
            selectedNode={selectedNode}
            onSelectNode={setSelectedNode}
            onOpenResource={setViewerResource}
          />
        ) : (
          <div className="ip-empty">Loading project…</div>
        )}
        {snapshot && selectedNode !== null && (
          <Details
            nodeId={selectedNode}
            snapshot={snapshot}
            onClose={() => setSelectedNode(null)}
            onSelectNode={(id) => {
              setSelectedNode(id);
              canvas.current?.focusNode(id);
            }}
            onOpenResource={setViewerResource}
          />
        )}
      </main>
      {snapshot && <ActivityStrip event={state.lastEvent} snapshot={snapshot} />}
      {viewerResource !== null && <ResourceViewer resourceId={viewerResource} onClose={() => setViewerResource(null)} />}
    </div>
  );
}
```

- [ ] **Step 7: Append the panel styles to `web/src/styles.css`**

```css
.ip-details { position: absolute; right: 0; top: 0; bottom: 0; width: 380px; background: var(--panel); border-left: 1px solid var(--border); box-shadow: var(--shadow); padding: 12px 14px; overflow-y: auto; z-index: 10; font-size: 12px; }
.ip-grab { display: none; width: 36px; height: 4px; border-radius: 2px; background: var(--border); margin: 0 auto 8px; }
@media (max-width: 719px) {
  .ip-details { top: auto; left: 0; width: auto; height: 60%; border-left: 0; border-top: 1px solid var(--border); border-radius: 14px 14px 0 0; }
  .ip-grab { display: block; }
}
.ip-details header, .ip-viewer header { display: flex; align-items: center; gap: 6px; font-size: 13px; }
.ip-details header b, .ip-viewer header b { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.ip-btn { border: 1px solid var(--border); border-radius: 6px; padding: 0 7px; font-size: 11px; color: var(--muted); white-space: nowrap; }
.ip-meta { display: flex; flex-wrap: wrap; gap: 6px; align-items: center; color: var(--muted); font-size: 11px; margin: 6px 0 10px; }
.ip-pill { border-radius: 8px; padding: 0 6px; font-weight: 700; font-size: 10px; color: #fff; background: var(--faint); }
.ip-pill.you { background: var(--amber); }
.ip-pill.st-done { background: var(--green); }
.ip-pill.st-active { background: var(--accent); }
.ip-pill.st-blocked { background: var(--red); }
.ip-link { color: var(--accent); text-decoration: underline; }
.ip-label { font-size: 10px; text-transform: uppercase; letter-spacing: 0.05em; color: var(--faint); margin: 12px 0 4px; }
.ip-res { display: flex; align-items: center; gap: 6px; width: 100%; text-align: left; border: 1px solid var(--purple); background: color-mix(in srgb, var(--purple) 8%, transparent); color: var(--purple); border-radius: 6px; padding: 4px 8px; margin-bottom: 4px; }
.ip-res .sub { color: var(--muted); font-size: 10px; margin-left: auto; }
.ip-kids { list-style: none; margin: 0; padding: 0; }
.ip-kids li button { width: 100%; text-align: left; padding: 2px 0; display: flex; gap: 6px; align-items: center; }
.ip-log { list-style: none; margin: 0; padding: 0; color: var(--muted); font-size: 11px; line-height: 1.7; }
.ip-outcome { margin: 8px 0; }
.ip-md { font-size: 12.5px; line-height: 1.55; overflow-wrap: anywhere; }
.ip-md pre { background: var(--panel-2); padding: 8px; border-radius: 6px; overflow: auto; }
.ip-md code { font-family: ui-monospace, 'Cascadia Code', Consolas, monospace; font-size: 12px; }
.ip-md table { border-collapse: collapse; }
.ip-md td, .ip-md th { border: 1px solid var(--border); padding: 2px 6px; }
.ip-viewer { position: fixed; inset: 0; background: var(--bg); z-index: 30; display: flex; flex-direction: column; }
.ip-viewer header { padding: 8px 12px; background: var(--panel); border-bottom: 1px solid var(--border); }
.ip-viewer-body { flex: 1; overflow: auto; padding: 16px 20px; max-width: 900px; width: 100%; margin: 0 auto; }
.ip-toast { position: fixed; bottom: 16px; left: 50%; transform: translateX(-50%); background: var(--text); color: var(--bg); padding: 4px 12px; border-radius: 8px; font-size: 12px; z-index: 40; }
```

- [ ] **Step 8: Type-check and build**

Run: `npx tsc -p web/tsconfig.json && npm run build:web`
Expected: no errors.

- [ ] **Step 9: Commit**

```bash
git add web test/web
git commit -m "Add the node details panel and resource viewer

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 20: End-to-end UI tests (Playwright on the system Edge)

**Files:**
- Create: `playwright.config.ts`, `test/e2e/start-server.mjs`, `test/e2e/ui.spec.ts`

**Interfaces:**
- Consumes: the built server (`dist/server/main.js`) and UI (`web/dist`); the HTTP API; the DOM contract from Task 18 (`.ip-node`, `.st-*`, `.needs-you`, `.flash`, `.ip-more`, `.ip-badge`, `.ip-chip`), `aside` details panel, `role="dialog"` viewer.
- Produces: `npm run test:e2e` (builds, starts a throwaway server on port 4399 with data in `.e2e-home`, runs the browser tests).

- [ ] **Step 1: Create the config and the server launcher**

`playwright.config.ts`:
```ts
import { defineConfig } from '@playwright/test';

const PORT = 4399;

export default defineConfig({
  testDir: 'test/e2e',
  timeout: 30_000,
  workers: 1,
  fullyParallel: false,
  use: {
    baseURL: `http://127.0.0.1:${PORT}`,
    channel: 'msedge',
    viewport: { width: 520, height: 900 },
    permissions: ['clipboard-read', 'clipboard-write'],
  },
  webServer: {
    command: 'node test/e2e/start-server.mjs',
    url: `http://127.0.0.1:${PORT}/api/health`,
    reuseExistingServer: false,
    timeout: 20_000,
  },
});
```

`test/e2e/start-server.mjs`:
```js
// Starts the built server with a fresh data dir so every e2e run begins empty.
import { rmSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const home = fileURLToPath(new URL('../../.e2e-home', import.meta.url));
rmSync(home, { recursive: true, force: true });
process.env.INPROGRESS_HOME = home;
process.env.INPROGRESS_PORT = '4399';
await import('../../dist/server/main.js');
```

- [ ] **Step 2: Write the tests**

`test/e2e/ui.spec.ts`:
```ts
import { readFileSync } from 'node:fs';
import { expect, test, type APIRequestContext } from '@playwright/test';

const headers = () => ({ authorization: `Bearer ${readFileSync('.e2e-home/token', 'utf8').trim()}`, 'x-inprogress-actor': 'scribe:e2e-session' });
const ids: Record<string, number> = {};
let api: APIRequestContext;

test.beforeAll(async ({ playwright }) => {
  api = await playwright.request.newContext({ baseURL: 'http://127.0.0.1:4399' });
  const project = await (await api.post('/api/projects', { headers: headers(), data: { name: 'E2E Demo', description: 'Seeded by Playwright' } })).json();
  const milestones = Array.from({ length: 25 }, (_, i) => ({ title: `Milestone ${i + 1}`, status: 'done' as const }));
  const created = await (
    await api.post('/api/nodes', {
      headers: headers(),
      data: {
        parentId: project.rootNodeId,
        nodes: [
          { title: 'Milestones', kind: 'phase', status: 'active', children: milestones },
          {
            title: 'Road to market', kind: 'phase', status: 'active',
            children: [
              { title: '1 iOS certificate', status: 'done' },
              { title: '2 Android signing', status: 'active', children: [
                { title: 'Upload keystore', status: 'done' },
                { title: 'Play app signing', status: 'active' },
                { title: 'Run signing tests', assignee: 'me' },
              ] },
              { title: '3 RevenueCat' }, { title: '4 Build to GitHub' }, { title: '5 Store listing' }, { title: '6 Beta' }, { title: '7 Launch' },
            ],
          },
        ],
      },
    })
  ).json();
  for (const n of created as { id: number; title: string }[]) ids[n.title] = n.id;
  await api.post('/api/resources', { headers: headers(), data: { nodeId: ids['Run signing tests'], kind: 'test-suite', title: 'Signing test suite', content: '# Signing tests\n\n- [ ] Upload key accepted' } });
  await api.post('/api/sessions/e2e-session/enroll', { headers: headers(), data: { project: project.slug, title: 'E2E session' } });
  await api.post('/api/sessions/e2e-session/focus', { headers: headers(), data: { nodeId: ids['Play app signing'] } });
  await api.post('/api/sessions/e2e-session/hook', { headers: headers(), data: { event: 'prompt' } });
});

test.afterAll(async () => {
  await api.dispose();
});

test('opens on the current work with folding, needs-you and the session badge', async ({ page }) => {
  await page.goto('/');
  await expect(page.locator('.ip-node', { hasText: 'Play app signing' })).toBeInViewport();
  await expect(page.locator('.ip-node.needs-you', { hasText: 'Run signing tests' })).toBeVisible();
  await expect(page.locator('.ip-more', { hasText: '+3 more' })).toBeVisible();
  await expect(page.locator('.ip-badge', { hasText: 'E2E session' })).toBeVisible();
  await expect(page).toHaveTitle('(1) InProgress · E2E Demo');
});

test('shows live changes and follows them', async ({ page }) => {
  await page.goto('/');
  await expect(page.locator('.ip-node', { hasText: 'Play app signing' })).toBeVisible();
  await api.patch(`/api/nodes/${ids['Play app signing']}`, { headers: headers(), data: { status: 'done', outcome: 'Configured' } });
  await expect(page.locator('.ip-node.st-done', { hasText: 'Play app signing' })).toBeVisible({ timeout: 5000 });
  // Let the follow move for that status change finish before moving the camera ourselves.
  await page.waitForTimeout(1600);
  await page.keyboard.press('Home');
  await expect(page.locator('.ip-node.root')).toBeInViewport();
  await api.post('/api/nodes', { headers: headers(), data: { parentId: ids['Road to market'], nodes: [{ title: 'Launch checklist', status: 'active' }] } });
  await expect(page.locator('.ip-node', { hasText: 'Launch checklist' })).toBeInViewport({ timeout: 6000 });
  await expect(page.locator('.ip-activity')).toContainText('Launch checklist');
});

test('the needs-you pill jumps to and highlights the item', async ({ page }) => {
  await page.goto('/');
  await page.keyboard.press('Home');
  await page.getByRole('button', { name: /need you/ }).click();
  await expect(page.locator('.ip-node.flash', { hasText: 'Run signing tests' })).toBeInViewport();
});

test('clicking a node opens its details and copies a reference', async ({ page }) => {
  await page.goto('/');
  const id = ids['Run signing tests'];
  await page.locator('.ip-node', { hasText: 'Run signing tests' }).click();
  const details = page.getByRole('complementary');
  await expect(details).toContainText(`#${id} Run signing tests`);
  await details.getByRole('button', { name: `Copy #${id}` }).click();
  // String form: the root tsconfig has no DOM lib, so `navigator` must not appear in test code.
  expect(await page.evaluate<string>('navigator.clipboard.readText()')).toBe(`#${id} Run signing tests`);
});

test('a resource chip opens the rendered resource', async ({ page }) => {
  await page.goto('/');
  await page.locator('.ip-chip', { hasText: 'Signing test suite' }).click();
  const viewer = page.getByRole('dialog');
  await expect(viewer.locator('h1')).toHaveText('Signing tests');
  await page.keyboard.press('Escape');
  await expect(viewer).toBeHidden();
});
```

- [ ] **Step 3: Run the e2e suite**

Run: `npm run test:e2e`
Expected: the build succeeds and 5 tests PASS in Edge. If a camera assertion flakes, check that `onlyRenderVisibleElements` is not hiding the target: assertions target nodes that the camera has already moved to, so they should be rendered. Debug with `npx playwright test --headed`.

- [ ] **Step 4: Commit**

```bash
git add playwright.config.ts test/e2e
git commit -m "Add end-to-end UI tests on Edge

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 21: Install for real, live check, hand over for InGame

This task changes Aiden's real `~/.claude` and is run by the controlling session, not a subagent.

**Files:**
- Modify (outside the repo, via the installer): `~/.claude/settings.json`, `~/.claude/agents/inprogress-scribe.md`, `~/.claude/skills/inprogress/SKILL.md`
- Create: `.live-check/` scratch folder (git-ignored)

- [ ] **Step 1: Full verification**

Run: `npm run typecheck && npm test && npm run test:smoke && npm run test:e2e`
Expected: everything green. Do not continue past a red step.

- [ ] **Step 2: Checkpoint with Aiden**

Show the install footprint (hooks in `settings.json`, the two allow rules, the agent file, the skill folder, a settings backup) and wait for an explicit yes before touching the real `~/.claude`.

- [ ] **Step 3: Install and check**

Run: `npm run claude:install`, then `node dist/cli/main.js start`, then `node dist/cli/main.js doctor`
Expected: every line `✓` (Edge may be `!`). If the installer says the agents folder is new, tell Aiden that open Claude sessions must be restarted to see the scribe.

- [ ] **Step 4: Open the window**

Run: `node dist/cli/main.js open` (Edge app window). Also offer the Claude Code tab's browser pane at `http://127.0.0.1:4317`.

- [ ] **Step 5: Automated live check (if the `claude` CLI is on PATH)**

```bash
mkdir -p .live-check
TOKEN=$(cat ~/.inprogress/token)
curl -s -X POST http://127.0.0.1:4317/api/projects -H "authorization: Bearer $TOKEN" -H 'content-type: application/json' -d '{"name":"Live check","description":"Scratch project for the InProgress live check"}'
curl -s -X POST http://127.0.0.1:4317/api/projects/live-check/bindings -H "authorization: Bearer $TOKEN" -H 'content-type: application/json' -d "{\"path\":\"$(pwd -W)/.live-check\"}"
cd .live-check && claude -p "Plan three steps to write haiku.txt with a haiku about trees, do step 1 only, and keep InProgress current as its briefing describes." ; cd ..
sleep 45
node dist/cli/main.js outline live-check
```
Expected: the outline shows three steps under the root with step 1 done and a session badge line for the print-mode session. If print mode exits before the background scribe finishes (nothing but the root appears), note it and use Step 6 as the live check instead.

- [ ] **Step 5b: Check the server outlives the hook that started it**

Stop the server (`node dist/cli/main.js stop`), start a fresh Claude session in any bound folder (the live-check folder, or ask Aiden to), let its SessionStart hook start the server, end that session, then run `node dist/cli/main.js status`.
Expected: still running. If it is not, Claude Code is killing the hook's process tree with the server in it. Then start the server from outside Claude instead: run `node dist/cli/main.js start` from a normal terminal, add a Startup-folder shortcut to `node "<repo>/dist/cli/main.js" start` (ask Aiden before creating it), and tell Aiden why.

- [ ] **Step 6: Hand over the first real use**

Tell Aiden, in the terminal:
1. Open a new Claude session in `C:\personal\InGame` (new, so the scribe and skill load).
2. Say: "Adopt InGame into InProgress: purpose, finished milestones M1–M6 as done phases, the road-to-market plan with real statuses, and attach docs/planning/road-to-market.md. Bind this folder."
3. Watch the window: the tree should appear within about 30 seconds, and the session chip should turn clay while Claude works.
4. Correct anything stale by telling that session.

- [ ] **Step 7: Record the project in memory**

Write a `project` memory for InProgress: repo path, how to start/open/doctor, where data lives, the spec and plan paths, and that the first real use is InGame's adoption. Add its line to `MEMORY.md`.

- [ ] **Step 8: Commit**

```bash
git status --short
git commit --allow-empty -m "InProgress v1 installed and live-checked

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

