# Plan: InProgress as a desktop Electron app (#709)

Worktree `.claude/worktrees/desktop-electron`, branch `desktop-electron`, label integration.

## Request

Aiden wants InProgress as a desktop Electron app he pins to the Windows taskbar, always showing the main
checkout's live build (the server on 127.0.0.1:4317, which `npm run deploy` replaces). He prefers Chrome over Edge.

Decisions (Aiden, 2026-11-11): unpackaged Electron run from the repo (no installer); closing the window quits the
app (the server keeps running); bar checked as a list.

## Criteria

- C1 · With the server stopped, click the pinned icon: the board opens within 5 s, one taskbar button grouped with the pin, green [◆] icon.
- C2 · Click the pin again while it is open: the same window comes to the front, no second window.
- C3 · Run `npm run deploy` with the app open: the window reloads onto the new build by itself.
- C4 · Run `inprogress open`: the Electron app opens, never Edge; with Electron missing, a Chrome `--app` window.
- C5 · A link that opens a new tab opens in Chrome (the default browser), not inside the app window.
- Window size and position are remembered between launches.

## Approach

The shell is a thin Electron main process in `src/desktop/`, bundled by tsup into `dist/desktop/main.js`, so a deploy
replaces it with the rest of `dist/`. Electron (`electron@45.1.0`, exact, in `dependencies`; already installed in the
worktree) runs it straight from `node_modules/electron/dist/electron.exe`. It never runs the server inside Electron:
better-sqlite3 is built for Node's ABI, so the server is always started with a real `node.exe`.

### Task 1: build plumbing

- `tsup.config.ts`: add entry `'desktop/main': 'src/desktop/main.ts'`. Keep `electron` out of every bundle: change
  `noExternal` to `[/^(?!(better-sqlite3|electron)(\/|$))/]` and update its comment. (In Electron `import ... from
  'electron'` resolves to the built-in module; in Node, `require('electron')` returns the binary's path, which only
  works unbundled because it reads `path.txt` beside its own file.)
- `test/smoke/bundle.test.ts`: extend whatever asserts what stays external so `electron` is allowed too, and add a case
  that `dist/desktop/main.js` exists and imports `electron` rather than inlining it.
- Icon: `scripts/make-icon.mjs` renders the SVG mark from `web/index.html` (same path data, fill `#c2fe0b`, on a
  transparent background) with Playwright's Chromium at 16, 24, 32, 48, 64 and 256 px and writes
  `assets/inprogress.ico` as an ICO with PNG-encoded entries (6-byte header, 16-byte directory entries, PNG payloads;
  width/height byte 0 for 256). Run it once and commit the `.ico`. Not part of the build.
- `scripts/build-to.mjs`: after tsup, copy `assets/inprogress.ico` to `<root>/dist/desktop/inprogress.ico`.
- `scripts/deploy-lib.mjs`: add `/^src\/desktop\//` and `/^assets\//` to `SMOKE_PATHS`. Update the matching
  `suitesFor` test if one pins the lists.

### Task 2: `src/desktop/logic.ts` (pure, unit-tested, no electron import)

- `DESKTOP_APP_ID = 'InProgress.Desktop'` (the AppUserModelID shared by the window and the shortcut, so the pin and the
  window are one taskbar button).
- `parseDesktopArgs(argv: string[]): { node?: string }`: reads `--node=<path>`.
- `nodeForServer(o: { argNode?: string; platform: string; lookup: () => string | undefined }): string | undefined`: the
  `--node` path when given and it exists (exists check injected or via `existsSync`), else the lookup.
  `lookUpNode()` uses `where.exe node` the way `src/server/open-path.ts` looks up VS Code (absolute
  `System32\where.exe`, `cwd: systemRoot()`, `windowsHide`, 3 s timeout); on other platforms `which node`.
