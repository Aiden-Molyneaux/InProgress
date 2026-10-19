import { randomBytes } from 'node:crypto';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { baseUrl, ensureToken, homeDir, port as configuredPort } from '../lib/home';
import { readBuild, VERSION } from '../lib/version';
import { createWatchState, watchAgents, watchCommandEnds, watchInterval } from './agent-watch';
import { buildApp } from './app';
import { snapshotDb, truncateIfLarge } from './backup';
import { openDb } from './db/connection';
import { createCtx } from './db/tx';
import { tickOffsite } from './offsite';
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
  let closing = false;
  let maintenance: NodeJS.Timeout | undefined;
  let watchTimer: NodeJS.Timeout | undefined;
  const app = buildApp({
    ctx,
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
  // Back up only once we own the port, so two racing starts never write the same backup file.
  const backups = join(home, 'backups');
  await snapshotDb(db, backups).catch((err: Error) => app.log.error(err.message));
  // After the backup, so the newest backup still holds a project the purge is about to remove; then on a timer, since
  // the server can run for weeks. runMaintenance never throws.
  const log = { info: (message: string) => app.log.info(message), error: (message: string) => app.log.error(message) };
  // One tick at a time: a push that takes minutes must not overlap the next tick's snapshot or copy. tickOffsite never throws.
  let ticking = false;
  const tick = async (): Promise<void> => {
    if (ticking) return;
    ticking = true;
    try {
      await snapshotDb(db, backups).catch((err: Error) => app.log.error(err.message));
      runMaintenance(ctx, home, log);
      await tickOffsite(db, home, log);
    } finally {
      ticking = false;
    }
  };
  runMaintenance(ctx, home, log);
  // The off-machine copy and the drill start in the background: a slow push never delays the server's first answer.
  ticking = true;
  void tickOffsite(db, home, log).finally(() => {
    ticking = false;
  });
  maintenance = setInterval(() => void tick(), MAINTENANCE_MS);
  maintenance.unref();
  // The transcript watcher: once now, so subagents that died while the server was down end at once, then on a timer that
  // never keeps the process alive. A failed tick is logged and the next one tries again.
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
  };
  watch();
  watchTimer = setInterval(watch, watchInterval(process.env));
  watchTimer.unref();
  // A hidden, detached server on Windows never receives these signals; POST /api/admin/shutdown is the clean way to stop it.
  process.on('SIGINT', () => void shutdown());
  process.on('SIGTERM', () => void shutdown());
}

main().catch(async (err: unknown) => {
  const anotherServerAnswers = async () => (await portState(baseUrl(configuredPort()))) === 'inprogress';
  process.exit(await reportStartupFailure(err, join(homeDir(), 'server.log'), anotherServerAnswers).catch(() => 1));
});
