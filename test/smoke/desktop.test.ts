import { spawn, spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { _electron as electron, type ElectronApplication } from '@playwright/test';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { findElectron } from '../../src/cli/open';
import { isServerUp } from '../../src/lib/ensure-server';

/** The tested build: `npm run test:smoke` builds into .build, so the live dist/ is never touched. */
const BUILD = process.env.INPROGRESS_BUILD_ROOT ?? '.build';
const electronPath = findElectron();

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

describe.skipIf(process.platform !== 'win32' || !electronPath)('desktop app (built)', () => {
  // A scratch copy of the build with a stub web/dist: the smoke build is node-only, and the server serves its page
  // from the web/dist beside dist/.
  const scratch = mkdtempSync(join(tmpdir(), 'ip-desktop-smoke-'));
  const home = join(scratch, 'home');
  const appdata = join(scratch, 'appdata');
  let base = '';
  let env: NodeJS.ProcessEnv = {};
  let app: ElectronApplication | undefined;
  const mainJs = join(scratch, 'dist', 'desktop', 'main.js');
  const args = () => [mainJs, `--node=${process.execPath}`];

  beforeAll(async () => {
    cpSync(join(BUILD, 'dist'), join(scratch, 'dist'), { recursive: true });
    mkdirSync(join(scratch, 'web', 'dist'), { recursive: true });
    writeFileSync(join(scratch, 'web', 'dist', 'index.html'), '<!doctype html><html><head><meta name="ip-ui-token" content=""><title>InProgress</title></head><body><div id="root">desktop smoke</div></body></html>');
    mkdirSync(home, { recursive: true });
    mkdirSync(appdata, { recursive: true });
    const port = await freePort();
    base = `http://127.0.0.1:${port}`;
    env = { ...process.env, INPROGRESS_HOME: home, INPROGRESS_PORT: String(port), INPROGRESS_CLAUDE_DIR: join(scratch, 'claude'), APPDATA: appdata, INPROGRESS_DESKTOP_HIDDEN: '1' };
    delete env.ELECTRON_RUN_AS_NODE;
    // The server is left stopped: the app starts it (criterion C1), through ensureServer's execPath.
    expect(await isServerUp(base)).toBe(false);
  });

  afterAll(async () => {
    if (base) {
      // Stop from a fresh process, as the built smoke test does; the server was started by the app, so there is no handle to kill.
      spawnSync(process.execPath, [join(scratch, 'dist', 'cli', 'main.js'), 'stop'], { env });
      for (let i = 0; i < 25 && (await isServerUp(base)); i++) await new Promise((r) => setTimeout(r, 200));
    }
    if (base && (await isServerUp(base))) {
      // Still up after the wait: the app spawned it detached, so kill the pid it recorded.
      try {
        process.kill(Number(readFileSync(join(home, 'server.pid'), 'utf8')));
      } catch {
        // No pid file, or the process is already gone: nothing left to stop.
      }
    }
    // The app's server child can hold the pipes Playwright watches, so the app closes only after the server has stopped.
    await app?.close().catch(() => undefined);
    rmSync(scratch, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  });

  it('starts the stopped server, opens one window on it, leaves the Start Menu shortcut alone, and a second launch hands over and exits', async () => {
    app = await electron.launch({ executablePath: electronPath, args: args(), env: env as Record<string, string> });
    const page = await app.firstWindow();
    await page.waitForLoadState('domcontentloaded');
    expect(new URL(page.url()).origin).toBe(base);
    expect(await isServerUp(base)).toBe(true);
    expect(existsSync(join(home, 'server.pid'))).toBe(true);
    await page.waitForSelector('#root', { state: 'attached' });
    // A scratch home is not the live instance, so it must leave the real Start Menu shortcut alone.
    expect(existsSync(join(appdata, 'Microsoft', 'Windows', 'Start Menu', 'Programs', 'InProgress.lnk'))).toBe(false);

    const second = spawn(electronPath!, args(), { env, stdio: 'ignore' });
    const exited = await new Promise<boolean>((resolve) => {
      const timer = setTimeout(() => resolve(false), 10_000);
      second.once('exit', () => {
        clearTimeout(timer);
        resolve(true);
      });
    });
    if (!exited) second.kill();
    expect(exited).toBe(true);
    expect(app.windows()).toHaveLength(1);
  }, 60_000);
});
