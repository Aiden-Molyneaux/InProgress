// The scenes harness for lead stage 1 (#743): scenes 1 to 6 of the plan, shown on a check surface with a copy of Aiden's data, and
// recorded. It never touches the live server or the live home beyond one read-only backup() of inprogress.db (the check surface's
// step 2), never the real t3 CLI (a recording stand-in keeps a world of threads), never the real webhook (a receiver of its own on
// 4425 records every POST), and with no --claude never a real claude (claude-scenes.mjs answers from standin.json).
// usage: node scripts/lead-scenes/run.mjs <build dir> <work dir> [--claude <program>] [--scenes 1,2,...]
// <build dir> holds `node scripts/build-to.mjs <build dir>`. Own ports: the server 4424, the voice receiver 4425.
// Times the plan sets in the night or 30 minutes apart are reached by backdating the copy's stamps, never by waiting; each scene's
// file says which stamps were moved. The server's minute watch runs every 10 s here (INPROGRESS_AGENT_WATCH_MS) instead of every 60 s.
import Database from 'better-sqlite3';
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { refuseLiveHome } from '../lead-exam/guard.mjs';

const here = fileURLToPath(new URL('.', import.meta.url));
const repoRoot = resolve(here, '..', '..');
const PORT = 4424;
const VOICE_PORT = 4425;
const LEAD = 'Progresser';
const SLUG = 'inprogress';
const isWin = process.platform === 'win32';

// ---- arguments ----
const argv = process.argv.slice(2);
const flag = (name) => {
  const i = argv.indexOf(name);
  return i < 0 ? undefined : argv[i + 1];
};
const positional = argv.filter((a, i) => !a.startsWith('--') && !(i > 0 && ['--claude', '--scenes'].includes(argv[i - 1])));
if (positional.length !== 2) throw new Error('usage: run.mjs <build dir> <work dir> [--claude <program>] [--scenes 1,2,...]');
const build = resolve(positional[0]).replace(/\\/g, '/');
const realClaude = flag('--claude');
const wanted = (flag('--scenes') ?? '1,2,3,4,5,6').split(',').map((s) => Number(s.trim()));
const INSTRUCTIONS = Number(/LEAD_INSTRUCTIONS_VERSION = (\d+)/.exec(readFileSync(join(repoRoot, 'src/core/lead.ts'), 'utf8'))?.[1]);
if (!Number.isInteger(INSTRUCTIONS)) throw new Error("could not read LEAD_INSTRUCTIONS_VERSION from src/core/lead.ts");

// Before anything is made: the work dir may not lie under the live home, by real path (checked again once it exists).
const liveHome = join(homedir(), '.inprogress');
refuseLiveHome([positional[1]], liveHome);
mkdirSync(positional[1], { recursive: true });
const work = realpathSync.native(resolve(positional[1])).replace(/\\/g, '/');
refuseLiveHome([work], liveHome);
const home = `${work}/home`;
const dbFile = `${home}/inprogress.db`;
const base = `http://127.0.0.1:${PORT}`;
if (resolve(home).toLowerCase() === resolve(liveHome).toLowerCase()) throw new Error('the scenes home is the live home');

