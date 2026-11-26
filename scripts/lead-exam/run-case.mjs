// One exam case through the lead's runner (plan task 16), blind: the record cut off at the ask.
// usage: node scripts/lead-exam/run-case.mjs <build dir> <copy> <out dir> <k> <id> <port>
// The build dir holds `node scripts/build-to.mjs <dir>` and `node scripts/lead-exam/build-entry.mjs <dir>`. The program a
// turn runs is INPROGRESS_LEAD_CLAUDE (default `claude`); the t3 CLI is always the exam's stand-in. Every case works on
// its own copy of <copy> under <out>/cases/<k>-<id>/, which is also its INPROGRESS_HOME. Writes <out>/lead-<k>-<id>.json.
import Database from 'better-sqlite3';
import { existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { countAfter, cutAt } from './cut.mjs';

const here = fileURLToPath(new URL('.', import.meta.url));
const [buildArg, copyArg, outArg, kind, idArg, portArg] = process.argv.slice(2);
if (!buildArg || !copyArg || !outArg || !kind || !idArg || !portArg) throw new Error('usage: run-case.mjs <build dir> <copy> <out dir> <k> <id> <port>');
const build = resolve(buildArg);
const copy = resolve(copyArg);
const out = resolve(outArg);
const askId = Number(idArg);
const port = Number(portArg);
if (!Number.isInteger(port) || port < 4410 || port > 4419) throw new Error(`port ${portArg} is not in the exam's lane, 4410 to 4419`);
if (!['q', 'r', 'm'].includes(kind) || !Number.isInteger(askId)) throw new Error(`case ${kind} ${idArg} is not <q|r|m> <ask id>`);

const resultFile = join(out, `lead-${kind}-${askId}.json`);
if (existsSync(resultFile)) {
  try {
    if (JSON.parse(readFileSync(resultFile, 'utf8')).error === null) {
      console.log(`case ${kind}-${askId} is already written: skipped`);
      process.exit(0);
    }
  } catch {
    // A file that does not parse is not a result: the case runs again.
  }
}

// The case's home is set before anything opens a database, and is never the live one.
const caseDir = join(out, 'cases', `${kind}-${askId}`);
mkdirSync(caseDir, { recursive: true });
process.env.INPROGRESS_HOME = caseDir;
const live = resolve(homedir(), '.inprogress').toLowerCase();
if (process.env.INPROGRESS_HOME !== caseDir || resolve(caseDir).toLowerCase().startsWith(live)) throw new Error(`INPROGRESS_HOME is ${process.env.INPROGRESS_HOME}: not a case folder`);
process.env.INPROGRESS_PORT = String(port);
process.env.T3CODE_CLI_PATH = join(here, process.platform === 'win32' ? 't3-standin.cmd' : 't3-standin.sh');
rmSync(join(caseDir, 'lead', 'voice.json'), { force: true });
rmSync(join(caseDir, 'voice.json'), { force: true });

const TIMEOUT_MS = 8 * 60 * 1000;
const log = (m) => console.log(`[${kind}-${askId}] ${m}`);
const write = (o) => writeFileSync(resultFile, JSON.stringify({ verdict: null, answer: null, reason: null, outcome: null, state: null, text: null, cost: null, error: null, ...o }, null, 1));

let db;
let app;
let runner;
let sender;
try {
  const mtimeBefore = statSync(copy).mtimeMs;
  const sizeBefore = statSync(copy).size;
  // a. The case's own copy, by backup(); the exam copy is opened read-only for it.
  const dbFile = join(caseDir, 'inprogress.db');
  rmSync(dbFile, { force: true });
  rmSync(`${dbFile}-wal`, { force: true });
  rmSync(`${dbFile}-shm`, { force: true });
  const source = new Database(copy, { readonly: true, fileMustExist: true });
  await source.backup(dbFile);
  source.close();
  const harness = await import(pathToFileURL(join(build, 'dist', 'exam', 'harness.js')).href);
  db = harness.openDb(dbFile);
  const ask = db.prepare('SELECT * FROM asks WHERE id = ?').get(askId);
  if (ask === undefined) throw new Error(`ask ${askId} is not in the copy`);
  const BEFORE = ask.raised_at;
  // b. The cut.
  const beforeCut = countAfter(db, BEFORE);
  cutAt(db, BEFORE, askId);
  log(`cut at ${BEFORE}: rows after before ${JSON.stringify(beforeCut)}, after ${JSON.stringify(countAfter(db, BEFORE))}`);
  // c. The clock: fixed at BEFORE plus one minute when the run starts, then moving with real time, as the live server's
  // does, so a lease (6 minutes) and the abort before its end behave as they do live.
  const t0 = Date.now();
  const base = Date.parse(BEFORE) + 60_000;
  const now = () => new Date(base + (Date.now() - t0)).toISOString();
  const ctx = harness.createCtx(db, now);
  ctx.reconcile = harness.reconcileProjects;
  // d. A lead and the round, on the copy only.
  const project = db.prepare('SELECT id, lead FROM projects WHERE id = ?').get(ask.project_id);
  const leadName = project.lead ?? harness.setProjectLead(ctx, 'exam', project.id, 'Progresser').lead;
  harness.insertLeadEvent(db, { projectId: project.id, lead: leadName, instructions: harness.LEAD_INSTRUCTIONS_VERSION, kind: 'allow', text: 'round', aidenWords: 'the exam' }, BEFORE);
  // e. The item, as a raise queues it: a review makes none in stage 1, so it is queued as a question about its ask.
  const itemKind = kind === 'm' ? 'permission' : 'question';
  const { item } = harness.produceDeskItem(db, { projectId: project.id, kind: itemKind, ref: String(askId), nodeId: ask.node_id, dueAt: new Date(Date.parse(BEFORE) + 3 * 60_000).toISOString() }, now());
  // f. The build's app, as main.ts makes it: no minute watch, no morning, no probe, no backup runner.
  const home = caseDir;
  const logger = { info: () => undefined, error: (m) => console.error(`[${kind}-${askId}] ${m}`) };
  sender = harness.createSender(
    ctx,
    { t3: { list: (p) => harness.t3List(p), show: (id) => harness.t3Show(id), start: harness.defaultStart(), send: (id, text) => harness.t3Send(id, text) }, webhook: harness.createVoiceWebhook(ctx, { home }) },
    { log: logger },
  );
  const webDir = join(build, 'web', 'dist');
  app = harness.buildApp({
    sender,
    ctx,
    home,
    token: harness.ensureToken(home),
    uiToken: 'exam-ui-token',
    version: harness.VERSION,
    build: null,
    ...(existsSync(webDir) ? { webDir } : {}),
    logger: false,
    onShutdown: () => undefined,
  });
  await app.listen({ port, host: '127.0.0.1' });
  // g. The runner, with the real apply on the case copy.
  runner = harness.createRunner(ctx, {
    way: harness.headlessWay({ claudePath: process.env.INPROGRESS_LEAD_CLAUDE || 'claude', leadDir: (slug) => join(home, 'lead', slug), toolsEntry: harness.leadToolsEntry() }),
    model: harness.LEAD_MODEL,
    home,
    port,
    apply: (c, turn, it, record) => {
      const effect = harness.applyVerdict(c, turn, it, record, sender);
      setImmediate(() => void sender.wake());
      return effect;
    },
    holdBack: (it) => harness.stoppedHoldBack(ctx, it),
    log: logger,
  });
  runner.start();
  const started = Date.now();
  const ENDED = ['applied', 'failed', 'abandoned', 'interrupted'];
  let turn;
  while (Date.now() - started < TIMEOUT_MS) {
    turn = db.prepare('SELECT * FROM lead_turns WHERE item_id = ? ORDER BY id DESC LIMIT 1').get(item.id);
    if (turn !== undefined && ENDED.includes(turn.state)) break;
    await new Promise((r) => setTimeout(r, 500));
  }
  const ended = turn !== undefined && ENDED.includes(turn.state);
  await runner.stop();
  sender.stop();
  await app.close();
  turn = db.prepare('SELECT * FROM lead_turns WHERE item_id = ? ORDER BY id DESC LIMIT 1').get(item.id);
  const row = db.prepare('SELECT state, outcome FROM desk_items WHERE id = ?').get(item.id);
  const text = turn?.verdict ? `${turn.verdict}\nKIND: ${turn.kind}\nANSWER: ${turn.answer}\nWHY: ${turn.why}` : null;
  let error = null;
  if (!ended) error = `the item's turn did not end in ${TIMEOUT_MS / 60000} minutes`;
  else if (turn.state !== 'applied') error = `the turn ${turn.state}: ${turn.why ?? '(no reason)'}`;
  write({ verdict: turn?.verdict ?? null, answer: turn?.answer ?? null, reason: turn?.why ?? null, outcome: row?.outcome ?? null, state: turn?.state ?? null, itemState: row?.state ?? null, kind: turn?.kind ?? null, text, cost: turn?.cost_usd ?? null, error });
  db.close();
  db = undefined;
  if (statSync(copy).mtimeMs !== mtimeBefore || statSync(copy).size !== sizeBefore) throw new Error('the exam copy changed during the run');
  log(`verdict ${turn?.verdict ?? 'none'}, turn ${turn?.state ?? 'none'}, item ${row?.state ?? 'none'}${error === null ? '' : `, error: ${error}`}`);
  process.exit(error === null ? 0 : 1);
} catch (err) {
  const message = err instanceof Error ? err.message : String(err);
  console.error(`[${kind}-${askId}] failed: ${message}`);
  try {
    await runner?.stop();
    sender?.stop();
    await app?.close();
    db?.close();
  } catch {
    // Stopping after a failure: what could not stop is left to end with this process, which exits next.
  }
  mkdirSync(out, { recursive: true });
  write({ error: message });
  process.exit(1);
}
