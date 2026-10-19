import { existsSync } from 'node:fs';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import type { ProjectSummary } from '../core/types';
import { createClient } from '../lib/client';
import { ensureServer, isServerUp } from '../lib/ensure-server';
import { baseUrl, homeDir, readToken } from '../lib/home';
import { snapshotDb, timestamp } from '../server/backup';
import { initOffsite, runDrill, runOffsite } from '../server/offsite';
import { claudeDir, install, kitStatus, repoRoot, uninstall } from './claude-config';
import { runAsk, runClaim, runOrchestrate } from './claim';
import { runDigest, runUsage } from './digest';
import { doctor } from './doctor';
import { openAppWindow } from './open';
import { runRestore } from './restore';
import { runTasks } from './tasks';

const USAGE =
  'Usage: inprogress <start | stop | open | status | outline <project> [--full] | tasks [<step id>] --session <session id> [--done|--doing|--todo "<subject>"]... | claim <step id> --session <session id> | ask <step id> --session <session id> --question|--permission|--review "<text>" | orchestrate --session <session id> [--status] | digest <project> [--since <iso>] [--all] | usage <project> [--days <n>] | backup [--push | --drill | --init <remote url>] | restore [--from <backup>] | doctor | claude-install | claude-uninstall | claude-check>';
/**
 * The first health check of a CLI run. A fresh process's first request is slow on a busy machine (fetch sets up its
 * HTTP parser), and 300 ms has called a running server down. Nothing listening still fails at once.
 */
const FIRST_PROBE_MS = 1000;

/**
 * Ask the server to shut down and wait until it has actually stopped answering (up to 3 s).
 * False when it is still answering; throws when the shutdown request itself fails.
 */