// ---- small helpers ----
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const pad = (n) => String(n).padStart(2, '0');
const clock = (d = new Date()) => `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
const hhmm = (iso) => clock(new Date(iso)).slice(0, 5);
const hm = (ms) => `${pad(new Date(ms).getHours())}:${pad(new Date(ms).getMinutes())}`;
const clip = (s, n = 400) => {
  const t = String(s ?? '').replace(/\s+/g, ' ').trim();
  return t.length > n ? `${t.slice(0, n - 1)}...` : t;
};
const iso = (ms = Date.now()) => new Date(ms).toISOString();
const MIN = 60_000;

async function waitFor(label, fn, timeoutMs, stepMs = 1000) {
  const end = Date.now() + timeoutMs;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > end) return undefined;
    await sleep(stepMs);
  }
}

// ---- the copy of Aiden's data: the only read of the live home, read-only, backup() writing the copy WAL included ----
async function copyLiveData() {
  rmSync(home, { recursive: true, force: true });
  mkdirSync(`${home}/lead`, { recursive: true });
  const live = join(liveHome, 'inprogress.db');
  if (!existsSync(live)) throw new Error(`No live database at ${live}`);
  const src = new Database(live, { readonly: true, fileMustExist: true });
  try {
    await src.backup(dbFile);
  } finally {
    src.close();
  }
}

const readDb = (sql, ...params) => {
  const db = new Database(dbFile, { readonly: true, fileMustExist: true });
  try {
    return db.prepare(sql).all(...params);
  } finally {
    db.close();
  }
};
const writeDb = (fn) => {
  const db = new Database(dbFile, { fileMustExist: true });
  db.pragma('busy_timeout = 8000');
  try {
    return fn(db);
  } finally {
    db.close();
  }
};
/** Moves a timestamp column of the selected rows back by `ms`. */
function backdate(table, col, where, params, ms) {
  return writeDb((db) => {
    const rows = db.prepare(`SELECT id, ${col} AS v FROM ${table} WHERE ${where}`).all(...params);
    for (const r of rows) if (r.v) db.prepare(`UPDATE ${table} SET ${col} = ? WHERE id = ?`).run(iso(Date.parse(r.v) - ms), r.id);
    return rows.length;
  });
}

// ---- the voice receiver (4425): records every POST, answers 200 or 503 ----
const voice = { posts: [], status: 200 };
const receiver = createServer((req, res) => {
  let body = '';
  req.on('data', (d) => (body += d));
  req.on('end', () => {
    const { authorization, ...headers } = req.headers;
    let parsed = body;
    try {
      parsed = JSON.parse(body);
    } catch {
      // Not JSON: the raw body is recorded.
    }
    const entry = { at: iso(), status: voice.status, method: req.method, url: req.url, hasKey: authorization !== undefined, headers, body: parsed };
    voice.posts.push(entry);
    writeFileSync(`${work}/voice.jsonl`, `${voice.posts.map((p) => JSON.stringify(p)).join('\n')}\n`);
    res.writeHead(voice.status, { 'content-type': 'application/json' });
    res.end(voice.status === 200 ? '{"ok":true}' : '{"error":"Grok is closed"}');
  });
});

// ---- the T3 recorder's world and calls ----
const worldFile = `${work}/t3.json`;
const callsFile = `${work}/t3-calls.jsonl`;
const readWorld = () => (existsSync(worldFile) ? JSON.parse(readFileSync(worldFile, 'utf8')) : { threads: [], next: 1 });
const calls = () => (existsSync(callsFile) ? readFileSync(callsFile, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []);
const threadMessages = (id) => readWorld().threads.find((t) => t.threadId === id)?.messages ?? [];
function addThread(threadId, title, firstAssistant) {
  const w = readWorld();
  const at = iso();
  w.threads.push({ threadId, projectId: 'scenes', title, createdAt: at, messages: firstAssistant ? [{ role: 'assistant', text: firstAssistant, createdAt: at }] : [] });
  writeFileSync(worldFile, `${JSON.stringify(w, null, 2)}\n`);
}
const sentTo = (id, from = 0) => calls().slice(from).filter((c) => c.args[1] === 'send' && c.args[2] === id).map((c) => c.stdin);

// ---- the server ----
let server;
let serverLog = '';
const serverEnv = () => {
  const env = { ...process.env };
  for (const k of Object.keys(env)) if (k.startsWith('INPROGRESS_') || k === 'T3CODE_THREAD_ID') delete env[k];
  return {
    ...env,
    INPROGRESS_HOME: home,
    INPROGRESS_PORT: String(PORT),
    INPROGRESS_HOOK_CAPTURE: '0',
    INPROGRESS_AGENT_WATCH_MS: '10000',
    INPROGRESS_LEAD_CLAUDE: join(here, 'claude-scenes.mjs'),
    T3CODE_CLI_PATH: join(here, isWin ? 't3-recorder.cmd' : 't3-recorder.sh'),
    SCENES_WORK: work,
    ...(realClaude === undefined ? {} : { SCENES_REAL_CLAUDE: realClaude }),
  };
};

async function startServer() {
  const env = serverEnv();
  if (!env.INPROGRESS_HOME || resolve(env.INPROGRESS_HOME).toLowerCase() === resolve(liveHome).toLowerCase()) throw new Error(`INPROGRESS_HOME is ${env.INPROGRESS_HOME}: not the scenes' home`);
  try {
    const other = await fetch(`${base}/api/health`);
    if (other.ok) throw new Error(`something already answers on ${PORT}: take another port`);
  } catch (err) {
    if (err.message.startsWith('something already')) throw err;
  }
  server = spawn(process.execPath, [`${build}/dist/server/main.js`], { env, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
  server.stdout.on('data', (d) => (serverLog += d));
  server.stderr.on('data', (d) => (serverLog += d));
  for (let i = 0; i < 150; i++) {
    try {
      const health = await (await fetch(`${base}/api/health`)).json();
      if (health.app === 'inprogress') return health;
    } catch {
      // Not listening yet: asked again.
    }
    if (server.exitCode !== null) break;
    await sleep(200);
  }
  throw new Error(`the build's server did not answer /api/health on ${PORT}:\n${serverLog.slice(-1500)}`);
}

async function stopServer() {
  if (server === undefined || server.exitCode !== null) return;
  const exited = new Promise((r) => server.once('exit', r));
  try {
    const token = readFileSync(`${home}/token`, 'utf8').trim();
    await fetch(`${base}/api/admin/shutdown`, { method: 'POST', headers: { authorization: `Bearer ${token}` } });
  } catch {
    // The server may already be going down, or its token unreadable: the kill below covers it.
  }
  await Promise.race([exited, sleep(8000)]);
  if (server.exitCode === null) {
    server.kill();
    await Promise.race([exited, sleep(3000)]);
  }
}

let token = '';
async function api(method, path, body, headers = {}) {
  const res = await fetch(`${base}${path}`, { method, headers: { 'content-type': 'application/json', authorization: `Bearer ${token}`, ...headers }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  const text = await res.text();
  if (!res.ok) throw new Error(`${method} ${path} answered ${res.status}: ${text}`);
  return text === '' ? undefined : JSON.parse(text);
}

/** The built CLI, as a session or the lead runs it: the scenes' home and port, never the defaults. */
function cli(args, cwd = work) {
  const env = serverEnv();
  const r = spawnSync(process.execPath, [`${build}/dist/cli/main.js`, ...args], { cwd, env, encoding: 'utf8', timeout: 120_000, windowsHide: true });
  return { code: r.status, text: `${r.stdout ?? ''}${r.stderr ?? ''}`.trim() };
}
const WHO = ['--as', LEAD, '--instructions', String(INSTRUCTIONS)];
const lead = (command, ...rest) => cli(['lead', command, ...rest, ...WHO]);
const leadRead = (command, ...rest) => cli(['lead', command, ...rest]);

/** The hold hook as the installer wires it, called as Claude Code calls it: the PreToolUse JSON on stdin. */
function holdHook(sessionId, cwd, command, family) {
  const input = { session_id: sessionId, transcript_path: '', cwd, permission_mode: 'bypassPermissions', hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command }, tool_use_id: 'toolu_scenes' };
  const r = spawnSync(process.execPath, [`${build}/dist/hooks/hook.js`, 'hold', `Bash(${family})`], { cwd, env: serverEnv(), input: JSON.stringify(input), encoding: 'utf8', timeout: 40_000, windowsHide: true });
  return { code: r.status, stdout: (r.stdout ?? '').trim(), stderr: (r.stderr ?? '').trim() };
}

// ---- the scratch repo, the project, the steps, the sessions ----
const scratch = `${work}/scratch`;
const repo = `${scratch}/repo`;
const NO_HOOKS = `${scratch}/no-hooks`;
const GIT_ENV = { ...process.env, GIT_AUTHOR_NAME: 'Scenes', GIT_AUTHOR_EMAIL: 'scenes@example.invalid', GIT_COMMITTER_NAME: 'Scenes', GIT_COMMITTER_EMAIL: 'scenes@example.invalid', GIT_TERMINAL_PROMPT: '0' };
const git = (cwd, ...args) => {
  const r = spawnSync('git', ['-c', `core.hooksPath=${NO_HOOKS}`, ...args], { cwd, env: GIT_ENV, encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`git ${args.join(' ')} failed (${r.status}): ${r.stderr || r.stdout}`);
  return r.stdout.trim();
};
function makeRepo(branches) {
  rmSync(scratch, { recursive: true, force: true });
  mkdirSync(NO_HOOKS, { recursive: true });
  mkdirSync(repo, { recursive: true });
  git(repo, 'init', '-b', 'main');
  writeFileSync(`${repo}/package.json`, `${JSON.stringify({ name: 'x', version: '1.2.0' }, null, 2)}\n`);
  writeFileSync(`${repo}/README.md`, 'scenes scratch repo\n');
  git(repo, 'add', '-A');
  git(repo, 'commit', '-m', 'first');
  for (const b of branches) {
    git(repo, 'checkout', '-b', b);
    // The button step's change touches a file on the landing check's risk list (claude/**, a default glob), so the check holds it until his yes.
    const file = b === 'step-button-name' ? `${repo}/claude/board-search-button.md` : `${repo}/${b}.txt`;
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, `${b}\n`);
    git(repo, 'add', '-A');
    git(repo, 'commit', '-m', b);
    git(repo, 'checkout', 'main');
  }
  // The stopped session's worktree: a folder on its branch with a commit of work in progress, so a restart has something to start from.
  git(repo, 'worktree', 'add', stoppedTree, 'step-stopped');
  writeFileSync(`${stoppedTree}/export-wip.txt`, 'half of the export, not finished\n');
  git(stoppedTree, 'add', '-A');
  git(stoppedTree, 'commit', '-m', 'wip: half of the export');
}
const stoppedTree = `${scratch}/wt-stopped`;

const project = { id: 0, rootId: 0 };
const steps = {};
async function makeStep(key, title) {
  await api('POST', '/api/nodes', { parentId: project.rootId, nodes: [{ title, kind: 'task', status: 'active', what: `${title}, as a small change to the window.`, why: 'People ask for it and the work is ready to start.' }] });
  const id = readDb('SELECT id FROM nodes WHERE project_id = ? AND title = ? ORDER BY id DESC LIMIT 1', project.id, title)[0]?.id;
  if (id === undefined) throw new Error(`the step ${title} was not made`);
  steps[key] = { id, title };
}

const randomId = () => (globalThis.crypto ?? { randomUUID: () => `${Date.now()}` }).randomUUID();
const sessions = {};
/** A session as a T3 Code session: start and claim posted the way the hooks post them, its thread in the recorder's world. */
async function startSession(key, step, branch, threadTitle, firstAssistant, cwd = repo) {
  const id = randomId();
  const threadId = `scenes-session-${key}`;
  addThread(threadId, threadTitle, firstAssistant);
  await api('POST', `/api/sessions/${id}/hook`, { event: 'start', source: 'startup', cwd, branch, title: threadTitle, app: 't3', t3ThreadId: threadId });
  await api('POST', `/api/sessions/${id}/claim`, { nodeId: steps[step].id });
  // A prompt: the session is working, so the minute watch does not read it as a stop (only the scene that stops a session does that).
  await api('POST', `/api/sessions/${id}/hook`, { event: 'prompt', cwd, branch, app: 't3', t3ThreadId: threadId });
  sessions[key] = { id, threadId, step, branch, cwd };
  return sessions[key];
}
const hookEvent = (key, event) => api('POST', `/api/sessions/${sessions[key].id}/hook`, { event, cwd: sessions[key].cwd, branch: sessions[key].branch, app: 't3', t3ThreadId: sessions[key].threadId });
const raise = (key, kind, text) => api('POST', `/api/nodes/${steps[sessions[key].step].id}/asks`, { kind, text, sessionId: sessions[key].id });

const setting = (key, value) => lead('set', SLUG, key, value, '--aiden', 'scenes setup');
/** Quiet hours that do not cover now: voice lines may go. A placeholder morning row keeps the day's list for the scene that shows it. */
function noQuiet() {
  const r = setting('quiet', `${hm(Date.now() + 6 * 60 * MIN)}-${hm(Date.now() + 7 * 60 * MIN)}`);
  holdMorning();
  return r;
}
const placeholders = [];
function holdMorning() {
  writeDb((db) => {
    const has = db.prepare("SELECT COUNT(*) AS n FROM lead_events WHERE project_id = ? AND kind = 'morning' AND at >= ?").get(project.id, iso(startOfDay())).n;
    if (has > 0) return;
    const r = db.prepare("INSERT INTO lead_events (project_id, at, lead, instructions, kind, text) VALUES (?, ?, ?, ?, 'morning', '')").run(project.id, iso(), LEAD, INSTRUCTIONS);
    placeholders.push(r.lastInsertRowid);
  });
}
const startOfDay = () => {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  return d.getTime();
};
/**
 * The next morning list: today's placeholder rows are removed, every morning row already written is backdated one day, and the quiet
 * hours end a minute from now (they began `hours` before). Waits for the new row (the watch writes it once the end has passed).
 */
async function nextMorning(hours = 9) {
  writeDb((db) => {
    for (const id of placeholders.splice(0)) db.prepare('DELETE FROM lead_events WHERE id = ?').run(id);
  });
  backdate('lead_events', 'at', "project_id = ? AND kind = 'morning'", [project.id], 24 * 60 * MIN);
  // The morning sends are keyed on the date: yesterday's keep their rows, under another key, so today's list can be made the same date.
  writeDb((db) => db.prepare("UPDATE lead_sends SET retry_key = 'earlier' || id || '-' || retry_key WHERE retry_key LIKE 'morning:%' OR retry_key LIKE 'morning-thread:%'").run());
  const before = readDb("SELECT MAX(id) AS id FROM lead_events WHERE kind = 'morning'")[0].id ?? 0;
  const end = Date.now() + MIN + 5000;
  setting('quiet', `${hm(end - hours * 60 * MIN)}-${hm(end)}`);
  const row = await waitFor('morning list', () => readDb("SELECT id, at, text FROM lead_events WHERE project_id = ? AND kind = 'morning' AND id > ? ORDER BY id DESC LIMIT 1", project.id, before)[0], 4 * MIN, 2000);
  return row;
}

// ---- scenes: records and checks ----
const results = [];
function newScene(n, title) {
  const s = { n, title, startAt: iso(), callsFrom: calls().length, postsFrom: voice.posts.length, did: [], checks: [], notes: [], backdated: [] };
  s.act = (text) => s.did.push(`- ${clock()} ${text}`);
  s.back = (text) => {
    s.backdated.push(text);
    s.act(`BACKDATED: ${text}`);
  };
  s.note = (text) => s.notes.push(text);
  /** exact: PASS when it matches; loose: DIFFERS when only this matches; else FAIL. Each a RegExp or a function of the text. */
  s.check = (label, plan, actual, exact, loose) => {
    const test = (t) => (t instanceof RegExp ? t.test(actual ?? '') : t(actual ?? ''));
    const status = exact !== undefined && test(exact) ? 'PASS' : loose !== undefined && test(loose) ? 'DIFFERS' : 'FAIL';
    s.checks.push({ status, label, plan, actual: actual ?? '(nothing)' });
    return status;
  };
  return s;
}
const fmtRows = (rows) => (rows.length === 0 ? '(none)' : rows.map((r) => `- ${r}`).join('\n'));
function recordSince(s) {
  const since = s.startAt;
  const items = readDb('SELECT id, kind, state, ref, node_id, outcome, created_at, done_at FROM desk_items WHERE project_id = ? AND created_at >= ? ORDER BY id', project.id, since).map(
    (i) => `desk item #${i.id} ${i.kind} ${i.state} ref ${clip(i.ref, 60)} step ${i.node_id ?? '-'} outcome ${clip(i.outcome, 80)} (made ${hhmm(i.created_at)}${i.done_at ? `, done ${hhmm(i.done_at)}` : ''})`,
  );
  const turns = readDb('SELECT id, item_id, way, state, verdict, kind, answer, why, cost_usd, duration_ms FROM lead_turns WHERE project_id = ? AND leased_at >= ? ORDER BY id', project.id, since).map(
    (t) => `turn ${t.id} on item #${t.item_id} (${t.way}) ${t.state}: verdict ${t.verdict ?? '-'} ${t.kind ?? ''}; answer "${clip(t.answer, 120)}"; why "${clip(t.why, 80)}"; cost ${t.cost_usd ?? '-'} USD, ${t.duration_ms ?? '-'} ms`,
  );
  const decisions = readDb('SELECT d.event_id, d.item_id, d.kind, d.line, d.aiden_words, d.said_where, e.kind AS ek FROM lead_decisions d JOIN lead_events e ON e.id = d.event_id WHERE d.project_id = ? AND e.at >= ? ORDER BY d.id', project.id, since).map(
    (d) => `decision d${d.event_id} (${d.ek}, ${d.kind}${d.item_id ? `, item #${d.item_id}` : ''}): ${clip(d.line, 140)}${d.aiden_words ? ` | his words: "${clip(d.aiden_words, 80)}" (${d.said_where})` : ''}`,
  );
  const sends = readDb('SELECT id, kind, target, state, result, retry_key, created_at, done_at, body FROM lead_sends WHERE project_id = ? AND created_at >= ? ORDER BY id', project.id, since).map(
    (x) => `send s${x.id} ${x.kind} to ${x.target} ${x.state}${x.result ? ` result ${clip(x.result, 40)}` : ''} (key ${x.retry_key ?? '-'}, made ${hhmm(x.created_at)}${x.done_at ? `, done ${hhmm(x.done_at)}` : ''}): ${clip(x.body, 160)}`,
  );
  return { items, turns, decisions, sends };
}
function finishScene(s, extra = []) {
  const rec = recordSince(s);
  const t3 = calls().slice(s.callsFrom).filter((c) => c.args[1] === 'start' || c.args[1] === 'send');
  const posts = voice.posts.slice(s.postsFrom);
  const text = [
    `# Scene ${s.n}: ${s.title}`,
    '',
    `Run with ${realClaude ?? 'the scenes stand-in (claude-scenes.mjs): the answers are stand-in answers, so PASS lines prove the plumbing, not the model'}. Server on ${PORT}, voice receiver on ${VOICE_PORT}, a copy of the live data.`,
    `Started ${s.startAt}.`,
    '',
    '## What was done',
    ...s.did,
    ...(s.backdated.length ? ['', '## Stamps backdated (never waited for)', ...s.backdated.map((b) => `- ${b}`)] : []),
    '',
    '## What the record shows',
    '### Desk items',
    fmtRows(rec.items),
    '### Turns',
    fmtRows(rec.turns),
    '### Decisions',
    fmtRows(rec.decisions),
    '### Sends',
    fmtRows(rec.sends),
    ...extra,
    '',
    '## T3 messages caused (the recorder)',
    t3.length === 0 ? '(none)' : t3.map((c) => `- ${hhmm(c.at)} thread ${c.args[1]} ${c.args.slice(2).filter((a) => !a.startsWith('--') || a === '--title').join(' ')}:\n\n${c.stdin.split('\n').map((l) => `    ${l}`).join('\n')}\n`).join('\n'),
    '',
    '## Voice POSTs caused (the receiver)',
    posts.length === 0 ? '(none)' : posts.map((p) => `- ${hhmm(p.at)} status ${p.status}, key sent ${p.hasKey}, content-type ${p.headers['content-type']}:\n\n${String(p.body?.text ?? JSON.stringify(p.body)).split('\n').map((l) => `    ${l}`).join('\n')}\n`).join('\n'),
    '',
    '## Notes',
    ...(s.notes.length ? s.notes.map((n) => `- ${n}`) : ['(none)']),
    '',
    '## Checked against the plan',
    ...s.checks.map((c) => `- **${c.status}** ${c.label}\n  - Plan: ${c.plan}\n  - Actual: ${clip(c.actual, 700)}`),
    '',
  ].join('\n');
  writeFileSync(`${work}/scene-${s.n}.md`, text);
  results.push(s);
}

const idRef = (key) => `#${steps[key].id}`;
const aiden = (r) => (r.code === 0 ? r.text : `exit ${r.code}: ${r.text}`);

// ---- scene 1 ----
async function scene1() {
  const s = newScene(1, "A session's question is answered while he is away");
  s.act(noQuiet().text.length ? `set quiet hours that do not cover now (a placeholder morning row keeps today's list for the last step)` : '');
  const q = 'Should search match step ids as well as titles?';
  const sess = await startSession('a', 'search', 'step-search-ids', `${idRef('search')} Board search`, q);
  const raisedAt = Date.now();
  const ask = await raise('a', 'question', q);
  s.act(`session on ${idRef('search')} raised a question in its thread: "${q}" (ask a${ask.id})`);
  const voiceBefore = readDb("SELECT COUNT(*) AS n FROM lead_sends WHERE project_id = ? AND kind = 'voice_line' AND created_at >= ?", project.id, s.startAt)[0].n;
  const got = await waitFor('the lead in the thread', () => sentTo(sess.threadId, s.callsFrom).find((m) => m.startsWith('[From ')), 150_000);
  const seconds = Math.round((Date.now() - raisedAt) / 1000);
  s.act(`the thread showed the lead's message after ${seconds} s`);
  const d = /\bd(\d+)\b/.exec(got ?? '')?.[1];
  s.check('The thread shows the lead\'s line with its d-number and the Why line, inside 90 seconds', `[From Progresser, the lead] d812: yes, match ids too, so typing 745 finds #745.\nWhy: the board already shows ids beside titles. Aiden can undo this with "undo d812".`, got, new RegExp(`^\\[From ${LEAD}, the lead\\] d${d}: yes, match ids too, so typing ${steps.search.id} finds #${steps.search.id}\\.\\nWhy: the board already shows ids beside titles\\. Aiden can undo this with "undo d${d}"\\.$`), /\[From Progresser, the lead\]/);
  s.check('Inside 90 seconds', '90 seconds', `${seconds} s`, () => seconds <= 90);
  s.check('The Why line names "undo d<n>"', 'Aiden can undo this with "undo d812".', got, new RegExp(`Why:.*undo d${d}`, 's'));
  await sleep(12_000);
  const voiceAfter = readDb("SELECT COUNT(*) AS n FROM lead_sends WHERE project_id = ? AND kind = 'voice_line' AND created_at >= ?", project.id, s.startAt)[0].n;
  s.check('Nothing reaches his phone (no voice line made, none posted)', 'Nothing reaches his phone.', `voice lines made ${voiceAfter - voiceBefore}, posted ${voice.posts.length - s.postsFrom}`, (t) => voiceAfter === voiceBefore && voice.posts.length === s.postsFrom);
  const open = readDb('SELECT cleared_at FROM asks WHERE id = ?', ask.id)[0];
  s.check('The session carries on: its ask is answered', 'The session carries on.', `ask a${ask.id} cleared_at ${open?.cleared_at ?? 'null'}`, () => open?.cleared_at != null);
  const morning = await nextMorning(9);
  s.act('quiet hours ended a minute after being set (end set 1 min ahead); the minute watch wrote the morning list');
  s.check("The next morning's list carries that one line", `the list carries d812`, morning?.text, new RegExp(`d${d} .*undo d${d}`, 's'), new RegExp(`d${d}`));
  s.note(`The morning list text: ${clip(morning?.text, 900)}`);
  finishScene(s, ['', '### The morning list', '```', morning?.text ?? '(none)', '```']);
  return d;
}

// ---- scene 2 ----
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');
async function scene2() {
  const s = newScene(2, 'What is his reaches his phone, and his word goes back');
  noQuiet();
  const q = `Which of two names should the button people will see carry: "Find" or "Search"?`;
  const sess = await startSession('b', 'button', 'step-button-name', `${idRef('button')} Board search button`, q);
  const ask = await raise('b', 'question', q);
  s.act(`session on ${idRef('button')} asked: ${q} (ask a${ask.id})`);
  const line = await waitFor('the bring voice line', () => readDb("SELECT id, created_at, body FROM lead_sends WHERE project_id = ? AND kind = 'voice_line' AND retry_key LIKE 'voice:bring:%' AND created_at >= ? AND state = 'intended' ORDER BY id DESC LIMIT 1", project.id, s.startAt)[0], 120_000);
  s.check('A voice line is made for what is his', 'Yours, InProgress: ...', line?.body, /^Yours, InProgress: /);
  if (line !== undefined) s.back(`voice line s${line.id} created_at moved 4 minutes back, so its 3-minute gather is over (the plan: within five minutes)`);
  if (line !== undefined) backdate('lead_sends', 'created_at', 'id = ?', [line.id], 4 * MIN);
  const post = await waitFor('the voice POST', () => voice.posts.slice(s.postsFrom).find((p) => String(p.body?.text).includes(`[s${line?.id}]`)), 120_000);
  const text = String(post?.body?.text ?? '');
  s.check('The Voice gets the line, with the step and both names', `Yours, InProgress: #745 Board search. The button says "Find" or "Search".\nI would pick "Search": the window says it everywhere else. Say "search" or "find".`, text, new RegExp(`^Yours, InProgress: #${steps.button.id} Board search button\\. The button says "Find" or "Search"\\.\\nI would pick "Search": the window says it everywhere else\\. Say "search" or "find"\\. \\[s\\d+\\]$`), /Yours, InProgress: .*I would pick/s);
  s.check('The line says "I would pick"', 'I would pick "Search"', text, /I would pick/);
  const sendId = line?.id;
  const answered = lead('answer', SLUG, '--send', `s${sendId}`, '--aiden', 'search');
  const at = new Date();
  s.act(`lead answer ${SLUG} --send s${sendId} --aiden "search" -> ${aiden(answered)}`);
  const carried = await waitFor('his answer in the thread', () => sentTo(sess.threadId, s.callsFrom).find((m) => /Aiden's answer/.test(m)), 90_000);
  s.check("The session's thread shows his answer carried by the lead from Grok", `Aiden's answer, carried by Progresser from Grok at 14:02: "search"`, carried, new RegExp(`^\\[From Progresser, the lead\\] Aiden's answer, carried by Progresser from Grok at ${hm(at.getTime())}: "search"$`), /Aiden's answer( to a\d+)?, carried by Progresser from Grok at \d\d:\d\d: "search"/);
  s.note('A DIFFERS on the carried answer means: the line names the ask ("Aiden\'s answer to a<id>, carried by ...").');

  // Typed in the lead's thread: Progresser carries his answer with --where thread.
  const q2 = 'Should the search box keep its text when the board reloads?';
  const ask2 = await raise('b', 'question', q2);
  s.act(`session on ${idRef('button')} asked: ${q2} (ask a${ask2.id})`);
  const typed = lead('answer', SLUG, `a${ask2.id}`, '--aiden', 'keep it', '--where', 'thread');
  const typedAt = new Date();
  s.act(`lead answer ${SLUG} a${ask2.id} --aiden "keep it" --where thread (typed in the lead's thread) -> ${aiden(typed)}`);
  const carriedThread = await waitFor('his typed answer in the thread', () => sentTo(sess.threadId, s.callsFrom).find((m) => /"keep it"/.test(m)), 90_000);
  s.check(
    "An answer typed in the lead's thread is carried as from the lead's thread",
    `Aiden's answer to a<id>, carried by Progresser from the lead's thread at HH:MM: "keep it"`,
    carriedThread,
    new RegExp(`Aiden's answer to a${ask2.id}, carried by Progresser from the lead's thread at ${hm(typedAt.getTime())}: "keep it"$`),
    /from the lead's thread/,
  );

  // The review, with a picture.
  mkdirSync(`${scratch}/session-b`, { recursive: true });
  const png = `${scratch}/session-b/board-search.png`;
  writeFileSync(png, PNG);
  const resource = await api('POST', '/api/resources', { nodeId: steps.button.id, kind: 'diagram', title: 'Board search screenshot', path: png.replace(/\//g, '\\'), sessionId: sess.id });
  s.act(`the session attached ${png} through the resource route: r${resource.id}, path ${resource.path}`);
  const copied = resource.path ?? '';
  s.check('The picture is copied into the project\'s resources folder', `a copy under <home>/resources/${SLUG}/`, copied, (t) => t.replace(/\\/g, '/').startsWith(`${home}/resources/`) && existsSync(copied));
  const named = leadRead('resource', SLUG, `r${resource.id}`, ...WHO);
  s.act(`lead resource ${SLUG} r${resource.id} -> ${clip(aiden(named), 500)}`);
  s.check('`lead resource` names the copied file', 'the copied file named', named.text, (t) => t.replace(/\\/g, '/').includes(copied.replace(/\\/g, '/')), /board-search/);
  const review = `Review: ${idRef('button')} Board search button is ready to land.`;
  const rask = await raise('b', 'review', review);
  s.act(`the session raised a review: ${review} (ask a${rask.id})`);
  // A review is a desk item with a voice line once the build has that (a review item, waiting on Aiden at once); until then the lead answers by the ask number.
  await sleep(20_000);
  const ritem = readDb('SELECT id FROM desk_items WHERE project_id = ? AND ref = ?', project.id, String(rask.id))[0];
  let rline = readDb("SELECT id FROM lead_sends WHERE project_id = ? AND kind = 'voice_line' AND created_at >= ? AND id <> ? AND body LIKE '%review waits on you%'", project.id, s.startAt, sendId)[0];
  if (rline !== undefined) {
    backdate('lead_sends', 'created_at', 'id = ?', [rline.id], 4 * MIN);
    s.back(`voice line s${rline.id} created_at moved 4 minutes back (the gather)`);
    const rpost = await waitFor('the review voice POST', () => voice.posts.slice(s.postsFrom).find((p) => String(p.body?.text).includes(`[s${rline.id}]`)), 120_000);
    s.check('The review waits on him by a voice line', 'Yours, InProgress: #745 <title>: a review waits on you. ... Say "ship it", "not yet", or "show me 745".', String(rpost?.body?.text ?? ''), /^Yours, InProgress: #\d+ .*: a review waits on you\..*Say "ship it", "not yet", or "show me \d+"\./s, /review waits on you/);
  } else {
    s.check('The review waits on him by a voice line', 'Yours, InProgress: #745 <title>: a review waits on you. ... Say "ship it", "not yet", or "show me 745".', `desk item for the review: ${ritem ? '#' + ritem.id : 'none'}; voice line about it: none (this build has no review item yet: answered by the ask number)`, () => false, () => ritem !== undefined);
  }
  const before = cli(['landing', String(steps.button.id), '--action', 'merge', '--branch', 'step-button-name'], repo);
  s.act(`inprogress landing ${steps.button.id} --action merge --branch step-button-name BEFORE his yes -> exit ${before.code}: ${clip(before.text, 300)}`);
  s.check('Before his yes the landing check holds the merge', "hold: this is Aiden's (it touches claude/board-search-button.md)", before.text, (t) => before.code === 3 && /^hold: this is Aiden's/.test(t), (t) => before.code === 3);
  await sleep(2500);
  const yes = lead('answer', SLUG, ...(rline !== undefined ? ['--send', `s${rline.id}`] : [`a${rask.id}`]), '--aiden', 'ship it', '--yes', 'merge', '--yes', 'deploy', '--yes', 'push', '--said-at', iso(), '--shown', `r${resource.id}`, '--where', 'voice');
  s.act(`lead answer ${SLUG} ${rline !== undefined ? `--send s${rline.id}` : `a${rask.id}`} --aiden "ship it" --yes merge --yes deploy --yes push --said-at <now> --shown r${resource.id} --where voice -> ${aiden(yes)}`);
  s.check('His yes is recorded for the merge, deploy and push of the change as it is', 'He said "ship it": the session lands the work through the landing check', yes.text, /His yes covers merge, deploy and push/, /Answered/);
  const landed = cli(['landing', String(steps.button.id), '--action', 'merge', '--branch', 'step-button-name'], repo);
  s.act(`inprogress landing ${steps.button.id} --action merge --branch step-button-name (in the scratch repo) AFTER his yes -> exit ${landed.code}: ${clip(landed.text, 300)}`);
  s.check('The landing check answers clear by his yes', 'Clear to land', landed.text, (t) => landed.code === 0 && /Clear to land/.test(t), (t) => landed.code === 0);
  const carry2 = await waitFor('the review answer in the thread', () => sentTo(sess.threadId, s.callsFrom).some((m) => /Aiden's answer[^\n]*"ship it"/.test(m)), 60_000);
  s.check('He said it once, to the Voice: the session was told in its thread', 'nobody sends him to a thread to say it again', sentTo(sess.threadId, s.callsFrom).filter((m) => /Aiden's answer/.test(m)).join('\n---\n'), () => carry2 === true);
  s.note('Whether the work is in the working app the next time he sits down needs the live install (done-when 1, after landing): not shown here.');
  finishScene(s);
}

// ---- scene 3 ----
async function scene3() {
  const s = newScene(3, 'Something goes wrong overnight and is handled');
  noQuiet();
  const reading = { at: iso(), window: 0.12, windowResets: iso(Date.now() + 3 * 60 * MIN), week: 0.41, weekResets: iso(Date.now() + 4 * 24 * 60 * MIN) };
  writeFileSync(`${work}/usage-scene3.jsonl`, `${JSON.stringify(reading)}\n`);
  s.act(`lead import-usage (a fresh reading, so a restart is not held for one): ${clip(aiden(cli(['lead', 'import-usage', `${work}/usage-scene3.jsonl`])), 200)}`);
  await hookEvent('b', 'end');
  s.act('the scene-2 session ended (a restart is refused while 3 sessions are in flight, the limit; the scenes keep sessions a and d live)');
  // A restart is refused while Aiden has more than 5 open asks in the project (the copy holds his real old ones): they are set aside on the copy for this scene and put back after it.
  const setAside = writeDb((db) => {
    const ids = db.prepare("SELECT id FROM asks WHERE project_id = ? AND owner = 'aiden' AND cleared_at IS NULL AND raised_at < ?").pluck().all(project.id, s.startAt);
    for (const id of ids) db.prepare('UPDATE asks SET cleared_at = ? WHERE id = ?').run(iso(), id);
    return ids;
  });
  s.back(`${setAside.length} of Aiden's old open asks on the copy given a cleared_at for this scene, and put back before scene 6. Intended build rule: a restart parks while he has more than 5 of his asks open in the project (bring those first); the set-aside lets the restart itself be shown`);
  s.note("His real old asks on the copy were set aside for this scene because a restart parks while he has more than 5 asks open (the intended rule: bring those first). They are restored after it.");
  const c = await startSession('c', 'stopped', 'step-stopped', `${idRef('stopped')} Export`, 'working on the export', stoppedTree);
  await hookEvent('c', 'stop');
  s.act(`session on ${idRef('stopped')} stopped with its step open`);
  backdate('sessions', 'last_seen_at', 'id = ?', [c.id], 40 * MIN);
  s.back(`session ${c.id.slice(0, 8)} last_seen_at moved 40 minutes back (it stopped at ${hm(Date.now() - 40 * MIN)}; the plan: 02:10)`);
  const item = await waitFor('the stopped item', () => readDb("SELECT id, outcome FROM desk_items WHERE project_id = ? AND kind = 'stopped' AND node_id = ? ORDER BY id DESC LIMIT 1", project.id, steps.stopped.id)[0], 90_000);
  const ask = await waitFor('the ask in its thread', () => sentTo(c.threadId, s.callsFrom).find((m) => /where does the work/i.test(m)), 90_000);
  s.check('The minute watch asks the session where the work stands (a message in its thread)', 'At 02:20 the lead asks it where the work stands.', ask, /^\[From Progresser, the lead\] Where does the work on #\d+ stand\? Reply in one line, then carry on\.$/, /where does the work/i);
  const askSend = readDb("SELECT id FROM lead_sends WHERE retry_key = ?", `ask-stopped:${item?.id}`)[0];
  if (askSend !== undefined) {
    backdate('lead_sends', 'created_at', 'id = ?', [askSend.id], 31 * MIN);
    backdate('lead_sends', 'done_at', 'id = ?', [askSend.id], 31 * MIN);
    s.back(`the ask's send s${askSend.id} (created_at and done_at) moved 31 minutes back (the plan: asked 02:20, no answer by 02:50)`);
  }
  const done = await waitFor('the turn on the stopped item', () => {
    const r = readDb('SELECT state, outcome FROM desk_items WHERE id = ?', item?.id)[0];
    return r?.state === 'done' || r?.state === 'waiting_aiden' ? r : undefined;
  }, 240_000, 2000);
  const turn = readDb('SELECT verdict, answer FROM lead_turns WHERE item_id = ? ORDER BY id DESC LIMIT 1', item?.id)[0];
  s.act(`the turn answered: ${turn?.verdict} ${clip(turn?.answer, 100)}; the item is ${done?.state}, outcome ${done?.outcome}`);
  const start = await waitFor('the start', () => calls().slice(s.callsFrom).find((x) => x.args[1] === 'start' && /restart|handoff|claim/i.test(x.stdin)), 120_000);
  s.check('A start reaches the recorder with the claim line', 'writes a handoff and starts a fresh session, once', start?.stdin, /inprogress claim/i, /Handoff|handoff|claim/);
  const starts = calls().slice(s.callsFrom).filter((x) => x.args[1] === 'start' && /Export/.test(x.args.join(' ')));
  s.check('Once', 'starts a fresh session, once', `${starts.length} thread start(s) for the step`, () => starts.length === 1);

  // A second session's publish is held.
  const d = await startSession('d', 'publish', 'step-publish', `${idRef('publish')} Release`, 'releasing');
  // A bare origin beside the scratch repo, main pushed, so the check knows origin/main and holds the publish by its own rule.
  const origin = `${scratch}/origin.git`;
  rmSync(origin, { recursive: true, force: true });
  git(scratch, 'init', '--bare', '-b', 'main', origin);
  if (!git(repo, 'remote').split(/\r?\n/).includes('origin')) git(repo, 'remote', 'add', 'origin', origin);
  git(repo, 'push', '-q', 'origin', 'main');
  s.act(`the scratch repo got a bare origin (${origin}) and main was pushed to it`);
  const held = holdHook(d.id, repo, 'npm publish', 'npm publish*');
  s.act(`hold hook for session ${d.id.slice(0, 8)} on \`npm publish\` -> exit ${held.code}, stdout ${clip(held.stdout, 400)}`);
  s.check('The publish is held before it runs and the session is told it waits for Aiden', 'it is held before it runs, and told it waits for Aiden', held.stdout, /"permissionDecision"\s*:\s*"deny".*waits/s, /"permissionDecision"\s*:\s*"deny"/);
  const heldItem = await waitFor('the held item', () => readDb("SELECT id, state FROM desk_items WHERE project_id = ? AND kind = 'held' ORDER BY id DESC LIMIT 1", project.id)[0], 60_000);
  s.act(`held desk item #${heldItem?.id} (${heldItem?.state})`);
  const heldWhy = readDb("SELECT text FROM lead_events WHERE project_id = ? AND kind = 'held' AND at >= ? ORDER BY id DESC LIMIT 1", project.id, s.startAt)[0]?.text;
  s.check('The hold records the publish rule as its reason', 'npm publish -> ... a publish goes out in his name', heldWhy, /a publish goes out in his name/, (t) => !/origin\/main is not known/.test(t) && t !== '');
  // The lid: a slept note across the quiet hours.
  writeDb((db) => db.prepare("INSERT INTO lead_events (project_id, at, lead, instructions, kind, text) VALUES (?, ?, ?, ?, 'slept', ?)").run(project.id, iso(), LEAD, INSTRUCTIONS, JSON.stringify({ from: iso(Date.now() - 8 * 60 * MIN), to: iso(Date.now() - 30 * MIN) })));
  s.back(`a slept note written by hand with from ${hm(Date.now() - 8 * 60 * MIN)} to ${hm(Date.now() - 30 * MIN)} (the minute watch writes one when a tick finds a gap over 3 minutes; waiting for a real sleep is not possible)`);
  const morning = await nextMorning(10);
  s.act('the next morning list written (quiet hours ended a minute after being set; older morning rows backdated a day)');
  const text = morning?.text ?? '';
  s.check('The morning list has the "Went wrong" line for the stopped session', `Went wrong (1)   #746 stopped at 02:10; restarted at 02:51, 41 minutes lost.`, text, new RegExp(`Went wrong \\(1\\)\\s+#${steps.stopped.id} stopped at \\d\\d:\\d\\d; restarted at \\d\\d:\\d\\d, \\d+ minutes? lost\\.`), /Went wrong \(\d+\)[^\n]*stopped at[^\n]*restarted/i);
  s.check('The morning list has the "Held for you" line for the publish', `Held for you (1) #747 wants to publish package x 1.2.0 to npm. Say "publish it" or "not yet".`, text, /Held for you \(1\)\s+#\d+ wants to publish package x 1\.2\.0 to npm\. Say "publish it" or "not yet"\./, /Held for you \(\d+\)[^\n]*wants to/);
  s.check('A lid gap is shown', `The laptop slept from 22:06 to 10:23. 3 items waited; none was lost.`, text, /The laptop slept from \d\d:\d\d to \d\d:\d\d\. \d+ items? waited; (none was lost|\d+ fell behind)\./, /slept from \d\d:\d\d to \d\d:\d\d/);
  writeDb((db) => setAside.forEach((id) => db.prepare('UPDATE asks SET cleared_at = NULL WHERE id = ?').run(id)));
  finishScene(s, ['', '### The morning list', '```', text, '```']);
}

// ---- scene 4 ----
async function scene4(scene1d) {
  const s = newScene(4, 'The morning list, and undo');
  noQuiet();
  const thread = setting('lead-thread', 'on');
  s.act(`lead set ${SLUG} lead-thread on -> ${aiden(thread)}`);
  const morning = await nextMorning(9);
  const list = morning?.text ?? '';
  s.act('the morning list written (quiet hours ended a minute after being set; older morning rows backdated a day)');
  const post = await waitFor('the morning voice POST', () => voice.posts.slice(s.postsFrom).find((p) => /morning list|decided for you/.test(String(p.body?.text))), 120_000);
  const vt = String(post?.body?.text ?? '');
  s.check('The Voice gets one line with the counts and "the list"', `InProgress: 6 decided for you, 1 yours. Say "the list".`, vt, /^InProgress: \d+ decided for you, \d+ yours\. Say "the list"\./, /decided/);
  const start = await waitFor("the day's thread start", () => calls().slice(s.callsFrom).find((c) => c.args[1] === 'start' && / lead /.test(c.args.join(' '))), 60_000);
  s.check("The lead's thread in T3 Code gets the list as one message", "the lead's thread in T3 Code gets one message", start?.stdin, (t) => t.includes(list.split('\n')[0] ?? '#'), /morning list|decided/i);
  s.check('Rulings on what the product does come first, each with the word that undoes it', 'Rulings on what the product does come first, each with the word that undoes it.', list, new RegExp(`Product rulings first:[\\s\\S]*d${scene1d} .*"undo d${scene1d}"`), /undo d\d+/);
  const undo = lead('undo', SLUG, `d${scene1d}`, '--aiden', `undo d${scene1d}, ids are noise`, '--reason', 'ids are noise');
  s.act(`lead undo ${SLUG} d${scene1d} --aiden "undo d${scene1d}, ids are noise" --reason "ids are noise" -> ${aiden(undo)}`);
  s.check('The answer is withdrawn', 'the answer is withdrawn', undo.text, /withdr|undone|Undid|Undone/i);
  // The question raised again is his: its line says what he undid, and offers no pick (the answer he withdrew).
  const again = /as a(\d+)/.exec(undo.text)?.[1];
  const reask = again === undefined ? undefined : await waitFor('the re-raised ask line', () => readDb("SELECT s.body FROM lead_sends s JOIN desk_items d ON d.id = s.item_id WHERE s.kind = 'voice_line' AND d.ref = ? ORDER BY s.id DESC LIMIT 1", again)[0]?.body, 30_000);
  s.check(
    'The re-raised ask says what he undid and offers no pick',
    `Yours, InProgress: #<step> <title>. <question>\nYou undid d${scene1d}: "undo d${scene1d}, ids are noise". Give your answer.`,
    reask,
    (t) => new RegExp(`You undid d${scene1d}: "undo d${scene1d}, ids are noise"\\. Give your answer\\.`).test(t) && !/I would pick/.test(t),
    (t) => t !== '' && !/I would pick/.test(t),
  );
  const told = await waitFor('the session told', () => sentTo(sessions.a.threadId, s.callsFrom).filter((m) => /undo|withdraw|withdrawn/i.test(m)), 60_000);
  await sleep(11_000);
  const toldAll = sentTo(sessions.a.threadId, s.callsFrom).filter((m) => /undo|withdraw|withdrawn/i.test(m));
  s.check('The session is told once', 'the session told', toldAll.join('\n---\n'), () => toldAll.length === 1);
  // The next turn's prompt: another question from the same session.
  const q = 'Should search also match labels?';
  const turnsBefore = readdirSync(`${work}/turns`).length;
  const ask = await raise('a', 'question', q);
  s.act(`session on ${idRef('search')} raised another question (ask a${ask.id}): ${q}`);
  await waitFor('the next turn', () => readDb('SELECT 1 AS x FROM lead_turns t JOIN desk_items i ON i.id = t.item_id WHERE i.ref = ? AND t.state = ?', String(ask.id), 'applied')[0], 150_000);
  const files = readdirSync(`${work}/turns`).sort().slice(turnsBefore);
  const prompts = files.map((f) => JSON.parse(readFileSync(`${work}/turns/${f}`, 'utf8'))).filter((t) => t.message.includes(q));
  const prompt = prompts[0]?.systemPrompt ?? '';
  s.act(`read the system prompt file the runner wrote for that turn (copied by claude-scenes.mjs): ${prompts.length} turn(s) found, ${prompt.length} characters`);
  s.check("The next turn's prompt shows the standing ruling", 'his reason stored as a standing ruling the lead reads before the next call of that kind', prompt.split('\n').filter((l) => /ids are noise/.test(l)).join('\n'), /Standing rulings[\s\S]*ids are noise/, (t) => /ids are noise/.test(prompt));
  // The week.
  const readingAt = Date.now() - 6 * MIN;
  const weekResets = Date.now() + Math.round(7 * 24 * 60 * MIN * 0.555);
  writeFileSync(`${work}/usage-scene4.jsonl`, `${JSON.stringify({ at: iso(readingAt), window: 0.12, windowResets: iso(Date.now() + 3 * 60 * MIN), week: 0.41, weekResets: iso(weekResets) })}\n`);
  const imported = cli(['lead', 'import-usage', `${work}/usage-scene4.jsonl`]);
  s.act(`lead import-usage <a reading of 6 minutes ago: window 12 percent, week 41 percent, week resets so that the line says 44> -> ${aiden(imported)}`);
  const week = leadRead('week', SLUG);
  s.act(`lead week ${SLUG} -> ${aiden(week)}`);
  s.check('The week is printed with the week, the line, this window and the reserve', `The week: 41 percent used; the line says 44. This window: 12 percent, resets 19:30.\nYour reserve is untouched. Last reading 6 minutes ago.`, week.text, /^The week: \d+ percent used; the line says \d+\. This window: \d+ percent, resets \d\d:\d\d\.\nYour reserve is untouched\. Last reading \d+ minutes? ago\.$/, /[Ww]eek \d+ percent used, the line says \d+.*[Ww]indow \d+ percent.*[Rr]eserve: untouched.*[Nn]ewest reading \d+ min/s);
  s.note('The week check compares the shape (week percent, the line, the window, the reserve, the reading age), not the imported figures: the turns read newer gauges and the newest wins by design.');
  finishScene(s, ['', '### The morning list', '```', list, '```']);
}

// ---- scene 5 ----
async function scene5() {
  const s = newScene(5, 'The lead is off, and Grok is closed');
  noQuiet();
  const off = lead('disallow', SLUG, 'round', '--aiden', 'turn the round off');
  s.act(`lead disallow ${SLUG} round --aiden "turn the round off" -> ${aiden(off)}`);
  const turnsBefore = readDb('SELECT COUNT(*) AS n FROM lead_turns WHERE project_id = ?', project.id)[0].n;
  const q1 = 'Should the Find box keep its focus after a search? (first, while off)';
  const q2 = 'Should the Find box clear itself after a search? (second, while off)';
  const a1 = await raise('a', 'question', q1);
  await sleep(2500);
  const a2 = await raise('a', 'question', q2);
  s.act(`two new questions raised while the round is off: a${a1.id}, a${a2.id}`);
  await sleep(35_000);
  const itemsOff = readDb("SELECT id FROM desk_items WHERE project_id = ? AND ref IN (?, ?)", project.id, String(a1.id), String(a2.id));
  const turnsOff = readDb('SELECT COUNT(*) AS n FROM lead_turns WHERE project_id = ?', project.id)[0].n;
  s.check('A new question gets no item and no turn', 'questions wait for him in the window, nothing is answered', `items ${itemsOff.length}, new turns ${turnsOff - turnsBefore}`, () => itemsOff.length === 0 && turnsOff === turnsBefore);
  const passed = holdHook(sessions.d.id, repo, 'npm publish', 'npm publish*');
  s.act(`hold hook for \`npm publish\` with the round off -> exit ${passed.code}, stdout ${JSON.stringify(passed.stdout)}`);
  s.check('A held command passes: the hold route says nothing', 'the hooks pass every command as they did before this stage', passed.stdout === '' ? '(nothing printed)' : passed.stdout, () => passed.stdout === '' && passed.code === 0);
  const on = lead('allow', SLUG, 'round', '--aiden', 'turn the round on');
  s.act(`lead allow ${SLUG} round --aiden "turn the round on" -> ${aiden(on)}`);
  await waitFor('both turns', () => readDb("SELECT COUNT(*) AS n FROM lead_turns t JOIN desk_items i ON i.id = t.item_id WHERE i.ref IN (?, ?) AND t.state = 'applied'", String(a1.id), String(a2.id))[0].n === 2, 200_000, 2000);
  const order = readDb("SELECT i.ref, t.id, t.leased_at FROM lead_turns t JOIN desk_items i ON i.id = t.item_id WHERE i.ref IN (?, ?) ORDER BY t.leased_at, t.id", String(a1.id), String(a2.id));
  s.check('Turning the round on takes what waited, oldest first', '"Turn the round on": what waited is taken in order, oldest first.', order.map((o) => `a${o.ref} leased ${o.leased_at}`).join('; '), () => order.length === 2 && order[0].ref === String(a1.id));

  // Grok closed.
  voice.status = 503;
  s.act('the voice receiver now answers 503 (Grok closed)');
  const maxSend = readDb('SELECT COALESCE(MAX(id), 0) AS n FROM lead_sends')[0].n;
  const qd = 'Should Escape close the search box? (decide)';
  const qb = 'Should the Find box show recent searches? (bring it to Aiden)';
  const d1 = await raise('a', 'question', qd);
  const b1 = await raise('a', 'question', qb);
  s.act(`two questions raised: a${d1.id} (the lead decides), a${b1.id} (the lead brings it)`);
  await waitFor('both turns', () => readDb("SELECT COUNT(*) AS n FROM lead_turns t JOIN desk_items i ON i.id = t.item_id WHERE i.ref IN (?, ?) AND t.state = 'applied'", String(d1.id), String(b1.id))[0].n === 2, 200_000, 2000);
  const turns = readDb("SELECT i.ref, t.verdict FROM lead_turns t JOIN desk_items i ON i.id = t.item_id WHERE i.ref IN (?, ?) AND t.state = 'applied' ORDER BY t.id", String(d1.id), String(b1.id));
  s.check('With the Voice unreachable the round still answers', 'the round answers, restarts and holds exactly the same', turns.map((t) => `a${t.ref}: ${t.verdict}`).join('; '), () => turns.length === 2);
  const line = await waitFor('the bring voice line', () => readDb("SELECT id, state FROM lead_sends WHERE project_id = ? AND kind = 'voice_line' AND retry_key = ?", project.id, `voice:bring:d${readDb("SELECT e.id FROM lead_events e WHERE e.kind = 'bring' AND e.ask_id = ?", b1.id)[0]?.id}`)[0], 60_000);
  backdate('lead_sends', 'created_at', "project_id = ? AND kind = 'voice_line' AND state = 'intended'", [project.id], 11 * MIN);
  s.back(`every voice line still intended moved 11 minutes back, so they count as not sent for over 10 minutes`);
  // The lines' state is read when the receiver answers 503, before anything can send them.
  const count503 = voice.posts.filter((p) => p.status === 503).length;
  const refused = await waitFor('a 503 POST', () => voice.posts.filter((p) => p.status === 503).length > count503 && voice.posts.filter((p) => p.status === 503).at(-1), 90_000);
  const refusedIds = refused ? [...String(refused.body?.text ?? '').matchAll(/\[s(\d+)\]/g)].map((m) => Number(m[1])) : [];
  const intended = refusedIds.length ? readDb(`SELECT id, state FROM lead_sends WHERE id IN (${refusedIds.map(() => '?').join(',')})`, ...refusedIds) : [];
  s.act(`a POST was answered 503 at ${refused ? hhmm(refused.at) : '(none)'} for lines ${refusedIds.map((i) => 's' + i).join(', ')}; their state read right then`);
  s.check('The lines that could not reach him wait (intended, not lost)', 'the lines that could not reach him', intended.map((x) => `s${x.id} ${x.state}`).join('; '), () => intended.length > 0 && intended.every((x) => x.state === 'intended'));
  s.check('The 503 was answered to the sender', 'Grok closed', `${voice.posts.slice(s.postsFrom).filter((p) => p.status === 503).length} POST(s) answered 503`, () => voice.posts.slice(s.postsFrom).some((p) => p.status === 503));
  const morning = await nextMorning(9);
  s.act('the next morning list written (quiet hours ended a minute after being set; older morning rows backdated a day)');
  s.check('The morning list shows the lines as not delivered', 'the lines that could not reach him are listed in the morning list as not delivered', morning?.text, /Not delivered \(\d+\)\s+voice_line to webhook \(s\d+\), not sent since \d\d:\d\d\./, /Not delivered/);
  voice.status = 200;
  s.act('the voice receiver answers 200 again');
  const back = await waitFor('the lines go', () => voice.posts.slice(s.postsFrom).some((p) => p.status === 200), 120_000, 2000);
  s.check('Once Grok is open the waiting lines go, each once', 'nothing is lost', `${voice.posts.slice(s.postsFrom).filter((p) => p.status === 200).length} POST(s) answered 200`, () => back === true);
  finishScene(s, ['', '### The morning list', '```', morning?.text ?? '(none)', '```']);
}

// ---- scene 6 ----
/** The stage 0 list of old asks (lead stage 0), read only: the one file under the live home the scenes read. */
const STAGE0_FILE = join(liveHome, 'resources', 'inprogress', '2026-11-23-lead-stage-0-old-asks.md');
/**
 * The readings of the other projects' asks in the stage 0 list: under each `## <slug>` heading a table
 * `| Ask | Step | Open for | Outcome | What the lead says |`; a reading is `<Outcome>: <what the lead says to its first full stop,
 * clipped to 200>.` InProgress's own rows are left out (the round reads those).
 */
function stage0Readings() {
  let text;
  try {
    text = readFileSync(STAGE0_FILE, 'utf8');
  } catch (err) {
    return { file: STAGE0_FILE, readings: [], error: `not read: ${err.code ?? err.message}` };
  }
  const readings = [];
  let slug;
  for (const raw of text.split(/\r?\n/)) {
    const heading = /^##\s+(\S+)\s*$/.exec(raw);
    if (heading !== null) {
      slug = heading[1];
      continue;
    }
    if (slug === undefined || slug === SLUG) continue;
    const cells = raw.trim().startsWith('|') ? raw.trim().replace(/^\|/, '').replace(/\|$/, '').split('|').map((c) => c.trim()) : [];
    const ask = /^a(\d+)$/.exec(cells[0] ?? '');
    if (ask === null || cells.length < 5) continue;
    const says = cells.slice(4).join('|').trim();
    // The first full stop: a period that ends a sentence (followed by a space or the end), not one inside 127.0.0.1 or a path.
    const stop = /\.(\s|$)/.exec(says);
    const sentence = (stop === null ? says : says.slice(0, stop.index)).slice(0, 200).trim();
    readings.push({ slug, ask: Number(ask[1]), text: `${cells[3]}: ${sentence}.` });
  }
  return { file: STAGE0_FILE, readings };
}

async function scene6() {
  const s = newScene(6, 'The old asks, cleared with the Voice');
  const has = existsSync(`${build}/dist/cli/main.js`) && readFileSync(`${build}/dist/cli/main.js`, 'utf8').includes('old-asks');
  if (!has) {
    s.act("the built CLI has no `lead old-asks` (task 17's commands are not in this build)");
    s.checks.push({ status: 'FAIL', label: 'Task 17 commands exist in the build', plan: '`lead old-asks <project>` and `lead old-asks next 5`', actual: 'not in the build: scene 6 NOT RUN' });
    finishScene(s);
    return;
  }
  noQuiet();
  // The other projects have no lead to run `lead set`, and their default quiet hours (00:00-09:00) would hold their lines at night: each
  // gets a quiet setting row six to seven hours ahead, written as `lead set` writes it (a 'setting' lead_events row, text `quiet <HH:MM-HH:MM>`).
  const quiet = `${hm(Date.now() + 6 * 60 * MIN)}-${hm(Date.now() + 7 * 60 * MIN)}`;
  const withAsks = readDb("SELECT DISTINCT p.id, p.slug FROM asks a JOIN projects p ON p.id = a.project_id WHERE a.cleared_at IS NULL AND a.owner = 'aiden' AND p.slug <> ? AND p.status = 'active' AND p.deleted_at IS NULL", SLUG);
  writeDb((db) => {
    for (const p of withAsks) db.prepare("INSERT INTO lead_events (project_id, at, lead, instructions, kind, text) VALUES (?, ?, ?, ?, 'setting', ?)").run(p.id, iso(), LEAD, INSTRUCTIONS, `quiet ${quiet}`);
  });
  s.back(`a quiet setting \`${quiet}\` written on the copy for ${withAsks.map((p) => p.slug).join(', ') || '(no other project)'} (they have no lead to run lead set; their default quiet hours 00:00-09:00 would hold the lines at night)`);
  for (const other of readDb("SELECT DISTINCT p.slug FROM asks a JOIN projects p ON p.id = a.project_id WHERE a.cleared_at IS NULL AND a.owner = 'aiden' AND p.slug <> ? AND p.status = 'active' AND p.deleted_at IS NULL", SLUG)) {
    const r = lead('old-asks', other.slug);
    s.act(`lead old-asks ${other.slug} -> ${clip(aiden(r), 160)}`);
  }
  const put = lead('old-asks', SLUG);
  s.act(`lead old-asks ${SLUG} -> ${aiden(put)}`);
  s.check('The old asks of InProgress are put on the desk', 'On InProgress the lead has already decided what his rule allows, and brings the rest', put.text, /Put \d+ old asks on the desk/);
  // The readings of the other projects' old asks come from the stage 0 list (read only, never written): an ask not in it gets none.
  const stage0 = stage0Readings();
  s.act(`read ${stage0.file}: ${stage0.readings.length} reading(s) of other projects' asks${stage0.error ? ` (${stage0.error})` : ''}`);
  let loaded = 0;
  for (const r of stage0.readings) {
    const res = lead('old-asks', 'reading', r.slug, String(r.ask), r.text);
    if (res.code === 0) loaded++;
    s.act(`lead old-asks reading ${r.slug} ${r.ask} "${clip(r.text, 120)}" -> ${clip(aiden(res), 160)}`);
  }
  s.note(`The readings of the other projects' old asks came from the stage 0 list (${stage0.file}), ${loaded} loaded: "<Outcome>: <what the lead says, to its first full stop>." An ask not in the list has none.`);
  let rounds = 0;
  let firstBatch;
  let answeredCount = 0;
  let finished = false;
  while (rounds < 16 && !finished) {
    rounds++;
    const next = lead('old-asks', 'next', '5');
    s.act(`lead old-asks next 5 -> ${aiden(next)}`);
    if (/No old asks remain/.test(next.text)) finished = true;
    const queued = readDb("SELECT id, body FROM lead_sends WHERE project_id IS NOT NULL AND kind = 'voice_line' AND retry_key LIKE 'voice:old:%' AND state = 'intended' ORDER BY id");
    const oldLines = queued.filter((q) => /\d+ of \d+: #/.test(q.body));
    if (firstBatch === undefined && oldLines.length) firstBatch = oldLines.map((q) => q.body);
    if (queued.length) {
      backdate('lead_sends', 'created_at', "kind = 'voice_line' AND retry_key LIKE 'voice:old:%' AND state = 'intended'", [], 4 * MIN);
      s.back(`${queued.length} old-ask voice line(s) created_at moved 4 minutes back (the gather)`);
    }
    await sleep(15_000);
    const lines = voice.posts.slice(s.postsFrom).flatMap((p) => String(p.body?.text ?? '').split(/\n\n/)).filter((l) => /\d+ of \d+: #/.test(l) && /\[s\d+\]/.test(l));
    for (const l of lines) {
      const m = /^(.*?), (\d+) of (\d+): .*\[s(\d+)\]$/s.exec(l.trim());
      if (m === null) continue;
      const sid = Number(m[4]);
      const done = readDb("SELECT d.state FROM lead_sends s JOIN desk_items d ON d.id = s.item_id WHERE s.id = ?", sid)[0];
      if (done === undefined || done.state === 'done') continue;
      const slug = readDb('SELECT slug FROM projects WHERE name = ?', m[1])[0]?.slug;
      if (slug === undefined) continue;
      const r = lead('answer', slug, '--send', `s${sid}`, '--aiden', 'close');
      answeredCount++;
      s.act(`lead answer ${slug} --send s${sid} --aiden "close" (line "${m[1]}, ${m[2]} of ${m[3]}") -> ${aiden(r)}`);
    }
  }
  const lines = voice.posts.slice(s.postsFrom).flatMap((p) => String(p.body?.text ?? '').split(/\n\n/)).filter((l) => /\d+ of \d+: #/.test(l));
  s.check('Old asks come as voice lines in the plan\'s shape, naming what was asked', `Glimpse, 1 of 7: #612 Login screen review, 19 days old. Asked: "<the ask>".\n<the reading>. Say your answer.`, lines[0], /^[^\n]+, 1 of \d+: #\d+ .+, \d+ days old\. Asked: ".*"\.\n.+/, /\d+ of \d+: #\d+/);
  // Every line of the first batch names its ask and carries a reading (from the stage 0 list, or the round's own answer).
  const batch = firstBatch ?? [];
  s.check(
    'Every line of the first batch carries what was asked and a reading',
    'each line: Asked: "<the ask>", then the lead\'s reading',
    batch.join('\n---\n') || '(no batch)',
    () => batch.length > 0 && batch.every((b) => b.includes('Asked: "') && (b.split('\n')[1] ?? '').trim() !== 'Say your answer.' && (b.split('\n')[1] ?? '').trim() !== ''),
    () => batch.length > 0 && batch.every((b) => b.includes('Asked: "')),
  );
  s.check('Each answer is recorded in his words', 'each answer is recorded in his words', `${answeredCount} answered with "close"`, () => answeredCount > 0);
  s.check('When the list is empty the Voice says so', 'When the list is empty the Voice says so.', voice.posts.slice(s.postsFrom).map((p) => p.body?.text).filter((t) => /old asks are done/i.test(String(t))).join(' | '), /The old asks are done/);
  s.note(`Stopped after ${rounds} round(s) of 5${finished ? '' : ' without reaching the done line (a cap of 16 rounds)'}.`);
  finishScene(s);
}

// ---- the end: screenshots, summary ----
async function screenshots() {
  mkdirSync(`${work}/shots`, { recursive: true });
  const notes = [];
  try {
    const { chromium } = await import('@playwright/test');
    let browser;
    for (const channel of ['chrome', 'msedge']) {
      try {
        browser = await chromium.launch({ channel });
        notes.push(`browser: system ${channel}`);
        break;
      } catch (err) {
        notes.push(`${channel} did not launch: ${clip(err.message, 160)}`);
      }
    }
    if (browser === undefined) return notes;
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
    await page.goto(`${base}/#/p/${SLUG}`);
    await page.waitForTimeout(2500);
    await page.screenshot({ path: `${work}/shots/board-needs-me-1440.png`, fullPage: false });
    notes.push('shots/board-needs-me-1440.png: the Board of InProgress at 1440 (its Needs me band is on it when something waits)');
    const needs = page.getByText('Needs me', { exact: false }).first();
    if ((await needs.count()) > 0) {
      await needs.scrollIntoViewIfNeeded();
      await page.screenshot({ path: `${work}/shots/needs-me-band-1440.png` });
      notes.push('shots/needs-me-band-1440.png: scrolled to the Needs me band');
    } else notes.push('no "Needs me" text on the board: the band is not shown when nothing waits');
    const lead = page.getByText('Lead', { exact: true }).first();
    if ((await lead.count()) > 0) {
      await lead.click();
      await page.waitForTimeout(2500);
      await page.screenshot({ path: `${work}/shots/lead-view-1440.png` });
      notes.push('shots/lead-view-1440.png: the Lead view at 1440');
    } else notes.push('no "Lead" row in the rail');
    await browser.close();
  } catch (err) {
    notes.push(`screenshots failed: ${clip(err.message, 300)}`);
  }
  return notes;
}

function summary(shotNotes, health) {
  const turns = readDb("SELECT COUNT(*) AS n, COALESCE(SUM(cost_usd), 0) AS cost, COALESCE(SUM(duration_ms), 0) AS ms, COALESCE(SUM(tokens_in), 0) AS tin, COALESCE(SUM(tokens_out), 0) AS tout FROM lead_turns WHERE started_at >= ?", results[0]?.startAt ?? iso(0))[0];
  const twice = readDb("SELECT item_id, COUNT(*) AS n FROM lead_turns WHERE state = 'applied' GROUP BY item_id HAVING n > 1");
  const t3 = calls().filter((c) => c.args[1] === 'start' || c.args[1] === 'send');
  const dupT3 = [...new Map(t3.map((c) => [`${c.args[1]}|${c.args[2]}|${c.stdin}`, 0])).keys()].length !== t3.length;
  const seen = voice.posts.flatMap((p) => [...String(p.body?.text ?? '').matchAll(/\[s(\d+)\]/g)].map((m) => `${p.status}:${m[1]}`));
  const doneTwice = Object.entries(seen.filter((x) => x.startsWith('200:')).reduce((a, x) => ({ ...a, [x]: (a[x] ?? 0) + 1 }), {})).filter(([, n]) => n > 1);
  const dupSends = readDb("SELECT retry_key, COUNT(*) AS n FROM lead_sends WHERE retry_key IS NOT NULL GROUP BY retry_key HAVING n > 1");
  const lines = [
    '# Scenes summary',
    '',
    `Build ${build} (sha ${health.build?.sha}), run with ${realClaude ?? 'the scenes stand-in (a DRY RUN: the answers are stand-in answers, so PASS proves the plumbing, not the model)'}. Server ${PORT}, voice receiver ${VOICE_PORT}, a copy of the live data. Finished ${iso()}.`,
    '',
    '## Each scene',
    ...results.flatMap((s) => [`### Scene ${s.n}: ${s.title} (scene-${s.n}.md)`, ...s.checks.map((c) => `- ${c.status}: ${c.label}. Actual: ${clip(c.actual, 200)}`), '']),
    '## Done when 3: no item acted on twice, read from the record',
    `- Desk items with more than one applied turn: ${twice.length === 0 ? 'none' : twice.map((t) => `#${t.item_id} (${t.n})`).join(', ')}. ${twice.length === 0 ? 'PASS' : 'FAIL'}`,
    `- Sends with more than one row for one retry key: ${dupSends.length === 0 ? 'none' : dupSends.map((d) => d.retry_key).join(', ')}. ${dupSends.length === 0 ? 'PASS' : 'FAIL'}`,
    `- T3 calls (start or send) repeating the same thread and text in the recorder: ${dupT3 ? 'YES' : 'none'}. ${dupT3 ? 'FAIL' : 'PASS'}`,
    `- Voice lines posted and answered 200 more than once: ${doneTwice.length === 0 ? 'none' : doneTwice.map(([k]) => k).join(', ')}. ${doneTwice.length === 0 ? 'PASS' : 'FAIL'}`,
    '',
    '## The cost of the turns',
    `${turns.n} turns, ${turns.cost.toFixed(4)} USD as the program reported it (the stand-in reports 0.01 each; a dry run's cost is no cost), ${turns.ms} ms, ${turns.tin} tokens in, ${turns.tout} tokens out.`,
    '',
    '## Screenshots',
    ...shotNotes.map((n) => `- ${n}`),
    '',
    `Files: ${work}/scene-<n>.md, voice.jsonl, t3-calls.jsonl, t3.json, turns/, shots/.`,
    '',
  ];
  writeFileSync(`${work}/summary.md`, lines.join('\n'));
}

async function main() {
  console.log(`scenes: build ${build}, work ${work}`);
  rmSync(`${work}/voice.jsonl`, { force: true });
  rmSync(`${work}/t3.json`, { force: true });
  rmSync(`${work}/t3-calls.jsonl`, { force: true });
  rmSync(`${work}/turns`, { recursive: true, force: true });
  await copyLiveData();
  writeFileSync(`${home}/lead/voice.json`, `${JSON.stringify({ url: `http://127.0.0.1:${VOICE_PORT}/voice`, key: 'scenes-scratch-key' })}\n`);
  await new Promise((r, j) => receiver.once('error', j).listen(VOICE_PORT, '127.0.0.1', r));
  const health = await startServer();
  const pid = existsSync(`${home}/server.pid`) ? readFileSync(`${home}/server.pid`, 'utf8').trim() : null;
  const builtSha = JSON.parse(readFileSync(`${build}/dist/build.json`, 'utf8')).sha;
  const headSha = execFileSync('git', ['rev-parse', '--short', 'HEAD'], { cwd: repoRoot, encoding: 'utf8' }).trim();
  console.log(`server: app=${health.app} build.sha=${health.build?.sha} (build.json ${builtSha}, HEAD ${headSha}) pid file ${pid}`);
  if (health.app !== 'inprogress' || health.build?.sha !== builtSha || pid === null) throw new Error('the server does not answer as the scenes build');
  token = readFileSync(`${home}/token`, 'utf8').trim();

  // The project: InProgress on the copy, its lead Progresser, the round on, the way headless.
  const row = readDb('SELECT id, lead FROM projects WHERE slug = ?', SLUG)[0];
  if (row === undefined) throw new Error(`the copy has no project ${SLUG}`);
  project.id = row.id;
  project.rootId = readDb('SELECT id FROM nodes WHERE project_id = ? AND parent_id IS NULL ORDER BY id LIMIT 1', project.id)[0].id;
  if (row.lead !== LEAD) {
    const page = await (await fetch(`${base}/`)).text();
    const ui = /<meta name="ip-ui-token" content="([^"]+)"/.exec(page)?.[1];
    if (ui === undefined) throw new Error('the server served no page with a UI token (is web/dist in the build?)');
    await api('POST', `/api/ui/projects/${project.id}/lead`, { slug: SLUG, name: LEAD }, { 'x-ip-ui-token': ui, origin: base });
  }
  makeRepo(['step-search-ids', 'step-button-name', 'step-stopped', 'step-publish']);
  // The lead's tools read the project's first folder: the copy's other bindings of this project are dropped so that it is the scratch repo, where the scenes' branches are.
  const dropped = writeDb((db) => db.prepare('DELETE FROM bindings WHERE project_id = ?').run(project.id).changes);
  console.log(`bindings of ${SLUG} dropped on the copy: ${dropped}`);
  await api('POST', `/api/projects/${SLUG}/bindings`, { path: repo });
  await api('POST', `/api/projects/${SLUG}/bindings`, { path: stoppedTree });
  await makeStep('search', 'Board search');
  await makeStep('button', 'Board search button');
  await makeStep('stopped', 'Export');
  await makeStep('publish', 'Release');
  const out = [];
  out.push(`allow round: ${aiden(lead('allow', SLUG, 'round', '--aiden', 'scenes setup'))}`);
  // The round's first switch-on is moved two hours back: a stop 40 minutes old counts only when it is after that moment (older ones are the old asks of task 17).
  const firstOn = writeDb((db) => db.prepare("UPDATE lead_events SET at = ? WHERE project_id = ? AND kind = 'allow' AND text LIKE 'round%'").run(iso(Date.now() - 120 * MIN), project.id).changes);
  out.push(`round first switched on: ${firstOn} allow row(s) backdated to ${hm(Date.now() - 120 * MIN)} (two hours ago)`);
  out.push(`allow starts: ${aiden(lead('allow', SLUG, 'starts', '--aiden', 'scenes setup'))}`);
  out.push(`turn-way: ${aiden(setting('turn-way', 'headless'))}`);
  out.push(`lead-thread: ${aiden(setting('lead-thread', 'off'))}`);
  out.push(`voice-cap: ${aiden(setting('voice-cap', '100'))}`);
  console.log(out.join('\n'));
  // The stand-in's answers (the dry run only; a real claude ignores the file).
  const sid = steps.search.id;
  writeFileSync(
    `${work}/standin.json`,
    `${JSON.stringify({
      rules: [
        { match: 'An action was held', verdict: 'AIDEN', kind: 'CANNOT-BE-TAKEN-BACK', answer: 'Publish package x 1.2.0 to npm, once the release is checked.', why: 'a publish cannot be taken back.' },
        { match: 'stopped on its step', verdict: 'DECIDE', kind: 'TECHNICAL', answer: 'RESTART: The goal is the export. The work is on its branch; the next step is its test.', why: 'the session stopped and did not answer.' },
        { match: 'ids as well as titles', verdict: 'DECIDE', kind: 'PRODUCT', answer: `yes, match ids too, so typing ${sid} finds #${sid}.`, why: 'the board already shows ids beside titles.' },
        { match: 'Review:', verdict: 'AIDEN', kind: 'CANNOT-BE-TAKEN-BACK', answer: 'ship it: the change is small and its checks passed.', why: 'a landing cannot be taken back.' },
        { match: '"Find" or "Search"', verdict: 'AIDEN', kind: 'TASTE', answer: '"Search": the window says it everywhere else.', why: 'the window says Search everywhere else.' },
        { match: 'bring it to Aiden', verdict: 'AIDEN', kind: 'TASTE', answer: 'yes, show the last five.', why: 'it helps repeat searches.' },
        { match: 'labels', verdict: 'DECIDE', kind: 'PRODUCT', answer: 'no, labels stay out of search for now.', why: 'ids and titles are what people type.' },
      ],
      default: { verdict: 'DECIDE', kind: 'TECHNICAL', answer: 'carry on as you are.', why: 'nothing here needs Aiden.' },
    }, null, 2)}\n`,
  );

  let scene1d = 0;
  for (const n of wanted) {
    console.log(`\n== scene ${n} ==`);
    try {
      if (n === 1) scene1d = await scene1();
      else if (n === 2) await scene2();
      else if (n === 3) await scene3();
      else if (n === 4) await scene4(scene1d || readDb("SELECT id FROM lead_events WHERE kind = 'decide' ORDER BY id LIMIT 1")[0]?.id);
      else if (n === 5) await scene5();
      else if (n === 6) await scene6();
    } catch (err) {
      console.log(`scene ${n} stopped: ${err.stack ?? err.message}`);
      writeFileSync(`${work}/scene-${n}-error.txt`, `${err.stack ?? err.message}\n\nserver log tail:\n${serverLog.slice(-3000)}\n`);
    }
  }
  const shotNotes = await screenshots();
  summary(shotNotes, health);
  console.log(readFileSync(`${work}/summary.md`, 'utf8'));
}

try {
  await main();
} finally {
  await stopServer();
  receiver.close();
  try {
    copyFileSync(`${home}/server.log`, `${work}/server.log`);
  } catch {
    // The server wrote no log, or it is gone: nothing to keep.
  }
}