- `isAppUrl(url: string, base: string): boolean`: same origin as `base`.
- `externalTarget(url: string): string | undefined`: the URL when its scheme is `http:` or `https:`, else undefined.
- Window bounds: `readBounds(file): Bounds | undefined` (JSON `{x,y,width,height}`, all finite integers, width >= 320,
  height >= 400; anything else undefined) and `writeBounds(file, b)`. File: `<homeDir()>/desktop.json`.
  `visibleBounds(b, displays: {x,y,width,height}[])`: returns `b` when its top-left 40x40 lies inside some display's
  work area, else undefined (a monitor that was unplugged).
- `shortcutPath(env): string | undefined`: `<APPDATA>\Microsoft\Windows\Start Menu\Programs\InProgress.lnk` on win32
  with `APPDATA` set, else undefined.
- `launchDetails(o: { electron: string; main: string; node?: string; icon: string; home: string })`:
  `{ target: electron, args: '"<main>"' plus ' --node="<node>"' when node, appUserModelId: DESKTOP_APP_ID, icon,
  iconIndex: 0, cwd: home, description: 'InProgress' }`. One quoting helper, double quotes around each path.

### Task 3: `src/desktop/main.ts` (the Electron main process)

In order:

1. `process.chdir(homeDir())` after `mkdirSync(homeDir(), { recursive: true })`: Windows locks a process's cwd, and the
   app must never pin `dist/` (deploy renames it) or a project folder.
2. `app.setName('InProgress')`; `app.setPath('userData', join(homeDir(), 'desktop'))` (so a scratch `INPROGRESS_HOME`
   gets its own single-instance lock and profile); `app.setAppUserModelId(DESKTOP_APP_ID)`.
3. `if (!app.requestSingleInstanceLock()) app.quit()` and return. On `second-instance`: restore if minimized, `show()`,
   `focus()`.
4. `app.on('window-all-closed', () => app.quit())`.
5. On ready: `Menu.setApplicationMenu(null)`. Create the window: `BrowserWindow({ width: 520, height: 1000, ...saved
   visible bounds, title: 'InProgress', icon: <dist/desktop/inprogress.ico>, backgroundColor: '#0d0f0c' (match the
   app's dark body; read `web/src` styles for the real value), show: process.env.INPROGRESS_DESKTOP_HIDDEN !== '1',
   webPreferences: { contextIsolation: true, sandbox: true, nodeIntegration: false } })`.
   On win32 `win.setAppDetails({ appId: DESKTOP_APP_ID, appIconPath: icon, appIconIndex: 0, relaunchCommand:
   <quoted electron + args from launchDetails>, relaunchDisplayName: 'InProgress' })`, so pinning the running button
   relaunches the app, not bare electron.exe.
6. Start Menu shortcut (win32, when `shortcutPath` gives one): `shell.writeShortcutLink(path, existsSync ? 'replace' :
   'create', launchDetails(...))`, wrapped in try/catch (a failure only means no Start Menu entry). Electron path is
   `process.execPath`; main is `fileURLToPath(import.meta.url)`; node is from step 7.
7. Server: `ensureServer({ baseUrl: baseUrl(), waitMs: 8000, execPath: node })` with `node = nodeForServer(...)`. If no
   node was found or it returns false, load a `data:text/html` page (escaped) saying InProgress did not start, naming
   `<home>/server.log`, with a Retry link that reloads `baseUrl()`. Otherwise `win.loadURL(baseUrl())`.
8. Bounds: on `close`, `writeBounds(file, win.getNormalBounds())` (try/catch).
9. Links: `webContents.setWindowOpenHandler(({ url }) => { const t = externalTarget(url); if (t) shell.openExternal(t); return { action: 'deny' } })`;
   `will-navigate`: when `!isAppUrl(url, baseUrl())`, `preventDefault()` and open externally the same way.
