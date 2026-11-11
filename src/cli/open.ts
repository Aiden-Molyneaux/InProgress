import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { homeDir } from '../lib/home';
import { nodeBinary } from './claude-config';

export function findChrome(): string | undefined {
  const bases = [process.env.ProgramFiles, process.env['ProgramFiles(x86)'], process.env.LOCALAPPDATA].filter((b): b is string => !!b);
  return bases.map((b) => join(b, 'Google', 'Chrome', 'Application', 'chrome.exe')).find((p) => existsSync(p));
}

export function chromeArgs(url: string): string[] {
  return [`--app=${url}`, '--window-size=520,1000'];
}

/** The Electron binary the `electron` package installed, or undefined when it is missing or its download never ran. */
export function findElectron(): string | undefined {
  try {
    // In Node, require('electron') returns the binary's path (read from path.txt beside the package's own index.js).
    const path: unknown = createRequire(import.meta.url)('electron');
    return typeof path === 'string' && existsSync(path) ? path : undefined;
  } catch {
    return undefined; // Not installed: the caller falls back to Chrome.
  }
}

/** dist/desktop/main.js, resolved from the bundled entry that calls this (dist/<dir>/<file>.js). */
export function desktopMain(): string {
  return fileURLToPath(new URL('../desktop/main.js', import.meta.url));
}

export type AppWindow = 'desktop' | 'chrome' | 'browser';

export interface OpenDeps {
  findElectron?: () => string | undefined;
  findChrome?: () => string | undefined;
  desktopMain?: () => string;
  spawn?: typeof spawn;
}

/** Open the UI in the desktop app, else a chromeless Chrome window, else the default browser. Says which one started. */
export function openAppWindow(url: string, deps: OpenDeps = {}): AppWindow {
  const start = deps.spawn ?? spawn;
  const electron = (deps.findElectron ?? findElectron)();
  const chrome = (deps.findChrome ?? findChrome)();
  const detached = { detached: true, stdio: 'ignore' as const };
  let child: ChildProcess;
  let used: AppWindow;
  const main = (deps.desktopMain ?? desktopMain)();
  if (electron && existsSync(main)) {
    // ELECTRON_RUN_AS_NODE would make electron.exe behave as plain node, never opening a window.
    const { ELECTRON_RUN_AS_NODE: _drop, ...env } = process.env;
    child = start(electron, [main, `--node=${nodeBinary()}`], { ...detached, cwd: homeDir(), env });
    used = 'desktop';
  } else if (chrome) {
    child = start(chrome, chromeArgs(url), detached);
    used = 'chrome';
  } else {
    if (process.platform === 'win32') child = start('explorer.exe', [url], detached);
    else child = start(process.platform === 'darwin' ? 'open' : 'xdg-open', [url], detached);
    used = 'browser';
  }
  // A launch that fails (a missing binary) must not surface as an unhandled 'error' event.
  child.on('error', () => undefined).unref();
  return used;
}