async function stopServer(url: string, out: (l: string) => void): Promise<boolean> {
  if (!(await isServerUp(url, FIRST_PROBE_MS))) return true;
  await createClient({ baseUrl: url, token: readToken() }).post('/api/admin/shutdown', {});
  for (let i = 0; i < 30; i++) {
    if (!(await isServerUp(url, 200))) {
      out('Stopped the running InProgress server.');
      return true;
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  out('Asked InProgress to stop, but it is still answering after 3 s.');
  return false;
}

/**
 * `inprogress backup`: a snapshot of the live database, or with --push the off-machine copy, --drill the check of the
 * pushed copy, --init <remote url> the setup of the backup repo and its first push. Opens the database as it is (no
 * migration), so it works beside the running server.
 */
async function runBackup(args: string[], out: (line: string) => void, home: string): Promise<number> {
  const initAt = args.indexOf('--init');
  const remote = initAt >= 0 ? args[initAt + 1] : undefined;
  const flags = args.filter((a, i) => i !== initAt + 1 || initAt < 0);
  const known = new Set(['--push', '--drill', '--init']);
  if (flags.some((a) => !known.has(a)) || (initAt >= 0 && (!remote || remote.startsWith('--')))) {
    out('Usage: inprogress backup [--push | --drill | --init <remote url>]');
    return 1;
  }
  const file = join(home, 'inprogress.db');
  if (!existsSync(file)) {
    out(`${file} is missing: start the server once`);
    return 1;
  }
  const db = new Database(file, { fileMustExist: true });
  try {
    db.pragma('busy_timeout = 5000');
    const log = { info: out, error: (message: string) => out(`Error: ${message}`) };
    if (initAt >= 0) {
      await initOffsite(home, remote!);
      out(`Set up ${join(home, 'offsite')} for ${remote}`);
    }
    if (flags.includes('--push') || initAt >= 0) {
      const status = await runOffsite(db, home, log, { force: true });
      if (status === 'not set up') out('The backup repo is not set up: run inprogress backup --init <remote url>');
      if (status === 'busy') out('Another backup is running: try again in a few minutes');
      if (status !== 'ok') return 1;
      out('Pushed the backup.');
      return 0;
    }
    if (flags.includes('--drill')) {
      if (!existsSync(join(home, 'offsite', '.git'))) {
        out('The backup repo is not set up: run inprogress backup --init <remote url>');
        return 1;
      }
      const drill = await runDrill(db, home, new Date());
      out(`Drill ${drill.ok ? 'passed' : 'FAILED'}: ${drill.detail}`);
      return drill.ok ? 0 : 1;
    }
    const result = await snapshotDb(db, join(home, 'backups'));
    out(result.file ? `Wrote ${result.file}` : 'Nothing changed since the newest snapshot: no new one written.');
    return 0;
  } catch (err) {
    out(`Backup failed: ${err instanceof Error ? err.message : String(err)}`);
    return 1;
  } finally {
    db.close();
  }
}

export interface CliOptions {
  /** The InProgress repo that claude-install wires in and doctor checks (default: the one this CLI was built in). */
  repo?: string;
  /** Starts the server when it is down (default: the real one; tests pass a stand-in). */
  ensureServer?: typeof ensureServer;
}

export async function runCli(args: string[], out: (line: string) => void = console.log, o: CliOptions = {}): Promise<number> {
  const [cmd, ...rest] = args;
  const url = baseUrl();
  const ensure = o.ensureServer ?? ensureServer;
  const notStarted = () => `InProgress did not start. See ${join(homeDir(), 'server.log')}`;
  switch (cmd) {
    case 'start': {
      const up = await ensure({ baseUrl: url, waitMs: 5000 });
      out(up ? `InProgress is running at ${url}` : notStarted());
      return up ? 0 : 1;
    }
    case 'stop':
      if (!(await isServerUp(url, FIRST_PROBE_MS))) {
        out('InProgress is not running.');
        return 0;
      }
      return (await stopServer(url, out)) ? 0 : 1;
    case 'open': {
      if (!(await ensure({ baseUrl: url, waitMs: 5000 }))) {
        out(notStarted());
        return 1;
      }
      openAppWindow(url);
      out(`Opened ${url}`);
      return 0;
    }
    case 'status': {
      if (!(await isServerUp(url, FIRST_PROBE_MS))) {
        out('InProgress is not running.');
        return 1;
      }
      const projects = await createClient({ baseUrl: url }).get<ProjectSummary[]>('/api/projects');
      out(`InProgress at ${url}`);
      if (!projects.length) out('  no projects yet');
      for (const p of projects) {
        out(`  ${p.slug.padEnd(24)} ${p.name}${p.status === 'archived' ? ' (archived)' : ''} · ${p.openAsks} need you · ${p.workingSessions} working / ${p.activeSessions} sessions`);
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
    case 'claim':
      return runClaim(rest, out, { baseUrl: url, token: readToken() });
    case 'ask':
      return runAsk(rest, out, { baseUrl: url, token: readToken() });
    case 'orchestrate':
      return runOrchestrate(rest, out, { baseUrl: url, token: readToken() });
    case 'digest':
      return runDigest(rest, out, { baseUrl: url, probeMs: FIRST_PROBE_MS });
    case 'usage':
      return runUsage(rest, out, { baseUrl: url, probeMs: FIRST_PROBE_MS });
    case 'tasks':
      // Run by a main session itself. It never starts the server (see TASKS_NOT_RUNNING_HINT).
      return runTasks(rest, out, { baseUrl: url, token: readToken() });
    case 'backup':
      return runBackup(rest, out, homeDir());
    case 'restore':
      return runRestore(rest, out, { home: homeDir(), serverUp: () => isServerUp(url, FIRST_PROBE_MS) });
    case 'doctor':
      // Start the server first, as `open` does, so doctor passes straight after claude-install stopped it.
      // If it cannot start, say where to look; the Server check then fails too.
      if (!(await isServerUp(url, FIRST_PROBE_MS))) out((await ensure({ baseUrl: url, waitMs: 5000 })) ? `Started InProgress at ${url} for these checks.` : notStarted());
      return doctor({ baseUrl: url, home: homeDir(), claudeDir: claudeDir(), repo: o.repo ?? repoRoot() }, out);
    case 'claude-install': {
      // Install first: a refused install (no build, a settings.json it cannot use) throws here and leaves the server running.
      const { log } = install({ repo: o.repo ?? repoRoot(), claudeDir: claudeDir(), stamp: timestamp() });
      log.forEach((l) => out(l));
      // Then stop the running server, so the next hook starts the new build. A failed stop (say a 401 from a token
      // mismatch) is reported; the install stands.
      await stopServer(url, out).catch((err) => out(`Could not stop the running InProgress server: ${err instanceof Error ? err.message : String(err)}`));
      out('Next: run `inprogress doctor`, then start a new Claude session.');
      return 0;
    }
    case 'claude-uninstall':
      uninstall({ claudeDir: claudeDir(), stamp: timestamp() }).forEach((l) => out(l));
      return 0;
    case 'claude-check': {
      // For the deploy script: 0 = the installed kit matches this repo, 2 = it differs (re-run install), 3 = not installed.
      const status = kitStatus({ repo: o.repo ?? repoRoot(), claudeDir: claudeDir() });
      if (!status.installed) {
        out(`InProgress is not installed in ${claudeDir()}: run npm run claude:install`);
        return 3;
      }
      if (status.differs.length) {
        out(`The installed kit differs from this build: ${status.differs.join(', ')}`);
        return 2;
      }
      out('The installed kit matches this build.');
      return 0;
    }
    default:
      out(USAGE);
      return cmd ? 1 : 0;
  }
}