10. Keys via `webContents.on('before-input-event')`: F5 or Ctrl+R reloads, Ctrl+Shift+I toggles DevTools. Nothing else
    (the app's own shortcuts in `web/src/useKeyboard.ts` need the rest).

### Task 4: `src/lib/ensure-server.ts`

Add an optional `execPath?: string` to `ensureServer`'s options, defaulting to `process.execPath`, used only as the
spawned program. No other change. Unit test that it is used (follow the file's existing tests).

### Task 5: `src/cli/open.ts`, `commands.ts`, `doctor.ts`

- Replace Edge with Chrome: `findChrome()` checks `ProgramFiles`, `ProgramFiles(x86)`, `LOCALAPPDATA` +
  `Google\Chrome\Application\chrome.exe`; `chromeArgs(url)` = `['--app=<url>', '--window-size=520,1000']`. Remove
  `findEdge`/`edgeArgs`.
- `findElectron(): string | undefined`: `createRequire(import.meta.url)('electron')` returning a string path that
  exists, else undefined (catch everything).
- `desktopMain()`: `fileURLToPath(new URL('../desktop/main.js', import.meta.url))`, like `serverEntry()`.
- `openAppWindow(url)`: Electron when found and `desktopMain()` exists, spawned detached, `stdio: 'ignore'`,
  `cwd: homeDir()`, args `[desktopMain(), '--node=' + process.execPath]`, env = `process.env` minus
  `ELECTRON_RUN_AS_NODE`; else Chrome `--app`; else the default browser as today. Return which one launched
  (`'desktop' | 'chrome' | 'browser'`), and `open` prints `Opened <url> in the desktop app` / `in Chrome` /
  `in your browser`.
- `doctor.ts`: replace the Edge check with `App window`: `Electron <path>` ok; else `!` warn `Electron not installed:
  run npm install; inprogress open will use Chrome` (or `the default browser` when Chrome is missing too).
- `src/server/routes/ui.ts:76` comment: say the desktop app or a Chrome app window.

### Task 6: tests

- Unit (`test/desktop/logic.test.ts`): every helper in Task 2, including quoting of paths with spaces, bounds rejected
  when off every display or malformed, `isAppUrl` across ports, `externalTarget` refusing `file:`, `javascript:`.
- `test/cli/commands.test.ts`: replace the Edge args test with `chromeArgs`; test the launcher choice by injecting the
  finders (refactor `openAppWindow` to take optional `{ findElectron, findChrome, spawn }` for this, defaults real).
- Smoke (`test/smoke/desktop.test.ts`): with the `.build` build, a scratch `INPROGRESS_HOME`, a free port, `APPDATA`
  set to a scratch folder and `INPROGRESS_DESKTOP_HIDDEN=1`, start the built server like `built.test.ts` does, then
  launch `_electron.launch({ executablePath: findElectron(), args: [<build>/dist/desktop/main.js, '--node=' +
  process.execPath], env })` from `@playwright/test`. Expect: the first window's URL is the server's base URL and its
  page shows the app root; `<APPDATA>/Microsoft/Windows/Start Menu/Programs/InProgress.lnk` exists; a second
  `spawn(electron, same args)` exits within 10 s while the first app still has one window. Close the app, stop the
  server, remove scratch folders. Skip the file (`describe.skipIf`) when not win32 or Electron is missing.

### Task 7: docs

- `docs/superpowers/specs/2026-09-27-inprogress-design.md` line ~492: `open` starts the server if needed, then the
  desktop app (Electron, `dist/desktop/main.js`); with Electron missing, a Chrome `--app` window; else the default
  browser.
- `docs/guide/inprogress-guide.html`: wherever `inprogress open` or the window is described, mention the desktop app
  and pinning it (run `inprogress open` once, then right-click its taskbar button and Pin to taskbar, or pin
  InProgress from the Start Menu).
- No em dashes anywhere (`test/repo/no-em-dash.test.ts`).

## Checks

`npm run typecheck`, `npm test`, `npm run test:smoke` from the worktree. Never use port 4317, 4399 or the live
`~/.inprogress`.

## Merge gate notes

The main checkout needs `npm install` after the merge (Electron is a new dependency; its postinstall downloads the
binary) before `npm run deploy`. A running desktop app holds `node_modules/electron/dist/electron.exe`, so a later
`npm install` that upgrades Electron needs the app closed.
