import { randomBytes } from 'node:crypto';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { baseUrl, ensureToken, homeDir, port as configuredPort } from '../lib/home';
import { readBuild, VERSION } from '../lib/version';
import { createWatchState, watchAgents, watchCommandEnds, watchInterval } from './agent-watch';
import { buildApp } from './app';
import { truncateIfLarge } from './backup';
import { openDb } from './db/connection';
import { createCtx } from './db/tx';
import { watchDesk } from './lead/desk';
import { applyVerdict } from './lead/apply';
import { stoppedBeforeLease } from './lead/stopped';
import { watchHeldLines } from './lead/hold';
import { createRunner, headlessWay, LEAD_MODEL, leadToolsEntry, type Runner } from './lead/runner';
import { createSender, type Sender } from './lead/sends';
import { defaultStart } from './lead-start';
import { t3List, t3Send, t3Show } from './t3';
import { createBackupRunner } from './backup-runner';
import { runMaintenance } from './project-lifecycle';
import { reconcileProjects } from './repo/taskState';
import { portState, reportStartupFailure } from './startup';

/** How often a running server purges deleted projects past their 30 days and prunes old rows. */
const MAINTENANCE_MS = 6 * 60 * 60 * 1000;

async function main(): Promise<void> {
  const home = homeDir();
  mkdirSync(home, { recursive: true });
  const port = configuredPort();
  const url = baseUrl(port);
  const first = await portState(url);
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
  // The Board reconcile runs inside every write; set here, not in createCtx, so tests opt in.
  ctx.reconcile = reconcileProjects;
  // The runner serializes the timer's tick, the startup run and the window's Back up now. It logs through the app's logger,
  // which does not exist yet: the closure looks it up when a line is written. runMaintenance never throws.
  const log = { info: (message: string) => app.log.info(message), error: (message: string) => app.log.error(message) };
  const runner = createBackupRunner({ db, home, log, maintenance: () => runMaintenance(ctx, home, log) });
  let closing = false;
  let maintenance: NodeJS.Timeout | undefined;
  let watchTimer: NodeJS.Timeout | undefined;
  let leadRunner: Runner | undefined;
  // The lead's sender (src/server/lead/sends.ts), beside the runner: every start, relay and desk message happens once. With
  // the runner off the app makes its own, which carries out lead start and relay and has no minute check.
  const senderLog = { info: (message: string) => app.log.info(message), error: (message: string) => app.log.error(message) };
  const sender: Sender | undefined =
    process.env.INPROGRESS_LEAD_RUNNER === 'off'
      ? undefined
      : createSender(ctx, { t3: { list: (p) => t3List(p), show: (id) => t3Show(id), start: defaultStart(), send: (id, text) => t3Send(id, text) } }, { log: senderLog });
  const app = buildApp({
    ...(sender === undefined ? {} : { sender }),
    ctx,
    home,
    backups: runner,
    token,
    uiToken: randomBytes(16).toString('hex'),
    version: VERSION,
    build: readBuild(),
    webDir: fileURLToPath(new URL('../../web/dist', import.meta.url)),
    logger: { level: 'info', file: logFile },
    onShutdown: () => void shutdown(),
  });
  async function shutdown(): Promise<void> {
    if (closing) return;
    closing = true;
    clearInterval(maintenance);
    clearInterval(watchTimer);
    // Its running turns are stopped and abandoned before the database closes under them.
    sender?.stop();
    await leadRunner?.stop().catch((err: unknown) => app.log.error(`Could not stop the lead's turn runner: ${(err as Error).message}`));
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
    if ((err as NodeJS.ErrnoException).code === 'EADDRINUSE' && (await portState(url)) === 'inprogress') return;
    console.error(`InProgress: could not listen on ${port}: ${(err as Error).message}`);
    process.exitCode = 1;
    return;
  }
  // The server is up. Nothing below may throw: main's .catch would find this very server answering and exit.
  // From process start, so a slow start after a reboot shows up in server.log (#60).
  app.log.info(`Ready in ${Math.round(process.uptime() * 1000)} ms`);
  try {
    writeFileSync(join(home, 'server.pid'), String(process.pid));
  } catch (err) {
    app.log.error(`Could not write server.pid: ${(err as Error).message}`);
  }
  // Back up only once we own the port, so two racing starts never write the same backup file. The runner snapshots first,
  // so the newest backup still holds a project the purge is about to remove, then runs maintenance, the off-machine copy and
  // the drill, in the background (a slow push never delays the server's first answer), and again on a timer, since the
  // server can run for weeks. runMaintenance never throws.
  runner.startup();
  // The playbooks' Held lines, for the hold hook to read: written now and after each change to a playbook or a lead.
  watchHeldLines(ctx, home, { error: (message) => app.log.error(message) });
  maintenance = setInterval(() => void runner.tick(), MAINTENANCE_MS);
  maintenance.unref();
  // The transcript watcher, and the lead's desk (src/server/lead/desk.ts): once now, so subagents that died while the
  // server was down end at once, then on a timer that never keeps the process alive. A failed tick is logged and the next
  // one tries again.
  const watchState = createWatchState();
  const watch = () => {
    try {
      const { ended, revived } = watchAgents(ctx, watchState);
      for (const e of ended) app.log.info(`Subagent ${e.agentId} of session ${e.sessionId} ended: ${e.reason}`);
      for (const r of revived) app.log.info(`Subagent ${r.agentId} of session ${r.sessionId} is running again`);
    } catch (err) {
      app.log.error(`Could not watch subagent transcripts: ${(err as Error).message}`);
    }
    try {
      const { ended, unreadable } = watchCommandEnds(ctx, watchState);
      for (const e of ended) app.log.info(`Command ${e.taskId} of session ${e.sessionId} ended: ${e.outcome}`);
      for (const u of unreadable) app.log.warn(`Could not read the transcript of session ${u.sessionId} for command ends (${u.code}): ${u.path}`);
    } catch (err) {
      app.log.error(`Could not watch command ends: ${(err as Error).message}`);
    }
    try {
      const { stopped, promiseDue, swept } = watchDesk(ctx);
      if (stopped + promiseDue + swept > 0) app.log.info(`Desk: ${stopped} stopped, ${promiseDue} promise due, ${swept} swept`);
    } catch (err) {
      app.log.error(`Could not watch the lead's desk: ${(err as Error).message}`);
    }
    // Recovery of sends that may have happened, then the rest carried out. tick() logs its own failures.
    if (sender !== undefined) void sender.tick().catch((err: unknown) => app.log.error(`Could not check the lead's sends: ${(err as Error).message}`));
  };
  watch();
  watchTimer = setInterval(watch, watchInterval(process.env));
  watchTimer.unref();
  // The lead's turn runner (src/server/lead/runner.ts): it runs turns only on a project whose round is on.
  // INPROGRESS_LEAD_RUNNER=off keeps it from starting; INPROGRESS_LEAD_CLAUDE names the program a turn runs.
  if (process.env.INPROGRESS_LEAD_RUNNER !== 'off') {
    try {
      leadRunner = createRunner(ctx, {
        way: headlessWay({ claudePath: process.env.INPROGRESS_LEAD_CLAUDE || 'claude', leadDir: (slug) => join(home, 'lead', slug), toolsEntry: leadToolsEntry() }),
        model: LEAD_MODEL,
        home,
        port,
        // The sends a verdict intends are carried out after its write commits.
        apply: (c, turn, item, record) => {
          const effect = applyVerdict(c, turn, item, record, sender);
          if (sender !== undefined) setImmediate(() => void sender.wake());
          return effect;
        },
        // A stopped session is asked in plain code before any turn; the ask is a send, carried out after its write commits.
        holdBack: (item) => {
          const r = stoppedBeforeLease(ctx, item);
          if (r === 'asked' && sender !== undefined) setImmediate(() => void sender.wake());
          return r !== 'lease';
        },
        log: { info: (message) => app.log.info(message), error: (message) => app.log.error(message) },
      });
      leadRunner.start();
    } catch (err) {
      app.log.error(`Could not start the lead's turn runner: ${(err as Error).message}`);
    }
  }
  // A hidden, detached server on Windows never receives these signals; POST /api/admin/shutdown is the clean way to stop it.
  process.on('SIGINT', () => void shutdown());
  process.on('SIGTERM', () => void shutdown());
}

main().catch(async (err: unknown) => {
  const anotherServerAnswers = async () => (await portState(baseUrl(configuredPort()))) === 'inprogress';
  process.exit(await reportStartupFailure(err, join(homeDir(), 'server.log'), anotherServerAnswers).catch(() => 1));
});
