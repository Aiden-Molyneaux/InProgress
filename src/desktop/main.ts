// The desktop app: an Electron window on the server at baseUrl(). It never runs the server itself (better-sqlite3 is
// built for Node's ABI, not Electron's), so the server is always started with a real node.exe. Closing the window
// quits the app; the server keeps running.
import { existsSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { app, BrowserWindow, Menu, screen, shell } from 'electron';
import { ensureServer } from '../lib/ensure-server';
import { baseUrl, homeDir } from '../lib/home';
import { DESKTOP_APP_ID, externalTarget, isAppUrl, launchDetails, nodeForServer, parseDesktopArgs, readBounds, shortcutPath, visibleBounds, writeBounds } from './logic';

const home = homeDir();
mkdirSync(home, { recursive: true });
// Windows locks a process's cwd: the app must never pin dist/ (a deploy renames it) or a project folder.
process.chdir(home);

app.setName('InProgress');
// Under the data dir so a scratch INPROGRESS_HOME gets its own single-instance lock and profile.
app.setPath('userData', join(home, 'desktop'));
app.setAppUserModelId(DESKTOP_APP_ID);

const main = fileURLToPath(import.meta.url);
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
    `<p><a style="color:#c2fe0b" href="${esc(baseUrl())}">Retry</a></p></body>`;
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
  app.on('second-instance', () => {
    if (!win) return;
    if (win.isMinimized()) win.restore();
    win.show();
    win.focus();
  });
  app.on('window-all-closed', () => app.quit());

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
    const node = nodeForServer({ argNode: parseDesktopArgs(process.argv).node, platform: process.platform });
    const details = launchDetails({ electron: process.execPath, main, node, icon, home });

    if (process.platform === 'win32') {
      // Pinning the running taskbar button then relaunches the app, not bare electron.exe.
      window.setAppDetails({ appId: DESKTOP_APP_ID, appIconPath: icon, appIconIndex: 0, relaunchCommand: `${quote(details.target)} ${details.args}`, relaunchDisplayName: 'InProgress' });
    }
    const lnk = shortcutPath();
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
      }
    });

    const up = node ? await ensureServer({ baseUrl: baseUrl(), waitMs: 8000, execPath: node }) : false;
    const failure = failurePage(node ? 'The server did not answer in time.' : 'No node.exe was found to run the server.');
    try {
      await window.loadURL(up ? baseUrl() : failure);
    } catch {
      // The page failed to load (the server went away, or the window closed meanwhile): say so unless the window is gone.
      if (!window.isDestroyed()) await window.loadURL(failure).catch(() => undefined);
    }
  });
}
