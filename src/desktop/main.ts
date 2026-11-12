// The desktop app: an Electron window on the server at baseUrl(). It never runs the server itself (better-sqlite3 is
// built for Node's ABI, not Electron's), so the server is always started with a real node.exe. Closing the window
// quits the app; the server keeps running.
import { existsSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { app, BrowserWindow, Menu, screen, shell } from 'electron';
import { ensureServer } from '../lib/ensure-server';
import { baseUrl, homeDir } from '../lib/home';
import { appUserModelId, externalTarget, isAppUrl, isLiveInstance, launchDetails, nodeForServer, parseDesktopArgs, readBounds, RETRY_URL, shortcutPath, visibleBounds, writeBounds } from './logic';

const home = homeDir();
mkdirSync(home, { recursive: true });
// Windows locks a process's cwd: the app must never pin dist/ (a deploy renames it) or a project folder.
process.chdir(home);

const main = fileURLToPath(import.meta.url);
// Only the installed app takes the shortcut and the shared taskbar identity; a scratch or worktree run must not hijack them.
const live = isLiveInstance({ main, env: process.env });
const appId = appUserModelId(live, home, main);

app.setName('InProgress');
// Under the data dir so a scratch INPROGRESS_HOME gets its own single-instance lock and profile.
app.setPath('userData', join(home, 'desktop'));
app.setAppUserModelId(appId);

const icon = join(dirname(main), 'inprogress.ico');
const boundsFile = join(home, 'desktop.json');
const quote = (path: string) => `"${path}"`;

/** The page shown when the server could not be started: what happened, where to look, and a way to try again. */
function failurePage(reason: string): string {
  const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  const html =
    `<!doctype html><meta charset="utf-8"><title>InProgress</title>` +
    `<body style="background:#111111;color:#f2f2f2;font:14px Segoe UI,sans-serif;padding:24px">` +
    `<h1 style="font-size:18px">InProgress did not start</h1><p>${esc(reason)}</p>` +
    `<p>The server log is ${esc(join(home, 'server.log'))}.</p>` +
    `<p><a style="color:#c2fe0b" href="${RETRY_URL}">Retry</a></p></body>`;
  return `data:text/html;charset=utf-8,${encodeURIComponent(html)}`;
}

function openExternally(url: string): void {
  const target = externalTarget(url);
  if (target) void shell.openExternal(target);
}

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  let win: BrowserWindow | undefined;
  let showingFailure = false;
  const findNode = () => nodeForServer({ argNode: parseDesktopArgs(process.argv).node, platform: process.platform });
  let node = findNode();
  /** The load under way: a double-clicked Retry or a second launch joins it rather than racing it. */
  let loading: Promise<void> | undefined;

  function load(window: BrowserWindow): Promise<void> {
    loading ??= loadOnce(window).finally(() => {
      loading = undefined;
    });
    return loading;
  }

  /** Starts the server if it is down and loads the board, or the failure page saying why it could not. */
  async function loadOnce(window: BrowserWindow): Promise<void> {
    // Look again on a Retry: node may have been installed or put on PATH since launch.
    node ??= findNode();
    let failure = failurePage('No node.exe was found to run the server.');
    try {
      if (node) {
        failure = failurePage('The server did not answer in time.');
        if (await ensureServer({ baseUrl: baseUrl(), waitMs: 8000, execPath: node })) {
          showingFailure = false;
          await window.loadURL(baseUrl());
          return;
        }
      }
    } catch (err) {
      // A throw (a spawn that cannot start, a log file that cannot open) or a failed load: show it rather than a blank window.
      failure = failurePage(`The server could not be started: ${(err as Error).message}`);
    }
    if (window.isDestroyed()) return;
    showingFailure = true;
    await window.loadURL(failure).catch(() => undefined);
  }

  app.on('second-instance', () => {
    if (!win || win.isDestroyed()) return;
    if (win.isMinimized()) win.restore();
    win.show();
    win.focus();
    if (showingFailure) void load(win);
  });
  app.on('window-all-closed', () => {
    app.releaseSingleInstanceLock();
    app.quit();
  });

  void app.whenReady().then(async () => {
    Menu.setApplicationMenu(null);
    const saved = readBounds(boundsFile);
    const bounds = saved && visibleBounds(saved, screen.getAllDisplays().map((d) => d.workArea));
    const window = new BrowserWindow({
      width: 520,
      height: 1000,
      ...bounds,
      title: 'InProgress',
      icon,
      backgroundColor: '#111111',
      show: process.env.INPROGRESS_DESKTOP_HIDDEN !== '1',
      webPreferences: { contextIsolation: true, sandbox: true, nodeIntegration: false },
    });
    win = window;
    const details = launchDetails({ electron: process.execPath, main, node, icon, home });

    if (live && process.platform === 'win32') {
      // Pinning the running taskbar button then relaunches the app, not bare electron.exe.
      window.setAppDetails({ appId, appIconPath: icon, appIconIndex: 0, relaunchCommand: `${quote(details.target)} ${details.args}`, relaunchDisplayName: 'InProgress' });
    }
    const lnk = live ? shortcutPath() : undefined;
    if (lnk) {
      try {
        mkdirSync(dirname(lnk), { recursive: true });
        shell.writeShortcutLink(lnk, existsSync(lnk) ? 'replace' : 'create', details);
      } catch {
        // No Start Menu entry is all a failure here costs; the window still works.
      }
    }

    window.on('close', () => {
      try {
        writeBounds(boundsFile, window.getNormalBounds());
      } catch {
        // Position is forgotten for next time; closing must not fail over it.
      }
    });
    window.webContents.setWindowOpenHandler(({ url }) => {
      openExternally(url);
      return { action: 'deny' };
    });
    window.webContents.on('will-navigate', (event, url) => {
      if (url === RETRY_URL) {
        event.preventDefault();
        void load(window);
        return;
      }
      if (isAppUrl(url, baseUrl())) return;
      event.preventDefault();
      openExternally(url);
    });
    window.webContents.on('before-input-event', (event, input) => {
      if (input.type !== 'keyDown') return;
      if (input.key === 'F5' || (input.control && !input.shift && input.key.toLowerCase() === 'r')) {
        window.webContents.reload();
        event.preventDefault();
      } else if (input.control && input.shift && input.key.toLowerCase() === 'i') {
        window.webContents.toggleDevTools();
        event.preventDefault();
      } else if (input.control && (input.key === '=' || input.key === '+')) {
        window.webContents.setZoomLevel(window.webContents.getZoomLevel() + 0.5);
        event.preventDefault();
      } else if (input.control && input.key === '-') {
        window.webContents.setZoomLevel(window.webContents.getZoomLevel() - 0.5);
        event.preventDefault();
      } else if (input.control && input.key === '0') {
        window.webContents.setZoomLevel(0);
        event.preventDefault();
      }
    });

    await load(window);
  });
}
