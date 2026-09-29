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
      // Start the server first, as `open` does, so doctor passes straight after claude-install stopped it.
      // If it cannot start, say where to look; the Server check then fails too.
      if (!(await isServerUp(url, FIRST_PROBE_MS))) out((await ensure({ baseUrl: url, waitMs: 5000 })) ? `Started InProgress at ${url} for these checks.` : notStarted());
      return doctor({ baseUrl: url, home: homeDir(), claudeDir: claudeDir(), repo: o.repo ?? repoRoot() }, out);
    case 'claude-install': {
      // A failed stop (say a 401 from a token mismatch) is reported, and the install goes ahead.
      await stopServer(url, out).catch((err) => out(`Could not stop the running InProgress server: ${err instanceof Error ? err.message : String(err)}`));
      const { log } = install({ repo: o.repo ?? repoRoot(), claudeDir: claudeDir(), stamp: timestamp() });
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
